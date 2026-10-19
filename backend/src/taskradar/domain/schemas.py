"""Typed values shared by the services: a task's deadline, as typed by the user or set in the task form."""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field, model_validator

from taskradar.domain.enums import (
    DueAnchor,
    DuePrecision,
    TimeSemantics,
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


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
