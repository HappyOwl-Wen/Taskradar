# Agent UI fixture

From the repository root, after `npm run build` in `frontend/`:

```powershell
backend\.venv\Scripts\python.exe scripts\agent-check\launch.py --data-dir build\agent-check\review
```

Open <http://127.0.0.1:8146>. The app and a scripted Claude-compatible API run on ports 8146 and 8147.
They use MemorySecretStore, a Fake Calendar client, a fixed 23 October 2026 clock and synthetic data only.
There are no real API requests or accesses to the user's data folder or Credential Manager.
Only scratch data paths inside `build/agent-check/` are accepted. Choose a fresh directory for a clean check.

Open the AI Agent button in the top bar. Ask `解释一下番茄工作法` for ordinary chat, or `帮我安排项目报告`
for a deterministic task + linked work-block proposal. Check that neither exists until Apply; apply and inspect
the task/calendar, repeat Apply through the API to verify the receipt, start another chat, discard a proposal,
and check the panel in light/dark, Chinese/English, and narrow/wide windows. Settings → AI Agent uses the real
settings and credential endpoints with the fixture's in-memory credentials. This fixture tests UI/transport;
it does not evaluate a real model's planning quality or live provider/account access.

The fake `/models` endpoint reports two models with thinking capabilities. Check automatic detection, refresh,
model/thinking selection, and drag/keyboard width changes (including persistence and narrow-window clamping).
Model and thinking settings open from the single composer button; execution mode and prompt suggestions have compact
buttons on its left. Check popup dismissal, keyboard focus, draft preservation and truncation at the 320px panel width.
The ordinary-chat reply includes Markdown tables, task lists, code and native-delimited math. Enable model titles
with `claude-haiku-5-5` as the title model and model suggestions in settings, then start a new chat. Verify the title
and three follow-up prompts; clicking a prompt should only fill the composer. In YOLO mode a new plan should apply
automatically, while older Restricted proposals remain pending. Both modes use the same application pipeline.

The fixture also implements a bounded synthetic prefix cache, returning estimated usage counters to exercise the
real HTTP parser and the Usage and cache disclosure. It uses hashes and a character-count heuristic, not a real
model tokenizer or bill. Check reuse through tool rounds and follow-up messages, missing versus zero counters in
unit tests, and off/5-minute/1-hour settings. Screenshots from this fixture do not verify a live gateway's caching,
account charges or production hit rates. No production credential is used to warm or test caches.
