"""Extractor interface shared by the rule engine, the LLM extractor and the hybrid pipeline."""

from __future__ import annotations

from typing import Protocol

from taskradar.domain.schemas import ExtractionInput, ExtractionResult


class Extractor(Protocol):
    name: str
    version: str

    def extract(self, inp: ExtractionInput) -> ExtractionResult: ...
