#!/usr/bin/env node
/**
 * 多 AK 管理（写 ~/.flyai/config.json，Key 不进项目目录）
 *
 *   node scripts/keys.mjs list              看当前池子里有几把（打码显示）
 *   node scripts/keys.mjs add sk-aaa sk-bbb 追加新 AK（自动去重）
 *   node scripts/keys.mjs rm sk-aaa         移除某把
 *   node scripts/keys.mjs clear             清空（保留文件本身）
 *
 * 官方口径（2026-10-21）：每个 AK 独立 5000 次额度，用完后每天 200 次，
 * 风控也是 AK 级、24 小时。所以多申请几把、均衡消耗，比死磕一把更稳。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.flyai', 'config.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}
function save(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
/** 兼容老的单 Key 写法：FLYAI_API_KEY 也算池子里的一把 */
function poolOf(cfg) {
  const arr = Array.isArray(cfg.FLYAI_API_KEYS) ? cfg.FLYAI_API_KEYS.slice() : [];
  if (cfg.FLYAI_API_KEY && !arr.includes(cfg.FLYAI_API_KEY)) arr.unshift(cfg.FLYAI_API_KEY);
  return arr;
}
const mask = (k) => (k.length <= 12 ? k.slice(0, 4) + '***' : k.slice(0, 8) + '***' + k.slice(-4));

const [cmd, ...args] = process.argv.slice(2);
const cfg = load();

switch (cmd) {
  case 'list': {
    const pool = poolOf(cfg);
    console.log(`配置文件：${FILE}`);
    console.log(`AK 数量：${pool.length}`);
    pool.forEach((k, i) => console.log(`  AK#${i + 1}  ${mask(k)}`));
    if (!pool.length) console.log('  (空 —— 会走游客通道，火车/酒店价格会被脱敏成 ¥1xx)');
    break;
  }
  case 'add': {
    if (!args.length) { console.error('用法：node scripts/keys.mjs add sk-aaa sk-bbb'); process.exit(1); }
    const bad = args.filter((k) => !/^sk-[A-Za-z0-9_-]{8,}$/.test(k));
    if (bad.length) { console.error('格式不像 AK：' + bad.map(mask).join(', ')); process.exit(1); }
    const pool = poolOf(cfg);
    const added = [];
    for (const k of args) if (!pool.includes(k)) { pool.push(k); added.push(k); }
    cfg.FLYAI_API_KEYS = pool;
    delete cfg.FLYAI_API_KEY;          // 统一收进数组，避免两处不一致
    save(cfg);
    console.log(`已追加 ${added.length} 把，当前共 ${pool.length} 把：`);
    pool.forEach((k, i) => console.log(`  AK#${i + 1}  ${mask(k)}${added.includes(k) ? '  ← 新增' : ''}`));
    console.log('\n重启服务后生效（启动.bat 或 npm start）。');
    break;
  }
  case 'rm': {
    if (!args.length) { console.error('用法：node scripts/keys.mjs rm sk-aaa'); process.exit(1); }
    const drop = new Set(args);
    const pool = poolOf(cfg).filter((k) => !drop.has(k));
    cfg.FLYAI_API_KEYS = pool;
    delete cfg.FLYAI_API_KEY;
    save(cfg);
    console.log(`已移除，剩余 ${pool.length} 把。`);
    break;
  }
  case 'clear': {
    cfg.FLYAI_API_KEYS = [];
    delete cfg.FLYAI_API_KEY;
    save(cfg);
    console.log('已清空 AK 池。');
    break;
  }
  default:
    console.log('用法：node scripts/keys.mjs <list|add|rm|clear> [sk-...]');
}
