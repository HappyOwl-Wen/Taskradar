"""Model discovery, provider thinking parameters and opt-in Agent automation contracts."""

from __future__ import annotations

import json
import uuid
from unittest.mock import Mock

import pytest
import requests

from taskradar.connectors.agent import AgentClient, AgentError, AgentReply
from taskradar.db.agent_models import AgentTurn
from taskradar.db.models import Task
from taskradar.db.session import transaction
from taskradar.domain.agent import AgentConfig, AgentPreferences
from taskradar.domain.agent_models import model_info
from taskradar.services.agent import AgentService
from taskradar.services.agent_catalog import AgentCatalog
from tests.test_agent import KEY, ScriptedClient, call, chat, configure, count
from tests.test_calendar_workspace import END, PRIMARY, START, event, form, setup


def response(body, status=200):
    return Mock(status_code=status, json=lambda: body, text=KEY)


def test_reported_capabilities_override_rules_and_unknown_variants_stay_auto():
    raw = {"capabilities": {"effort": {"low": {"supported": True}}, "thinking": {"types": {}}}}
    info = model_info("anthropic", "claude-sonnet-4-6", raw)
    assert info["reasoning_levels"] == ["auto", "low"] and info["capability_source"] == "api"
    assert "xhigh" not in model_info("anthropic", "claude-sonnet-4-6")["reasoning_levels"]
    assert model_info("anthropic", "claude-sonnet-4-5")["reasoning_kind"] == "budget"
    malformed = {"capabilities": {"effort": True, "thinking": "unknown"}}
    assert model_info("anthropic", "unrecognized", malformed)["reasoning_levels"] == ["auto"]
    assert model_info("anthropic", "claude-sonnet-4-6", {"capabilities": {"effort": {"supported": False}}})[
        "reasoning_levels"
    ] == ["auto"]
    for name in ("custom-model", "gpt-5.4-pro", "gpt-5.2-chat-latest", "o3-deep-research"):
        assert model_info("openai", name)["reasoning_levels"] == ["auto"]
    assert "xhigh" in model_info("openai", "gpt-5.4-mini-2026-03-17")["reasoning_levels"]
    assert model_info("openai", "text-embedding-3-small")["usable"] is False
    assert model_info("anthropic", "retired", {"lifecycle": "retired"})["usable"] is False


def test_catalog_paginates_caches_by_credentials_and_returns_detached_results(monkeypatch):
    get = Mock(
        side_effect=[
            response({"data": [{"id": "a"}], "has_more": True, "last_id": "a"}),
            response({"data": [{"id": "b"}], "has_more": False}),
            response({"data": [{"id": "c"}]}),
            response({"data": [{"id": "d"}]}),
        ]
    )
    monkeypatch.setattr(requests, "get", get)
    catalog, config = AgentCatalog(), AgentConfig()
    found = catalog.discover(config, KEY)
    assert [m["id"] for m in found["models"]] == ["a", "b"]
    assert get.call_args.kwargs["params"]["after_id"] == "a"
    assert get.call_args.kwargs["headers"]["x-api-key"] == KEY
    assert get.call_args.kwargs["allow_redirects"] is False
    found["models"].clear()
    assert len(catalog.discover(config, KEY)["models"]) == 2 and get.call_count == 2
    assert catalog.discover(config, "different-key")["models"][0]["id"] == "c"
    assert catalog.discover(config, KEY, refresh=True)["models"][0]["id"] == "d"
    assert KEY not in json.dumps(catalog.cache)


@pytest.mark.parametrize(
    "status,code",
    [
        (404, "agent_models_unavailable"),
        (401, "agent_auth_failed"),
        (429, "agent_rate_limited"),
        (307, "agent_provider_error"),
    ],
)
def test_discovery_failures_are_sanitized(monkeypatch, status, code):
    monkeypatch.setattr(requests, "get", Mock(return_value=response({}, status)))
    with pytest.raises(AgentError) as exc:
        AgentCatalog().discover(AgentConfig(), KEY)
    assert exc.value.code == code and KEY not in str(exc.value)


def test_discovery_rejects_invalid_pagination_and_honors_compatible_metadata(monkeypatch):
    get = Mock(return_value=response({"data": [{"id": "local", "reasoning_efforts": ["low", "high"]}]}))
    monkeypatch.setattr(requests, "get", get)
    config = AgentConfig(provider="openai_compatible", model="local")
    catalog = AgentCatalog()
    catalog.discover(config, KEY)
    assert get.call_args.kwargs["headers"]["Authorization"] == f"Bearer {KEY}"
    assert catalog.known(config, KEY)["reasoning_levels"] == ["auto", "low", "high"]
    get.return_value = response({"data": [{"id": "a"}], "has_more": True, "last_id": "a"})
    with pytest.raises(AgentError, match="agent_invalid_response"):
        catalog.discover(config, KEY, refresh=True)


