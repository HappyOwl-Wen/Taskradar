"""A looping Windows alarm, independent of toast permissions and WebView/browser audio throttling."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

log = logging.getLogger(__name__)


class AlarmSound:
    def __init__(self) -> None:
        self.playing = False

    def start(self) -> None:
        if self.playing or sys.platform != "win32":
            return
        import winsound

        sound = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "Media" / "Alarm01.wav"
        try:
            if sound.is_file():
                winsound.PlaySound(str(sound), winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP)
            else:
                winsound.PlaySound("SystemExclamation", winsound.SND_ALIAS | winsound.SND_ASYNC | winsound.SND_LOOP)
            self.playing = True
        except (OSError, RuntimeError):
            log.exception("Could not play the Pomodoro alarm")

    def stop(self) -> None:
        if not self.playing or sys.platform != "win32":
            return
        import winsound

        try:
            winsound.PlaySound(None, 0)
        except (OSError, RuntimeError):
            log.exception("Could not stop the Pomodoro alarm")
        finally:
            self.playing = False
