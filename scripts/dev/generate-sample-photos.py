"""
Generates PLACEHOLDER images for the sample locations so the site can be
developed and tested before real photographs are added.

These are procedurally drawn scenes, not photographs. Delete the sample
locations (src/content/locations/*) once your own photos are in.

Usage:  python3 scripts/dev/generate-sample-photos.py
Requires: numpy, Pillow
"""
import math
import zlib
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "src", "content", "locations")
LONG_EDGE = 2400


def hex2rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


class Canvas:
    def __init__(self, w, h, rng):
        self.w, self.h, self.rng = w, h, rng
        self.img = np.zeros((h, w, 3), dtype=np.float32)
        self.yy, self.xx = np.mgrid[0:h, 0:w].astype(np.float32)
        self.u = self.xx / w
        self.v = self.yy / h

    # vertical gradient through colour stops [(t, "#hex"), ...]
    def sky(self, stops):
        v = self.v[:, :1, None]
        out = np.zeros((self.h, 1, 3), dtype=np.float32)
        for (t0, c0), (t1, c1) in zip(stops[:-1], stops[1:]):
            m = (v >= t0) & (v <= t1)
            t = np.clip((v - t0) / max(t1 - t0, 1e-6), 0, 1)
            col = lerp(hex2rgb(c0), hex2rgb(c1), t)
            out = np.where(m, col, out)
        out = np.where(v < stops[0][0], hex2rgb(stops[0][1]), out)
        out = np.where(v > stops[-1][0], hex2rgb(stops[-1][1]), out)
        self.img[:] = np.broadcast_to(out, self.img.shape)

    def glow(self, cx, cy, radius, color, strength=1.0, power=2.0):
        d = np.sqrt(((self.u - cx) * self.w / self.h) ** 2 + (self.v - cy) ** 2) / radius
        g = np.exp(-(d ** power)) * strength
        self.img += g[..., None] * hex2rgb(color)

    def fill(self, mask, color, alpha=1.0):
        c = hex2rgb(color) if isinstance(color, str) else color
        m = (mask * alpha)[..., None]
        self.img = self.img * (1 - m) + c * m

    def ridge_mask(self, heights):
        """heights: array (w,) of y positions in 0..1; returns AA mask of area below."""
        y = heights[None, :] * self.h
        return np.clip(self.yy - y + 0.5, 0, 1)

    def fbm1d(self, freq, octaves=5, sharp=False, seed_off=0):
        x = self.u[0]
        total = np.zeros_like(x)
        amp, f = 1.0, freq
        for o in range(octaves):
            phase = self.rng.uniform(0, 2 * math.pi)
            n = np.sin(x * f * 2 * math.pi + phase) * 0.6 + np.sin(x * f * 2 * 1.73 * math.pi + phase * 1.3) * 0.4
            if sharp:
                n = 1 - np.abs(n)
            total += n * amp
            amp *= 0.5
            f *= 2.03
        return total / 1.9

    def stars(self, count, region=1.0, size=1.0):
        layer = Image.new("L", (self.w, self.h), 0)
        d = ImageDraw.Draw(layer)
        for _ in range(count):
            x = self.rng.uniform(0, self.w)
            y = self.rng.uniform(0, self.h * region) ** 1.0
            b = int(self.rng.uniform(60, 255) * (1 - y / (self.h * region)) ** 0.5)
            r = self.rng.uniform(0.4, 1.4) * size * self.w / 2400
            d.ellipse([x - r, y - r, x + r, y + r], fill=b)
        arr = np.asarray(layer.filter(ImageFilter.GaussianBlur(0.6 * self.w / 2400)), dtype=np.float32) / 255
        self.img += arr[..., None] * np.array([0.9, 0.95, 1.0])

    def lights(self, mask, count, color="#ffc47a", size=2.0, spread=1.0):
        layer = Image.new("L", (self.w, self.h), 0)
        d = ImageDraw.Draw(layer)
        ys, xs = np.nonzero(mask > 0.5)
        if len(xs) == 0:
            return
        idx = self.rng.integers(0, len(xs), count)
        s = self.w / 2400
        for i in idx:
            r = self.rng.uniform(0.6, 1.6) * size * s
            d.ellipse([xs[i] - r, ys[i] - r, xs[i] + r, ys[i] + r], fill=int(self.rng.uniform(140, 255)))
        sharp = np.asarray(layer, dtype=np.float32) / 255
        halo = np.asarray(layer.filter(ImageFilter.GaussianBlur(6 * s * spread)), dtype=np.float32) / 255
        c = hex2rgb(color)
        self.img += (sharp[..., None] * 1.1 + halo[..., None] * 1.6) * c

    def reflect(self, horizon, darken=0.55, ripple=0.004):
        hy = int(horizon * self.h)
        rows = self.h - hy
        src_y = hy - 1 - np.arange(rows)
        src_y = np.clip(src_y, 0, hy - 1)
        offs = (np.sin(np.arange(rows)[:, None] * 0.9 + self.xx[hy:, :] * 0.02) * ripple * self.w).astype(int)
        xs = np.clip(self.xx[hy:, :].astype(int) + offs, 0, self.w - 1)
        refl = self.img[src_y[:, None], xs]
        fade = np.linspace(1.0, 0.5, rows)[:, None, None]
        self.img[hy:] = refl * darken * fade + self.img[hy:] * (1 - darken) * 0.15

    def silhouette(self, draw_fn, color, alpha=1.0, blur=0.0):
        ss = 2
        layer = Image.new("L", (self.w * ss, self.h * ss), 0)
        d = ImageDraw.Draw(layer)
        draw_fn(d, self.w * ss, self.h * ss, ss)
        layer = layer.resize((self.w, self.h), Image.LANCZOS)
        if blur:
            layer = layer.filter(ImageFilter.GaussianBlur(blur))
        m = np.asarray(layer, dtype=np.float32) / 255
        self.fill(m, color, alpha)
        return m

    def finish(self, grade="neutral"):
        img = self.img
        # gentle filmic tone curve
        img = np.clip(img, 0, None)
        img = img / (1 + img * 0.18)
        img = np.clip(img * 1.12, 0, 1)
        img = img * img * (3 - 2 * img) * 0.35 + img * 0.65
        # restrained colour grade: cool shadows, warm highlights
        lum = img.mean(axis=2, keepdims=True)
        shadows = (1 - lum) ** 2
        img += shadows * np.array([-0.012, 0.004, 0.018])
        img += lum ** 2 * np.array([0.015, 0.006, -0.01])
        # vignette
        d = np.sqrt((self.u - 0.5) ** 2 * 1.2 + (self.v - 0.5) ** 2)
        img *= (1 - smoothstep(0.35, 0.95, d) * 0.45)[..., None]
        # grain
        img += self.rng.normal(0, 0.012, img.shape).astype(np.float32)
        img = np.clip(img, 0, 1)
        return Image.fromarray((img * 255).astype(np.uint8))


