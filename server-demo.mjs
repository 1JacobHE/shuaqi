/**
 * 公网演示入口（跨平台）
 * ------------------------------------------------------------------
 * 等价于 `DEMO=1 node server.mjs`，但写法不依赖 shell 的 `VAR=x cmd` 语法，
 * 因此 Windows / Linux 部署环境都能直接用。
 *
 * 演示模式下不发起任何实时请求，只读本机 data/rail-cache.json 里已抓到的
 * 真实班次，保证页面在任何网络环境下打开都是完整的 216 条目的地列表。
 */
process.env.DEMO = '1';
await import('./server.mjs');
