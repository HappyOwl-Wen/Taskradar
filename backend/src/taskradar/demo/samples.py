"""Generate the synthetic demo / test documents (PDFs and screenshots).

All content is fictitious. The generated files are committed under ``taskradar/demo/samples`` so
tests do not depend on fonts being installed; this module documents how they were produced and
lets users regenerate them (``python -m taskradar demo-files <folder>``).
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SAMPLES_DIR = Path(__file__).resolve().parent / "samples"

CJK_FONT_CANDIDATES = [
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
LATIN_FONT_CANDIDATES = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]
LATIN_BOLD_CANDIDATES = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _font_path(candidates: list[str]) -> str | None:
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def _pil_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = _font_path(candidates)
    if path is None:
        return ImageFont.load_default()
    return ImageFont.truetype(path, size)


@dataclass
class Line:
    text: str
    size: int = 26
    bold: bool = False
    color: str = "#1f2933"
    gap: int = 14


# ---------------------------------------------------------------------------------------------
# PDFs with a real text layer
# ---------------------------------------------------------------------------------------------


def text_pdf(path: Path, lines: list[Line], *, cjk: bool) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)  # A4 portrait in points
    fontname = "helv"
    if cjk:
        font_file = _font_path(CJK_FONT_CANDIDATES)
        if font_file:
            page.insert_font(fontname="cjk", fontfile=font_file)
            fontname = "cjk"
        else:
            fontname = "china-s"
    else:
        latin = _font_path(LATIN_FONT_CANDIDATES)
        if latin:
            page.insert_font(fontname="latin", fontfile=latin)
            fontname = "latin"
    y = 80.0
    for line in lines:
        size = line.size * 0.45
        if line.text:
            page.insert_text((60, y), line.text, fontname=fontname, fontsize=size,
                             color=pymupdf.utils.getColor("black"))
        y += size + line.gap * 0.6
    doc.subset_fonts()
    doc.set_metadata({"title": path.stem, "author": "TaskRadar synthetic demo", "producer": "TaskRadar"})
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path, garbage=4, deflate=True)
    doc.close()
    return path


# ---------------------------------------------------------------------------------------------
# Raster images (screenshots / scans)
# ---------------------------------------------------------------------------------------------


def render_lines(lines: list[Line], *, width: int, cjk: bool, padding: int = 48, header: str | None = None,
                 header_color: str = "#2563eb", background: str = "white") -> Image.Image:
    regular = CJK_FONT_CANDIDATES if cjk else LATIN_FONT_CANDIDATES
    bold = CJK_FONT_CANDIDATES if cjk else LATIN_BOLD_CANDIDATES
    measure = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    height = padding * 2 + (70 if header else 0)
    for line in lines:
        height += line.size + line.gap
    img = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(img)
    y = padding
    if header:
        draw.rectangle((0, 0, width, 64), fill=header_color)
        draw.text((padding, 16), header, font=_pil_font(bold, 28), fill="white")
        y = 64 + padding // 2
    for line in lines:
        font = _pil_font(bold if line.bold else regular, line.size)
        if line.text:
            # Wrap long lines to the image width.
            words = list(line.text) if cjk else line.text.split(" ")
            current = ""
            for word in words:
                trial = (current + word) if cjk else (current + " " + word).strip()
                if measure.textlength(trial, font=font) > width - 2 * padding and current:
                    draw.text((padding, y), current, font=font, fill=line.color)
                    y += line.size + 8
                    current = word
                else:
                    current = trial
            draw.text((padding, y), current, font=font, fill=line.color)
        y += line.size + line.gap
    return img.crop((0, 0, width, min(height, y + padding)))


def screenshot_png(path: Path, lines: list[Line], *, cjk: bool, header: str) -> Path:
    img = render_lines(lines, width=1000, cjk=cjk, header=header)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    return path


def scanned_pdf(path: Path, lines: list[Line], *, cjk: bool, seed: int = 7) -> Path:
    """Render text to a grey, slightly rotated 'scan' and embed it as an image-only PDF page."""
    img = render_lines(lines, width=1240, cjk=cjk, padding=110, background="#fbfaf7")
    canvas = Image.new("RGB", (1240, 1754), "#fbfaf7")
    canvas.paste(img, (0, 40))
    rng = random.Random(seed)
    canvas = canvas.rotate(0.6, resample=Image.Resampling.BICUBIC, expand=False, fillcolor="#fbfaf7")
    grey = canvas.convert("L")
    pixels = grey.load()
    assert pixels is not None
    for _ in range(4000):  # light speckle noise
        x, y = rng.randrange(grey.width), rng.randrange(grey.height)
        pixels[x, y] = rng.randrange(150, 230)
    grey = grey.filter(ImageFilter.GaussianBlur(0.4))
    tmp = path.with_suffix(".tmp.png")
    grey.save(tmp)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, filename=str(tmp))
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path, garbage=4, deflate=True)
    doc.close()
    tmp.unlink()
    return path


# ---------------------------------------------------------------------------------------------
# The sample set
# ---------------------------------------------------------------------------------------------


def write_samples(target: Path | None = None) -> list[Path]:
    target = target or SAMPLES_DIR
    files: list[Path] = []

    files.append(text_pdf(target / "01_zh_enrollment_certificate_notice.pdf", [
        Line("示例大学 · 教务处", 34, bold=True),
        Line("关于提交在读证明的通知", 30, bold=True, gap=20),
        Line("发布日期：2026年10月12日"),
        Line(""),
        Line("各位同学："),
        Line("为完成下学期的学籍注册，请于2026年11月20日前通过TUMonline上传"),
        Line("在读证明（Immatrikulationsbescheinigung）。逾期将影响下学期的注册。"),
        Line(""),
        Line("如有疑问，请联系教务处。"),
        Line("（本文件为 TaskRadar 合成演示数据）", 20),
    ], cjk=True))

    files.append(screenshot_png(target / "02_de_residence_permit_documents.png", [
        Line("Von: Kreisverwaltungsreferat - Ausländerbehörde", 24, color="#52606d"),
        Line("Datum: 09.10.2026", 24, color="#52606d"),
        Line("Betreff: Ihr Antrag auf Verlängerung des Aufenthaltstitels", 26, bold=True, gap=24),
        Line("Sehr geehrte Frau Wang,", 26),
        Line("für die Bearbeitung Ihres Antrags fehlen noch Unterlagen.", 26),
        Line("Bitte reichen Sie die fehlenden Unterlagen für Ihren Aufenthaltstitel", 26),
        Line("bis spätestens 27.11.2026 ein.", 26, gap=24),
        Line("Mit freundlichen Grüßen", 26),
        Line("Ihre Ausländerbehörde (synthetische Demo)", 22, color="#52606d"),
    ], cjk=False, header="Posteingang"))

    files.append(screenshot_png(target / "03_de_residence_permit_reminder.png", [
        Line("Von: Kreisverwaltungsreferat - Ausländerbehörde", 24, color="#52606d"),
        Line("Datum: 30.10.2026", 24, color="#52606d"),
        Line("Betreff: Erinnerung: fehlende Unterlagen", 26, bold=True, gap=24),
        Line("Sehr geehrte Frau Wang,", 26),
        Line("wir möchten Sie daran erinnern, die Unterlagen für Ihren", 26),
        Line("Aufenthaltstitel bis zum 27.11.2026 einzureichen.", 26, gap=24),
        Line("Mit freundlichen Grüßen", 26),
    ], cjk=False, header="Posteingang"))

    files.append(screenshot_png(target / "04_zh_enrollment_certificate_reminder.png", [
        Line("发件人：示例大学教务处", 26, color="#52606d"),
        Line("日期：2026年11月10日", 26, color="#52606d"),
        Line("主题：提醒：提交在读证明", 28, bold=True, gap=24),
        Line("同学你好：", 28),
        Line("提醒您：请在11月20日前提交在读证明。", 28),
        Line("如果您已经提交，请忽略此提醒。", 28),
    ], cjk=True, header="Mail"))

    files.append(scanned_pdf(target / "05_zh_course_registration_scan.pdf", [
        Line("示例大学 教务处通知", 40, bold=True, gap=30),
        Line("日期：2026年10月20日", 32, gap=24),
        Line("请于2026年11月5日前在TUMonline完成选课。", 34),
        Line("未按时选课的同学将无法参加本学期考试。", 34),
    ], cjk=True))

    files.append(text_pdf(target / "06_en_rental_contract.pdf", [
        Line("Example Living GmbH - Tenant Services", 32, bold=True, gap=20),
        Line("Date: October 8, 2026"),
        Line(""),
        Line("Dear Ms. Wang,"),
        Line("welcome to your new apartment. To complete the move-in process:"),
        Line("1. Please sign and return the rental contract by November 2, 2026."),
        Line("2. Please pay the security deposit of 1,200 EUR by November 15, 2026."),
        Line(""),
        Line("Best regards, Example Living (synthetic demo data)", 22),
    ], cjk=False))

    files.append(screenshot_png(target / "07_de_marketing.png", [
        Line("SUPER SALE: 50% Rabatt auf alles!", 34, bold=True, color="#b91c1c", gap=20),
        Line("Nur diese Woche - jetzt kaufen und sparen.", 26),
        Line("Gutschein-Code: SALE50", 26),
        Line("Newsletter abbestellen", 20, color="#52606d"),
    ], cjk=False, header="Angebote"))
    return files


if __name__ == "__main__":  # pragma: no cover
    for written in write_samples():
        print(written)
