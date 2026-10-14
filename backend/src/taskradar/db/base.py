"""SQLAlchemy declarative base and custom column types."""

from __future__ import annotations

import datetime as dt
from typing import Any, ClassVar

from sqlalchemy import JSON, DateTime, MetaData
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import TypeDecorator

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class UTCDateTime(TypeDecorator[dt.datetime]):
    """Stores timezone-aware datetimes as naive UTC (SQLite has no tz support).

    Naive datetimes are rejected on write so local times can never be stored by accident.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: dt.datetime | None, dialect: Dialect) -> dt.datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("UTCDateTime requires a timezone-aware datetime")
        return value.astimezone(dt.UTC).replace(tzinfo=None)

    def process_result_value(self, value: dt.datetime | None, dialect: Dialect) -> dt.datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=dt.UTC)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map: ClassVar[dict[Any, Any]] = {
        dict[str, Any]: JSON,
        list[Any]: JSON,
        list[str]: JSON,
        list[dict[str, Any]]: JSON,
        dt.datetime: UTCDateTime(),
    }
