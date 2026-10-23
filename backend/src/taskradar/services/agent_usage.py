"""Aggregate only usage counters actually reported for every attempt in a request group."""

from __future__ import annotations

from typing import Any

FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


def add_usage(previous: dict[str, Any], usage: dict[str, int] | None, *, model: str) -> dict[str, Any]:
    requests = previous.get("requests", 0)
    result: dict[str, Any] = {
        "requests": requests + 1,
        "reported_requests": previous.get("reported_requests", 0) + int(bool(usage)),
        "models": list(dict.fromkeys([*previous.get("models", []), model]))[-20:],
    }
    for name in FIELDS:
        value = (usage or {}).get(name)
        if type(value) is int and value >= 0 and (requests == 0 or name in previous):
            result[name] = previous.get(name, 0) + value
    if all(name in result for name in FIELDS[:3]):
        result["total_input_tokens"] = sum(result[name] for name in FIELDS[:3])
    return result
