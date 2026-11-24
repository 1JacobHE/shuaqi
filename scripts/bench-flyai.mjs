#!/usr/bin/env node
/**
 * 吞吐标定：在隔离目录里按指定节奏连打 N 条，看会不会 451。
 *
 * 目的：举办方说开了 5 QPS，但我们旧参数是 3s 间隔（0.33 QPS）——差 15 倍。
 * 不能凭一句话就改生产参数，先测出真实可承受的节奏。
 *
 *   node scripts/bench-flyai.mjs --key 2 --n 10 --gap 250
 *   node scripts/bench-flyai.mjs --key 2 --n 10 --gap 200 --date 2026-10-30
 *
 * 每条换一个目的地（缓存 30 分钟，不换就全命中缓存、测不出真实请求）。
 * 全程用临时 dataDir，主 risk-state.json 零污染。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const gi = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const keyIdx = Number(gi('--key', '2'));
const N = Math.min(40, Number(gi('--n', '10')));
const GAP = Math.max(0, Number(gi('--gap', '250')));
const CONC = Math.max(1, Math.min(16, Number(gi('--conc', '1'))));
const date = gi('--date', '2026-10-29');
const origin = gi('--origin', '成都');

/* 都是真有直飞航线的目的地，保证每条都是真实查询而不是空结果 */
const DESTS = ['丽江', '大理', '三亚', '昆明', '桂林', '北海', '西宁', '兰州', '大同', '延吉',
  '宜宾', '西昌', '张家界', '恩施', '武夷山', '扬州', '银川', '敦煌', '嘉峪关', '呼伦贝尔'];

function resolvePool() {
  const multi = (process.env.FLYAI_API_KEYS || '').trim();
  if (multi) return multi.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.flyai', 'config.json'), 'utf8'));
    if (Array.isArray(c.FLYAI_API_KEYS) && c.FLYAI_API_KEYS.length) return c.FLYAI_API_KEYS.filter(Boolean);
    if (c.FLYAI_API_KEY) return [c.FLYAI_API_KEY];
  } catch { /* ignore */ }
  return [];
}

const pool = resolvePool();
if (!pool.length) { console.log('❌ 没有 Key'); process.exit(2); }
const tag = `AK#${keyIdx}`;
const key = pool[keyIdx - 1];
if (!key) { console.log(`❌ --key 超范围（池里 ${pool.length} 把）`); process.exit(2); }

const TMP = path.join(os.tmpdir(), `flyai-bench-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

const { createFlyai } = await import('../flyai.mjs');
const f = createFlyai({ keys: [key], dataDir: TMP, gapMs: GAP, concurrency: CONC });

console.log(`标定：${tag}  ${N} 条  并发 ${CONC}  间隔 ${GAP}ms  日期 ${date}`);
console.log(`隔离目录：${TMP}\n`);

const rows = [];
const t0 = Date.now();

/* 并发模式：一次性全部发出去，让 flyai 内部队列自己限流 */
const tasks = [];
for (let i = 0; i < N; i++) {
  const dest = DESTS[i % DESTS.length];
  tasks.push((async () => {
    const ts = Date.now();
    const r = await f.searchFlight({ origin, destination: dest, date });
    const cost = ((Date.now() - ts) / 1000).toFixed(2);
    const ok = r.list.length > 0;
    const risk = /451|403|risk control|Abnormal/i.test(r.error || '');
    const price = ok ? r.list[0].price : null;
    rows.push({ dest, ok, risk, cost });
    console.log(`  ${String(rows.length).padStart(2)}. ${dest.padEnd(5)} ${ok ? '✅' : risk ? '🚫 451' : '⚠️ 空'}  ${cost}s  ${price ? '¥' + price : (r.error || '').slice(0, 50)}`);
    return risk;
  })());
}
const results = await Promise.all(tasks);
const riskN = results.filter(Boolean).length;
const total = ((Date.now() - t0) / 1000).toFixed(1);

const okN = rows.filter((x) => x.ok).length;
const avg = (rows.reduce((s, x) => s + Number(x.cost), 0) / rows.length).toFixed(2);

console.log(`\n── 结果 ──`);
console.log(`发出 ${rows.length} 条 | 成功 ${okN} | 451 ${riskN} | 总耗时 ${total}s | 单条均值 ${avg}s`);
console.log(`有效速率 ${(rows.length / Number(total)).toFixed(2)} QPS（含网络往返）`);
if (riskN > 0) console.log('\n⛔ 出现 451 —— 这个并发档位不安全，退回更低一档。');

try {
  fs.appendFileSync(path.join(TMP, 'bench.json'), JSON.stringify({ at: new Date().toISOString(), tag, N, GAP, okN, riskN, total }));
} catch { /* ignore */ }
fs.rmSync(TMP, { recursive: true, force: true });

process.exitCode = riskN > 0 ? 1 : 0;
