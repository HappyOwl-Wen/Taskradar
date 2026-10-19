"""Security & privacy guarantees."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from taskradar.db.models import AuditLog, Task
from taskradar.db.session import transaction
from taskradar.security import secrets as sk
from taskradar.security.redact import RedactingFilter, redact_secrets
from taskradar.services.system import AutostartManager


def test_state_changing_requests_require_csrf_token(api: Any) -> None:
    token = api.headers.pop("X-TaskRadar-CSRF")
    response = api.post("/api/tasks", json={"title": "x"})
    assert response.status_code == 403 and response.json()["error"]["code"] == "csrf_failed"
    response = api.post("/api/tasks", json={"title": "x"}, headers={"X-TaskRadar-CSRF": "wrong"})
    assert response.status_code == 403
    api.headers["X-TaskRadar-CSRF"] = token
    assert api.post("/api/tasks", json={"title": "x"}).status_code == 201


def test_foreign_host_header_is_rejected(api: Any) -> None:
    # DNS rebinding: an attacker domain resolving to 127.0.0.1 still sends its own Host header.
    response = api.get("/api/tasks", headers={"Host": "evil.example:8000"})
    assert response.status_code == 421


def test_cross_origin_writes_are_rejected(api: Any) -> None:
    response = api.post("/api/tasks", json={"title": "x"}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403 and response.json()["error"]["code"] == "cross_origin_rejected"
    response = api.post("/api/tasks", json={"title": "x"}, headers={"Sec-Fetch-Site": "cross-site"})
    assert response.status_code == 403


def test_security_headers(api: Any) -> None:
    response = api.get("/api/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"


def test_web_ui_files_never_come_from_outside_its_folder(api: Any) -> None:
    secret = Path(api.container.config.data_dir) / "taskradar.db"
    assert secret.is_file()
    for path in ("/..%2F..%2Ftaskradar.db", "/%2e%2e/%2e%2e/taskradar.db", "/assets/../../taskradar.db"):
        response = api.get(path)
        assert response.status_code in (200, 404)
        assert b"SQLite format" not in response.content  # the page (or nothing), never the database


def test_the_google_client_file_is_checked_before_it_is_stored(api: Any) -> None:
    too_big = api.post("/api/integrations/google/client-config", files={"file": ("c.json", b"x" * (64 * 1024 + 1))})
    assert too_big.status_code == 413
    web = json.dumps({"web": {"client_id": "1.apps.googleusercontent.com"}}).encode()
    wrong = api.post("/api/integrations/google/client-config", files={"file": ("c.json", web)})
    assert wrong.json()["error"]["code"] == "wrong_client_type"
    assert api.container.secrets.get(sk.GOOGLE_CLIENT_CONFIG) is None


def test_secrets_are_redacted_from_logs(caplog: pytest.LogCaptureFixture) -> None:
    logger = logging.getLogger("taskradar.test")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO, logger="taskradar.test"):
        logger.info(
            "key=%s token ya29.a0AfH6SMBx refresh 1//0gLongRefreshToken123456 secret GOCSPX-abc123",
            "sk-proj-abcdefghijklmnopqrstu",
        )
        logger.info("GET /api/oauth/google/callback?state=xyz&code=4/0AbCdEf HTTP/1.1")
    text = caplog.text
    for leaked in ("abcdefghijklmnop", "ya29.a0AfH6", "0gLongRefresh", "GOCSPX-abc", "4/0AbCdEf", "state=xyz"):
        assert leaked not in text
    assert redact_secrets('{"refresh_token": "1//abc"}') == '{"refresh_token": "***"}'


def test_what_removed_features_stored_can_only_be_deleted(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """A Gmail sign-in and a model API key of earlier versions: never used or shown, deleted on request."""
    revoked: list[dict[str, str]] = []
    monkeypatch.setattr("requests.post", lambda url, data, timeout: revoked.append({"url": url, **data}))
    secrets = api.container.secrets
    secrets.set(sk.GOOGLE_TOKEN_GMAIL, json.dumps({"token": "ya29.old", "refresh_token": "1//old-refresh"}))
    secrets.set(sk.OPENAI_API_KEY, "sk-proj-THISISASECRETKEY1234567890")
    secrets.set(sk.GOOGLE_CLIENT_CONFIG, '{"installed": {}}')

    legacy = api.get("/api/data/legacy")
    assert legacy.json() == {"messages": 0, "documents": 0, "credentials": ["gmail", "llm_api_key"]}
    for path in ("/api/data/legacy", "/api/settings", "/api/system/status", "/api/integrations/google"):
        text = api.get(path).text
        assert "THISISASECRET" not in text and "old-refresh" not in text and "ya29.old" not in text
    # Only the two known entries can be deleted this way (not the Calendar sign-in or the client file).
    assert api.delete("/api/data/legacy-credentials/google_client_config").status_code == 404
    assert api.delete("/api/data/legacy-credentials/llm_api_key").json() == {"credentials": ["gmail"]}
    assert api.delete("/api/data/legacy-credentials/gmail").json() == {"credentials": []}
    assert secrets.get(sk.GOOGLE_TOKEN_GMAIL) is None and secrets.get(sk.OPENAI_API_KEY) is None
    assert secrets.get(sk.GOOGLE_CLIENT_CONFIG) is not None
    # The Gmail sign-in is revoked at Google too, so it cannot be used anywhere any more.
    assert revoked == [{"url": "https://oauth2.googleapis.com/revoke", "token": "1//old-refresh"}]
    with transaction(api.container.factory) as session:
        audited = [(a.action, a.target) for a in session.scalars(select(AuditLog))]
    assert ("credential.delete", "gmail") in audited and ("credential.delete", "llm_api_key") in audited


def test_settings_of_removed_features_cannot_be_written(api: Any) -> None:
    for section in ("llm", "gmail", "folders", "policy", "demo"):
        response = api.put("/api/settings", json={section: {"provider": "openai"}})
        assert response.status_code == 422, section
    assert set(api.get("/api/settings").json()) == {"general", "reminders", "notifications", "calendar", "timers"}


def test_destructive_actions_need_explicit_confirmation(api: Any) -> None:
    api.post("/api/tasks", json={"title": "keep me"})
    assert api.post("/api/data/delete-all", json={"confirm": "yes"}).status_code == 403
    assert api.post("/api/data/delete-imported", json={}).status_code == 400
    with transaction(api.container.factory) as session:
        assert session.scalars(select(Task)).first() is not None
    assert api.post("/api/data/delete-all", json={"confirm": "DELETE"}).status_code == 200
    with transaction(api.container.factory) as session:
        assert session.scalars(select(Task)).first() is None


def test_autostart_is_never_changed_without_confirmation(api: Any, tmp_path: Path) -> None:
    manager = AutostartManager(startup_dir=tmp_path / "Startup")
    api.app.state.autostart = manager
    assert api.post("/api/system/autostart", json={"enabled": True}).status_code == 403
    assert not manager.enabled()
    assert api.post("/api/system/autostart", json={"enabled": True, "confirm": True}).json()["enabled"] is True
    assert manager.enabled()
    assert api.post("/api/system/autostart", json={"enabled": False, "confirm": True}).json()["enabled"] is False
