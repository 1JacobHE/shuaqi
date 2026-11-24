/*
 * 飞猪实时航班层（flyai CLI 封装）
 * ------------------------------------------------------------------
 * 只干一件事：给定 出发城市 + 目的城市 + 日期，拿回真实在售航班。
 * 返回的是**交易事实**——航班号、航司、起降机场与时刻、票价、飞猪下单链接。
 *
 * 双通道（官方 2026-10-21 口径：风控是 **AK 级、24 小时**）：
 *   - 有 Key →「正式通道」：价格完全解禁，每个 AK 独立 5000 次 + 用完每天 200 次（免费）。
 *   - 无 Key →「体验通道（游客模式）」：机票有真实价，火车/酒店价格脱敏成 ¥1xx。
 *   官方明确建议：可以**多申请 AK**。所以这里支持 Key 池轮换——
 *   某把 AK 被风控时自动换下一把，而不是在同一把锁上反复撞到 24 小时。
 *
 * 四条纪律（依据官方标定 + 2026-10-21 比赛群答复）：
 *   ① 两层闸门：条间隔 1.5s + 滚动窗口 18 次/60s（官方 20~24 次/60s，留 25% 边际）；
 *   ② 结果缓存（默认 30 分钟）：同一 from|date|dest 只在 TTL 内真正调用一次；
 *   ③ 风控熔断：命中 451/403 只冷却**当前 AK**，指数 30min→1h→2h…封顶 24h；
 *      不重试、不探测（探测只会重置计时）；
 *   ④ 失败即空：无可用 AK 时只用历史真价顶上并标注查询时间，绝不编价、绝不抛给上层。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* flyai CLI 的位置**不能写死成某台机器的绝对路径** —— 一发布到云端沙箱就是 Linux，
 * 那条 Windows 路径根本不存在，机票会全军覆没（而且不会报错，只会静默降级成缓存价）。
 * 按「就近原则」依次找：项目自带依赖 → 全局 node_modules → PATH 里的 flyai。 */
const DEFAULT_BIN = (() => {
  const cands = [
    path.join(HERE, 'node_modules', '@fly-ai', 'flyai-cli', 'dist', 'flyai-bundle.cjs'),
    path.join(HERE, '..', 'node_modules', '@fly-ai', 'flyai-cli', 'dist', 'flyai-bundle.cjs'),
    'C:/Users/73410/.workbuddy/binaries/node/workspace/node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs'
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 权限不足就跳过 */ } }
  return 'flyai';   // 装进 PATH 的场景（npm i -g / 沙箱 install 后）
})();

/** 游客模式用的干净 HOME：里面没有任何 .flyai/config.json，CLI 自动走体验通道 */
const GUEST_HOME = path.join(os.tmpdir(), 'flyai-guest');
try { fs.mkdirSync(GUEST_HOME, { recursive: true }); } catch { /* ignore */ }

/**
 * 取 Key 池（Key 不写进项目目录）。
 * 官方口径（2026-10-21 比赛群）：没有比赛专用 AK，但**可以多申请**，
 * 每个 AK 独立 5000 次 + 用完每天 200 次，全部免费；风控是 AK 级、时长 24 小时。
 * 所以这里支持多 Key 轮换：某个 AK 被风控时自动切下一个，不拖死整个服务。
 *
 * 优先级：FLYAI_API_KEYS(逗号分隔) > FLYAI_API_KEY(单个)
 *        > <项目>/data/flyai-keys.json（托管环境用）> ~/.flyai/config.json（本机用）
 *
 * 为什么要有项目内那一层：部署到云端时只上传项目目录，用户 HOME 里的
 * `~/.flyai/config.json` 不会跟着走 —— 2026-11-04 实测线上 `hasKey=false`、
 * 全程走游客通道。游客通道既没有 5000 次额度也没有独立风控隔离，一旦被收紧，
 * 「实时航班」就整条失效。所以托管环境必须能读到 Key。
 * 该文件只在服务端读，不在 public/ 内，不会被静态服务暴露。
 */
