"""Domain enumerations shared by the pipeline, persistence and API layers."""

from __future__ import annotations

from enum import StrEnum


class TaskStatus(StrEnum):
    CANDIDATE = "candidate"
    CONFIRMED = "confirmed"
    IN_PROGRESS = "in_progress"
    WAITING_FOR_REPLY = "waiting_for_reply"
    COMPLETED = "completed"
    DISMISSED = "dismissed"


ACTIVE_STATUSES: frozenset[TaskStatus] = frozenset(
    {TaskStatus.CANDIDATE, TaskStatus.CONFIRMED, TaskStatus.IN_PROGRESS, TaskStatus.WAITING_FOR_REPLY}
)
"""Statuses that still require attention (reminders apply)."""

COMMITTED_STATUSES: frozenset[TaskStatus] = frozenset(
    {TaskStatus.CONFIRMED, TaskStatus.IN_PROGRESS, TaskStatus.WAITING_FOR_REPLY}
)
"""Statuses the user explicitly accepted."""

CLOSED_STATUSES: frozenset[TaskStatus] = frozenset({TaskStatus.COMPLETED, TaskStatus.DISMISSED})


class Category(StrEnum):
    ACADEMIC = "academic"
    ADMINISTRATIVE = "administrative"
    FINANCIAL = "financial"
    TRAVEL = "travel"
    PERSONAL = "personal"
    OTHER = "other"


class Priority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class DuePrecision(StrEnum):
    NONE = "none"
    """No deadline is known. ``due_at`` is null."""
    DATE = "date"
    """Only a calendar date is known (all-day). No time is invented."""
    DATETIME = "datetime"
    """An exact local date and time is known."""


class TimeSemantics(StrEnum):
    DEADLINE = "deadline"
    """Something must be done *before* this time."""
    APPOINTMENT = "appointment"
    """Something *happens at* this time (meeting, appointment, exam)."""


class DueAnchor(StrEnum):
    SOURCE_DATE = "source_date"
    DOCUMENT_DATE = "document_date"
    IMPORT_TIME = "import_time"


class Urgency(StrEnum):
    OVERDUE = "overdue"
    URGENT = "urgent"
    HIGH = "high"
    UPCOMING = "upcoming"
    NORMAL = "normal"
    NO_DEADLINE = "no_deadline"
    INACTIVE = "inactive"


class ActionType(StrEnum):
    SUBMIT = "submit"
    PAY = "pay"
    REGISTER = "register"
    REPLY = "reply"
    CONFIRM = "confirm"
    ATTEND = "attend"
    BOOK = "book"
    UPLOAD = "upload"
    SIGN = "sign"
    RENEW = "renew"
    APPLY = "apply"
    BRING = "bring"
    PREPARE = "prepare"
    CANCEL = "cancel"
    OTHER = "other"


class ContentType(StrEnum):
    OBLIGATION = "obligation"
    REMINDER = "reminder"
    COMPLETION_NOTICE = "completion_notice"
    STATUS_UPDATE = "status_update"
    MARKETING = "marketing"
    NEWSLETTER = "newsletter"
    INFORMATIONAL = "informational"
    OTHER = "other"


class CompletionKind(StrEnum):
    RECEIVED = "received"
    COMPLETED = "completed"
    PAID = "paid"
    APPROVED = "approved"
    CANCELLED = "cancelled"
    IN_REVIEW = "in_review"


class SourceKind(StrEnum):
    GMAIL = "gmail"
    DEMO_MAIL = "demo_mail"
    UPLOAD = "upload"
    FOLDER = "folder"
    SAMPLE_UPLOAD = "sample_upload"  # files and mails imported as test data


SAMPLE_SOURCE_KINDS: frozenset[str] = frozenset({SourceKind.DEMO_MAIL.value, SourceKind.SAMPLE_UPLOAD.value})
"""Sources whose items are demo or test data: their tasks are marked as samples."""


class JobKind(StrEnum):
    GMAIL_SYNC = "gmail_sync"
    FOLDER_SCAN = "folder_scan"
    FILE_IMPORT = "file_import"
    REMINDER_SCAN = "reminder_scan"
    REPROCESS = "reprocess"


class JobStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class JobTrigger(StrEnum):
    MANUAL = "manual"
    SCHEDULED = "scheduled"
    STARTUP = "startup"
    RETRY = "retry"


class Actor(StrEnum):
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


class EventType(StrEnum):
    CREATED = "created"
    STATUS_CHANGED = "status_changed"
    FIELDS_UPDATED = "fields_updated"
    SOURCE_ATTACHED = "source_attached"
    SOURCE_DETACHED = "source_detached"
    MERGED = "merged"
    SUGGESTION_CREATED = "suggestion_created"
    SUGGESTION_RESOLVED = "suggestion_resolved"
    REVERTED = "reverted"
    CALENDAR_SYNCED = "calendar_synced"
    CALENDAR_FAILED = "calendar_failed"
    CALENDAR_REMOVED = "calendar_removed"
    LINKED = "linked"
    REVIEW_RESOLVED = "review_resolved"  # the user cleared a review flag ("the new deadline is right")


class NotificationLevel(StrEnum):
    OVERDUE = "overdue"
    URGENT = "urgent"
    HIGH = "high"
    UPCOMING = "upcoming"
    INFO = "info"
    ERROR = "error"
