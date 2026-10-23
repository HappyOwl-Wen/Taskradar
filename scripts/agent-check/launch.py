"""UI fixture: real Agent HTTP transport, scripted local Claude-compatible API, no real accounts.

Run after building the frontend. Both servers bind only to loopback; data stays inside build/agent-check.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fake_cache import FixturePromptCache

from taskradar.api.app import create_app
from taskradar.config import AppConfig
from taskradar.connectors.calendar import FakeCalendarClient
from taskradar.container import build_container
from taskradar.domain.agent import AgentConfigUpdate
from taskradar.security.secrets import MemorySecretStore

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8146)
parser.add_argument("--data-dir", type=Path, default=ROOT / "build" / "agent-check" / "data")
args = parser.parse_args()
data_dir = args.data_dir.resolve()
if not data_dir.is_relative_to(ROOT / "build" / "agent-check"):
    raise SystemExit("Use a scratch folder inside build/agent-check")

fake_api = FastAPI()
prefix_cache = FixturePromptCache()


def reply(content):
    return {"id": "synthetic-message", "role": "assistant", "type": "message", "stop_reason": "tool_use" if content[0]["type"] == "tool_use" else "end_turn", "content": content}


def tool(id, name, arguments):
    return reply([{"type": "tool_use", "id": id, "name": name, "input": arguments}])


@fake_api.get("/v1/models")
async def models():
    return {"data": [{"id": model, "display_name": name, "capabilities": {
        "effort": {"supported": True, **{level: {"supported": True} for level in ("low", "medium", "high", "xhigh", "max")}},
        "thinking": {"supported": True, "types": {"adaptive": {"supported": True}}},
    }} for model, name in (("claude-sonnet-5-5", "Claude Sonnet · Demo"), ("claude-haiku-5-5", "Claude Haiku · Demo"))], "has_more": False}


@fake_api.post("/v1/messages")
async def messages(request: Request):
    body = await request.json()
    usage = prefix_cache.usage(body)

    def finish(result):
        return {**result, "usage": {**usage, "output_tokens": max(1, len(json.dumps(result["content"], ensure_ascii=False)) // 4)}}

    system = body["system"]
    if isinstance(system, list):
        system = "\n".join(block["text"] for block in system if block["type"] == "text")
    if system.startswith("Generate one concise conversation title"):
        return finish(reply([{"type": "text", "text": "专注节奏与明日计划"}]))
    if system.startswith("Suggest exactly three"):
        return finish(reply([{"type": "text", "text": json.dumps(["帮我安排明天的报告写作时间", "解释怎样选择专注时长", "总结当前未应用的方案"], ensure_ascii=False)}]))
    latest = body["messages"][-1]["content"]
    if isinstance(latest, list) and all(block["type"] == "text" for block in latest):
        latest = "\n".join(block["text"] for block in latest)
    if isinstance(latest, str):
        latest = latest.rsplit("[User message]\n", 1)[-1]
        if any(word in latest.lower() for word in ("安排", "plan", "报告", "report")):
            return finish(tool("read_calendar", "get_calendar", {"start": "2026-10-24", "end": "2026-10-25"}))
        return finish(reply([{"type": "text", "text": "## 让专注有节奏\n\n番茄工作法把工作分成 **专注** 与 **休息** 两个阶段。\n\n| 阶段 | 时长 |\n| --- | --- |\n| 专注 | 25 分钟 |\n| 短休息 | 5 分钟 |\n\n- [x] 选择一个小目标\n- [ ] 完成四轮后稍长休息\n\n```text\n专注 → 休息 → 复盘\n```\n\n每天四轮的专注时间：\\(4 \\times 25 = 100\\) 分钟。\n\n你可以在番茄钟页面调整时长。"}]))
    result = latest[-1]
    if result["tool_use_id"] == "read_calendar":
        return finish(tool("task_create", "create_task", {"title": "完成项目报告", "due_date": "2026-10-30", "priority": "high", "description": "整理项目进展，完成报告初稿。"}))
    if result["tool_use_id"] == "task_create":
        task_id = json.loads(result["content"])["details"]["task_id"]
        return finish(tool("work_create", "save_work_block", {"title": "项目报告 · 初稿写作", "start": "2026-10-24T09:00", "end": "2026-10-24T10:30", "timezone": "Europe/Berlin", "task_id": task_id}))
    return finish(reply([{"type": "text", "text": "### 明日写作计划\n\n1. 添加 **完成项目报告**，截止到 10 月 30 日，优先级为高。\n2. 明天 **09:00–10:30** 预留写作时段，并关联这项待办。\n\n请查看下面的具体安排及应用状态。"}]))


fake = FakeCalendarClient()
c = build_container(
    AppConfig(data_dir=data_dir, port=args.port, open_browser=False, scheduler_enabled=False),
    secrets=MemorySecretStore(), calendar_client_factory=lambda: fake,
    clock=lambda: dt.datetime(2026, 10, 23, 8, tzinfo=dt.UTC), toast=lambda title, body: True,
)
c.agent.configure(AgentConfigUpdate(base_url=f"http://127.0.0.1:{args.port + 1}/v1", api_key="synthetic-ui-fixture"))
provider = uvicorn.Server(uvicorn.Config(fake_api, host="127.0.0.1", port=args.port + 1, log_level="warning"))
thread = threading.Thread(target=provider.run, daemon=True)
thread.start()
try:
    uvicorn.run(create_app(c), host="127.0.0.1", port=args.port, log_level="warning")
finally:
    provider.should_exit = True
    thread.join(timeout=3)
    c.dispose()