function resolveKeys() {
  const multi = (process.env.FLYAI_API_KEYS || '').trim();
  if (multi) return multi.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (process.env.FLYAI_API_KEY) return [process.env.FLYAI_API_KEY];
  const candidates = [
    path.join(HERE, 'data', 'flyai-keys.json'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.flyai', 'config.json')
  ];
  for (const p of candidates) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(c.FLYAI_API_KEYS) && c.FLYAI_API_KEYS.length) {
        const list = c.FLYAI_API_KEYS.filter(Boolean);
        if (list.length) return list;
      }
      if (c.FLYAI_API_KEY) return [c.FLYAI_API_KEY];
    } catch { /* 没有就试下一个 */ }
  }
  return [];
}

/** "220" → 3.7 小时；"2小时20分钟" 之类也兜住 */
function toHours(s, dep, arr) {
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.round((n / 60) * 10) / 10;
  if (dep && arr) {
    const d = new Date(arr.replace(/-/g, '/')) - new Date(dep.replace(/-/g, '/'));
    if (d > 0) return Math.round((d / 3600000) * 10) / 10;
  }
  return null;
}
const hhmm = (dt) => (typeof dt === 'string' && dt.length >= 16 ? dt.slice(11, 16) : '');
const ymdOnly = (dt) => (typeof dt === 'string' && dt.length >= 10 ? dt.slice(0, 10) : '');

/** 把 flyai 的一条 itemList 归一成与高铁 option 同构的结构（MCP 服务也复用，避免字段漂移） */
export function normalize(item, ctx) {
  const j = item?.journeys?.[0];
  const segs = j?.segments || [];
  if (!segs.length) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const price = Number(item?.ticketPrice);
  const stops = Math.max(0, segs.length - 1);
  return {
    no: first.marketingTransportNo || first.transportNo || '航班',
    kind: '航班', mode: 'flight',
    airline: first.marketingTransportName || '',
    from: first.depCityName || ctx.origin,
    to: last.arrCityName || ctx.destination,
    fromPort: first.depStationName || '',
    toPort: last.arrStationName || '',
    fromIata: first.depStationCode || '',
    toIata: last.arrStationCode || '',
    dep: hhmm(first.depDateTime), arr: hhmm(last.arrDateTime),
    depDate: ymdOnly(first.depDateTime), date: ctx.date,
    hours: toHours(j.totalDuration || item.totalDuration, first.depDateTime, last.arrDateTime),
    km: null, airlines: first.marketingTransportName ? [first.marketingTransportName] : [],
    seat: first.seatClassName || '经济舱',
    price: Number.isFinite(price) && price > 0 ? price : null,
    priceText: Number.isFinite(price) && price > 0 ? `¥${Math.round(price)}` : '',
    qty: '', stops, stopsText: stops ? `${stops} 次经停` : '直飞',
    live: true,
    jumpUrl: item?.jumpUrl || ctx.fallbackUrl,
    source: 'flyai'
  };
}

