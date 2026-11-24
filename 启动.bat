@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  耍起 · 目的地探索  ——  一键启动
rem
rem  本脚本会依次拉起三层服务：
rem    ① 飞猪 MCP 服务   :8099   （4 个工具：机票/火车票/酒店/景点）
rem    ② 百炼高代码应用  :8090   （意图解析 → 调 MCP → qwen 编排 → 「· 」短行）
rem    ③ 网站主站        :8790   （12306 实时余票 + 本地航线库 + 调百炼应用）
rem
rem  数据源（四层降级，越往下越稳）
rem    A 高铁余票 = 12306 公开只读接口（无配额，全量实时）
rem    B 航班骨架 = 本地航线库 data/air.json（零网络、零配额）
rem    C 航班实时 = 飞猪 flyai（按需 1 次 / 目的地，有风控冷却）
rem    D 行程安排 = 百炼应用 → 本地模型 → 本地规则（三层，永不空白）
rem
rem  购票入口：高铁 → 12306 官方页   机票 / 酒店 / 门票 → 飞猪
rem ============================================================

rem ---------- 0) 清掉上一次残留的端口占用（重复双击也不会端口冲突） ----------
for %%P in (8099 8090 8790) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
  )
)

rem ---------- 1) 高铁扫描（12306）：不需要 Key、没有配额，默认全量扫 216 个目的地 ----------
rem    速率由 railways.mjs 的「全局最小间隔 280ms + 并发 3 + 熔断」纪律保证，
rem    一次全量约 1~2 分钟，边扫边出；已缓存的不会重复请求。
rem    ★ 不要靠调大 RAIL_CONCURRENCY 提速 —— 实测并发 8 猛打几分钟就会把本机 IP
rem      打成「大部分请求 302」，且恢复期很长。
set RAIL_MIN_GAP_MS=280
set RAIL_CONCURRENCY=3
set SCAN_LIMIT=9999

rem 1.5) 后台温和自补：只补本地还没有的目的地，间隔 1.2s、并发 1，
rem      启动 20 秒后来一轮，之后每 6 小时一轮。关掉它：set RAIL_AUTOWARM=0
rem set RAIL_AUTOWARM=0
rem set RAIL_WARM_GAP=1200
rem set RAIL_WARM_EVERY=21600000

rem 1.8) 可选：首轮手动预热（补齐默认日期的班次，之后交给后台自补）
rem      在另一个窗口执行：node scripts/warm-rail.mjs

rem ---------- 2) 扫描并发（12306 侧另有自己的速率纪律，见上面） ----------
set CONCURRENCY=2

rem ---------- 3) CPS 推广位（商业价值保留的关键开关） ----------
rem    填入飞猪分配的推广位参数后，所有飞猪跳转链接会自动带上，成交即可分佣。
rem    留空则链接原样输出，不影响功能。
rem    形如：set AFFILIATE_QUERY=utm_source=xxx^&cid=yyy
rem    注：公网 demo 刻意留空 —— demo 是给评委看的，挂推广位会显得在拿比赛做推广。
set AFFILIATE_QUERY=

rem ---------- 4) 阿里云百炼（赛事要求：必须使用百炼） ----------
rem    4.1) 主站的行程润色走百炼模型（OpenAI 兼容端点 + qwen-plus）
rem         Key 从 %USERPROFILE%\.bailian\config.json 读取，不写进项目文件。
set BAILIAN=1

rem    4.2) 百炼高代码应用地址：主站优先调它，由它去调飞猪 MCP 再交给 qwen 编排。
rem         这是「用了百炼」最硬的证据 —— 百炼控制台里能看到完整的工具调用记录。
rem         若 python 不可用（下面会检测），这一行不会设置，主站自动降级到本地模型。
rem         应用部署到云端后，把下面这行改成云端地址即可，主站代码不用动。
set BAILIAN_APP_URL=http://127.0.0.1:8090
set BAILIAN_APP_TIMEOUT_MS=25000

rem ---------- 5) 飞猪实时航班 ----------
rem    Key 放 %USERPROFILE%\.flyai\config.json 或设 FLYAI_API_KEY，二选一。
rem    没配 / 被风控也不影响使用：仍会出「能不能直飞、飞多久」，购票照样跳飞猪，
rem    只是「航班号 / 时刻 / 票价」退化为「以飞猪页面为准」。
rem    ★ 并发必须保持 1：实测并发 3 连打几十次会被飞猪判定 abnormal access（HTTP 451/403），
rem      之后一段时间该 Key 全部请求被拒 —— 这跟「配额够不够」无关。
set FLYAI_CONCURRENCY=1
set FLYAI_GAP_MS=600
rem    扫描结束后预热前 N 个目的地的实时航班（0 = 完全按需，用户展开才查）
rem    默认 2：批量预热是最容易被风控判异常的动作，宁可少几条自动出实时，
rem    也不能把 Key 打进冷却 —— 一旦冷却，后面全都拿不到。
set FLYAI_WARM=2

rem ---------- 6) 运行模式 ----------
rem    DEMO=1  演示模式：不发起任何实时请求，只读本机已缓存的真实班次（公网 demo 用）
rem    绑定地址默认 0.0.0.0（发布沙箱要求反代可达），本机访问 127.0.0.1 一样正常。
rem set DEMO=1

rem ============================================================
rem  下面开始起服务，顺序不能乱：MCP 先起，应用才能连上
rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node。请先安装 Node.js 18+，或把 node 加入 PATH。
  pause
  exit /b 1
)

echo.
echo [1/3] 启动飞猪 MCP 服务（:8099）...
start "飞猪 MCP :8099" /min cmd /c "node mcp-flyai.mjs --http --port 8099"

where python >nul 2>nul
if errorlevel 1 (
  echo [2/3] 跳过百炼应用 —— 没找到 python。
  echo       行程将改由「主站直连百炼模型 → 本地规则」生成，功能不受影响。
  set BAILIAN_APP_URL=
) else (
  echo [2/3] 启动百炼高代码应用（:8090）...
  start "百炼应用 :8090" /min cmd /c "python bailian-app\server_stdlib.py --port 8090"
)

timeout /t 3 >nul

echo [3/3] 启动网站主站（:8790）...
echo.
echo   本机访问： http://127.0.0.1:8790
echo   局域网访问：http://本机IP:8790
echo.
echo   关掉这个窗口 = 退出主站。另两个最小化窗口（MCP / 百炼应用）可以一起关掉。
echo.

node server.mjs
pause
