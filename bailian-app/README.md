# flytrip-bailian-app · 百炼高代码应用

把「飞猪真实航班/酒店/景点 + qwen-plus 编排」封成一个百炼可部署的 Python 应用。
它是路径 B 的**AI 层**：不负责余票与列表页，那部分由 Node 主站承担。

## 文件

| 文件 | 作用 |
|---|---|
| `main.py` | 平台入口。只做 HTTP 接线：`GET /health`、`POST /process`、`GET /plan` |
| `core.py` | 真正的逻辑：意图解析 → 调飞猪 MCP → qwen 润色 → 输出「· 」短行。**纯标准库**，本地不装依赖也能跑 |
| `requirements.txt` | 依赖（锁死版本，避免构建漂移） |
| `pyproject.toml` | 打包成 `.whl` 用 |

## 平台硬性约定（不满足会部署失败）

1. 入口文件**必须叫 `main.py`**；
2. **必须有 `GET /health` 且返回 `"OK"`** —— 百炼靠它判断进程是否起来；
3. 对话接口默认 `POST /process`，遵循 Agent API 协议（`input` → `output` 消息数组，支持 `stream`）；
4. `requirements.txt` 用 `==` 锁版本，别用 `>=`。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | ✅ | 百炼 API Key，在应用「部署 → 环境变量」里配 |
| `MODEL` | | 默认 `qwen-plus` |
| `MCP_URL` | ✅ | 飞猪 MCP 地址，如 `http://127.0.0.1:8090/mcp` |
| `NODE_API` | | Node 主站地址（可选） |

## 本地跑通（三种方式，从轻到重）

**1）只测核心逻辑，一个依赖都不装：**

```bash
# 先把飞猪 MCP 起起来
node ../mcp-flyai.mjs --http --port 8099

export MCP_URL=http://127.0.0.1:8099/mcp
export DASHSCOPE_API_KEY=sk-xxx
python core.py "成都出发 10-27 去丽江 玩2天"
```

输出示例：

```
· 乘FM9537航班07:00从虹桥国际机场起飞，10:10抵达凤凰国际机场
· 游览天涯海角游览区、蜈支洲岛、南山文化旅游区及亚特兰蒂斯水世界
· 住宿可选三亚凤凰岛星河湾帆船度假酒店（¥148）或轩岩Holiday·假日酒店
机票下单：https://router.feizhu.com/...
```

**2）起完整 HTTP 服务（需要 fastapi）：**

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080
# 健康检查
curl http://127.0.0.1:8080/health          # → OK
# 简化接口
curl "http://127.0.0.1:8080/plan?q=成都出发%2010-27%20去丽江%20玩2天"
```

**3）按 Agent API 协议调 `/process`：**

```bash
curl -X POST http://127.0.0.1:8080/process \
  -H "Content-Type: application/json" \
  -d '{"input":[{"role":"user","content":[{"type":"text","text":"成都出发 10-27 去丽江 玩2天"}]}],"stream":false}'
```

## 部署到百炼

```bash
# 1. 装打包/部署工具
pip install agentscope-runtime==1.0.0
pip install "agentscope-runtime[deployment]==1.0.0"

# 2. 配 AK/SK（上传软件包时的鉴权，不是 API Key）
export ALIBABA_CLOUD_ACCESS_KEY_ID=LTAI****
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=****
export MODELSTUDIO_WORKSPACE_ID=llm-****      # 可选

# 3. 打包
python -m build          # 产出 dist/flytrip_bailian_app-0.1.0-py3-none-any.whl

# 4. 部署
runtime-fc-deploy --deploy-name flytrip-ai --whl-path dist/flytrip_bailian_app-0.1.0-py3-none-any.whl
```

> 首次部署前，建议先在百炼控制台**创建一次**高代码应用（引导会帮你开通 FC、API 网关的 RAM 角色），否则命令行上传会报权限错误。

部署完在「部署 → 环境变量」里补 `DASHSCOPE_API_KEY` 和 `MCP_URL`，然后「重新部署」。

## 降级铁律

| 情况 | 行为 |
|---|---|
| 没配 `DASHSCOPE_API_KEY` | 不调模型，直接用模板文案拼「· 」要点，接口照常返回 |
| qwen 超时/报错 | 同上，退回模板 |
| 飞猪 MCP 挂了 | 该维度写"暂未取到，建议自行查询"，不编造替代内容 |
| 模型写了乱七八糟的格式 | `to_bullets()` 强行拆成「· 」短行（和 Node 侧 `planfmt.mjs` 同一套规则） |

**任何情况下都不会把失败渲染成"AI 编造的内容"** —— 这是这个项目对外最硬的一条承诺。
