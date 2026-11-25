"""Gera os icones do Vertice Workspace a partir da marca SVG do app.

Saida:
  assets/vertice.ico            multi-resolucao (16..256), payload PNG (Vista+)
  assets/vertice-icon-256.png   master RGBA

Uso:  python scripts/build-vertice-icon.py
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

ACCENT = (109, 216, 197, 255)  # #6DD8C5 - destaque claro (tema escuro)
BADGE = (14, 76, 70, 255)      # #0E4C46 - fundo do badge (tema claro)

SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 8

# Traco mais grosso em tamanhos pequenos: o mark de 2.2 fica ilegivel em 16px.
STROKE_BY_SIZE = {16: 3.4, 24: 3.0, 32: 2.8, 48: 2.5, 64: 2.2}


def render(size: int) -> Image.Image:
    """Desenha badge + marca do Vertice e reduz com LANCZOS."""
    stroke = STROKE_BY_SIZE.get(size, 2.2)
    canvas = size * SUPERSAMPLE
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [0, 0, canvas - 1, canvas - 1], radius=int(canvas * 0.22), fill=BADGE
    )

    scale = canvas * 0.62 / 32.0
    offset = (canvas - 32 * scale) / 2.0

    def point(x: float, y: float) -> tuple[float, float]:
        return (offset + x * scale, offset + y * scale)

    width = stroke * scale
    px = max(1, int(round(width)))

    chevron = [point(6, 9), point(16, 25), point(26, 9)]
    draw.line(chevron, fill=ACCENT, width=px, joint="curve")

    bar = [point(11, 16), point(21, 16)]
    draw.line(bar, fill=ACCENT, width=px)

    radius = width / 2.0
    for x, y in (chevron[0], chevron[-1], bar[0], bar[-1]):
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=ACCENT)

    return img.resize((size, size), Image.Resampling.LANCZOS)


def build_ico(images: list[Image.Image]) -> bytes:
    """Monta um .ico com payloads PNG (compativel com Windows Vista+)."""
    header = struct.pack("<HHH", 0, 1, len(images))
    entries = b""
    payloads = b""
    offset = len(header) + 16 * len(images)

    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
        width, height = img.size
        entries += struct.pack(
            "<BBBBHHII",
            0 if width >= 256 else width,
            0 if height >= 256 else height,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        offset += len(data)
        payloads += data

    return header + entries + payloads


def main() -> None:
    images = [render(size) for size in SIZES]
    ico_path = ASSETS / "vertice.ico"
    ico_path.write_bytes(build_ico(images))
    images[-1].save(ASSETS / "vertice-icon-256.png")
    print("OK  {} ({} bytes, {} resolucoes)".format(ico_path, ico_path.stat().st_size, len(images)))
    print("OK  {}".format(ASSETS / "vertice-icon-256.png"))


if __name__ == "__main__":
    main()
