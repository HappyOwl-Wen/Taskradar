"""OCR engine abstraction with a local Tesseract implementation.

The engine is discovered automatically (configured path, PATH, standard install locations and
the per-user tools directory used by ``scripts/install-tesseract.ps1``). OCR runs fully locally.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageOps

log = logging.getLogger(__name__)

SUPPORTED_OCR_LANGS = ("chi_sim", "deu", "eng")


class OCRError(RuntimeError):
    code = "ocr_failed"


class OCRUnavailableError(OCRError):
    code = "ocr_unavailable"


@dataclass
class OCRResult:
    text: str
    confidence: float | None
    engine: str
    languages: list[str] = field(default_factory=list)


class OCREngine(Protocol):
    name: str

    def available(self) -> bool: ...

    def languages(self) -> list[str]: ...

    def recognize(self, image: Image.Image) -> OCRResult: ...


# CJK ideographs, CJK punctuation and full-width forms (built with chr() to keep the source ASCII-clean).
_CJK_CLASS = f"[{chr(0x4E00)}-{chr(0x9FFF)}{chr(0x3000)}-{chr(0x303F)}{chr(0xFF00)}-{chr(0xFFEF)}]"
_CJK_SPACE = re.compile(rf"(?<={_CJK_CLASS})[ \t]+(?={_CJK_CLASS})")


def tidy_ocr_text(text: str) -> str:
    """Tesseract inserts spaces between CJK glyphs; remove them and normalise line breaks."""
    text = _CJK_SPACE.sub("", text)
    lines = [ln.rstrip() for ln in text.replace("\r", "").split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln.strip() or (out and out[-1] != ""):
            out.append(ln.strip())
    return "\n".join(out).strip()


def candidate_tesseract_paths(tools_dir: Path | None = None) -> list[Path]:
    paths: list[Path] = []
    env = os.environ.get("TASKRADAR_TESSERACT_CMD")
    if env:
        paths.append(Path(env))
    which = shutil.which("tesseract")
    if which:
        paths.append(Path(which))
    if tools_dir is not None:
        paths.append(tools_dir / "tesseract" / "tesseract.exe")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        paths.append(Path(local) / "TaskRadar" / "tools" / "tesseract" / "tesseract.exe")
        paths.append(Path(local) / "Programs" / "Tesseract-OCR" / "tesseract.exe")
    for env_name in ("ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(env_name)
        if base:
            paths.append(Path(base) / "Tesseract-OCR" / "tesseract.exe")
    paths.extend([Path("/usr/bin/tesseract"), Path("/usr/local/bin/tesseract"), Path("/opt/homebrew/bin/tesseract")])
    return paths


class TesseractEngine:
    """Tesseract via pytesseract. Runs the CLI as a subprocess with a timeout."""

    name = "tesseract"

    def __init__(self, cmd: str | Path | None = None, tools_dir: Path | None = None, timeout: float = 60.0):
        self.timeout = timeout
        self._cmd: Path | None = None
        candidates = [Path(cmd)] if cmd else candidate_tesseract_paths(tools_dir)
        for path in candidates:
            if path.is_file():
                self._cmd = path
                break
        self._langs: list[str] | None = None

    @property
    def command(self) -> str | None:
        return str(self._cmd) if self._cmd else None

    def available(self) -> bool:
        return self._cmd is not None and bool(self.languages())

    def languages(self) -> list[str]:
        if self._cmd is None:
            return []
        if self._langs is None:
            try:
                proc = subprocess.run(  # noqa: S603 - fixed binary path, no shell, no user input
                    [str(self._cmd), "--list-langs"],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                langs = [ln.strip() for ln in (proc.stdout or "").splitlines()[1:] if ln.strip()]
                self._langs = [lang for lang in langs if lang in SUPPORTED_OCR_LANGS]
            except (OSError, subprocess.SubprocessError) as exc:
                log.warning("Tesseract language listing failed: %s", exc)
                self._langs = []
        return self._langs

    def version(self) -> str | None:
        if self._cmd is None:
            return None
        try:
            proc = subprocess.run(  # noqa: S603
                [str(self._cmd), "--version"],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            first = (proc.stdout or proc.stderr or "").splitlines()
            return first[0].strip() if first else None
        except (OSError, subprocess.SubprocessError):
            return None

    def _run(self, image: Image.Image, langs: list[str]) -> OCRResult:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = str(self._cmd)
        lang = "+".join(langs)
        try:
            data = pytesseract.image_to_data(
                image,
                lang=lang,
                config="--oem 1 --psm 3",
                output_type=pytesseract.Output.DICT,
                timeout=self.timeout,
            )
        except RuntimeError as exc:  # pytesseract raises RuntimeError on timeout
            raise OCRError(f"OCR timed out after {self.timeout:.0f}s") from exc
        except pytesseract.TesseractError as exc:
            raise OCRError(f"Tesseract failed: {exc}") from exc
        except OSError as exc:
            raise OCRUnavailableError(f"Tesseract could not be started: {exc}") from exc

        lines: dict[tuple[int, int, int], list[str]] = {}
        confidences: list[float] = []
        for i, word in enumerate(data.get("text", [])):
            if not word or not word.strip():
                continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            lines.setdefault(key, []).append(word)
            try:
                conf = float(data["conf"][i])
            except (TypeError, ValueError):
                conf = -1
            if conf >= 0:
                confidences.append(conf)
        text_lines: list[str] = []
        last_block: tuple[int, int] | None = None
        for key in sorted(lines):
            block = (key[0], key[1])
            if last_block is not None and block != last_block:
                text_lines.append("")
            text_lines.append(" ".join(lines[key]))
            last_block = block
        text = tidy_ocr_text("\n".join(text_lines))
        confidence = round(sum(confidences) / len(confidences) / 100.0, 3) if confidences else None
        return OCRResult(text=text, confidence=confidence, engine=self.name, languages=langs)

    def recognize(self, image: Image.Image) -> OCRResult:
        if self._cmd is None:
            raise OCRUnavailableError("Tesseract is not installed")
        langs = self.languages()
        if not langs:
            raise OCRUnavailableError("No supported Tesseract language data (chi_sim/deu/eng) found")
        prepared = preprocess_for_ocr(image)

        latin = [lang for lang in ("deu", "eng") if lang in langs]
        cjk = [lang for lang in ("chi_sim", "eng") if lang in langs]
        attempts: list[list[str]] = []
        if latin:
            attempts.append(latin)
        if "chi_sim" in langs:
            attempts.append(cjk)
        best: OCRResult | None = None
        for attempt in attempts:
            result = self._run(prepared, attempt)
            if best is None or _score(result) > _score(best):
                best = result
            # A confident Latin-script result does not need a CJK pass.
            if attempt is latin and result.confidence and result.confidence >= 0.80 and not _cjk_ratio(result.text):
                break
        assert best is not None
        return best


def _cjk_ratio(text: str) -> float:
    if not text:
        return 0.0
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    return cjk / max(1, len(text.replace(" ", "")))


def _score(result: OCRResult) -> float:
    conf = result.confidence or 0.0
    useful = sum(1 for ch in result.text if ch.isalnum())
    return conf * 100 + min(useful, 400) * 0.05


TARGET_LINE_HEIGHT = 42.0


def estimate_line_height(gray: Image.Image) -> float | None:
    """Median height of text lines via a horizontal projection profile (dark text on light)."""
    sample = gray
    scale = 1.0
    if gray.height > 2400:
        scale = 2400 / gray.height
        sample = gray.resize((max(1, int(gray.width * scale)), 2400), Image.Resampling.BOX)
    ink = sample.point(lambda p: 255 if p < 140 else 0)
    # Average each row to a single pixel: fraction of ink per row (no numpy needed).
    column = ink.resize((1, ink.height), Image.Resampling.BOX)
    flatten = getattr(column, "get_flattened_data", None) or column.getdata  # Pillow >= 12 / older
    rows = list(flatten())
    runs: list[int] = []
    current = 0
    for value in rows:
        if value > 2:  # > ~1% ink in this row
            current += 1
        elif current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    runs = [r for r in runs if r >= 4]
    if len(runs) < 2:
        return None
    runs.sort()
    return runs[len(runs) // 2] / scale


def preprocess_for_ocr(image: Image.Image) -> Image.Image:
    """Grayscale, fix orientation/contrast and rescale so text lines are ~42 px high.

    Tesseract accuracy drops sharply when glyphs are much smaller or much larger than that
    (e.g. Chinese 交 is misread as 爻 at ~3x magnification), so the factor is derived from the
    measured line height instead of the image size.
    """
    img = ImageOps.exif_transpose(image)
    if img.mode not in ("L", "RGB"):
        background = Image.new("RGB", img.size, "white")
        if img.mode in ("RGBA", "LA"):
            background.paste(img, mask=img.split()[-1])
        else:
            background.paste(img.convert("RGB"))
        img = background
    img = img.convert("L")
    # Dark-mode screenshots: invert if the image is predominantly dark.
    histogram = img.histogram()
    if sum(histogram[:96]) > sum(histogram) * 0.6:
        img = ImageOps.invert(img)
    img = ImageOps.autocontrast(img)
    line_height = estimate_line_height(img)
    factor = TARGET_LINE_HEIGHT / line_height if line_height else (2.0 if img.height < 1500 else 1.0)
    factor = max(0.5, min(3.0, factor))
    if abs(factor - 1.0) >= 0.15:
        img = img.resize((max(1, int(img.width * factor)), max(1, int(img.height * factor))), Image.Resampling.LANCZOS)
    return img


class NullOCREngine:
    """Used when no engine is installed: always reports unavailable."""

    name = "none"

    def available(self) -> bool:
        return False

    def languages(self) -> list[str]:
        return []

    def recognize(self, image: Image.Image) -> OCRResult:
        raise OCRUnavailableError("No OCR engine is installed")
