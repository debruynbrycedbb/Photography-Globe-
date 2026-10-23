import { getCollection, type CollectionEntry } from 'astro:content';
import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { parse } from 'yaml';

export type Location = CollectionEntry<'locations'>;
export type Photo = Location['data']['photos'][number];

/** Prefix a site-relative path with the configured base path (needed on GitHub Pages). */
export function withBase(p = ''): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return base + p.replace(/^\//, '');
}

export function locationHref(loc: Location): string {
  return withBase(`${loc.id}/`);
}

export async function getLocations(): Promise<Location[]> {
  const all = await getCollection('locations');
  return all.sort((a, b) => {
    const oa = a.data.order ?? Number.POSITIVE_INFINITY;
    const ob = b.data.order ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa - ob;
    return latestDate(b) - latestDate(a) || a.data.name.localeCompare(b.data.name);
  });
}

function allDates(loc: Location): Date[] {
  const d: Date[] = [];
  for (const v of loc.data.visits) {
    d.push(v.from);
    if (v.to) d.push(v.to);
  }
  for (const p of loc.data.photos) if (p.taken) d.push(p.taken);
  return d;
}

function latestDate(loc: Location): number {
  const d = allDates(loc);
  return d.length ? Math.max(...d.map((x) => x.getTime())) : 0;
}

/** "2024", "2022–2024" or "" when no dates are known. */
export function yearsLabel(loc: Location): string {
  const years = [...new Set(allDates(loc).map((d) => d.getUTCFullYear()))].sort();
  if (!years.length) return '';
  return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}

const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Human-readable visit dates, e.g. "2 Apr 2025 – 6 Apr 2025". Falls back to photo dates. */
export function visitLabels(loc: Location): string[] {
  if (loc.data.visits.length) {
    return loc.data.visits.map((v) => (v.to ? `${fmtDay.format(v.from)} – ${fmtDay.format(v.to)}` : fmtDay.format(v.from)));
  }
  // No visits listed: group photo dates into trips (a gap of more than 3 weeks starts a new trip).
  const taken = (loc.data.photos.map((p) => p.taken).filter(Boolean) as Date[]).sort((a, b) => +a - +b);
  if (!taken.length) return [];
  const trips: Date[][] = [];
  for (const d of taken) {
    const last = trips[trips.length - 1];
    if (last && +d - +last[last.length - 1] < 21 * 864e5) last.push(d);
    else trips.push([d]);
  }
  return trips.map((t) => {
    const a = fmtMonth.format(t[0]);
    const b = fmtMonth.format(t[t.length - 1]);
    return a === b ? a : `${a} – ${b}`;
  });
}

export function formatDate(d?: Date): string {
  return d ? fmtDay.format(d) : '';
}

function mostCommon(values: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

export const mainCamera = (loc: Location) => mostCommon(loc.data.photos.map((p) => p.camera));
/** Lens names without the stabiliser/motor suffixes, e.g. "EF-M15-45mm f/3.5-6.3". */
export const shortLens = (lens = '') => lens.replace(/\s+(IS|STM|USM|OSS|VR|OIS|DG|DN|HSM|WR|LM|G|GM|II|III)(\s+(IS|STM|USM|OSS|VR|OIS|DG|DN|HSM|WR|LM))*$/i, '').trim();
export const mainLens = (loc: Location) => shortLens(mostCommon(loc.data.photos.map((p) => p.lens)));

export function settingsLabel(p: Photo): string {
  const s = p.settings;
  if (!s) return '';
  return [s.focal, s.aperture, s.shutter, s.iso ? `ISO ${s.iso}` : ''].filter(Boolean).join('  ');
}

export function countriesCount(locs: Location[]): number {
  return new Set(locs.map((l) => l.data.country.trim().toLowerCase())).size;
}

// ---------- Responsive image sources ----------
export const GRID_WIDTHS = [480, 800, 1200, 1600, 2400];

export async function responsive(img: ImageMetadata, widths = GRID_WIDTHS) {
  const usable = widths.filter((w) => w <= img.width);
  if (!usable.length || usable[usable.length - 1] < img.width) usable.push(Math.min(img.width, 2400));
  const variants = await Promise.all(usable.map((w) => getImage({ src: img, width: w, format: 'webp', quality: 82 })));
  return {
    src: variants[Math.min(1, variants.length - 1)].src,
    srcset: variants.map((v, i) => `${v.src} ${usable[i]}w`).join(', '),
    width: img.width,
    height: img.height,
  };
}

export async function sized(img: ImageMetadata, width: number) {
  const out = await getImage({ src: img, width: Math.min(width, img.width), format: 'webp', quality: 80 });
  return out.src;
}

// ---------- Colour palettes (used for placeholders and the descent sky) ----------
type Palette = { avg: string; top: string; mid: string; bottom: string };
const rawCache = new Map<string, any>();
const paletteCache = new Map<string, Palette>();

async function rawEntry(loc: Location) {
  if (!rawCache.has(loc.id)) {
    const file = path.resolve(loc.filePath ?? `src/content/locations/${loc.id}/location.yaml`);
    rawCache.set(loc.id, { dir: path.dirname(file), data: parse(await readFile(file, 'utf8')) });
  }
  return rawCache.get(loc.id);
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

async function paletteOf(file: string): Promise<Palette> {
  if (paletteCache.has(file)) return paletteCache.get(file)!;
  const { data } = await sharp(file).resize(1, 3, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (i: number) => hex(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
  const avg = hex((data[0] + data[3] + data[6]) / 3, (data[1] + data[4] + data[7]) / 3, (data[2] + data[5] + data[8]) / 3);
  const pal = { avg, top: px(0), mid: px(1), bottom: px(2) };
  paletteCache.set(file, pal);
  return pal;
}

/** Palette of the cover image, or of photo `index`. */
export async function palette(loc: Location, index: number | 'cover' = 'cover'): Promise<Palette> {
  try {
    const { dir, data } = await rawEntry(loc);
    const rel = index === 'cover' ? data.cover : data.photos?.[index]?.file;
    return await paletteOf(path.resolve(dir, rel));
  } catch {
    return { avg: '#0b1518', top: '#0b1518', mid: '#0b1518', bottom: '#0b1518' };
  }
}

/** Compact data the globe needs on the client. */
export async function clientSummary(loc: Location) {
  const pal = await palette(loc);
  return {
    slug: loc.id,
    name: loc.data.name,
    country: loc.data.country,
    region: loc.data.region ?? '',
    lat: loc.data.coordinates.lat,
    lng: loc.data.coordinates.lng,
    description: loc.data.description,
    photos: loc.data.photos.length,
    years: yearsLabel(loc),
    camera: mainCamera(loc),
    lens: mainLens(loc),
    href: locationHref(loc),
    thumb: await sized(loc.data.cover, 640),
    coverPosition: loc.data.coverPosition,
    palette: pal,
  };
}

export type ClientLocation = Awaited<ReturnType<typeof clientSummary>>;
