"""
flytrip-bailian-app · 核心逻辑（纯标准库，零第三方依赖）
====================================================================
把"解析意图 → 调飞猪 MCP 工具 → 让 qwen 编排"这条链独立出来，
好处有两个：
  1. 本地不装 fastapi 也能直接测（python core.py "成都出发 10-27 去丽江 玩2天"）；
  2. 云端依赖只有 fastapi + uvicorn，构建失败的变量更少。

main.py 只负责把这里的能力包成 /health、/process 两个 HTTP 接口。
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List

def _read_dashscope_key() -> str:
    """优先环境变量，其次用户级配置。这样启动脚本不必把 Key 写到明面上。"""
    k = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if k:
        return k
    try:
        p = os.path.join(os.path.expanduser("~"), ".bailian", "config.json")
        with open(p, "r", encoding="utf-8") as f:
            return (json.load(f) or {}).get("DASHSCOPE_API_KEY", "") or ""
    except Exception:  # noqa: BLE001
        return ""


DASHSCOPE_KEY = _read_dashscope_key()
MODEL = os.getenv("MODEL", "qwen-plus")
BASE_URL = os.getenv("DASHSCOPE_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")
MCP_URL = os.getenv("MCP_URL", "http://127.0.0.1:8099/mcp")
NODE_API = os.getenv("NODE_API", "").rstrip("/")

HTTP_TIMEOUT = 25
LLM_TIMEOUT = 30

SYSTEM_PROMPT = """你是一个严谨的中文旅行行程助手，只负责把"已核实的行程要点"润色成通顺、可读的安排，绝不创造任何信息。

# 输入格式
用户消息是若干行要点，每行形如 `[标签] 内容`。标签含义：
- 去：去程交通（真实车次/航班、时刻、时长、票价如有）
- 返：返程信息（仅当用户选了"往返"才出现）
- 玩：当地必看景点 / 必吃（来自真实数据源）
- 住：住宿区位建议

这些要点都是系统从真实数据源（飞猪开放平台航班/车次/酒店/景点）取到的"已核实事实"。

# 硬规则（违反任一条都算失败）
1. 只能使用输入里给出的事实。禁止新增任何地点、店名、票价、时刻、车次/航班号、时长——输入没有的，一个字都不要写。
2. 若某条要点写明"暂未取到 / 建议自行查询 / 需中转"，你必须原样保留这个提醒，禁止编造一个来补位。
3. 不解释、不道歉、不写"根据您的要求"等套话，直接给安排。

