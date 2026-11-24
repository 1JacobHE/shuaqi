#!/usr/bin/env node
/*
 * 飞猪 MCP 服务（Fliggy MCP Server）
 * ------------------------------------------------------------------
 * 把 flyai CLI 的四个能力包成标准 MCP 工具，供百炼「自定义 MCP 服务」挂载：
 *
 *   search_flight  机票（航班号/航司/起降时刻/机场/票价/飞猪下单链接）
 *   search_hotel   酒店（名称/星级/价格/评分/下单链接）
 *   search_poi     景点门票
 *   search_train   火车票
 *
 * 两种运行方式：
 *   node mcp-flyai.mjs                  → stdio（本地 / 支持 stdio 的宿主）
 *   node mcp-flyai.mjs --http --port 8090 → HTTP（百炼脚本部署 / 容器部署）
 *                                          POST /mcp    JSON-RPC
 *                                          GET  /healthz 健康检查（必须，百炼靠它判活）
 *
 * 风控纪律（和 flyai.mjs 一致，依官方 2026-10-10 实测标定）：
 *   ① 全局串行：一次只跑一个 CLI 子进程；
 *   ② 两层闸门：条间隔 1.5s + 滚动窗口 18 次/60s（官方配额 20~24 次/60s，留边际）；
 *      ——只做间隔挡不住连扫，配额是按窗口算的；
 *   ③ TTL 缓存 30 分钟，失败只缓存 30 秒；
 *   ④ 命中 451/403 **立刻全局熔断**，指数冷却 3→6→12min…封顶 6h。
 *      不重试、不切体验通道：两通道共用同一账号配额，再打一次只会加重封禁。
 *      （官方实测封禁 >5 小时，24 轮探测 24/24 全封，探测只会重置计时。）
 *
 * 环境变量：
 *   FLYAI_BIN         flyai-bundle.cjs 的路径（云上必填）
 *   FLYAI_API_KEY     飞猪 Key（可选；不填走体验通道）
 *   FLYAI_GAP_MS      条间隔，默认 1500
 *   FLYAI_WINDOW_MAX  滚动窗口内最大次数，默认 18 次/60s
 *   FLYAI_MODE        auto | guest | keyed，默认 auto
 *   PORT              HTTP 模式端口，默认 8090
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalize } from './flyai.mjs';

const VERSION = '1.0.0';

/* ---------------------------------------------------------------- 基础工具 */

/** 游客模式用的干净 HOME：里面没有 .flyai/config.json，CLI 自动走体验通道 */
const GUEST_HOME = path.join(os.tmpdir(), 'flyai-guest');
try { fs.mkdirSync(GUEST_HOME, { recursive: true }); } catch { /* ignore */ }

/** 找 flyai CLI：环境变量 > 当前工程 node_modules > 本机全局安装 */
function resolveBin() {
  const cands = [
    process.env.FLYAI_BIN,
    path.join(process.cwd(), 'node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs'),
    'C:/Users/73410/.workbuddy/binaries/node/workspace/node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs'
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return cands[0] || 'flyai';
}

/** Key 池：官方口径（2026-10-21）——没有比赛专用 AK，但可多申请，每把独立 5000 次 + 每天 200 次，风控 AK 级 24h */
function resolveKeys() {
  const multi = (process.env.FLYAI_API_KEYS || '').trim();
  if (multi) return multi.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (process.env.FLYAI_API_KEY) return [process.env.FLYAI_API_KEY];
  const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.flyai', 'config.json');
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(c.FLYAI_API_KEYS) && c.FLYAI_API_KEYS.length) return c.FLYAI_API_KEYS.filter(Boolean);
    return c.FLYAI_API_KEY ? [c.FLYAI_API_KEY] : [];
  } catch { return []; }
}

