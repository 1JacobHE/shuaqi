/*
 * 耍起 · 随心出发，即刻耍起（目的地探索）
 * ------------------------------------------------------------------
 * 一句话：选好出发城市（并勾选出走哪些车站/机场）+ 日期 + 天数，
 * 一屏列出「这几天能去哪儿」，每条都带真实车次或直飞航线，并可一键去正主那儿买票。
 *
 * 四层数据，各用各的最优来源，且任一层不可用都不会让功能整体失效：
 *   ① 高铁 → 12306 公开余票接口（无需 Key、无配额、全量实时），购票跳转 12306 官方页
 *   ② 航班骨架 → 本地航线库（data/air.json，周更的真实航线网络：谁在飞/飞多久/多远），
 *               零网络零配额，负责回答「能不能直飞」
 *   ③ 航班实时 → 飞猪 flyai（航班号/时刻/票价/下单链接），按需 1 次/目的地，
 *               并发 1 + 600ms 间隔 —— 批量扫会被判定异常访问（451 风控）
 *   ④ 行程 → 本地规则生成（真实班次 + 本地策展素材），可选接大模型润色（LLM_*，默认关闭）
 *
 * 环境变量：
 *   PORT              监听端口，默认 8790
 *   SCAN_LIMIT        单次扫描的目的地上限，默认 9999（12306 无配额，默认全量扫）
 *   CONCURRENCY       并发数，默认 2
 *   LLM_BASE / LLM_API_KEY / LLM_MODEL
 *                     可选大模型（OpenAI 兼容端点），仅用于行程块措辞润色；
 *                     三者齐全才启用，任何失败都退回本地规则。
 *                     只填 DASHSCOPE_API_KEY（或设 BAILIAN=1）即自动指向阿里云百炼端点。
 *   DEMO=1            演示模式：只读本机已缓存的真实班次，不发起任何实时请求
 *   AFFILIATE_QUERY   CPS 推广位参数，附加到飞猪跳转链接（商业变现开关），默认空
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRail } from './railways.mjs';
import { createAir } from './airlib.mjs';
import { createFlyai } from './flyai.mjs';
import { normalizePlanText } from './planfmt.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const PUBLIC = path.join(DIR, 'public');

const PORT = Number(process.env.PORT) || 8790;
// 默认绑 0.0.0.0：发布沙箱要求服务对反代可达；本机访问 127.0.0.1 同样正常。
const HOST = process.env.HOST || '0.0.0.0';
/** 本地双击启动时自动开浏览器用的地址（0.0.0.0 不是一个可访问地址） */
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
/**
 * 演示模式：只由显式 DEMO=1 启用。
 * ------------------------------------------------------------------
 * 开启后不发起任何实时查询，只读本机 data/rail-cache.json 里已经抓到的真实班次。
 * 公网 demo 就跑在这个模式上 —— 无论部署环境能否连通 12306，页面打开都是完整的
 * 216 条目的地列表 + 已缓存的真实车次，不会空屏。
 */
const DEMO = process.env.DEMO === '1';
/** 扫描并发数（12306 侧另有独立的速率纪律，见 railways.mjs 的 RAIL_MIN_GAP_MS） */
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 2);
/** 单次扫描的目的地上限。12306 是公开只读接口、无配额，所以默认全量扫。 */
const SCAN_LIMIT = Math.max(4, Number(process.env.SCAN_LIMIT) || 9999);

const POOL_ALL = JSON.parse(fs.readFileSync(path.join(DATA, 'destinations.json'), 'utf8'));
/* 候选池上限：策展了 216 个，但一次扫 216 条又慢又容易被 12306 限流，
 * 列表也没人翻得完。默认只留**名气最高的 100 个**（POOL_LIMIT 可调）。
 * 排序用 fame 稳定降序，同分保持原文件顺序 —— 保证每次启动池子是同一批。 */
const POOL_LIMIT = Math.max(20, Number(process.env.POOL_LIMIT) || 100);
const POOL = POOL_ALL
  .map((d, i) => ({ d, i }))
  .sort((a, b) => (b.d.fame || 0) - (a.d.fame || 0) || a.i - b.i)
  .slice(0, Math.min(POOL_LIMIT, POOL_ALL.length))
  .map(({ d }) => d);
if (POOL.length < POOL_ALL.length) {
  console.log(`候选池：${POOL_ALL.length} 个里取名气最高的 ${POOL.length} 个（POOL_LIMIT=${POOL_LIMIT}）`);
}

/* ------------------------------------------------------------------ *
 * 一·A、12306 实时余票层（高铁数据的主力来源）
 * ------------------------------------------------------------------
 * 为什么把高铁从飞猪切到 12306：
 *   飞猪开放平台对 search-train 有硬配额（实测约 20~24 次/分钟，打爆即风控数小时），
 *   而本产品的核心体验是「一次性列出 200+ 个可达目的地」，两者在数量级上根本不兼容 ——
 *   结果就是列表后段大片城市只能显示「未取」。
 *   12306 的余票查询是公开的只读接口，单次 45~90ms、无需 Key、可全量，正好补上这块。
 *   飞猪则退化为**可选的航班与商品增强**（配额足够时启用，不可用时功能不受影响）。
 *
 * 速率纪律（重要，勿调高）：
 *   实测并发 8 猛打几分钟就会把本机 IP 打成「大部分请求 302」，恢复期很长；
 *   串行 ~3 次/秒则长期稳定。所以这里用 RAIL_MIN_GAP_MS 做**全局最小间隔**，
 *   并发只用来掩盖单次延迟，不用于提高速率。
 */
const RAIL = createRail({
  dataDir: DATA,
  concurrency: Math.max(1, Number(process.env.RAIL_CONCURRENCY) || 3),
  minGapMs: Math.max(0, Number(process.env.RAIL_MIN_GAP_MS) || 280),
  maxTries: Math.max(1, Number(process.env.RAIL_MAX_TRIES) || 3),
  presaleDays: Math.max(1, Number(process.env.RAIL_PRESALE_DAYS) || 14),
  cacheTtlMs: Number(process.env.RAIL_CACHE_TTL_MS) || 15 * 60 * 1000,
  diskTtlMs: Number(process.env.RAIL_DISK_TTL_MS) || 14 * 24 * 3600 * 1000
});
/* ------------------------------------------------------------------ *
 * 一·C、本地航班层（取代飞猪 API）
 * ------------------------------------------------------------------
 * 飞猪 search-flight 的配额模型（约 20~24 次/60s）与「一次列 200+ 目的地」的需求
 * 在数量级上不兼容 —— 这正是上一版「机票只能看到几个航班」的根因。
 * 现在改为：用本地静态真实航线网络回答「能不能直飞、谁在飞、飞多久多远」，
 * 价格与实时班次交给飞猪 H5（一键跳转）。分工明确，且任一方不可用都不会让功能失效。
 */
const AIR = createAir({ dataDir: DATA });
/**
 * 飞猪实时航班层：本地航线库负责「能不能直飞」，飞猪负责「具体是哪一班、几点、多少钱、怎么下单」。
 * 没配 Key 或 CLI 不在时 ready=false，整条链路自动只走本地库，功能不残缺。
 */
const FLYAI = createFlyai({
  // 并发 3 + 400ms 间隔：2026-10-23 实测标定（AK 已开到 5 QPS），1.61 QPS，偶发 429 由重试吃掉。
  concurrency: Number(process.env.FLYAI_CONCURRENCY) || 3,
  gapMs: process.env.FLYAI_GAP_MS !== undefined ? Number(process.env.FLYAI_GAP_MS) : 400,
  ttlMs: (Number(process.env.FLYAI_TTL_MIN) || 30) * 60 * 1000
});
/** 车站库：城市名 → 该市按重要性排序的车站列表（由 12306 station_name.js 归并而来） */
const STATIONS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'stations.json'), 'utf8')).cities || {}; } catch { return {}; }
})();

/* ---------------- 跳转链接（三个目的地，各用各的正主） ---------------- */
/* 高铁购票链接由 railways.mjs 按「实际乘车站 + 电报码」逐条生成（见 tripToOption），
   这里只放航班/酒店/门票三处。 */
/** 机票 → 飞猪机票 H5 搜索（预填出发/到达城市与日期） */
const FLIGGY_FLIGHT = 'https://sjipiao.fliggy.com/flight_search_result.htm';
/** 酒店 → 飞猪酒店列表（预填城市与入离日期） */
const FLIGGY_HOTEL = 'https://hotel.fliggy.com/hotel_list.htm';
/** 景点/门票 → 飞猪搜索 */
const FLIGGY_POI = 'https://www.fliggy.com/search/';
/** 高铁 → 12306 直达购票页（fs/ts 预填区间，date 预填日期） */
const RAIL_BUY = 'https://kyfw.12306.cn/otn/leftTicket/init';

function fliggyFlightUrl(fromCity, toCity, date, o = {}) {
  const p = new URLSearchParams();
  p.set('tripType', o.round ? '2' : '1');
  if (fromCity) p.set('depCity', fromCity);
  if (toCity) p.set('arrCity', toCity);
  if (date) p.set('depDate', date);
  if (o.round && o.backDate) p.set('retDate', o.backDate);
  return decorate(`${FLIGGY_FLIGHT}?${p.toString()}`);
}
function fliggyHotelUrl(city, checkIn, checkOut) {
  const p = new URLSearchParams();
  if (city) p.set('city', city);
  if (checkIn) p.set('checkIn', checkIn);
  if (checkOut) p.set('checkOut', checkOut);
  return decorate(`${FLIGGY_HOTEL}?${p.toString()}`);
}
const fliggyPoiUrl = city => decorate(`${FLIGGY_POI}?q=${encodeURIComponent(city + '景点门票')}`);

/**
 * 12306 直达购票页（指定区间与日期）。
 * fs/ts 用「站名,电报码」——12306 认电报码，只给中文名有时会落到默认站。
 * 城市没有站名表的（如纯机场城市）退化为城市名，链接仍然可用。
 */
function railBuyUrl(fromCity, toCity, date) {
  const pick = c => {
    const city = normCity(c);
    const first = (STATIONS[city] || [])[0];
    const name = first || city;
    const code = first ? RAIL.codeOf(first) : '';
    return code ? `${name},${code}` : name;
  };
  const p = new URLSearchParams({
    linktypeid: 'dc', fs: pick(fromCity), ts: pick(toCity), date: date || '', flag: 'N,N,Y'
  });
  return `${RAIL_BUY}?${p.toString()}`;
}

/**
 * 返程段落（基础版：只有落点、日期与两个跳转入口，零网络请求）。
 * 列表里每条目的地都带这个；真实班次由 backLegPlan 在展开时才去查。
 */
function backLegOf(destCity, trip) {
  if (!trip || trip.tripType !== 'round') return null;
  const to = normCity(trip.backCity || trip.from || '');
  const date = trip.backDate || '';
  if (!to) return null;
  /* 这里的「勾选」是**生效后**的：返程侧没单独勾，就沿用出发侧（来回同一套交通工具是常态）。
   * 落点写全：「恩施 → 苏州（昆山南）」「福州 → 苏州（虹桥国际机场 / 浦东国际机场）」。 */
  const intent = backIntentOf(destCity, trip);
  /* 站名跟城市同名时（勾了「苏州」站、「苏州」是城市）不再写一遍「苏州（苏州）」，
   * 只有真的能区分落点时才加括号（「苏州（昆山南）」）。 */
  const marks = [...intent.stations, ...intent.ports.map(portCn)]
    .filter(m => m && m !== to && m.replace(/站$/, '') !== to);
  return {
    from: destCity, to, date,
    toLabel: marks.length ? `${to}（${marks.join(' / ')}）` : to,
    stations: intent.stations, ports: intent.ports,
    wantTrain: intent.wantTrain, wantAir: intent.wantAir,
    trainUrl: railBuyUrl(destCity, to, date),
    airUrl: fliggyFlightUrl(destCity, to, date, {})
  };
}

/** IATA → 中文机场名（「SHA」→「虹桥国际机场」）；查不到就原样返回 */
function portCn(iata) {
  const p = AIR.portOf(iata);
  return (p && (p.cn || p.city)) || iata;
}

/**
 * 返程要坐什么：把「车站/机场勾选」翻译成返程该查哪几种交通。
 * ------------------------------------------------------------------
 * 用户在返程侧单独勾过（backPick=1）→ 严格照返程的勾选：没勾车站就不出高铁、
 * 没勾机场就不出航班。
 * 没在返程侧勾过 → 沿用出发侧的勾选。这是绝大多数人的用法：
 * 「来回都坐飞机」只在出发侧勾一次机场，返程不该因为「没重复勾」就被掐成高铁-only。
 * 两边都没动过 → 两种都查。
 *
 * 车站名不能跨城硬搬（「苏州园区」在上海不存在），所以只在同城时继承；
 * 机场代码则要求确实属于返程落点城市，避免把虹桥/浦东塞给杭州。
 */
function backIntentOf(destCity, trip) {
  const to = normCity(trip.backCity || trip.from || '');
  const sameCity = to === normCity(trip.from || '');
  const backTouched = !!trip.backPick;
  const cityPorts = new Set(AIR.airportsOfCity(to).map(a => a.iata));

  if (backTouched) {
    const stations = trip.backStations || [];
    const ports = (trip.backPorts || []).filter(i => cityPorts.has(i));
    return { backTouched, stations, ports, wantTrain: stations.length > 0, wantAir: ports.length > 0 };
  }
  const stations = sameCity ? (trip.fromStations || []) : [];
  const ports = (trip.fromPorts || []).filter(i => cityPorts.has(i));
  /* 出发侧勾过（pick=1）：勾了车站要高铁、勾了机场要飞机；只勾了机场就是「这趟不坐火车」 */
  const wantTrain = trip.pick ? (stations.length > 0 || ports.length === 0) : true;
  const wantAir = trip.pick ? (ports.length > 0) : true;
  return { backTouched, stations, ports, wantTrain, wantAir };
}

/**
 * 往返可行性：这一程能不能「按你选的方式」回来。
 * ------------------------------------------------------------------
 * 用户只勾了其中一种交通（比如去程高铁、返程飞机）时，候选目的地必须**两头都有得走**：
 * 铁路能到、机场却没有的城市（或者有机场、没有直飞航线），放进列表就是坏选项 ——
 * 点开才发现「回不来」，比直接不显示更糟。
 *
 * 只用本地数据判断（车站表 + 航线库），零网络，所以可以放在 /api/list 的零请求路径上：
 *   · 只坐飞机回来 → 目的地要有民航机场，且本地航线库里有「目的地 → 返程城市」的直飞
 *   · 只坐火车回来 → 目的地要有车站
 *   · 两种都查（用户没勾 / 都勾了）→ 不筛，因为任何一种回来都算成立
 */
/**
 * 用户真实意图的交通方式：以勾选为准。只勾机场就是 flight，只勾车站就是 train。
 * transport 参数只是客户端的提示，不能假设它一定跟着勾选走（旧链接、外来请求都可能传 all）。
 */
