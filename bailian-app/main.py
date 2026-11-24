"""
flytrip-bailian-app · 百炼高代码应用入口
====================================================================
平台只认这个文件：入口必须叫 main.py，必须有 GET /health，对话走 POST /process。
真正的业务逻辑在 core.py（纯标准库），这里只做 HTTP 接线。

环境变量：
  DASHSCOPE_API_KEY  百炼 API Key（必填，平台侧配置）
  MODEL              模型名，默认 qwen-plus
  MCP_URL            飞猪 MCP 地址，如 http://127.0.0.1:8090/mcp
  NODE_API           Node 主站地址（可选）
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

import core

APP_VERSION = "0.1.0"
app = FastAPI(title="flytrip-bailian-app", version=APP_VERSION)


@app.get("/health")
def health_check():
    """百炼靠这个接口判断进程是否启动成功；返回非 200 / 非 OK 都会判部署失败。"""
    return PlainTextResponse("OK")


@app.get("/")
def index():
    return {
        "app": "flytrip-bailian-app",
        "version": APP_VERSION,
        "model": core.MODEL,
        "tools": bool(core.MCP_URL),
        "node_api": bool(core.NODE_API),
        "endpoints": ["GET /health", "POST /process", "GET /plan"],
    }


@app.get("/plan")
def plan_get(q: str = "", origin: str = "", destination: str = "", date: str = "", days: int = 2):
    """给网站 / curl 直接用的简化接口，逻辑与 /process 完全一致。"""
    text = q or f"{origin}出发 {date} 去{destination} 玩{days}天"
    return core.build(text)


def _msg(text: str, role: str = "assistant") -> Dict[str, Any]:
    return {
        "id": f"msg_{uuid.uuid4().hex[:12]}",
        "object": "message",
        "type": "message",
        "status": "completed",
        "role": role,
        "content": [{"type": "text", "object": "content", "index": 0, "delta": False, "text": text}],
    }


def _extract_input(body: Dict[str, Any]) -> str:
    """兼容三种入参：Agent API 协议 input / 简化 query / message。"""
    if isinstance(body.get("query"), str):
        return body["query"]
    if isinstance(body.get("message"), str):
        return body["message"]
    inp = body.get("input")
    if isinstance(inp, str):
        return inp
    # 百炼 Agent API 的真实形态是 input: { messages: [...] } / { text: "..." } / { query: "..." }。
    # 之前只认 str 和 list，用这个形状调进来会拿到空字符串，页面就回一句「请告诉我出发城市…」。
    if isinstance(inp, dict):
        for k in ("text", "query", "prompt", "content"):
            v = inp.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        inp = inp.get("messages") if isinstance(inp.get("messages"), list) else []
    if isinstance(inp, list):
        buf = []
        for m in inp:
            c = m.get("content") if isinstance(m, dict) else None
            if isinstance(c, str):
                buf.append(c)
            elif isinstance(c, list):
                for part in c:
                    if isinstance(part, dict) and part.get("type") == "text":
                        buf.append(part.get("text", ""))
        return "\n".join(x for x in buf if x).strip()
    return ""


@app.post("/process")
async def process(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": {"code": "bad_request", "message": "body 不是合法 JSON"}},
                            status_code=400)
    if not isinstance(body, dict):
        body = {}

    result = core.build(_extract_input(body))
    resp_id = f"response_{uuid.uuid4().hex[:16]}"
    session_id = body.get("session_id") or f"session_{uuid.uuid4().hex[:12]}"

    # 协议允许流式与非流式两种；控制台测试面板通常发 stream=true
    if body.get("stream"):
        def gen():
            yield "data: " + json.dumps({"id": resp_id, "object": "response", "status": "created"},
                                        ensure_ascii=False) + "\n\n"
            msg_id = f"msg_{uuid.uuid4().hex[:12]}"
            yield "data: " + json.dumps({"id": msg_id, "object": "message", "type": "message",
                                         "status": "created"}, ensure_ascii=False) + "\n\n"
            for line in result["text"].split("\n"):
                yield "data: " + json.dumps(
                    {"status": "in_progress", "type": "text", "index": 0, "delta": True,
                     "text": line + "\n", "object": "content", "msg_id": msg_id},
                    ensure_ascii=False) + "\n\n"
            yield "data: " + json.dumps(
                {"status": "completed", "type": "text", "index": 0, "delta": False,
                 "text": result["text"], "object": "content", "msg_id": msg_id},
                ensure_ascii=False) + "\n\n"
            yield "data: " + json.dumps({"id": msg_id, "status": "completed", "object": "message"},
                                        ensure_ascii=False) + "\n\n"
            yield "data: " + json.dumps({"id": resp_id, "object": "response", "status": "completed"},
                                        ensure_ascii=False) + "\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return {
        "id": resp_id,
        "object": "response",
        "created_at": int(time.time()),
        "completed_at": int(time.time()),
        "error": None,
        "session_id": session_id,
        "output": [_msg(result["text"])],
        "usage": None,
        "extra": {"ok": result["ok"], "intent": result["intent"], "plan": result.get("plan", "")},
    }
