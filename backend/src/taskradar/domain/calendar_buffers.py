"""Time reserved before and after a calendar item: preparation, commute or rest.

Buffers are a local planning aid. They widen an item for overlap warnings and in the week view, and they are
never sent to Google: an invited, read-only or recurring meeting can carry them as well as an own work block.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

BufferKind = Literal["prep", "commute", "rest"]
MAX_BUFFER_MINUTES = 240


class Buffer(BaseModel):
    before_minutes: int = Field(default=0, ge=0, le=MAX_BUFFER_MINUTES)
    before_kind: BufferKind = "prep"
    after_minutes: int = Field(default=0, ge=0, le=MAX_BUFFER_MINUTES)
    after_kind: BufferKind = "rest"

    @property
    def empty(self) -> bool:
        return not (self.before_minutes or self.after_minutes)
