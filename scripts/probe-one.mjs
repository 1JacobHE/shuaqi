#!/usr/bin/env node
/**
 * 单发探针：确认解封只用这一条命令
 *
 *   node scripts/probe-one.mjs              按熔断状态判断，冷却中直接拒绝（不发请求）
 *   node scripts/probe-one.mjs --force      无视本地冷却记录，强发一条
 *   node scripts/probe-one.mjs --dest 大理   指定目的地（默认丽江）
 *
 * 为什么单独做一个脚本：页面上点「搜索」会一次打 30 条，
 * 万一还在封禁期，等于把 24 小时重新计时。验证解封**只能发一条**。
 *
 * 三种结果：
 *   有票        → 自动清掉熔断状态，重启服务即可正常用
 *   451/403     → 写回 24 小时冷却，继续等，别再试
 *   其它错误    → 不写冷却，原样打印（可能只是网络问题）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RISK_FILE = path.join(HERE, '..', 'data', 'risk-state.json');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const di = argv.indexOf('--dest');
const dest = di >= 0 ? argv[di + 1] : '丽江';
const date = process.env.PROBE_DATE || '2026-10-25';

function readRisk() {
  try { return JSON.parse(fs.readFileSync(RISK_FILE, 'utf8')); } catch { return null; }
}
function writeRisk(until, hits) {
  fs.mkdirSync(path.dirname(RISK_FILE), { recursive: true });
  fs.writeFileSync(RISK_FILE, JSON.stringify({ until, hits, at: Date.now() }));
}

const risk = readRisk();
if (!force && risk && Number(risk.until) > Date.now()) {
  const left = Math.ceil((Number(risk.until) - Date.now()) / 60000);
  console.log(`⏳ 仍在冷却中，还剩 ${left} 分钟（到 ${new Date(Number(risk.until)).toLocaleString('zh-CN')}）`);
  console.log('   现在发请求只会把 24 小时重新计时，所以我没有发。');
  console.log('   确认已解封就加 --force 强发一条。');
  process.exit(0);
}

// 探针自己发：先清掉本地记录，避免刚启动就被自己的熔断拦住
writeRisk(0, 0);

const { createFlyai } = await import('../flyai.mjs');
const f = createFlyai();
console.log(`发出 1 条请求：成都 → ${dest}  ${date}`);

const t0 = Date.now();
const r = await f.searchFlight({ origin: '成都', destination: dest, date });
const cost = ((Date.now() - t0) / 1000).toFixed(1);

if (r.list.length) {
  const b = r.list[0];
  console.log(`✅ 通了（${cost}s）：${b.no} ${b.dep || ''}→${b.arr || ''} ¥${b.price}`);
  writeRisk(0, 0);                       // 确认解封，清掉冷却
  console.log('   已清除熔断状态 —— 重启服务（启动.bat）即可正常使用。');
} else if (/451|403|risk control|Abnormal/i.test(r.error || '')) {
  writeRisk(Date.now() + 24 * 3600 * 1000, 1);
  console.log(`❌ 仍在封禁中（${cost}s）：${r.error}`);
  console.log('   已写回 24 小时冷却，别再试了，明天这个时间再来。');
  process.exitCode = 1;
} else {
  console.log(`⚠️ 没拿到数据，但不像是风控（${cost}s）：${r.error || '(空)'}`);
  console.log('   未写冷却 —— 可能只是网络抖动或该航线无直飞，可以换个目的地再试一次。');
  process.exitCode = 2;
}
