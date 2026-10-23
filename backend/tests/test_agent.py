"""Agent contracts using in-memory credentials, isolated SQLite and fake API/Google clients."""

from __future__ import annotations

import copy
import datetime as dt
import json
import uuid
from unittest.mock import Mock

import pytest
import requests
from sqlalchemy import func, select

from taskradar.connectors.agent import AgentClient, AgentError, AgentReply
from taskradar.db.agent_models import AgentTurn
from taskradar.db.calendar_models import CalendarDraft, WorkBlock
from taskradar.db.models import Setting, Task
from taskradar.db.session import transaction
from taskradar.domain.agent import AgentConfig, AgentConfigUpdate
from taskradar.domain.calendar import EventForm
from taskradar.domain.enums import Actor
from taskradar.services.agent import credential_name
from taskradar.services.agent_tools import AgentTools
from tests.conftest import add_task
from tests.test_calendar_workspace import END, PRIMARY, READONLY, START, event, form, setup

KEY = "test-agent-credential-never-export"


def call(name, arguments):
    return AgentReply("", [{"id": str(uuid.uuid4()), "name": name, "arguments": arguments}], [])


class ScriptedClient:
    def __init__(self, config, key, replies):
        assert key == KEY
        self.config = config
        self.replies = iter(replies)
        self.requests = []
        self.results = []

    def complete(self, system, messages, tools):
        self.requests.append((system, copy.deepcopy(messages), tools))
        reply = next(self.replies)
        return reply(self) if callable(reply) else reply

    def append_results(self, messages, reply, results):
        self.results.extend(results)
        messages.append({"role": "assistant", "content": json.dumps(results, ensure_ascii=False)})


def configure(c, replies, **kwargs):
    c.agent.configure(AgentConfigUpdate(api_key=KEY, **kwargs))
    client = ScriptedClient(c.agent.config(), KEY, replies)
    c.agent.client_factory = lambda config, key: client
    return client


def chat(c, text="帮我安排", request_id=None, conversation_id=None):
    return c.agent.chat(conversation_id or c.agent.new_conversation()["id"], request_id or str(uuid.uuid4()), text)


def count(c, model):
    with transaction(c.factory) as session:
        return session.scalar(select(func.count()).select_from(model))


def test_config_keys_are_secure_and_not_reused_from_legacy_feature(api):
    c = api.container
    c.secrets.set("openai_api_key", "legacy-unused")
    assert not api.get("/api/agent/config").json()["configured"]
    response = api.put("/api/agent/config", json={"api_key": KEY})
    assert response.status_code == 200 and response.json()["configured"]
    assert KEY not in response.text
    with transaction(c.factory) as session:
        assert KEY not in json.dumps(session.get(Setting, "agent").value)
    assert c.secrets.get(credential_name("anthropic")) == KEY
    assert KEY not in json.dumps(c.data.export())
    api.put(
        "/api/agent/config",
        json={"provider": "openai", "base_url": "https://api.openai.com/v1", "model": "gpt-5.4-mini"},
    )
    assert not api.get("/api/agent/config").json()["configured"]
    api.put("/api/agent/config", json={"provider": "anthropic"})
    assert api.get("/api/agent/config").json()["configured"]
    assert not api.delete("/api/agent/key").json()["configured"]


@pytest.mark.parametrize(
    "url",
    [
        "http://example.test/v1",
        "https://user:pass@example.test/v1",
        "https://example.test/v1?key=secret",
        "file:///tmp/api",
    ],
)
def test_invalid_provider_endpoints_are_rejected(api, url):
    assert api.put("/api/agent/config", json={"base_url": url}).status_code == 422


