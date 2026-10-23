// Generates the globe's map data from public-domain sources.
// Run with `npm run textures`. Outputs are committed, so you only need to
// re-run this if you want to change the globe's base map.
//
// Sources:
//   - Natural Earth (via the world-atlas package) — public domain.
//   - NASA Blue Marble / Black Marble / topography (via the three-globe package) — public domain.
//
// Outputs (public/textures and public/data):
//   globe-mask-{4096,2048}.png    R = land mask, G = soft coastal glow
//   globe-detail-{4096,2048}.jpg  R = relief, G = city lights, B = surface brightness
//   borders.bin / coast.bin / graticule.bin   line geometry (lat/lng, int16 x 100)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { geoEquirectangular, geoPath, geoInterpolate, geoDistance } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import sharp from 'sharp';

const root = new URL('..', import.meta.url);
const p = (rel) => new URL(rel, root);

await mkdir(p('public/textures'), { recursive: true });
await mkdir(p('public/data'), { recursive: true });

const countries = JSON.parse(await readFile(p('node_modules/world-atlas/countries-50m.json'), 'utf8'));
const land = feature(countries, countries.objects.land ?? countries.objects.countries);

// ---------- Land mask + coastal glow ----------
async function renderMask(width) {
  const height = width / 2;
  const projection = geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2])
    .precision(0.1);
  const d = geoPath(projection)(land);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#000"/>
    <path d="${d}" fill="#fff" fill-rule="evenodd"/>
  </svg>`;
  const maskRaw = await sharp(Buffer.from(svg)).flatten({ background: '#000' }).greyscale().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const maskPng = await sharp(maskRaw.data, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const glow = await sharp(maskPng).blur(width / 500).extractChannel(0).raw().toBuffer();
  const blank = Buffer.alloc(width * height, 0);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = maskRaw.data[i];
    rgb[i * 3 + 1] = glow[i];
    rgb[i * 3 + 2] = blank[i];
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, palette: false })
    .toFile(new URL(`public/textures/globe-mask-${width}.png`, root).pathname);
}

// ---------- Relief / lights / brightness packed into one texture ----------
async function renderDetail(width) {
  const height = width / 2;
  const img = (f) => p(`node_modules/three-globe/example/img/${f}`).pathname;
  const toGrey = (f) =>
    sharp(img(f)).resize(width, height, { kernel: 'lanczos3' }).greyscale().extractChannel(0).raw().toBuffer();
  const [relief, lights, surface] = await Promise.all([
    toGrey('earth-topology.png'),
    toGrey('earth-night.jpg'),
    toGrey('earth-blue-marble.jpg'),
  ]);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = relief[i];
    rgb[i * 3 + 1] = lights[i];
    rgb[i * 3 + 2] = surface[i];
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 84, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(new URL(`public/textures/globe-detail-${width}.jpg`, root).pathname);
}

// ---------- Line geometry ----------
// Long segments are resampled along great circles so lines hug the sphere.
function resample(line, maxStepRad = (0.6 * Math.PI) / 180) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const dist = geoDistance(a, b);
    const steps = Math.ceil(dist / maxStepRad);
    if (steps > 1) {
      const interp = geoInterpolate(a, b);
      for (let s = 1; s < steps; s++) out.push(interp(s / steps));
    }
    out.push(b);
  }
  return out;
}

async function writeLines(name, multiLine) {
  const lines = multiLine.coordinates.map((l) => resample(l)).filter((l) => l.length > 1);
  const total = lines.reduce((n, l) => n + l.length, 0);
  const header = new Uint32Array(1 + lines.length);
  header[0] = lines.length;
  lines.forEach((l, i) => (header[i + 1] = l.length));
  const pts = new Int16Array(total * 2);
  let k = 0;
  for (const l of lines) {
    for (const [lng, lat] of l) {
      pts[k++] = Math.round(lng * 100);
      pts[k++] = Math.round(lat * 100);
    }
  }
  const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(pts.buffer)]);
  await writeFile(p(`public/data/${name}.bin`), buf);
  console.log(`${name}.bin: ${lines.length} lines, ${total} points, ${(buf.length / 1024).toFixed(0)} KB`);
}

const borders = mesh(countries, countries.objects.countries, (a, b) => a !== b);
const coast = mesh(countries, countries.objects.land ?? countries.objects.countries, (a, b) => a === b);

await Promise.all([
  renderMask(4096),
  renderMask(2048),
  renderDetail(4096),
  renderDetail(2048),
  writeLines('borders', borders),
  writeLines('coast', coast),
]);
console.log('Globe textures written.');