const BIN = resolveBin();
const KEYS = resolveKeys();
const keyPool = KEYS.map((k, i) => ({ key: k, tag: `AK#${i + 1}`, cool: 0, hits: 0, uses: 0 }));
const MODE = (process.env.FLYAI_MODE || (KEYS.length ? 'auto' : 'guest')).toLowerCase();
// 官方 2026-10-10 标定：配额是**滚动窗口 20~24 次/60s**，不是总次数也不是并发数。
// 打穿后带 Key 得 451、无 Key 得 403，都是 24 小时级封禁。这里压到官方配额的一半以下 → 12 次/60s。
const GAP = Math.max(0, Number(process.env.FLYAI_GAP_MS ?? 3000));
const WIN_MAX = Math.max(1, Number(process.env.FLYAI_WINDOW_MAX) || 12);
const WIN_MS = 60000;
const TTL = 30 * 60 * 1000;
const TIMEOUT = 30000;
/* 风控熔断：官方 2026-10-21 —— 时长 24 小时。
 * 实测补充：重置 AK 后全新 Key 依然 451 → 封禁记在**账号**上、不在 Key 上，
 * 「换把 Key 试试」只会把 24 小时重新计时。所以冷却直接取满 24h，不再做 30min 起步。 */
const RISK_BASE = 24 * 3600 * 1000;
const RISK_CAP = 24 * 3600 * 1000;
const RISK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'risk-state.json');

/* ------------------------------------------------------------ 串行 + 缓存 */

const cache = new Map();      // key → { at, payload }
let queue = Promise.resolve(); // 所有 CLI 调用串成一条链
let lastAt = 0;
let cooldownUntil = 0;
let riskHits = 0;
const stamps = [];            // 滚动窗口时间戳

/* 熔断状态落盘：进程重启（改配置、崩溃重拉）不该把 24 小时冷却清空，
 * 否则重启后第一次调用就会去撞同一道墙、把计时重新归零。 */
try {
  const s = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
  if (Number(s.until) > Date.now()) { cooldownUntil = Number(s.until); riskHits = Number(s.hits) || 1; }
} catch { /* 没被风控过就没有这个文件 */ }
function flushRisk() {
  try {
    fs.mkdirSync(path.dirname(RISK_FILE), { recursive: true });
    fs.writeFileSync(RISK_FILE, JSON.stringify({ until: cooldownUntil, hits: riskHits, at: Date.now() }));
  } catch { /* 磁盘写失败不影响运行 */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 全局串行 + 条间隔 + 滚动窗口：光有间隔挡不住连扫，配额是按窗口算的 */
function serial(task) {
  const run = queue.then(async () => {
    const wait = lastAt + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= WIN_MS) stamps.shift();
      if (stamps.length < WIN_MAX) { stamps.push(now); break; }
      await sleep(WIN_MS - (now - stamps[0]) + 80);
    }
    lastAt = Date.now();
    return task();
  });
  queue = run.catch(() => { });
  return run;
}

/** 剔除代理变量：宿主的 127.0.0.1:60700 是共享沙箱出口，机房 IP 比家宽更容易被风控 */
function childEnv(extra) {
  const e = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete e[k];
  return { ...e, ...extra };
}

/** 选一把未冷却、用得最少的 AK；全冷却返回 null */
function pickKey() {
  const now = Date.now();
  const live = keyPool.filter((s) => now >= s.cool);
  if (!live.length) return null;
  live.sort((a, b) => a.uses - b.uses);
  return live[0];
}

/** guest=true：不带 Key + HOME 指向无 config 目录，强制体验通道 */
function execCli(args, keyUsed) {
  return new Promise((resolve) => {
    const env = keyUsed
      ? childEnv({ FLYAI_API_KEY: keyUsed })
      : childEnv({ FLYAI_API_KEY: '', USERPROFILE: GUEST_HOME, HOME: GUEST_HOME, APPDATA: GUEST_HOME });
    let out = '', err = '';
    let p;
    try {
      p = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e) });
    }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, TIMEOUT);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j && j.status !== undefined && j.status !== 0) {
          return resolve({ ok: false, error: j.message || j.systemMessage || 'status!=0' });
        }
        return resolve({ ok: true, data: j?.data ?? j, note: j?.systemMessage || '' });
      } catch (e) {
        return resolve({ ok: false, error: (err || String(e.message)).replace(/\s+/g, ' ').slice(0, 200) });
      }
    });
  });
}

const isRisk = (msg) => /451|risk control|Abnormal access/i.test(msg || '');

