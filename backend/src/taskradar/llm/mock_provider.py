"""Scripted provider for tests and offline simulations. Never contacts any network."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from taskradar.llm.base import LLMResponse

Script = str | dict[str, Any] | BaseException | Callable[[str, str], "str | dict[str, Any]"]


class MockLLMProvider:
    name = "mock"
    is_cloud = False

    def __init__(self, responses: list[Script] | None = None, model: str = "mock-model", default: Script | None = None):
        self.model = model
        self._responses = list(responses or [])
        self._default = default
        self.calls: list[dict[str, Any]] = []

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema_name: str,
        schema: dict[str, Any],
        max_output_tokens: int = 4000,
    ) -> LLMResponse:
        self.calls.append({"system": system, "user": user, "schema_name": schema_name})
        if self._responses:
            item = self._responses.pop(0)
        elif self._default is not None:
            item = self._default
        else:
            raise AssertionError("MockLLMProvider has no scripted response left")
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            item = item(system, user)
        content = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
        return LLMResponse(
            content=content,
            model=self.model,
            input_tokens=len(system + user) // 4,
            output_tokens=len(content) // 4,
            latency_ms=1,
            finish_reason="stop",
        )
