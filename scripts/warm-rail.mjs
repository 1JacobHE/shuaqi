/*
 * warm-rail.mjs —— 温和地把 12306 余票缓存预热满
 * ------------------------------------------------------------------
 * 为什么单独写一个脚本，而不是直接点页面上的「搜索」：
 *   12306 对**突发速率**极敏感（并发 8 猛打几分钟就会把 IP 打成「大部分 302」），
 *   但对**稳定的低频**容忍度很高（实测 1.2 秒/次长期稳定）。
 *   演示前用这个脚本慢慢把 data/rail-cache.json 填满，评审打开页面时就是零请求、
 *   秒出全量实时数据的体验；而页面上的「搜索」只需补增量。
 *
 * 用法：
 *   node scripts/warm-rail.mjs            # 默认预热「今天+7」天（页面的默认日期）
 *   node scripts/warm-rail.mjs 1,3,7      # 预热多个日期偏移
 *   RAIL_WARM_GAP=1500 node scripts/warm-rail.mjs
 *
 * 可随时 Ctrl+C 中断：已扫到的结果已经落盘，下次运行会自动跳过（只补缺的）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRail } from '../railways.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(DIR, 'data');
const POOL = JSON.parse(fs.readFileSync(path.join(DATA, 'destinations.json'), 'utf8'));

const GAP = Math.max(300, Number(process.env.RAIL_WARM_GAP) || 1300);
const FROM = process.env.RAIL_WARM_FROM || '苏州';
const offsets = (process.argv[2] || '7').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
// 只有显式指定 --force 才重扫已有缓存；默认只补缺的，绝不重复打 12306
const FORCE = process.argv.includes('--force');

const rail = createRail({
  dataDir: DATA,
  concurrency: 1,
  minGapMs: GAP,
  maxTries: Math.max(1, Number(process.env.RAIL_WARM_TRIES) || 4),
  // 预热脚本不熔断：它本就是要慢慢磨的，偶尔的 302 属于常态
  breakerRate: 0.95,
  breakerMin: 40
});

const fromCode = rail.codeOf(FROM);
if (!fromCode) { console.error(`出发地「${FROM}」不在站名表里`); process.exit(1); }
console.log(`预热出发地 ${FROM}(${fromCode}) · 目的地面板 ${POOL.length} 个 · 最小间隔 ${GAP}ms · 日期偏移 ${offsets.join(',')}`);

for (const off of offsets) {
  const d = new Date(); d.setDate(d.getDate() + off);
  const date = d.toISOString().slice(0, 10);
  const todo = FORCE ? POOL.slice() : POOL.filter(x => !rail.isFresh(fromCode, date, x));
  console.log(`\n=== ${date}（+${off} 天）：待补 ${todo.length} / ${POOL.length} ===`);
  if (!todo.length) { console.log('  已全部有缓存，跳过'); continue; }

  const t0 = Date.now();
  let n = 0;
  const st = await rail.scanAll({
    fromName: FROM, fromCode, date, dests: todo,
    onProgress: (s, dest) => {
      n++;
      if (n % 20 === 0 || s.scanned === s.total) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        process.stdout.write(`  ${s.scanned}/${s.total} 有车=${s.covered} 无直达=${s.noDirect} 失败=${s.failed} 用时${el}s\n`);
      }
    }
  });
  console.log(`  完成：${JSON.stringify(st)} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log('\n最终状态：', JSON.stringify(rail.stats()));
console.log('缓存文件：', path.join(DATA, 'rail-cache.json'));