# ---------------------------------------------------------------- scenes

def mountains(c, layers, horizon, sharpness=True):
    for i, (base, amp, freq, color) in enumerate(layers):
        h = base - amp * c.fbm1d(freq, 6, sharp=sharpness)
        c.fill(c.ridge_mask(h), color)


def person(d, W, H, s, x, y, scale=1.0):
    h = H * 0.06 * scale
    w = h * 0.28
    d.ellipse([x - w * 0.32, y - h, x + w * 0.32, y - h + w * 0.64], fill=255)
    d.rounded_rectangle([x - w / 2, y - h + w * 0.62, x + w / 2, y - h * 0.38], radius=w * 0.3, fill=255)
    d.rectangle([x - w * 0.36, y - h * 0.4, x - w * 0.06, y], fill=255)
    d.rectangle([x + w * 0.06, y - h * 0.4, x + w * 0.36, y], fill=255)


def scene_iceland(c, k):
    c.sky([(0, "#1d2a3d"), (0.38, "#5c6f84"), (0.55, "#c6cdd2"), (0.62, "#d9c9b3")])
    c.glow(0.7, 0.55, 0.35, "#f1c9a0", 0.25)
    # cloud band
    band = c.fbm1d(2.5, 6)
    clouds = smoothstep(0.1, 0.6, np.sin(c.v * 18 + band[None, :] * 2.5) * 0.5 + 0.5) * smoothstep(0.15, 0.3, c.v) * (1 - smoothstep(0.32, 0.45, c.v))
    c.fill(clouds * 0.12, "#e7e9ea")
    horizon = 0.62
    mountains(c, [
        (0.56, 0.12, 1.3, "#7b8796"),
        (0.6, 0.1, 1.9, "#4e5b6b"),
        (0.64, 0.06, 3.0, "#2d3845"),
    ], horizon)
    if k % 2 == 0:
        c.fill(c.ridge_mask(np.full(c.w, 0.7)), "#3a4a56")
        c.reflect(0.7, 0.5)
    fg = 0.78 + 0.08 * c.fbm1d(0.7, 4) + 0.08 * (c.u[0] - 0.5)
    c.fill(c.ridge_mask(fg), "#151b20")
    if k in (0, 3):
        px = c.w * (0.35 if k == 0 else 0.62)
        py = float(np.interp(px / c.w, c.u[0], fg)) * c.h + 2
        c.silhouette(lambda d, W, H, s: person(d, W, H, s, px * s, py * s, 1.0), "#0b0f12")