@pytest.mark.parametrize(
    "provider,model,effort,field,value",
    [
        ("anthropic", "claude-sonnet-5-5", "high", "output_config", {"effort": "high"}),
        ("anthropic", "claude-sonnet-4-5", "medium", "thinking", {"type": "enabled", "budget_tokens": 4096}),
        ("anthropic", "claude-sonnet-4-5", "none", "thinking", {"type": "disabled"}),
        ("openai", "gpt-5.4-mini", "xhigh", "reasoning", {"effort": "xhigh"}),
        ("openai_compatible", "gpt-5.4-mini", "low", "reasoning_effort", "low"),
    ],
)
def test_thinking_parameters_match_each_wire_protocol(monkeypatch, provider, model, effort, field, value):
    body = {"content": [{"type": "text", "text": "ok"}], "output": [], "choices": [{"message": {"content": "ok"}}]}
    post = Mock(return_value=response(body))
    monkeypatch.setattr(requests, "post", post)
    client = AgentClient(AgentConfig(provider=provider, model=model, reasoning_effort=effort), KEY)
    client.complete("system", [], [])
    payload = post.call_args.kwargs["json"]
    assert payload[field] == value
    if provider == "anthropic" and effort == "high":
        assert payload["thinking"] == {"type": "adaptive"}
    client.config.reasoning_effort = "auto"
    client.complete("system", [], [])
    assert not {"thinking", "output_config", "reasoning", "reasoning_effort"} & post.call_args.kwargs["json"].keys()


def test_unknown_effort_is_rejected_before_request_and_protocol_tool_limits_hold(monkeypatch):
    post = Mock()
    monkeypatch.setattr(requests, "post", post)
    with pytest.raises(AgentError, match="agent_reasoning_unsupported"):
        AgentClient(AgentConfig(model="custom", reasoning_effort="high"), KEY).complete("", [], [])
    with pytest.raises(AgentError, match="agent_model_protocol_unsupported"):
        AgentClient(AgentConfig(provider="openai_compatible", model="gpt-6.1-sol"), KEY).complete("", [], [{}])
    post.assert_not_called()


def test_preference_patch_preserves_other_options_and_rejects_null(api):
    api.put(
        "/api/agent/config",
        json={
            "api_key": KEY,
            "title_mode": "model",
            "title_model": "small-title",
            "reasoning_effort": "high",
            "workspace_access": False,
        },
    )
    result = api.patch("/api/agent/config", json={"execution_mode": "yolo"}).json()
    assert result["configured"] and result["title_model"] == "small-title"
    assert result["reasoning_effort"] == "high" and result["workspace_access"] is False
    changed = api.patch("/api/agent/config", json={"model": "another"}).json()
    assert changed["reasoning_effort"] == "auto" and changed["execution_mode"] == "yolo"
    assert api.patch("/api/agent/config", json={"model": None}).status_code == 422
    assert api.patch("/api/agent/config", json={"workspace_access": True}).status_code == 422


def test_model_discovery_and_title_routes_use_saved_configuration(api, monkeypatch):
    assert api.get("/api/agent/models").status_code == 409
    configure(api.container, [AgentReply("Answer", [], []), AgentReply("Generated title", [], [])])
    monkeypatch.setattr(requests, "get", Mock(return_value=response({"data": [{"id": "claude-sonnet-5-5"}]})))
    models = api.get("/api/agent/models").json()
    assert models["models"][0]["id"] == models["selected"]["id"] == "claude-sonnet-5-5"
    result = chat(api.container)
    url = f"/api/agent/conversations/{result['conversation_id']}"
    assert api.patch(url, json={"title": "  "}).status_code == 422
    assert api.patch(url, json={"title": "My title"}).json()["title_source"] == "manual"
    assert api.post(url + "/title", json={}).json()["title"] == "Generated title"


def test_yolo_rejects_a_remote_event_change_after_proposal(container, calendar_client):
    setup(container, calendar_client)
    original = event(calendar_client)
    container.workspace.refresh(START, END)

    def concurrent_edit(_):
        calendar_client.patch_event(PRIMARY, original["id"], {"summary": "Remote edit"}, original["etag"])
        return AgentReply("Proposed update", [], [])

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
                    "event": form(title="AI edit"),
                },
            ),
            concurrent_edit,
        ],
        execution_mode="yolo",
    )
    result = chat(container)
    assert result["changes"][0]["error"] == "event_conflict"
    assert calendar_client.get_event(PRIMARY, original["id"])["summary"] == "Remote edit"


