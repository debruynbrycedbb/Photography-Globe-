#!/usr/bin/env node
/**
 * Add photos to a location (creating the location if it doesn't exist yet).
 *
 *   npm run add-photos -- --location kyoto ~/Desktop/kyoto-export
 *   npm run add-photos -- --location kyoto --name "Kyoto" --country Japan --region Kansai photo1.jpg photo2.jpg
 *
 * What it does for each photo:
 *   - reads the date, camera, lens and exposure settings from EXIF
 *   - resizes it to at most 3000px on the long edge (plenty for the web)
 *   - removes ALL metadata from the copy it saves, including GPS coordinates
 *   - adds an entry to src/content/locations/<location>/location.yaml
 *
 * Your original files are never modified.
 *
 * New locations need --name and --country. Coordinates come from --lat/--lng,
 * or from the first photo's GPS data if it has any (rounded to ~1 km).
 */
import { readdir, stat, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import exifr from 'exifr';
import { parseDocument, YAMLSeq } from 'yaml';

const MAX_EDGE = 3000;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCATIONS = path.join(ROOT, 'src/content/locations');
const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?|heic|heif|avif)$/i;

// Node's argument parser treats "-13.3" as a flag, so join negative numbers
// to their option ("--lat -13.3" → "--lat=-13.3") for southern/western coordinates.
const argv = process.argv.slice(2).reduce((out, a, i, all) => {
  if (/^-\d/.test(a) && /^--(lat|lng)$/.test(all[i - 1] ?? '')) out[out.length - 1] += `=${a}`;
  else out.push(a);
  return out;
}, []);

const { values: opt, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    location: { type: 'string', short: 'l' },
    name: { type: 'string' },
    country: { type: 'string' },
    region: { type: 'string' },
    lat: { type: 'string' },
    lng: { type: 'string' },
    description: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const fail = (msg) => {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
};

if (opt.help || !positionals.length) {
  console.log(`
  Add photos to a location.

    npm run add-photos -- --location <folder-name> [photos or folders...]

  New location? Also pass:  --name "Display name" --country "Country"
  Optional:                 --region "Region"  --lat 35.01 --lng 135.77  --description "..."
`);
  process.exit(opt.help ? 0 : 1);
}

const slugify = (s) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const slug = slugify(opt.location || opt.name || '');
if (!slug) fail('Pass --location <folder-name> (for example --location kyoto).');
if (['gallery', 'about', 'contact', 'textures', 'data'].includes(slug)) fail(`"${slug}" is reserved by the site. Choose another name.`);

// ---------- collect files ----------
async function collect(p) {
  const s = await stat(p).catch(() => null);
  if (!s) fail(`Can't find "${p}".`);
  if (s.isDirectory()) {
    const entries = await readdir(p);
    return (await Promise.all(entries.sort().map((e) => collect(path.join(p, e))))).flat();
  }
  return IMAGE_EXT.test(p) ? [path.resolve(p)] : [];
}
const files = (await Promise.all(positionals.map(collect))).flat();
if (!files.length) fail('No image files found (supported: jpg, png, webp, tiff, heic, avif).');

// ---------- EXIF helpers ----------
const fmtShutter = (t) => (!t ? undefined : t >= 1 ? `${+t.toFixed(1)}s` : `1/${Math.round(1 / t)}`);
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d) =>
  d instanceof Date && !Number.isNaN(+d)
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : undefined;

async function readExif(file) {
  try {
    const x = await exifr.parse(file, { gps: true, tiff: true, exif: true });
    if (!x) return {};
    const make = (x.Make || '').trim();
    const model = (x.Model || '').trim();
    const camera = model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : [make, model].filter(Boolean).join(' ');
    return {
      taken: localStamp(x.DateTimeOriginal || x.CreateDate),
      camera: camera || undefined,
      lens: (x.LensModel || x.Lens || '').trim() || undefined,
      settings: {
        focal: x.FocalLength ? `${Math.round(x.FocalLength)}mm` : undefined,
        aperture: x.FNumber ? `f/${+x.FNumber.toFixed(1)}` : undefined,
        shutter: fmtShutter(x.ExposureTime),
        iso: x.ISO || undefined,
      },
      gps: typeof x.latitude === 'number' ? { lat: x.latitude, lng: x.longitude } : undefined,
    };
  } catch {
    return {};
  }
}