def scene_cinque(c, k):
    c.sky([(0, "#232845"), (0.35, "#55507a"), (0.55, "#c98a86"), (0.66, "#efb18b")])
    c.glow(0.82, 0.62, 0.25, "#ffb27a", 0.35)
    horizon = 0.64
    c.fill(c.ridge_mask(np.full(c.w, horizon)), "#1e2c44")
    c.reflect(horizon, 0.45)
    side = 0.0 if k % 2 == 0 else 1.0
    x = c.u[0] if side == 0 else 1 - c.u[0]
    cliff = 0.28 + 0.5 * smoothstep(0.25, 0.75, x) + 0.04 * c.fbm1d(3, 5)
    m = c.ridge_mask(cliff) * (1 - smoothstep(0.62, 0.72, x))
    c.fill(m, "#2b2733")
    # terraces / houses
    houses = m * (c.v > cliff[None, :] * 1.08 + 0.04) * (c.v < 0.82)
    c.fill(houses * 0.35, "#4a3c3c")
    c.lights(houses, 900 + 200 * k, "#ffbf73", 1.7)
    c.fill(c.ridge_mask(0.9 + 0.03 * c.fbm1d(2, 3)), "#0c0e14")


def acacia(d, W, H, s, x, y, scale):
    h = H * 0.18 * scale
    d.line([x, y, x + h * 0.05, y - h * 0.55], fill=255, width=int(h * 0.05))
    for a in (-0.7, -0.3, 0.2, 0.6):
        d.line([x + h * 0.04, y - h * 0.5, x + a * h * 0.6, y - h * 0.85], fill=255, width=int(h * 0.025))
    d.ellipse([x - h * 0.6, y - h * 0.98, x + h * 0.65, y - h * 0.8], fill=255)