def test_local_api_and_missing_configuration(api):
    assert (
        api.put(
            "/api/agent/config",
            json={"provider": "openai_compatible", "base_url": "http://127.0.0.1:11434/v1", "model": "local-model"},
        ).status_code
        == 200
    )
    conversation = api.post("/api/agent/conversations").json()
    response = api.post(
        f"/api/agent/conversations/{conversation['id']}/messages",
        json={"text": "Hello", "request_id": str(uuid.uuid4())},
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "agent_not_configured"


def test_general_chat_does_not_read_or_mutate_workspace(container):
    client = configure(container, [AgentReply("番茄工作法使用固定专注与休息周期。", [], [])])
    add_task(container, "private title")
    result = chat(container, "解释番茄工作法")
    assert result["status"] == "completed" and not result["changes"]
    assert "private title" not in json.dumps(client.requests)
    assert "2026-10-14T10:00:00+02:00" in client.requests[0][1][-1]["content"]
    assert "Europe/Berlin" in client.requests[0][1][-1]["content"]
    assert "2026-10-14" not in client.requests[0][0]
    assert count(container, Task) == 1


def test_follow_up_replays_actual_change_state_in_message_order(container):
    client = configure(
        container,
        [
            call("create_task", {"title": "报告"}),
            AgentReply("请查看建议。", [], []),
            AgentReply("报告任务已经应用。", [], []),
        ],
    )
    conversation_id = container.agent.new_conversation()["id"]
    first = chat(container, "添加报告", conversation_id=conversation_id)
    container.agent.apply(first["id"])
    chat(container, "刚才创建了吗？", conversation_id=conversation_id)
    messages = client.requests[-1][1]
    assert messages[0]["content"] == client.requests[0][1][0]["content"]
    assert messages[0]["content"].endswith("添加报告")
    assert '"status":"pending"' in messages[1]["content"]
    assert '"status":"applied"' in messages[-1]["content"]
    assert messages[-1]["content"].endswith("刚才创建了吗？")
    assert [turn["user_text"] for turn in container.agent.history(conversation_id)["items"]] == [
        "添加报告",
        "刚才创建了吗？",
    ]


def test_workspace_disabled_omits_tools_and_rejects_unsolicited_calls(container):
    client = configure(container, [call("create_task", {"title": "must not exist"})], workspace_access=False)
    result = chat(container)
    assert client.requests[0][2] == []
    assert result["error"] == "agent_workspace_disabled" and not result["changes"]
    assert count(container, Task) == 0


def test_new_task_and_linked_work_block_are_previewed_then_applied_once(api):
    c = api.container

    def block_reply(client):
        task_id = client.results[-1]["result"]["details"]["task_id"]
        return call("save_work_block", {**form(title="写报告"), "task_id": task_id})

    configure(
        c,
        [
            call("create_task", {"title": "项目报告", "due_date": "2026-10-23", "priority": "high"}),
            block_reply,
            AgentReply("建议先在工作时段写报告。请检查并应用。", [], []),
        ],
    )
    conversation = api.post("/api/agent/conversations").json()["id"]
    request_id = str(uuid.uuid4())
    url = f"/api/agent/conversations/{conversation}/messages"
    body = {"text": "帮我创建报告任务并预留一小时写作", "request_id": request_id}
    turn = api.post(url, json=body).json()
    assert turn["status"] == "completed", turn
    assert len(turn["changes"]) == 2
    assert count(c, Task) == count(c, WorkBlock) == 0
    assert all(ch["status"] == "pending" for ch in turn["changes"])
    assert api.post(url, json=body).json()["id"] == request_id
    assert count(c, AgentTurn) == 1
    assert api.post(f"/api/agent/turns/{request_id}/apply", json={"confirm": False}).status_code == 422
    applied = api.post(f"/api/agent/turns/{request_id}/apply", json={"confirm": True}).json()
    assert [ch["status"] for ch in applied["changes"]] == ["applied", "applied"], applied
    api.post(f"/api/agent/turns/{request_id}/apply", json={"confirm": True})
    assert count(c, Task) == count(c, WorkBlock) == 1
    with transaction(c.factory) as session:
        task, block = session.scalar(select(Task)), session.scalar(select(WorkBlock))
        assert block.task_id == task.id and task.due_date == dt.date(2026, 10, 23)
        assert task.due_time is None  # A date-only deadline stays date-only.


def test_change_conflicts_preserve_manual_edits_and_partial_retry_is_idempotent(container):
    task_id = add_task(container, "old title")
    configure(
        container,
        [
            call("create_task", {"title": "new task"}),
            call("update_task", {"task_id": task_id, "changes": {"title": "AI title"}}),
            AgentReply("请检查两项建议。", [], []),
        ],
    )
    turn = chat(container)
    with transaction(container.factory) as session:
        task = container.tasks.get(session, task_id)
        container.tasks.update_fields(session, task, {"title": "manual title"}, actor=Actor.USER)
    result = container.agent.apply(turn["id"])
    assert [ch["status"] for ch in result["changes"]] == ["applied", "error"]
    assert result["changes"][1]["error"] == "agent_change_conflict"
    container.agent.apply(turn["id"])
    assert count(container, Task) == 2
    with transaction(container.factory) as session:
        assert container.tasks.get(session, task_id).title == "manual title"
    discarded = container.agent.discard(turn["id"])
    assert [ch["status"] for ch in discarded["changes"]] == ["applied", "skipped"]


def test_task_status_deadline_clear_and_recycle_bin(container):
    task_id = add_task(container, due=dt.date(2026, 10, 15), time=dt.time(10))
    configure(
        container,
        [
            call("update_task", {"task_id": task_id, "changes": {"status": "completed", "due_date": None}}),
            AgentReply("确认后将完成任务并清除日期。", [], []),
        ],
    )
    turn = chat(container)
    assert container.agent.apply(turn["id"])["changes"][0]["status"] == "applied"
    with transaction(container.factory) as session:
        task = container.tasks.get(session, task_id)
        assert task.status == "completed" and task.due_date is None and task.due_time is None
    configure(container, [call("delete_task", {"task_id": task_id}), AgentReply("确认后移入回收站。", [], [])])
    turn = chat(container)
    container.agent.apply(turn["id"])
    with transaction(container.factory) as session:
        assert container.tasks.get_trashed(session, task_id).deleted_at is not None


def test_unknown_tools_and_dst_ambiguity_become_tool_errors_without_changes(container):
    client = configure(
        container,
        [
            call("shell", {"command": "anything"}),
            call("create_task", {"title": "ambiguous", "due_date": "2026-10-25", "due_time": "02:30"}),
            call("save_work_block", form(start="2026-10-25T02:30", end="2026-10-25T04:00")),
            AgentReply("请明确夏令时切换时的时间。", [], []),
        ],
    )
    result = chat(container)
    assert not result["changes"]
    assert all("error" in r["result"] for r in client.results)
    assert "ambiguous" in json.dumps(client.results)


def test_overlaps_and_buffers_are_returned_in_proposals(container):
    container.workspace.save_block(None, EventForm(**form()))
    tools = AgentTools(container)
    result = tools.run("save_work_block", form(title="overlap", start="2026-10-22T10:30", end="2026-10-22T11:30"))
    assert result["conflicts"]["conflicts"][0]["title"] == "Write report"
    assert len(tools.changes) == 1


def test_omitted_event_timezone_uses_settings_and_unsupported_block_notes_are_rejected(container):
    container.settings.update({"general": {"timezone": "Asia/Shanghai"}})
    tools = AgentTools(container)
    args = form()
    args.pop("timezone")
    proposed = tools.run("save_work_block", args)
    assert proposed["details"]["timezone"] == "Asia/Shanghai"
    with pytest.raises(ValueError):
        tools.run("save_work_block", form(description="This must not be silently lost"))


def test_google_proposals_use_existing_permissions_and_conditional_writes(container, calendar_client):
    setup(container, calendar_client)
    original = event(calendar_client)
    container.workspace.refresh(START, END)
    configure(
        container,
        [
            call("get_calendar", {"start": START.isoformat(), "end": END.isoformat()}),
            call(
                "save_calendar_event",
                {
                    "operation": "update",
                    "calendar_id": PRIMARY,
                    "event_id": original["id"],
                    "event": form(title="Moved", start="2026-10-22T14:00", end="2026-10-22T15:00"),
                },
            ),
            AgentReply("请检查日程修改。", [], []),
        ],
    )
    turn = chat(container)
    assert len(turn["changes"]) == 1, turn
    assert calendar_client.get_event(PRIMARY, original["id"])["summary"] != "Moved"
    # A concurrent remote edit must not be overwritten by applying an older proposal.
    calendar_client.patch_event(PRIMARY, original["id"], {"summary": "Remote edit"}, original["etag"])
    applied = container.agent.apply(turn["id"])
    assert applied["changes"][0]["error"] == "event_conflict"
    assert calendar_client.get_event(PRIMARY, original["id"])["summary"] == "Remote edit"
    container.agent.discard(turn["id"])
    with transaction(container.factory) as session:
        assert session.get(CalendarDraft, turn["changes"][0]["id"]) is None
    with pytest.raises(ValueError, match="writable"):
        AgentTools(container).run(
            "save_calendar_event", {"operation": "create", "calendar_id": READONLY, "event": form()}
        )


def test_google_create_is_idempotent_and_chat_deletion_keeps_applied_items(container, calendar_client):
    setup(container, calendar_client)
    configure(
        container,
        [
            call("save_calendar_event", {"operation": "create", "calendar_id": PRIMARY, "event": form()}),
            AgentReply("将创建新日程。", [], []),
        ],
    )
    turn = chat(container)
    assert container.agent.apply(turn["id"])["changes"][0]["status"] == "applied"
    container.agent.apply(turn["id"])
    assert len(calendar_client.events) == 1
    container.agent.delete_conversation(turn["conversation_id"])
    assert count(container, AgentTurn) == 0 and len(calendar_client.events) == 1


def test_chat_failures_and_restart_leave_no_applicable_changes(container):
    configure(container, [call("create_task", {"title": "proposal before error"})])
    turn = chat(container)
    assert turn["status"] == "failed" and not turn["changes"]
    assert count(container, Task) == 0
    with transaction(container.factory) as session:
        row = session.get(AgentTurn, turn["id"])
        row.status, row.error = "running", None
    from taskradar.services.agent import AgentService

    restarted = AgentService(container)
    assert restarted.history(turn["conversation_id"])["items"][0]["error"] == "agent_interrupted"


def test_export_privacy_and_delete_all_include_chat_history(container):
    configure(container, [AgentReply("private answer", [], [])])
    chat(container, "private question")
    exported = container.data.export()
    assert exported["agent_turns"][0]["assistant_text"] == "private answer"
    assert "private answer" not in json.dumps(container.data.export(include_content=False))
    assert "private question" not in json.dumps(container.data.export(include_content=False))
    deleted = container.data.delete_all()
    assert deleted["agent_turns"] == deleted["agent_conversations"] == 1
    assert not container.agent.conversations()


@pytest.mark.parametrize("provider", ["anthropic", "openai", "openai_compatible"])
def test_provider_protocol_round_trip_and_keys_stay_in_headers(monkeypatch, provider):
    function_call = {"name": "find_tasks", "arguments": {"query": "report"}}
    if provider == "anthropic":
        body = {
            "content": [
                {"type": "tool_use", "id": "c1", "name": function_call["name"], "input": function_call["arguments"]}
            ]
        }
    elif provider == "openai":
        body = {
            "status": "completed",
            "output": [
                {"type": "reasoning", "encrypted_content": "opaque"},
                {
                    "type": "function_call",
                    "call_id": "c1",
                    "name": function_call["name"],
                    "arguments": json.dumps(function_call["arguments"]),
                },
            ],
        }
    else:
        body = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "c1",
                                "type": "function",
                                "function": {
                                    "name": function_call["name"],
                                    "arguments": json.dumps(function_call["arguments"]),
                                },
                            }
                        ],
                    }
                }
            ]
        }
    post = Mock(return_value=Mock(status_code=200, json=lambda: body))
    monkeypatch.setattr(requests, "post", post)
    client = AgentClient(AgentConfig(provider=provider, base_url="https://example.test/v1"), KEY)
    messages = [{"role": "user", "content": "report"}]
    result = client.complete(
        "system", messages, [{"name": "find_tasks", "description": "find", "parameters": {"type": "object"}}]
    )
    assert result.calls[0]["arguments"] == {"query": "report"}
    assert KEY not in json.dumps(post.call_args.kwargs["json"])
    assert KEY in json.dumps(post.call_args.kwargs["headers"])
    assert post.call_args.kwargs["allow_redirects"] is False
    client.append_results(messages, result, [{"id": "c1", "result": {"items": []}}])
    assert "items" in json.dumps(messages)
    if provider == "openai":
        assert messages[1]["encrypted_content"] == "opaque"
        assert post.call_args.kwargs["json"]["store"] is False


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "agent_auth_failed"),
        (429, "agent_rate_limited"),
        (500, "agent_provider_error"),
        (307, "agent_provider_error"),
    ],
)
def test_provider_errors_never_echo_response_bodies(monkeypatch, status, code):
    monkeypatch.setattr(requests, "post", Mock(return_value=Mock(status_code=status, text=KEY)))
    with pytest.raises(AgentError) as error:
        AgentClient(AgentConfig(), KEY).complete("private prompt", [], [])
    assert error.value.code == code and KEY not in str(error.value)
