# Security and privacy

TaskRadar keeps your to-dos on your own computer. This document describes what it protects against, how, and what
remains your responsibility.

## Reporting a vulnerability

Please do not open a public issue for security problems. Contact the maintainer privately (via the contact details
on the repository owner's profile) with a description and, if possible, steps to reproduce.

## Assets and threat model

| Asset | Where it lives |
| --- | --- |
| Tasks, their history, timers, notifications, settings | SQLite database `%LOCALAPPDATA%\TaskRadar\taskradar.db` |
| Agent chats, proposals and application receipts | The same local database; included in export and delete-all |
| Agent API keys, separately for each protocol | Windows Credential Manager; never returned by the API or stored in settings |
| Mails and files imported by earlier versions (if any), with what was read from them | The same database and `%LOCALAPPDATA%\TaskRadar\files\`, until you delete them |
| Google OAuth client configuration and Calendar token | Windows Credential Manager (service "TaskRadar"), never files or the database |
| Logs | `%LOCALAPPDATA%\TaskRadar\logs\taskradar.log` (rotated, secrets masked) |

Threats considered:

1. **Other websites in your browser** attacking the local server (CSRF, DNS rebinding, clickjacking).
2. **Other users or devices on the network** reaching the server.
3. **Over-broad permissions** to Google services or the system.
4. **Leaking secrets or content** through logs, Git or error messages.
5. **Unwanted side effects**: writing to calendars, changing the Start menu or autostart, notifications you did not
   ask for.

Out of scope: an attacker who already controls your Windows account or the machine (they can read the database and
the Credential Manager), and the security of Google's services.

## Controls

### Network surface

* The server binds to `127.0.0.1` only. Binding to any other address is refused unless
  `TASKRADAR_ALLOW_NON_LOOPBACK=1` is set explicitly.
* **Host allow-list** (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`): requests with any other `Host` header
  get `421`, which defeats DNS-rebinding attacks.
* **CSRF**: every state-changing request under `/api` must carry `X-TaskRadar-CSRF` with a random per-process token
  (compared in constant time). The token is only readable by same-origin JavaScript; custom headers cannot be sent
  cross-origin without a CORS preflight, which is never granted. As defence in depth, a present `Origin` must be on
  the allow-list and `Sec-Fetch-Site` must be `same-origin` or `none`.
* **Response headers**: strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no external hosts),
  `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: no-store` for the API.
  The web UI loads no third-party resources.
* A file lock prevents two TaskRadar servers from using the same data folder.

### Desktop window, tray and installer

* The window loads only TaskRadar's own local address. Other `http`, `https` and `mailto` links open in your default
  browser; anything else is blocked. The Google sign-in happens in your default browser, never inside the window.
