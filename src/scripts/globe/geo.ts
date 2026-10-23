import { Vector3 } from 'three';

export const DEG = Math.PI / 180;

/**
 * Converts latitude/longitude (degrees) to a point on a sphere.
 * Matches the UV layout of THREE.SphereGeometry with an equirectangular texture.
 */
export function latLngToVec3(lat: number, lng: number, radius = 1, out = new Vector3()): Vector3 {
  const la = lat * DEG;
  const lo = lng * DEG;
  return out.set(Math.cos(la) * Math.cos(lo) * radius, Math.sin(la) * radius, -Math.cos(la) * Math.sin(lo) * radius);
}

/** Shortest signed angular difference b - a, in degrees, wrapped to [-180, 180). */
export function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Loads the packed line files produced by scripts/build-globe-textures.mjs and
 * returns LineSegments-ready positions on a sphere of the given radius.
 */
export async function loadLines(url: string, radius: number): Promise<Float32Array> {
  const buf = await (await fetch(url)).arrayBuffer();
  const header = new Uint32Array(buf, 0, 1);
  const count = header[0];
  const lengths = new Uint32Array(buf, 4, count);
  const pts = new Int16Array(buf, 4 + count * 4);
  let segs = 0;
  for (let i = 0; i < count; i++) segs += Math.max(0, lengths[i] - 1);
  const out = new Float32Array(segs * 6);
  const a = new Vector3();
  const b = new Vector3();
  let p = 0;
  let o = 0;
  for (let i = 0; i < count; i++) {
    const n = lengths[i];
    for (let j = 0; j < n; j++) {
      const lng = pts[(p + j) * 2] / 100;
      const lat = pts[(p + j) * 2 + 1] / 100;
      latLngToVec3(lat, lng, radius, b);
      if (j > 0) {
        out[o++] = a.x; out[o++] = a.y; out[o++] = a.z;
        out[o++] = b.x; out[o++] = b.y; out[o++] = b.z;
      }
      a.copy(b);
    }
    p += n;
  }
  return out;
}

/** Graticule lines (every `step` degrees) generated on the client. */
export function graticule(radius: number, step = 15): Float32Array {
  const segs: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  for (let lng = -180; lng < 180; lng += step) {
    for (let lat = -80; lat < 80; lat += 2) {
      latLngToVec3(lat, lng, radius, a);
      latLngToVec3(lat + 2, lng, radius, b);
      segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  for (let lat = -75; lat <= 75; lat += step) {
    for (let lng = -180; lng < 180; lng += 2) {
      latLngToVec3(lat, lng, radius, a);
      latLngToVec3(lat, lng + 2, radius, b);
      segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  return new Float32Array(segs);
}
