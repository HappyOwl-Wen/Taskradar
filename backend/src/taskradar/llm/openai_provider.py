"""OpenAI (and OpenAI-compatible) chat-completions provider with Structured Outputs."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from taskradar.llm.base import (
    LLMAuthError,
    LLMError,
    LLMInvalidOutputError,
    LLMRateLimitError,
    LLMResponse,
    LLMServerError,
    LLMTimeoutError,
)

log = logging.getLogger(__name__)


class OpenAIProvider:
    """Calls ``chat.completions`` with ``response_format=json_schema`` (strict).

    ``structured_mode="json_object"`` is offered for OpenAI-compatible servers that do not support
    JSON-schema constrained decoding; the schema is then embedded in the prompt and the result is
    validated locally all the same.
    """

    name = "openai"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str | None = None,
        timeout: float = 45.0,
        structured_mode: str = "json_schema",
        reasoning_effort: str | None = None,
        client: Any | None = None,
    ) -> None:
        if not model:
            raise ValueError("A model name must be configured")
        self.model = model
        self.base_url = base_url
        self.structured_mode = structured_mode
        self.reasoning_effort = reasoning_effort
        self.is_cloud = base_url is None or not any(h in base_url for h in ("127.0.0.1", "localhost", "[::1]"))
        if client is not None:
            self._client = client
        else:
            from openai import OpenAI

            # Retries are handled by the extraction layer so attempts are counted and bounded.
            self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=0)

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema_name: str,
        schema: dict[str, Any],
        max_output_tokens: int = 4000,
    ) -> LLMResponse:
        import openai

        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        kwargs: dict[str, Any] = {"model": self.model, "messages": messages, "max_completion_tokens": max_output_tokens}
        if self.structured_mode == "json_object":
            messages[0]["content"] = (
                system
                + "\n\nReturn ONLY a JSON object that validates against this JSON schema:\n"
                + json.dumps(schema, ensure_ascii=False)
            )
            kwargs["response_format"] = {"type": "json_object"}
        else:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            }
        if self.reasoning_effort:
            kwargs["reasoning_effort"] = self.reasoning_effort

        started = time.perf_counter()
        try:
            completion = self._client.chat.completions.create(**kwargs)
        except openai.APITimeoutError as exc:
            raise LLMTimeoutError("The model request timed out") from exc
        except openai.RateLimitError as exc:
            raise LLMRateLimitError("The model provider rate-limited the request") from exc
        except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
            raise LLMAuthError("The model provider rejected the API key") from exc
        except openai.APIConnectionError as exc:
            raise LLMTimeoutError("Could not reach the model provider") from exc
        except openai.InternalServerError as exc:
            raise LLMServerError("The model provider returned a server error") from exc
        except openai.BadRequestError as exc:
            raise LLMError(f"The model provider rejected the request: {exc.message}") from exc
        except openai.APIError as exc:
            raise LLMError(f"Model provider error: {exc.__class__.__name__}") from exc
        latency_ms = int((time.perf_counter() - started) * 1000)

        choice = completion.choices[0] if completion.choices else None
        if choice is None:
            raise LLMInvalidOutputError("The model returned no choices")
        message = choice.message
        refusal = getattr(message, "refusal", None)
        if refusal:
            raise LLMInvalidOutputError("The model refused to answer")
        content = message.content or ""
        if choice.finish_reason == "length":
            raise LLMInvalidOutputError("The model output was truncated")
        usage = getattr(completion, "usage", None)
        return LLMResponse(
            content=content,
            model=getattr(completion, "model", self.model) or self.model,
            input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
            latency_ms=latency_ms,
            finish_reason=choice.finish_reason,
        )
