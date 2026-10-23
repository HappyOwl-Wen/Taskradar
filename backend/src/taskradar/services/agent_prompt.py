"""Stable text-history prefixes; changing runtime state belongs in the newest user turn."""

from __future__ import annotations

import datetime as dt
import json
from typing import Any

from taskradar.domain.agent import AgentConfig


def change_state(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: ch.get(k) for k in ("id", "kind", "title", "status", "error")} for ch in changes]


def assistant_message(turn: dict[str, Any]) -> str:
    state = turn["options"]["_reply_state"]
    if not (turn["assistant_text"] or state or turn["error"]):
        return ""
    return (
        turn["assistant_text"]
        + "\n[TaskRadar change state at reply: "
        + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        + "; error="
        + str(turn["error"])
        + "]"
    )


def messages_for_turn(
    config: AgentConfig,
    *,
    now: dt.datetime,
    timezone: str,
    language: str,
    history: list[dict[str, Any]],
    text: str,
) -> list[dict[str, Any]]:
    retained = list(history[-20:])
    while True:
        messages = []
        updates = []
        for turn in retained:
            messages.append({"role": "user", "content": turn["options"].get("_request_text", turn["user_text"])})
            answer = assistant_message(turn)
            if answer:
                messages.append({"role": "assistant", "content": answer})
            state = change_state(turn["changes"])
            if state != turn["options"]["_reply_state"]:
                updates.append({"turn_id": turn["id"], "changes": state})
        context = {
            "now": now.isoformat(),
            "timezone": timezone,
            "language": language,
            "workspace_access": config.workspace_access,
            "execution_mode": config.execution_mode,
            "changed_since_reply": updates,
        }
        request = (
            "[TaskRadar runtime context]\n"
            + json.dumps(context, ensure_ascii=False, separators=(",", ":"))
            + "\n[User message]\n"
            + text
        )
        messages.append({"role": "user", "content": request})
        # Count the actual replayed text, including context and receipts, rather than just visible chat text.
        if sum(len(m["content"]) for m in messages) <= 30000 or not retained:
            return messages
        retained.pop(0)
