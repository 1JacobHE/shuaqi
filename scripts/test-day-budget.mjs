#!/usr/bin/env node
/**
 * 单日累计预算闸门验证（离线，零真实请求）
 *
 * 背景：2026-10-21 当天累计 52 次调用撞出 4 个 451，账号封 24 小时。
 * 前两层闸门（条间隔、滚动窗口）只看「瞬间多快」，管不住「一天打多少」，
 * 所以补了第三层 DAY_MAX。本脚本验证它真的挡得住。
 *
 * 验证六件事：
 *   ① 预算内正常放行；
 *   ② 到顶后零请求（不是少发，是一个都不发）；
 *   ③ 超支时仍能用磁盘里的历史真价顶上，并标 priceStale；
 *   ④ 账本落盘：进程重启后继续从原额度扣；
 *   ⑤ 跨天自动清零；
 *   ⑥ cachedOnly 只读磁盘，不占预算。
 *
 * 运行：node scripts/test-day-budget.mjs
 */
import { createFlyai } from '../flyai.mjs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STUB = fileURLToPath(new URL('./stub-flyai-cli.mjs', import.meta.url));
const TMP = path.join(os.tmpdir(), 'flyai-day-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
function check(label, cond, extra = '') {
  if (!cond) failed++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? '  ' + extra : ''}`);
}

/* 闸门放宽到极限，单独考察 DAY_MAX —— 不让窗口/间隔干扰结论 */
const FAST = { bin: STUB, dataDir: TMP, keys: ['AK9-test'], gapMs: 0, windowMax: 9999, dayMax: 3 };

const q = (n) => ({ origin: '苏州', destination: `城${n}`, date: '2026-10-30' });   // 不同目的地 = 必然 cache miss

console.log('\n── 场景 A：预算内放行，到顶即停 ──');
{
  const f = createFlyai(FAST);
  const r1 = await f.searchFlight(q(1));
  const r2 = await f.searchFlight(q(2));
  const r3 = await f.searchFlight(q(3));
  check('前 3 条正常拿到航班', [r1, r2, r3].every((r) => r.list.length > 0), `calls=${f.stats().calls}`);
  check('真实调用次数 = 3', f.stats().calls === 3, `实际 ${f.stats().calls}`);

  const r4 = await f.searchFlight(q(4));
  check('第 4 条被预算拦住', r4.error === 'DAY_BUDGET', `error=${r4.error}`);
  check('被拦时**零请求**（calls 仍为 3）', f.stats().calls === 3, `实际 ${f.stats().calls}`);
  check('预算显示 3/3', f.stats().dayBudget === '3/3', f.stats().dayBudget);
  check('剩余额度为 0', f.stats().dayLeft === 0, String(f.stats().dayLeft));
}

console.log('\n── 场景 B：账本落盘，重启后不重置 ──');
{
  const f2 = createFlyai(FAST);          // 同一 dataDir，等同进程重启
  check('重启后读到已用 3 次', f2.stats().dayBudget === '3/3', f2.stats().dayBudget);
  const r = await f2.searchFlight(q(5));
  check('重启后第 1 条依然被拦', r.error === 'DAY_BUDGET', `error=${r.error}`);
  check('重启后依然零请求', f2.stats().calls === 0, `实际 ${f2.stats().calls}`);
  check('账本文件存在且 used=3',
    JSON.parse(fs.readFileSync(path.join(TMP, 'flyai-day.json'), 'utf8')).used === 3);
}

console.log('\n── 场景 C：超支时用历史真价兜底 ──');
{
  /* 手动种一份磁盘价库：不依赖 8 秒落盘定时器，测试时序才可控 */
  const TMP2 = path.join(os.tmpdir(), 'flyai-day-test-2');
  fs.rmSync(TMP2, { recursive: true, force: true });
  fs.mkdirSync(TMP2, { recursive: true });
  const CK = '苏州|2026-10-30|城9';
  fs.writeFileSync(path.join(TMP2, 'flight-cache.json'), JSON.stringify({
    [CK]: { t: Date.now(), list: [{ no: 'MU5678', price: 620, dep: '10:05', arr: '13:20', hours: 3.2 }] }
  }));

  /* 只剩 1 次额度：花在别的城市上，再回头查有历史价的那条 */
  const capped = createFlyai({ ...FAST, dataDir: TMP2, dayMax: 1 });
  await capped.searchFlight(q(8));
  const r = await capped.searchFlight(q(9));
  check('超支时返回 DAY_BUDGET', r.error === 'DAY_BUDGET', `error=${r.error || '无'}`);
  check('超支时仍给出历史真价', r.list.length > 0, `${r.list.length} 条`);
  check('历史价被标记为 stale', r.list.every((x) => x.priceStale === true));
  check('带查询时间戳便于前端标注', r.list.every((x) => Number(x.priceAt) > 0));
  check('历史上真实票价被原样保留', r.list[0] && r.list[0].price === 620, JSON.stringify(r.list[0]?.price));
}

console.log('\n── 场景 C2：dayMax=0 表示显式关闭，不是"零额度" ──');
{
  const TMP4 = path.join(os.tmpdir(), 'flyai-day-test-4');
  fs.rmSync(TMP4, { recursive: true, force: true });
  fs.mkdirSync(TMP4, { recursive: true });
  const f = createFlyai({ ...FAST, dataDir: TMP4, dayMax: 0 });
  const r = await f.searchFlight(q(11));
  check('dayMax=0 时正常放行', r.error !== 'DAY_BUDGET', `error=${r.error || '无'}`);
  check('dayMax=0 时 dayLeft 为 -1（不限）', f.stats().dayLeft === -1, String(f.stats().dayLeft));
}

console.log('\n── 场景 D：跨天自动清零 ──');
{
  const TMP3 = path.join(os.tmpdir(), 'flyai-day-test-3');
  fs.rmSync(TMP3, { recursive: true, force: true });
  fs.mkdirSync(TMP3, { recursive: true });
  /* 手写一份「昨天」的账本，used 塞满 */
  fs.writeFileSync(path.join(TMP3, 'flyai-day.json'),
    JSON.stringify({ date: '2000-01-01', used: 999, at: 0 }));
  const f = createFlyai({ ...FAST, dataDir: TMP3, dayMax: 3 });
  check('昨天的账本不占用今天', f.stats().dayLeft === 3, String(f.stats().dayLeft));
  const r = await f.searchFlight(q(7));
  check('跨天后可以正常查询', r.error !== 'DAY_BUDGET', `error=${r.error || '无'}`);
}

console.log('\n── 场景 E：cachedOnly 不占预算 ──');
{
  const f = createFlyai({ ...FAST, dataDir: TMP, dayMax: 3 });
  f.searchFlight({ ...q(1), cachedOnly: true });
  f.searchFlight({ ...q(2), cachedOnly: true });
  check('cachedOnly 后预算仍是 3/3', f.stats().dayBudget === '3/3', f.stats().dayBudget);
}

console.log(failed ? `\n✗ ${failed} 项失败\n` : '\n✓ 全部通过：日预算闸门按预期工作\n');
process.exit(failed ? 1 : 0);
