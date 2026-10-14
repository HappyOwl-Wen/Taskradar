# Contributing to TaskRadar

Thanks for helping. TaskRadar handles private mail and documents, so a few rules come before everything else.

## Ground rules

* **Synthetic data only.** Never commit real e-mails, letters, screenshots, tokens, client secrets or databases —
  not even "anonymised" ones. Test data lives in `backend/src/taskradar/demo/` and `backend/tests/` and is written
  by hand or generated (`python -m taskradar demo-files <folder>`).
* **No silent side effects.** Anything that leaves the machine or changes the system (Google APIs, LLM requests,
  autostart, notifications, file access outside TaskRadar's storage) must go through
  `PermissionGuard.check()` and be covered by a test that shows it is refused without permission.
* **Never invent facts.** Extraction changes must keep date-only deadlines date-only, keep evidence verifiable and
  flag uncertainty instead of guessing.
* **Tests don't get weakened to pass.** If a test fails, fix the code or explain in the PR why the expectation was
  wrong. Do not delete failing tests or replace real behaviour with mocks to make them green.
* **Report numbers from real runs only** (evaluation, performance), with the command that produced them.

## Development setup

Windows (the target platform):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Dev    # backend[dev] + frontend build + migrations
powershell -ExecutionPolicy Bypass -File scripts\install-tesseract.ps1   # OCR, needed for the OCR tests
```

macOS / Linux (everything except Windows-only features such as autostart and toasts):

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
cd ../frontend && npm ci && npm run build
# OCR: install tesseract with the deu and chi_sim models (see .github/workflows/ci.yml)
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

Open <http://127.0.0.1:5173>. The API documentation is at <http://127.0.0.1:8000/api/docs>.

## Checks

Run before every commit; CI runs the same commands.

```powershell
cd backend
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m ruff format --check .      # format with: ruff format .
.venv\Scripts\python.exe -m mypy
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m taskradar eval              # development set
.venv\Scripts\python.exe -m taskradar eval --dataset src\taskradar\demo\eval_holdout.json

cd ..\frontend
npm run lint
npm run typecheck
npm test
npm run build
```

## Where things live

* `backend/src/taskradar/` — see [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.
* `backend/tests/conftest.py` — fixtures: a fixed clock (`FIXED_NOW`, 2026-10-14 08:00 UTC, with `advance()`),
  a fake Gmail mailbox, a fake Calendar, an in-memory secret store, isolated temporary data folders and an API
  client with the CSRF header set. Tests that need Tesseract use `@requires_ocr` and are skipped without it.
* `frontend/src/` — `pages/`, `components/` (`ui/` primitives, `tasks/`, `sources/`, `settings/`, `layout/`),
  `lib/` (API client, types mirroring `api/serializers.py`, queries, formatting), `i18n/`.

## Changing the extractor

1. Add or adjust cases in `backend/src/taskradar/demo/eval_dataset.json` (the development set) and unit tests in
   `tests/test_extraction.py` / `tests/test_dates.py`.
2. Do **not** tune against `eval_holdout.json`. If a held-out case reveals a bug, fix it, say so in
   [docs/EVALUATION.md](docs/EVALUATION.md) (that case is then no longer independent) and add fresh held-out cases
   before the next measurement.
3. Bump `RULES_VERSION` in `extraction/rules.py` (or `PROMPT_VERSION` for the LLM prompt) when behaviour changes, and
   update the numbers in the docs from a real run.

## Database changes

Edit `db/models.py`, then create a migration (SQLite needs batch mode, which `env.py` enables):

```powershell
cd backend
.venv\Scripts\alembic.exe revision --autogenerate -m "describe the change"
```

Review the generated file in `src/taskradar/migrations/versions/`; migrations run automatically on start-up.

## Translations

UI strings live in `frontend/src/i18n/zh-CN.ts` (the source of truth for keys) and `frontend/src/i18n/en.ts`.
A unit test fails if the key sets or `{{placeholders}}` differ. Backend error codes are translated in the
`errors` section; new error codes need an entry there.

## Commits and pull requests

Small, focused commits with a message that explains *why*. A PR should describe the behaviour change, how it was
tested, and any effect on privacy, permissions or the evaluation numbers.