export function createFlyai(o = {}) {
  const bin = o.bin || process.env.FLYAI_BIN || DEFAULT_BIN;
  const KEYS = Array.isArray(o.keys) ? o.keys.filter(Boolean)
    : (o.key !== undefined ? (o.key ? [o.key] : []) : resolveKeys());
  const TTL = Math.max(60000, Number(o.ttlMs) || 30 * 60 * 1000);
  /* 并发 3 / 条间隔 400ms —— 2026-10-23 实测标定（举办方把 AK 开到 5 QPS 之后）：
   *   并发 1 + 3s 间隔   → 0.35 QPS（单条 CLI 往返就要 2.6s，串行被延迟卡死）
   *   并发 2 + 0 间隔    → 6/6 全成功，0.56 QPS，无 429
   *   并发 3 + 0 间隔    → 2/9 出现 429（瞬时限流，不是封禁）
   *   并发 3 + 400ms     → 9 条里 8 成功、耗时 5.6s（1.61 QPS），仅首条撞了一次 429
   * 所以取 3 并发 + 400ms：实测安全，30 个目的地约 19 秒（原来要 168 秒）。
   * 429 由下面 run 的重试逻辑吃掉，不会漏到用户面前。 */
  const LIMIT = Math.max(1, Number(o.concurrency) || 3);
  const GAP = Math.max(0, Number(o.gapMs ?? process.env.FLYAI_GAP_MS) || 400);
  const TIMEOUT = Math.max(8000, Number(o.timeoutMs) || 30000);

  /* ── 配额真相 ────────────────────────────────────────────────────────
   * 旧口径（2026-10-21 之前）：滚动窗口约 20~24 次/60s；
   *   超了带 Key → HTTP 451「Abnormal access behavior detected by risk control」，封 24 小时。
   *
   * 新口径（2026-10-23，举办方为该 AK 开到 **5 QPS** = 300 次/60s）：
   *   实测并发 3 时偶发 **HTTP 429**（瞬时限流，秒级恢复，**不是** 24 小时封禁），
   *   加重试即可；跑不到 5 QPS 是 CLI 单条往返 2.6s 的延迟限制，不是配额不够。
   *
   * 这里仍留 5 倍边际：窗口 60 次 / 60s（授权 300）。留着不是为了省，是怕
   * 5 QPS 只是给「短时突发」而不是「持续满速」——边际换的是不被封号。
   */
  const WIN_MAX = Math.max(1, Number(o.windowMax) || Number(process.env.FLYAI_WINDOW_MAX) || 60);
  const WIN_MS = Math.max(10000, Number(o.windowMs) || 60000);

  /* 风控熔断：官方 2026-10-21 口径 —— 风控时长 **24 小时**。
   * 实测补充（同日）：**重置 AK 后新 Key 依然 451** → 封禁记在账号上，不在 Key 上，
   * 所以「换 Key 试一下」没有任何意义，只会把 24 小时重新计时。
   *
   * 因此冷却直接取满 24 小时（不做 30min 起步的指数增长）：
   * 只要试探一次就重置真封禁，低估冷却时长 = 主动亏掉一整天。
   * 若确认已解封，用 resetRisk() 手动清零再试（一次只发一条，别扫）。 */
  const RISK_BASE = Number(o.riskCooldownMs) || 24 * 3600 * 1000;
  const RISK_CAP = Number(o.riskCooldownMaxMs) || RISK_BASE;
  const RISK_RE = /Abnormal access behavior|risk control|HTTP 451|HTTP 403/i;

  const binReady = fs.existsSync(bin);
  const hasKey = KEYS.length > 0;
  /** 每个 AK 独立状态：冷却/命中按 AK 记——官方风控是 AK 级、24 小时 */
  const keyPool = KEYS.map((k, i) => ({ key: k, tag: `AK#${i + 1}`, cool: 0, hits: 0, uses: 0 }));
  // 通道模式：auto（有 Key 优先正式、被封自动降级体验）| guest（永远体验通道）| keyed（永远正式）
  const MODE = (process.env.FLYAI_MODE || (hasKey ? 'auto' : 'guest')).toLowerCase();

  // ── 磁盘价格库：把「成功查到的真实票价」记下来。
  // 飞猪风控是按出口 IP 判定的（实测：换 Key、换设备指纹、换航线日期，仍然 403），
  // 一旦被拦，实时层就没价。这时用同一条航线**上次真实查到的价**顶上，
  // 前端标注查询时间——宁可显示「2 小时前的真价」，也不显示空白或编一个数字。
  const DATA_DIR = o.dataDir || process.env.FLYAI_DATA_DIR || path.join(HERE, 'data');
  const PRICE_FILE = path.join(DATA_DIR, 'flight-cache.json');
  const STALE_TTL = Math.max(3600e3, Number(o.staleTtlMs) || 7 * 24 * 3600e3);
  const PRICE_MAX = Math.max(100, Number(o.priceMaxKeys) || 800);
  let priceDisk = {};
  try { if (fs.existsSync(PRICE_FILE)) priceDisk = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8')) || {}; } catch { priceDisk = {}; }
  let priceDirty = false;
  const flushPrice = () => {
    if (!priceDirty) return;
    priceDirty = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const keys = Object.keys(priceDisk);
      if (keys.length > PRICE_MAX) {                    // 淘汰最旧的航线
        keys.sort((a, b) => (priceDisk[a].t || 0) - (priceDisk[b].t || 0));
        for (const k of keys.slice(0, keys.length - PRICE_MAX)) delete priceDisk[k];
      }
      fs.writeFileSync(PRICE_FILE, JSON.stringify(priceDisk));
    } catch { /* 磁盘写失败不影响运行 */ }
  };
  setInterval(flushPrice, 8000).unref();
  process.on('exit', flushPrice);

  const cache = new Map();     // key → { at, list, error }
  const inflight = new Map();  // key → Promise
  let active = 0;
  let lastAt = 0;
  let cooldownUntil = 0;       // 风控熔断截止（**全局**：两个通道共用同一账号配额）
  let riskHits = 0;            // 连续命中次数 → 决定冷却指数

  /* ── 熔断状态落盘 ────────────────────────────────────────────────────────
   * 实测（2026-10-21）：**重置 AK 后新 Key 依然 451** → 风控记在账号上，不在 Key 上。
   * 也就是说，只要这个 uid 被封，换多少把 Key 都没用。
   *
   * 那熔断状态就不能只放内存里：进程一重启（点「启动.bat」、改配置、崩溃重拉）
   * 冷却就被清空，用户随手点一下「搜索」又会打出几十个请求，把 24 小时重新计时。
   * 所以把截止时间写到磁盘，重启后继续生效 —— 这是演示当天最容易踩的坑。
   */
  const RISK_FILE = path.join(DATA_DIR, 'risk-state.json');
  try {
    const s = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
    riskHits = Number(s.hits) || 0;
    if (s.keys && typeof s.keys === 'object') {
      /* 新格式：按 Key 记冷却。池里两把 Key 属于两个不同账号，
       * 封禁的起算点和时长都不一样，必须各算各的（2026-10-23）。 */
      for (const k of keyPool) {
        const u = Number(s.keys[k.tag]) || 0;
        if (u > Date.now()) k.cool = u;
      }
      if (Number(s.until) > Date.now()) cooldownUntil = Number(s.until);   // 游客通道
    } else if (Number(s.until) > Date.now()) {
      /* 旧格式（全局一份，分不清是谁被封）：保守只算在池里第一把头上，
       * 其余 Key 留活口交给 pickKey 去试 —— 试通即自愈，试不通会重新按 Key 落盘。 */
      const hot = keyPool[0];
      if (hot) hot.cool = Number(s.until);
    }
  } catch { /* 没有历史状态就是没被风控过 */ }
  const flushRisk = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const keys = {};
      for (const k of keyPool) if (k.cool > Date.now()) keys[k.tag] = k.cool;
      fs.writeFileSync(RISK_FILE, JSON.stringify({
        until: cooldownUntil > Date.now() ? cooldownUntil : 0,
        keys, hits: riskHits, at: Date.now()
      }));
    } catch { /* 写不进去不影响运行 */ }
  };
  const queue = [];
  const windowStamps = [];     // 滚动窗口时间戳
  const stat = { calls: 0, hits: 0, fails: 0, lastError: '', mode: MODE, guestUsed: 0, keyedUsed: 0, staleUsed: 0, blocked: 0, dayUsed: 0, dayMax: 0, rateLimited: 0 };

  /* ── 第三层闸门：单日累计预算 ──────────────────────────────────────────────
   * 前两层（条间隔、滚动窗口）管的是「瞬间多快」，管不住「一天打多少」。
   * 2026-10-21 的教训正出在这里：当天累计 52 次调用，其中 4 次 451，账号直接封 24 小时。
   * 单次扫描预热 8 条看起来很温柔，但缓存按「出发城市+日期」分片——
   * 换个日期就是全新的一批 key，缓存全 miss，于是每次扫描都按满额重打。
   * 演示那天连着换 10-28 / 10-25 / 10-29 三个日期各扫一遍，24 秒的温柔扫描
   * 就这么叠成了 52 次。窗口闸门全程没觉得有问题，账号画像却已经进风控了。
   *
   * 所以必须有累计账本。2026-10-23 举办方把 AK 开到 5 QPS 后，日上限从 40 提到 400
   * （一次扫描约 42 次 = 30 预热 + 12 热门补价，够演示 9 轮；仍然落盘、仍然超支即停）。
   * 超支后零请求、全走缓存真价。宁可少几条实时价，也不能把演示当天的账号打封。 */
  /* 0 = 不设上限（显式关闭）。注意不能用 `|| 400`：那样 dayMax=0 会被吞成 400，
   * 想关闸门反而变成每天 400 次，语义正好反了。 */
  const DAY_MAX = (() => {
    const raw = o.dayMax ?? process.env.FLYAI_DAY_MAX;
    if (raw === undefined || raw === null || raw === '') return 400;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 400;
  })();
  const DAY_FILE = path.join(DATA_DIR, 'flyai-day.json');
  const dayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);  // 按北京时区分天
  let dayState = { date: dayKey(), used: 0 };
  try {
    const s = JSON.parse(fs.readFileSync(DAY_FILE, 'utf8'));
    if (s && s.date === dayState.date) dayState.used = Number(s.used) || 0;
  } catch { /* 没账本就从 0 开始 */ }
  stat.dayUsed = dayState.used;
  stat.dayMax = DAY_MAX;
  const flushDay = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DAY_FILE, JSON.stringify({ date: dayState.date, used: dayState.used, at: Date.now() }));
    } catch { /* 写不进去不影响运行 */ }
  };
  const dayLeft = () => {
    const d = dayKey();
    if (d !== dayState.date) { dayState = { date: d, used: 0 }; flushDay(); }  // 跨天自动清零
    stat.dayUsed = dayState.used;
    return DAY_MAX > 0 ? DAY_MAX - dayState.used : Infinity;   // 0 = 不限制
  };

  /**
   * 三层闸门：条间隔 GAP + 滚动窗口 WIN_MAX/WIN_MS + 单日累计 DAY_MAX。
   * 前两层管瞬间速率，第三层管全天总量——少了哪一层都会在演示当天出事。
   */
  async function gate() {
    const wait = lastAt + GAP - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    for (;;) {
      const now = Date.now();
      while (windowStamps.length && now - windowStamps[0] >= WIN_MS) windowStamps.shift();
      if (windowStamps.length < WIN_MAX) { windowStamps.push(now); break; }
      await new Promise(r => setTimeout(r, WIN_MS - (now - windowStamps[0]) + 80));
    }
    lastAt = Date.now();
  }

  function acquire() {
    if (active < LIMIT) { active++; return Promise.resolve(); }
    return new Promise((res) => queue.push(res));
  }
  function release() {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  }

  /**
   * 子进程环境：剔除所有代理变量。
   * 本机 127.0.0.1:60700 是宿主沙箱的**共享出口代理**（sandbox-cli），
   * 一旦 CLI 内部读代理变量，请求就会从机房共享 IP 出去——登录态/票价接口
   * 对机房 ASN 的容忍度远低于家宽，属于自找风控。
   * 家宽直连更"像人"，也让出口 IP 可控可换（换热点即换 IP）。
   */
  function childEnv(extra) {
    const e = { ...process.env };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete e[k];
    return { ...e, ...extra };
  }

  /** keyUsed 为空 → 游客通道（HOME 指到无 config 的临时目录，强制体验模式） */
  function run(origin, destination, date, keyUsed) {
    return new Promise((resolve) => {
      const args = [bin, 'search-flight', '--origin', origin, '--destination', destination, '--dep-date', date];
      const env = keyUsed
        ? childEnv({ FLYAI_API_KEY: keyUsed })
        : childEnv({ FLYAI_API_KEY: '', USERPROFILE: GUEST_HOME, HOME: GUEST_HOME, APPDATA: GUEST_HOME });
      const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, TIMEOUT);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', () => {
        clearTimeout(timer);
        stat.calls++;
        try {
          const j = JSON.parse(out);
          const items = Array.isArray(j?.data?.itemList) ? j.data.itemList : [];
          if (!items.length) {
            const msg = j?.message || j?.systemMessage || '无航班数据';
            stat.fails++;
            stat.lastError = msg;
            return resolve({ list: [], error: msg });
          }
          const ctx = { origin, destination, date };
          const list = items.map((it) => normalize(it, ctx)).filter(Boolean);
          resolve({ list, error: '' });
        } catch (e) {
          stat.fails++;
          stat.lastError = (err || String(e.message)).replace(/\s+/g, ' ').slice(0, 160);
          resolve({ list: [], error: stat.lastError });
        }
      });
    });
  }

  /** 不发请求时的返回：有历史真价就顶上（标注查询时间），没有就空 */
  function staleOrEmpty(ck, err) {
    const oc = priceDisk[ck];
    if (oc && Array.isArray(oc.list) && oc.list.length && Date.now() - (Number(oc.t) || 0) < STALE_TTL) {
      const stale = oc.list.map((x) => ({ ...x, priceStale: true, priceAt: Number(oc.t) || 0 }));
      stat.staleUsed++;
      return { list: stale, error: err, channel: 'cooling', stale: true, staleAt: Number(oc.t) || 0, cooling: true };
    }
    return { list: [], error: err, channel: 'cooling', cooling: true };
  }

  /**
   * 选一个 AK：未冷却的里面挑**用得最少**的（均衡消耗，别把单个 AK 的 5000 次先打光）。
   * 全都在冷却 → 返回 null，调用方直接停手。
   * exclude：本次查询已经试过的 AK（命中风控后换下一把用）。
   */
  function pickKey(exclude) {
    const now = Date.now();
    const live = keyPool.filter((s) => now >= s.cool && !(exclude && exclude.has(s.tag)));
    if (!live.length) return null;
    live.sort((a, b) => a.uses - b.uses);
    return live[0];
  }

  /** 查一次；命中缓存直接返回，同参数并发只打一次 */
  async function searchFlight({ origin, destination, date, fallbackUrl = '', cachedOnly = false }) {
    const ck = `${origin}|${date}|${destination}`;
    /* cachedOnly：首屏预渲染 / 离线演示专用 —— 只读磁盘上的历史真价，一个请求都不发。
     * 这里刻意**不套 STALE_TTL**：调用方是「绝不编价、但可以标查询时间」的场景，
     * 过期与否由前端如实显示「X 前查询」，比直接不显示价格对用户更有用。 */
    if (cachedOnly) {
      const oc = priceDisk[ck];
      if (!oc || !Array.isArray(oc.list) || !oc.list.length) return { list: [], error: 'no-cache', channel: 'cache' };
      stat.staleUsed++;
      return {
        list: oc.list.map((x) => ({ ...x, priceStale: true, priceAt: Number(oc.t) || 0 })),
        error: '', channel: 'cache', stale: true, staleAt: Number(oc.t) || 0
      };
    }
    if (!binReady) return { list: [], error: 'flyai-unavailable', cached: false };
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < TTL) {
      stat.hits++;
      return { list: hit.list, error: hit.error, cached: true };
    }
    if (inflight.has(ck)) {
      const r = await inflight.get(ck);
      return { ...r, cached: true };
    }
    const task = (async () => {
      await acquire();
      try {
        /* 选 AK → 调用 → 命中风控换下一把，放在一个循环里。
         * 风控记在**账号**上（2026-10-21 实测：同账号重置 Key 仍 451），但不同账号互不牵连
         * （2026-10-23 实测：AK#1 451 时 AK#2 立刻出价）。所以命中 451 后要换池里另一把把
         * 这一条查完 —— 以前是直接判死，用户看到的就是「明明在卖票，票价却以飞猪为准」。
         * 同一把 Key 绝不重试：那只会把 24 小时重新计时。 */
        const tried = new Set();
        let picked = null;
        let r = { list: [], error: '' };
        for (;;) {
          picked = MODE === 'guest' ? null : pickKey(tried);
          if (MODE === 'guest' && Date.now() < cooldownUntil) {
            // 游客通道没有 Key 可选，只能整体停手（探测只会重置 24h 计时）
            stat.blocked++;
            return staleOrEmpty(ck, 'CLIENT_COOLDOWN');
          }
          if (MODE !== 'guest' && !picked) {
            stat.blocked++;                       // 所有 AK 都在冷却里
            return staleOrEmpty(ck, 'ALL_KEYS_COOLING');
          }

          /* 第三层闸：单日累计预算。到顶就零请求，全走缓存真价。
           * 前两层（条间隔 / 滚动窗口）只管「瞬间多快」，管不住「一天打多少」。 */
          if (dayLeft() <= 0) {
            stat.blocked++;
            stat.lastError = `今日飞猪预算已用完（${stat.dayUsed}/${DAY_MAX}），改用缓存真价`;
            return staleOrEmpty(ck, 'DAY_BUDGET');
          }

          await gate();
          /* 先记账再发请求：进程中途被杀 / 超时都要算进当天总量。
           * 少算一次就可能导致多打一轮，而多打一轮的代价是 24 小时封禁。 */
          dayState.used++;
          stat.dayUsed = dayState.used;
          flushDay();
          const keyUsed = picked ? picked.key : '';
          r = await run(origin, destination, date, keyUsed);

          /* 429 = 瞬时限流，**不是封禁**（2026-10-23 实测：并发 3 时偶发，隔一秒重发就好）。
           * 之前没区分，用户看到的是「这个城市没有航班」——把限流当成了没数据，
           * 一个本来能出的目的地就这么在页面上消失了。重试同样计入日预算。 */
          for (let retry = 0; retry < 3 && /HTTP\s*429|Too Many Requests|rate limit/i.test(r.error || ''); retry++) {
            stat.rateLimited = (stat.rateLimited || 0) + 1;
            stat.lastError = `429 瞬时限流，第 ${retry + 1} 次重试`;
            await new Promise((res) => setTimeout(res, 700 * (retry + 1) + Math.floor(Math.random() * 300)));
            dayState.used++; stat.dayUsed = dayState.used; flushDay();
            await gate();
            r = await run(origin, destination, date, keyUsed);
          }
          if (picked) { picked.uses++; stat.keyedUsed++; tried.add(picked.tag); } else { stat.guestUsed++; }

          /* 命中风控：**这一把 Key 停手**，同 Key 绝不重试。
           * 风控记在账号（uid）上而不是 Key 本身 —— 2026-10-21 实测：同一账号重置出新 Key，
           * 第一条依旧 451。 */
          if (!RISK_RE.test(r.error || '')) break;

          riskHits++;
          const cool = Math.min(RISK_CAP, RISK_BASE * 2 ** (riskHits - 1));
          const hitUntil = Date.now() + cool;
          if (picked) {
            picked.hits++;
            picked.cool = Math.max(picked.cool, hitUntil);
            stat.lastError = `${picked.tag} 命中风控（账号级），这把停手 ${Math.round(cool / 60000)} 分钟`;
          } else {
            stat.lastError = `游客通道命中风控，停手 ${Math.round(cool / 60000)} 分钟`;
            cooldownUntil = Math.max(cooldownUntil, hitUntil);
          }
          // 池子里一把都不剩了才升级成全局停手（游客通道也跟着停）
          if (!keyPool.some((s) => s.cool <= Date.now())) cooldownUntil = Math.max(cooldownUntil, hitUntil);
          flushRisk();

          /* 池里还有别的账号的 Key → 立刻换一把把这一条查完（换 Key 重试不是「对同一把重试」，
           * 不会加深封禁；这一次多花的只是一次日预算）。 */
          if (!picked) break;
          const alt = pickKey(tried);
          if (!alt) break;
          stat.lastError += `；已换 ${alt.tag} 继续查`;
        }
        const list = r.list.map((x) => (fallbackUrl && !x.jumpUrl ? { ...x, jumpUrl: fallbackUrl } : x));
        const ch = picked ? 'keyed' : 'guest';

        if (list.length) {
          // 拿到真实票价 → 记进磁盘库，供风控期间顶上
          priceDisk[ck] = { t: Date.now(), list: list.map((x) => ({ ...x, priceStale: false, priceAt: 0 })) };
          priceDirty = true;
          // 真的通了 → 这把 Key 的冷却与命中计数归零（别的 Key 的账不动）
          if (picked && (picked.cool || picked.hits)) { picked.cool = 0; picked.hits = 0; flushRisk(); }
          if (!keyPool.some((s) => s.cool > Date.now())) { riskHits = 0; cooldownUntil = 0; flushRisk(); }
          cache.set(ck, { at: Date.now(), list, error: '' });
          return { list, error: '', channel: ch };
        }

        // 实时为空（风控 / 无直飞）→ 用同一航线上次查到的真实价格兜底，
        // 并打上 priceStale 让前端标注「X 前查询」，绝不显示空白也不编价。
        const old = priceDisk[ck];
        if (old && Array.isArray(old.list) && old.list.length && Date.now() - (Number(old.t) || 0) < STALE_TTL) {
          const stale = old.list.map((x) => ({ ...x, priceStale: true, priceAt: Number(old.t) || 0 }));
          cache.set(ck, { at: Date.now() - TTL + 5 * 60 * 1000, list: stale, error: r.error });  // 5 分钟后再试实时
          stat.staleUsed++;
          return { list: stale, error: r.error, channel: ch, stale: true, staleAt: Number(old.t) || 0 };
        }

        // 成功缓存整段 TTL；失败只缓存 30 秒（别把一次抖动记成 30 分钟的「没航班」）
        cache.set(ck, { at: Date.now() - TTL + 30000, list: [], error: r.error });
        return { list: [], error: r.error, channel: ch };
      } finally { release(); }
    })();
    inflight.set(ck, task);
    try { return { ...(await task), cached: false }; }
    finally { inflight.delete(ck); }
  }

  return {
    ready: binReady,            // CLI 可用（无论是否有 Key）
    available: binReady,        // 总能拿到航班（正式或体验通道）
    hasKey,
    mode: MODE,
    /** 熔断期内不发请求，只用磁盘里的历史真价顶上 */
    searchFlight: (q) => searchFlight(q),
    stats: () => {
      const left = dayLeft();          // 顺带处理跨天清零，并刷新 stat.dayUsed
      return {
        ready: binReady, mode: MODE, hasKey,
        concurrency: LIMIT, gapMs: GAP, window: `${WIN_MAX}/${Math.round(WIN_MS / 1000)}s`,
        dayBudget: `${stat.dayUsed}/${DAY_MAX || '不限'}`,
        dayLeft: DAY_MAX ? Math.max(0, left) : -1,
        cached: cache.size,
        priceCached: Object.keys(priceDisk).length,
        coolingMin: (() => {
          // 只要还有一把 Key 能发请求，就不算冷却中（按 Key 计时，不再一把封全池停）
          if (keyPool.some((s) => s.cool <= Date.now())) return 0;
          const rem = keyPool.map((s) => s.cool - Date.now()).filter((n) => n > 0);
          return rem.length ? Math.max(0, Math.ceil(Math.min(...rem) / 60000)) : 0;
        })(),
        riskHits,
        akCount: keyPool.length,
        ak: keyPool.map((s) => ({
          tag: s.tag, uses: s.uses, hits: s.hits,
          coolMin: Math.max(0, Math.ceil((s.cool - Date.now()) / 60000))
        })),
        ...stat
      };
    },
    clear: () => cache.clear(),
    /** 手动解除熔断（确认已解封后使用；解除后只发一条试探，别直接扫） */
    /** 手动解除熔断（确认已解封后使用；解除后只发一条试探，别直接扫）
     *  resetDay=true 时同时清零当天累计账本 —— 只在调试时用，正常别清。 */
    resetRisk: (resetDay = false) => {
      riskHits = 0; cooldownUntil = 0;
      for (const s of keyPool) { s.cool = 0; s.hits = 0; }
      flushRisk();
      if (resetDay) { dayState = { date: dayKey(), used: 0 }; stat.dayUsed = 0; flushDay(); }
      stat.lastError = '';
    }
  };
}