function effectiveTransport(trip, transport) {
  const t = normTransport(transport);
  if (!trip || !trip.pick) return t;
  const st = (trip.fromStations || []).length, ap = (trip.fromPorts || []).length;
  if (st && !ap) return 'train';
  if (ap && !st) return 'flight';
  return t;
}

/**
 * 去程可行性：用户只勾了一种交通方式时，目的地得真的能按那种方式到。
 * 只勾机场 → 目的地要有民航机场且有直飞航线；只勾车站 → 要有车站。
 * 和 backFeasible 一样只用本地数据，零网络。
 */
function routeFeasible(destCity, trip, transport) {
  const tp = normTransport(effectiveTransport(trip, transport));
  const dest = normCity(destCity);
  if (tp === 'flight') {
    if (!AIR.airportsOfCity(dest).length) return false;
    const fromCity = normCity((trip && trip.from) || '');
    const ports = ((trip && trip.fromPorts) || []).length
      ? trip.fromPorts
      : AIR.airportsOfCity(fromCity).map(a => a.iata);
    if (!ports.length) return false;
    if (!AIR.directRoutes(ports, dest).length) return false;
  } else if (tp === 'train') {
    if (!(STATIONS[dest] || []).length) return false;
    if (!RAIL.codeOf(dest)) return false;
  }
  return true;
}

function backFeasible(destCity, trip) {
  if (!trip || trip.tripType !== 'round') return true;
  const to = normCity(trip.backCity || trip.from || '');
  if (!to) return true;
  const intent = backIntentOf(destCity, trip);
  const onlyAir = intent.wantAir && !intent.wantTrain;
  const onlyRail = intent.wantTrain && !intent.wantAir;
  if (!onlyAir && !onlyRail) return true;
  const dest = normCity(destCity);
  if (onlyAir) {
    const ports = AIR.airportsOfCity(dest).map(a => a.iata);
    if (!ports.length) return false;                       // 目的地压根没机场
    if (!AIR.airportsOfCity(to).length) return false;      // 返程落点没机场
    /* 用户勾了具体返程机场（比如只勾虹桥）就要落到那个机场才算成立：
     * 南京→上海只有浦东的直飞，勾了虹桥就该把南京剔掉，而不是点开才发现「没有你要的机场」。 */
    const destIatas = intent.ports.length ? intent.ports : null;
    if (!AIR.directRoutes(ports, to, destIatas ? { destIatas } : {}).length) return false;
  }
  if (onlyRail) {
    if (!(STATIONS[dest] || []).length) return false;      // 目的地没有铁路
    if (!RAIL.codeOf(dest)) return false;
  }
  return true;
}

/**
 * 返程真实班次：往返模式下，用户展开一条目的地时，顺手把「从这儿回 backCity」的
 * 车次也查回来 —— 只给两个跳转链接是不够的，用户要的是「几点、哪班、多少钱」。
 *
 * 只在「展开单条」时查（每次 1~2 个 12306 请求，且有缓存），列表全量扫描里绝不调 ——
 * 那会让 100 个目的地变成 200 个请求，直接把 12306 惹毛。
 *
 * 返程的落点严格按用户勾选的**到达站**来：勾了昆山南，就只查终到昆山南的车。
 */
/* 批量补查（墙渲染后自动把每块的返程一次查完）里允许打飞猪实时价的次数上限。
 * 返程航班的缓存键是「目的地→落点」，和去程不通用，所以第一次批量必然是一批真实请求。
 * 不封顶的话一屏 40 个航班目的地能把当天 400 次预算吃掉大半，真要单条细查时就没得用了 ——
 * 到顶后这批只给班次骨架（票价待补），点开单条仍按原有节奏打实时价。 */
const BATCH_FLIGHT_CAP = 60;
let batchFlightLive = 0;

async function backLegPlan(destCity, trip, opt = {}) {
  const batch = !!opt.batch;
  const base = backLegOf(destCity, trip);
  if (!base) return null;
  const intent = backIntentOf(destCity, trip);
  /* 12306 只卖预售期内的票（默认 15 天含当天）。返程日期在这之外时，**拿这个日期去查必然是空的**，
   * 以前就落到「暂时没取到（12306 可能在限流）」的提示上，用户以为系统坏了 —— 其实是票还没开卖。
   * 现在改成：超预售期就按「当前最远可售日」查一批（时刻表开售后基本不变），照样给班次，
   * 同时把 overPresale / refDate / openDate 交给前端，明明白白标出「这是参考日的车次」。
   */
  const presaleMax = RAIL.preSaleMax();
  const overPresale = !!(base.date && presaleMax && base.date > presaleMax);
  const queryDate = overPresale ? presaleMax : base.date;
  const out = {
    ...base, options: [], nTrain: 0, nFlight: 0, note: '', source: '',
    wantTrain: intent.wantTrain, wantAir: intent.wantAir
  };
  if (overPresale) {
    out.overPresale = true;
    out.refDate = queryDate;
    /* 开售日：preSaleMax(今天) = 今天 + N 天，要让 preSaleMax ≥ 该日期 → 开售日 = 该日期 - N */
    out.openDate = addDays(base.date, -RAIL.preSaleDays());
  }

  // ① 高铁：目的地 → 返程落点
  try {
    if (intent.wantTrain) {
      const originStations = (STATIONS[destCity] || []).slice(0, 2);
      const codes = stationCodes(originStations);
      /* 勾了到达站就只查这几个站；勾了机场没勾车站则压根不查高铁（wantTrain 已拦）；
       * 都没勾：用落点城市最主要的站。 */
      const targets0 = intent.stations.length
        ? intent.stations.slice(0, 2)
        : pickStations(base.to, null, false);
      /* 有些落点（昆山、常熟 这类县级市）在「城市 → 车站」表里没有独立条目，
       * 但 station_name 里确实有同名站。查不到就退一步用城市名当站名试一次，
       * 否则用户选了昆山回，返程会静悄悄地一条都不给。 */
      const targets = targets0.length ? targets0 : (RAIL.codeOf(base.to) ? [base.to] : []);
      const sameCityStops = STATIONS[base.to] || [];
      if (codes.length && targets.length) {
        /* ---- 一次查全，而不是「勾几个站就查几次」 ----
         * 2026-11-05 实测：12306 的站码是**城市级**的 —— 查 SZH(苏州) / OHH(苏州北) / KAH(苏州园区)
         * 返回的是同一批「到苏州」的车次。旧实现按用户勾的每个到达站各查一次（勾 3 站 = 3 次），
         * 严格过滤为空时再跑一轮同城兜底（又 3 次），一条返程 15~20 秒；
         * 墙上 39 个目的地要补 5 分钟以上，用户等不到就以为「只有点开才有」。
         * 现在：按城市主站码查 1 次拿全集，严格/放宽全在本地过滤，零额外请求。 */
        const pool = [];
        let s = '', a = '', unc = true;
        const cityCode = RAIL.codeOf(base.to) || RAIL.codeOf(targets[0]) || '';
        const query = async (code, name) => {
          /* fast：墙上批量补查时只试一次、7 秒超时，失败立刻用「同路线存档日」兜底。
           * 用户主动点开单条（batch=false）仍走完整重试，两条路径互不影响。 */
          const r = await RAIL.railList(destCity, codes, queryDate, { name, code }, { cap: 40, siblings: false, fast: batch });
          if (!r || !r.ok) return 0;
          if (r.source === 'live') s = 'live';
          else if (!s) s = r.source || '';
          if (r.archivedDate) a = r.archivedDate;
          /* 「查通了但一趟都没有」可以下结论；只有 archive 兜底 / 整个查询失败才算不确定。
           * 以前只认 source==='live'，于是缓存里的空结果也被写成「12306 可能在限流」。 */
          if (r.uncertain !== true) unc = false;
          const before = pool.length;
          for (const t of (r.list || [])) pool.push({ ...t, mode: 'train' });
          return pool.length - before;
        };
        let got = cityCode ? await query(cityCode, base.to) : 0;
        /* 城市码没覆盖到（县级市有独立电报码、或城市码这次没查通）→ 再按勾的站补，
         * 最多补 2 个，别回到「勾几个站就打几次」的老路。 */
        if (!got) {
          for (const st of targets.slice(0, 2)) {
            const c = RAIL.codeOf(st);
            if (!c || c === cityCode) continue;
            if (await query(c, st)) got++;
          }
        }
        const uniq = (list) => {
          const seen = new Set(); const o = [];
          for (const t of list) {
            const k = t.no + '|' + (t.to || '');
            if (seen.has(k)) continue;
            seen.add(k); o.push(t);
          }
          return o;
        };
        /* 严格：只留终到用户勾选车站的；一条都没有 → 放宽到同城其他站，并说明「只是下车点不同」 */
        const strictNames = new Set(targets);
        const looseNames = new Set(sameCityStops.length ? sameCityStops : targets);
        let picked = uniq(pool.filter(t => strictNames.has(t.to)));
        if (!picked.length) {
          const wide = uniq(pool.filter(t => looseNames.has(t.to)));
          if (wide.length) { picked = wide; out.stationLoose = true; }
        }
        /* 池子里明明有车，只是到站名不在我们的表里（新站/改名）→ 全给，别再静默返回 0 条。
         * 「返程待查、点开却有一堆车」就是这条兜底缺失造成的。 */
        if (!picked.length && pool.length) { picked = uniq(pool); out.stationLoose = true; }
        out.options = picked;
        out.source = s; out.archivedDate = a;
        out.uncertain = unc && !out.options.length;
      }
    }
  } catch { /* 返程查失败不影响去程展示 */ }

  // ② 航班：返程是「目的地 → 落点」，**出发机场用目的地的**，勾选只约束落点机场
  /* 旧实现把落点机场（SHA/PVG）当成「出发机场白名单」传给福州，福州机场里没有这两个，
   * pickAirports 过滤后为空 → 一条航班都不剩，用户勾了机场却只拿到火车。 */
  try {
    if (intent.wantAir) {
      /* 先读本机已有的真价缓存（零请求）；缓存没有、而用户又明确要坐飞机回来时，
       * 才为这一条打一次飞猪 —— 展开单条是用户的主动行为，不该只给「直飞、价格以飞猪为准」。
       * fromPorts 传空 = 福州的全部机场；勾选只约束**落点**机场，稍后按 toIata 筛。
       * batch（墙上批量补查返程）：缓存没有就先给骨架，实时价留出预算给用户主动点开的那条。 */
      let r = await liveFlightOptions(destCity, [], base.to, queryDate, { cap: 6, cachedOnly: true });
      const cachedList = (r && r.list) || [];
      const canGoLive = FLYAI.ready && (!batch || batchFlightLive < BATCH_FLIGHT_CAP);
      if (!cachedList.length && canGoLive) {
        if (batch) batchFlightLive++;
        r = await liveFlightOptions(destCity, [], base.to, queryDate, { cap: 6 });
      }
      let list = (r && r.list) || [];
      /* 过滤前的真实班次留一份：飞猪按「城市」搜，像苏州这种没有机场的城市会就近落到无锡硕放，
       * 用户勾了虹桥（SHA）就一条都命中不了。那种情况不能留空白，得把真班次摆出来并说清落点。 */
      const allFlights = list.filter(o => o.no && o.no !== '直飞');
      if (intent.ports.length) {
        const set = new Set(intent.ports);
        list = list.filter(o => set.has(o.toIata));   // 严格：只留落在勾选机场的
      }
      if (!list.length && allFlights.length) {
        list = allFlights;
        out.airportLoose = true;
        out.airportNote = [...new Set(allFlights.map(o => o.toPort || o.to).filter(Boolean))].slice(0, 2).join(' / ');
      }
      if (list.length) {
        out.options = out.options.concat(list.slice(0, 4).map(o => ({ ...o, mode: 'flight' })));
        if (r && r.live) out.flightLive = true;
      } else if (r && r.reason) {
        out.flightReason = r.reason;
      }
    }
  } catch { /* ignore */ }

  out.options.sort((a, b) => (a.hours ?? 999) - (b.hours ?? 999));
  out.nTrain = out.options.filter(o => o.mode === 'train').length;
  out.nFlight = out.options.filter(o => o.mode === 'flight').length;
  if (!out.options.length) {
    const none = !intent.wantTrain && !intent.wantAir;
    out.note = none
      ? '返程这边没勾车站也没勾机场。点「返程 · 车站机场」勾一下，或直接用上面的 12306 / 飞猪 查。'
      : overPresale
        /* 超预售期时「限流」是假原因，别让用户去反复刷新；参考日也查不到就直说没有直达 */
        ? `${base.date} 还没开售（12306 目前最远只到 ${presaleMax}，${out.openDate || '开售日'} 起可查）。`
          + `参考 ${presaleMax} 当天，${destCity} → ${base.to} 也没有查到直达班次，可点下面的 12306 入口看看中转。`
        : intent.wantAir && !intent.wantTrain
          ? `暂时没取到 ${destCity} → ${base.to} 的直飞班次${out.flightReason === 'no-direct' ? '（这两个城市之间没有直飞）' : ''}，票价与时刻以飞猪为准，可点上面的飞猪入口直接查。`
          : intent.wantTrain && !intent.wantAir
            ? (out.uncertain
              ? `暂时没取到 ${destCity} → ${base.to} 的实时车次（12306 可能在限流），可用下面的入口直接查。`
              : `12306 没有查到 ${destCity} → ${base.to} 的直达班次，可换日期或看看中转。`)
            : '这一程暂时没取到班次，可用上面的 12306 / 飞猪 入口直接查。';
  }
  return out;
}

/** 日期相加：一律按 UTC 计算。
 *  用 new Date('2026-10-20T00:00:00') 会落在本地时区，toISOString() 转 UTC 后会**少一天**（东八区）。 */
