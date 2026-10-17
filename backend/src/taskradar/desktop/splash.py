"""The pages the window shows before the web UI: the start screen and, if the server cannot start, why.

They are plain HTML (no scripts) in the colours of the app, so that opening the window never flashes white in
the dark theme and the user sees at once that TaskRadar is starting.
"""

from __future__ import annotations

from html import escape

# Same colours as the web UI's frame (frontend/src/index.css).
FRAME = {"light": "#f2f3f5", "dark": "#1d1e22"}
CONTENT = {"light": "#ffffff", "dark": "#25262b"}
TEXT = {"light": "#1d2129", "dark": "#ebecef"}
MUTED = {"light": "#5d6470", "dark": "#a6abb5"}
ACCENT = {"light": "#4f46e5", "dark": "#8b8ff5"}

MARK = """<svg width="44" height="44" viewBox="0 0 32 32" fill="none" aria-hidden="true">
<rect width="32" height="32" rx="8" fill="#4f46e5"/>
<circle cx="16" cy="16" r="9" stroke="#fff" stroke-opacity=".45" stroke-width="2"/>
<circle cx="16" cy="16" r="4.5" stroke="#fff" stroke-opacity=".75" stroke-width="2"/>
<path d="M16 16 L23.5 9.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
<circle cx="16" cy="16" r="1.8" fill="#fff"/><circle cx="21.5" cy="20" r="1.6" fill="#fbbf24"/></svg>"""

TEXTS = {
    "zh-CN": {
        "starting": "正在启动…",
        "failed": "TaskRadar 无法启动",
        "failed_hint": "关闭这个窗口后再打开 TaskRadar 试试。如果仍然不行，日志里有原因：",
        "detail": "错误代码",
    },
    "en": {
        "starting": "Starting…",
        "failed": "TaskRadar could not start",
        "failed_hint": "Close this window and open TaskRadar again. If that does not help, the log says why:",
        "detail": "Error code",
    },
}


def _page(theme: str, language: str, body: str) -> str:
    t = "dark" if theme == "dark" else "light"
    lang = "en" if language == "en" else "zh-CN"
    return f"""<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><title>TaskRadar</title>
<meta name="color-scheme" content="{"dark" if t == "dark" else "light"}">
<style>
html,body{{height:100%;margin:0}}
body{{background:{FRAME[t]};color:{TEXT[t]};display:grid;place-items:center;
font:14px/20px "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
-webkit-user-select:none;user-select:none;cursor:default}}
main{{display:grid;justify-items:center;gap:12px;text-align:center;max-width:30rem;padding:24px;
animation:enter 220ms cubic-bezier(.2,0,0,1) both}}
h1{{font-size:20px;line-height:28px;font-weight:600;margin:4px 0 0}}
p{{margin:0;color:{MUTED[t]}}}
code{{font:12px/18px "Cascadia Mono",Consolas,monospace;color:{TEXT[t]};background:{CONTENT[t]};
padding:2px 6px;border-radius:6px;-webkit-user-select:text;user-select:text;word-break:break-all}}
.bar{{width:160px;height:3px;border-radius:3px;background:{MUTED[t]}33;overflow:hidden;margin-top:8px}}
.bar::before{{content:"";display:block;width:40%;height:100%;border-radius:3px;background:{ACCENT[t]};
animation:slide 1.2s cubic-bezier(.4,0,.2,1) infinite}}
@keyframes slide{{from{{transform:translateX(-100%)}}to{{transform:translateX(250%)}}}}
@keyframes enter{{from{{opacity:0;transform:translateY(4px)}}}}
@media (prefers-reduced-motion: reduce){{main{{animation:none}}.bar::before{{animation:none;width:100%;opacity:.5}}}}
</style></head><body><main>{body}</main></body></html>"""


def start_page(theme: str, language: str) -> str:
    text = TEXTS["en" if language == "en" else "zh-CN"]
    return _page(
        theme,
        language,
        f'{MARK}<h1>TaskRadar</h1><p role="status">{text["starting"]}</p><div class="bar" aria-hidden="true"></div>',
    )


def error_page(theme: str, language: str, *, code: str, log_path: str) -> str:
    text = TEXTS["en" if language == "en" else "zh-CN"]
    return _page(
        theme,
        language,
        f"{MARK}<h1>{text['failed']}</h1><p>{text['failed_hint']}</p><code>{escape(log_path)}</code>"
        f"<p>{text['detail']}: <code>{escape(code)}</code></p>",
    )