/**
 * 统一入口：缓存 → 通道决策 → 执行 → 风控降级 → 回写缓存
 * @param {string} cmd   flyai 子命令
 * @param {string[]} args 参数
 * @param {string} ck   缓存 key
 */
async function call(cmd, args, ck) {
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.payload, cached: true };

  const payload = await serial(async () => {
    // 熔断期内一个请求都不发：探测只会重置 24h 计时
    if (Date.now() < cooldownUntil) return { ok: false, error: 'CLIENT_COOLDOWN' };
    // 选 AK：guest 模式或无可用 AK 的处理
    const picked = MODE === 'guest' ? null : pickKey();
    if (MODE !== 'guest' && !picked) return { ok: false, error: 'ALL_KEYS_COOLING' };

    const r = await execCli([cmd, ...args], picked ? picked.key : '');
    if (picked) picked.uses++;

    /* 命中风控：全局停手，不重试、不换 Key。
     * 实测：重置后的新 Key 第一次调用依然 451 → 封禁在账号上，换 Key 甩不掉。 */
    if (!r.ok && isRisk(r.error)) {
      riskHits++;
      const cool = Math.min(RISK_CAP, RISK_BASE * 2 ** (riskHits - 1));
      if (picked) { picked.hits++; picked.cool = Date.now() + cool; }
      cooldownUntil = Math.max(cooldownUntil, Date.now() + cool);
      for (const s of keyPool) s.cool = Math.max(s.cool, cooldownUntil);
      flushRisk();
    } else if (r.ok && (riskHits || cooldownUntil)) {
      riskHits = 0; cooldownUntil = 0;
      for (const s of keyPool) { s.cool = 0; s.hits = 0; }
      flushRisk();
    }
    return r;
  });

  cache.set(ck, { at: payload.ok ? Date.now() : Date.now() - TTL + 30000, payload });
  return { ...payload, cached: false };
}

/* ---------------------------------------------------------------- 四个工具 */