def test_yolo_only_applies_new_proposals_and_repeated_chat_does_not_repeat_writes(container):
    client = configure(
        container,
        [
            call("create_task", {"title": "older pending"}),
            AgentReply("preview", [], []),
            call("create_task", {"title": "new automatic"}),
            AgentReply("new preview", [], []),
        ],
    )
    old = chat(container)
    assert old["changes"][0]["status"] == "pending" and count(container, Task) == 0
    container.agent.preferences(AgentPreferences(execution_mode="yolo"))
    new = chat(container, conversation_id=old["conversation_id"])
    assert new["changes"][0]["status"] == "applied" and count(container, Task) == 1
    assert new["options"]["execution_mode"] == "yolo" and new["options"]["phase"] == "complete"
    again = chat(container, request_id=new["id"], conversation_id=new["conversation_id"])
    assert again == new and len(client.requests) == 4 and count(container, Task) == 1
    assert container.agent.history(old["conversation_id"])["items"][0]["changes"][0]["status"] == "pending"


def test_yolo_still_checks_workspace_permissions(container):
    configure(container, [call("create_task", {"title": "forbidden"})], execution_mode="yolo", workspace_access=False)
    result = chat(container)
    assert result["error"] == "agent_workspace_disabled" and not result["changes"]
    assert count(container, Task) == 0


def test_model_titles_use_selected_model_once_and_suggestions_have_no_tools(container):
    configure(container, [], title_mode="model", title_model="small-title", prompt_suggestions="model")
    configs, clients = [], []

    def factory(config, key):
        configs.append(config)
        text = (
            "A concise title"
            if config.model == "small-title"
            else ('["Next step?", "Why?", "Example?"]' if not config.workspace_access else "Answer")
        )
        client = ScriptedClient(config, key, [AgentReply(text, [], [])])
        clients.append(client)
        return client

    container.agent.client_factory = factory
    first = chat(container, "A question")
    second = chat(container, "A follow-up", conversation_id=first["conversation_id"])
    assert [c.model for c in configs].count("small-title") == 1
    assert container.agent.conversations()[0]["title"] == "A concise title"
    assert first["options"]["suggestions"] == second["options"]["suggestions"] == ["Next step?", "Why?", "Example?"]
    for config, client in zip(configs, clients, strict=True):
        if not config.workspace_access:
            assert config.reasoning_effort == "auto" and client.requests[0][2] == []
    assert "Next step?" not in json.dumps(container.data.export(include_content=False))


def test_auxiliary_failure_keeps_answer_applied_receipt_and_existing_title(container):
    configure(
        container,
        [
            call("create_task", {"title": "safe result"}),
            AgentReply("Answer", [], []),
            call("delete_task", {"task_id": str(uuid.uuid4())}),
            AgentReply("not JSON", [], []),
        ],
        execution_mode="yolo",
        title_mode="model",
        prompt_suggestions="model",
    )
    result = chat(container, "Keep this fallback title")
    assert result["status"] == "completed" and result["assistant_text"] == "Answer"
    assert result["changes"][0]["status"] == "applied" and count(container, Task) == 1
    assert result["options"]["title_error"] == "agent_invalid_response"
    assert result["options"]["suggestions_error"] == "agent_suggestions_failed"
    assert container.agent.conversations()[0]["title"] == "Keep this fallback title"


def test_manual_title_is_not_overwritten_and_disabled_suggestions_make_no_call(container):
    client = configure(container, [AgentReply("Answer", [], [])], title_mode="model", prompt_suggestions="off")
    conversation = container.agent.new_conversation()["id"]
    container.agent.rename(conversation, "My own title")
    chat(container, conversation_id=conversation)
    assert container.agent.conversations()[0]["title_source"] == "manual"
    assert container.agent.suggestions(conversation) == [] and len(client.requests) == 1


def test_restart_preserves_applied_receipts_without_replaying_yolo(container):
    configure(container, [call("create_task", {"title": "once"}), AgentReply("Answer", [], [])], execution_mode="yolo")
    result = chat(container)
    with transaction(container.factory) as session:
        row = session.get(AgentTurn, result["id"])
        row.options = {**row.options, "phase": "finishing"}
    restored = AgentService(container).history(result["conversation_id"])["items"][0]
    assert restored["changes"][0]["status"] == "applied" and restored["options"]["phase"] == "interrupted"
    assert count(container, Task) == 1
