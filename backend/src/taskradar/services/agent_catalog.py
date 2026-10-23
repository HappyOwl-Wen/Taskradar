"""Bounded, cached discovery from the configured API; credentials never reach the browser."""

from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
from typing import Any

import requests

from taskradar.connectors.agent import AgentError
from taskradar.domain.agent import AgentConfig
from taskradar.domain.agent_models import model_info


def _scope(config: AgentConfig, key: str) -> str:
    return hashlib.sha256(json.dumps([config.provider, config.base_url, key]).encode()).hexdigest()


class AgentCatalog:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def discover(self, config: AgentConfig, key: str, *, refresh: bool = False) -> dict[str, Any]:
        scope = _scope(config, key)
        with self.lock:
            cached = self.cache.get(scope)
            if cached and not refresh and time.monotonic() - cached[0] < 300:
                return copy.deepcopy(cached[1])
            headers = {"Accept": "application/json"}
            if config.provider == "anthropic":
                headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            else:
                headers["Authorization"] = f"Bearer {key}"
            models: list[dict[str, Any]] = []
            params: dict[str, Any] = {"limit": 1000} if config.provider == "anthropic" else {}
            seen_cursors: set[str] = set()
            for _ in range(10):
                try:
                    response = requests.get(
                        config.base_url + "/models",
                        headers=headers,
                        params=params,
                        timeout=(5, 15),
                        allow_redirects=False,
                    )
                except requests.Timeout as exc:
                    raise AgentError("agent_timeout", 504) from exc
                except requests.RequestException as exc:
                    raise AgentError("agent_unreachable") from exc
                if response.status_code in (401, 403):
                    raise AgentError("agent_auth_failed")
                if response.status_code in (404, 405, 501):
                    raise AgentError("agent_models_unavailable")
                if response.status_code == 429:
                    raise AgentError("agent_rate_limited", 429)
                if not 200 <= response.status_code < 300:
                    raise AgentError("agent_provider_error")
                try:
                    data = response.json()
                    rows = data["data"]
                    if not isinstance(rows, list):
                        raise ValueError("Expected model list")
                    for row in rows:
                        if (
                            not isinstance(row, dict)
                            or not isinstance(row.get("id"), str)
                            or not 0 < len(row["id"]) <= 200
                        ):
                            raise ValueError("Invalid model")
                        models.append(model_info(config.provider, row["id"], row))
                    if len(models) > 2000:
                        raise ValueError("Model list too large")
                    if not data.get("has_more"):
                        break
                    cursor = data.get("last_id")
                    if not isinstance(cursor, str) or cursor in seen_cursors:
                        raise ValueError("Invalid pagination")
                    seen_cursors.add(cursor)
                    params["after_id" if config.provider == "anthropic" else "after"] = cursor
                except (ValueError, KeyError, TypeError) as exc:
                    raise AgentError("agent_invalid_response") from exc
            else:
                raise AgentError("agent_models_unavailable")
            result = {
                "provider": config.provider,
                "base_url": config.base_url,
                "models": list({m["id"]: m for m in models}.values()),
            }
            # A single-user app needs only the recent provider profiles, and never persists discovery credentials.
            if len(self.cache) >= 5:
                self.cache.clear()
            self.cache[scope] = (time.monotonic(), result)
            return copy.deepcopy(result)

    def known(self, config: AgentConfig, key: str) -> dict[str, Any]:
        scope = _scope(config, key)
        with self.lock:
            cached = self.cache.get(scope)
            if cached and time.monotonic() - cached[0] < 300:
                for model in cached[1]["models"]:
                    if model["id"] == config.model:
                        return copy.deepcopy(model)
        return model_info(config.provider, config.model)
