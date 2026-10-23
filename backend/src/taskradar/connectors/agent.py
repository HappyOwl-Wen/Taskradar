"""Small HTTP adapters for Claude Messages, OpenAI Responses and compatible Chat Completions."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any

import requests

from taskradar.domain.agent import AgentConfig
from taskradar.domain.agent_models import model_info


class AgentError(Exception):
    def __init__(self, code: str, status_code: int = 502) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass
class AgentReply:
    text: str
    calls: list[dict[str, Any]]
    raw: list[dict[str, Any]]
    usage: dict[str, int] | None = None


def claude_cache_payload(system: str, messages: list[dict[str, Any]], ttl: str) -> dict[str, Any]:
    """Use block-level markers for gateways that do not implement top-level automatic caching.

    Keep one anchor on the original user input through tool rounds, and one on the growing suffix.
    Never mutate canonical history, cache thinking blocks directly, or exceed three breakpoints.
    """
    cached = copy.deepcopy(messages)
    blocks = []
    user_anchor = None
    for message in cached:
        if isinstance(message["content"], str):
            message["content"] = [{"type": "text", "text": message["content"]}]
        for block in message["content"]:
            block.pop("cache_control", None)
            if block.get("type") in ("text", "tool_use", "tool_result", "image", "document"):
                blocks.append(block)
                if message["role"] == "user" and block["type"] == "text":
                    user_anchor = block
    control = {"type": "ephemeral", **({"ttl": "1h"} if ttl == "1h" else {})}
    if user_anchor is not None:
        user_anchor["cache_control"] = dict(control)
    if blocks:
        blocks[-1]["cache_control"] = dict(control)
    return {"system": [{"type": "text", "text": system, "cache_control": control}], "messages": cached}


class AgentClient:
    def __init__(self, config: AgentConfig, api_key: str) -> None:
        self.config = config
        self.api_key = api_key
        self.capabilities = model_info(config.provider, config.model)

    def complete(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AgentReply:
        config = self.config
        headers = {"Content-Type": "application/json"}
        payload: dict[str, Any] = {"model": config.model}
        effort = config.reasoning_effort
        capabilities = self.capabilities
        if effort not in capabilities["reasoning_levels"]:
            raise AgentError("agent_reasoning_unsupported", 422)
        if tools and capabilities["tool_calling"] is False:
            raise AgentError("agent_model_protocol_unsupported", 422)
        token_limit = 16384 if effort not in ("auto", "none") else 8192
        if config.provider == "anthropic":
            path = "/messages"
            headers.update({"x-api-key": self.api_key, "anthropic-version": "2023-06-01"})
            payload.update(system=system, messages=messages, max_tokens=token_limit)
            if config.prompt_cache != "off":
                payload.update(claude_cache_payload(system, messages, config.prompt_cache))
            if effort != "auto":
                if capabilities["reasoning_kind"] == "budget":
                    payload["thinking"] = (
                        {"type": "disabled"}
                        if effort == "none"
                        else {
                            "type": "enabled",
                            "budget_tokens": {"low": 1024, "medium": 4096, "high": 8192}[effort],
                        }
                    )
                else:
                    payload["output_config"] = {"effort": effort}
                    if capabilities["thinking_type"]:
                        payload["thinking"] = {"type": capabilities["thinking_type"]}
            if tools:
                payload["tools"] = [
                    {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools
                ]
        elif config.provider == "openai":
            path = "/responses"
            headers["Authorization"] = f"Bearer {self.api_key}"
            payload.update(
                instructions=system,
                input=messages,
                store=False,
                max_output_tokens=token_limit,
                include=["reasoning.encrypted_content"],
            )
            if effort != "auto":
                payload["reasoning"] = {"effort": effort}
            if tools:
                payload.update(
                    tools=[{"type": "function", **t, "strict": False} for t in tools], parallel_tool_calls=False
                )
        else:
            path = "/chat/completions"
            headers["Authorization"] = f"Bearer {self.api_key}"
            payload.update(messages=[{"role": "system", "content": system}, *messages])
            if effort != "auto":
                payload["reasoning_effort"] = effort
            if tools:
                payload["tools"] = [{"type": "function", "function": t} for t in tools]
        try:
            response = requests.post(
                config.base_url + path, headers=headers, json=payload, timeout=(10, 60), allow_redirects=False
            )
        except requests.Timeout as exc:
            raise AgentError("agent_timeout", 504) from exc
        except requests.RequestException as exc:
            raise AgentError("agent_unreachable") from exc
        if response.status_code in (401, 403):
            raise AgentError("agent_auth_failed")
        if response.status_code == 429:
            raise AgentError("agent_rate_limited", 429)
        if not 200 <= response.status_code < 300:
            # Provider bodies and request exceptions may echo credentials or private prompts. Never log/return them.
            raise AgentError("agent_provider_error")
        try:
            data = response.json()
            if config.provider == "anthropic":
                raw = data["content"]
                if data.get("stop_reason") == "max_tokens":
                    raise AgentError("agent_incomplete")
                calls = [
                    {"id": b["id"], "name": b["name"], "arguments": b["input"]} for b in raw if b["type"] == "tool_use"
                ]
                text = "\n".join(b["text"] for b in raw if b["type"] == "text")
            elif config.provider == "openai":
                if data.get("status") not in (None, "completed"):
                    raise AgentError("agent_incomplete")
                raw = data["output"]
                calls = [
                    {"id": b["call_id"], "name": b["name"], "arguments": json.loads(b["arguments"])}
                    for b in raw
                    if b["type"] == "function_call"
                ]
                text = "\n".join(
                    part["text"]
                    for b in raw
                    if b["type"] == "message"
                    for part in b.get("content", [])
                    if part["type"] == "output_text"
                )
            else:
                choice = data["choices"][0]
                if choice.get("finish_reason") == "length":
                    raise AgentError("agent_incomplete")
                message = choice["message"]
                raw = [message]
                calls = [
                    {"id": b["id"], "name": b["function"]["name"], "arguments": json.loads(b["function"]["arguments"])}
                    for b in message.get("tool_calls", [])
                ]
                text = message.get("content") or ""
            if not isinstance(raw, list) or not isinstance(text, str) or len(text) > 50000 or len(calls) > 20:
                raise ValueError("Invalid response")
            usage = None
            if config.provider == "anthropic" and isinstance(data.get("usage"), dict):
                usage = {
                    name: value
                    for name in (
                        "input_tokens",
                        "cache_creation_input_tokens",
                        "cache_read_input_tokens",
                        "output_tokens",
                    )
                    if type(value := data["usage"].get(name)) is int and value >= 0
                } or None
            return AgentReply(text=text, calls=calls, raw=raw, usage=usage)
        except (KeyError, ValueError, TypeError, IndexError) as exc:
            raise AgentError("agent_invalid_response") from exc

    def append_results(self, messages: list[dict[str, Any]], reply: AgentReply, results: list[dict[str, Any]]) -> None:
        provider = self.config.provider
        if provider == "openai":
            # Preserve reasoning and all other output items when continuing a stateless Responses turn.
            messages.extend(reply.raw)
            messages.extend(
                {
                    "type": "function_call_output",
                    "call_id": r["id"],
                    "output": json.dumps(r["result"], ensure_ascii=False),
                }
                for r in results
            )
        elif provider == "anthropic":
            messages.append({"role": "assistant", "content": reply.raw})
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": r["id"],
                            "content": json.dumps(r["result"], ensure_ascii=False),
                        }
                        for r in results
                    ],
                }
            )
        else:
            messages.extend(reply.raw)
            messages.extend(
                {"role": "tool", "tool_call_id": r["id"], "content": json.dumps(r["result"], ensure_ascii=False)}
                for r in results
            )
