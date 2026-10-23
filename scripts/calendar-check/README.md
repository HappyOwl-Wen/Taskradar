# Calendar UI fixture

Run from the repository root after `cd frontend; npm run build`:

```powershell
backend\.venv\Scripts\python.exe scripts\calendar-check\launch.py --desktop --data-dir build\calendar-check\fresh-review
backend\.venv\Scripts\python.exe scripts\calendar-check\launch.py --local --port 8135 --data-dir build\calendar-check\fresh-local
```

The fixture uses MemorySecretStore and FakeCalendarClient, never the user's Credential Manager or real Google account.
It creates local deadlines, undated tasks and work plans, a writable primary calendar, TaskRadar's own calendar, a
read-only team calendar, overlapping events, a multi-day all-day event, overnight and DST events, recurring instances
and an exception. `--local` omits Google authorization entirely. Only data directories inside `build/calendar-check/`
are accepted. Use a fresh directory for each complete run: the fake remote resets when the process exits.

The desktop mode exposes WebView2 debugging on port 9234 for checks only. Never enable it for normal use.
See [verification](../../docs/CALENDAR_VERIFICATION.zh-CN.md) for results and limitations.