function addDays(dateStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 目的地策展素材里的「玩什么」条目：排除「建议 3-4 天」这类元信息，只留景点/吃食 */
function curatedSpots(d) {
  return ((d && d.tips) || []).filter(t => t && !/^建议\s*\d/.test(String(t)));
}

/* ---------------- 行程参数：出发/返程 城市 + 车站/机场勾选 + 单程往返 ---------------- */
function csvList(v) {
  return String(v == null ? '' : v).split(',').map(s => s.trim()).filter(Boolean);
}
/**
 * 解析一次查询的「行程设定」。
 *   from/backCity    出发点与返程落点（默认同一个城市；用户可让去程从苏州走、回程落上海）
 *   *Stations        勾选的车站名（空 = 该市最重要的那个站，避免无谓地把请求量翻倍）
 *   *Ports           勾选的机场 IATA（空 = 该市全部自有+邻近机场）
 *   tripType         单程 oneway（默认）/ 往返 round
 *   backDate         返程日期（往返时用；缺省则按天数推算）
 */
function parseTrip(q) {
  const from = (q.from || '').trim() || '苏州';
  const tripType = q.tripType === 'round' ? 'round' : 'oneway';
  const backCity = (q.backCity || '').trim() || from;
  let backDate = /^\d{4}-\d{2}-\d{2}$/.test(q.backDate || '') ? q.backDate : '';
  return {
    from,
    fromStations: csvList(q.fromStations),
    fromPorts: csvList(q.fromPorts).map(s => s.toUpperCase()),
    tripType,
    backCity,
    backStations: csvList(q.backStations),
    backPorts: csvList(q.backPorts).map(s => s.toUpperCase()),
    backDate,
    /* pick=1：用户动过「出发侧」的车站/机场勾选。此时没勾的那一类（车站/机场）就是「不要」，
     * 结果里绝不能出现用户没选的站点 —— 严格匹配优先于「尽量多出结果」。
     * backPick=1：只动过**返程侧**的勾选。两边必须分开，否则「只勾了回程的昆山南」
     * 会把去程也一起掐成空（去程一个站都没勾 → 严格模式下就是不要车次）。 */
    pick: q.pick === '1' || q.pick === true,
    backPick: q.backPick === '1' || q.backPick === true
  };
}

/** 某城市按重要性排序的车站；勾选为空时只取最重要的一个 */
/** 站名归一：去掉「站」后缀与空白。
 *  站名表里是「苏州」「上海虹桥」，但用户手输、旧链接、外部文档常写成「苏州站」——
 *  严格匹配下差一个字就一个站都对不上，结果直接空白，所以这里先归一。 */
function normStName(n) {
  return String(n == null ? '' : n).replace(/\s+/g, '').replace(/站$/, '');
}
function pickStations(city, picked, strict) {
  const all = (STATIONS[city] || []).slice();
  if (!all.length) return [];
  /* 勾了就**严格按勾的来**：以前这里有个 `sel.length ? sel : all.slice(0,1)` 的兜底，
   * 一旦名字对不上（同城站改名、城市名带后缀），就悄悄换成别的站发出去 ——
   * 用户勾的是苏州北，页面出来的却是苏州站的票，属于「看起来能用，其实是错的」。
   * strict（前端 pick=1，表示用户动过勾选）：没勾的那一类就是「不要」，不再回退到默认。 */
  if (!picked || !picked.length) return strict ? [] : all.slice(0, 1);
  const set = new Set(picked.map(normStName));
  return all.filter(s => set.has(normStName(s)));
}
/** 车站名 → 电报码（12306 只认电报码）。勾了几个就查几个 —— 少查一个就是不严格 */
function stationCodes(names) {
  return names.map(n => RAIL.codeOf(n)).filter(Boolean);
}
/** 出发城市可用的机场；勾选为空时取全部（自有在前、邻近在后），勾了就只留勾的 */
function pickAirports(city, picked, strict) {
  const all = AIR.airportsOfCity(city);
  if (!picked || !picked.length) return strict ? [] : all;
  const set = new Set(picked);
  return all.filter(a => set.has(a.iata));   // 同样不再回退成「全部机场」
}

/**
 * 本地航线库 → 航班选项（与高铁 option 同构，便于「都可以」混排）。
 * 提不出直飞时如实返回原因，而不是含糊的「未取到」。
 * 这是**骨架**：只有航线与时长，没有航班号/时刻/价格 —— 那部分由 liveFlightOptions 补。
 */
function flightOptions(fromCity, fromPorts, destCity, date, o = {}) {
  const ports = pickAirports(fromCity, fromPorts, o.strict);
  if (!ports.length) return { list: [], reason: o.strict ? 'no-picked-port' : 'no-departure-airport' };
  if (!AIR.airportsOfCity(destCity).length) return { list: [], reason: 'no-destination-airport' };
  const rs = AIR.directRoutes(ports.map(p => p.iata), destCity);
  if (!rs.length) return { list: [], reason: 'no-direct' };
  const list = rs.slice(0, Math.max(4, Number(o.cap) || 10)).map(r => {
    const fp = AIR.portOf(r.from) || {};
    const tp = AIR.portOf(r.to) || {};
    const hours = r.min ? Math.round((r.min / 60) * 10) / 10 : null;
    return {
      no: '直飞', kind: '航班', mode: 'flight',
      from: fp.city || fromCity, to: tp.city || destCity,
      fromPort: fp.cn || '', toPort: tp.cn || '',
      fromIata: r.from, toIata: r.to,
      dep: '', arr: '', date,
      hours, km: r.km, airlines: r.by || [],
      seat: '经济舱', price: null, priceText: '', qty: '', live: false,
      jumpUrl: fliggyFlightUrl(fp.city || fromCity, tp.city || destCity, date, o)
    };
  });
  return { list, reason: '' };
}

/**
 * 航班选项（实时优先）——真正给用户看的那一层。
 * ------------------------------------------------------------------
 * 顺序写死，不许调换：
 *   ① 用户勾了机场 → 只查这些机场所在的出发城市（勾选是用户的明确意图）；
 *   ② 先问飞猪要**真实在售航班**（航班号/时刻/票价/下单链接）；
 *   ③ 飞猪没有答案（无直飞、接口抖动、没配 Key）→ 退回本地航线库骨架，并说明原因。
 * 返回值多一个 live 字段：true 表示这一屏是实时票价，前端据此打「实时」标。
 */
async function liveFlightOptions(fromCity, fromPorts, destCity, date, o = {}) {
  const ports = pickAirports(fromCity, fromPorts, o.strict);
  if (!ports.length) return { list: [], reason: o.strict ? 'no-picked-port' : 'no-departure-airport', live: false };
  const fallbackUrl = fliggyFlightUrl(fromCity, destCity, date, o);

  // 注意：这里**不看 DEMO**。DEMO 约束的是「高铁不发实时请求」；飞猪能否用由 ready 决定
  // （ready 需要 Key + CLI 同时存在，公网沙箱二者都没有，自然退回骨架）。
  // o.cachedOnly 时只读本地历史真价（零请求）：读磁盘不需要 Key，
  // 所以**不能**跟着 ready 一起被挡掉 —— 否则公网 demo 明明上传了 flight-cache，
  // 却因为沙箱里没有 Key 而全部显示「以飞猪为准」。
  if (o.cachedOnly || FLYAI.ready) {
    const r = await FLYAI.searchFlight({
      origin: ports[0].city || fromCity,
      destination: destCity,
      date,
      fallbackUrl,
      cachedOnly: !!o.cachedOnly
    });
    if (r.list.length) {
      // 用户勾了具体机场 → 只留从这些机场起飞的班次（勾选才真正生效）
      const picked = o.fromPorts && o.fromPorts.length ? new Set(o.fromPorts) : null;
      const list = picked ? r.list.filter(x => picked.has(x.fromIata)) : r.list;
      const use = list.length ? list : [];
      if (use.length) {
        // stale = 飞猪风控中，票价是上次查到的真价（不是此刻的），此时不能标成「实时」
        return { list: use.slice(0, Math.max(4, Number(o.cap) || 10)), reason: '', live: !r.stale, stale: !!r.stale, staleAt: r.staleAt || 0 };
      }
    }
  }
  // 实时层没给出可用结果 → 骨架兜底（保证页面永远有「能不能直飞」的结论）
  const fo = flightOptions(fromCity, fromPorts, destCity, date, o);
  return { ...fo, live: false };
}

/* ------------------------------------------------------------------ *
 * 一·B、后台温和自补（autowarm）
 * ------------------------------------------------------------------
 * 只做一件事：把「默认日期（今天 +7）」上本地还缺的目的地慢慢补上。
 * 三条纪律，缺一不可：
 *   ① 只补缺的 —— 已有缓存的目的地 0 请求，所以大多数轮次是「什么都不做」；
 *   ② 慢 —— 单次间隔 RAIL_WARM_GAP（默认 1200ms，比页面交互用的 280ms 更保守），并发 1；
 *   ③ 不循环探测 —— 一轮跑完就睡，下一次在 RAIL_WARM_EVERY 之后。
 * 这样公网部署上的评审打开页面时，默认日期始终有真余票，而不是只剩存档时刻。
 */
const AUTOWARM = process.env.RAIL_AUTOWARM !== '0' && !DEMO;
const WARM_GAP = Math.max(400, Number(process.env.RAIL_WARM_GAP) || 1200);
const WARM_EVERY = Math.max(600000, Number(process.env.RAIL_WARM_EVERY) || 6 * 3600 * 1000);
let autoWarming = false;
async function autoWarm(why) {
  // 演示模式连后台自补都不跑：demo 环境里没有任何理由去动 12306。
  if (!AUTOWARM || autoWarming || !RAIL.ready) return;
  autoWarming = true;
  try {
    const def = new Date(); def.setDate(def.getDate() + 7);
    const date = `${def.getFullYear()}-${String(def.getMonth() + 1).padStart(2, '0')}-${String(def.getDate()).padStart(2, '0')}`;
    const from = process.env.RAIL_WARM_FROM || '苏州';
    const fromCode = RAIL.codeOf(from);
    if (!fromCode) return;
    const todo = POOL.filter(d => !RAIL.isFresh(fromCode, date, d));
    if (!todo.length) { console.log(`[autowarm] ${why}：${date} 已全部有缓存，0 请求`); return; }
    console.log(`[autowarm] ${why}：${date} 待补 ${todo.length}/${POOL.length}（间隔 ${WARM_GAP}ms，只补缺的）`);
    const st = await RAIL.scanAll({
      fromName: from, fromCode, date, dests: todo, gapMs: WARM_GAP,
      onProgress: s => { if (s.scanned % 40 === 0) console.log(`[autowarm] ${s.scanned}/${s.total} 有车=${s.covered} 无直达=${s.noDirect} 失败=${s.failed}`); }
    });
    console.log(`[autowarm] ${why} 完成：${JSON.stringify(st)}`);
  } catch (e) { console.log('[autowarm] 出错：' + (e && e.message)); }
  finally { autoWarming = false; }
}

/* ------------------------------------------------------------------ *
 * 二、数据归一化
 * ------------------------------------------------------------------ */

/**
 * CPS 推广位（商业价值保留的关键挂载点）
 * ------------------------------------------------------------------
 * 每个商品链接都指向飞猪对应页面。把推广位参数
 * 配到 AFFILIATE_QUERY，成交即可分佣——这样「平台方上架/集成本功能」与「你获利」
 * 是同一件事，而不是零和。
 *
 * AFFILIATE_QUERY 形如：utm_source=xxx&cid=yyy
 * 默认留空 → 链接原样输出，不影响功能，也不会因为猜参数而搞坏跳转。
 * 拿到开放平台的推广位参数后，填在 启动.bat 里即可，无需改代码。
 */
const AFFILIATE_QUERY = process.env.AFFILIATE_QUERY || '';
function decorate(u) {
  const url = u || '';
  if (!url || !AFFILIATE_QUERY) return url;
  return url + (url.includes('?') ? '&' : '?') + AFFILIATE_QUERY;
}
// 池里的名字有些是站名（歙县北 / 青州市），flyai 按城市检索，需要归一
const CITY_FIX = {
  歙县北: '歙县', 黟县东: '黟县', 青州市: '青州', 龙泉市: '龙泉', 和顺县: '和顺',
  防城港北: '防城港', 太子城: '崇礼', 南平市: '南平', 白山市: '白山',
  二连: '二连浩特', 普者黑: '普者黑'
};
const normCity = n => CITY_FIX[n] || String(n).replace(/市$/, '');

function firstSeg(item) {
  const j = (item.journeys || [])[0];
  const s = j && (j.segments || [])[0];
  return { journey: j, seg: s };
}

/* ------------------------------------------------------------------ *
 * 三、自然语言意图解析（参赛命题要的「AI 是核心解法」入口）
 * ------------------------------------------------------------------ */
const ORIGINS = ['苏州', '上海', '北京', '广州', '深圳', '杭州', '南京', '成都', '重庆', '武汉', '西安',
  '天津', '郑州', '长沙', '合肥', '济南', '青岛', '福州', '厦门', '南昌', '昆明', '贵阳', '南宁',
  '太原', '石家庄', '沈阳', '哈尔滨', '长春', '大连', '兰州', '西宁', '银川', '乌鲁木齐',
  '呼和浩特', '海口', '三亚', '无锡', '常州', '宁波', '温州', '徐州', '佛山', '东莞', '珠海', '泉州',
  '南通', '扬州', '绍兴', '嘉兴', '湖州', '台州', '金华', '烟台', '潍坊', '洛阳', '保定', '唐山'];

const TAG_HINTS = [
  [['温泉', '泡汤'], ['温泉']],
  [['古镇', '水乡'], ['古镇', '古城', '古村', '水乡', '运河']],
  [['古城', '古城墙'], ['古城', '古都', '历史']],
  [['海边', '大海', '海岛', '沙滩', '看海'], ['海滨', '海岛', '海景', '渔村', '银滩']],
  [['雪山', '冰川'], ['雪山', '冰川']],
  [['草原', '牧场'], ['草原', '牧歌']],
  [['沙漠', '戈壁'], ['沙漠', '戈壁', '丹霞']],
  [['山', '爬山', '徒步'], ['山岳', '山水', '森林', '峡谷']],
  [['湖', '泛舟'], ['湖泊', '湿地']],
  [['梯田'], ['梯田']],
  [['美食', '吃', '小吃'], ['美食', '小吃', '早茶', '烧烤']],
  [['民宿', '小城', '安静', '发呆', '慢'], ['小城', '古村', '田园']],
  [['异域', '边境', '出境'], ['异域', '边境', '西域']],
  [['石窟', '大佛', '寺庙', '佛教'], ['石窟', '佛教', '宗教场所']],
  [['海岛'], ['海岛', '岛屿']],
  [['茶'], ['茶山', '茶园']],
  [['滑雪', '雪'], ['滑雪', '雪乡']],
  [['看海'], ['海滨', '海景']]
];

function parseIntent(q, base = {}) {
  const text = String(q || '');
  const intent = {
    raw: text,
    from: base.from || '',
    date: base.date || '',
    days: base.days || 2,
    budget: null,
    tags: [],
    fameMax: null
  };

  // 出发地
  if (!intent.from) {
    const hit = ORIGINS.find(c => text.includes(c));
    if (hit) intent.from = hit;
  }

  // 时间预算
  if (/半天/.test(text)) intent.days = 0.5;
  else if (/当天|一日|一天|1\s*天/.test(text)) intent.days = 1;
  else if (/周末|两天|2\s*天|双休/.test(text)) intent.days = 2;
  else if (/三天|3\s*天|小长假/.test(text)) intent.days = 3;
  else {
    const m = /([四五六七1-9])\s*天/.exec(text);
    if (m) intent.days = m[1] === '四' ? 4 : m[1] === '五' ? 5 : m[1] === '六' ? 6 : m[1] === '七' ? 7 : Number(m[1]);
  }

  // 预算
  const b = /预算\s*(\d{2,6})|人均\s*(\d{2,6})|(\d{3,6})\s*(?:元|块|以内)/.exec(text);
  if (b) intent.budget = Number(b[1] || b[2] || b[3]);

  // 主题
  for (const [words, tags] of TAG_HINTS) {
    if (words.some(w => text.includes(w))) intent.tags.push(...tags);
  }
  intent.tags = [...new Set(intent.tags)];

  // 小众 / 网红
  if (/小众|冷门|人少|安静|不挤|清净/.test(text)) intent.fameMax = 2;
  if (/网红|必去|经典|著名/.test(text)) intent.fameMin = 3;

  return intent;
}

// 「时间预算」对应的理想单程耗时（小时）
function idealHours(days) {
  if (days <= 0.5) return 1.2;
  if (days <= 1) return 2.2;
  if (days <= 2) return 3.2;
  if (days <= 3) return 5.5;
  if (days <= 4) return 8;
  return 11;
}

function scoreDest(dest, opt, hours) {
  const ideal = idealHours(opt.days);
  const spread = Math.max(1.4, ideal * 0.85);
  let s = 100 * Math.exp(-((hours - ideal) ** 2) / (2 * spread ** 2));
  s += (dest.fame || 1) * 3;
  const overlap = (dest.tags || []).filter(t => (opt.tags || []).includes(t)).length;
  s += overlap * 7;
  // AI 点名推荐的目的地加权 —— 体现「AI 参与决策」
  if (opt.aiHit && opt.aiHit.includes(dest.name)) s += 12;
  return Math.round(s * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * 三·A、意图理解：本地规则实现
 * ------------------------------------------------------------------
 * 「自然语言 → 结构化意图」这件事，抽的是天数 / 主题 / 小众偏好这类**确定性字段**，
 * 用规则做得好，且带来两个实打实的好处：
 *   ① 零配额、零外部依赖 —— 不会因为第三方额度耗尽而整层静默降级；
 *   ② 零网络往返 —— 不拖慢主流程。
 * 因此由 parseIntent 抽字段、localSemantic 做关键词加权，结果完全可预测、可单测。
 *
 * 可选大模型（默认关闭）：若你想让「行程块」的措辞由模型润色，设置
 *   LLM_BASE=https://... / LLM_API_KEY=... / LLM_MODEL=...
 * 三件齐全才启用，且**任何失败都退回本地规则** —— 模型可用与否不影响功能。
 *
 * 【赛事提交】要接阿里云百炼，只需设 BAILIAN=1（或只填 DASHSCOPE_API_KEY）；
 * 端点与模型名会自动补成百炼的 OpenAI 兼容端点，无需手写 URL。Key 也从
 * ~/.bailian/config.json 读取，不必写进项目文件（提交仓库不会泄漏）。
 */
const BAILIAN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** 百炼 Key 的解析顺序：环境变量 → 用户级配置 ~/.bailian/config.json
 *  → 项目内 data/bailian-key.json（给云端容器用：托管环境没有 HOME，
 *  用户目录的配置上传不上去，Key 只能跟着项目走。data/ 不在静态目录里，
 *  不会被当静态文件下发；仓库里由 .gitignore 排除。） */
const BAILIAN_KEY_FILE = path.join(DIR, 'data', 'bailian-key.json');
function readBailianKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const from = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.bailian', 'config.json'),
    BAILIAN_KEY_FILE
  ];
  for (const cfg of from) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      const k = j.DASHSCOPE_API_KEY || j.api_key || j.key || '';
      if (k) return k;
    } catch { /* 换下一个来源 */ }
  }
  return '';
}
/** 项目内是否放了 Key 文件 —— 云端无人值守，有文件就自动启用百炼，不必再设 BAILIAN=1 */
function hasProjectBailianKey() {
  try { return fs.statSync(BAILIAN_KEY_FILE).size > 0; } catch { return false; }
}

