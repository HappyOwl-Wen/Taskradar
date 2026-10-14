"""Process-level configuration (paths, network binding).

User-adjustable behaviour (scan intervals, reminder thresholds, LLM provider, ...) lives in the
database-backed settings service (:mod:`taskradar.services.settings`). This module only covers
what must be known *before* the database is opened.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "TaskRadar"
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def default_data_dir() -> Path:
    env = os.environ.get("TASKRADAR_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / APP_NAME
    return Path.home() / ".local" / "share" / APP_NAME


@dataclass(frozen=True)
class AppConfig:
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8000
    dev_origin: str | None = None
    open_browser: bool = True
    scheduler_enabled: bool = True
    log_level: str = "INFO"
    tesseract_cmd: str | None = None
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "taskradar.db"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def uploads_dir(self) -> Path:
        return self.files_dir / "uploads"

    @property
    def attachments_dir(self) -> Path:
        return self.files_dir / "attachments"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def tools_dir(self) -> Path:
        return self.data_dir / "tools"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def base_url(self) -> str:
        host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host  # noqa: S104
        return f"http://{host}:{self.port}"

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.uploads_dir, self.attachments_dir, self.logs_dir, self.exports_dir):
            path.mkdir(parents=True, exist_ok=True)


def load_dotenv(path: Path) -> None:
    """Minimal ``.env`` loader (KEY=VALUE lines). Existing environment variables win.

    Values are never logged. Only used for developer convenience; the application stores
    secrets in the OS credential store.
    """
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_config(**overrides: object) -> AppConfig:
    host = os.environ.get("TASKRADAR_HOST", "127.0.0.1")
    if host not in LOOPBACK_HOSTS and not _env_flag("TASKRADAR_ALLOW_NON_LOOPBACK"):
        raise ValueError(
            f"Refusing to bind to non-loopback host {host!r}. TaskRadar serves private data; "
            "set TASKRADAR_ALLOW_NON_LOOPBACK=1 only if you really know what you are doing."
        )
    values: dict[str, object] = {
        "data_dir": default_data_dir(),
        "host": host,
        "port": int(os.environ.get("TASKRADAR_PORT", "8000")),
        "dev_origin": os.environ.get("TASKRADAR_DEV_ORIGIN") or None,
        "open_browser": not _env_flag("TASKRADAR_NO_BROWSER"),
        "scheduler_enabled": not _env_flag("TASKRADAR_DISABLE_SCHEDULER"),
        "log_level": os.environ.get("TASKRADAR_LOG_LEVEL", "INFO").upper(),
        "tesseract_cmd": os.environ.get("TASKRADAR_TESSERACT_CMD") or None,
    }
    values.update(overrides)
    return AppConfig(**values)  # type: ignore[arg-type]
