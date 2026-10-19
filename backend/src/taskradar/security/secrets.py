"""Secret storage in the operating system's credential store (Windows Credential Manager).

OAuth tokens and API keys never touch the database, log files or the repository. Windows limits a
generic credential blob to 2560 bytes (~1280 UTF-16 characters), so long values are chunked.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from typing import Any, Protocol

log = logging.getLogger(__name__)

OPENAI_API_KEY = "openai_api_key"
GOOGLE_CLIENT_CONFIG = "google_client_config"
GOOGLE_TOKEN_GMAIL = "google_token_gmail"  # noqa: S105 - name of a credential-store entry, not a secret
GOOGLE_TOKEN_CALENDAR = "google_token_calendar"  # noqa: S105 - name of a credential-store entry, not a secret

# What removed features stored (Gmail reading, analysis by a language model): only ever deleted, never used.
LEGACY_SECRETS = {"gmail": GOOGLE_TOKEN_GMAIL, "llm_api_key": OPENAI_API_KEY}

_CHUNK = 1000


class SecretStoreError(RuntimeError):
    code = "secret_store_unavailable"


class SecretStore(Protocol):
    backend_name: str

    def get(self, key: str) -> str | None: ...

    def set(self, key: str, value: str) -> None: ...

    def delete(self, key: str) -> None: ...

    def available(self) -> bool: ...


class KeyringSecretStore:
    """Backed by :mod:`keyring` (Windows Credential Manager on Windows)."""

    def __init__(self, service: str = "TaskRadar") -> None:
        self.service = service
        self._lock = threading.Lock()
        self._keyring: Any = None
        try:
            import keyring

            self._keyring = keyring
            self.backend_name = type(keyring.get_keyring()).__name__
        except Exception as exc:  # pragma: no cover - import failure
            log.error("keyring unavailable: %s", exc.__class__.__name__)
            self._keyring = None
            self.backend_name = "unavailable"

    def available(self) -> bool:
        if self._keyring is None:
            return False
        name = self.backend_name.lower()
        return "fail" not in name and "null" not in name

    def _require(self) -> object:
        if not self.available():
            raise SecretStoreError("No secure credential store is available on this system")
        return self._keyring

    def get(self, key: str) -> str | None:
        kr = self._require()
        with self._lock:
            head = kr.get_password(self.service, key)  # type: ignore[attr-defined]
            if head is None:
                return None
            if not head.startswith("chunked:"):
                return head
            count = int(head.split(":", 1)[1])
            parts = []
            for i in range(count):
                part = kr.get_password(self.service, f"{key}#{i}")  # type: ignore[attr-defined]
                if part is None:
                    log.warning("Secret %s is incomplete", key)
                    return None
                parts.append(part)
            return "".join(parts)

    def set(self, key: str, value: str) -> None:
        kr = self._require()
        with self._lock:
            self._delete_unlocked(kr, key)
            if len(value) <= _CHUNK:
                kr.set_password(self.service, key, value)  # type: ignore[attr-defined]
                return
            chunks = [value[i : i + _CHUNK] for i in range(0, len(value), _CHUNK)]
            for i, chunk in enumerate(chunks):
                kr.set_password(self.service, f"{key}#{i}", chunk)  # type: ignore[attr-defined]
            kr.set_password(self.service, key, f"chunked:{len(chunks)}")  # type: ignore[attr-defined]

    def delete(self, key: str) -> None:
        kr = self._require()
        with self._lock:
            self._delete_unlocked(kr, key)

    def _delete_unlocked(self, kr: object, key: str) -> None:
        import keyring.errors

        head = kr.get_password(self.service, key)  # type: ignore[attr-defined]
        if head is None:
            return
        if head.startswith("chunked:"):
            for i in range(int(head.split(":", 1)[1])):
                with contextlib.suppress(keyring.errors.PasswordDeleteError):
                    kr.delete_password(self.service, f"{key}#{i}")  # type: ignore[attr-defined]
        with contextlib.suppress(keyring.errors.PasswordDeleteError):
            kr.delete_password(self.service, key)  # type: ignore[attr-defined]


class MemorySecretStore:
    """In-memory store for tests and the isolated demo mode."""

    backend_name = "memory"

    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    def available(self) -> bool:
        return True

    def get(self, key: str) -> str | None:
        return self._data.get(key)

    def set(self, key: str, value: str) -> None:
        self._data[key] = value

    def delete(self, key: str) -> None:
        self._data.pop(key, None)
