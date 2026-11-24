/*
 * 航班层 · 本地航线库（零网络 / 零 API Key / 永不失败）
 * ------------------------------------------------------------------
 * 为什么不再走飞猪 API：
 *   飞猪开放平台的 search-flight 有硬配额（实测约 20~24 次/60s 即触发风控），
 *   而本产品的核心动作是「一次列出 200+ 个目的地的可达性」——用量与它的配额模型根本冲突。
 *   结果就是航班列只能看到寥寥几条，且随时可能整块不可用。
 *
 * 本模块改用**静态真实航线网络**回答用户真正关心的问题：
 *   · 从我这几个机场，能不能直飞那里？      → 能 / 不能
 *   · 谁在飞？                              → 承运航司
 *   · 要飞多久、多远？                      → 时长（分钟）/ 航距（km）
 * 数据：Jonty/airline-route-data（周更）+ FlyClaw airports.json（机场中文名）。
 * 价格与实时班次由飞猪 H5 承接 —— 一键跳转过去查真实票价。所以：
 *   本地库负责「可达性与航线事实」（这是它擅长的、也最稳定的部分），
 *   飞猪负责「实时价格与下单」（这是它擅长的部分）。
 * 两者分工，任何一方不可用都不会让整个功能失效。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 地区标注：air.json 生成时已把港澳台规整为「中国香港 / 中国澳门 / 中国台湾」，
   这里只做透传并兜底，确保不会以独立国家形态出现。 */
const CN_REGION = { '香港': '中国香港', '澳门': '中国澳门', '台湾': '中国台湾' };

export function createAir({ dataDir } = {}) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'air.json'), 'utf8')); } catch { raw = {}; }
  const ports = raw.ports || {};     // IATA -> { iata, cn, city, city_en, region, lat, lon }
  const cities = raw.cities || {};   // 城市名 -> { own: [IATA], near: [{ iata, city, km }] }
  const routes = raw.routes || {};   // 出发 IATA -> [{ to, km, min, by: [航司] }]
  const ready = Object.keys(ports).length > 100;

  const portOf = i => ports[i] || null;
  const regionOf = i => {
    const p = ports[i];
    if (!p) return '';
    return CN_REGION[p.region] || p.region || '';
  };

  /** 城市可选机场：自有（own）在前，邻近（near，带 km）在后 */
  function airportsOfCity(city) {
    const e = cities[city];
    if (!e) return [];
    const out = [];
    const seen = new Set();
    for (const i of (e.own || [])) {
      const p = ports[i];
      if (!p || seen.has(i)) continue;
      seen.add(i);
      out.push({ iata: i, cn: p.cn, city: p.city, region: regionOf(i), own: true, km: 0 });
    }
    for (const n of (e.near || [])) {
      const p = ports[n.iata];
      if (!p || seen.has(n.iata)) continue;
      seen.add(n.iata);
      out.push({ iata: n.iata, cn: p.cn, city: p.city, region: regionOf(n.iata), own: false, km: n.km || 0 });
    }
    return out;
  }

  /** 城市「自己」的机场 —— 判断「这里有民航机场吗」用这个，不含邻近 */
  const ownPorts = city => ((cities[city] || {}).own || []).slice();
  const nearPorts = city => ((cities[city] || {}).near || []).map(x => x.iata);
  const hasOwnAirport = city => ownPorts(city).length > 0;

  /**
   * 从 fromIatas（出发城市勾选的机场）飞往 destCity 的直飞航线。
   * 目的地机场优先用「自有」，无自有则回退「邻近」（例如飞苏州 = 飞无锡/上海）。
   * 返回按飞行时长升序、同一 from→to 去重。
   */
  function directRoutes(fromIatas, destCity, o = {}) {
    const destList = (o.destIatas && o.destIatas.length)
      ? o.destIatas
      : (ownPorts(destCity).length ? ownPorts(destCity) : nearPorts(destCity));
    if (!destList.length) return [];
    const ds = new Set(destList);
    const seen = new Set();
    const out = [];
    for (const f of (fromIatas || [])) {
      for (const r of (routes[f] || [])) {
        if (!ds.has(r.to)) continue;
        const k = f + '|' + r.to;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ from: f, to: r.to, km: r.km || 0, min: r.min || 0, by: r.by || [] });
      }
    }
    return out.sort((a, b) => (a.min || 9999) - (b.min || 9999) || a.km - b.km);
  }

  /** 机场信息批量查询（供前端展示「无锡硕放国际机场」这种全称） */
  function info(iatas) {
    const out = {};
    for (const i of (iatas || [])) { const p = ports[i]; if (p) out[i] = { iata: i, cn: p.cn, city: p.city, region: regionOf(i) }; }
    return out;
  }

  /** 有民航可达性的全部城市名（含只有邻近机场的，如苏州） */
  const cityNames = () => Object.keys(cities);

  function stats() {
    let n = 0;
    for (const k in routes) n += (routes[k] || []).length;
    return { ready, ports: Object.keys(ports).length, cities: Object.keys(cities).length, routes: n };
  }

  return { ready, portOf, regionOf, airportsOfCity, ownPorts, nearPorts, hasOwnAirport, directRoutes, info, cityNames, stats };
}
