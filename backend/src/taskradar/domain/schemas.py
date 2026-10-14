"""Typed contracts between pipeline stages.

Every stage (parsing -> extraction -> reconciliation -> deadline evaluation -> policy) consumes
and produces these models so each stage can be tested in isolation.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from taskradar.domain.enums import (
    ActionType,
    Category,
    CompletionKind,
    ContentType,
    DueAnchor,
    DuePrecision,
    MatchRelation,
    Priority,
    RelationHint,
    TimeSemantics,
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------------------------
# Normalization & parsing outputs
# --------------------------------------------------------------------------------------------


class PageText(_Model):
    page: int = Field(ge=1)
    text: str
    method: Literal["text", "ocr", "none"]
    ocr_confidence: float | None = None


class ParsedDocument(_Model):
    kind: Literal["pdf", "image"]
    pages: list[PageText]
    page_count: int
    extraction_method: Literal["text", "ocr", "mixed", "none"]
    language: str | None = None
    doc_date: dt.date | None = None
    ocr_engine: str | None = None
    warnings: list[str] = Field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(p.text for p in self.pages if p.text.strip())


class AttachmentRef(_Model):
    filename: str
    mime_type: str
    size: int = 0
    attachment_id: str | None = None
    inline_data: bytes | None = None


class NormalizedMessage(_Model):
    external_id: str
    thread_id: str | None = None
    history_id: str | None = None
    rfc822_message_id: str | None = None
    subject: str = ""
    sender: str = ""
    sender_domain: str | None = None
    recipients: str = ""
    sent_at: dt.datetime | None = None
    snippet: str = ""
    body_text: str = ""
    labels: list[str] = Field(default_factory=list)
    is_bulk: bool = False
    attachments: list[AttachmentRef] = Field(default_factory=list)


# --------------------------------------------------------------------------------------------
# Extraction contracts
# --------------------------------------------------------------------------------------------


class TextSegment(_Model):
    text: str
    page: int | None = None
    offset: int = 0


class ExtractionInput(_Model):
    origin_kind: Literal["message", "document"]
    origin_id: int
    title: str | None = None
    text: str
    segments: list[TextSegment] = Field(default_factory=list)
    sender: str | None = None
    sent_at: dt.datetime | None = None
    doc_date: dt.date | None = None
    received_at: dt.datetime
    language: str | None = None
    labels: list[str] = Field(default_factory=list)
    is_bulk: bool = False
    thread_id: str | None = None
    timezone: str = "Europe/Berlin"
    ocr_confidence: dict[int, float] = Field(default_factory=dict)

    def locate(self, start: int) -> int | None:
        """Return the 1-based page number for a character offset in :attr:`text`."""
        page: int | None = None
        for seg in self.segments:
            if seg.offset <= start:
                page = seg.page
            else:
                break
        return page


class Evidence(_Model):
    quote: str
    page: int | None = None
    start: int | None = None
    end: int | None = None
    verified: bool = True
    kind: Literal["action", "deadline", "completion", "context"] = "action"


class DueInfo(_Model):
    date: dt.date | None = None
    time: dt.time | None = None
    precision: DuePrecision = DuePrecision.NONE
    text: str | None = None
    is_relative: bool = False
    ambiguous: bool = False
    needs_confirmation: bool = False
    anchor: DueAnchor | None = None
    alternatives: list[dt.date] = Field(default_factory=list)
    semantics: TimeSemantics = TimeSemantics.DEADLINE
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _derive_precision(self) -> DueInfo:
        # Precision is always derived from what is actually known - never trusted from input.
        if self.date is None:
            self.time = None
            self.precision = DuePrecision.NONE
        elif self.time is None:
            self.precision = DuePrecision.DATE
        else:
            self.precision = DuePrecision.DATETIME
        return self


class CandidateTask(_Model):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    category: Category = Category.OTHER
    action_type: ActionType = ActionType.OTHER
    action_required: str = ""
    due: DueInfo = Field(default_factory=DueInfo)
    priority: Priority = Priority.MEDIUM
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: list[Evidence] = Field(default_factory=list)
    relation_hint: RelationHint = RelationHint.NEW
    uncertainties: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)


class CompletionSignal(_Model):
    subject: str
    kind: CompletionKind
    evidence: Evidence
    confidence: float = Field(ge=0.0, le=1.0)
    explicit: bool
    entities: list[str] = Field(default_factory=list)
    action_type: ActionType = ActionType.OTHER


class LLMUsage(_Model):
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    latency_ms: int = 0
    attempts: int = 1


class ExtractionResult(_Model):
    content_type: ContentType
    is_actionable: bool
    tasks: list[CandidateTask] = Field(default_factory=list)
    completion_signals: list[CompletionSignal] = Field(default_factory=list)
    extractor: str
    notes: list[str] = Field(default_factory=list)
    usage: LLMUsage | None = None
    trace: list[dict[str, object]] = Field(default_factory=list)


# --------------------------------------------------------------------------------------------
# Reconciliation contracts
# --------------------------------------------------------------------------------------------


class TaskSnapshot(_Model):
    """The subset of a stored task needed for reconciliation (kept DB-agnostic for testing)."""

    id: str
    title: str
    description: str = ""
    action_type: ActionType = ActionType.OTHER
    category: Category = Category.OTHER
    entities: list[str] = Field(default_factory=list)
    due_date: dt.date | None = None
    due_time: dt.time | None = None
    status: str
    origin_keys: list[str] = Field(default_factory=list)
    thread_ids: list[str] = Field(default_factory=list)
    last_source_at: dt.datetime | None = None
    user_locked_fields: list[str] = Field(default_factory=list)


DecisionLayer = Literal["deterministic", "normalized", "semantic", "none"]


class MatchDecision(_Model):
    relation: MatchRelation
    task_id: str | None = None
    score: float = 0.0
    layer: DecisionLayer = "none"
    reasons: list[str] = Field(default_factory=list)
