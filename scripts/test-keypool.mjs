#!/usr/bin/env node
/**
 * Key 池 + 熔断行为验证（离线，零真实请求）
 *
 * 用 scripts/stub-flyai-cli.mjs 假装飞猪：Key 含 AK1 → 恒 451，其余正常。
 *
 * 验证六件事（口径已按 2026-10-21 实测修正）：
 *   ① 命中 451 是**账号级**：不光冷却中招那把，整个池子一起停（换 Key 甩不掉封禁）；
 *   ② 停手期间**一个请求都不发**（防探测重置 24h 计时）；
 *   ③ 冷却状态**落盘**，进程重启后仍然生效（演示当天最容易踩的坑）；
 *   ④ 冷却到期 → 自动恢复，并把命中计数归零；
 *   ⑤ 全部正常时多 Key 均衡消耗；
 *   ⑥ 频率闸门不因多 Key 放宽。
 *
 * 运行：node scripts/test-keypool.mjs
 */
import { createFlyai } from '../flyai.mjs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STUB = fileURLToPath(new URL('./stub-flyai-cli.mjs', import.meta.url));
const TMP = path.join(os.tmpdir(), 'flyai-pool-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
function check(label, cond, extra = '') {
  if (!cond) failed++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? '  ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 场景 A：账号级熔断 ─────────────────────────────────────────── */
console.log('\n=== 场景 A：AK1 触发 451 → 整个池子停手 ===');
const a = createFlyai({
  bin: STUB, dataDir: TMP, gapMs: 10, windowMax: 999, riskCooldownMs: 60 * 60 * 1000,
  keys: ['sk-AK1', 'sk-AK2', 'sk-AK3']
});
const r1 = await a.searchFlight({ origin: '成都', destination: '丽江', date: '2026-10-25' });
const callsAfterHit = a.stats().calls;
const r2 = await a.searchFlight({ origin: '成都', destination: '大理', date: '2026-10-25' });
const r3 = await a.searchFlight({ origin: '成都', destination: '洛阳', date: '2026-10-25' });
const sa = a.stats();
console.log(`  第1次: ${r1.error}`);
console.log(`  第2/3次: ${r2.error} / ${r3.error}`);
console.log('  AK:', JSON.stringify(sa.ak));
check('第1次真实发出并命中 451', callsAfterHit === 1, `calls=${callsAfterHit}`);
check('第2、3次不再换 Key 重试（零请求）', sa.calls === 1 && r2.error === 'CLIENT_COOLDOWN' && r3.error === 'CLIENT_COOLDOWN', `calls=${sa.calls}`);
check('三把 Key 全部进入冷却（账号级）', sa.ak.every((k) => k.coolMin > 0), sa.ak.map((k) => k.coolMin).join('/'));
check('只有 AK1 记了命中，其余只是被连坐', sa.ak[0].hits === 1 && sa.ak[1].hits === 0 && sa.ak[2].hits === 0);
check('冷却时长取满 24h 口径（此处按 60min 注入）', sa.coolingMin >= 59 && sa.coolingMin <= 60, `coolingMin=${sa.coolingMin}`);

/* ── 场景 B：冷却状态落盘，重启仍生效 ───────────────────────────── */
console.log('\n=== 场景 B：重启后冷却仍然生效（落盘）===');
const riskFile = path.join(TMP, 'risk-state.json');
check('risk-state.json 已写入', fs.existsSync(riskFile));
const b = createFlyai({
  bin: STUB, dataDir: TMP, gapMs: 10, windowMax: 999, riskCooldownMs: 60 * 60 * 1000,
  keys: ['sk-AK2', 'sk-AK3']            // 换成别的 Key，模拟"我换把 Key 试试"
});
const rb = await b.searchFlight({ origin: '成都', destination: '扬州', date: '2026-10-25' });
const sb = b.stats();
console.log(`  新实例（新 Key）第一次调用: ${rb.error}`);
check('新进程启动即处于冷却，零请求', sb.calls === 0, `calls=${sb.calls}`);
check('换成没被封过的 Key 也照样拦截', rb.error === 'CLIENT_COOLDOWN');

/* ── 场景 C：冷却到期 → 自动恢复 ────────────────────────────────── */
console.log('\n=== 场景 C：冷却到期后自动恢复 ===');
const TMP2 = path.join(os.tmpdir(), 'flyai-pool-test-2');
fs.rmSync(TMP2, { recursive: true, force: true });
fs.mkdirSync(TMP2, { recursive: true });
// 「只失败第一次」：第一次 451 → 冷却 700ms → 到期后第二次应真的拿到数据
process.env.STUB_FAIL_FIRST = '1';
process.env.STUB_COUNTER = path.join(TMP2, 'called.once');
const c = createFlyai({
  bin: STUB, dataDir: TMP2, gapMs: 10, windowMax: 999, riskCooldownMs: 700,
  keys: ['sk-AK2']
});
const c1 = await c.searchFlight({ origin: '成都', destination: '桂林', date: '2026-10-25' });
const c2 = await c.searchFlight({ origin: '成都', destination: '北海', date: '2026-10-25' });
console.log(`  第1次: ${c1.error}`);
console.log(`  冷却中: ${c2.error}`);
await sleep(900);
const c3 = await c.searchFlight({ origin: '成都', destination: '北海', date: '2026-10-25' });
const sc = c.stats();
console.log(`  冷却到期后: ${c3.list.length ? '有票 ¥' + c3.list[0].price : '空'} ${c3.error || ''}`);
delete process.env.STUB_FAIL_FIRST;
delete process.env.STUB_COUNTER;
check('第1次命中 451', /451/.test(c1.error || ''));
check('冷却中确实拦截（零请求）', c2.error === 'CLIENT_COOLDOWN');
check('到期后自动恢复，不需要重启', c3.list.length === 1, `list=${c3.list.length}`);
check('恢复后命中计数归零', sc.riskHits === 0 && sc.ak[0].hits === 0, `riskHits=${sc.riskHits}`);
check('落盘状态也被清零', JSON.parse(fs.readFileSync(path.join(TMP2, 'risk-state.json'), 'utf8')).until === 0);

/* ── 场景 D：全部正常时的均衡消耗 ───────────────────────────────── */
console.log('\n=== 场景 D：多 Key 均衡消耗（无风控）===');
const TMP3 = path.join(os.tmpdir(), 'flyai-pool-test-3');
fs.rmSync(TMP3, { recursive: true, force: true });
fs.mkdirSync(TMP3, { recursive: true });
const d = createFlyai({
  bin: STUB, dataDir: TMP3, gapMs: 10, windowMax: 999,
  keys: ['sk-AK2', 'sk-AK3', 'sk-AK4', 'sk-AK5']
});
for (const dest of ['丽江', '大理', '洛阳', '扬州', '张家界', '恩施', '桂林', '北海']) {
  await d.searchFlight({ origin: '成都', destination: dest, date: '2026-10-25' });
}
const sd = d.stats();
console.log('  uses:', sd.ak.map((k) => k.uses).join(' / '));
check('8 次请求全部有票', sd.calls === 8);
check('四把 Key 用量差 ≤1', Math.max(...sd.ak.map((k) => k.uses)) - Math.min(...sd.ak.map((k) => k.uses)) <= 1);

/* ── 场景 E：闸门不被多 Key 放宽 ────────────────────────────────── */
console.log('\n=== 场景 E：频率闸门（多 Key 不得放宽）===');
const e = createFlyai({ bin: STUB, dataDir: TMP3, keys: ['sk-AK2', 'sk-AK3', 'sk-AK4'] });
const se = e.stats();
/* 闸门的判据是「比授权配额更保守」，不是写死某个数字。
 * 2026-10-23 举办方把 AK 开到 5 QPS（= 300 次/60s），因此上界从 18 提到 90（仍留 3 倍余量）。
 * 断言写成区间而不是等值，参数再调整时不会再假报警。 */
const winMax = Number(String(se.window).split('/')[0]);
check('窗口 ≤ 90 次/60s（授权 300，留 3 倍边际）', winMax <= 90 && winMax > 0, se.window);
check('条间隔 ≥ 300ms', se.gapMs >= 300, String(se.gapMs));
check('并发 ≤ 4（实测 3 起偶发 429，不超）', se.concurrency >= 1 && se.concurrency <= 4, String(se.concurrency));
check('日预算闸门存在', typeof se.dayLeft === 'number' && se.dayMax > 0, `dayBudget=${se.dayBudget}`);

console.log(`\n${failed ? '❌ ' + failed + ' 项未通过' : '✅ 全部通过'}\n`);
for (const p of [TMP, TMP2, TMP3]) fs.rmSync(p, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
