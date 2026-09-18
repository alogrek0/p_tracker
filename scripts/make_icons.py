"""Generate the PWA icons for Pill ledger.

Usage:
    python scripts/make_icons.py

Requires Pillow (pip install pillow). No other dependency.

icons/icon.svg is the design reference. This script redraws the same
geometry with Pillow instead of rasterizing the SVG, so it does not need
cairosvg or a browser. If you change the SVG, update the drawing code
below to match.

Outputs (all written next to icon.svg):
    icon-192.png, icon-512.png                   purpose "any"
    icon-maskable-192.png, icon-maskable-512.png purpose "maskable"
"""

from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (0x0F, 0x6E, 0x5B, 255)
MINT = (0xBF, 0xE6, 0xDA, 255)
WHITE = (255, 255, 255, 255)
HIGHLIGHT = (255, 255, 255, int(255 * 0.7))

BASE = 512          # design size, matches the SVG viewBox
SCALE = 4           # supersampling factor for smooth edges
ANGLE = 40          # capsule tilt in degrees (SVG uses rotate(-40))

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"


def draw_capsule(size: int, capsule_scale: float = 1.0) -> Image.Image:
    """Draw the tilted capsule on a transparent canvas of the given size."""
    s = size / BASE * capsule_scale
    big = size * SCALE
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # Geometry from icon.svg, centered on the canvas.
    cx = big / 2
    cy = big / 2
    w = 320 * s * SCALE
    h = 144 * s * SCALE
    r = h / 2
    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2

    # Mint full capsule.
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=MINT)

    # White right half (a rounded rectangle clipped to the right side).
    half = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(half).rounded_rectangle([x0, y0, x1, y1], radius=r, fill=WHITE)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rectangle([cx, 0, big, big], fill=255)
    layer.paste(half, (0, 0), mask)

    # Soft highlight bar on the left half.
    hx0 = x0 + 48 * s * SCALE
    hy0 = y0 + 32 * s * SCALE
    hx1 = hx0 + 80 * s * SCALE
    hy1 = hy0 + 24 * s * SCALE
    hl = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle([hx0, hy0, hx1, hy1], radius=(hy1 - hy0) / 2, fill=HIGHLIGHT)
    layer.alpha_composite(hl)

    layer = layer.rotate(ANGLE, resample=Image.BICUBIC, center=(cx, cy))
    return layer.resize((size, size), Image.LANCZOS)


def draw_icon(size: int, maskable: bool) -> Image.Image:
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # Full bleed background; art stays inside the 80 percent safe zone.
        d.rectangle([0, 0, big, big], fill=ACCENT)
        capsule_scale = 0.72
    else:
        radius = 112 / BASE * big
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=ACCENT)
        capsule_scale = 1.0
    img = img.resize((size, size), Image.LANCZOS)
    img.alpha_composite(draw_capsule(size, capsule_scale))
    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        draw_icon(size, maskable=False).save(OUT_DIR / f"icon-{size}.png", optimize=True)
        draw_icon(size, maskable=True).save(OUT_DIR / f"icon-maskable-{size}.png", optimize=True)
        print(f"wrote icon-{size}.png and icon-maskable-{size}.png")


if __name__ == "__main__":
    main()