* The page has no JavaScript bridge into Python (pywebview's bridge needs `eval`, which the CSP forbids). It reports
  unsaved changes, theme and language through `PUT /api/desktop/state`, and a second start asks the running one to
  show its window through `POST /api/desktop/activate`; both are CSRF-protected like every other change and do not
  exist in the browser version.
* The context menu offers only editing commands; the WebView2 developer tools and their debugging port are off. The
  port opens only when `TASKRADAR_WEBVIEW_DEBUG_PORT` is set, for automated checks; with it any local program could
  control the page, so never set it for daily use.
* Closing the window keeps TaskRadar running in the tray (you can switch that off); "退出 TaskRadar" in the tray menu
  ends it. Notification text is shown as data (XML-escaped), never interpreted.
* The installer needs no administrator rights and writes only to `%LOCALAPPDATA%\Programs\TaskRadar`, the Start menu
  and (if ticked) desktop shortcut, and its entry under `HKCU\…\Uninstall`. It refuses a non-empty folder it did not
  create and an archive whose paths would leave the program folder; its page reaches only four actions
  (information, install, open, close). Uninstalling removes only what the installer created (shortcuts that point
  into the program folder, its own registry entry, TaskRadar's own autostart entry and notification registration)
  and keeps your data and secrets.
* The programs are not code-signed: use an installer you built yourself or got from a source you trust.

### Permissions (least privilege)

* Google Calendar has staged grants: `calendar.app.created` for the original TaskRadar calendar;
  `calendar.calendarlist.readonly` + `calendar.events.readonly` for existing-calendar reads; optional
  `calendar.events` for editing. The app explains each upgrade before opening Google's consent. Actual granted
  scopes are stored with credentials, cancelled upgrades preserve them, and reconnects check the workspace's account.
* App-selected calendars are an additional boundary, not a narrower Google OAuth grant. Ordinary event writes check
  the actual grant, the app editing switch, the selected destination, fresh CalendarList accessRole and explicit
  object/destination confirmation. Google checks the ACL again on the request. Recurring, invited and special events
  use Google's webpage for edits. No invitations are sent (`sendUpdates=none`). Original task mirrors retain their
  task-ID ownership check. Updates/deletions use ETag conditions rather than overwriting concurrent edits.
* Remote event snapshots, work blocks and unsent drafts are local data in SQLite. Drafts never submit automatically.
  Offline failures, expired sync tokens and per-calendar failures cannot rebuild local tasks or discard pending edits.
  Unfinished form input also stays in the current browser/WebView's local storage until submitted or discarded.
* OAuth uses the installed-application flow with PKCE, a `state` value that expires after 15 minutes and a loopback
  redirect URI. Only Desktop-type client configurations are accepted; missing scopes are rejected. Disconnecting
  revokes the token at Google.
* Windows autostart is created only after an explicit confirmation in the settings (a small script in your Startup
  folder; the registry is not touched) and removed the same way; TaskRadar refuses to delete a startup entry it did
  not create.
* The Start menu entry (needed for notifications on the screen when TaskRadar does not come from the installer) is
  created only after an explicit confirmation in the settings: one shortcut, `TaskRadar.lnk`, in your own Start menu.
  TaskRadar removes it only if it starts this TaskRadar, and never replaces an entry that starts another one.
* TaskRadar writes its notification identity (name and icon) under `HKCU\Software\Classes\AppUserModelId\
  TaskRadar.Desktop`; uninstalling removes it again.

### Single permission gate and audit log

Every side effect outside TaskRadar's own data calls `PermissionGuard.check()` before it happens: calendar writes and
deletions, autostart and Start menu changes, desktop and timer notifications, Google sign-in and sign-out, deleting a
stored credential, export and delete-all. The guard enforces the rules above (e.g. a calendar write requires a
connected calendar, an explicit confirmation or an opt-in rule, and a task with a date; delete-all requires the typed
phrase `DELETE`; notifications only when switched on) and records every decision — allowed or denied — in
`audit_log` without secret values.

### Content

* The optional Agent sends messages, bounded conversation context and relevant workspace data queried on demand to
  the user-configured API endpoint. With a key configured, opening Agent UI automatically queries that service's
  model list (no chat/workspace content). Chat starts on Send; optional model titles and suggestions make additional
  calls with bounded conversation context after successful replies, or on the corresponding user action.
  Requests are audited through `PermissionGuard`; a workspace-access switch removes data/mutation tools for chat-only
  use (existing messages in that conversation remain context). API endpoints require HTTPS except on loopback;
  redirects are not followed. Provider error bodies and request exceptions are never logged or shown to the frontend.
* Agent tools are an allow-list with validated arguments and bounded reads/loops. They propose changes only; the
  default Restricted mode requires Apply, while optional YOLO mode automatically applies the current successful
  turn's proposals. Both paths use server-stored proposals, never executable client-supplied payloads. Local edits
  check snapshots, local mutations and receipts commit together, and Google edits reuse the existing permission and
  ETag checks. No model tool can access credentials, run code, issue shell commands or change provider settings.
  YOLO does not expand the tool allow-list or bypass calendar permissions, snapshots or ETags, and does not execute
  older pending proposals. Model-generated titles/suggestions have no tools. Markdown disallows raw HTML and unsafe
  link protocols; images become links rather than automatically requesting model-provided tracking URLs.
  Claude prompt caching uses provider-side ephemeral cache controls (5 minutes by default, optional 1 hour or off).
  Cached prompts are still sent to the configured service and subject to that service's data handling. Stable replay
  contexts and receipt snapshots remain local chat content, are hidden from public chat responses, and are omitted
  from content-free exports. The app stores only reported numeric usage counters, never provider response bodies in
  its usage ledger, and makes no extra model requests merely to warm or test a production cache.

* Task titles, notes and timer names are data. Nothing in TaskRadar executes commands derived from them; there is no
  shell or code execution path from content at all.
* Data from earlier versions (imported mails and files) is only shown as the quotes a task was found by; it can be
  deleted as a whole in Settings → 数据与隐私.

### Secrets

* The OAuth client configuration and the Calendar token are stored in the Windows Credential Manager via `keyring`
  (long values are chunked). The Gmail token and API key that earlier versions may have stored are shown in
  Settings → 数据与隐私 and can be deleted there.
* A logging filter masks API keys, Google tokens, client secrets, bearer headers and `code`/`state`/token query
  parameters before anything is written.
* `.gitignore` excludes `.env`, client secret and token files, databases and logs. The repository contains only
  synthetic test data.

### Your data

* **Export**: Settings → 数据与隐私 → download (JSON with tasks, history, timers and calendar links; never secrets).
* **Delete**: single tasks from the UI (after a question); the data of earlier versions as a whole; **delete all
  local data** wipes the database content and stored file copies. Google Calendar events already written stay in the
  "TaskRadar" calendar; remove that calendar in Google Calendar if you want them gone. Remove the secrets in the
  settings (disconnect Google) or in the Windows Credential Manager.
* The database is not encrypted by TaskRadar. Use a Windows account password and BitLocker on laptops.
