#!/usr/bin/env node
/**
 * 测试桩：模拟 flyai CLI 的输出协议。
 *
 * ⚠ 仅用于验证 Key 池轮换 / 熔断逻辑，**不联网、不消耗任何飞猪配额**。
 *   用法：createFlyai({ bin: '本文件路径', keys: [...] })
 *
 * 行为约定（按 Key 名区分，方便断言）：
 *   - 无 Key                        → 403（游客通道被封）
 *   - Key 含 "AK1"                  → 451（命中风控）
 *   - 环境变量 STUB_FAIL_FIRST=1    → **只在第一次**调用返回 451（之后正常），
 *     用来验证「冷却到期后自动恢复」；计数落在 STUB_COUNTER 指向的文件
 *   - 其他                           → 返回一条成功航班
 */
import fs from 'node:fs';

const key = process.env.FLYAI_API_KEY || '';
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] || '' : ''; };
const destination = arg('--destination');

const reply = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const RISK = (code) => ({ code, message: `HTTP ${code} Abnormal access behavior detected by risk control` });

if (!key) reply(RISK(403));
if (/AK1/i.test(key)) reply(RISK(451));

// 「只失败一次」模式：第一次调用返回 451，之后正常返回
if (process.env.STUB_FAIL_FIRST === '1') {
  const counter = process.env.STUB_COUNTER || '';
  if (counter && !fs.existsSync(counter)) {
    fs.writeFileSync(counter, '1');
    reply(RISK(451));
  }
}

reply({
  data: {
    itemList: [{
      ticketPrice: 620,
      jumpUrl: 'https://example.test/book?id=stub',
      journeys: [{
        totalDuration: 'PT2H10M',
        segments: [{
          transportNo: 'MU5678',
          marketingTransportNo: 'MU5678',
          marketingTransportName: '东方航空',
          depCityName: '成都',
          arrCityName: destination,
          depStationName: '天府',
          arrStationName: destination + '机场',
          depStationCode: 'TFU',
          arrStationCode: 'LJG',
          depDateTime: '2026-10-25T08:10:00',
          arrDateTime: '2026-10-25T10:20:00',
          seatClassName: '经济舱'
        }]
      }]
    }]
  }
});
