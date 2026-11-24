"""
flytrip-bailian-app · 纯标准库版服务器（本地 / 无 FastAPI 环境）
====================================================================
为什么存在这个文件：
  百炼云端部署用 main.py（FastAPI）。但本机 pip 连不上外网装不了 FastAPI，
  就没法在本地验证「Node 主站 → 百炼应用 /process → 飞猪 MCP」这条真实链路。
  这个文件用 http.server 复刻同一套路由与协议，本地零依赖就能跑通。

协议与 main.py 完全一致：
  GET  /health    → "OK"
  GET  /          → 服务信息
  GET  /plan?q=   → 简化接口
  POST /process   → Agent API 协议（支持 stream=true 的 SSE）

用法：
  python server_stdlib.py --port 8090
"""
from __future__ import annotations

import json
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import core

APP_VERSION = "0.1.0"


def _msg(text: str, role: str = "assistant") -> dict:
    return {
        "id": f"msg_{uuid.uuid4().hex[:12]}",
        "object": "message",
        "type": "message",
        "status": "completed",
        "role": role,
        "content": [{"type": "text", "object": "content", "index": 0, "delta": False, "text": text}],
    }


def _extract_input(body: dict) -> str:
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
            if not isinstance(m, dict):
                continue
            c = m.get("content")
            if isinstance(c, str):
                buf.append(c)
            elif isinstance(c, list):
                for part in c:
                    if isinstance(part, dict) and part.get("type") == "text":
                        buf.append(part.get("text", ""))
        return "\n".join(x for x in buf if x).strip()
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # 允许 keep-alive，SSE 才好用

    def log_message(self, fmt, *args):     # 静音默认访问日志，保留错误
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------------------------------------------------------------- helpers
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _text(self, s: str, code: int = 200):
        self._send(code, s.encode("utf-8"), "text/plain; charset=utf-8")

    # ------------------------------------------------------------------- GET
    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/health":
            return self._text("OK")
        if u.path == "/":
            return self._json({
                "app": "flytrip-bailian-app",
                "version": APP_VERSION,
                "runtime": "stdlib",
                "model": core.MODEL,
                "tools": bool(core.MCP_URL),
                "node_api": bool(core.NODE_API),
                "endpoints": ["GET /health", "POST /process", "GET /plan"],
            })
        if u.path == "/plan":
            q = parse_qs(u.query)
            text = (q.get("q") or [""])[0]
            if not text:
                text = "%s出发 %s 去%s 玩%s天" % (
                    (q.get("origin") or [""])[0], (q.get("date") or [""])[0],
                    (q.get("destination") or [""])[0], (q.get("days") or ["2"])[0])
            try:
                return self._json(core.build(text))
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)[:200]}, 500)
        return self._json({"error": "not found"}, 404)

    # ------------------------------------------------------------------ POST
    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path not in ("/process", "/plan"):
            return self._json({"error": "not found"}, 404)

        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                body = {}
        except Exception:  # noqa: BLE001
            return self._json({"error": {"code": "bad_request", "message": "body 不是合法 JSON"}}, 400)

        text = _extract_input(body)
        try:
            result = core.build(text)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": {"code": "internal", "message": str(e)[:200]}}, 500)

        if u.path == "/plan":
            return self._json(result)

        resp_id = f"response_{uuid.uuid4().hex[:16]}"
        session_id = body.get("session_id") or f"session_{uuid.uuid4().hex[:12]}"
        out_text = result.get("text") or ""

        # 流式：控制台测试面板 / Agent API 客户端常发 stream=true
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            def emit(obj):
                self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.flush()

            msg_id = f"msg_{uuid.uuid4().hex[:12]}"
            emit({"id": resp_id, "object": "response", "status": "created"})
            emit({"id": msg_id, "object": "message", "type": "message", "status": "created"})
            for line in out_text.split("\n"):
                emit({"status": "in_progress", "type": "text", "index": 0, "delta": True,
                      "text": line + "\n", "object": "content", "msg_id": msg_id})
            emit({"status": "completed", "type": "text", "index": 0, "delta": False,
                  "text": out_text, "object": "content", "msg_id": msg_id})
            emit({"id": msg_id, "status": "completed", "object": "message"})
            emit({"id": resp_id, "object": "response", "status": "completed"})
            # 显式结束：不用 chunked，靠关闭连接收尾
            self.close_connection = True
            return

        return self._json({
            "id": resp_id,
            "object": "response",
            "created_at": int(time.time()),
            "completed_at": int(time.time()),
            "error": None,
            "session_id": session_id,
            "output": [_msg(out_text)],
            "usage": None,
            "extra": {"ok": result.get("ok"), "intent": result.get("intent"),
                      "plan": result.get("plan", ""), "source": result.get("source", "")},
        })


def main():
    port = 8090
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"bailian-app (stdlib) listening on http://127.0.0.1:{port}", flush=True)
    print(f"  MCP_URL  = {core.MCP_URL or '(未配置)'}", flush=True)
    print(f"  MODEL    = {core.MODEL}", flush=True)
    print(f"  HAS_KEY  = {bool(core.DASHSCOPE_KEY)}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
