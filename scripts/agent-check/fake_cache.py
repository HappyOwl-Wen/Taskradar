"""Synthetic prefix cache for UI checks, NOT a tokenizer, bill or live-provider verification."""

from __future__ import annotations

import hashlib
import json
import time


class FixturePromptCache:
    def __init__(self):
        self.entries = {}

    def usage(self, body):
        digest = hashlib.sha256()
        size = 0
        positions = []
        marks = []

        def append(value, control=None):
            nonlocal size
            encoded = json.dumps(value, ensure_ascii=False, sort_keys=True)
            digest.update(encoded.encode())
            size += len(encoded)
            positions.append((digest.hexdigest(), max(1, size // 4)))
            if control:
                marks.append((len(positions) - 1, control.get("ttl", "5m")))

        append({name: body.get(name) for name in ("model", "thinking", "output_config", "tools")})
        system = body["system"]
        if isinstance(system, str):
            append({"system": system})
        else:
            for block in system:
                append({"system": {k: v for k, v in block.items() if k != "cache_control"}}, block.get("cache_control"))
        for message in body["messages"]:
            blocks = message["content"]
            if isinstance(blocks, str):
                blocks = [{"type": "text", "text": blocks}]
            for block in blocks:
                append({"role": message["role"], "block": {k: v for k, v in block.items() if k != "cache_control"}}, block.get("cache_control"))
        now = time.monotonic()
        read = 0
        for index, _ in marks:
            for key, tokens in positions[max(0, index - 19):index + 1]:
                if self.entries.get(key, 0) > now:
                    read = max(read, tokens)
        cached = 0
        for index, ttl in marks:
            key, tokens = positions[index]
            if tokens >= 512:
                self.entries[key] = now + (3600 if ttl == "1h" else 300)
                cached = max(cached, tokens)
        if len(self.entries) > 500:
            self.entries.clear()
        return {"input_tokens": max(0, size // 4 - cached), "cache_creation_input_tokens": max(0, cached - read),
                "cache_read_input_tokens": read}