/** 机票 */
async function searchFlight(a) {
  const args = ['--origin', a.origin, '--destination', a.destination, '--dep-date', a.dep_date];
  if (a.max_price) args.push('--max-price', String(a.max_price));
  if (a.journey_type) args.push('--journey-type', String(a.journey_type));
  if (a.sort_type) args.push('--sort-type', String(a.sort_type));
  if (a.seat_class) args.push('--seat-class-name', a.seat_class);
  const r = await call('search-flight', args, `F|${a.origin}|${a.destination}|${a.dep_date}|${a.max_price || ''}|${a.journey_type || ''}`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const raw = Array.isArray(r.data?.itemList) ? r.data.itemList : [];
  const ctx = { origin: a.origin, destination: a.destination, date: a.dep_date };
  const items = raw.map(it => normalize(it, ctx)).filter(Boolean)
    .slice(0, a.limit || 8)
    .map(x => ({
      flight_no: x.no, airline: x.airline,
      from_city: x.from, to_city: x.to,
      from_airport: x.fromPort, to_airport: x.toPort,
      dep_time: x.dep, arr_time: x.arr,
      duration_hours: x.hours, stops: x.stopsText,
      price_cny: x.price, book_url: x.jumpUrl
    }));
  return { ok: true, count: items.length, items, note: r.note || '', cached: !!r.cached };
}

/** 酒店 */
async function searchHotel(a) {
  const args = ['--dest-name', a.city];
  if (a.keyword) args.push('--key-words', a.keyword);
  if (a.check_in) args.push('--check-in-date', a.check_in);
  if (a.check_out) args.push('--check-out-date', a.check_out);
  if (a.max_price) args.push('--max-price', String(a.max_price));
  const r = await call('search-hotel', args, `H|${a.city}|${a.keyword || ''}|${a.check_in || ''}|${a.check_out || ''}`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = pickList(r.data)
    .map(h => {
      const p = money(pick(h, ['price', 'minPrice', 'priceYuan']));
      return {
        name: pick(h, ['name', 'hotelName', 'title']),
        star: pick(h, ['star', 'starRating']),
        price_cny: p.num,
        price_text: p.text,
        address: pick(h, ['address', 'addr']),
        book_url: pick(h, ['detailUrl', 'jumpUrl', 'url'])
      };
    })
    .filter(x => x.name)
    .slice(0, a.limit || 6);
  return { ok: true, count: items.length, items, note: r.note || '', cached: !!r.cached };
}

/** 景点（注意 CLI 的参数名是 --city-name，不是 --city） */
async function searchPoi(a) {
  const args = ['--city-name', a.city];
  if (a.keyword) args.push('--keyword', a.keyword);
  if (a.category) args.push('--category', a.category);
  const r = await call('search-poi', args, `P|${a.city}|${a.keyword || ''}|${a.category || ''}`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = pickList(r.data)
    .map(p => {
      const money1 = money(pick(p, ['price', 'minPrice', 'ticketPrice']));
      return {
        name: pick(p, ['name', 'poiName', 'title']),
        level: pick(p, ['poiLevel', 'level', 'star']),
        price_cny: money1.num,
        price_text: money1.text,
        address: pick(p, ['address', 'addr']),
        book_url: pick(p, ['detailUrl', 'jumpUrl', 'url'])
      };
    })
    .filter(x => x.name)
    .slice(0, a.limit || 6);
  return { ok: true, count: items.length, items, note: r.note || '', cached: !!r.cached };
}

/** 火车票：flyai 的 train 也是 journeys/segments 结构，压平成一行一趟 */
async function searchTrain(a) {
  const args = ['--origin', a.origin, '--destination', a.destination, '--dep-date', a.dep_date];
  if (a.journey_type) args.push('--journey-type', String(a.journey_type));
  const r = await call('search-train', args, `T|${a.origin}|${a.destination}|${a.dep_date}|${a.journey_type || ''}`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = pickList(r.data)
    .map(it => normalizeTrain(it, { origin: a.origin, destination: a.destination, date: a.dep_date }))
    .filter(Boolean)
    .slice(0, a.limit || 8);
  return { ok: true, count: items.length, items, note: r.note || '', cached: !!r.cached };
}

/* --------------------------------------------------------- 火车票归一化 */

const hhmm = (dt) => (typeof dt === 'string' && dt.length >= 16 ? dt.slice(11, 16) : '');

/** 取第一个非空字段，兼容不同接口的命名差异 */
function pick(o, keys) {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function normalizeTrain(item, ctx) {
  const j = item?.journeys?.[0];
  const segs = j?.segments || [];
  if (!segs.length) return null;
  const f = segs[0];
  const l = segs[segs.length - 1];
  const p = money(item?.ticketPrice ?? item?.price);
  const mins = Number(j?.totalDuration || item?.totalDuration);
  return {
    train_no: f.marketingTransportNo || f.transportNo || '车次',
    from_station: f.depStationName || f.depCityName || ctx.origin,
    to_station: l.arrStationName || l.arrCityName || ctx.destination,
    dep_time: hhmm(f.depDateTime),
    arr_time: hhmm(l.arrDateTime),
    duration_hours: Number.isFinite(mins) && mins > 0 ? Math.round((mins / 60) * 10) / 10 : null,
    transfers: Math.max(0, segs.length - 1),
    price_cny: p.num,
    price_text: p.text,
    book_url: item?.jumpUrl || ''
  };
}

/**
 * 价格字段可能是数字，也可能是 "¥1xx" 这种体验模式脱敏字符串。
 * 脱敏值不能当数字用（"¥1xx" 解析成 1 会骗人），所以原样保留为 text。
 */
function money(v) {
  if (v === undefined || v === null || v === '') return { num: null, text: '' };
  const s = String(v).trim();
  if (/x/i.test(s)) return { num: null, text: s };
  const n = Number(s.replace(/[¥￥,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { num: null, text: s };
  return { num: n, text: s.startsWith('¥') ? s : '¥' + n };
}


/** 不同接口的列表字段名不统一，这里兜一下常见几种 */
function pickList(d) {
  if (!d) return [];
  for (const k of ['itemList', 'list', 'items', 'hotelList', 'poiList', 'trainList', 'data']) {
    if (Array.isArray(d[k])) return d[k];
  }
  return Array.isArray(d) ? d : [];
}

/* ------------------------------------------------------------- MCP 协议层 */

const TOOLS = [
  {
    name: 'search_flight',
    description: '查询实时机票：返回真实航班号、航司、起降机场与时刻、飞行时长、经济舱票价（人民币）和飞猪下单链接。用于回答"某天从 A 到 B 有哪些航班/多少钱"。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '出发城市中文名，如 成都' },
        destination: { type: 'string', description: '目的城市中文名，如 丽江' },
        dep_date: { type: 'string', description: '出发日期 YYYY-MM-DD' },
        max_price: { type: 'number', description: '最高票价（元），可选' },
        journey_type: { type: 'number', enum: [1, 2], description: '1=只看直达，2=含中转，可选' },
        limit: { type: 'number', description: '最多返回几条，默认 8' }
      },
      required: ['origin', 'destination', 'dep_date']
    }
  },
  {
    name: 'search_hotel',
    description: '查询某城市的酒店/民宿：返回名称、星级、价格、评分与飞猪下单链接。',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 丽江' },
        keyword: { type: 'string', description: '关键词，如 古城、亲子，可选' },
        check_in: { type: 'string', description: '入住日期 YYYY-MM-DD，可选' },
        check_out: { type: 'string', description: '退房日期 YYYY-MM-DD，可选' },
        max_price: { type: 'number', description: '每晚最高价，可选' },
        limit: { type: 'number', description: '最多返回几条，默认 6' }
      },
      required: ['city']
    }
  },
  {
    name: 'search_poi',
    description: '查询某城市的景点/门票：返回景点名称、价格与飞猪购买链接。',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 丽江' },
        keyword: { type: 'string', description: '景点关键词，如 玉龙雪山，可选' },
        category: { type: 'string', description: '景点类型：nature/ancient town/museum/hot spring 等，可选' },
        limit: { type: 'number', description: '最多返回几条，默认 6' }
      },
      required: ['city']
    }
  },
  {
    name: 'search_train',
    description: '查询火车票/高铁：返回车次、出发到达站与时刻、历时、票价。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '出发城市，如 成都' },
        destination: { type: 'string', description: '目的城市，如 昆明' },
        dep_date: { type: 'string', description: '出发日期 YYYY-MM-DD' },
        journey_type: { type: 'number', enum: [1, 2], description: '1=只看直达，2=含中转，可选' },
        limit: { type: 'number', description: '最多返回几条，默认 8' }
      },
      required: ['origin', 'destination', 'dep_date']
    }
  }
];

