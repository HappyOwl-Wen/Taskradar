"""Deterministic multilingual date parsing."""

from __future__ import annotations

import datetime as dt

import pytest

from taskradar.domain.enums import DueAnchor, DuePrecision
from taskradar.extraction.dates import (
    choose_deadline,
    detect_document_date,
    find_dates,
    find_times,
    mention_to_due,
    parse_due_text,
)

ANCHOR = dt.date(2026, 10, 13)  # a Tuesday


def first(text: str, anchor: dt.date = ANCHOR, lang: str | None = None):  # type: ignore[no-untyped-def]
    mentions = find_dates(text, anchor, lang=lang)
    assert mentions, f"no date found in {text!r}"
    return choose_deadline(mentions)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("请于2026年11月20日前提交在读证明。", dt.date(2026, 11, 20)),
        ("Bitte reichen Sie die Unterlagen bis spätestens 27.11.2026 ein.", dt.date(2026, 11, 27)),
        ("Bitte überweisen Sie den Betrag bis zum 15. November 2026.", dt.date(2026, 11, 15)),
        ("Please submit the form by November 20, 2026.", dt.date(2026, 11, 20)),
        ("Deadline: 2026-12-01", dt.date(2026, 12, 1)),
        ("Abgabe am 3. Dezember", dt.date(2026, 12, 3)),
        ("截止日期：十一月二十日", dt.date(2026, 11, 20)),
    ],
)
def test_absolute_dates(text: str, expected: dt.date) -> None:
    mention = first(text)
    assert mention.date == expected
    assert mention.deadline_cue


def test_date_only_never_gets_an_invented_time() -> None:
    mention = first("请于2026年11月20日前提交")
    due = mention_to_due(mention, anchor_kind=DueAnchor.SOURCE_DATE)
    assert due.time is None
    assert due.precision == DuePrecision.DATE


def test_explicit_times_are_attached() -> None:
    assert first("bis spätestens 27.11.2026, 12:00 Uhr").time == dt.time(12, 0)
    assert first("截止日期：11月30日下午5点").time == dt.time(17, 0)
    assert first("Your appointment is on November 3, 2026 at 10:30 am.").time == dt.time(10, 30)
    assert first("Please reply by midnight on 20 November 2026.").time == dt.time(23, 59)


def test_numbers_that_are_not_times_are_ignored() -> None:
    mention = first("完成以下3点：11月20日前提交")
    assert mention.date == dt.date(2026, 11, 20)
    assert mention.time is None


def test_relative_dates_use_the_source_date_not_today() -> None:
    # Mail sent on Tuesday 2026-10-13: "下周五" is Friday of the next calendar week.
    assert first("请在下周五前提交报告").date == dt.date(2026, 10, 23)
    # The same text in a mail sent a week later resolves differently.
    assert first("请在下周五前提交报告", anchor=dt.date(2026, 10, 20)).date == dt.date(2026, 10, 30)
    assert first("Please confirm within 14 days.").date == dt.date(2026, 10, 27)
    assert first("Die Rückmeldung muss innerhalb von zwei Wochen erfolgen.").date == dt.date(2026, 10, 27)
    assert first("明天下午3点前提交").date == dt.date(2026, 10, 14)
    assert first("Bitte bis morgen um 10 Uhr antworten.").time == dt.time(10, 0)


def test_business_days_skip_weekends() -> None:
    # Friday + 3 business days = Wednesday
    assert first("请在3个工作日内完成缴费", anchor=dt.date(2026, 10, 16)).date == dt.date(2026, 10, 21)


def test_ambiguous_next_weekday_is_flagged_with_alternatives() -> None:
    mention = first("Please submit your form by next Friday.")
    assert mention.ambiguous
    assert mention.date == dt.date(2026, 10, 23)
    assert dt.date(2026, 10, 16) in mention.alternatives
    due = mention_to_due(mention, anchor_kind=DueAnchor.SOURCE_DATE)
    assert due.needs_confirmation
    assert due.text == "next Friday"


def test_ambiguous_numeric_dates_keep_both_readings() -> None:
    mention = first("Payment due 05/11/2026.")
    assert mention.ambiguous
    assert {mention.date, *mention.alternatives} == {dt.date(2026, 11, 5), dt.date(2026, 5, 11)}
    us = first("Payment due 05/11/2026.", lang="en")
    assert us.date == dt.date(2026, 5, 11)
    assert first("Payment due 11/20/2026.").ambiguous is False


def test_approximate_expressions_need_confirmation() -> None:
    mention = first("请于本月底前完成选课")
    assert mention.approximate and mention.date == dt.date(2026, 10, 31)
    assert mention_to_due(mention, anchor_kind=DueAnchor.SOURCE_DATE).needs_confirmation
    assert first("Bitte bis Ende November einreichen.").date == dt.date(2026, 11, 30)


def test_relative_date_without_source_date_is_flagged() -> None:
    due = parse_due_text("bis nächsten Freitag", ANCHOR, anchor_kind=DueAnchor.IMPORT_TIME)
    assert due is not None
    assert due.needs_confirmation
    assert "relative_to_import_time" in due.notes


def test_year_inference_rolls_over() -> None:
    assert first("请在1月5日前提交", anchor=dt.date(2026, 12, 28)).date == dt.date(2027, 1, 5)


def test_weekday_mismatch_is_flagged() -> None:
    mention = first("am Freitag, 21.11.2026")  # 21.11.2026 is a Saturday
    assert mention.ambiguous
    assert "weekday_mismatch" in mention.notes


def test_utc_times_are_converted_to_berlin_across_dst_change() -> None:
    # 2026-10-25 is the end of summer time in Europe/Berlin (UTC+1 afterwards).
    mention = first("Submit by 12:00 UTC on 2026-10-25")
    assert mention.date == dt.date(2026, 10, 25)
    assert mention.time == dt.time(13, 0)


def test_version_numbers_are_not_dates() -> None:
    assert find_dates("Version 1.5.2 released", ANCHOR) == []


def test_find_times() -> None:
    assert dt.time(17, 0) in find_times("截止时间为2026-10-20 17:00")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("München, 01.10.2026\n\nSehr geehrte Frau Wang,", dt.date(2026, 10, 1)),
        ("Universität\nDatum: 2. Oktober 2026\nBetreff", dt.date(2026, 10, 2)),
        ("通知\n发布日期：2026年10月8日\n各位同学", dt.date(2026, 10, 8)),
        ("Bitte zahlen Sie bis 30.10.2026.", None),
    ],
)
def test_document_date_detection(text: str, expected: dt.date | None) -> None:
    assert detect_document_date(text) == expected
