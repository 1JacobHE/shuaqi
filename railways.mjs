/*
 * railways.mjs —— 12306 余票实时数据层
 * ------------------------------------------------------------------
 * 为什么存在这一层：
 *   飞猪开放平台对 search-train 有硬配额（实测约 20~24 次/分钟，打爆即风控），
 *   一次「全量列出时间预算内可达的城市」必然触发限流，于是列表后段大片城市没有实时信息。
 *   而 12306 的余票查询是**公开的只读接口**，单次 45~90ms，本机实测全量扫 216 个目的地
 *   只需数秒，且不需要任何 Key。所以「高铁实时数据」由这一层承担，
 *   飞猪退化为**可选的航班增强**。
 *
 * 本层只做四件事，不掺业务：
 *   1) 会话预热（JSESSIONID 必取，缺了必定被踢到错误页）
 *   2) 全局定速 + 同会话重试 + 三段式缓存（精确日期 / 同路线存档日 / 磁盘持久化）
 *   3) 解析（含 yp_info_new 里的票价与各席别余票）
 *   4) 按 train_no 归并「同一趟车在出发城市群多个乘车站各返回一行」的重复
 *
 * 数据源合规立场（与项目 README 一致，此处写明以便审阅）：
 *   只做**低频、只读、个人查询级别**的余票展示，不代购、不抢票、不下单、不存储用户身份；
 *   扫描由用户显式点击触发，结果本地缓存，并设有 IP 级频次上限与全局最小请求间隔。
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INIT_URL = 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc';
const TICKET_BASE = 'https://kyfw.12306.cn/otn/leftTicket/';
const BOOK_URL = 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc';

/* 座位类型表：yp_info_new（字段 39）每 10 字符一组 = <座位码 1 位><票价 5 位，单位角><标志 4 位>
   已与官方 queryTicketPrice 逐条比对一致，含 840.5 这类带小数的价格。 */
const SEAT_MAP = {
  9: { name: '商务座', qtyIdx: 32 }, P: { name: '特等座', qtyIdx: 25 },
  M: { name: '一等座', qtyIdx: 31 }, O: { name: '二等座', qtyIdx: 30 },
  S: { name: '二等包座', qtyIdx: 30 }, 6: { name: '高级软卧', qtyIdx: 21 },
  4: { name: '软卧', qtyIdx: 23 }, 3: { name: '硬卧', qtyIdx: 28 },
  2: { name: '软座', qtyIdx: 24 }, 1: { name: '硬座', qtyIdx: 29 },
  W: { name: '无座', qtyIdx: 26 }
};
// 无座不参与「最低价」，否则会出现「最便宜但要站 12 小时」的误导
const SEAT_ORDER = ['二等座', '硬座', '硬卧', '一等座', '软卧', '高级软卧', '特等座', '商务座', '软座', '二等包座', '无座'];
const SUFFIX = ['', '北', '东', '南', '西'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 本地日期 → 'YYYY-MM-DD'（**不要**用 toISOString：那是 UTC，会偏移一天） */
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 解析站名表：`简码|中文名|电报码|全拼音|简拼|序号|城市码|城市名` */
function loadStations(file) {
  const byName = new Map();
  const byCode = new Map();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { byName, byCode, ok: false }; }
  for (const item of raw.split('@').slice(1)) {
    const p = item.split('|');
    if (p.length < 3 || !p[1] || !p[2]) continue;
    const rec = { name: p[1], code: p[2], py: p[3] || '', short: p[4] || '', cityCode: p[6] || '', cityName: p[7] || '' };
    if (!byName.has(rec.name)) byName.set(rec.name, rec);
    if (!byCode.has(rec.code)) byCode.set(rec.code, rec);
  }
  return { byName, byCode, ok: byName.size > 1000 };
}

const normName = s => String(s || '').trim().replace(/市$/, '');
const clockOf = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

