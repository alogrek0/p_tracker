#!/usr/bin/env python3
"""Generate the p_tracker PWA icon set.

Run:  py -3 scripts/make_icons.py       (from the repository root)

The -3 matters on Windows. The py launcher otherwise follows the shebang below,
looks up "python3" on PATH, and finds the Microsoft Store stub, which refuses to
run anything.

Outputs, all under icons/ :

    icon.svg                  vector master, the "any" artwork
    icon-192.png              "any"      192x192
    icon-512.png              "any"      512x512
    icon-maskable-192.png     "maskable" 192x192
    icon-maskable-512.png     "maskable" 512x512

Artwork: a capsule tilted 45 degrees on a calm teal field. The capsule is split
into a white half and a pale teal half with a seam in the field colour. No text,
no hairlines, nothing that dies at 40px on an iOS home screen.

The "any" tile is a rounded square. The "maskable" tile is full bleed and its
capsule is shrunk so every painted pixel sits inside the inner 80 percent circle
that Android and iOS may crop to.

Rasterising
-----------
There is no guaranteed SVG rasteriser on a stock Windows box, so this script has
two back ends and picks whichever is available:

1. cairosvg, if it is importable. icon.svg (and an in memory maskable twin) are
   rasterised through it.
2. Otherwise a small built in renderer draws the same geometry directly and
   writes the PNG with zlib, which is in the standard library. Shapes are drawn
   from signed distance fields, so edges are antialiased.

Both back ends read the same constants below, and this script writes icon.svg
itself, so the vector and the bitmaps cannot drift apart.

No third party dependencies are required.
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

# --------------------------------------------------------------------------
# Design constants. Everything is expressed in a 512 x 512 design space and
# scaled at render time, so these numbers describe both the SVG and the PNGs.
# --------------------------------------------------------------------------

CANVAS = 512.0
CENTER = CANVAS / 2.0

# The icon's own brand colour. The manifest theme_color / background_color are
# deliberately NOT this: they match styles.css --bg (#f5f5f7) and the
# theme-color meta in index.html, so the standalone launch does not flash.
FIELD = "#236E6B"          # deep calm teal
CAPSULE_LIGHT = "#FFFFFF"  # the near half of the capsule
CAPSULE_TINT = "#9FD6D2"   # the far half, pale teal

CORNER_RADIUS = 112.0      # rounded square for the "any" tile
TILT_DEGREES = -45.0       # negative is counter clockwise on screen

# Capsule half length / half width in design units.
ANY_HALF_LENGTH = 170.0
ANY_HALF_WIDTH = 78.0

# The maskable safe zone is the inner 80 percent circle: radius 0.4 * 512 which
# is 204.8. A stadium's farthest point from its centre is exactly its half
# length, so any half length under 204.8 is safe. 140 leaves a real margin.
MASKABLE_HALF_LENGTH = 164.0
MASKABLE_HALF_WIDTH = 75.0

SEAM_WIDTH = 9.0           # design units, so about 3px at 192

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"


class Variant:
    """One icon flavour: how round the tile is and how big the capsule is."""

    def __init__(self, name, corner_radius, half_length, half_width):
        self.name = name
        self.corner_radius = corner_radius
        self.half_length = half_length
        self.half_width = half_width

    @property
    def seam_half(self):
        # Keep the seam proportional so the maskable art is a true scale copy.
        return SEAM_WIDTH * 0.5 * (self.half_length / ANY_HALF_LENGTH)


ANY = Variant("any", CORNER_RADIUS, ANY_HALF_LENGTH, ANY_HALF_WIDTH)
MASKABLE = Variant("maskable", 0.0, MASKABLE_HALF_LENGTH, MASKABLE_HALF_WIDTH)


# --------------------------------------------------------------------------
# SVG
# --------------------------------------------------------------------------

def capsule_paths(v):
    """Return (near_half_path, far_half_path) as SVG path data.

    The capsule is a stadium: a rectangle of half length L and half width W with
    semicircular caps of radius W. It is drawn axis aligned here and rotated by
    the caller.
    """
    left = CENTER - v.half_length
    right = CENTER + v.half_length
    top = CENTER - v.half_width
    bottom = CENTER + v.half_width
    r = v.half_width
    cap_l = left + r      # centre x of the left cap
    cap_r = right - r     # centre x of the right cap
    s = v.seam_half

    near = (
        "M {0:.2f} {1:.2f} H {2:.2f} A {3:.2f} {3:.2f} 0 0 0 {2:.2f} {4:.2f} "
        "H {0:.2f} Z"
    ).format(CENTER - s, top, cap_l, r, bottom)
    far = (
        "M {0:.2f} {1:.2f} H {2:.2f} A {3:.2f} {3:.2f} 0 0 1 {2:.2f} {4:.2f} "
        "H {0:.2f} Z"
    ).format(CENTER + s, top, cap_r, r, bottom)
    return near, far


def build_svg(v):
    near, far = capsule_paths(v)
    if v.corner_radius > 0:
        tile = (
            '  <rect width="512" height="512" rx="{0:.0f}" ry="{0:.0f}" '
            'fill="{1}"/>'
        ).format(v.corner_radius, FIELD)
    else:
        tile = '  <rect width="512" height="512" fill="{0}"/>'.format(FIELD)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512" role="img" aria-label="p_tracker">\n'
        + tile + "\n"
        + '  <g transform="rotate({0:.0f} {1:.0f} {1:.0f})">\n'.format(
            TILT_DEGREES, CENTER)
        + '    <path d="{0}" fill="{1}"/>\n'.format(near, CAPSULE_LIGHT)
        + '    <path d="{0}" fill="{1}"/>\n'.format(far, CAPSULE_TINT)
        + "  </g>\n"
        + "</svg>\n"
    )


# --------------------------------------------------------------------------
# Built in rasteriser, used when cairosvg is not installed
# --------------------------------------------------------------------------

def hex_rgb(value):
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def rounded_box_sd(px, py, bx, by, r):
    """Signed distance to a rounded box centred on the origin.

    Negative inside. bx and by are the half extents, r the corner radius.
    """
    qx = abs(px) - bx + r
    qy = abs(py) - by + r
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def coverage(distance, scale):
    """Antialiased coverage from a signed distance, measured in device pixels."""
    return min(1.0, max(0.0, 0.5 - distance * scale))


def render_rgba(v, size):
    """Render one icon and return raw RGBA rows, size * size * 4 bytes."""
    field = hex_rgb(FIELD)
    light = hex_rgb(CAPSULE_LIGHT)
    tint = hex_rgb(CAPSULE_TINT)

    unit = CANVAS / size                  # design units per device pixel
    scale = 1.0 / unit                    # device pixels per design unit
    angle = math.radians(-TILT_DEGREES)   # inverse rotation into capsule space
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)

    tile_r = v.corner_radius
    half = CANVAS / 2.0
    seam = v.seam_half

    out = bytearray(size * size * 4)
    i = 0
    for y in range(size):
        dy = (y + 0.5) * unit - CENTER
        for x in range(size):
            dx = (x + 0.5) * unit - CENTER

            # The tile. A zero radius tile is a plain full bleed square.
            if tile_r > 0.0:
                tile_cov = coverage(
                    rounded_box_sd(dx, dy, half, half, tile_r), scale)
            else:
                tile_cov = 1.0

            r_val, g_val, b_val = field
            alpha = tile_cov

            if tile_cov > 0.0:
                # Rotate into the capsule's own frame.
                u = dx * cos_a - dy * sin_a
                w = dx * sin_a + dy * cos_a

                cap_cov = coverage(
                    rounded_box_sd(u, w, v.half_length, v.half_width,
                                   v.half_width),
                    scale,
                )
                if cap_cov > 0.0:
                    # Half planes u < -seam and u > +seam, leaving the seam
                    # itself unpainted so the field colour shows through.
                    near_cov = min(cap_cov, coverage(u + seam, scale))
                    far_cov = min(cap_cov, coverage(seam - u, scale))
                    if near_cov > 0.0:
                        r_val = r_val + (light[0] - r_val) * near_cov
                        g_val = g_val + (light[1] - g_val) * near_cov
                        b_val = b_val + (light[2] - b_val) * near_cov
                    if far_cov > 0.0:
                        r_val = r_val + (tint[0] - r_val) * far_cov
                        g_val = g_val + (tint[1] - g_val) * far_cov
                        b_val = b_val + (tint[2] - b_val) * far_cov
                    alpha = max(alpha, cap_cov)

            out[i] = int(r_val + 0.5)
            out[i + 1] = int(g_val + 0.5)
            out[i + 2] = int(b_val + 0.5)
            out[i + 3] = int(alpha * 255.0 + 0.5)
            i += 4
    return out


def write_png(path, rgba, size):
    """Write a straight, non interlaced, 8 bit RGBA PNG."""
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0, None
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

def load_cairosvg():
    try:
        import cairosvg
        return cairosvg
    except Exception:
        return None


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    svg_path = OUT_DIR / "icon.svg"
    svg_text = build_svg(ANY)
    with open(svg_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(svg_text)
    print("wrote {0}".format(svg_path.name))

    cairosvg = load_cairosvg()
    if cairosvg is None:
        print("cairosvg not available, using the built in renderer")

    targets = [
        (ANY, 192, "icon-192.png"),
        (ANY, 512, "icon-512.png"),
        (MASKABLE, 192, "icon-maskable-192.png"),
        (MASKABLE, 512, "icon-maskable-512.png"),
    ]

    for variant, size, filename in targets:
        out = OUT_DIR / filename
        if cairosvg is not None:
            source = svg_text if variant is ANY else build_svg(variant)
            cairosvg.svg2png(
                bytestring=source.encode("utf-8"),
                write_to=str(out),
                output_width=size,
                output_height=size,
            )
        else:
            write_png(out, render_rgba(variant, size), size)
        print("wrote {0}  {1}x{1}  {2} bytes".format(
            out.name, size, out.stat().st_size))

    return 0


if __name__ == "__main__":
    sys.exit(main())
