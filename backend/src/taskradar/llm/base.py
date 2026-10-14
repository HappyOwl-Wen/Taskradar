"""Provider-agnostic LLM interface.

Providers only need to turn (system prompt, user prompt, JSON schema) into raw JSON text plus
usage metadata. Validation, retries, grounding and fallback live in the extraction layer so
every provider gets the same safety guarantees.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class LLMError(RuntimeError):
    code = "llm_error"
    retryable = False


class LLMUnavailableError(LLMError):
    code = "llm_unavailable"


class LLMAuthError(LLMError):
    code = "llm_auth_failed"


class LLMTimeoutError(LLMError):
    code = "llm_timeout"
    retryable = True


class LLMRateLimitError(LLMError):
    code = "llm_rate_limited"
    retryable = True


class LLMServerError(LLMError):
    code = "llm_server_error"
    retryable = True


class LLMInvalidOutputError(LLMError):
    code = "llm_invalid_output"
    retryable = True


@dataclass
class LLMResponse:
    content: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    finish_reason: str | None = None


class LLMProvider(Protocol):
    name: str
    model: str
    is_cloud: bool

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema_name: str,
        schema: dict[str, Any],
        max_output_tokens: int = 4000,
    ) -> LLMResponse: ...