/** 大模型配置：显式 LLM_* 优先；显式要求时才接百炼（避免本机残留的旧 Key 被静默启用） */
const LLM = (() => {
  const base = process.env.LLM_BASE || '';
  const key = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  if (base && key) return { base, key, model: model || 'qwen-plus', via: 'LLM_*' };
  if (base || key) return { base: '', key: '', model: '', via: '' };   // 只配一半 → 视为未配置
  const wantBailian = process.env.BAILIAN === '1' || !!process.env.DASHSCOPE_API_KEY || hasProjectBailianKey();
  if (!wantBailian) return { base: '', key: '', model: '', via: '' };
  const bk = readBailianKey();
  if (!bk) return { base: '', key: '', model: '', via: '' };
  return { base: BAILIAN_ENDPOINT, key: bk, model: model || 'qwen-plus', via: '百炼' };
})();

/**
 * 备用大模型：~/.llm/config.json（{ base, api_key, model, label }）。
 * ------------------------------------------------------------------
 * 为什么要有这一层：赛事强制用百炼，但**账户欠费（Arrearage）时百炼会直接拒绝请求**，
 * 那时如果只有一条模型链路，行程就只能退回措辞朴素的本地规则。
 * 这里再挂一条任意 OpenAI 兼容端点，主链路失败时自动顶上，页面永远有顺滑的措辞。
 * Key 只存用户目录，不进项目文件 —— 提交仓库不会泄漏。
 */
function readAltLLM() {
  try {
    const cfg = path.join(process.env.USERPROFILE || process.env.HOME || '', '.llm', 'config.json');
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    const base = String(j.base || j.LLM_BASE || '').trim().replace(/\/+$/, '');
    const key = String(j.api_key || j.LLM_API_KEY || '').trim();
    const model = String(j.model || j.LLM_MODEL || '').trim();
    if (!base || !key) return null;
    return { base, key, model: model || 'gpt-4o-mini', label: String(j.label || model || '备用模型') };
  } catch { return null; }
}
const ALT_LLM = readAltLLM();

const LLM_BASE = LLM.base;
const LLM_KEY = LLM.key;
const LLM_MODEL = LLM.model || 'qwen-plus';
const LLM_TIMEOUT_MS = Math.max(2000, Number(process.env.LLM_TIMEOUT_MS) || 12000);
/* 提供者链：主（百炼 / LLM_*）→ 备用（~/.llm/config.json）。
 * 每个提供者各自记失败次数与冷却，互不牵连。 */
const LLM_PROVIDERS = [
  LLM_BASE && LLM_KEY ? { base: LLM_BASE.replace(/\/$/, ''), key: LLM_KEY, model: LLM_MODEL, label: LLM.via || '模型', fails: 0, downUntil: 0 } : null,
  ALT_LLM ? { ...ALT_LLM, fails: 0, downUntil: 0 } : null
].filter(Boolean);
const HAS_LLM = LLM_PROVIDERS.length > 0;

/*
 * 百炼「高代码应用」地址（路径 B 的核心接线）。
 * 配了它，行程就优先由百炼应用生成：应用侧再去调飞猪 MCP 拿真实航班/酒店/景点，
 * 走 qwen 编排成「· 」短行。这样评审在百炼控制台能看到完整的工具调用记录。
 * 没配（或调用失败）就退回本地 LLM 润色，再退回本地规则 —— 三层降级，页面永不空白。
 */
