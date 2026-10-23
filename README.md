# Photography Globe

A photography portfolio built around an interactive 3D Earth. Visitors rotate the globe, pick a location, and fly down through the clouds into that location's gallery.

- **Framework:** [Astro](https://astro.build) (static site, works on GitHub Pages)
- **3D:** [Three.js](https://threejs.org) with custom shaders
- **Animation:** [GSAP](https://gsap.com)
- **Cost:** free. No API keys. The only outside service is the free, public ISS orbit data (see below).

> **Original photos:** keep your full-size originals in `Photos for Globe/` (or anywhere else). That folder is excluded from Git; only the resized, metadata-free copies in `src/content/locations/` are published.

---

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev        # http://localhost:4321, with live reload
```

```bash
npm run build      # builds the site into dist/
npm run preview    # serves dist/ locally to check the real build
```

---

## Adding photos

Each location is a folder inside `src/content/locations/`:

```
src/content/locations/kyoto/
  location.yaml      ← name, country, coordinates, captions
  fushimi-dawn.jpg
  gion-rain.jpg
```

### The easy way: the import script

Export your edited photos as JPEGs (any size; 2,500–4,000 px on the long edge is ideal). Then:

```bash
# New location (coordinates come from the photos' GPS if they have it)
npm run add-photos -- --location kyoto --name "Kyoto" --country Japan --region Kansai ~/Desktop/kyoto-export

# Or with explicit coordinates
npm run add-photos -- --location kyoto --name "Kyoto" --country Japan --lat 35.0116 --lng 135.7681 ~/Desktop/kyoto-export

# More photos for a location that already exists
npm run add-photos -- --location kyoto ~/Desktop/kyoto-day-2
```

The script:

- reads the **date, camera, lens and exposure settings** from each photo's EXIF data and writes them into `location.yaml`
- resizes copies to at most 3,000 px (your originals are never touched)
- **removes all metadata from the copies, including GPS coordinates**, so published photos can't reveal where you were standing
- skips photos that are already in the location

Afterwards, open `location.yaml` and fill in titles and captions.

> **Tip for coordinates:** in Google Maps, right-click a place and click the coordinates at the top of the menu to copy them.

### The manual way

Copy photos into the folder and edit `location.yaml` yourself:

```yaml
name: Kyoto
country: Japan
region: Kansai                       # optional
coordinates: { lat: 35.0116, lng: 135.7681 }
description: One or two sentences shown on the globe panel and at the top of the gallery.
notes: Optional longer note about the trip. # optional
order: 3                             # optional: position in the location strip
visits:                              # optional
  - { from: 2025-04-02, to: 2025-04-06 }
cover: ./fushimi-dawn.jpg            # the photo used for the panel, strip and gallery hero
photos:
  - file: ./fushimi-dawn.jpg
    title: Fushimi Inari at dawn
    caption: Optional sentence.
    alt: Optional description for screen readers (falls back to the title).
    taken: 2025-04-03T06:12:00
    camera: Sony A7 IV
    lens: FE 24-70mm F2.8 GM II
    settings: { focal: 35mm, aperture: f/8, shutter: 1/250, iso: 100 }
    tags: [architecture, morning]
```

The build **checks every location**. If a photo file is missing, a coordinate is out of range or a date is malformed, it stops and tells you which file and field to fix, rather than publishing a broken page.

### Locations on the Moon

A location with `body: moon` sits on the Moon instead of the Earth (see `src/content/locations/moon-and-stars/`). Its `coordinates` are lunar latitude/longitude: `lat: 12, lng: -90` is near the middle of the side that faces visitors. Visitors reach it by clicking the small Moon beside the globe, or from the location strip. Moon locations don't count towards the "countries" total.

The Moon's surface is drawn by `scripts/build-moon-texture.py` (procedural, no third-party imagery). Re-run it only if you want a different surface.

### Choosing a cover and framing it

`cover` picks the photo used for the homepage panel, the location strip and the full-screen gallery opening. Most photos are cropped to fit those spaces, so `coverPosition` sets which part stays visible: `"50% 30%"` keeps more of the top, `"50% 70%"` more of the bottom.

`featuredLocation` in `src/site.config.ts` is the location selected when the homepage first opens.

---

## Editing text

| What | Where |
|---|---|
| Logo letters, byline, headline, intro | `src/site.config.ts` |
| Location shown first on the homepage | `featuredLocation` in `src/site.config.ts` |
| Contact details | `contact` in `src/site.config.ts` |
| About page | `src/pages/about.astro` |
| Colours, fonts, spacing | variables at the top of `src/styles/global.css` |

---

## Publishing on GitHub Pages

1. Create a repository on GitHub and push this project to its `main` branch.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` now builds and publishes the site automatically (the workflow is in `.github/workflows/deploy.yml`). The first build takes a couple of minutes; later builds reuse resized images.

The site is published at **https://bdbphotography.site**. The domain is set in two places: the repo's **Settings → Pages → Custom domain**, and the file `public/CNAME`, which the deploy workflow reads so every link is built for the domain. To go back to the `github.io` address, delete `public/CNAME` and remove the custom domain in Settings.

**Limits to know about** (GitHub's published limits):

- The published site may be at most **1 GB**, and GitHub recommends keeping the repository under 1 GB. Photos at about 3,000 px are roughly 1–2 MB each, so plan on several hundred photos before needing external image storage (Cloudflare R2's free tier is the suggested next step).
- Soft bandwidth limit of **100 GB/month**, which is plenty for a portfolio.

---

## How it works

```
src/
  content/locations/<slug>/   photos + location.yaml (one folder per location)
  content.config.ts           validation rules for location.yaml
  site.config.ts              site text and settings
  pages/
    index.astro               homepage (globe)
    [slug]/index.astro        one page per location (globe + gallery pre-rendered)
    gallery.astro             list of all locations (also the no-3D fallback)
  components/
    GlobeApp.astro            homepage interface, gallery layer, lightbox
    Gallery.astro             a location's gallery
  scripts/
    app.ts                    selection, journeys, history, links
    globe/Globe.ts            Three.js scene, camera, input
    globe/shaders.ts          Earth, atmosphere, markers, stars, clouds
    globe/sun.ts              where the Sun is overhead right now (day and night)
    globe/iss.ts              live ISS position
    lightbox.ts               full-screen photo viewer
scripts/
  add-photos.mjs              photo import (EXIF, resize, strip metadata)
  build-globe-textures.mjs    regenerates the globe map from Natural Earth / NASA data
  dev/generate-sample-photos.py  draws placeholder images for testing (development only)
```

- **Every location has a real page** (`/kyoto/`). Opening it directly shows the gallery straight away. Search engines and people without JavaScript get normal HTML.
- **From the globe, no page reload happens.** The gallery HTML is fetched in the background (usually before the camera has finished flying), the URL updates, and the browser's Back button flies you back up.
- **Images** are resized at build time into several WebP sizes, and each visitor downloads the size their screen needs.
- **Accessibility:** the globe can be rotated with arrow keys, zoomed with + / −, and Enter opens the selected location. Every location is also a button in the strip. Reduced-motion settings replace the flight with a short fade.
- **Fallback:** if a device can't run WebGL, the globe area shows a message and visitors use the location strip or the Gallery page.

### Live features

- **Day and night** follow the real position of the Sun, worked out from the visitor's clock (`src/scripts/globe/sun.ts`), so it's the same for every visitor at the same moment. No location permission is needed. City lights show on the night side.
- **The ISS** is drawn at its real position, with its path for half an orbit either side. Its published orbit is downloaded from [CelesTrak](https://celestrak.org) (backup: [wheretheiss.at](https://wheretheiss.at)), cached in the browser for 12 hours, and the position is calculated on the visitor's device with [satellite.js](https://github.com/shashwatak/satellite-js) (`src/scripts/globe/iss.ts`). Latitude and longitude are exact; its height is drawn 2.5× higher than reality so it doesn't hug the globe. If neither source is reachable, the ISS is simply not shown.
- **Play my journey** visits every Earth location in order of its earliest photo date (or `visits` date), drawing a flight arc for each leg. Any click, drag, scroll or Escape stops it. To change the order, fix the dates in `location.yaml`.

### Map data credits

- Country borders and coastlines: [Natural Earth](https://www.naturalearthdata.com/) (public domain), via the `world-atlas` package.
- Relief, city lights and surface brightness: NASA Blue Marble / Black Marble imagery (public domain), via the `three-globe` package.

To regenerate the globe textures (only needed if you change the map style): `npm run textures`.

### Debugging

Add `?debug` to the URL to expose the globe in the browser console as `window.__globe`.
