"""Manual entry grammar, contextual policy and calendar properties with an injected clock."""

import calendar
import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from taskradar.extraction.quick_add import parse_quick_task
from taskradar.extraction.temporal import parse_temporal
from taskradar.extraction.temporal_calendar import Operation, shift, wall_time_status
from taskradar.extraction.temporal_grammar import Expression

NOW = dt.datetime(2026, 10, 21, 8, tzinfo=dt.UTC)
TZ = "Europe/Berlin"


def parse(text: str, now: dt.datetime = NOW, timezone: str = TZ):
    return parse_temporal(text, now=now, timezone=timezone)


@pytest.mark.parametrize(
    ("text", "date", "time"),
    [
        ("今天交作业", "2026-10-21", None),
        ("明天交作业", "2026-10-22", None),
        ("后天交作业", "2026-10-23", None),
        ("大后天交作业", "2026-10-24", None),
        ("这周五交作业", "2026-10-23", None),
        ("下周一交作业", "2026-10-26", None),
        ("下下周三交作业", "2026-11-04", None),
        ("下个月月底缴费", "2026-11-30", None),
        ("三天之后提交", "2026-10-24", None),
        ("下个工作日提交", "2026-10-22", None),
        ("后天晚上8点交作业", "2026-10-23", "20:00"),
        ("明早交作业", "2026-10-22", None),
        ("明晚八点开会", "2026-10-22", "20:00"),
        ("明天早上十点半去看牙医", "2026-10-22", "10:30"),
        ("Freitag 10 Uhr Zahnarzt", "2026-10-23", "10:00"),
        ("morgen um 8", "2026-10-22", "08:00"),
        ("下周 Freitag 提交", "2026-10-30", None),
        ("明天 15 Uhr 去学校", "2026-10-22", "15:00"),
        ("nächsten Mittwoch abgeben", "2026-10-28", None),
        ("due nächsten Montag 23:59", "2026-10-26", "23:59"),
        ("in three weeks submit", "2026-11-11", None),
        ("in zwei Monaten abgeben", "2026-12-21", None),
        ("2026-12-31 23:59 submit", "2026-12-31", "23:59"),
        ("1.11. Zahnarzt", "2026-11-01", None),
        ("Oct 25 5pm report", "2026-10-25", "17:00"),
        ("25. Oktober 2026 abgeben", "2026-10-25", None),
        ("下下下周五", "2026-11-13", None),
        ("三周后的周二", "2026-11-10", None),
        ("后天的后一天", "2026-10-24", None),
        ("明天的下周三", "2026-10-28", None),
        ("明天的后一天的后两天", "2026-10-25", None),
        ("tomorrow at midnight run", "2026-10-22", "00:00"),
    ],
)
def test_compositional_dates(text: str, date: str, time: str | None) -> None:
    result = parse(text)
    assert result.normalized_date == dt.date.fromisoformat(date)
    assert result.normalized_time == (dt.time.fromisoformat(time) if time else None)
    assert not result.needs_confirmation


@pytest.mark.parametrize(
    ("text", "start", "end"),
    [
        ("明年三月初", "2027-03-01", "2027-03-10"),
        ("下下个月", "2026-12-01", "2026-12-31"),
        ("这两天处理一下", "2026-10-21", "2026-10-23"),
        ("两周以内", "2026-10-21", "2026-11-04"),
        ("下周找一天完成", "2026-10-26", "2026-11-01"),
        ("irgendwann nächste Woche", "2026-10-26", "2026-11-01"),
        ("end of next week", "2026-10-30", "2026-11-01"),
    ],
)
def test_ranges_never_autofill_an_arbitrary_day(text: str, start: str, end: str) -> None:
    result = parse(text)
    assert result.precision == "range" and result.needs_confirmation
    assert result.normalized_date is None and result.normalized_time is None
    assert result.candidates[0].value.date == dt.date.fromisoformat(start)
    assert result.candidates[0].value.end == dt.date.fromisoformat(end)


@pytest.mark.parametrize("text", ["尽量早点", "ASAP", "as soon as possible", "dringend"])
def test_urgency_is_not_a_date(text: str) -> None:
    result = parse(text)
    assert result.status == "urgency"
    assert not result.candidates and result.normalized_date is None


@pytest.mark.parametrize(
    "text", ["renew passport", "整理2025年的财务报表", "write next chapter", "read Friday's report"]
)
def test_content_is_preserved_without_deadline(text: str) -> None:
    quick = parse_quick_task(text, now=NOW, tz=TZ)
    assert quick.title == text and quick.due is None


@pytest.mark.parametrize(
    "text",
    ["明天 25:99 提交", "2026-02-30 提交", "2025年13月1号提交", "February 30 提交", "31/02/2026 提交", "24:00 开会"],
)
def test_invalid_literals_are_not_rescued_as_substring_dates(text: str) -> None:
    result = parse(text)
    assert result.status == "unresolved"
    assert result.normalized_date is None and result.normalized_time is None
    assert not any(c.selectable for c in result.candidates)
    assert parse("0000-01-01").status == "unresolved"
    assert parse("01/02/0000").status == "unresolved"