const clean = (o) => {
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const c = clean(v);
    if (c !== undefined && c !== '' && !(typeof c === 'object' && !Object.keys(c).length)) out[k] = c;
  }
  return out;
};

// ---------- location file ----------
const dir = path.join(LOCATIONS, slug);
const yamlPath = path.join(dir, 'location.yaml');
const exists = await access(yamlPath).then(() => true, () => false);
const exifs = await Promise.all(files.map(readExif));

let doc;
if (exists) {
  doc = parseDocument(await readFile(yamlPath, 'utf8'));
} else {
  if (!opt.name || !opt.country) fail(`"${slug}" is a new location. Also pass --name "Display name" and --country "Country".`);
  let lat = opt.lat !== undefined ? Number(opt.lat) : undefined;
  let lng = opt.lng !== undefined ? Number(opt.lng) : undefined;
  if (lat === undefined || lng === undefined) {
    const g = exifs.find((e) => e.gps)?.gps;
    if (!g) fail('No --lat/--lng given and the photos have no GPS data. Find the coordinates (e.g. right-click the place in Google Maps) and pass --lat and --lng.');
    lat = Math.round(g.lat * 100) / 100;
    lng = Math.round(g.lng * 100) / 100;
    console.log(`  Using GPS from the photos for the globe marker: ${lat}, ${lng} (rounded to about 1 km).`);
  }
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) fail('Latitude must be -90…90 and longitude -180…180.');
  await mkdir(dir, { recursive: true });
  doc = parseDocument('');
  doc.contents = doc.createNode(
    clean({
      name: opt.name,
      country: opt.country,
      region: opt.region,
      coordinates: { lat, lng },
      description: opt.description ?? '',
      visits: [],
      cover: '',
      photos: [],
    }),
  );
  doc.set('description', opt.description ?? '');
  doc.set('visits', doc.createNode([]));
  doc.set('photos', new YAMLSeq());
}

if (!doc.get('photos')) doc.set('photos', new YAMLSeq());
const photos = doc.get('photos');
const already = new Set((photos.items || []).map((p) => String(p.get ? p.get('file') : p.file)));

// ---------- copy + register photos ----------
let added = 0;
for (let i = 0; i < files.length; i++) {
  const src = files[i];
  const base = slugify(path.basename(src).replace(IMAGE_EXT, '')) || `photo-${i + 1}`;
  const outName = `${base}.jpg`;
  const rel = `./${outName}`;
  if (already.has(rel)) {
    console.log(`  – ${outName} is already in ${slug}, skipped`);
    continue;
  }
  await sharp(src)
    .rotate() // apply the camera's orientation before metadata is dropped
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(path.join(dir, outName)); // sharp writes no metadata unless asked → GPS is gone
  const e = exifs[i];
  photos.add(
    doc.createNode(
      clean({
        file: rel,
        title: '',
        caption: '',
        taken: e.taken,
        camera: e.camera,
        lens: e.lens,
        settings: e.settings,
      }),
    ),
  );
  console.log(`  ✓ ${outName}${e.taken ? `  (${e.taken.slice(0, 10)})` : ''}`);
  added++;
}

if (!doc.get('cover') && photos.items.length) {
  doc.set('cover', photos.items[0].get('file'));
}

await writeFile(yamlPath, doc.toString({ lineWidth: 0 }));
console.log(`
  Added ${added} photo${added === 1 ? '' : 's'} to ${path.relative(ROOT, yamlPath)}
  Next: open that file to add titles and captions, then run "npm run dev" to preview.
`);