def scene_namibia(c, k):
    c.sky([(0, "#3f3557"), (0.3, "#9d5f68"), (0.5, "#ef9c62"), (0.58, "#f6c27e")])
    c.glow(0.3 + 0.1 * k, 0.56, 0.12, "#fff1c4", 0.9, 1.6)
    for i, (base, amp, col) in enumerate([(0.58, 0.12, "#a3492b"), (0.63, 0.1, "#7f3320"), (0.7, 0.06, "#59240f")]):
        x = c.u[0]
        h = base - amp * (0.5 + 0.5 * np.sin(x * (2.2 + i) * math.pi + c.rng.uniform(0, 6))) ** 2
        mask = c.ridge_mask(h)
        c.fill(mask, col)
        # lit face
        lit = mask * smoothstep(0.0, 1.0, np.cos(x * (2.2 + i) * math.pi * 1.0 + i)) * 0.25
        c.fill(lit, "#f08a4b")
    pan = 0.78
    c.fill(c.ridge_mask(np.full(c.w, pan)), "#d6bf9b")
    c.fill(smoothstep(pan, 1.0, c.v) * 0.4, "#b49a78")
    n = 1 + k % 3
    for i in range(n):
        tx = c.w * (0.25 + 0.5 * i / max(n, 1) + c.rng.uniform(-0.08, 0.08))
        ty = c.h * (pan + c.rng.uniform(0.03, 0.12))
        sc = c.rng.uniform(0.7, 1.2)
        c.silhouette(lambda d, W, H, s: acacia(d, W, H, s, tx * s, ty * s, sc), "#1a120d")


def skyline(d, W, H, s, rng, base, maxh):
    x = 0
    rects = []
    while x < W:
        bw = rng.uniform(0.018, 0.05) * W
        bh = rng.uniform(0.25, 1.0) ** 2 * maxh * H
        d.rectangle([x, base * H - bh, x + bw, base * H], fill=255)
        if rng.random() < 0.15:
            d.polygon([(x + bw * 0.3, base * H - bh), (x + bw * 0.5, base * H - bh - maxh * H * 0.18), (x + bw * 0.7, base * H - bh)], fill=255)
        rects.append((x, base * H - bh, x + bw, base * H))
        x += bw + rng.uniform(0, 0.004) * W
    return rects


def scene_newyork(c, k):
    c.sky([(0, "#161a33"), (0.35, "#3d3c66"), (0.6, "#c7778a"), (0.72, "#f0a273")])
    horizon = 0.72
    rng = np.random.default_rng(k + 40)
    m = c.silhouette(lambda d, W, H, s: skyline(d, W, H, s, rng, horizon, 0.45), "#151726")
    c.lights(m * (c.v < horizon - 0.01), 5000, "#ffd08a", 0.9, 0.5)
    m2 = c.silhouette(lambda d, W, H, s: skyline(d, W, H, s, np.random.default_rng(k + 90), horizon, 0.22), "#0d0f1a")
    c.lights(m2 * (c.v < horizon - 0.01), 1500, "#ffe3b0", 0.8, 0.4)
    c.fill(c.ridge_mask(np.full(c.w, horizon)), "#14182a")
    c.reflect(horizon, 0.7, 0.002)


def scene_lofoten(c, k):
    c.sky([(0, "#03070d"), (0.4, "#08151f"), (0.62, "#0f2a33")])
    c.stars(1600, 0.6)
    # aurora curtains
    centre = 0.28 + 0.1 * c.fbm1d(0.8 + 0.2 * k, 4)
    dist = c.v - centre[None, :]
    curtain = np.exp(-np.clip(dist, 0, None) * 40) * np.exp(-np.clip(-dist, 0, None) * 6) * (dist > -0.25)
    streak = 0.82 + 0.18 * np.sin(c.u * 140 + c.fbm1d(6, 3)[None, :] * 8)
    a = curtain * streak * smoothstep(0.0, 0.08, c.v)
    c.img += a[..., None] * hex2rgb("#3bf0a0") * 0.9
    c.img += (np.exp(-np.clip(-dist - 0.1, 0, None) * 8) * curtain * 0.25)[..., None] * hex2rgb("#a35cff")
    horizon = 0.66
    h = 0.66 - 0.22 * c.fbm1d(1.4, 6, sharp=True)
    mm = c.ridge_mask(h)
    c.fill(mm, "#16212b")
    snow = mm * smoothstep(0.0, 0.04, c.v - h[None, :]) * (1 - smoothstep(0.03, 0.12, c.v - h[None, :])) * (h[None, :] < 0.56)
    c.fill(snow * 0.55, "#8fa2ad")
    c.fill(c.ridge_mask(np.full(c.w, horizon)), "#071017")
    c.reflect(horizon, 0.65, 0.002)
    if k % 2:
        c.lights(c.ridge_mask(np.full(c.w, horizon - 0.004)) * (c.v < horizon + 0.004) * (c.u < 0.45), 40, "#ffcf8a", 1.5)