# 输出格式
- 改写成 3~4 行中文，每行以"· "开头，每行不超过 40 个汉字。
- 必须换行，不要把多行并成一段。
- 不要标题、不要序号、不要任何 markdown。
- 直接输出这几行，前后不要多余空行。"""


# ------------------------------------------------------------------ HTTP

def _post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str] | None = None,
               timeout: int = HTTP_TIMEOUT) -> Dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ------------------------------------------------------------- 飞猪 MCP

def call_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """通过 MCP JSON-RPC 调一个工具；任何失败都返回 {ok:false}，绝不抛给上层。"""
    if not MCP_URL:
        return {"ok": False, "error": "未配置 MCP_URL"}
    body = {"jsonrpc": "2.0", "id": int(time.time() * 1000),
            "method": "tools/call", "params": {"name": name, "arguments": args}}
    try:
        j = _post_json(MCP_URL, body, timeout=HTTP_TIMEOUT)
        if "error" in j:
            return {"ok": False, "error": str(j["error"].get("message", ""))}
        return json.loads(j["result"]["content"][0]["text"])
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001 工具挂了不该炸掉整个请求
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}


# --------------------------------------------------------------- 意图解析

CITY_PAIR_RE = re.compile(r"从([\u4e00-\u9fa5]{2,6})(?:到|去|飞往|前往|飞)([\u4e00-\u9fa5]{2,6})")
ORIGIN_RE = re.compile(r"(?:从|由|在)?([\u4e00-\u9fa5]{2,6})(?:出发|出发地|起飞)")
DEST_RE = re.compile(r"(?:去|到|飞往|前往|飞)([\u4e00-\u9fa5]{2,6})")
# 城市名后面常常直接跟动词："去丽江玩3日" → 要切掉"玩"
CITY_STOP_RE = re.compile(r"[玩住吃游逛旅天地日行程\s\d]")
DATE_RE = re.compile(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})")
DATE_RE2 = re.compile(r"(\d{1,2})月(\d{1,2})日")
DATE_RE3 = re.compile(r"(?<!\d)(\d{1,2})[-/](\d{1,2})(?!\d)")
DAYS_RE = re.compile(r"(\d+)\s*天")
# "玩3日"也能识别，但要避开"10月27日"（否则会从"7日"里错抓出 7 天）
DAYS_RE_R = re.compile(r"(?<![\d月])(\d+)\s*日")
DAYS_CN = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
DAYS_CN_RE = re.compile(r"([一两二三四五六七八九十])\s*天")


def parse_intent(text: str) -> Dict[str, Any]:
    t = (text or "").strip()

    # 城市：先看"从A到B"，再分别看"X出发"和"去Y"
    origin = destination = ""
    m = CITY_PAIR_RE.search(t)
    if m:
        origin, destination = m.group(1), m.group(2)
    else:
        m = ORIGIN_RE.search(t)
        if m:
            origin = m.group(1)
        m = DEST_RE.search(t)
        if m:
            destination = m.group(1)

    # "去丽江玩3日" 会被抓成"丽江玩"，这里按停用字切开取前段
    origin = CITY_STOP_RE.split(origin)[0] if origin else ""
    destination = CITY_STOP_RE.split(destination)[0] if destination else ""
    if len(origin) < 2:
        origin = ""
    if len(destination) < 2:
        destination = ""

    today = _dt.date.today()
    date = ""
    m = DATE_RE.search(t)
    if m:
        try:
            date = _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            date = ""
    if not date:
        for rx in (DATE_RE2, DATE_RE3):        # 只给了"10月27日"或"10-27"时按今年算
            m = rx.search(t)
            if not m:
                continue
            try:
                cand = _dt.date(today.year, int(m.group(1)), int(m.group(2)))
                if cand < today:                  # 已过则视为明年
                    cand = _dt.date(today.year + 1, cand.month, cand.day)
                date = cand.isoformat()
                break
            except ValueError:
                continue
    if not date:
        date = (today + _dt.timedelta(days=7)).isoformat()

    days = 2
    m = DAYS_RE.search(t) or DAYS_RE_R.search(t)
    if m:
        days = max(1, min(10, int(m.group(1))))
    else:
        m = DAYS_CN_RE.search(t)
        if m:
            days = max(1, min(10, DAYS_CN.get(m.group(1), 2)))

    return {"origin": origin, "destination": destination, "date": date, "days": days}


# ------------------------------------------------------------ 事实收集

def collect_facts(it: Dict[str, Any]) -> Dict[str, Any]:
    """依次拿交通 / 景点 / 酒店。MCP 侧本身就是串行限流的，这里顺序调用即可。"""
    facts: Dict[str, Any] = {"flight": [], "train": [], "poi": [], "hotel": [], "errors": []}
    o, d, date = it["origin"], it["destination"], it["date"]

    def take(bucket: str, label: str, resp: Dict[str, Any]) -> None:
        """成功就把 items 摊进桶里，失败记一条原因（不抛异常）。"""
        if resp.get("ok"):
            facts[bucket].extend(resp.get("items") or [])
        else:
            facts["errors"].append(f"{label}：{resp.get('error', '无数据')}")

    if o and d:
        take("flight", "机票", call_tool("search_flight", {
            "origin": o, "destination": d, "dep_date": date, "journey_type": 1, "limit": 3}))
        take("train", "车次", call_tool("search_train", {
            "origin": o, "destination": d, "dep_date": date, "journey_type": 1, "limit": 3}))

    if d:
        take("poi", "景点", call_tool("search_poi", {"city": d, "limit": 4}))

        try:
            check_out = (_dt.date.fromisoformat(date) + _dt.timedelta(days=it["days"])).isoformat()
        except ValueError:
            check_out = ""
        take("hotel", "酒店", call_tool("search_hotel", {
            "city": d, "check_in": date, "check_out": check_out, "limit": 3}))

    return facts


def short_name(n: str, limit: int = 14) -> str:
    """
    酒店名常带「（分店名）」「·品牌」「丨系列」后缀，硬切会切出「（丽江古城南…」这种废字。
    优先在这些分隔符处断开，取能认出来的主名。
    """
    n = (n or "").strip()
    if not n:
        return ""
    if len(n) <= limit:
        return n
    for sep in ("（", "(", "丨", "｜", "|", "·", "－", "-"):
        i = n.find(sep)
        if 4 <= i <= limit:
            return n[:i]
    return n[:limit] + "…"


def facts_to_lines(it: Dict[str, Any], f: Dict[str, Any]) -> List[Dict[str, str]]:
    """把事实折成 [去][玩][住] 三条要点，喂给模型。"""
    lines: List[Dict[str, str]] = []

    if f["flight"]:
        x = f["flight"][0]
        lines.append({
            "k": "去",
            "t": f"{x['flight_no']} {x.get('from_airport', it['origin'])} {x['dep_time']} 起飞，"
                 f"{x.get('to_airport', it['destination'])} {x['arr_time']} 到，"
                 f"约 {x.get('duration_hours')}h，经济舱 {x.get('price_text') or '票价需查询'}",
        })
    elif f["train"]:
        x = f["train"][0]
        lines.append({
            "k": "去",
            "t": f"{x['train_no']} {x['from_station']} {x['dep_time']} 出发，"
                 f"{x['to_station']} {x['arr_time']} 到，约 {x.get('duration_hours')}h，"
                 f"{x.get('price_text') or '票价需查询'}",
        })
    else:
        lines.append({"k": "去", "t": "暂未取到直达班次，建议自行查询或考虑中转"})

    if f["poi"]:
        names = "、".join(x["name"] for x in f["poi"][:4])
        lines.append({"k": "玩", "t": f"{names}（均为当地真实在售景点）"})
    else:
        lines.append({"k": "玩", "t": "景点数据暂未取到，建议自行查询"})

    if f["hotel"]:
        names = "；".join(f"{short_name(x['name'])}（{x.get('price_text') or '价格需查询'}）"
                          for x in f["hotel"][:2])
        lines.append({"k": "住", "t": f"可选：{names}"})
    else:
        lines.append({"k": "住", "t": "住宿建议自行查询"})

    return lines


# ------------------------------------------------------------------ 大模型

def llm_polish(lines: List[Dict[str, str]]) -> str:
    """调 qwen 润色。失败返回空串，由上层退回模板文案（绝不伪造 AI 输出）。"""
    if not DASHSCOPE_KEY:
        return ""
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(f"[{l['k']}] {l['t']}" for l in lines)},
        ],
        "temperature": 0.3,
    }
    try:
        j = _post_json(BASE_URL.rstrip("/") + "/chat/completions", payload,
                       headers={"Authorization": f"Bearer {DASHSCOPE_KEY}"}, timeout=LLM_TIMEOUT)
        return (j["choices"][0]["message"]["content"] or "").strip()
    except Exception:  # noqa: BLE001
        return ""


BULLET = re.compile(r"^[·\-*•]\s*")


def clip(s: str, n: int) -> str:
    """裁到 n 字以内，但绝不在括号/价格中间下刀。"""
    if len(s) <= n:
        return s
    cut = s[:n]
    # 优先级 1：括号没闭合 → 退到最近的「（」前。
    # 否则会切出「（¥1」这种半截价，看起来像 1 块钱，比不显示更糟。
    if cut.count("（") > cut.count("）"):
        i = cut.rfind("（")
        if i > 0:
            return cut[:i]
    # 优先级 2：能退到标点/空格就退，避免把词劈开
    for sep in ("，", "、", "；", " "):
        i = cut.rfind(sep)
        if i >= n - 10:
            return cut[:i]
    return cut


def to_bullets(text: str, max_line: int = 48, max_lines: int = 4) -> str:
    """和 Node 侧 planfmt.mjs 同样的兜底：模型写成一整段也强行拆成「· 」短行。"""
    s = (text or "").replace("\r", "")
    s = re.sub(r"^[ \t]*#{1,6}[^\n]*$", "", s, flags=re.M)
    s = s.replace("**", "").replace("`", "")
    s = re.sub(r"^[ \t]*[-*•·][ \t]+", "", s, flags=re.M).strip()
    if not s:
        return ""

    rows = [x.strip() for x in s.split("\n") if x.strip()]
    if len(rows) >= 2:
        return "\n".join("· " + clip(r, max_line) for r in rows[:max_lines + 1])

    parts: List[str] = []
    for seg in re.split(r"[。；;！!？?]+", s):
        if not seg:
            continue
        if len(seg) <= max_line:
            parts.append(seg)
        else:
            parts.extend([x for x in re.split(r"[，,、]+", seg) if x])

    out, cur = [], ""
    for p in parts:
        p = p.strip().rstrip("，,、")
        if not p:
            continue
        if not cur:
            cur = p
        elif len(cur + "，" + p) <= max_line:
            cur += "，" + p
        else:
            out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return "\n".join("· " + clip(x, max_line) for x in out[:max_lines])


# ------------------------------------------------------------ 主流程

def build(text: str) -> Dict[str, Any]:
    it = parse_intent(text)
    if not it["destination"]:
        return {
            "ok": False,
            "need": "destination",
            "text": "请告诉我出发城市、目的地和日期，例如「成都出发 10-27 去丽江 玩2天」。",
            "intent": it,
        }

    facts = collect_facts(it)
    lines = facts_to_lines(it, facts)
    raw = llm_polish(lines)          # 空串 = 模型不可用，下面退回模板文案
    plan = to_bullets(raw)
    if not plan:
        plan = "\n".join("· " + l["t"][:40] for l in lines)

    links: List[str] = []
    if facts["flight"] and facts["flight"][0].get("book_url"):
        links.append(f"机票下单：{facts['flight'][0]['book_url']}")
    if facts["hotel"] and facts["hotel"][0].get("book_url"):
        links.append(f"酒店预订：{facts['hotel'][0]['book_url']}")

    return {
        "ok": True,
        "text": plan + ("\n" + "\n".join(links) if links else ""),
        "plan": plan,
        "intent": it,
        "facts": facts,
        "source": "llm" if raw else "template",
    }


if __name__ == "__main__":
    import sys

    q = " ".join(sys.argv[1:]) or "成都出发 10-27 去丽江 玩2天"
    r = build(q)
    print(json.dumps({k: v for k, v in r.items() if k != "facts"}, ensure_ascii=False, indent=2))
    f = r.get("facts", {})
    print("\n-- 事实统计 --")
    for k in ("flight", "train", "poi", "hotel", "errors"):
        v = f.get(k, [])
        print(f"{k}: {len(v) if isinstance(v, list) else v}")
        if k == "errors" and v:
            for e in v:
                print("   ", e)
