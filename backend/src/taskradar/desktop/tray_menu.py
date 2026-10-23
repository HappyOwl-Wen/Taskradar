"""A compact, themed WinForms tray menu; all drawing stays on the window's UI thread."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

TEXTS = {
    "zh-CN": {
        "open": "打开 TaskRadar",
        "restart": "重启服务",
        "quit": "退出 TaskRadar",
        "starting": "正在启动服务…",
        "running": "服务运行中",
        "restarting": "正在重启服务…",
        "failed": "服务暂不可用，可重试",
    },
    "en": {
        "open": "Open TaskRadar",
        "restart": "Restart service",
        "quit": "Quit TaskRadar",
        "starting": "Starting service…",
        "running": "Service running",
        "restarting": "Restarting service…",
        "failed": "Service unavailable · retry",
    },
}
PALETTES = {
    "light": {
        "background": "#faf9fe",
        "text": "#292637",
        "muted": "#6b6478",
        "border": "#ded9e8",
        "hover": "#e9e0f8",
        "accent": "#7050ad",
        "danger": "#b42318",
        "danger_hover": "#fff0ef",
    },
    "dark": {
        "background": "#302b3e",
        "text": "#f1edf8",
        "muted": "#b9afc9",
        "border": "#484053",
        "hover": "#48375e",
        "accent": "#c4a4f0",
        "danger": "#ff9a9c",
        "danger_hover": "#442b30",
    },
}


def _rounded(rect: Any, radius: int) -> Any:
    from System.Drawing.Drawing2D import GraphicsPath

    path = GraphicsPath()
    diameter = radius * 2
    for x, y, angle in (
        (rect.Left, rect.Top, 180),
        (rect.Right - diameter, rect.Top, 270),
        (rect.Right - diameter, rect.Bottom - diameter, 0),
        (rect.Left, rect.Bottom - diameter, 90),
    ):
        path.AddArc(int(x), int(y), diameter, diameter, angle, 90)
    path.CloseFigure()
    return path


class TrayMenu:
    def __init__(
        self,
        form: Any,
        icon: Path,
        *,
        language: str,
        theme: str,
        on_open: Callable[[], None],
        on_restart: Callable[[], None],
        on_quit: Callable[[], None],
    ) -> None:
        from System.Drawing import Bitmap, ContentAlignment, Font, FontStyle, Icon, Size
        from System.Windows.Forms import (
            ContextMenuStrip,
            Padding,
            ToolStripMenuItem,
            ToolStripProfessionalRenderer,
            ToolStripSeparator,
        )

        self._scale = max(1.0, int(form.DeviceDpi) / 96)
        self._resources: list[Any] = []
        self._images: list[Any] = []
        self._theme = ""
        self._language = language
        self._state = "running"
        self._status: str | None = None
        self.control = menu = ContextMenuStrip()
        menu.AutoSize = False
        menu.Size = Size(self.px(264), self.px(208))
        menu.Padding = Padding(self.px(6))
        menu.ImageScalingSize = Size(self.px(18), self.px(18))
        menu.ShowCheckMargin = False
        menu.DropShadowEnabled = True
        menu.Font = self._own(Font("Segoe UI", 10.0))
        renderer = ToolStripProfessionalRenderer()
        renderer.RoundedEdges = False
        renderer.RenderToolStripBackground += self._background
        renderer.RenderImageMargin += self._background
        renderer.RenderSeparator += self._separator
        renderer.RenderToolStripBorder += self._border
        menu.Renderer = renderer
        menu.SizeChanged += self._shape
        self.title = ToolStripMenuItem("TaskRadar")
        self.title.Enabled = False
        self.title.Tag = "title"
        self.title.Font = self._own(Font("Segoe UI", 11.0, FontStyle.Bold))
        if icon.with_suffix(".png").is_file():
            self.title.Image = self._own(Bitmap(str(icon.with_suffix(".png"))))
        else:
            with_icon = self._own(Icon(str(icon)))
            self.title.Image = self._own(with_icon.ToBitmap())
        self.title.ImageAlign = ContentAlignment.MiddleLeft
        self.status = ToolStripMenuItem()
        self.status.Enabled = False
        self.status.Tag = "status"
        self.status.Font = self._own(Font("Segoe UI", 9.0))
        self.items: dict[str, Any] = {}
        for label, height in ((self.title, 28), (self.status, 24)):
            label.AutoSize = False
            label.TextAlign = ContentAlignment.MiddleLeft
            label.Size = Size(self.px(250), self.px(height))
            label.Paint += self._paint_row
            menu.Items.Add(label)
        menu.Items.Add(ToolStripSeparator())
        for key, callback in (("open", on_open), ("restart", on_restart), ("quit", on_quit)):
            if key == "quit":
                menu.Items.Add(ToolStripSeparator())
            item = ToolStripMenuItem()
            item.Tag = key
            item.AutoSize = False
            item.Size = Size(self.px(250), self.px(40))
            item.Click += self._click(callback)
            item.Paint += self._paint_row
            self.items[key] = item
            menu.Items.Add(item)
        self.update(language, theme)
        self._shape(None, None)

    def px(self, value: int) -> int:
        return round(value * self._scale)

    def _own(self, resource: Any) -> Any:
        self._resources.append(resource)
        return resource

    @staticmethod
    def _click(callback: Callable[[], None]) -> Callable[..., None]:
        return lambda _sender, _args: callback()

    def color(self, name: str) -> Any:
        from System.Drawing import ColorTranslator

        return ColorTranslator.FromHtml(PALETTES[self._theme][name])

    def update(self, language: str, theme: str) -> None:
        self._language = "en" if language == "en" else "zh-CN"
        theme = "dark" if theme == "dark" else "light"
        if theme != self._theme:
            self._theme = theme
            old_images, self._images = self._images, []
            for key, item in self.items.items():
                item.Image = self._glyph(key)
                self._images.append(item.Image)
            for image in old_images:
                image.Dispose()
        self.control.BackColor = self.color("background")
        self.control.ForeColor = self.color("text")
        for key, item in self.items.items():
            item.Text = TEXTS[self._language][key]
            item.ForeColor = self.color("danger" if key == "quit" else "text")
        self.status.ForeColor = self.color("muted")
        self.set_state(self._state)

    def set_state(self, state: str) -> None:
        self._state = state
        texts = TEXTS[self._language]
        self.status.Text = self._status if state == "running" and self._status else texts[state]
        self.items["restart"].Enabled = state not in {"starting", "restarting"}
        self.items["restart"].Text = texts["restarting" if state == "restarting" else "restart"]
        self.control.Invalidate(True)

    def set_status(self, status: str | None) -> None:
        self._status = status
        self.set_state(self._state)

    def _shape(self, _sender: Any, _args: Any) -> None:
        from System.Drawing import Region

        path = _rounded(self.control.ClientRectangle, self.px(10))
        previous = self.control.Region
        self.control.Region = Region(path)
        path.Dispose()
        if previous is not None:
            previous.Dispose()

    def _fill(self, graphics: Any, rect: Any, color: str, *, radius: int = 0) -> None:
        from System.Drawing import SolidBrush

        brush = SolidBrush(self.color(color))
        try:
            if radius:
                path = _rounded(rect, self.px(radius))
                try:
                    graphics.FillPath(brush, path)
                finally:
                    path.Dispose()
            else:
                graphics.FillRectangle(brush, rect)
        finally:
            brush.Dispose()

    def _background(self, _sender: Any, args: Any) -> None:
        self._fill(args.Graphics, args.AffectedBounds, "background")

    def _paint_row(self, item: Any, args: Any) -> None:
        from System.Drawing import (
            Rectangle,
            RectangleF,
            SolidBrush,
            StringAlignment,
            StringFormat,
            StringFormatFlags,
            StringTrimming,
        )
        from System.Drawing.Drawing2D import CombineMode, SmoothingMode
        from System.Drawing.Text import TextRenderingHint

        # Paint the row as one unit: native menu text metrics vary with DPI and fixed-width items.
        graphics = args.Graphics
        saved = graphics.Save()
        brush = format_text = None
        try:
            rect = Rectangle(0, 0, item.Width, item.Height)
            graphics.SetClip(rect, CombineMode.Replace)
            graphics.SmoothingMode = SmoothingMode.AntiAlias
            self._fill(graphics, rect, "background")
            key = str(item.Tag)
            if item.Selected and item.Enabled:
                rect.Inflate(-self.px(2), -self.px(2))
                self._fill(graphics, rect, "danger_hover" if key == "quit" else "hover", radius=6)
            if item.Image is not None:
                size = self.px(18)
                graphics.DrawImage(item.Image, Rectangle(self.px(9), (item.Height - size) // 2, size, size))
            color = (
                "muted"
                if key == "status" or (not item.Enabled and key != "title")
                else "danger"
                if key == "quit"
                else "text"
            )
            brush = SolidBrush(self.color(color))
            format_text = StringFormat()
            format_text.Alignment = StringAlignment.Near
            format_text.LineAlignment = StringAlignment.Center
            format_text.FormatFlags = StringFormatFlags.NoWrap
            format_text.Trimming = StringTrimming.EllipsisCharacter
            graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit
            graphics.DrawString(
                str(item.Text),
                item.Font,
                brush,
                RectangleF(self.px(36), 0, item.Width - self.px(44), item.Height),
                format_text,
            )
        finally:
            if brush is not None:
                brush.Dispose()
            if format_text is not None:
                format_text.Dispose()
            graphics.Restore(saved)

    def _separator(self, _sender: Any, args: Any) -> None:
        from System.Drawing import Pen, Rectangle

        self._fill(args.Graphics, Rectangle(0, 0, args.Item.Width, args.Item.Height), "background")
        pen = Pen(self.color("border"))
        try:
            y = args.Item.Height // 2
            args.Graphics.DrawLine(pen, self.px(12), y, args.Item.Width - self.px(12), y)
        finally:
            pen.Dispose()

    def _border(self, _sender: Any, args: Any) -> None:
        from System.Drawing import Pen, Rectangle
        from System.Drawing.Drawing2D import SmoothingMode

        args.Graphics.SmoothingMode = SmoothingMode.AntiAlias
        path = _rounded(Rectangle(0, 0, self.control.Width - 1, self.control.Height - 1), self.px(10))
        pen = Pen(self.color("border"))
        try:
            args.Graphics.DrawPath(pen, path)
        finally:
            pen.Dispose()
            path.Dispose()

    def _glyph(self, key: str) -> Any:
        from System.Drawing import Bitmap, Graphics, Pen
        from System.Drawing.Drawing2D import LineCap, SmoothingMode

        bitmap = Bitmap(self.px(18), self.px(18))
        graphics = Graphics.FromImage(bitmap)
        graphics.ScaleTransform(self._scale, self._scale)
        graphics.SmoothingMode = SmoothingMode.AntiAlias
        pen = Pen(self.color("danger" if key == "quit" else "accent"), 1.6)
        pen.StartCap = pen.EndCap = LineCap.Round
        try:
            if key == "open":
                graphics.DrawRectangle(pen, 3, 5, 10, 10)
                graphics.DrawLine(pen, 8, 10, 15, 3)
                graphics.DrawLine(pen, 10, 3, 15, 3)
                graphics.DrawLine(pen, 15, 3, 15, 8)
            elif key == "restart":
                graphics.DrawArc(pen, 3, 3, 12, 12, -135, 285)
                graphics.DrawLine(pen, 3, 3, 3, 8)
                graphics.DrawLine(pen, 3, 8, 8, 8)
            else:
                graphics.DrawArc(pen, 3, 3, 12, 12, -55, 290)
                graphics.DrawLine(pen, 9, 1, 9, 9)
        finally:
            pen.Dispose()
            graphics.Dispose()
        return bitmap

    def dispose(self) -> None:
        self.control.Dispose()
        for resource in [*self._images, *reversed(self._resources)]:
            resource.Dispose()
        self._images.clear()
        self._resources.clear()