def test_time_only_and_unknown_wording() -> None:
    result = parse("15:30 call mom")
    assert result.precision == "time" and result.normalized_time == dt.time(15, 30)
    assert result.normalized_date is None and "date_required" in result.explanation
    result = parse("tommorow send")
    assert result.status == "unresolved" and result.normalized_date is None
    assert parse("改天再说").normalized_date is None


def test_semantic_relationships_and_corrections() -> None:
    result = parse("周五考试，周三之前复习完。")
    assert result.normalized_date == dt.date(2026, 10, 21)
    assert "deadline_preferred" in result.explanation
    assert len(result.candidates) == 2
    assert parse("不是周五，是下周一交作业").normalized_date == dt.date(2026, 10, 26)
    assert parse("明天，不对，后天交作业").normalized_date == dt.date(2026, 10, 23)
    assert parse("not Friday but Monday submit").normalized_date == dt.date(2026, 10, 26)
    assert parse("from Monday to Friday finish").normalized_date == dt.date(2026, 10, 30)
    for text in ("周五考试，周三复习", "如果周五没完成，就周日处理", "周五或周日处理"):
        result = parse(text)
        assert result.needs_confirmation and result.normalized_date is None
        assert len(result.candidates) == 2


@pytest.mark.parametrize(
    ("text", "title"),
    [
        ("明天早上10点去看牙医", "去看牙医"),
        ("submit report by Oct 25 5pm", "submit report"),
        ("Miete bis 1.11. überweisen", "Miete überweisen"),
        ("不是周五，是下周一交作业", "交作业"),
        ("明天，不对，后天交作业", "交作业"),
        ("周五考试，周三之前复习完。", "周五考试，复习完"),
    ],
)
def test_title_removes_only_the_selected_expression(text: str, title: str) -> None:
    assert parse_quick_task(text, now=NOW, tz=TZ).title == title


def test_missing_year_and_past_deadlines_remain_candidates() -> None:
    result = parse("submit report by Oct 20 5pm")
    assert result.normalized_date is None and result.needs_confirmation
    assert {c.value.date for c in result.candidates} == {dt.date(2026, 10, 20), dt.date(2027, 10, 20)}
    assert "missing_year_past" in result.explanation
    for text, date in [
        ("昨天", dt.date(2026, 10, 20)),
        ("前天", dt.date(2026, 10, 19)),
        ("2020-01-01", dt.date(2020, 1, 1)),
    ]:
        result = parse(text)
        assert result.candidates[0].value.date == date
        assert result.needs_confirmation and result.normalized_date is None
    assert parse("今天 08:00").needs_confirmation
    assert parse("Feb 29").candidates[0].value.date == dt.date(2028, 2, 29)
    assert parse("10/11/2026").needs_confirmation


def test_unknown_event_anchor_does_not_use_today() -> None:
    for text in ("签约后三天内付款", "within three days after signing pay"):
        result = parse(text)
        assert result.normalized_date is None
        assert "unknown_anchor" in result.explanation
        assert all(c.value.date is None for c in result.candidates)


def test_ambiguity_and_exaggeration() -> None:
    result = parse("next Friday at 5pm")
    assert result.normalized_date is None
    assert {c.value.date for c in result.candidates} == {dt.date(2026, 10, 23), dt.date(2026, 10, 30)}
    result = parse("大大大大大大大后天")
    assert result.needs_confirmation and result.confidence < 0.8
    assert result.candidates[0].value.date == dt.date(2026, 10, 30)
    assert parse("差不多月底").normalized_date is None
    result = parse("两周内的周二提交")
    assert result.normalized_date is None and result.needs_confirmation
    assert {c.value.date for c in result.candidates} == {dt.date(2026, 10, 27), dt.date(2026, 11, 3)}
    assert parse("周末之前弄完").candidates[0].value.date == dt.date(2026, 10, 23)
    result = parse("下周末提交")
    assert result.candidates[0].value.date == dt.date(2026, 10, 31)
    assert result.candidates[0].value.end == dt.date(2026, 11, 1)
    assert parse("10 Uhr am Freitag Zahnarzt").normalized_time == dt.time(10)
    assert parse("一百零三天后提交").normalized_date == NOW.date() + dt.timedelta(days=103)


def test_dst_gap_and_fold_do_not_become_fictitious_instants() -> None:
    now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    for text, reason in [("2026-03-29 02:30 开会", "nonexistent_time"), ("2026-10-25 02:30 开会", "ambiguous_time")]:
        result = parse(text, now)
        assert result.normalized_time is None and result.needs_confirmation
        assert reason in result.explanation and not result.candidates[0].selectable
    assert parse("2026-03-29 03:30 开会", now).normalized_time == dt.time(3, 30)
    before_dst = dt.datetime(2026, 3, 28, 23, 30, tzinfo=ZoneInfo(TZ))
    assert parse("明天 23:30", before_dst).normalized_date == dt.date(2026, 3, 29)
    assert parse("明天 02:30 UTC", now).needs_confirmation