def rooftops(d, W, H, s, rng, k):
    base = H * 0.78
    x = 0
    while x < W:
        bw = rng.uniform(0.04, 0.09) * W
        bh = rng.uniform(0.06, 0.16) * H
        d.rectangle([x, base - bh, x + bw, H], fill=255)
        if rng.random() < 0.5:
            d.polygon([(x, base - bh), (x + bw / 2, base - bh - bh * 0.25), (x + bw, base - bh)], fill=255)
        x += bw
    # dome
    cx = W * (0.36 + 0.25 * (k % 2))
    r = W * 0.07
    d.rectangle([cx - r * 0.8, base - H * 0.25, cx + r * 0.8, base], fill=255)
    d.pieslice([cx - r, base - H * 0.25 - r, cx + r, base - H * 0.25 + r], 180, 360, fill=255)
    d.rectangle([cx - r * 0.06, base - H * 0.25 - r * 1.35, cx + r * 0.06, base - H * 0.25 - r * 0.9], fill=255)
    # tower
    tx = W * (0.75 - 0.4 * (k % 2))
    tw = W * 0.035
    d.rectangle([tx - tw, base - H * 0.42, tx + tw, base], fill=255)
    d.rectangle([tx - tw * 0.7, base - H * 0.5, tx + tw * 0.7, base - H * 0.42], fill=255)
    d.polygon([(tx - tw * 0.5, base - H * 0.5), (tx, base - H * 0.56), (tx + tw * 0.5, base - H * 0.5)], fill=255)


def scene_seville(c, k):
    if k % 3 == 2:
        c.sky([(0, "#141c3a"), (0.45, "#2f3f6e"), (0.75, "#6f6f9a")])
    else:
        c.sky([(0, "#5b4d7d"), (0.35, "#c9806b"), (0.62, "#ffc98a"), (0.8, "#ffe0aa")])
        c.glow(0.55, 0.72, 0.18, "#fff0c8", 0.6)
    rng = np.random.default_rng(k + 7)
    m = c.silhouette(lambda d, W, H, s: rooftops(d, W, H, s, rng, k), "#2a1e22")
    c.lights(m * (c.v > 0.62), 500 if k % 3 == 2 else 150, "#ffc06a", 1.6)


def palm(d, W, H, s, x, y, scale, lean):
    h = H * 0.55 * scale
    pts = []
    for i in range(30):
        t = i / 29
        pts.append((x + lean * h * 0.35 * t * t, y - h * t))
    for i in range(len(pts) - 1):
        wdt = int(h * 0.028 * (1 - 0.5 * i / 29))
        d.line([pts[i], pts[i + 1]], fill=255, width=max(wdt, 2))
    tx, ty = pts[-1]
    for a in np.linspace(-2.8, -0.3, 9):
        L = h * 0.32
        frond = []
        for j in range(14):
            t = j / 13
            ang = a + 0.0
            fx = tx + math.cos(ang) * L * t
            fy = ty + math.sin(ang) * L * t + (L * 0.5) * t * t
            frond.append((fx, fy))
        for j in range(len(frond) - 1):
            d.line([frond[j], frond[j + 1]], fill=255, width=max(int(h * 0.016 * (1 - j / 14)), 2))
    for a in np.linspace(0.3, 2.8, 2):
        pass


