"""Cache wire format, stable-prefix replay and truthful per-turn usage accounting."""

from __future__ import annotations

import copy
import datetime as dt
import json
from unittest.mock import Mock

import pytest
import requests

from taskradar.connectors.agent import AgentClient, AgentError, AgentReply, claude_cache_payload
from taskradar.domain.agent import AgentConfig, AgentConfigUpdate, AgentPreferences
from taskradar.services.agent_usage import add_usage
from tests.test_agent import KEY, call, chat, configure


def response(content=None, usage=None):
    body = {"content": content or [{"type": "text", "text": "ok"}]}
    if usage is not None:
        body["usage"] = usage
    return Mock(status_code=200, json=lambda: body)


@pytest.mark.parametrize("ttl", ["off", "5m", "1h"])
def test_claude_cache_controls_use_compatible_block_markers(monkeypatch, ttl):
    post = Mock(return_value=response())
    monkeypatch.setattr(requests, "post", post)
    client = AgentClient(AgentConfig(prompt_cache=ttl), KEY)
    messages = [{"role": "user", "content": "hello"}]
    original = copy.deepcopy(messages)
    client.complete("fixed system", messages, [])
    payload = post.call_args.kwargs["json"]
    assert messages == original and "cache_control" not in payload
    if ttl == "off":
        assert payload["system"] == "fixed system" and payload["messages"] == original
    else:
        expected = {"type": "ephemeral", **({"ttl": "1h"} if ttl == "1h" else {})}
        assert payload["system"][0]["cache_control"] == expected
        assert payload["messages"][0]["content"][0]["cache_control"] == expected


