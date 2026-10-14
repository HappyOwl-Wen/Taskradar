# Security and privacy

TaskRadar processes personal mail and documents. This document describes what it protects against, how, and
what remains your responsibility.

## Reporting a vulnerability

Please do not open a public issue for security problems. Contact the maintainer privately (via the contact
details on the repository owner's profile) with a description and, if possible, steps to reproduce.

## Assets and threat model

| Asset | Where it lives |
| --- | --- |
| Mail bodies, document text, tasks, history | SQLite database `%LOCALAPPDATA%\TaskRadar\taskradar.db` |
| Copies of imported files and attachments | `%LOCALAPPDATA%\TaskRadar\files\` (content-addressed by SHA-256) |
| Google OAuth client config and tokens, LLM API key | Windows Credential Manager (service "TaskRadar"), never files or the database |
| Logs | `%LOCALAPPDATA%\TaskRadar\logs\taskradar.log` (rotated, secrets masked) |

Threats considered:

1. **Other websites in your browser** attacking the local server (CSRF, DNS rebinding, clickjacking).
2. **Other users/devices on the network** reaching the server.
3. **Untrusted content** in mails, PDFs and screenshots: prompt injection, malicious files, path tricks.
4. **Over-broad permissions** to Google services or the file system.
5. **Leaking secrets or content** through logs, Git, error messages or a cloud LLM.
6. **Unwanted side effects**: writing to calendars, sending anything, changing system settings.

Out of scope: an attacker who already controls your Windows account or the machine (they can read the
database and the Credential Manager), and the security of Google's and the LLM provider's services.

## Controls

### Network surface

* The server binds to `127.0.0.1` only. Binding to any other address is refused unless
  `TASKRADAR_ALLOW_NON_LOOPBACK=1` is set explicitly.
* **Host allow-list** (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`): requests with any other `Host`
  header get `421`, which defeats DNS-rebinding attacks.
* **CSRF**: every state-changing request under `/api` must carry `X-TaskRadar-CSRF` with a random per-process
  token (compared in constant time). The token is only readable by same-origin JavaScript; custom headers
  cannot be sent cross-origin without a CORS preflight, which is never granted. As defence in depth, a present
  `Origin` must be on the allow-list and `Sec-Fetch-Site` must be `same-origin` or `none`.
* **Response headers**: strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no external
  hosts), `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: no-store` for the
  API. The web UI loads no third-party resources.
* A file lock prevents two TaskRadar servers from using the same data folder.

### Permissions (least privilege)

* Gmail: `https://www.googleapis.com/auth/gmail.readonly` only. TaskRadar cannot send, delete, label or mark
  mail as read.
* Google Calendar: `https://www.googleapis.com/auth/calendar.app.created` only — access to calendars TaskRadar
  created, nothing else. Events are written into a dedicated "TaskRadar" calendar, never with attendees, with
  `sendUpdates=none`; before updating an event TaskRadar checks that it carries its own task ID.
* OAuth uses the installed-application flow with PKCE, a `state` value that expires after 15 minutes and a
  loopback redirect URI. Only Desktop-type client configurations are accepted. Missing scopes are rejected.
  Disconnecting revokes the token at Google.
* File system: only folders you add are scanned, never whole drives, your profile root, system folders or
  TaskRadar's own data folder. Files in watched folders are opened read-only in place; uploads and mail
  attachments are stored as copies. Original files are never modified, moved or deleted (deleting a record or
  everything only removes TaskRadar's own copies). "Show in Explorer" and file downloads are limited to
  TaskRadar's storage and watched folders.
* Windows autostart is created only after an explicit confirmation in the UI (a small script in your Startup
  folder; the registry is not touched) and removed the same way; TaskRadar refuses to delete a startup entry
  it did not create.

### Single permission gate and audit log

Every external side effect calls `PermissionGuard.check()` before it happens: LLM requests, Gmail reads,
calendar writes, autostart changes, desktop notifications, folder watching, revealing files, OAuth
connect/revoke, export and delete-all. The guard enforces the rules above (e.g. a calendar write requires a
connected calendar, an explicit user confirmation or an opt-in rule, a confirmed task and a date; delete-all
requires the typed phrase `DELETE`; a cloud LLM requires consent) and records every decision — allowed or
denied — in `audit_log` without secret values.

### Untrusted content

* Mail and document text is data, never instructions. Nothing in TaskRadar executes commands derived from
  content; there is no shell or code execution path from content at all.
* The LLM prompt wraps content in `<untrusted_content>` and instructs the model to ignore embedded instructions;
  regardless of the model's behaviour, its output is validated: tasks asking to run commands or reveal
  credentials are dropped, quotes must be found in the source, dates are re-parsed from the source.
* Prompt-injection phrases (English, German, Chinese) are detected; affected candidates are flagged for review.
* Uploads: at most 20 files per request and a configurable size limit (25 MB default); the type is determined
  by magic bytes (PDF, PNG, JPEG, WebP, e-mail), not by the extension; file names are sanitised; images larger
  than 60 megapixels are rejected (decompression bombs); encrypted or corrupted PDFs fail safely.
* Stored files are named by their SHA-256 hash, and served with `X-Content-Type-Options: nosniff`, and images
  additionally with a sandboxing CSP.

### Secrets

* OAuth client configuration, tokens and the API key are stored in the Windows Credential Manager via
  `keyring` (long values are chunked). `OPENAI_API_KEY` from the environment is supported for development.
* A logging filter masks API keys, Google tokens, client secrets, bearer headers and `code`/`state`/token query
  parameters before anything is written.
* `.gitignore` excludes `.env`, client secret and token files, databases and logs. The repository contains only
  synthetic test data.

### Cloud LLM (optional) and data minimisation

The default extractor is local. A cloud provider is used only after you select it, store a key and tick the
consent notice explaining that content will be sent to the provider. Before sending, TaskRadar:

* sends only items whose text contains obligation cues (marketing/newsletters are never sent);
* masks IBANs, card numbers (Luhn-checked), labelled ID numbers, phone numbers and e-mail user names;
* truncates long texts (12 000 characters by default) and sends one item per request;
* sends the deduplication judge only short, redacted task descriptions.

Token usage, cost estimates, latency and validation failures of every call are recorded in `extraction_runs`
and visible on the Insights page.

### Your data

* **Export**: Settings → Data & privacy → Download export (JSON, optionally with mail/document text; never secrets).
* **Delete**: single documents, mails or tasks from the UI; **Delete all local data** wipes the database
  content and stored file copies and stops watching all folders (Gmail, Google Calendar and your original files
  are not touched).
  Remove the secrets in Settings (API key, OAuth client, Disconnect) or in the Windows Credential Manager.
* The database is not encrypted by TaskRadar. Use a Windows account password and BitLocker on laptops.