def scene_bali(c, k):
    c.sky([(0, "#251e3e"), (0.3, "#6a3b5d"), (0.52, "#ee7a44"), (0.62, "#ffc06b")])
    sx = 0.45 + 0.15 * (k % 3 - 1)
    c.glow(sx, 0.6, 0.09, "#fff4c9", 1.2, 1.5)
    horizon = 0.63
    c.fill(c.ridge_mask(0.6 - 0.04 * c.fbm1d(1.2, 4) * (c.u[0] > 0.6)), "#3d2134", 0.8)
    c.fill(c.ridge_mask(np.full(c.w, horizon)), "#2a1c2c")
    c.reflect(horizon, 0.75, 0.003)
    c.fill(c.ridge_mask(0.9 + 0.03 * c.fbm1d(1, 3)), "#120a10")
    for i in range(1 + k % 2):
        px = c.w * (0.78 if i == 0 else 0.16) + c.rng.uniform(-40, 40)
        lean = -0.9 if i == 0 else 0.7
        c.silhouette(lambda d, W, H, s: palm(d, W, H, s, px * s, H * 0.93, 1.0 - 0.15 * i, lean), "#0c070a")


def scene_zermatt(c, k):
    alpenglow = k % 2 == 1
    if alpenglow:
        c.sky([(0, "#26324f"), (0.5, "#7d86a8"), (0.75, "#e9b9a7")])
    else:
        c.sky([(0, "#1f4c80"), (0.55, "#7fa9d2"), (0.8, "#d7e6f2")])
    x = c.u[0]
    px = 0.55 + 0.1 * (k % 3 - 1)
    peak = 0.16 + np.abs(x - px) * (1.1 + 0.4 * (x < px)) + 0.02 * c.fbm1d(5, 4)
    mask = c.ridge_mask(peak)
    lit = "#f3c4ad" if alpenglow else "#f2f5f7"
    shade = "#5e6b85" if alpenglow else "#8a99ad"
    face = mask * (x < px)
    c.fill(mask, shade)
    c.fill(face * 0.85, lit)
    c.fill(c.ridge_mask(0.62 - 0.08 * c.fbm1d(1.5, 5, True)), "#c9d4e0" if not alpenglow else "#9c98b0")
    c.fill(c.ridge_mask(0.78 - 0.05 * c.fbm1d(1, 4)), "#e8eef4" if not alpenglow else "#b7b0c4")

    def pines(d, W, H, s):
        rng = np.random.default_rng(k + 3)
        for _ in range(26):
            x0 = rng.uniform(0, W)
            base = H * rng.uniform(0.86, 0.98)
            h = H * rng.uniform(0.06, 0.14)
            d.polygon([(x0, base - h), (x0 - h * 0.22, base), (x0 + h * 0.22, base)], fill=255)

    c.silhouette(pines, "#1c2530")


SCENES = {
    "iceland-south-coast": scene_iceland,
    "cinque-terre": scene_cinque,
    "sossusvlei": scene_namibia,
    "new-york": scene_newyork,
    "lofoten": scene_lofoten,
    "seville": scene_seville,
    "uluwatu": scene_bali,
    "zermatt": scene_zermatt,
}

ASPECTS = [(3, 2), (3, 2), (2, 3), (16, 9), (4, 5), (3, 2)]


def main():
    only = os.environ.get("ONLY", "").split(",") if os.environ.get("ONLY") else None
    for slug, fn in SCENES.items():
        if only and slug not in only:
            continue
        out = os.path.join(ROOT, slug)
        os.makedirs(out, exist_ok=True)
        for k, (aw, ah) in enumerate(ASPECTS):
            if aw >= ah:
                w, h = LONG_EDGE, int(LONG_EDGE * ah / aw)
            else:
                w, h = int(LONG_EDGE * aw / ah), LONG_EDGE
            rng = np.random.default_rng(zlib.crc32(f"{slug}-{k}".encode()))
            c = Canvas(w, h, rng)
            fn(c, k)
            img = c.finish()
            path = os.path.join(out, f"{slug}-{k + 1:02d}.jpg")
            img.save(path, quality=86, optimize=True, progressive=True)
            print(path)


if __name__ == "__main__":
    main()
