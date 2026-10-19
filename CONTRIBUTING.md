# Contributing to TaskRadar

Thanks for helping. TaskRadar keeps people's to-dos on their own computer, so a few rules come before everything else.

## Ground rules

* **Synthetic data only.** Never commit real tasks, e-mails, screenshots of your own data, tokens, client secrets or
  databases — not even "anonymised" ones. Test data lives in `backend/tests/` and `frontend/src/test/` and is written
  by hand.
* **No silent side effects.** Anything that leaves the machine or changes the system (Google APIs, autostart, the
  Start menu, notifications, files outside TaskRadar's own data folder) must go through `PermissionGuard.check()` and
  be covered by a test that shows it is refused without permission.
* **Never invent facts.** Date parsing must keep date-only deadlines date-only and say when a date is ambiguous
  instead of guessing.
* **Tests don't get weakened to pass.** If a test fails, fix the code or explain in the PR why the expectation was
  wrong. Do not delete failing tests or replace real behaviour with mocks to make them green.
* **Report numbers from real runs only** (sizes, start-up times), with how they were measured.

## Development setup

Windows (the target platform):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Dev    # backend[dev] + frontend build + migrations
```

macOS / Linux (everything except Windows-only features such as the window, the tray, autostart and notifications):

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
cd ../frontend && npm ci && npm run build
```

### Running with hot reload

Use a separate data folder so development never touches your real data (`/data/` is git-ignored):

```powershell
# terminal 1 - API on 127.0.0.1:8000, accepting the Vite dev origin for state-changing requests
$env:TASKRADAR_DEV_ORIGIN = "http://127.0.0.1:5173"
backend\.venv\Scripts\python.exe -m taskradar serve --no-browser --data-dir data

# terminal 2 - Vite dev server on 127.0.0.1:5173, proxies /api to the backend
cd frontend; npm run dev
```

Open <http://127.0.0.1:5173>. The API documentation is at <http://127.0.0.1:8000/api/docs>. To try the desktop window
with a test data folder: `backend\.venv\Scripts\python.exe -m taskradar desktop --data-dir data`.

## Checks

Run before every commit; CI runs the same commands (on Ubuntu, where the Windows-only tests are skipped).

```powershell
cd backend
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m ruff format --check .      # format with: ruff format .
.venv\Scripts\python.exe -m mypy
.venv\Scripts\python.exe -m mypy --platform linux      # as CI sees it
.venv\Scripts\python.exe -m pytest

cd ..\frontend
npm run lint
npm run typecheck
npm test
npm run build
```

## Where things live

* `backend/src/taskradar/` — see [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.
* `backend/tests/conftest.py` — fixtures: a fixed clock (`FIXED_NOW`, 2026-10-14 08:00 UTC, with `advance()`), a fake
  Calendar, recorded Windows notifications instead of real ones, an in-memory secret store, isolated temporary data
  folders and an API client with the CSRF header set (with a Start menu folder of its own, never yours).
* `frontend/src/` — `pages/`, `components/` (`ui/` primitives, `tasks/`, `timers/`, `settings/`, `layout/`), `lib/`
  (API client, types mirroring `api/serializers.py`, queries, timers, formatting), `i18n/`.

## Database changes

Edit `db/models.py`, then create a migration (SQLite needs batch mode, which `env.py` enables):

```powershell
cd backend
.venv\Scripts\alembic.exe revision --autogenerate -m "describe the change"
```

Review the generated file in `src/taskradar/migrations/versions/`; migrations run automatically on start-up, and a
test fails when the migrations and the models disagree.

## Translations

UI strings live in `frontend/src/i18n/zh-CN.ts` (the source of truth for keys) and `frontend/src/i18n/en.ts`. A unit
test fails if the key sets or `{{placeholders}}` differ. Backend error codes are translated in the `errors` section;
new error codes need an entry there.

## Commits and pull requests

Small, focused commits with a message that explains *why*. A PR should describe the behaviour change, how it was
tested, and any effect on privacy or permissions.