const HANDLERS = {
  search_flight: searchFlight,
  search_hotel: searchHotel,
  search_poi: searchPoi,
  search_train: searchTrain
};

/** 处理一条 JSON-RPC 请求；通知类消息返回 null（不回复） */
async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNote = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fliggy-flyai', version: VERSION }
        }
      };
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    if (method === 'tools/call') {
      const name = params?.name;
      const fn = HANDLERS[name];
      if (!fn) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } };
      }
      const out = await fn(params?.arguments || {});
      const text = JSON.stringify(out, null, 2);
      // 工具内部失败（比如 451）不抛协议错误，交给模型看到原因后自己决定怎么说
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text }],
          isError: out.ok === false
        }
      };
    }
    if (isNote) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } };
  } catch (e) {
    if (isNote) return null;
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}

/* -------------------------------------------------------------- 两种传输层 */

function startStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleRpc(msg).then((resp) => {
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`[mcp-flyai] stdio ready, bin=${BIN}, mode=${MODE}, key=${KEYS.length} 把\n`);
}

function startHttp(port) {
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }
    if (req.method === 'GET' && req.url === '/tools') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tools: TOOLS }, null, 2));
    }
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        }
        const resp = await handleRpc(msg);
        if (!resp) { res.writeHead(202); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resp));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  srv.listen(port, '0.0.0.0', () => {
    process.stderr.write(`[mcp-flyai] http ready on 0.0.0.0:${port}  POST /mcp  GET /healthz  mode=${MODE} key=${KEYS.length} 把\n`);
  });
}

/* ------------------------------------------------------------------- 启动 */

const argv = process.argv.slice(2);
if (argv.includes('--http')) {
  const i = argv.indexOf('--port');
  startHttp(Number(i >= 0 ? argv[i + 1] : process.env.PORT) || 8090);
} else {
  startStdio();
}
