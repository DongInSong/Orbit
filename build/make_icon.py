#!/usr/bin/env python3
"""Generate build/orbit.ico from the same mark as the in-app SVG favicon
(a cyan planet + a tilted orbit) on a dark rounded tile. Re-run after tweaks:

    python build/make_icon.py

Emits a multi-resolution .ico (16-256 px) that orbit.spec bakes into orbit.exe
(so the Start-Menu shortcuts use it) and that the WiX ARP entry shows. Pillow only.
"""
import os
from PIL import Image, ImageDraw, ImageFilter

CYAN = (34, 211, 238)        # #22d3ee — matches --cyan and the favicon
BG = (11, 15, 26)            # dark tile, matches the app's space theme
SS = 8                       # supersample for crisp anti-aliasing
OUT = 256                    # master / max ICO dimension
S = OUT * SS

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "orbit.ico")


def build():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # dark rounded tile
    draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.18), fill=BG + (255,))

    # map the 32-unit favicon coordinate space into a centred 74% box
    box = 0.74 * S
    scale = box / 32.0
    cx = cy = S / 2.0          # favicon centre (16,16) -> canvas centre

    # soft cyan glow behind the planet
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gr = 9 * scale
    ImageDraw.Draw(glow).ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=CYAN + (130,))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(6 * scale)))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # planet: filled circle, r=5
    pr = 5 * scale
    draw.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=CYAN + (255,))

    # orbit: tilted ellipse outline, rx=13 ry=6 stroke 1.5, rotate -24deg
    orbit = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rx, ry = 13 * scale, 6 * scale
    ImageDraw.Draw(orbit).ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                                  outline=CYAN + (165,), width=max(1, int(1.5 * scale)))
    orbit = orbit.rotate(24, resample=Image.BICUBIC, center=(cx, cy))
    img = Image.alpha_composite(img, orbit)

    master = img.resize((OUT, OUT), Image.LANCZOS)
    master.save(OUT_PATH, format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"wrote {OUT_PATH}")
    return master


if __name__ == "__main__":
    build()