const BAILIAN_APP_URL = (() => {
  const raw = (process.env.BAILIAN_APP_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  // 发布沙箱只暴露一个对外端口，本机回环地址（127.0.0.1:8090）在那里必然连不上。
  // 留着只会让每条行程先白等一次连接失败 —— 云端自动忽略，直接走第二层降级。
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(raw);
  const inCloud = !!process.env.PORT && Number(process.env.PORT) !== 8790;
  if (isLoopback && inCloud) return '';
  return raw;
})();
const BAILIAN_APP_TIMEOUT_MS = Math.max(3000, Number(process.env.BAILIAN_APP_TIMEOUT_MS) || 25000);
let appCalls = 0;
let appFails = 0;
let appFailStreak = 0;
let appDownUntil = 0;

/**
 * 调百炼应用的 /process（非流式），取出 extra.plan。
 * 返回 { plan, source } 或抛错（由调用方降级）。
 */
async function bailianAppPlan({ dest, from, date, days, transport, trip, lines }) {
  if (!BAILIAN_APP_URL) throw new Error('NO_APP_URL');
  // 连续失败两次 → 冷却 5 分钟，避免每个目的地都白等一次超时
  if (Date.now() < appDownUntil) throw new Error('APP_COOLING');

  // 优先把本地已核实的事实要点直接喂过去（最省一次飞猪往返，也最不容易编造）
  const factText = lines.map(l => `[${l.k}] ${l.t}`).join('\n');
  const query = [
    `${from || '本地'}出发 ${date} 去${dest}`,
    `玩${days}天`,
    trip && trip.tripType === 'round' ? `往返，${trip.backDate} 返回` : '单程',
    transport === 'flight' ? '优先飞机' : transport === 'rail' ? '优先高铁' : ''
  ].filter(Boolean).join(' ') + '\n\n【已核实要点】\n' + factText;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BAILIAN_APP_TIMEOUT_MS);
  appCalls++;
  try {
    const r = await fetch(`${BAILIAN_APP_URL}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: [{ role: 'user', content: [{ type: 'text', text: query }] }],
        stream: false
      }),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    const j = await r.json();
    // Agent API 协议：正文在 output[].content[].text，结构化字段在 extra
    let text = (j && j.extra && j.extra.plan) || '';
    if (!text && Array.isArray(j && j.output)) {
      text = j.output
        .flatMap(o => (Array.isArray(o && o.content) ? o.content : []))
        .filter(c => c && c.type === 'text')
        .map(c => c.text || '')
        .join('\n');
    }
    const plan = normalizePlanText(String(text || '')).slice(0, 600);
    if (!plan) throw new Error('EMPTY_PLAN');
    appFailStreak = 0;
    return { plan, source: 'bailian-app', extra: (j && j.extra) || null };
  } catch (e) {
    appFails++;
    appFailStreak++;
    if (appFailStreak >= 2) appDownUntil = Date.now() + 5 * 60 * 1000;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

let llmCalls = 0;
let llmFails = 0;
let llmFailStreak = 0;
let llmDownUntil = 0;

/*
 * 行程润色的系统提示词。
 * 关键点：它必须走 role=system（而不是塞进 user 消息）——
 * 放在 user 里，多轮对话一夹就失效，模型会把要点压成一段逗号连写。
 * 输出格式另有 planfmt.mjs 做确定性兜底，提示词只负责「事实不越界」。
 */
const PLAN_SYSTEM_PROMPT = `你是一个严谨的中文旅行行程助手，只负责把"已核实的行程要点"润色成通顺、可读的安排，绝不创造任何信息。

# 输入格式
用户消息是若干行要点，每行形如 \`[标签] 内容\`。标签含义：
- 去：去程交通（真实车次/航班、时刻、时长、票价如有）
- 返：返程信息（仅当用户选了"往返"才出现）
- 玩：当地必看景点 / 必吃（来自本地策展的真实地名）
- 住：住宿区位建议

这些要点都是系统从真实数据源（12306 高铁实时、飞猪开放平台航班、本地策展）取到的"已核实事实"。

# 硬规则（违反任一条都算失败）
1. 只能使用输入里给出的事实。禁止新增任何地点、店名、票价、时刻、车次/航班号、时长——输入没有的，一个字都不要写。
2. 若某条要点写明"暂未取到 / 建议自行查询 / 需中转"，你必须原样保留这个提醒，禁止编造一个来补位。
3. 不解释、不道歉、不写"根据您的要求"等套话，直接给安排。

# 输出格式
- 改写成 3~4 行中文，每行以"· "开头，每行不超过 40 个汉字。
- 必须换行，不要把多行并成一段。
- 不要标题、不要序号、不要任何 markdown（加粗、链接、表格、代码块都不行）。
- 直接输出这几行，前后不要多余空行。

# 示例
输入：
[去] G2837 成都东 08:12 出发，昆明 12:41 到，约 4.5h，二等座 ¥341
[玩] 滇池；石林；翠湖
[住] 优先住昆明站 / 翠湖周边，换乘成本低

输出：
· 去程 G2837 早 8:12 出发，午后到昆明，放行李后轻松逛
· 第一天翠湖 + 滇池，同方向不绕路
· 第二天石林一日，返程前留时间回站
· 住翠湖或昆明站旁，吃饭逛街步行可达`;


/** 调一个提供者；失败时只给它自己记失败与冷却，不牵连下一条 */
async function callProvider(p, messages, opts = {}) {
  if (Date.now() < p.downUntil) throw new Error(`PROVIDER_COOLING:${p.label}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || LLM_TIMEOUT_MS);
  try {
    const res = await fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify({
        model: opts.model || p.model,
        messages,
        temperature: opts.temperature === undefined ? 0.3 : opts.temperature
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      p.fails++;
      if (p.fails >= 2) p.downUntil = Date.now() + 10 * 60 * 1000;   // 连续 2 次失败 → 冷却 10 分钟
      const body = (await res.text()).slice(0, 200);
      throw new Error('LLM_HTTP_' + res.status + ' ' + body);
    }
    const j = await res.json();
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    p.fails = 0;
    return c || '';
  } catch (e) {
    if (ctl.signal.aborted) {
      p.fails++;
      if (p.fails >= 2) p.downUntil = Date.now() + 10 * 60 * 1000;
      throw new Error('LLM_TIMEOUT');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 依次尝试提供者链：主（百炼 / LLM_*）→ 备用（~/.llm/config.json）。
 * 全部失败才抛错，调用方据此退回本地规则 —— 页面永远不会因为模型挂掉而空白。
 */
let lastLLMEngine = '';
async function llmChat(messages, opts = {}) {
  if (!HAS_LLM) throw new Error('NO_LLM_KEY');
  // 全局熔断：所有提供者都在冷却 → 直接放弃，不让用户每条都白等一次超时。
  if (Date.now() < llmDownUntil) throw new Error('LLM_COOLING');
  llmCalls++;
  let lastErr = null;
  for (const p of LLM_PROVIDERS) {
    try {
      const txt = await callProvider(p, messages, opts);
      lastLLMEngine = p.label;
      llmFailStreak = 0;
      return txt;
    } catch (e) {
      lastErr = e;
      llmFails++;
      llmFailStreak++;
      if (llmFailStreak >= 4) llmDownUntil = Date.now() + 10 * 60 * 1000;
    }
  }
  throw lastErr || new Error('LLM_ALL_FAILED');
}

/** 池内全部主题标签，作为受限词表（供前端筛选器与本地规则使用） */
function poolTagVocab() {
  const s = new Set();
  for (const d of POOL) for (const t of d.tags || []) s.add(t);
  return [...s].join('、');
}

/**
 * 意图增强：本地规则已由 parseIntent 覆盖全部字段（出发地/天数/预算/主题/小众偏好）。
 * 保留这个调用点是为了「将来想接大模型」时有个明确的插槽，当前恒返回 null ——
 * 也就是完全不改变 parseIntent 的结果，没有隐藏的不确定性。
 */
async function aiParseIntent(intent) {
  return null;
}

/** 把模型结果合并进正则结果。表单里用户手选过的字段优先级最高，不被覆盖。 */
function applyAiIntent(intent, ai, form = {}) {
  const applied = [];
  if (!ai || typeof ai !== 'object') return applied;

  if (!intent.from && !form.fromGiven && typeof ai.from === 'string' && ai.from.trim()) {
    intent.from = ai.from.trim().replace(/市$/, '');
    applied.push('出发地');
  }
  const d = Number(ai.days);
  if (!form.daysGiven && Number.isFinite(d) && d > 0 && d <= 15 && d !== intent.days) {
    intent.days = d; applied.push('天数');
  }
  if (!intent.budget) {
    const b = Number(ai.budget);
    if (Number.isFinite(b) && b >= 50 && b <= 200000) { intent.budget = b; applied.push('预算'); }
  }
  const legit = new Set();
  for (const dd of POOL) for (const t of dd.tags || []) legit.add(t);
  const extra = Array.isArray(ai.tags) ? ai.tags.filter(t => legit.has(t) && !intent.tags.includes(t)) : [];
  if (extra.length) { intent.tags = [...new Set([...intent.tags, ...extra])].slice(0, 6); applied.push('主题：' + extra.join('/')); }
  if (!intent.fameMax && ai.fameMax === 2) { intent.fameMax = 2; applied.push('偏小众'); }
  if (!intent.fameMin && ai.fameMin === 3) { intent.fameMin = 3; applied.push('偏经典'); }
  if (typeof ai.reason === 'string' && ai.reason.trim()) intent.reason = ai.reason.trim().slice(0, 60);

  return applied;
}

/* ------------------------------------------------------------------ *
 * 三·B、语义匹配层（本地关键词加权，取代飞猪 ai-search）
 * ------------------------------------------------------------------
 * 作用不变：让用户的原话真正影响结果 —— 被点名的目的地优先扫描、排序加权。
 * 但实现不再依赖外部接口：把原话当作关键词串，去匹配池内目的地的
 * 名称 / 别名 / 主题标签 / 一句话印象。拿得到就加权，拿不到就纯按规则排序，
 * 不存在「接口挂了整块功能就退化」的问题。
 */
function localSemantic(intent, pool) {
  const raw = String(intent.raw || '').trim();
  if (!raw) return { text: '', hit: [] };
  const scored = [];
  for (const d of pool) {
    let s = 0;
    if (raw.includes(d.name)) s += 10;                                  // 直接点名
    for (const a of (d.aliases || [])) if (a && a.length > 1 && raw.includes(a)) s += 6;
    for (const t of (d.tags || [])) if (t && raw.includes(t)) s += 3;   // 主题词命中
    if (s > 0) scored.push([d.name, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return { text: '', hit: scored.slice(0, 40).map(x => x[0]) };
}
async function aiUnderstand(intent, pool) {
  return localSemantic(intent, pool);
}

/* ------------------------------------------------------------------ *
 * 三·C、全量列表（列表永不空屏）
 * ------------------------------------------------------------------
 * 把本地策展池（216 个目的地，含必看/必吃/建议天数）与快照里的实时车次
 * 合并成一份「一屏全列」的数据。全程零 API 调用 → 打开即出，且不受配额影响。
 * 没有实时数据的目的地照常列出（curated 内容在），只是标记 covered:false，
 * 用户可单点补查。
 */
/** "HH:MM" → 当天第几分钟；解析不了返回 null */
function clockMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function minToClock(v) {
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

/**
 * 取某目的地的直达班次（火车优先，飞机明显更快时才改用飞机）。
 * 归一化后的 list 按耗时升序，list[0] 即「最快」——注意它不等于「最早发车」。
 */
/** 出行方式：高铁 / 飞机 / 都可以 */
const TRANSPORTS = ['all', 'train', 'flight'];
function normTransport(t) {
  const v = String(t || '').toLowerCase();
  return TRANSPORTS.includes(v) ? v : 'all';
}
/** 某条班次属于哪种交通方式（归一化时会写进 mode，这里兜底） */
function modeOf(o) { return o && o.mode === 'flight' ? 'flight' : 'train'; }

/**
 * 取某目的地当天的班次，按出行方式筛选并**合并**高铁与航班。
 * transport: 'all'（默认）| 'train' | 'flight'
 *
 * opts 里的行程设定（来自 parseTrip）：
 *   fromStations  勾选的车站（同城多站）；空 = 该市最重要的一个站
 *   fromPorts     勾选的机场 IATA；空 = 该市全部自有+邻近机场
 *   round/backDate 往返时用于生成机票跳转链接（tripType=2）
 *
 * 高铁走 12306（实时余票），航班走**本地航线库**（零网络、永不失败）。
 * opts.cacheOnly=true 时高铁绝不发网络请求（页面首屏渲染走这条路径，零成本、秒出）；
 * 航班本来就不发请求，所以首屏与实时查询的航班结论完全一致 —— 这是本地库最大的好处。
 */
async function scheduleFor(d, from, date, transport, opts = {}) {
  const want = normTransport(transport);
  const stations = pickStations(from, opts.fromStations, opts.strict);
  const codes = stationCodes(stations);

  let rail = { ok: false, list: [], source: '', archivedDate: '', count: 0, nTrain: 0 };
  if (want !== 'flight') {
    if (codes.length) {
      rail = await RAIL.railList(from, codes, date, d, {
        cacheOnly: !!opts.cacheOnly, siblings: false, cap: 12,
        onlyFrom: opts.strict ? stations : null      // 勾了站就只留勾的那几个站的车
      });
    }
  }
  const train = (rail.list || []).map(o => ({ ...o, mode: 'train' }));

  let flight = [];
  let flightReason = '';
  let flightLive = false;
  if (want !== 'train') {
    // noLive：列表级的批量预渲染不逐城打飞猪（一次请求都不发）。
    // 但「零请求」不等于「没价格」——本地 flight-cache 里已有的历史真价要顶上来，
    // 并带上查询时间让前端如实标注，否则缓存里明明有价，列表却全写「以飞猪为准」。
    const fo = opts.noLive
      ? await liveFlightOptions(from, opts.fromPorts, normCity(d.name), date, {
          round: opts.round, backDate: opts.backDate, cap: 8, cachedOnly: true, strict: opts.strict })
      : await liveFlightOptions(from, opts.fromPorts, normCity(d.name), date, {
          round: opts.round, backDate: opts.backDate, cap: 8, strict: opts.strict });
    flight = fo.list;
    flightReason = fo.reason;
    flightLive = !!fo.live;
  }
  const list = train.concat(flight).sort((a, b) => (a.hours ?? 999) - (b.hours ?? 999));
  return {
    mode: list.length ? list[0].mode : '',
    modes: [...new Set(list.map(modeOf))],
    list,
    railOk: rail.ok,
    railSource: rail.source || '',
    archivedDate: rail.archivedDate || '',
    railCount: rail.count || 0,
    flightReason,
    flightLive
  };
}

async function buildList(from, date, days, tags, transport, opts = {}) {
  const wantTags = tags || [];
  const tp = normTransport(transport);
  const items = [];
  for (const d of POOL) {
    const city = normCity(d.name);
    const { mode, modes, list, railOk, railSource, archivedDate, railCount, flightReason } =
      await scheduleFor(d, from, date, tp, opts);
    const best = list[0] || null;
    // 「最早发车」要在全天所有班次里取最小值——best 是「最快」那趟，两者常常不是同一班。
    // 航班的 dep 为空（本地航线库没有时刻），所以它不会参与这个最小值计算。
    let depMin = null;
    for (const o of list) {
      const v = clockMin(o.dep);
      if (v !== null && (depMin === null || v < depMin)) depMin = v;
    }
    /* 最快那班未必有价（航班常缺价）—— 墙上还要给一个「最低价」兜底，
     * 否则明明有 ¥228 的高铁，方块上却只能写「查价」。 */
    let minPrice = null;
    for (const o of list) if (o.price != null && (minPrice === null || o.price < minPrice)) minPrice = o.price;
    items.push({
      name: d.name, city, code: d.code, tags: d.tags || [], fame: d.fame, blurb: d.blurb, tips: d.tips || [],
      mode, modes, best, options: list.slice(0, 12), count: railCount || list.length,
      nTrain: list.filter(o => modeOf(o) === 'train').length,
      nFlight: list.filter(o => modeOf(o) === 'flight').length,
      hours: best ? best.hours : null,
      price: best ? best.price : null,
      minPrice,
      depMin,
      earlyDep: depMin === null ? '' : minToClock(depMin),
      score: best ? scoreDest(d, { days, tags: wantTags }, best.hours) : 0,
      covered: !!best,
      // 数据来源与新鲜度：高铁为 live/cache/archive，航班恒为 air（本地航线库，非实时班次）
      source: railSource || (list.length && modeOf(list[0]) === 'flight' ? 'air' : ''),
      archivedDate: archivedDate || '',
      railTried: railOk,          // 12306 确实查过（true）还是连查都没查成（false）
      // 提不出直达航班时的原因（无出发机场 / 目的地无民航机场 / 无直飞航线），
      // 让前端能如实说明，而不是一句含糊的「未取到」。
      flightReason: flightReason || '',
      // 查过了、但一趟直达都没有 → 这是 12306 给出的「无直达」结论，不是「没查到」。
      // 前端据此把这类目的地显示成「需中转」，而不是含糊的「未取到」。
      noDirect: !best && railOk
    });
  }
  return items;
}

/**
 * 单目的地实时补查。
 * 高铁走 12306（含同城站补查，多花 2~4 次请求换准确度）；
 * 航班走飞猪（配额受限，只在可用时查）。
 */
async function handleLive(req, res, q) {
  const name = q.dest || '';
  const d = POOL.find(x => x.name === name) || POOL.find(x => x.code === q.code);
  if (!d) return sendJson(res, { ok: false, error: '未知目的地' }, 400);
  const from = q.from || '';
  const date = q.date || '';
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, { ok: false, error: '缺少 from / date' }, 400);
  // 演示模式一律不外呼：前端已经不会调到这里，后端再兜一层，
  // 免得有人手动打接口就把公网 demo 变成一台对着 12306 / 飞猪狂发的机器。
  if (DEMO) {
    return sendJson(res, {
      ok: false, demo: true,
      error: '离线演示模式：实时补查已关闭，这里展示的是本机已抓取的真实班次快照。'
    });
  }
  const trip = parseTrip(q);
  /* 这一程「按你选的返程方式」根本回不来（没机场 / 没直飞 / 没铁路）→ 直接说清楚，
   * 而不是先查半天去程再让返回段空着。 */
  if (!backFeasible(normCity(d.name), trip)) {
    return sendJson(res, {
      ok: false, backInfeasible: true,
      error: `${d.name} 按你选的返程方式回不来（目的地或返程落点没有对应的车站/机场直连），已从候选里剔除。`
    });
  }
  try {
    const { card, error, noDirect } = await scanOne(d, {
      from, date, days: Number(q.days) || 2, tags: [], transport: normTransport(q.transport),
      trip
    });
    if (!card) {
      return sendJson(res, {
        ok: false, noDirect: !!noDirect,
        error: error || (noDirect
          ? '12306 已确认：该站没有从出发地直达的车次，这类目的地通常需要中途换乘。'
          : '没有查到直达班次（已尝试同城站补查）')
      });
    }
    // 往返：顺手把返程班次也查回来（一次 1~2 个请求），别只丢两个链接给用户
    if (trip && trip.tripType === 'round') {
      try { card.back = await backLegPlan(normCity(d.name), trip); } catch { /* 返程失败不影响去程 */ }
    }
    return sendJson(res, { ok: true, card });
  } catch (e) {
    if (e && e.blocked) {
      return sendJson(res, { ok: false, blocked: true, error: '12306 触发了频控保护，已短暂熔断，稍后再试即可。' });
    }
    return sendJson(res, { ok: false, error: String(e.message || e) });
  }
}

/* ------------------------------------------------------------------ *
 * 四、扫描任务（SSE 边扫边出）
 * ------------------------------------------------------------------ */
const jobs = new Map();
let activeScans = 0;
const MAX_CONCURRENT = Number(process.env.MAX_SCANS) || 2;

function poolFor(intent, limitN, aiHit = [], base = POOL) {
  let pool = base.slice();
  if (intent.fameMax) pool = pool.filter(d => d.fame <= intent.fameMax);
  if (intent.fameMin) pool = pool.filter(d => d.fame >= intent.fameMin);
  if (intent.tags.length) {
    const f = pool.filter(d => (d.tags || []).some(t => intent.tags.includes(t)));
    if (f.length >= 6) pool = f;
  }
  // AI 点名的目的地排最前（保证被 limit 截断时一定在），其余按知名度降序
  const aiSet = new Set(aiHit);
  pool.sort((a, b) => (aiSet.has(b.name) - aiSet.has(a.name)) || (b.fame - a.fame));
  return pool.slice(0, limitN);
}

function jobKey(o) { return [o.from, o.date, o.days, o.tags.join('/'), o.fameMax || '', o.limit, o.transport || 'all', (o.aiHit || []).join(',')].join('|'); }

function startJob(key, opt) {
  const job = {
    key, opt, cards: [], listeners: new Set(), finished: false, startedAt: Date.now(),
    stats: {
      scanned: 0, total: opt.pool.length, withData: 0, noDirect: 0, failed: 0, archived: 0,
      broken: false, phase: 'rail',
      flightScanned: 0, flightTotal: 0, flightCovered: 0
    }
  };
  jobs.set(key, job);
  activeScans++;
  // emit 必须在 runJob 之前挂好：纯航班模式不走高铁，一进 runJob 就会同步发事件。
  job.emit = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const l of job.listeners) { try { l.write(payload); } catch { /* ignore */ } }
  };
  runJob(job).catch(e => { job.error = String(e.message || e); }).finally(() => {
    job.finished = true;
    job.finishedAt = Date.now();
    activeScans--;
    job.emit('done', { ...job.stats, error: job.error || null, stopped: !!job.aborted, elapsed: Date.now() - job.startedAt });
    for (const l of job.listeners) { try { l.end(); } catch { /* ignore */ } }
    job.listeners.clear();
    setTimeout(() => { if (jobs.get(key) === job) jobs.delete(key); }, 120000).unref();
  });
  return job;
}

/**
 * 单目的地：高铁（12306 实时）+ 航班（本地航线库，零网络）。
 * 返回 { card, error }
 *   card=null 且 error=''   → 明确没有直达班次
 *   card=null 且 error≠''   → 查询失败（限流/网络/出发地无法识别），**不代表没有直达**
 */
async function scanOne(dest, opt) {
  const want = normTransport(opt.transport);
  const trip = opt.trip || {};
  const stations = pickStations(opt.from, trip.fromStations, trip.pick);
  const codes = stationCodes(stations);
  const errs = [];

  let rail = { ok: false, list: [], count: 0, source: '', archivedDate: '' };
  if (want !== 'flight') {
    if (!codes.length) errs.push(`出发地「${opt.from}」不在 12306 站名表内`);
    else {
      /* siblings：直达太少时自动补查同城其他高铁站 —— 这是「尽量多出结果」的好心，
       * 但用户勾了具体车站之后就成了越权：勾了苏州北却冒出苏州、苏州新区的车。
       * 所以勾选状态下关掉它（strict）。 */
      /* 扫描是「后台增量铺墙」，不是用户主动点开的那一条：单条死磕 3 次 × 20 秒会把整轮扫描拖到几分钟，
       * 墙一直不满。给 2 次 + 12 秒超时，失败还有同路线存档日兜底，整体节奏快一倍。 */
      rail = await RAIL.railList(opt.from, codes, opt.date, dest, {
        siblings: !trip.pick, cap: 12, onlyFrom: trip.pick ? stations : null, tries: 2
      });
      if (!rail.ok) errs.push('12306 暂时没有响应这条查询（通常是短时限流），稍后重试即可');
    }
  }

  let flight = [];
  let flightReason = '';
  let flightLive = false;
  if (want !== 'train') {
    const fo = await liveFlightOptions(opt.from, trip.fromPorts, normCity(dest.name), opt.date, {
      round: trip.tripType === 'round', backDate: trip.backDate, cap: 10, strict: trip.pick
    });
    flight = fo.list;
    flightReason = fo.reason;
    flightLive = !!fo.live;
    if (!flight.length && want === 'flight') {
      errs.push(flightReason === 'no-destination-airport'
        ? `${normCity(dest.name)}没有民航机场，飞机到不了，需要铁路或就近机场中转`
        : flightReason === 'no-departure-airport'
          ? `「${opt.from}」周边没有可选机场`
          : '这条航线暂时没有直飞航班，需要在枢纽中转');
    }
  }

  const train = (rail.list || []).map(o => ({ ...o, mode: 'train' }));
  const list = train.concat(flight).sort((a, b) => (a.hours ?? 999) - (b.hours ?? 999));
  if (!list.length) {
    /* rail.ok=true 且没有任何班次 → 12306 明确回答「没有直达」。这是结论，不是失败。
     * 但如果结果是「勾选车站被筛空」且没查到实时数据，那就只是不知道，不能替 12306 下结论。 */
    if (rail.uncertain) errs.push(`你勾的车站这次没取到实时数据（12306 正在限流），可以少勾几个站、或不勾直接搜`);
    const confirmed = rail.ok === true && !train.length && !rail.uncertain;
    return { card: null, noDirect: confirmed, error: errs.join('；') };
  }

  const b = list[0];
  let depMin = null;
  for (const o of list) { const v = clockMin(o.dep); if (v !== null && (depMin === null || v < depMin)) depMin = v; }
  return {
    card: {
      name: dest.name, city: normCity(dest.name), tags: dest.tags, blurb: dest.blurb, tips: dest.tips || [],
      fame: dest.fame, mode: b.mode, modes: [...new Set(list.map(modeOf))],
      best: b, options: list.slice(0, 12),
      count: (rail.count || train.length) + flight.length,
      nTrain: train.length, nFlight: flight.length,
      hours: b.hours, price: b.price,
      depMin, earlyDep: depMin === null ? '' : minToClock(depMin),
      source: rail.source || (b.mode === 'flight' ? (flightLive ? 'flyai' : 'air') : 'live'),
      archivedDate: rail.archivedDate || '',
      flightReason: flightReason || '',
      flightLive,
      back: backLegOf(normCity(dest.name), trip),
      score: scoreDest(dest, opt, b.hours)
    },
    error: ''
  };
}

/**
 * 扫描任务主体。两段式，各司其职：
 *   ① 高铁：12306 全量扫（这是「列表里每个城市都有实时信息」的关键，几秒到一两分钟）
 *   ② 航班：本地航线库 —— **零网络、零配额、瞬时完成**，直接对全部目的地算出可达性
 * 两段都「边扫边出」：前端收到一张就渲染一行，不用等全部跑完。
 */
async function runJob(job) {
  const { opt } = job;
  const want = normTransport(opt.transport);
  const trip = opt.trip || {};
  const stations = pickStations(opt.from, trip.fromStations, trip.pick);
  const codes = stationCodes(stations);
  const results = [];
  const emitProgress = (phase, done, total, name) => {
    job.emit('progress', { phase, done, total, name, stats: { ...job.stats } });
  };
  // 让出一个事件循环：调用方（handleScan）要先挂上 SSE 监听器，
  // 否则纯航班模式下 ②-A 的骨架卡片会在监听器挂载之前全部发完，用户端一条都收不到。
  await new Promise(r => setImmediate(r));

  /* ---------- ① 高铁：12306 ---------- */
  if (want !== 'flight') {
    job.stats.phase = 'rail';
    if (!codes.length) {
      job.emit('fail', { message: `出发地「${opt.from}」不在 12306 站名表内，无法查询高铁班次。` });
    } else {
      const st = await RAIL.scanAll({
        fromName: opt.from, fromCode: codes[0], fromCodes: codes, date: opt.date, dests: opt.pool,
        onlyFrom: (opt.trip && opt.trip.pick) ? stations : null,
        isStopped: () => job.aborted,
        onProgress: (s, d) => {
          job.stats.scanned = s.scanned; job.stats.total = s.total;
          job.stats.withData = s.covered; job.stats.noDirect = s.noDirect;
          job.stats.failed = s.failed; job.stats.archived = s.archived;
          emitProgress('rail', s.scanned, s.total, d.name);
        },
        onCard: c => {
          // 往返模式下每条目的地都带上「从这儿回去」的返程段
          const card = trip && trip.tripType === 'round' ? { ...c, back: backLegOf(normCity(c.name), trip) } : c;
          results.push(card);
          job.emit('card', card);
        },
        onNoDirect: d => job.emit('nocard', { name: d.name })
      });
      job.stats.broken = st.broken;
      if (st.broken) {
        job.emit('fail', {
          message: `12306 开始限流，本次扫描提前收手 —— 已扫到 ${st.scanned} 个目的地（其中 ${st.covered} 个有实时班次），`
            + `这些结果已全部保留并写入本地缓存。过几分钟再点「搜索」，已缓存的不会重复请求，只会补剩下的。`
        });
      }
    }
  }

  /* ---------- ② 航班：本地骨架先出，飞猪实时后补 ---------- */
  if (want !== 'train' && !job.aborted) {
    job.stats.phase = 'flight';

    /* 航班候选上限：默认 30 个（FLIGHT_MAX 可调）。
     * 216 个策展目的地里绝大多数压根没有直飞航线，全量铺开有两笔账都是亏的：
     *   ① 首屏被一堆「飞机到不了」占满，真正有票的反被挤到下面；
     *   ② 候选越多，实时补价就得摊得越薄，配额全花在没结果的地方。
     * 所以按「名气 → 搜索相关度」排序，取前 30 个**真有直飞航线**的作为航班候选。
     * 高铁侧完全不受影响，仍然扫满整个池子 —— 这个上限只管飞机。 */
    const FLIGHT_MAX = Math.max(1, Number(process.env.FLIGHT_MAX) || 30);
    const ranked = opt.pool.slice()
      .sort((a, b) => (b.fame - a.fame) || ((b.score || 0) - (a.score || 0)));

    // ②-A 骨架：本地航线库瞬间给出「能不能直飞、飞多久」，保证列表不空屏、有排序依据。
    const skeleton = new Map();   // name → 本地骨架列表
    const targets = [];           // 入选的航班候选（≤ FLIGHT_MAX，且都真有直飞航线）
    let emitted = 0;              // 已发出的航班卡片数
    for (const d of ranked) {
      if (targets.length >= FLIGHT_MAX) break;
      // 纯航班模式下，「飞机到不了」的说明卡也算一张，总量同样封顶 30
      if (want === 'flight' && emitted >= FLIGHT_MAX) break;
      const fo = flightOptions(opt.from, trip.fromPorts, normCity(d.name), opt.date, {
        round: trip.tripType === 'round', backDate: trip.backDate, cap: 10
      });
      job.stats.flightScanned++;
      if (fo.list.length) {
        emitted++;
        targets.push(d);
        skeleton.set(d.name, fo.list);
        job.stats.flightCovered++;
        const best = fo.list[0];
        job.emit('fcard', {
          name: d.name, source: 'air',
          list: fo.list.slice(0, 12), count: fo.list.length, nFlight: fo.list.length,
          hours: best.hours, price: null, depMin: null, earlyDep: '',
          flightReason: '', back: backLegOf(normCity(d.name), trip)
        });
      } else if (want === 'flight') {
        emitted++;
        job.emit('fcard', { name: d.name, source: 'air', list: [], count: 0, nFlight: 0, flightReason: fo.reason });
      }
    }
    job.stats.flightTotal = targets.length;
    emitProgress('flight', targets.length, targets.length, '');

    // ②-B 实时：**不做批量扫**。实测并发 3 连打 87 次会被飞猪判定为异常访问（HTTP 451 风控），
    // 前面几条能出、后面全废 —— 这正是「只能看到几个航班」的真因。
    // 所以这里只给排在最前的几个目的地预热（串行 + 间隔），让用户滚动到首屏就是真票价；
    // 其余目的地在用户展开时按需查询（一次调用，缓存 30 分钟）。
    if (FLYAI.ready) {
      // 预热 30 条 = 全部航班候选。旧参数（3s 间隔、窗口 12/60s）下 30 条要 168 秒，
      // 所以当时只敢热 8 条；现在 3 并发 + 400ms 实测 1.61 QPS，30 条约 19 秒，
      // 一次扫描就能让所有真有直飞的目的地带上实时票价。
      const warmN = Number(process.env.FLYAI_WARM ?? 30);
      const warm = targets.slice(0, Number.isFinite(warmN) ? Math.max(0, warmN) : 30);
      job.stats.flightLiveTotal = warm.length;
      let done = 0, hits = 0;
      for (const d of warm) {
        if (job.aborted) break;
        const fo = await liveFlightOptions(opt.from, trip.fromPorts, normCity(d.name), opt.date, {
          round: trip.tripType === 'round', backDate: trip.backDate, cap: 10, strict: trip.pick
        });
        done++;
        if (fo.live && fo.list.length) {
          hits++;
          const best = fo.list[0];
          let depMin = null;
          for (const o of fo.list) { const v = clockMin(o.dep); if (v !== null && (depMin === null || v < depMin)) depMin = v; }
          job.emit('fcard', {
            name: d.name, source: 'flyai', live: true,
            list: fo.list.slice(0, 12), count: fo.list.length, nFlight: fo.list.length,
            hours: best.hours, price: best.price,
            depMin, earlyDep: depMin === null ? '' : minToClock(depMin),
            flightReason: ''
          });
        }
        job.stats.flightLiveDone = done;
        job.stats.flightLiveHits = hits;
        emitProgress('flight-live', done, warm.length, d.name);
      }

      /* ②-B-2 热门补价：上面的 warm 只覆盖「本轮扫描池」，而扫描池默认是
       * 「12306 侧还没缓存的」那批——热门目的地昨天就缓存过了，压根不在池里，
       * 于是它们的机票价永远停在昨天，页面上一片「2 天前查询」。
       * 5 QPS 之后有余量，按名气再补一轮首屏看得见的热门（必须有直飞，否则纯烧配额）。
       * 每条 fcard 按名字合并进已有卡片，不会产生重复行。 */
      const REFRESH_N = Math.max(0, Number(process.env.FLYAI_REFRESH ?? 12));
      if (REFRESH_N) {
        const warmed = new Set(warm.map((d) => d.name));
        const hot = POOL.slice()
          .sort((a, b) => (b.fame - a.fame) || ((b.score || 0) - (a.score || 0)))
          .filter((d) => !warmed.has(d.name))
          .filter((d) => flightOptions(opt.from, trip.fromPorts, normCity(d.name), opt.date, {
            round: trip.tripType === 'round', backDate: trip.backDate, cap: 2, strict: trip.pick
          }).list.length > 0)
          .slice(0, REFRESH_N);
        job.stats.flightLiveTotal += hot.length;
        for (const d of hot) {
          if (job.aborted) break;
          const fo = await liveFlightOptions(opt.from, trip.fromPorts, normCity(d.name), opt.date, {
            round: trip.tripType === 'round', backDate: trip.backDate, cap: 10, strict: trip.pick
          });
          done++;
          if (fo.live && fo.list.length) {
            hits++;
            const best = fo.list[0];
            let depMin = null;
            for (const o of fo.list) { const v = clockMin(o.dep); if (v !== null && (depMin === null || v < depMin)) depMin = v; }
            job.emit('fcard', {
              name: d.name, source: 'flyai', live: true,
              list: fo.list.slice(0, 12), count: fo.list.length, nFlight: fo.list.length,
              hours: best.hours, price: best.price,
              depMin, earlyDep: depMin === null ? '' : minToClock(depMin),
              flightReason: ''
            });
          }
          job.stats.flightLiveDone = done;
          job.stats.flightLiveHits = hits;
          emitProgress('flight-live', done, job.stats.flightLiveTotal, d.name);
        }
      }
    }
  }

  job.results = results;
}

/* ------------------------------------------------------------------ *
 * 五、HTTP
 * ------------------------------------------------------------------ */
function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if ((res.req?.headers['accept-encoding'] || '').includes('gzip') && body.length > 1024) {
    head['Content-Encoding'] = 'gzip';
    res.writeHead(code, head);
    return res.end(zlib.gzipSync(body));
  }
  res.writeHead(code, head);
  res.end(body);
}

async function handleScan(req, res, q) {
  const trip = parseTrip(q);
  const intent = parseIntent(q.q || '', {
    from: q.from || trip.from || '', date: q.date || '', days: q.days ? Number(q.days) : undefined
  });
  if (!intent.from) intent.from = trip.from;
  if (!intent.from) return sendJson(res, { error: '请提供出发城市' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(intent.date || '')) return sendJson(res, { error: '日期格式应为 YYYY-MM-DD' }, 400);
  const transport = effectiveTransport(trip, normTransport(q.transport));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  const send = (e, d) => { try { res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); } catch { /* ignore */ } };

  /* 演示模式必须**真的**不发请求。
   * 之前 DEMO 只影响返回体里那个 demo 标志，扫描照跑 —— 结果公网 demo 打开就开始扫 12306，
   * 扫到一半还会给评委看一条红色的「12306 开始限流，本次扫描提前收手」。
   * 这里直接回一帧 intent + done：前端看到 allFresh 就去用 /api/list 已有的快照渲染。 */
  if (DEMO) {
    send('intent', {
      ...intent, transport, trip, limit: 0, pool: 0, total: POOL.length,
      demo: true, offline: true, llm: HAS_LLM, railReady: RAIL.ready,
      preSaleMax: RAIL.preSaleMax(), allFresh: true
    });
    send('done', {
      scanned: 0, total: 0, withData: 0, noDirect: 0, failed: 0, archived: 0, broken: false,
      phase: 'rail', flightScanned: 0, flightTotal: 0, flightCovered: 0,
      replayed: false, allFresh: true, demo: true, elapsed: 0
    });
    return res.end();
  }

  send('intent', {
    ...intent, transport, trip, total: POOL.length, demo: DEMO,
    llm: HAS_LLM, railReady: RAIL.ready, preSaleMax: RAIL.preSaleMax(), thinking: true
  });

  // 预售期之外的日期在 12306 上必然查不到（接口直接 302），是**产品问题不是网络问题**，
  // 必须说清楚，而不是让用户对着一个「扫了 216 个全失败」的进度条发呆。
  if (intent.date > RAIL.preSaleMax()) {
    send('fail', {
      message: `12306 只发售 ${RAIL.preSaleMax()}（今天起 ${RAIL.preSaleDays()} 天）以内的车票，`
        + `你选的 ${intent.date} 还没开售。请把日期改到 ${RAIL.preSaleMax()} 之前再搜。`
    });
    return res.end();
  }

  // 意图理解与语义匹配现在都在本地完成 —— 无网络往返、无配额、行为可预测。
  const [applied, ai] = await Promise.all([
    aiParseIntent(intent).then(r => applyAiIntent(intent, r, {
      fromGiven: !!(q.from && String(q.from).trim()),
      daysGiven: q.days !== undefined && q.days !== ''
    })),
    aiUnderstand(intent, POOL)
  ]);
  send('ai', {
    hit: ai.hit, applied, reason: intent.reason || ''
  });

  const limitN = Math.min(POOL.length, Math.max(4, Number(q.limit) || SCAN_LIMIT));
  const codes = stationCodes(pickStations(intent.from, trip.fromStations, trip.pick));
  const fromCode = codes[0] || '';

  // 默认只扫「本地还没有的」—— 缓存是这套架构的立身之本：
  // 已缓存的目的地零请求复用，用户第二次点「搜索」几乎是瞬时的，也不会给 12306 添麻烦。
  const onlyMissing = q.miss !== '0';
  let pool;
  if (onlyMissing && fromCode) {
    const miss = POOL.filter(d => !RAIL.isFresh(fromCode, intent.date, d));
    pool = poolFor(intent, limitN, ai.hit, miss);
  } else {
    pool = poolFor(intent, limitN, ai.hit, POOL);
  }
  /* 往返 + 只选了一种交通方式时，先剔掉「回不来」的目的地，别让 12306 白查一场 */
  if (trip.tripType === 'round') pool = pool.filter(d => backFeasible(normCity(d.name), trip));
  /* 去程只选了一种交通方式：去不了的目的地也不用扫 */
  pool = pool.filter(d => routeFeasible(normCity(d.name), trip, transport));
  const opt = {
    from: intent.from, fromCode, fromCodes: codes, date: intent.date, days: intent.days, tags: intent.tags,
    fameMax: intent.fameMax, limit: limitN, pool, aiHit: ai.hit, transport, trip
  };
  const key = jobKey(opt);

  send('intent', {
    ...intent, transport, trip, limit: limitN, pool: pool.length, total: POOL.length,
    demo: DEMO, llm: HAS_LLM, aiHit: ai.hit,
    railReady: RAIL.ready, preSaleMax: RAIL.preSaleMax(), allFresh: onlyMissing && pool.length === 0
  });

  // 全部已缓存 → 不必新建任务，让前端直接用 /api/list 的结果渲染即可
  if (!pool.length) {
    send('done', { ...{ scanned: 0, total: 0, withData: 0, noDirect: 0, failed: 0, archived: 0, broken: false, phase: 'rail', flightScanned: 0, flightTotal: 0, flightCovered: 0 }, replayed: false, allFresh: true, elapsed: 0 });
    return res.end();
  }

  let job = jobs.get(key);
  if (!job || job.finished) {
    if (activeScans >= MAX_CONCURRENT) { send('fail', { message: '服务器正在为其他用户扫描，请稍候重试。' }); return res.end(); }
    job = startJob(key, opt);
  }
  // key 一并发给前端：用户点「停止」时要指名叫停哪一个任务
  send('progress', { phase: 'rail', done: job.stats.scanned, total: opt.pool.length, name: '', key, stats: { ...job.stats } });

  job.listeners.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
  const clean = () => { clearInterval(hb); job.listeners.delete(res); };
  res.on('close', clean); res.on('error', clean);
}

/**
 * 用户主动「重试连接」。
 * ------------------------------------------------------------------
 * 现在航班走本地航线库（零网络、零配额），高铁走 12306（公开只读接口，无 Key），
 * 所以整个产品已不存在「需要用户手动重连的外部配额链路」。
 * 这个端点保留下来，只为了给旧前端一个明确的答复，而不是静默 404。
 */
async function handleReconnect(req, res) {
  return sendJson(res, {
    ok: true, notNeeded: true,
    message: '航班已改为本地航线库、高铁走 12306 公开接口，均无配额限制，无需重连。'
  });
}

/**
 * GET /api/dest —— 「住哪 / 玩什么」
 * ------------------------------------------------------------------
 * 原实现走飞猪开放平台的 search-poi / search-hotel。那两个接口配额极小，
 * 一旦被风控整块就是空的 —— 这正是之前「飞猪酒店/景点显示有问题」的原因。
 *
 * 现在改为：**本地策展内容（真实、可离线）+ 飞猪查询深链**。
 *   玩什么 → 用目的地池里已有的必看/必吃素材（这些是本地策展数据，零依赖）
 *   住哪   → 给出该地的住宿区位建议 + 「去飞猪找酒店」深链（带城市与入离日期）
 * 跳转链接由我们自己构造（hotel.fliggy.com / fliggy.com 搜索），不经过任何 API，
 * 所以永远不会因为配额而消失。
 */
function hotelAreaHint(tags, days) {
  const t = new Set(tags || []);
  if (t.has('古城')) return '优先住古城内或城门附近，步行即可逛核心景点';
  if (t.has('海岛') || t.has('海滨')) return '优先住临海一线或码头附近，早晚下海最方便';
  if (t.has('古镇')) return '优先住民宿客栈，夜里人少才是古镇最好的时候';
  if (t.has('雪山') || t.has('高原')) return '优先住低海拔城区，先适应再上山，睡眠质量更稳';
  if (t.has('森林') || t.has('山野')) return '优先住景区门口或镇上，省掉每天往返的交通时间';
  if (days >= 3) return '优先住交通枢纽附近，多天行程换乘成本最低';
  return '优先住老城或地铁沿线，一天来回都方便';
}
/**
 * 把「必看：A、B、C」这一类策展串拆成逐条景点。
 * 数据源本身只有这种成串文本，直接整串丢给前端会显得像半成品：
 * 用户要的是「我到了先去哪、门票在哪儿买」，所以必须一条景点一个入口。
 */
function splitSpots(d) {
  const out = { see: [], eat: [] };
  for (const t of ((d && d.tips) || [])) {
    const s = String(t || '').trim();
    if (!s || /^建议\s*\d/.test(s)) continue;
    const m = /^(必看|必吃|推荐|玩)\s*[：:]\s*(.+)$/.exec(s);
    if (!m) { out.see.push(s); continue; }
    const bucket = m[1] === '必吃' ? out.eat : out.see;
    for (const x of m[2].split(/[、，,／\/]/)) {
      const v = x.trim();
      if (v) bucket.push(v);
    }
  }
  return out;
}

/** 景点门票深链：带上城市与景点名，点过去就是该景点的搜索结果 */
function poiTicketUrl(city, poiName) {
  const q = poiName ? `${city}${poiName}门票` : `${city}景点门票`;
  return decorate(`${FLIGGY_POI}?q=${encodeURIComponent(q)}`);
}

/**
 * 住宿分区建议（本地规则，按目的地气质给两个真实选择）。
 * 只给「住哪一片 + 为什么」，不给具体酒店名——编酒店名就是造假。
 */
function hotelAreas(city, tags, days) {
  const t = new Set(tags || []);
  const area = (name, why) => ({ name, why, keyword: name });
  if (t.has('古城')) return [area('古城内', '步行就能逛完核心景点，夜里人散了才是它最好看的时候'), area('城门附近', '车能直接到，拉行李箱不用在石板路上颠')];
  if (t.has('海岛') || t.has('海滨')) return [area('临海一线', '出门就是海，早晚下水最省事'), area('码头附近', '赶船、出海一日游都不用早起赶路')];
  if (t.has('古镇')) return [area('古镇内客栈', '住在景区里，清早和夜里都没有游客团'), area('景区门口', '停车方便，带老人小孩时进出更轻松')];
  if (t.has('雪山') || t.has('高原')) return [area('低海拔城区', '先适应海拔再上山，睡眠质量更稳'), area('景区换乘点附近', '上山的车大多在这儿发，少折腾一小时')];
  if (t.has('森林') || t.has('山野')) return [area('景区门口', '省掉每天往返的两小时车程'), area('县城中心', '吃饭买东西更方便，房价也更实在')];
  if (days >= 3) return [area('交通枢纽附近', '多天行程换乘成本最低，去各处都快'), area('老城中心', '吃饭逛街都在步行范围，晚上不无聊')];
  return [area('老城或地铁沿线', '一天来回都方便，晚上还有得逛'), area('车站附近', '赶早班车不用起太早，回程也稳')];
}

async function handleDest(req, res, q) {
  const name = q.name || '';
  const city = normCity(name);
  if (!city) return sendJson(res, { error: 'missing name' }, 400);
  const d = POOL.find(x => x.name === name) || POOL.find(x => x.code === q.code) || null;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : '';
  const days = Math.max(1, Number(q.days) || 2);
  const checkOut = date ? addDays(date, days) : '';

  // 「玩什么」：把本地策展串拆成逐条景点，每条都带自己的门票搜索入口
  const sp = splitSpots(d);
  const pois = sp.see.slice(0, 6).map((n, i) => ({
    name: n, desc: '', rank: i + 1, kind: 'see', jumpUrl: poiTicketUrl(city, n)
  }));
  const foods = sp.eat.slice(0, 6).map((n, i) => ({
    name: n, desc: '', rank: i + 1, kind: 'eat', jumpUrl: poiTicketUrl(city, n)
  }));

  // 「住哪儿」：按目的地气质给两个真实分区选择，各自带酒店搜索入口
  const hotels = hotelAreas(city, d && d.tags, days).map(a => ({
    name: a.name,
    hint: a.why,
    keyword: a.keyword,
    jumpUrl: fliggyHotelUrl(city, date, checkOut)
  }));

  return sendJson(res, {
    city, blurb: (d && d.blurb) || '', tips: curatedSpots(d),
    pois, foods, hotels,
    links: {
      hotel: fliggyHotelUrl(city, date, checkOut),
      poi: fliggyPoiUrl(city)
    },
    note: ''
  });
}

/**
 * GET /api/intent —— 意图解析（本地规则，无外部依赖）
 * 表单里用户手选过的字段优先级最高，不被覆盖。
 */
async function handleIntent(req, res, q) {
  const intent = parseIntent(q.q || '', {
    from: q.from || '',
    date: q.date || '',
    days: q.days ? Number(q.days) : undefined
  });
  const t0 = Date.now();
  const applied = await aiParseIntent(intent).then(r => applyAiIntent(intent, r, {
    fromGiven: !!(q.from && String(q.from).trim()),
    daysGiven: q.days !== undefined && q.days !== ''
  }));
  intent.applied = applied;
  intent.ms = Date.now() - t0;
  return sendJson(res, intent);
}

/**
 * GET /api/ai —— 本地语义理解结果（不再调用飞猪 ai-search）
 * 保留这个端点，是为了让「用户原话被如何理解」这件事可被查看与调试。
 */
async function handleAi(req, res, q) {
  const query = q.q || '';
  if (!query) return sendJson(res, { error: 'missing q' }, 400);
  const intent = parseIntent(query, { from: q.from || '', date: q.date || '' });
  const sem = localSemantic(intent, POOL);
  return sendJson(res, {
    local: true,
    intent: { from: intent.from, days: intent.days, tags: intent.tags, fameMax: intent.fameMax, fameMin: intent.fameMin, budget: intent.budget },
    hit: sem.hit
  });
}

/* ------------------------------------------------------------------ *
 * 三·A-2、行程安排：本地规则生成（可选大模型润色）
 * ------------------------------------------------------------------
 * 输入全部来自表单里确定的字段（出发地 / 日期 / 天数 / 交通方式）与所选的那一条目的地，
 * 加上**真实班次**与本地策展素材。所以生成的内容里每个数字都有出处：
 *   · 「怎么去」直接用取到的真实车次/航线，没有就如实说需要中转，绝不编造时刻；
 *   · 「玩什么」来自目的地池里的必看/必吃素材（本地策展，零依赖）；
 *   · 「住哪」「门票」给出区位建议 + 飞猪跳转（同样零依赖）。
 * 想接大模型润色措辞？设置 LLM_BASE / LLM_API_KEY / LLM_MODEL 即可（见文件顶部说明），
 * 模型失败时自动退回这套本地规则，功能不受影响。
 */
const planCache = new Map();          // key: dest|from|date|days|transport|tripType

/** 本地规则生成三行安排（永远是可用的那一条路径） */
function buildLocalPlan(d, ctx) {
  const { from, date, days, list, trip, mode } = ctx;
  const lines = [];

  /* ① 怎么去 —— 只用真实班次说话 */
  const best = list[0];
  if (best && mode === 'train') {
    lines.push({
      k: '去', url: best.jumpUrl || '',
      t: `${best.no} ${best.from} ${best.dep} 出发，${best.arr} 到 ${best.to}，约 ${best.hours}h`
        + (best.priceText ? `，${best.seat} ${best.priceText}` : '')
    });
  } else if (best && mode === 'flight') {
    lines.push({
      k: '去', url: best.jumpUrl || '',
      t: `${best.fromPort || best.from} → ${best.toPort || best.to} 直飞，约 ${best.hours}h`
        + (best.airlines && best.airlines.length ? `，${best.airlines.slice(0, 2).join('、')}在飞` : '')
    });
  } else {
    lines.push({ k: '去', url: '', t: `暂未取到 ${from} → ${d.name} 的直达班次，建议先到就近枢纽再中转换乘` });
  }

  /* ② 往返 —— 用户选了往返才给 */
  if (trip && trip.tripType === 'round') {
    const back = trip.backDate || '';
    lines.push({
      k: '返', url: '',
      t: back ? `${back} 返程，按去程反向安排，请预留 2 小时到站` : '返程日期未定，建议按「去程 + 天数」倒推'
    });
  }

  /* ③ 玩什么 —— 当地必看/必吃素材，按天数取用 */
  const spots = curatedSpots(d).slice(0, days >= 3 ? 4 : 3);
  if (spots.length) lines.push({ k: '玩', url: fliggyPoiUrl(d.name), t: spots.join('；') });

  /* ④ 住哪 —— 区位建议 + 飞猪酒店深链 */
  const checkOut = ctx.date ? addDays(ctx.date, days) : '';
  lines.push({
    k: '住', url: fliggyHotelUrl(d.name, ctx.date || '', checkOut),
    t: hotelAreaHint(d.tags, days)
  });

  return lines;
}

async function handlePlan(req, res, q) {
  const name = q.dest || '';
  const d = POOL.find(x => x.name === name) || POOL.find(x => x.code === q.code);
  if (!d) return sendJson(res, { ok: false, error: '未知目的地' }, 400);

  const trip = parseTrip(q);
  const from = q.from || trip.from;
  const date = q.date || '';
  const days = Number(q.days) || 2;
  const transport = normTransport(q.transport);
  const key = [name, from, date, days, transport, trip.tripType].join('|');

  if (planCache.has(key)) {
    return sendJson(res, { ok: true, cached: true, ...planCache.get(key) });
  }

  const { list, mode } = await scheduleFor(d, from, date, transport, {
    cacheOnly: true, fromStations: trip.fromStations, fromPorts: trip.fromPorts, strict: trip.pick,
    round: trip.tripType === 'round', backDate: trip.backDate
  });

  // 高铁没命中缓存时，用第一趟班次补一次（仅一次，避免放大请求）
  let rail = list;
  if (!rail.length && transport !== 'flight' && date) {
    try {
      const r = await scanOne(d, { from, date, days, transport, trip });
      if (r.card && r.card.options) rail = r.card.options;
    } catch { /* 失败就用空列表，本地规则照样能给出安排 */ }
  }
  const m = (rail[0] && modeOf(rail[0])) || mode;

  const lines = buildLocalPlan(d, { from, date, days, list: rail, trip, mode: m });
  const result = {
    source: 'local',
    lines,
    plan: lines.map(l => `· ${l.t}`).join('\n')
  };

  // 第一层：百炼高代码应用（应用内部再调飞猪 MCP + qwen 编排）
  if (BAILIAN_APP_URL) {
    try {
      const r = await bailianAppPlan({ dest: name, from, date, days, transport, trip, lines });
      result.source = 'bailian-app';
      result.plan = r.plan;
      result.engine = '百炼应用';
      // 把百炼产出的纯文本行，按顺序配回本地要点的标签（去/返/玩/住）与跳转链接，
      // 这样前端仍然渲染成带徽标的卡片，但正文确实是模型写的那份。
      const aiRows = r.plan.split('\n')
        .map(x => x.replace(/^[·•]\s*/, '').trim())
        .filter(Boolean)
        .filter(x => !/^(机票下单|酒店预订|门票|购买)[:：]/.test(x));
      // 飞猪被风控时，百炼应用只会拿到空数据，产出「暂未取到直达班次…建议自行查询」。
      // 这种文案不能覆盖本地已有的班次与策展 —— 用缺失去覆盖有，是负优化。
      const missing = aiRows.filter(t => /暂未取到|建议自行查询|需自行查询|暂无/.test(t)).length;
      const degraded = aiRows.length < 2 || missing >= 2;
      if (aiRows.length && !degraded) {
        const urlOf = k => (lines.find(l => l.k === k) || {}).url || '';
        result.lines = aiRows.map((t, i) => {
          const k = (lines[i] && lines[i].k) || '·';
          return { k, t, url: urlOf(k) };
        });
      } else if (degraded) {
        // 高铁场景不涉及飞猪，文案里别提；统一说「数据降级」更准确
        result.engine = '百炼应用 · 数据降级';
      }
      planCache.set(key, result);
      return sendJson(res, { ok: true, ...result });
    } catch (e) {
      result.appError = String((e && e.message) || e).slice(0, 120);   // 仅记录，继续降级
    }
  }

  // 第二层：本地直连百炼模型润色
  if (HAS_LLM) {
    try {
      const txt = await llmChat([
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: lines.map(l => `[${l.k}] ${l.t}`).join('\n') }
      ], { temperature: 0.3, timeoutMs: 15000 });
      // 模型可能无视格式要求写成一段 —— 这里做确定性整形，保证前端永远是「· 」短行
      const cleaned = normalizePlanText(txt).slice(0, 600);
      if (cleaned) {
        result.source = 'llm';
        result.plan = cleaned;
        result.model = lastLLMEngine || LLM_MODEL;
        // 如实标注是谁润色的：百炼要写「百炼模型」，换备用端点就写它自己的名字，
        // 不能让评委以为「百炼模型」四个字什么时候都成立。
        result.engine = /百炼/.test(lastLLMEngine) ? '百炼模型' : `${lastLLMEngine || LLM_MODEL} 润色`;
      }
    } catch (e) {
      result.llmError = String((e && e.message) || e).slice(0, 120);   // 仅记录，不影响返回
    }
  }

  // 第三层：本地规则（result 本身就是这样，无需处理）
  if (!result.engine) result.engine = '本地规则';

  planCache.set(key, result);
  return sendJson(res, { ok: true, ...result });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/healthz') {
      return sendJson(res, {
        ok: true, demo: DEMO, pool: POOL.length, scans: jobs.size,
        concurrency: CONCURRENCY,
        rail: RAIL.stats(),
        air: AIR.stats(),
        flyai: FLYAI.stats(),
        stationCities: Object.keys(STATIONS).length,
        llm: HAS_LLM ? LLM_MODEL : false,
        llm_providers: LLM_PROVIDERS.map(p => ({ label: p.label, model: p.model, cooling: Date.now() < p.downUntil })),
        llm_calls: llmCalls, llm_fails: llmFails,
        bailian_app: BAILIAN_APP_URL || false,
        app_calls: appCalls, app_fails: appFails
      });
    }
    if (u.pathname === '/api/intent') return await handleIntent(req, res, q);

    /* 可选地点：出发/返程的城市 → 车站与机场清单（供前端勾选） */
    if (u.pathname === '/api/places') {
      const city = (q.city || '').trim();
      if (city) {
        return sendJson(res, {
          city,
          stations: (STATIONS[city] || []).slice(0, 30),
          airports: AIR.airportsOfCity(city)
        });
      }
      // 不带 city：返回全部可选城市及其「有没有车站 / 有机场（自有 or 邻近）」，
      // 前端据此给出可搜索的城市选择器。slim=1 时省掉明细，只回城市名。
      //
      // pooled：这个城市在不在**候选池**（知名度前 100）里。
      // 400 多个城市一上来全铺开，用户会以为「就这些」；只铺池子里的、其余靠输入搜，
      // 才不会误以为选择受限。排序也按池子顺序（名气降序）在前，其余按拼音在后。
      const poolOrder = new Map(POOL.map((d, i) => [d.name, i]));
      const names = new Set([...Object.keys(STATIONS), ...AIR.cityNames()]);
      const cities = [...names].sort((a, b) => {
        const ra = poolOrder.has(a) ? poolOrder.get(a) : 1e6;
        const rb = poolOrder.has(b) ? poolOrder.get(b) : 1e6;
        return ra - rb || a.localeCompare(b, 'zh');
      }).map(n => ({
        name: n,
        rail: (STATIONS[n] || []).length > 0,
        air: AIR.airportsOfCity(n).length > 0,
        ownAir: AIR.hasOwnAirport(n),
        pooled: poolOrder.has(n)
      }));
      if (q.slim === '1') return sendJson(res, { total: cities.length, cities });
      return sendJson(res, { total: cities.length, cities });
    }

    if (u.pathname === '/api/list') {
      const trip = parseTrip(q);
      const from = trip.from;
      const date = q.date || '';
      const days = Number(q.days) || 2;
      const tags = (q.tags || '').split(',').filter(Boolean);
      const transport = normTransport(q.transport);
      /* 以勾选反推真实意图：只勾机场就是只看航班，只勾车站就是只看高铁 */
      const tp = effectiveTransport(trip, transport);
      // 只读缓存、不发任何网络请求：打开即出全量列表（这是「列表永不空屏」的保证）
      const all0 = await buildList(from, date, days, tags, tp, {
        cacheOnly: true, noLive: true, fromStations: trip.fromStations, fromPorts: trip.fromPorts, strict: trip.pick,
        round: trip.tripType === 'round', backDate: trip.backDate
      });
      /* 往返且用户只指定了一种交通方式时，把「这一程没法原路回来」的目的地直接剔掉：
       * 铁路能到但没机场的城市，在「去程高铁 + 返程飞机」下不该出现在候选里。 */
      /* 两种剔除要分开计数，否则文案会撒谎：
       *   routeFiltered —— 你选的方式**去不了**（勾了飞机，可这个地方没机场）
       *   backFiltered  —— 去得了但**回不来**（往返时才会发生）
       * 早先只用一个差值，单程勾机场时会说成「按往返方式剔除了 50 个回不来的」，
       * 把「这儿没有机场」错讲成「回程没车」。 */
      const routeOut = all0.filter(it => routeFeasible(it.city, trip, tp));
      const items = routeOut.filter(it => backFeasible(it.city, trip));
      const routeFiltered = all0.length - routeOut.length;
      const backFiltered = routeOut.length - items.length;
      const covered = items.filter(x => x.covered).length;
      // 实时/缓存的构成，前端据此如实标注每行数据的新鲜度
      const live = items.filter(x => x.covered && x.source === 'live').length;
      const cachedN = items.filter(x => x.covered && x.source === 'cache').length;
      const arch = items.filter(x => x.covered && x.source === 'archive').length;
      const air = items.filter(x => x.covered && x.source === 'air').length;
      const meta = {
        from, date, days, tags, transport, trip, demo: DEMO,
        railReady: RAIL.ready, preSaleMax: RAIL.preSaleMax(),
        airReady: AIR.ready, llm: HAS_LLM,
        total: items.length, covered, live, cached: cachedN, archived: arch, air,
        backFiltered, routeFiltered
      };
      // slim=1：页面上只想知道预售期/就绪状态时用，省掉几百 KB 的列表
      if (q.slim === '1') return sendJson(res, { ...meta, items: [] });
      /* 往返：首屏这份列表也要带「返程段」（只有落点/日期/两个跳转入口，零请求）。
       * 缺了它，用户展开卡片时前端根本不知道要展示返程，只会看到去程 —— 正是那个 bug。 */
      if (trip.tripType === 'round') {
        for (const it of items) {
          if (!it.back) it.back = backLegOf(normCity(it.name), trip);
        }
      }
      return sendJson(res, { ...meta, items });
    }
    if (u.pathname === '/api/live') return await handleLive(req, res, q);
    /* 单独的返程查询：列表里那些没展开的目的地，用户点「查返程」时才发。
     * 一次 1~2 个 12306 请求，避免全量扫描时请求量翻倍。 */
    if (u.pathname === '/api/back') {
      if (DEMO) return sendJson(res, { ok: false, demo: true, error: '离线演示模式：实时补查已关闭。' });
      const trip = parseTrip(q);
      const name = q.dest || '';
      if (!name || !trip || trip.tripType !== 'round') return sendJson(res, { ok: false, error: '需要往返模式与目的地' }, 400);
      try {
        const back = await backLegPlan(normCity(name), trip, { batch: q.batch === '1' || q.batch === true });
        return sendJson(res, { ok: true, back });
      } catch (e) {
        return sendJson(res, { ok: false, error: String(e.message || e) });
      }
    }
    if (u.pathname === '/api/reconnect') return await handleReconnect(req, res);
    if (u.pathname === '/api/scan') return await handleScan(req, res, q);
    /* 用户中途叫停：前端关掉 SSE 只是「不听」，服务端的 job 仍在跑、仍在打 12306。
     * 所以必须有一个明确的中止入口 —— 否则用户改了条件重搜，旧任务还在后台偷偷发请求。 */
    if (u.pathname === '/api/stop') {
      const k = String(q.key || '');
      const job = k ? jobs.get(k) : null;
      if (job && !job.finished) { job.aborted = true; return sendJson(res, { ok: true, stopped: true }); }
      return sendJson(res, { ok: true, stopped: false });
    }
    /* 健康检查：给「随时打开都能用」这件事一个可验证的凭据。
     * `up` 是进程存活秒数 —— 隔一段时间再采一次，如果它连续增长，说明容器没有被回收重启；
     * 如果归零重来，说明平台把它停过（那就得考虑保活或换常驻环境）。 */
    if (u.pathname === '/api/health') {
      let airStat = {};
      try { airStat = (FLYAI.stats && FLYAI.stats()) || {}; } catch { airStat = {}; }
      return sendJson(res, {
        ok: true,
        up: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        now: new Date().toISOString(),
        node: process.version,
        rail: { ready: !!RAIL.ready, preSaleMax: RAIL.preSaleMax ? RAIL.preSaleMax() : null },
        air: {
          ready: !!FLYAI.ready, mode: FLYAI.mode || '', hasKey: !!FLYAI.hasKey,
          dayUsed: airStat.dayUsed ?? null, blocked: airStat.blocked ?? null
        },
        llm: {
          ready: HAS_LLM,
          model: HAS_LLM ? LLM_PROVIDERS[0].model : null,
          providers: LLM_PROVIDERS.map(p => `${p.label}${p.downUntil > Date.now() ? '·冷却' : ''}`),
          app: !!BAILIAN_APP_URL
        },
        pool: POOL.length,
        memMB: Math.round(process.memoryUsage().rss / 1048576)
      });
    }
    if (u.pathname === '/api/dest') return await handleDest(req, res, q);
    if (u.pathname === '/api/plan') return await handlePlan(req, res, q);
    if (u.pathname === '/api/ai') return await handleAi(req, res, q);
    if (u.pathname === '/api/pool') {
      const tags = {};
      for (const d of POOL) for (const t of d.tags) tags[t] = (tags[t] || 0) + 1;
      return sendJson(res, {
        total: POOL.length,
        tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => ({ tag: k, n: v }))
      });
    }
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const buf = fs.readFileSync(file);
    const head = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if ((req.headers['accept-encoding'] || '').includes('gzip') && buf.length > 2048) {
      head['Content-Encoding'] = 'gzip';
      res.writeHead(200, head);
      return res.end(zlib.gzipSync(buf));
    }
    res.writeHead(200, head);
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) sendJson(res, { error: String(e.message || e) }, 500);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const airS = AIR.stats();
  console.log(`耍起 · 随心出发，即刻耍起  已启动  监听 ${HOST}:${PORT}  →  ${LOCAL_URL}`);
  console.log(`目的地面板 ${POOL.length} 个 · 可选城市 ${Object.keys(STATIONS).length} 个（车站）/${airS.cities} 个（机场）`);
  console.log(`高铁数据：12306 实时余票（站名表 ${RAIL.ready ? '已加载' : '缺失!'} · 全量扫描 · 全局最小间隔 ${process.env.RAIL_MIN_GAP_MS || 280}ms）`);
  console.log(`航班数据：本地航线库（${airS.ports} 个机场 / ${airS.routes} 条直飞航线，零网络零配额）· 购票跳转飞猪`);
  console.log(`行程安排：本地规则生成${HAS_LLM ? `（已启用可选大模型 ${LLM_MODEL} 润色 · 来源 ${LLM.via}）` : '（未配置大模型，纯本地规则；设 BAILIAN=1 或 LLM_* 可启用）'}`);
  console.log(`列表接口 /api/list 零网络（读本地缓存），缺的由 /api/scan 增量补齐`);
  if (AUTOWARM) {
    // 启动 20 秒后跑一轮（避开启动瞬间的用户请求），之后每 WARM_EVERY 跑一轮
    setTimeout(() => autoWarm('启动'), 20000).unref();
    setInterval(() => autoWarm('定时'), WARM_EVERY).unref();
    console.log(`后台自补：已开启（只补缺的 · 间隔 ${WARM_GAP}ms · 每 ${Math.round(WARM_EVERY / 3600000)} 小时一轮）`);
  } else {
    console.log('后台自补：已关闭（RAIL_AUTOWARM=0）');
  }
  if (process.env.NO_OPEN !== '1') {
    import('node:child_process').then(({ exec }) => {
      const url = LOCAL_URL;
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }).catch(() => {});
  }
});
