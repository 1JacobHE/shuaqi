/**
 * 航班票价预热 —— 把常用航线的**真实票价**温和地灌进 data/flight-cache.json
 * ---------------------------------------------------------------------------
 * 为什么需要它：
 *   飞猪的风控按「出口 IP + 行为频率」判定（实测：换 Key、换设备指纹、换航线日期都无效）。
 *   一旦被拦，实时层拿不到价，页面就只能显示「票价以飞猪为准」。
 *   有了这个脚本，可以在网络干净的时候一次性把常用航线价格存下来 ——
 *   之后即使被风控，页面也会显示「¥620 · 2 小时前查」的真实票价，而不是空白。
 *
 * 三条纪律：
 *   ① 慢：单条间隔默认 8 秒（约 7.5 次/分，官方配额是 20~24 次/60s，留足余量）；
 *   ② 撞墙就停：一旦命中 451/403 立刻整体结束，继续试探只会把 24 小时风控重新计时；
 *   ③ 不重复花钱：同样航线、同样日期、12 小时内查过就跳过。
 *
 * 用法：
 *   node scripts/warm-flight.mjs                                # 成都出发，默认日期（今天+7），12 条
 *   node scripts/warm-flight.mjs --from 上海 --n 20 --gap 10000
 *   node scripts/warm-flight.mjs --date 2026-10-30 --dry         # 只打印计划，不发请求
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAir } from '../airlib.mjs';
import { createFlyai } from '../flyai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const PRICE_FILE = path.join(DATA, 'flight-cache.json');

/** 取 --name value；裸 --flag 视为 true */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const p2 = (n) => String(n).padStart(2, '0');
const def = new Date(); def.setDate(def.getDate() + 7);

const FROM = String(arg('from', '成都'));
const DATE = String(arg('date', `${def.getFullYear()}-${p2(def.getMonth() + 1)}-${p2(def.getDate())}`));
const N = Math.max(1, Number(arg('n', 12)) || 12);
const GAP = Math.max(1000, Number(arg('gap', 12000)) || 12000);
const FRESH_H = Math.max(0, Number(arg('fresh', 12)) || 12);
const DRY = arg('dry', false) === true;
const NO_KEY = arg('guest', false) === true;   // --guest：强制走体验通道（不带 Key）

const air = createAir({ dataDir: DATA });
if (!air.ready) { console.error('航线库未就绪（data/air.json），无法筛选目的地。'); process.exit(1); }

const all = JSON.parse(fs.readFileSync(path.join(DATA, 'destinations.json'), 'utf8'));
const targets = all
  .map((x, i) => ({ ...x, _i: i }))
  .filter((x) => x.name && x.name !== FROM && air.hasOwnAirport(x.name))   // 只选有民航机场的城市
  // 先按热度，再保持 destinations.json 的策划顺序（丽江/大理这类会排在前面）
  .sort((a, b) => (b.fame || 0) - (a.fame || 0) || a._i - b._i)
  .slice(0, N);

let store = {};
try { store = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8')) || {}; } catch { store = {}; }

const keyOf = (dest) => `${FROM}|${DATE}|${dest}`;
const ago = (t) => {
  const m = Math.max(1, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
};

console.log(`预热：${FROM} → ${targets.length} 个目的地，日期 ${DATE}，间隔 ${GAP}ms`);
console.log(`已有缓存航线：${Object.keys(store).length} 条；${FRESH_H} 小时内查过的会跳过。\n`);

if (DRY) {
  targets.forEach((d, i) => console.log(`  ${i + 1}. ${FROM} → ${d.name}`));
  console.log('\n(--dry) 未发起任何请求。');
  process.exit(0);
}

if (NO_KEY) process.env.FLYAI_MODE = 'guest';
const FLYAI = createFlyai({ concurrency: 1, gapMs: 3000 });
if (!FLYAI.ready) { console.error('flyai CLI 不可用（FLYAI_BIN 指向的 bundle 不存在）。'); process.exit(1); }

let ok = 0, skip = 0, miss = 0, blocked = false;

for (let i = 0; i < targets.length; i++) {
  const dst = targets[i];
  const tag = `[${i + 1}/${targets.length}] ${dst.name}`;

  const hit = store[keyOf(dst.name)];
  if (hit && Date.now() - (Number(hit.t) || 0) < FRESH_H * 3600e3) {
    skip++;
    console.log(`${tag} 跳过（${ago(Number(hit.t))}查过）`);
    continue;
  }

  const r = await FLYAI.searchFlight({ origin: FROM, destination: dst.name, date: DATE });
  const risk = /451|403|risk control|Abnormal access/i.test(r.error || '');

  // 撞墙立即停：继续打只会把封禁时间拉长
  if (r.stale || (risk && !r.list.length)) {
    blocked = true;
    console.log(`\n⛔ ${dst.name} 命中飞猪风控（${(r.error || 'risk control').slice(0, 60)}）`);
    console.log('   已停止。继续重试只会延长封禁，建议换网络或等几小时后再跑。\n');
    break;
  }

  if (r.list.length) {
    ok++;
    const low = r.list.reduce((a, b) => (a.price != null && (!b.price || a.price <= b.price) ? a : b), r.list[0]);
    console.log(`${tag} ✅ ${r.list.length} 条 · ${low.no} ${low.dep}-${low.arr} ${low.priceText || '—'}`);
  } else {
    miss++;
    console.log(`${tag} ·  无直飞/无数据 ${r.error ? '(' + r.error.slice(0, 40) + ')' : ''}`);
  }

  if (i < targets.length - 1) await new Promise((x) => setTimeout(x, GAP));
}

await new Promise((x) => setTimeout(x, 1200));   // 等磁盘 flush

const now = JSON.parse(fs.existsSync(PRICE_FILE) ? fs.readFileSync(PRICE_FILE, 'utf8') : '{}');
console.log('─────────────── 汇总 ───────────────');
console.log(`成功 ${ok} · 跳过 ${skip} · 无数据 ${miss}${blocked ? ' · 中途因风控停止' : ''}`);
console.log(`磁盘价格库现有 ${Object.keys(now).length} 条航线。`);
if (ok) console.log('下次打开页面，这些航线的票价会直接显示（并标注查询时间）。');