@pytest.mark.parametrize("year", [2024, 2025, 2026, 2028])
def test_month_shifts_and_ranges_always_produce_valid_calendar_dates(year: int) -> None:
    for month in range(1, 13):
        start = dt.date(year, month, calendar.monthrange(year, month)[1])
        for offset in range(-14, 15):
            actual = shift(start, offset, "month")
            expected_year, zero_month = divmod(year * 12 + month - 1 + offset, 12)
            assert (actual.year, actual.month) == (expected_year, zero_month + 1)
            assert actual.day == min(start.day, calendar.monthrange(actual.year, actual.month)[1])
        result = parse("下个月月底", dt.datetime.combine(start, dt.time(12), ZoneInfo(TZ)))
        assert result.normalized_date == shift(start.replace(day=1), 2, "month") - dt.timedelta(days=1)


def test_generated_modifier_and_recursive_offset_properties() -> None:
    for count in range(1, 35):
        result = parse("大" * count + "后天提交")
        assert result.candidates[0].value.date == NOW.date() + dt.timedelta(days=count + 2)
        assert result.needs_confirmation == (count > 1)
        result = parse("下" * count + "周五提交")
        assert result.normalized_date == dt.date(2026, 10, 23) + dt.timedelta(weeks=count)
    for a in range(1, 15):
        for b in range(1, 8):
            result = parse(f"{a}天后的后{b}天提交")
            assert result.normalized_date == NOW.date() + dt.timedelta(days=a + b)


@pytest.mark.parametrize("zone", ["Europe/Berlin", "America/New_York", "Pacific/Kiritimati", "Asia/Shanghai"])
def test_relative_dates_are_consistent_with_local_calendar(zone: str) -> None:
    for hour in (0, 12, 23):
        now = dt.datetime(2026, 12, 31, hour, 30, tzinfo=dt.UTC)
        result = parse("后天", now, zone)
        assert result.normalized_date == now.astimezone(ZoneInfo(zone)).date() + dt.timedelta(days=2)


def test_business_days_only_skip_weekends() -> None:
    friday = dt.datetime(2026, 12, 25, 8, tzinfo=dt.UTC)
    result = parse("下个工作日", friday)
    assert result.normalized_date == dt.date(2026, 12, 28)
    assert "weekdays_only" in result.explanation
    for days in range(1, 30):
        assert shift(friday.date(), days, "business").weekday() < 5


def test_semantic_extension_is_validated_and_never_autofilled() -> None:
    class Provider:
        def propose(self, text: str, **kwargs: Any) -> list[Expression]:
            return [Expression(0, len(text), [Operation("offset", 3, "day")])]

    result = parse_temporal("custom idiom", now=NOW, timezone=TZ, provider=Provider())
    assert result.candidates[0].value.date == dt.date(2026, 10, 24)
    assert result.needs_confirmation and result.normalized_date is None

    class InvalidProvider:
        def propose(self, text: str, **kwargs: Any) -> list[Expression]:
            return [Expression(0, len(text), [Operation("literal", parts=(2026, 2, 30))])]

    result = parse_temporal("custom idiom", now=NOW, timezone=TZ, provider=InvalidProvider())
    assert result.status == "unresolved" and result.normalized_date is None


def test_api_timezone_validation_and_no_implicit_candidate_persistence(api: Any) -> None:
    api.container.clock.now = dt.datetime(2026, 10, 21, 23, 30, tzinfo=dt.UTC)
    response = api.post("/api/tasks/quick-parse", json={"text": "明天交作业", "timezone": "Europe/Berlin"})
    assert response.json()["due_date"] == "2026-10-23"
    parsed = api.post("/api/tasks/quick-parse", json={"text": "大大后天交作业"}).json()
    assert parsed["due_date"] is None and parsed["temporal"]["needs_confirmation"]
    task = api.post("/api/tasks", json=parsed).json()
    assert task["due_date"] is None and task["title"] == "大大后天交作业"
    for path, body in [("quick-parse", {"text": "明天"}), ("", {"title": "task"})]:
        assert (
            api.post("/api/tasks" + ("/" + path if path else ""), json={**body, "timezone": "Invalid/Zone"}).status_code
            == 422
        )
    for date, code in [("2026-03-29", "nonexistent_time"), ("2026-10-25", "ambiguous_time")]:
        response = api.post(
            "/api/tasks", json={"title": "meeting", "due_date": date, "due_time": "02:30", "timezone": TZ}
        )
        assert response.status_code == 422 and response.json()["error"]["code"] == code
    assert wall_time_status(dt.date(2026, 10, 25), dt.time(3, 30), TZ) == "valid"
