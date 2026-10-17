"""The Windows desktop app: TaskRadar in its own window (WebView2), with the local server managed for the user.

Opening the window starts the server in the same process; closing it stops both. The window shows the same web UI
as the browser version. Nothing here is imported by the server unless the desktop app runs, and only
:mod:`taskradar.desktop.shell` needs pywebview.
"""
