"""Provider-reported model capabilities, with explicitly identified documentation fallbacks.

Availability ALWAYS comes from /models. These rules only describe already named models; unknown
models keep provider defaults. Sources and the verification date are documented in the Agent guide.
"""

from __future__ import annotations

import re
from typing import Any

from taskradar.domain.agent import Provider

EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def model_info(provider: Provider, model: str, raw: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = raw or {}
    info: dict[str, Any] = {
        "id": model,
        "name": str(raw.get("display_name") or raw.get("name") or model)[:200],
        "reasoning_levels": ["auto"],
        "reasoning_kind": "unknown",
        "capability_source": "unknown",
        "tool_calling": None,
        "usable": True,
        "thinking_type": None,
    }
    lower = model.lower()
    if provider == "anthropic":
        if re.match(r"claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:-|$)", lower) or re.match(
            r"claude-opus-4-[78](?:-|$)", lower
        ):
            info.update(
                reasoning_levels=["auto", "low", "medium", "high", "xhigh", "max"],
                reasoning_kind="effort",
                thinking_type="adaptive",
                capability_source="documented",
                tool_calling=True,
            )
        elif re.match(r"claude-(?:opus|sonnet)-4-6(?:-|$)", lower):
            info.update(
                reasoning_levels=["auto", "low", "medium", "high", "max"],
                reasoning_kind="effort",
                thinking_type="adaptive",
                capability_source="documented",
                tool_calling=True,
            )
        elif re.match(r"claude-(?:opus|sonnet|haiku)-4(?:[.-]|$)", lower):
            info.update(
                reasoning_levels=["auto", "none", "low", "medium", "high"],
                reasoning_kind="budget",
                thinking_type="enabled",
                capability_source="documented",
                tool_calling=True,
            )
        capabilities = raw.get("capabilities")
        if isinstance(capabilities, dict):
            effort = _object(capabilities.get("effort"))
            thinking = _object(capabilities.get("thinking"))
            types = _object(thinking.get("types"))
            levels = [
                level
                for level in EFFORTS
                if isinstance(effort.get(level), dict) and effort[level].get("supported") is True
            ]
            if levels:
                info.update(reasoning_levels=["auto", *levels], reasoning_kind="effort", capability_source="api")
                info["thinking_type"] = "adaptive" if _object(types.get("adaptive")).get("supported") is True else None
            elif effort.get("supported") is False and thinking.get("supported") is False:
                info.update(
                    reasoning_levels=["auto"], reasoning_kind="none", thinking_type=None, capability_source="api"
                )
            elif _object(types.get("enabled")).get("supported") is True:
                levels = ["auto", "low", "medium", "high"]
                if _object(types.get("disabled")).get("supported") is True:
                    levels.insert(1, "none")
                info.update(
                    reasoning_levels=levels, reasoning_kind="budget", thinking_type="enabled", capability_source="api"
                )
            elif effort.get("supported") is False:
                info.update(reasoning_levels=["auto"], reasoning_kind="unknown", capability_source="api")
    else:
        if re.match(r"gpt-6(?:\.1)?-(?:astra|sol|luna)(?:-|$)", lower):
            levels = ["low", "medium", "high", "xhigh", "max"]
            if lower.startswith(("gpt-6-sol", "gpt-6-luna")):
                levels.insert(0, "none")
            info.update(
                reasoning_levels=["auto", *levels],
                reasoning_kind="effort",
                capability_source="documented",
                tool_calling=True,
            )
            if provider == "openai_compatible":
                # These modern models require Responses for reasoning + tools.
                info["tool_calling"] = False
        elif re.fullmatch(r"gpt-5\.[245](?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?", lower):
            info.update(
                reasoning_levels=["auto", "none", "low", "medium", "high", "xhigh"],
                reasoning_kind="effort",
                capability_source="documented",
                tool_calling=True,
            )
        elif re.fullmatch(r"gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?", lower):
            info.update(
                reasoning_levels=["auto", "none", "low", "medium", "high"],
                reasoning_kind="effort",
                capability_source="documented",
                tool_calling=True,
            )
        elif re.fullmatch(r"gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?", lower):
            info.update(
                reasoning_levels=["auto", "minimal", "low", "medium", "high"],
                reasoning_kind="effort",
                capability_source="documented",
                tool_calling=True,
            )
        elif re.fullmatch(r"o[134](?:-mini)?(?:-\d{4}-\d{2}-\d{2})?", lower):
            info.update(
                reasoning_levels=["auto", "low", "medium", "high"],
                reasoning_kind="effort",
                capability_source="documented",
                tool_calling=True,
            )
        elif lower.startswith(("gpt-4", "chatgpt-4")):
            info.update(reasoning_kind="none", capability_source="documented", tool_calling=True)
        # Some compatible gateways explicitly supply an effort enum. Do not guess one from a vendor name.
        reported = raw.get("reasoning_efforts")
        if isinstance(reported, list) and any(level in EFFORTS for level in reported if isinstance(level, str)):
            info.update(
                reasoning_levels=["auto", *[level for level in EFFORTS if level in reported]],
                reasoning_kind="effort",
                capability_source="api",
            )
    if lower.startswith(("text-embedding", "tts-", "whisper-", "dall-e", "gpt-image", "omni-moderation")) or any(
        part in lower for part in ("-realtime", "-transcribe", "-audio")
    ):
        info.update(usable=False, tool_calling=False, reasoning_levels=["auto"], reasoning_kind="none")
    if raw.get("lifecycle") == "retired":
        info["usable"] = False
    return info