def test_tool_round_keeps_user_anchor_and_caches_suffix_without_marking_thinking():
    messages = [{"role": "user", "content": "hello"}]
    original = claude_cache_payload("stable", messages, "5m")
    messages += [
        {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "opaque", "signature": "signature"},
                {"type": "tool_use", "id": "c", "name": "find_tasks", "input": {}},
            ],
        },
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c", "content": "result"}]},
    ]
    payload = claude_cache_payload("stable", messages, "5m")
    assert payload["system"] == original["system"] and payload["messages"][0] == original["messages"][0]
    assert payload["messages"][-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in payload["messages"][1]["content"][0]
    assert json.dumps(payload).count('"cache_control"') == 3
    assert "cache_control" not in json.dumps(messages)


def test_cache_headers_never_leak_to_other_protocols(monkeypatch):
    body = {"output": [], "choices": [{"message": {"content": "ok"}}]}
    post = Mock(return_value=Mock(status_code=200, json=lambda: body))
    monkeypatch.setattr(requests, "post", post)
    for provider in ("openai", "openai_compatible"):
        AgentClient(AgentConfig(provider=provider, prompt_cache="1h"), KEY).complete("system", [], [])
        assert "cache_control" not in json.dumps(post.call_args.kwargs["json"])


def test_runtime_changes_and_application_do_not_rewrite_a_cached_prefix(container):
    client = configure(
        container,
        [
            call("create_task", {"title": "report"}),
            AgentReply("Proposed", [], []),
            AgentReply("Pending", [], []),
            AgentReply("Applied", [], []),
        ],
    )
    first = chat(container, "create report")
    chat(container, "what is pending?", conversation_id=first["conversation_id"])
    cached_prefix = copy.deepcopy(client.requests[-1][1])
    container.agent.apply(first["id"])
    container.agent.preferences(AgentPreferences(execution_mode="yolo"))
    container.clock = lambda: dt.datetime(2026, 10, 15, 12, tzinfo=dt.UTC)
    last = chat(container, "what was applied?", conversation_id=first["conversation_id"])
    messages = client.requests[-1][1]
    assert messages[: len(cached_prefix)] == cached_prefix
    assert len({request[0] for request in client.requests}) == 1
    assert '"now":"2026-10-15T14:00:00+02:00"' in messages[-1]["content"]
    assert '"status":"applied"' in messages[-1]["content"]
    assert '"execution_mode":"yolo"' in messages[-1]["content"]
    assert not any(key.startswith("_") for key in last["options"])
    assert all(
        not any(k.startswith("_") for k in t["options"])
        for t in container.agent.history(first["conversation_id"])["items"]
    )
    assert "_request_text" in json.dumps(container.data.export())
    assert "_request_text" not in json.dumps(container.data.export(include_content=False))


def test_legacy_history_gets_a_frozen_receipt_and_actual_text_is_bounded(container):
    client = configure(container, [AgentReply("answer" * 900, [], []) for _ in range(5)])
    first = chat(container, "legacy question")
    from taskradar.db.agent_models import AgentTurn
    from taskradar.db.session import transaction

    with transaction(container.factory) as session:
        session.get(AgentTurn, first["id"]).options = {}
    for _ in range(4):
        chat(container, "long question" * 400, conversation_id=first["conversation_id"])
    assert sum(len(m["content"]) for m in client.requests[-1][1]) <= 30000
    assert len(client.requests[-1][1]) < 9


def test_wire_usage_is_aggregated_across_tool_rounds_and_retry_keeps_receipt(container, monkeypatch):
    container.agent.configure(AgentConfigUpdate(api_key=KEY))
    first_usage = {
        "input_tokens": 100,
        "cache_creation_input_tokens": 2000,
        "cache_read_input_tokens": 0,
        "output_tokens": 20,
    }
    second_usage = {
        "input_tokens": 50,
        "cache_creation_input_tokens": 100,
        "cache_read_input_tokens": 2000,
        "output_tokens": 30,
    }
    post = Mock(
        side_effect=[
            response(
                [{"type": "tool_use", "id": "c1", "name": "create_task", "input": {"title": "report"}}], first_usage
            ),
            response(usage=second_usage),
        ]
    )
    monkeypatch.setattr(requests, "post", post)
    turn = chat(container)
    usage = turn["options"]["usage"]["chat"]
    assert usage["requests"] == usage["reported_requests"] == 2
    assert usage["cache_read_input_tokens"] == 2000 and usage["cache_creation_input_tokens"] == 2100
    assert usage["input_tokens"] == 150 and usage["output_tokens"] == 50 and usage["total_input_tokens"] == 4250
    again = chat(container, request_id=turn["id"], conversation_id=turn["conversation_id"])
    assert again["options"]["usage"] == turn["options"]["usage"] and post.call_count == 2


def test_optional_calls_have_separate_usage_and_unknown_is_not_zero(container):
    usage = {
        "input_tokens": 50,
        "cache_creation_input_tokens": 1000,
        "cache_read_input_tokens": 2000,
        "output_tokens": 20,
    }
    configure(
        container,
        [
            AgentReply("Answer", [], [], usage),
            AgentReply("Title", [], [], usage),
            AgentReply('["Next?", "Why?", "How?"]', [], []),
        ],
        title_mode="model",
        prompt_suggestions="model",
    )
    turn = chat(container)
    ledger = turn["options"]["usage"]
    assert ledger["chat"]["cache_read_input_tokens"] == ledger["title"]["cache_read_input_tokens"] == 2000
    assert ledger["suggestions"]["reported_requests"] == 0
    assert "cache_read_input_tokens" not in ledger["suggestions"]


def test_partial_usage_errors_and_invalid_counters_are_not_fabricated(monkeypatch):
    post = Mock(
        return_value=response(
            usage={
                "input_tokens": 5,
                "cache_creation_input_tokens": -1,
                "cache_read_input_tokens": True,
                "output_tokens": "10",
            }
        )
    )
    monkeypatch.setattr(requests, "post", post)
    reply = AgentClient(AgentConfig(), KEY).complete("", [], [])
    assert reply.usage == {"input_tokens": 5}
    first = add_usage({}, reply.usage, model="model")
    assert first["input_tokens"] == 5 and "total_input_tokens" not in first
    failed = add_usage(first, None, model="model")
    assert failed["requests"] == 2 and failed["reported_requests"] == 1
    assert "input_tokens" not in failed and "cache_read_input_tokens" not in failed


def test_failed_call_attempt_is_recorded_without_false_cache_miss(container):
    def fail(_):
        raise AgentError("agent_timeout")

    configure(container, [fail])
    turn = chat(container)
    assert turn["status"] == "failed"
    assert turn["options"]["usage"]["chat"]["requests"] == 1
    assert "cache_read_input_tokens" not in turn["options"]["usage"]["chat"]
