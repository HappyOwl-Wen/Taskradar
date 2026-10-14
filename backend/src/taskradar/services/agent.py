"""Builds the extraction pipeline from current settings (rules only, or hybrid with an LLM)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from taskradar.extraction.base import Extractor
from taskradar.extraction.hybrid import ExtractionNotPermitted, HybridExtractor
from taskradar.extraction.llm_extractor import LLMExtractor
from taskradar.extraction.rules import RuleBasedExtractor
from taskradar.llm.base import LLMProvider
from taskradar.llm.openai_provider import OpenAIProvider
from taskradar.reconciliation.judge import LLMRelationJudge
from taskradar.reconciliation.reconciler import Reconciler
from taskradar.security.permissions import PermissionDenied, PermissionGuard, SideEffect
from taskradar.services.settings import SettingsService


class AgentFactory:
    def __init__(
        self,
        settings: SettingsService,
        guard: PermissionGuard,
        *,
        provider_override: LLMProvider | None = None,
    ) -> None:
        self.settings = settings
        self.guard = guard
        self.provider_override = provider_override

    def llm_provider(self) -> LLMProvider | None:
        if self.provider_override is not None:
            return self.provider_override
        cfg = self.settings.get().llm
        if cfg.provider == "none":
            return None
        api_key = self.guard.llm_api_key()
        if cfg.provider == "openai" and not api_key:
            return None
        return OpenAIProvider(
            api_key=api_key or "not-needed",
            model=cfg.model,
            base_url=cfg.base_url if cfg.provider == "openai_compatible" else None,
            timeout=cfg.timeout_seconds,
            structured_mode=cfg.structured_mode,
            reasoning_effort=cfg.reasoning_effort,
        )

    def mode(self) -> str:
        """'llm' when model extraction is configured and permitted, otherwise 'rules'."""
        if self.llm_provider() is None or not self.guard.is_allowed(SideEffect.LLM_SEND):
            return "rules"
        return "llm"

    def extractor(self) -> Extractor:
        rules = RuleBasedExtractor()
        provider = self.llm_provider()
        if provider is None:
            return rules
        cfg = self.settings.get().llm
        llm = LLMExtractor(
            provider,
            max_retries=cfg.max_retries,
            max_input_chars=cfg.max_input_chars,
            redact_identifiers=cfg.redact_identifiers,
            price_overrides=(cfg.price_input_per_mtok, cfg.price_output_per_mtok),
        )

        def authorize(inp: object) -> None:
            target = f"{getattr(inp, 'origin_kind', '?')}:{getattr(inp, 'origin_id', '?')}"
            try:
                self.guard.check(SideEffect.LLM_SEND, target=target, kind="extraction")
            except PermissionDenied as exc:
                raise ExtractionNotPermitted(exc.code, exc.message) from exc

        return HybridExtractor(rules, llm, prefilter=cfg.prefilter, authorize=authorize)

    def reconciler(self, session: Session) -> Reconciler:
        provider = self.llm_provider()
        cfg = self.settings.get().llm
        judge = None
        if provider is not None and cfg.use_semantic_dedup and self.guard.is_allowed(SideEffect.LLM_SEND):

            def authorize() -> None:
                self.guard.check(SideEffect.LLM_SEND, target="dedup_judge", session=session, kind="dedup")

            judge = LLMRelationJudge(provider, authorize=authorize)
        return Reconciler(judge=judge)
