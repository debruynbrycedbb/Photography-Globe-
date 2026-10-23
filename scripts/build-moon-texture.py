"""
Generates the Moon's surface texture procedurally (no third-party imagery,
so there are no licensing questions): dark maria, a few hundred craters
with raised rims and bright ray systems on the largest ones.

Output: public/textures/moon-2048.jpg  (R = albedo, G = height for hill-shading)
Usage:  python3 scripts/build-moon-texture.py      (needs numpy + Pillow)
"""
import math
import os
import numpy as np
from PIL import Image, ImageFilter

W, H = 2048, 1024
rng = np.random.default_rng(7)
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'textures', 'moon-2048.jpg')

lon = (np.arange(W) + 0.5) / W * 2 * math.pi - math.pi
lat = math.pi / 2 - (np.arange(H) + 0.5) / H * math.pi
LON, LAT = np.meshgrid(lon, lat)
X = np.cos(LAT) * np.cos(LON)
Y = np.sin(LAT)
Z = -np.cos(LAT) * np.sin(LON)


def value_noise3(x, y, z, freq, seed):
    """Smooth 3D value noise sampled on the sphere (seamless, no pole pinching)."""
    r = np.random.default_rng(seed)
    n = 64
    grid = r.random((n, n, n)).astype(np.float32)
    p = [(c * freq + 32.0) % (n - 1) for c in (x, y, z)]
    i = [np.floor(c).astype(int) for c in p]
    f = [c - np.floor(c) for c in p]
    f = [t * t * (3 - 2 * t) for t in f]
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[0] if dx else 1 - f[0]) * (f[1] if dy else 1 - f[1]) * (f[2] if dz else 1 - f[2])
                out = out + w * grid[(i[0] + dx) % n, (i[1] + dy) % n, (i[2] + dz) % n]
    return out


def fbm(freq, octaves, seed):
    total = np.zeros((H, W), np.float32)
    amp, f, norm = 1.0, freq, 0.0
    for o in range(octaves):
        total += amp * value_noise3(X, Y, Z, f, seed + o)
        norm += amp
        amp *= 0.5
        f *= 2.03
    return total / norm


# Base albedo: highlands bright, maria dark (large smooth patches, more on one hemisphere like the real near side)
maria = fbm(1.3, 4, 11)
# The site shows the Moon's local +Z side to the viewer, so put more maria there.
maria_mask = np.clip((maria + 0.16 * np.clip(Z, 0, 1) - 0.55) * 6.0, 0, 1)
albedo = 0.62 - 0.30 * maria_mask + 0.10 * (fbm(6.0, 5, 23) - 0.5)
height = 0.5 - 0.10 * maria_mask + 0.12 * (fbm(4.0, 6, 31) - 0.5)

# Craters: power-law sizes, drawn in 3D so they stay round everywhere on the sphere
n_craters = 520
sizes = 0.012 * (1 / (rng.random(n_craters) ** 0.55))
sizes = np.clip(sizes, 0.012, 0.16)
for k in range(n_craters):
    v = rng.normal(size=3)
    v /= np.linalg.norm(v)
    a = sizes[k]
    clat = math.asin(v[1])
    clon = math.atan2(-v[2], v[0])
    # Bounding box in pixels (wider near the poles)
    span_lat = a * 2.6
    r0 = max(0, int((math.pi / 2 - (clat + span_lat)) / math.pi * H))
    r1 = min(H, int((math.pi / 2 - (clat - span_lat)) / math.pi * H) + 1)
    if abs(clat) + span_lat > math.pi / 2 - 0.05:
        cols = np.arange(W)
    else:
        span_lon = span_lat / max(math.cos(abs(clat) + span_lat), 0.05)
        c0 = int((clon - span_lon + math.pi) / (2 * math.pi) * W)
        c1 = int((clon + span_lon + math.pi) / (2 * math.pi) * W) + 1
        cols = np.arange(c0, c1) % W
    xs, ys, zs = X[r0:r1][:, cols], Y[r0:r1][:, cols], Z[r0:r1][:, cols]
    d = np.arccos(np.clip(xs * v[0] + ys * v[1] + zs * v[2], -1, 1)) / a  # 1.0 at the rim
    bowl = np.where(d < 1, -(1 - d * d) * 0.9, 0)
    rim = np.exp(-((d - 1.0) / 0.18) ** 2) * 0.55
    ejecta = np.where(d > 1, np.exp(-(d - 1) * 2.2) * 0.12, 0)
    dh = (bowl + rim + ejecta) * a * 2.2
    fresh = rng.random() ** 2
    da = np.where(d < 1, -0.05 * fresh, 0) + rim * 0.10 * fresh + ejecta * 0.5 * fresh
    if a > 0.06 and rng.random() < 0.35:
        # faint, irregular ray system around a few big young craters
        ang = np.arctan2(ys - v[1], xs - v[0])
        ph = rng.random(3) * 6
        rays = np.clip(np.sin(ang * 17 + ph[0]) * np.sin(ang * 29 + ph[1]) * np.sin(ang * 7 + ph[2]), 0, 1) ** 1.5
        da = da + rays * np.where(d > 1, np.exp(-(d - 1) * 0.7), 0) * 0.07
    height[r0:r1, cols] += dh
    albedo[r0:r1, cols] += da

albedo = np.clip(albedo, 0.05, 1.0)
height = height - height.min()
height = height / height.max()

a8 = (albedo * 255).astype(np.uint8)
h8 = (height * 255).astype(np.uint8)
h8 = np.asarray(Image.fromarray(h8).filter(ImageFilter.GaussianBlur(0.6)))
rgb = np.stack([a8, h8, np.zeros_like(a8)], axis=-1)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
Image.fromarray(rgb).save(OUT, quality=88, optimize=True)
print('wrote', os.path.normpath(OUT), os.path.getsize(OUT) // 1024, 'KB')