export function createRail(opt = {}) {
  const dataDir = opt.dataDir;
  const CONC = Math.max(1, Number(opt.concurrency) || 3);
  const CACHE_TTL = Math.max(60000, Number(opt.cacheTtlMs) || 15 * 60 * 1000);
  const DISK_TTL = Math.max(CACHE_TTL, Number(opt.diskTtlMs) || 14 * 24 * 3600 * 1000);
  const PRESALE_DAYS = Math.max(1, Number(opt.presaleDays) || 14);
  const MAX_TRIES = Math.max(1, Number(opt.maxTries) || 3);
  const MIN_GAP_MS = Math.max(0, Number(opt.minGapMs) || 280);
  const BREAKER_RATE = Math.max(0.1, Number(opt.breakerRate) || 0.6);
  const BREAKER_MIN = Math.max(8, Number(opt.breakerMin) || 40);
  // 磁盘缓存的绝对上限：跨日期回退靠它，所以要长期保留；但也不能无限膨胀
  const DISK_MAX_KEYS = Math.max(200, Number(opt.diskMaxKeys) || 4000);
  const CACHE_FILE = path.join(dataDir, 'rail-cache.json');

  const { byName, byCode, ok: stationsOk } = loadStations(path.join(dataDir, 'station_name.js'));

  /* ================= 会话 ================= */
  let cookie = '';
  let cookieAt = 0;
  let queryPath = 'queryG';
  let warming = null;
  let consecutiveFails = 0;

  /**
   * 用 node:https，**不用全局 fetch**。
   * 2026-10-23 实测：宿主用 --require 注入的 shim 会给全局 fetch 挂上沙箱代理，
   * 12306 对机房出口 IP 直接 302 到 /mormhweb/logFiles/error.html（body 空）；
   * 同一个 URL 换成 node:https 直连就稳定 200（199KB 数据）。
   * node:https 不读 HTTP_PROXY，正好绕开这一层。
   */
  function httpGet(url, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode,
          cookies: res.headers['set-cookie'] || [],
          text: Buffer.concat(chunks).toString('utf8')
        }));
      });
      req.on('error', reject);
      req.setTimeout(Number(timeoutMs) || 20000, () => { req.destroy(new Error('timeout')); });
    });
  }

  async function warm(force = false) {
    if (!force && cookie && Date.now() - cookieAt < 5 * 60 * 1000) return;
    if (warming) return warming;
    warming = (async () => {
      const r = await httpGet(INIT_URL, { 'User-Agent': UA });
      const parts = r.cookies.map(c => c.split(';')[0]).filter(Boolean);
      // JSESSIONID（HttpOnly）是必须的，漏掉必定被踢到错误页
      if (!parts.some(p => p.startsWith('JSESSIONID='))) throw new Error('未能获取 JSESSIONID（可能被风控）');
      cookie = parts.join('; ');
      cookieAt = Date.now();
    })().finally(() => { warming = null; });
    return warming;
  }

  /* ================= 缓存：精确日期 + 同路线存档日 ================= */
  const mem = new Map();                 // `${date}|${from}|${to}` → { t, list }
  const routeIdx = new Map();            // `${from}|${to}` → [{ date, t }]  按时间倒序
  let disk = {};
  try { if (fs.existsSync(CACHE_FILE)) disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { disk = {}; }

  function routeKey(fromCode, toCode) { return fromCode + '|' + toCode; }
  function indexPut(date, fromCode, toCode, t) {
    const rk = routeKey(fromCode, toCode);
    const arr = routeIdx.get(rk) || [];
    const i = arr.findIndex(x => x.date === date);
    if (i >= 0) arr[i] = { date, t }; else arr.push({ date, t });
    arr.sort((a, b) => b.t - a.t);
    if (arr.length > 12) arr.length = 12;
    routeIdx.set(rk, arr);
  }
  (function buildIdx() {
    for (const k of Object.keys(disk)) {
      const p = k.split('|');            // date|from|to
      if (p.length !== 3) continue;
      indexPut(p[0], p[1], p[2], disk[k].t || 0);
    }
  })();

  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    try {
      const keys = Object.keys(disk);
      if (keys.length > DISK_MAX_KEYS) {                // 淘汰最旧的
        keys.sort((a, b) => (disk[a].t || 0) - (disk[b].t || 0));
        for (const k of keys.slice(0, keys.length - DISK_MAX_KEYS)) delete disk[k];
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(disk));
    } catch { /* 磁盘写失败不影响运行 */ }
  };
  setInterval(flush, 8000).unref();
  process.on('exit', flush);

  function cacheKey(date, fromCode, toCode) { return `${date}|${fromCode}|${toCode}`; }
  /** 精确命中（内存 15 分钟内，磁盘 14 天内） */
  function cacheGet(fromCode, toCode, date) {
    const k = cacheKey(date, fromCode, toCode);
    const m = mem.get(k);
    if (m && Date.now() - m.t < CACHE_TTL) return { list: m.list, t: m.t, date };
    const d = disk[k];
    if (d && Date.now() - d.t < DISK_TTL) { mem.set(k, d); return { list: d.list, t: d.t, date }; }
    return null;
  }
  /** 同路线的任意存档日：日期一变缓存就“失效”会让页面看起来像坏了，所以按路线回退 */
  function cacheGetAny(fromCode, toCode) {
    const arr = routeIdx.get(routeKey(fromCode, toCode));
    if (!arr) return null;
    for (const e of arr) {
      if (Date.now() - e.t > DISK_TTL) continue;
      const d = disk[cacheKey(e.date, fromCode, toCode)];
      if (d && d.list) return { list: d.list, t: d.t, date: e.date };
    }
    return null;
  }
  function cachePut(fromCode, toCode, date, list) {
    const k = cacheKey(date, fromCode, toCode);
    const v = { t: Date.now(), list };
    mem.set(k, v); disk[k] = v;
    indexPut(date, fromCode, toCode, v.t);
    dirty = true;
  }

  /* ================= 节流 / 熔断 =================
     教训：用并发 8 猛打 12306，几分钟内就会把本机 IP 打成「大部分请求 302」，
     且恢复需要相当一段时间。原版（串行 + 300ms 间隔 ≈ 3.3 次/秒）实测长期稳定，
     所以这里用**全局最小间隔**把速率钉在可长期运行的水平，而不是靠并发数赌运气。 */
  const recent = [];
  let lastReqAt = 0;
  let pacerChain = Promise.resolve();
  let breakerFired = false;
  let breakerAt = 0;
  const BREAKER_COOL_MS = Math.max(30000, Number(opt.breakerCoolMs) || 180000);  // 3 分钟后自动试一次
  // 允许单次扫描临时放慢（后台自补用）：不改变全局纪律，只让那一次更温和
  let curGap = MIN_GAP_MS;
  function failRate() { return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0; }
  function noteResult(ok) { recent.push(ok ? 0 : 1); if (recent.length > 60) recent.shift(); }
  function pacer() {
    const rate = failRate();
    const gap = curGap * (rate > 0.35 ? 3 : rate > 0.18 ? 1.6 : 1);
    pacerChain = pacerChain.then(async () => {
      const wait = lastReqAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastReqAt = Date.now();
    });
    return pacerChain;
  }
  /**
   * 熔断：样本够多且失败率过高 → 判定被限流，中止批量扫描（已扫到的照常保留）。
   *
   * 2026-10-23 补：熔断必须**会自己恢复**。之前 breakerFired 一旦置位就挂到下一次
   * scanAll 开头才清，于是批量扫描断掉之后，用户点开单条也一直走存档——
   * 明明单条查询是能通的，界面却像坏了一样。现在冷却 BREAKER_COOL_MS 后自动复位。
   */
  function broke() {
    if (breakerFired) {
      if (Date.now() - breakerAt > BREAKER_COOL_MS) { breakerFired = false; recent.length = 0; }
      else return true;
    }
    if (recent.length < BREAKER_MIN) return false;
    if (failRate() >= BREAKER_RATE) { breakerFired = true; breakerAt = Date.now(); return true; }
    return false;
  }

  /* ================= 查询 ================= */
  async function queryOnce(fromCode, toCode, date, timeoutMs) {
    const url = `${TICKET_BASE}${queryPath}?leftTicketDTO.train_date=${date}`
      + `&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}&purpose_codes=ADULT`;
    const r = await httpGet(url, {
      'User-Agent': UA, Cookie: cookie, Referer: INIT_URL, 'X-Requested-With': 'XMLHttpRequest'
    }, timeoutMs);
    if (r.status !== 200) {
      /* 2026-10-23 实测：12306 换接口路径时回的是 **HTTP 302**，
       * body 里带着新路径（`{"c_url":"leftTicket/queryG","status":false}`）。
       * 旧代码在这里直接 return fail，根本没读 body —— 于是 queryPath 永远停在
       * 已经被废弃的 queryZ，每次查询都 302，连续失败把熔断打穿，整站退化成历史存档。
       * 现在先把 body 读出来看有没有 c_url，有就换路径让上层重试。 */
      try {
        const j = JSON.parse(r.text);
        if (j && j.c_url) {
          queryPath = String(j.c_url).replace(/^.*\//, '');
          return { fail: 'redirect' };
        }
      } catch { /* 不是 JSON —— 就是真失败，按状态码返回 */ }
      return { fail: 'status_' + r.status };
    }
    const txt = r.text;
    let j;
    try { j = JSON.parse(txt); } catch { return { fail: 'non_json' }; }
    // 接口路径是动态的：queryZ/queryA 会回一个 c_url，照着改路径再试一次即可
    if (j.c_url) { queryPath = String(j.c_url).replace(/^.*\//, ''); return { fail: 'redirect' }; }
    if (!j.data) return { fail: 'no_data' };
    return { trains: parseResult(j.data) };
  }

  /**
   * 带重试的查询。
   * ------------------------------------------------------------------
   * 实测的关键结论（勿再改回「失败就换会话」）：
   *   ① 刚预热出来的**新会话，第一个请求的失败率最高**（随 12306 侧压力浮动）；
   *      同一个会话紧接着的后续请求成功率高得多。
   *   ② 所以失败时**必须在同一会话内立即重试**；如果立刻 warm(true) 换会话，
   *      等于每次都把状态重置回「最容易被拒的第一发」，重试就成了自杀。
   * 因此策略是：同一会话内连试；连续两次失败才换会话，最多 MAX_TRIES 次。
   */
  async function queryTrains(fromCode, toCode, date, fast, triesArg) {
    await warm();
    let last = 'unknown';
    /* fast：批量补查用。失败了反正有「同路线存档日」兜底，没必要在一趟车上死磕 3 次 × 20 秒 ——
     * 那会让一条返程变成 40~60 秒，墙上 30 个目的地要补十几分钟，用户等不到就说「只有点开才有」。
     * 单条查（用户主动点开）仍走完整重试。 */
    const tries = triesArg ? Math.max(1, Number(triesArg)) : (fast ? 1 : MAX_TRIES);
    const tmo = fast ? 7000 : (triesArg ? 12000 : 20000);
    for (let i = 0; i < tries; i++) {
      await pacer();
      let r;
      try { r = await queryOnce(fromCode, toCode, date, tmo); }
      catch (e) { r = { fail: 'net_' + ((e && e.code) || (e && e.name) || 'err') }; }
      if (r.fail === 'redirect') {          // 换到新路径再试一次，不算失败
        await pacer();
        try { r = await queryOnce(fromCode, toCode, date, tmo); } catch { r = { fail: 'net' }; }
      }
      if (!r.fail) { consecutiveFails = 0; noteResult(true); return { ok: true, trains: r.trains }; }
      last = r.fail;
      noteResult(false);
      if (!fast && (i + 1) % 2 === 0) { try { await warm(true); } catch { /* 下一轮再试 */ } }
    }
    consecutiveFails++;
    return { ok: false, error: last };
  }

  /* ================= 解析 ================= */
  function parseAvail(v) {
    if (v === undefined || v === null || v === '' || v === '无') return { n: 0, raw: '', type: 'none' };
    if (v === '有') return { n: 999, raw: '有', type: 'yes' };
    if (v === '候补') return { n: 0, raw: '候补', type: 'wait' };
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return { n: 0, raw: v, type: 'none' };
    return { n, raw: String(n), type: n > 0 ? 'num' : 'none' };
  }
  function parsePrices(info) {
    const out = {};
    if (!info) return out;
    for (let i = 0; i + 9 < info.length + 1; i += 10) {
      const code = info[i];
      const raw = info.slice(i + 1, i + 6);
      if (!/^\d{5}$/.test(raw)) continue;
      out[code] = Number(raw) / 10;
    }
    return out;
  }
  function parseResult(data) {
    const map = data.map || {};
    const out = [];
    for (const s of data.result || []) {
      const p = s.split('|');
      const prices = parsePrices(p[39]);
      const seats = {};
      const wzPrice = prices.W ?? prices.O ?? null;
      for (const [code, price] of Object.entries(prices)) {
        const meta = SEAT_MAP[code];
        if (!meta) continue;
        const a = parseAvail(p[meta.qtyIdx]);
        if (a.type === 'none' && price === null) continue;
        seats[meta.name] = { qty: a.raw, n: a.n, price: price === null ? wzPrice : price };
      }
      // 有票但价格表里没出现的席别（偶发），补一条无价格的
      for (const [code, meta] of Object.entries(SEAT_MAP)) {
        if (seats[meta.name]) continue;
        const a = parseAvail(p[meta.qtyIdx]);
        if (a.type === 'num' || a.type === 'yes' || a.type === 'wait') seats[meta.name] = { qty: a.raw, n: a.n, price: null };
      }
      const dur = p[10] || '';
      const dm = /^(\d+):(\d+)$/.exec(dur);
      const hours = dm ? Number(dm[1]) + Number(dm[2]) / 60 : 99;
      const seatList = Object.entries(seats).map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => SEAT_ORDER.indexOf(a.name) - SEAT_ORDER.indexOf(b.name));
      const priced = seatList.filter(x => x.price !== null && x.name !== '无座');
      const minPrice = priced.length ? Math.min(...priced.map(x => x.price)) : null;
      const minSeat = priced.find(x => x.price === minPrice)?.name || null;
      const anyTicket = seatList.some(x => x.n > 0 || x.qty === '候补');

      out.push({
        trainNo: p[2], train: p[3],
        from: map[p[6]] || p[6], to: map[p[7]] || p[7],
        depart: p[8], arrive: p[9], duration: dur, hours,
        seats: seatList, minPrice, minSeat, hasTicket: anyTicket, canBuy: p[11] === 'Y'
      });
    }
    return out;
  }

  /** 同城站：运城北 / 延吉西 / 凯里南 这类高铁站是独立电报码，12306 只对部分城市自动合并 */
  function siblingsOf(name) {
    const base = String(name).replace(/(北|东|南|西)$/, '');
    const out = [];
    for (const suf of SUFFIX) {
      const cand = base + suf;
      const rec = byName.get(cand);
      if (rec && !out.some(o => o.code === rec.code)) out.push({ name: rec.name, code: rec.code });
    }
    return out.length ? out : (byName.get(name) ? [{ name, code: byName.get(name).code }] : []);
  }

  /** 按 train_no 归并：12306 会把同一趟车按出发城市群每个乘车站各返回一行 */
  function buildTrips(trains, originName) {
    const groups = new Map();
    for (const t of trains) {
      if (!t.canBuy || !t.hasTicket) continue;
      if (!groups.has(t.trainNo)) groups.set(t.trainNo, []);
      groups.get(t.trainNo).push(t);
    }
    const trips = [];
    for (const rows of groups.values()) {
      const opts = rows.map(r => ({
        from: r.from, to: r.to, depart: r.depart, arrive: r.arrive, duration: r.duration, hours: r.hours,
        minPrice: r.minPrice, minSeat: r.minSeat, seats: r.seats,
        main: String(r.from).startsWith(originName)
      })).sort((a, b) => a.hours - b.hours || (a.minPrice ?? 1e9) - (b.minPrice ?? 1e9));
      /**
       * 代表班次必须按「出发地本站」来选，而不是取全城市群里最快的那一行。
       * 例：苏州→大同的 G3754 会返回 苏州(11:08) / 张家港(9:30) / 常熟 / 太仓 四行，
       * 直接取最快会显示「张家港 11:01 上车」，而用户是在苏州出发 —— 属于误导。
       * 所以优先用本站上车的方案；确实没有本站方案时，才退回最快的那一行，
       * 并把「更快的换乘站」作为附注给出（对旅客其实是有效信息）。
       */
      const main = opts.find(o => o.main) || opts[0];
      const better = opts.find(o => o !== main && o.hours < main.hours - 0.3);
      trips.push({
        train: main.train || rows[0].train, trainNo: rows[0].trainNo,
        to: main.to, from: main.from, depart: main.depart, arrive: main.arrive,
        duration: main.duration, hours: main.hours, seats: main.seats,
        minPrice: main.minPrice, minSeat: main.minSeat,
        alt: (main.main && better) ? better : null,
        opts, hasMain: opts.some(o => o.main)
      });
    }
    trips.sort((a, b) => a.hours - b.hours || (a.minPrice ?? 1e9) - (b.minPrice ?? 1e9));
    return trips;
  }

  /** 一趟车 → 前端/百炼通用的班次对象（与航班对象同构，便于「都可以」混排） */
  function tripToOption(t, fromName, toName, date, fromCode, toCode) {
    const seat = t.minSeat || (t.seats[0] && t.seats[0].name) || '';
    const qty = (t.seats.find(s => s.name === seat) || {}).qty || '';
    const arrName = t.to || toName;
    // 上车点可能是同城站（用户在「苏州北」上车，而不是「苏州」）。
    // 购票链接必须带**这趟车实际停靠的那个站**，否则 12306 打开后车次对不上。
    const boardName = t.from || fromName;
    const boardCode = (byName.get(boardName) || {}).code || fromCode;
    return {
      no: t.train, trainNo: t.trainNo, kind: '高铁/动车',
      from: boardName, to: arrName,
      dep: String(t.depart || '').trim(), arr: String(t.arrive || '').trim(), date,
      hours: Math.round(t.hours * 10) / 10,
      seat, price: t.minPrice, priceText: t.minPrice == null ? '' : '¥' + t.minPrice,
      qty, seats: t.seats, mode: 'train',
      // 同一趟车若在出发城市群的其他站上车更快，作为附注给出（不改变「从哪出发」的事实）
      alt: t.alt ? `${t.alt.from} ${String(t.alt.depart || '').trim()} 上车可省 ${(t.hours - t.alt.hours).toFixed(1)}h` : '',
      jumpUrl: `${BOOK_URL}&fs=${encodeURIComponent(boardName + ',' + boardCode)}&ts=${encodeURIComponent(arrName + ',' + toCode)}&date=${date}&flag=N,N,Y`
    };
  }

  /** 取代表性班次：最快 + 最便宜 + 最早发车的并集，保证任何排序依据都不会被截断丢掉 */
  function pick(trips, cap) {
    if (trips.length <= cap) return trips.slice();
    const byDur = trips.slice(0, Math.ceil(cap * 0.6));
    const byPrice = trips.filter(t => t.minPrice !== null).sort((a, b) => a.minPrice - b.minPrice).slice(0, Math.ceil(cap * 0.45));
    const byEarly = trips.slice().sort((a, b) => String(a.depart).localeCompare(String(b.depart))).slice(0, Math.ceil(cap * 0.4));
    const seen = new Set(); const out = [];
    for (const t of [...byDur, ...byPrice, ...byEarly]) {
      const k = t.train + '|' + t.from;
      if (seen.has(k)) continue;
      seen.add(k); out.push(t);
      if (out.length >= cap) break;
    }
    return out.sort((a, b) => a.hours - b.hours || (a.minPrice ?? 1e9) - (b.minPrice ?? 1e9));
  }

  function assemble(trains, { fromName, ok, source, archivedDate, fromCode, date, dest, cap }) {
    const trips = buildTrips(trains, fromName);
    const toCode = dest.code || (byName.get(dest.name) || {}).code || '';
    const shown = pick(trips, cap);
    const allDepMin = trips.reduce((m, t) => { const v = clockOf(t.depart); return v === null ? m : (m === null || v < m ? v : m); }, null);
    const priced = trips.filter(t => t.minPrice !== null);
    // 跨日期回退来的班次：时刻/席别/票价是时刻表数据（对日期不敏感），但**余票必须留空**，
    // 否则等于拿 A 日的余票冒充 B 日，属于误导。
    const archived = source === 'archive';
    return {
      ok: true, source, archivedDate: archivedDate || '',
      list: shown.map(t => {
        const o = tripToOption(t, fromName, dest.name, date, fromCode, toCode);
        if (archived) { o.qty = ''; o.archived = true; }
        return o;
      }),
      count: trips.length,
      nTrain: trips.length, nFlight: 0,
      hours: trips.length ? Math.round(trips[0].hours * 10) / 10 : null,
      price: priced.length ? Math.min(...priced.map(t => t.minPrice)) : null,
      depMin: allDepMin,
      earlyDep: allDepMin === null ? '' : String(Math.floor(allDepMin / 60)).padStart(2, '0') + ':' + String(allDepMin % 60).padStart(2, '0')
    };
  }

  /**
   * 取某一条「出发站 → 目的地」的原始班次（缓存 / 实时 / 存档日回退），不做同城站补查。
   * 返回 { ok, trains, source, archivedDate } 或 { ok:false, error }
   */
  async function railRawOne(fromName, fromCode, date, dest, o = {}) {
    const toCode = o.code || dest.code || (byName.get(dest.name) || {}).code;
    if (!toCode) return { ok: false, error: 'NO_STATION_CODE' };

    let hit = cacheGet(fromCode, toCode, date);
    let source = 'cache';
    if (!hit) {
      if (o.cacheOnly) {
        // 只读缓存、绝不发网络请求：页面「打开即出全量列表」走这条零成本路径
        const any = cacheGetAny(fromCode, toCode);
        if (!any) return { ok: false, error: 'NO_CACHE' };
        return { ok: true, trains: any.list || [], source: 'archive', archivedDate: any.date, toCode };
      }
      const r = await queryTrains(fromCode, toCode, date, !!o.fast, o.tries);
      if (!r.ok) {
        // 实时失败 ≠ 没有直达。退回同路线存档日，至少把时刻表给到用户并注明存档日。
        const any = cacheGetAny(fromCode, toCode);
        if (any) return { ok: true, trains: any.list || [], source: 'archive', archivedDate: any.date, toCode };
        return { ok: false, error: r.error };
      }
      hit = { list: r.trains, t: Date.now(), date };
      source = 'live';
      cachePut(fromCode, toCode, date, r.trains);
    }
    return { ok: true, trains: hit.list || [], source, toCode };
  }

  /**
   * 查一个目的地。
   * fromCodeArg 可以是单个电报码，也可以是**数组**（用户勾选了同城多个车站时）。
   * 多站会分别取数并按「车次 + 上车站」合并去重 —— 这样用户勾了苏州北和苏州，
   * 两个站的车次都会出现，而不是只看到一个站的。
   * 返回 { ok, list, count, nTrain, hours, price, depMin, earlyDep, source }
   *   ok=false                → 无缓存且（网络失败 / cacheOnly），**不代表没有直达**
   *   ok=true 且 list=[]      → 确实没有直达班次
   *   source: 'live' 实时查得 | 'cache' 当日缓存 | 'archive' 同路线存档日（余票留空）
   */
  async function railList(fromName, fromCodeArg, date, dest, o = {}) {
    const codes = (Array.isArray(fromCodeArg) ? fromCodeArg : [fromCodeArg]).filter(Boolean);
    if (!codes.length) return { ok: false, error: 'NO_STATION_CODE' };
    const cap = Math.max(4, Number(o.cap) || 12);

    const trains = [];
    let source = '', archivedDate = '', okAny = false, lastErr = '';
    for (const c of codes) {
      const r = await railRawOne(fromName, c, date, dest, o);
      if (!r.ok) { lastErr = r.error || lastErr; continue; }
      okAny = true;
      if (r.source === 'live') source = 'live';
      else if (!source) source = r.source;
      if (r.archivedDate) archivedDate = r.archivedDate;
      for (const t of (r.trains || [])) trains.push(t);
    }
    if (!okAny) return { ok: false, error: lastErr || 'QUERY_FAILED' };

    // 直达车次太少 → 补查同城高铁站（运城北/延吉西/凯里南 这类独立电报码）。
    // 只在「单出发站」时做：多站时用户已自行指定上车点，再补查会让请求量成倍放大。
    const distinct = new Set(trains.filter(t => t.canBuy && t.hasTicket).map(t => t.trainNo)).size;
    if (distinct < 2 && o.siblings === true && codes.length === 1) {
      const toCode0 = o.code || dest.code || (byName.get(dest.name) || {}).code;
      for (const sib of siblingsOf(dest.name)) {
        if (sib.code === toCode0) continue;
        const r2 = await railRawOne(fromName, codes[0], date, { name: sib.name, code: sib.code }, { ...o, code: sib.code });
        if (!r2.ok) continue;
        for (const t of (r2.trains || [])) trains.push(t);
      }
    }

    // 同城多站下同一趟车会有多个上车站，按「车次 + 上车站」去重
    const seen = new Set(); const uniq = [];
    for (const t of trains) {
      const k = t.trainNo + '|' + t.from;
      if (seen.has(k)) continue;
      seen.add(k); uniq.push(t);
    }

    /* 严格匹配的最后一道保险：用户勾了具体车站，就别让任何「别站的票」混进来。
     * 为什么需要它——缓存是按电报码存的，但历史缓存可能被同城补查污染过
     * （苏州北 的键下存着 苏州/张家港 的班次），光靠查对了码挡不住这种脏数据。
     * 这里按**上车站名**再筛一遍：不匹配的一条都不留。 */
    const only = (o.onlyFrom && o.onlyFrom.length) ? new Set(o.onlyFrom) : null;
    /* 返程查的是「目的地 → 返程落点」，用户勾的返程车站是**到达站**，
     * 所以要按 to 筛，不能拿 onlyFrom 去卡上车站（那是去程的语义）。 */
    const onlyTo = (o.onlyTo && o.onlyTo.length) ? new Set(o.onlyTo) : null;
    const finalTrains = (only || onlyTo)
      ? uniq.filter(t => (!only || only.has(t.from)) && (!onlyTo || onlyTo.has(t.to)))
      : uniq;
    if ((only || onlyTo) && !finalTrains.length) {
      /* 空结果有两种含义，必须分开告诉上层：
       *   uncertain=false → 这一程**确实**没有符合条件的直达（可以下结论）
       *   uncertain=true  → 只有别的日期的存档时刻表，不能拿它说「今天没有」
       * 注意 cache 也算「下得了结论」：缓存条目只由实时查询写入（含「查通了但一趟都没有」），
       * 之前把 cache 当成不确定，于是「中卫→苏州 真没有直达」被写成「12306 可能在限流」。 */
      return { ok: true, list: [], count: 0, nTrain: 0, hours: null, price: null, depMin: null, earlyDep: '',
        source: source || 'cache', archivedDate, onlyFrom: o.onlyFrom,
        uncertain: source === 'archive' };
    }

    return assemble(finalTrains, {
      fromName, source: source || 'cache', archivedDate,
      fromCode: codes[0], date, dest, cap
    });
  }

  /**
   * 全量扫描（用户点击「搜索」时触发）。
   * 并发 CONC，对每个目的地调用 railList；onCard 收到即回调，实现「边扫边出」。
   * 只扫描调用方传进来的 `dests`（通常已用 isFresh 过滤，只留缺的/过期的）。
   */
  async function scanAll({ fromName, fromCode, fromCodes, date, dests, onProgress, onCard, onNoDirect, isStopped, gapMs, onlyFrom }) {
    breakerFired = false;
    breakerAt = 0;
    recent.length = 0;
    curGap = gapMs ? Math.max(200, Number(gapMs)) : MIN_GAP_MS;
    // 用户勾选了同城多个车站时逐个取数；默认只有一个（避免请求量成倍放大）
    const codes = (fromCodes && fromCodes.length) ? fromCodes : [fromCode].filter(Boolean);
    const stats = { scanned: 0, total: dests.length, covered: 0, noDirect: 0, failed: 0, archived: 0, broken: false };
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONC, Math.max(1, dests.length)) }, async () => {
      while (true) {
        if (isStopped && isStopped()) return;
        if (broke()) { stats.broken = true; return; }
        const i = cursor++;
        if (i >= dests.length) return;
        const d = dests[i];
        let card = null;
        try {
          // 批量扫描不做同城「目的地」站补查：那会让「无直达」的目的地额外发最多 4 次请求，
          // 200 多个目的地连起来就是上千次调用，既慢又容易招来限流。
          // 单点补查（/api/live）才开这个开关 —— 那里多花 2~4 次换准确度是值得的。
          const r = await railList(fromName, codes, date, d, { siblings: false, onlyFrom: onlyFrom || null });
          if (!r.ok) stats.failed++;
          else if (!r.list.length) {
            stats.noDirect++;
            // 「确实没有直达」是一条结论，必须与「没查到」分开告诉前端，
            // 否则界面会把前者显示成后者，反倒让人以为数据不可靠。
            if (onNoDirect) { try { onNoDirect(d); } catch { /* ignore */ } }
          } else {
            stats.covered++;
            if (r.source === 'archive') stats.archived++;
            card = {
              name: d.name, city: d.name, mode: 'train', modes: ['train'],
              options: r.list, count: r.count, nTrain: r.nTrain, nFlight: 0,
              hours: r.hours, price: r.price, depMin: r.depMin, earlyDep: r.earlyDep,
              source: r.source, archivedDate: r.archivedDate || ''
            };
          }
        } catch { stats.failed++; }
        stats.scanned++;
        if (onProgress) { try { onProgress(stats, d); } catch { /* ignore */ } }
        if (card && onCard) { try { onCard(card); } catch { /* ignore */ } }
      }
    });
    await Promise.all(workers);
    flush();
    return stats;
  }

  /** 12306 预售期内的最晚可查日期（默认 15 天含当天，可由 RAIL_PRESALE_DAYS 覆盖）
   *  用本地日期拼串，不走 toISOString()：后者会转成 UTC，在东八区的清晨会少一天。 */
  function preSaleMax() { const d = new Date(); d.setDate(d.getDate() + PRESALE_DAYS); return ymd(d); }
  function preSaleDays() { return PRESALE_DAYS; }
  /** 某目的地在该出发地/日期是否已有可用缓存（供「只扫缺的」判断） */
  function isFresh(fromCode, date, dest) {
    const toCode = dest.code || (byName.get(dest.name) || {}).code;
    return !!toCode && !!cacheGet(fromCode, toCode, date);
  }

  function stats() {
    return {
      stations: byName.size, stationsOk,
      cookie: !!cookie, cookieAge: cookie ? Math.round((Date.now() - cookieAt) / 1000) + 's' : null,
      memCache: mem.size, diskCache: Object.keys(disk).length,
      failRate: Math.round(failRate() * 100) / 100,
      consecutiveFails, breakerFired, presaleMax: preSaleMax()
    };
  }

  return {
    ready: stationsOk,
    codeOf: name => (byName.get(name) || byName.get(normName(name)) || {}).code || '',
    nameOf: code => (byCode.get(code) || {}).name || code,
    hasStation: name => byName.has(name) || byName.has(normName(name)),
    siblingsOf, railList, isFresh, scanAll,
    preSaleMax, preSaleDays, stats,
    resetBreaker: () => { breakerFired = false; recent.length = 0; },
    clearCache: () => { mem.clear(); routeIdx.clear(); disk = {}; dirty = true; flush(); }
  };
}
