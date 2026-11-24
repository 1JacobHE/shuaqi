#!/usr/bin/env node
/**
 * 单 Key 隔离探针：只验证「这一把 Key 所在账号」是否解封，**不动**主状态。
 *
 * 为什么不用 probe-one.mjs：它命中 451 会把 data/risk-state.json 写成
 * 「现在 + 24h」，而那是一份**全局**记录。池里两把 Key 属于两个不同账号，
 * 封禁起算点差十几个小时——用 AK#2 探一条失败，会把 AK#1 本来今晚就到期的
 * 记录推后一整天，等于自己把路堵死。
 *
 * 这个脚本的做法：给 flyai 一个临时 dataDir，冷却/日账本/价格库全落在临时目录，
 * 主 data/risk-state.json 一个字节都不碰；结果只追加到 data/probe-log.jsonl。
 *
 *   node scripts/probe-key.mjs --key 2                  # 探池里第 2 把
 *   node scripts/probe-key.mjs --key 2 --dest 大理
 *   node scripts/probe-key.mjs --key 2 --date 2026-10-29
 *
 * 退出码：0 = 通了  1 = 451/403 仍在封  2 = 其它错误（多半不是风控）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LOG = path.join(ROOT, 'data', 'probe-log.jsonl');

const argv = process.argv.slice(2);
const gi = (n, dflt) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : dflt; };
const keyIdx = Number(gi('--key', '1'));
const dest = gi('--dest', '丽江');
const origin = gi('--origin', '成都');
const date = gi('--date', process.env.PROBE_DATE || '2026-10-25');

function resolvePool() {
  const multi = (process.env.FLYAI_API_KEYS || '').trim();
  if (multi) return multi.split(',').map((s) => s.trim()).filter(Boolean);
  const single = (process.env.FLYAI_API_KEY || '').trim();
  if (single) return [single];
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.flyai', 'config.json'), 'utf8'));
    if (Array.isArray(c.FLYAI_API_KEYS) && c.FLYAI_API_KEYS.length) return c.FLYAI_API_KEYS.filter(Boolean);
    if (c.FLYAI_API_KEY) return [c.FLYAI_API_KEY];
  } catch { /* 没有就是没有 */ }
  return [];
}

const pool = resolvePool();
if (!pool.length) {
  console.log('❌ 没有任何 Key（~/.flyai/config.json 为空）');
  process.exit(2);
}
if (!Number.isFinite(keyIdx) || keyIdx < 1 || keyIdx > pool.length) {
  console.log(`❌ --key 只能是 1~${pool.length}（池里有 ${pool.length} 把）`);
  process.exit(2);
}
const tag = `AK#${keyIdx}`;
const mask = (k) => `${k.slice(0, 7)}***${k.slice(-5)}`;

// 隔离目录：主状态不受影响
const TMP = path.join(os.tmpdir(), `flyai-probe-${tag}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

const { createFlyai } = await import('../flyai.mjs');
// gapMs 给 0：只发一条，没有第二条要间隔
const f = createFlyai({ keys: [pool[keyIdx - 1]], dataDir: TMP, gapMs: 0 });

console.log(`探针：${tag} ${mask(pool[keyIdx - 1])}  →  ${origin} → ${dest}  ${date}`);
console.log('隔离模式：冷却 / 日账本 / 价格库全部落在临时目录，主 risk-state.json 不动\n');

const t0 = Date.now();
const r = await f.searchFlight({ origin, destination: dest, date });
const cost = ((Date.now() - t0) / 1000).toFixed(1);

let verdict;
let code;
if (r.list.length) {
  const b = r.list[0];
  verdict = `通了 ${b.no || ''} ${b.dep || ''}→${b.arr || ''} ¥${b.price}`;
  code = 0;
  console.log(`✅ ${tag} 已解封（${cost}s）`);
  console.log(`   ${b.no} ${b.dep}→${b.arr}  ¥${b.price}  ${b.airlines?.join('/') || ''}`);
  console.log('\n   下一步：把这一把设为主 Key 重启服务，实时机票就能用。');
} else if (/451|403|risk control|Abnormal/i.test(r.error || '')) {
  verdict = `仍封 ${r.error}`.slice(0, 120);
  code = 1;
  console.log(`❌ ${tag} 仍在封禁中（${cost}s）`);
  console.log(`   ${r.error}`);
  console.log('\n   注意：主状态没有被改动，别的 Key 的倒计时不受影响。');
} else {
  verdict = `其它错误 ${r.error || '(空)'}`.slice(0, 120);
  code = 2;
  console.log(`⚠️ ${tag} 没拿到数据，但不像风控（${cost}s）`);
  console.log(`   ${r.error || '(空)'}`);
  console.log('   可能只是网络抖动 / 该航线当天无直飞。换个 --dest 可再试一次。');
}

// 只记一行日志，方便回头对时间线
try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({
    at: new Date().toISOString(), tag, keyMask: mask(pool[keyIdx - 1]),
    origin, dest, date, cost: Number(cost), ok: code === 0, verdict
  }) + '\n');
  console.log(`\n（已记录到 data/probe-log.jsonl）`);
} catch { /* 日志失败不影响结论 */ }

fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = code;
