import gsap from 'gsap';
import { Vector3 } from 'three';
import { Globe, MOON_HOVER } from './globe/Globe';
import { angleDelta, latLngToVec3 } from './globe/geo';
import { Lightbox } from './lightbox';

interface Loc {
  slug: string;
  name: string;
  country: string;
  region: string;
  lat: number;
  lng: number;
  description: string;
  photos: number;
  years: string;
  camera: string;
  lens: string;
  href: string;
  thumb: string;
  palette: { avg: string; top: string; mid: string; bottom: string };
  coverPosition: string;
  body: 'earth' | 'moon';
}

type Mode = 'globe' | 'gallery' | 'travelling';

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  [...root.querySelectorAll(sel)] as T[];

function hexToVec(h: string) {
  const n = parseInt(h.slice(1), 16);
  return new Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function startApp() {
  const root = $('[data-app]');
  if (!root) return;
  const data: Loc[] = JSON.parse($('#locations-data').textContent || '[]');
  if (!data.length) return;

  const base = document.documentElement.dataset.base || '/';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const homeTitle = root.dataset.homeTitle || document.title;

  const stage = $('[data-globe-stage]');
  const canvas = $<HTMLCanvasElement>('[data-globe-canvas]');
  const ring = $('[data-globe-ring]');
  const tip = $('[data-globe-tip]');
  const sky = $('[data-sky]');
  const layer = $('[data-gallery-layer]');
  const announcer = $('[data-announcer]');
  const track = $('[data-strip]');
  const lightbox = new Lightbox($('[data-lightbox]'));

  const initialSlug = root.dataset.initial || '';
  let mode: Mode = initialSlug ? 'gallery' : 'globe';
  let busy = false;
  let queued: (() => void) | null = null;
  const indexOf = (slug: string) => data.findIndex((l) => l.slug === slug);
  const panelCta = $<HTMLAnchorElement>('[data-panel-cta]');
  let selected = Math.max(0, indexOf(initialSlug || panelCta?.dataset.location || data[0].slug));
  /** True while the selected location is centred and waiting for a second tap. */
  let cued = false;
  let current = initialSlug ? indexOf(initialSlug) : -1;
  const isMoon = (i: number) => data[i]?.body === 'moon';
  /** Last Earth location selected, so "Back to Earth" returns to it. */
  let lastEarth = isMoon(selected) ? Math.max(0, data.findIndex((l) => l.body !== 'moon')) : selected;

  // ------------------------------------------------------------ globe
  let globe: Globe | null = null;

  const fallback = () => {
    globe = null;
    root.classList.add('no-webgl');
    $('[data-globe-fallback]').hidden = false;
  };

  if (Globe.supported()) {
    globe = new Globe(canvas, stage, {
      base,
      reducedMotion: reduced,
      onHover: (i) => {
        if (i === null) tip.classList.remove('is-visible');
        else {
          tip.textContent = i === MOON_HOVER ? 'Visit the Moon' : `${data[i].name}, ${data[i].country}`;
          tip.classList.add('is-visible');
        }
      },
      onPick: (i) => select(i),
      onActivate: (i) => enter(i),
      onMoon: () => {
        const m = data.findIndex((l) => l.body === 'moon');
        if (m >= 0) select(m);
      },
      onCluster: (ids) => zoomToCluster(ids),
      onInteract: () => root.classList.add('has-interacted'),
      fitBox: () => {
        const header = document.querySelector('[data-header]')?.getBoundingClientRect();
        const strip = document.querySelector('.strip')?.getBoundingClientRect();
        if (!header || !strip || !strip.height) return null;
        // The middle column under the header is empty, so the globe may rise slightly into it.
        return { top: header.bottom * 0.72, bottom: strip.top - 14 };
      },
    });
    // Labels wrapping differently once the web fonts arrive can change the strip's height.
    document.fonts?.ready.then(() => globe?.resize());
    globe.onFrame = (screen) => {
      const s = screen[selected];
      const up = globe ? Math.max(0, 1 - globe.view.descend * 12) : 0;
      const show = mode !== 'gallery' && !root.classList.contains('is-travelling') && s && s.facing > 0.12;
      ring.style.transform = `translate3d(${s?.x ?? -99}px, ${s?.y ?? -99}px, 0)`;
      ring.style.opacity = show ? String(Math.min(1, (s.facing - 0.12) * 4) * up) : '0';
      // "Tap again" arrows: only once the globe has stopped turning towards the selection.
      ring.classList.toggle('is-cued', !!show && cued && mode === 'globe');
      if (globe && globe.hovered >= 0) {
        const h = screen[globe.hovered];
        tip.style.transform = `translate3d(${h.x}px, ${h.y}px, 0)`;
      } else if (globe && globe.hovered === MOON_HOVER) {
        const m = globe.moonOnScreen();
        tip.style.transform = `translate3d(${m.x}px, ${m.y - m.r + 8}px, 0)`;
      }
    };
    stage.addEventListener('globe:lost', fallback);
    // Append ?debug to the URL to inspect the globe from the browser console as window.__globe.
    if (new URLSearchParams(location.search).has('debug')) (window as any).__globe = globe;

    const boot = () =>
      globe!
        .init(data)
        .then(() => {
          globe!.selected = selected;
          if (mode === 'gallery') {
            // Deep link: park the camera at the surface so the return journey starts from here.
            if (isMoon(current)) {
              // Place the Moon where it normally sits, then put the camera on it.
              globe!.view.intro = 1;
              globe!.freezeMoon();
              globe!.view.body = 1;
              root.classList.add('on-moon');
            }
            const p = globe!.pointLatLng(current);
            Object.assign(globe!.view, { lat: p.lat, lng: p.lng, descend: 1, layout: 0, fov: 52, intro: 1, atmosphere: 2.2 });
            globe!.interactive = false;
            globe!.renderFrame();
          } else {
            const t = globe!.targetFor(selected);
            if (reduced) {
              Object.assign(globe!.view, { lat: t.lat, lng: t.lng, intro: 1 });
              cued = true;
            } else {
              Object.assign(globe!.view, { lat: t.lat + 6, lng: t.lng - 40, zoom: 1.22, intro: 0 });
              gsap.to(globe!.view, {
                lat: t.lat, lng: t.lng, zoom: 1, intro: 1, duration: 2.6, ease: 'power3.out',
                onComplete: () => { cued = true; },
              });
            }
            globe!.start();
          }
          root.classList.add('globe-ready');
        })
        .catch((err) => {
          console.error(err);
          fallback();
        });

    if (mode === 'gallery' && 'requestIdleCallback' in window) (window as any).requestIdleCallback(boot, { timeout: 2500 });
    else boot();
  } else {
    fallback();
  }

  // ------------------------------------------------------------ panel + strip
  const panel = $('[data-panel]');
  function renderPanel(l: Loc) {
    if (!panel) return;
    const set = (sel: string, v: string) => ($(sel, panel).textContent = v || '—');
    const img = $<HTMLImageElement>('[data-panel-img]', panel);
    panel.classList.add('is-swapping');
    window.setTimeout(() => {
      img.src = l.thumb;
      img.style.objectPosition = l.coverPosition;
      set('[data-panel-name]', l.name);
      set('[data-panel-country]', l.country);
      $('[data-panel-desc]', panel).textContent = l.description;
      set('[data-panel-photos]', String(l.photos));
      set('[data-panel-years]', l.years);
      set('[data-panel-camera]', l.camera);
      set('[data-panel-lens]', l.lens);
      for (const a of $$<HTMLAnchorElement>('[data-location]', panel)) {
        a.href = l.href;
        a.dataset.location = l.slug;
      }
      img.decode?.().catch(() => {}).finally(() => panel.classList.remove('is-swapping'));
      if (!img.decode) panel.classList.remove('is-swapping');
    }, reduced ? 0 : 180);
  }

  function select(i: number, { fly = true } = {}) {
    if (i < 0 || i >= data.length) return;
    const changed = i !== selected;
    selected = i;
    for (const b of $$('[data-select]')) b.setAttribute('aria-pressed', String(b.dataset.select === data[i].slug));
    const item = $(`[data-select="${data[i].slug}"]`);
    item?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
    if (changed) {
      renderPanel(data[i]);
      announcer.textContent = `${data[i].name}, ${data[i].country} selected.`;
      prefetch(data[i]);
    }
    if (!isMoon(i)) lastEarth = i;
    if (globe) {
      globe.selected = i;
      if (fly && mode === 'globe') {
        if (isMoon(i) !== globe.onMoon) {
          flyToBody(i);
          return;
        }
        // Zoom in when this location's marker would overlap a neighbour's.
        const zoom = globe.zoomToSeparate(i);
        const t = globe.targetFor(i, zoom);
        globe.halt();
        globe.setFlying(true);
        cued = false;
        gsap.killTweensOf(globe.view, 'lat,lng,zoom');
        gsap.to(globe.view, {
          lat: t.lat,
          lng: t.lng,
          zoom,
          duration: reduced ? 0 : 1.3,
          ease: 'power3.inOut',
          onComplete: () => {
            globe?.setFlying(false);
            cued = true;
          },
        });
      }
    }
  }

  /** Fly the camera between the Earth and the Moon, arriving on location i. */
  function flyToBody(i: number): Promise<void> {
    if (!globe) return Promise.resolve();
    const g = globe;
    const toMoon = isMoon(i);
    g.halt();
    g.setFlying(true);
    g.interactive = false;
    g.hovered = -1;
    tip.classList.remove('is-visible');
    cued = false;
    gsap.killTweensOf(g.view);
    gsap.killTweensOf(g, 'moonLock');
    if (toMoon && g.view.body < 0.01) g.freezeMoon();
    const zoom = toMoon ? 1 : g.zoomToSeparate(i);
    const t = g.targetFor(i, zoom);
    root.classList.toggle('on-moon', toMoon);
    announcer.textContent = toMoon ? 'Travelling to the Moon.' : 'Back to the Earth.';
    return new Promise((done) => {
      const finish = () => {
        g.setFlying(false);
        g.interactive = true;
        cued = true;
        done();
      };
      const dur = reduced ? 0 : 2.4;
      const tl = gsap.timeline({ onComplete: finish });
      tl.to(g.view, { body: toMoon ? 1 : 0, lat: t.lat, lng: t.lng, zoom, duration: dur, ease: 'power2.inOut' }, 0);
      if (!toMoon) tl.to(g, { moonLock: 0, duration: dur, ease: 'power2.inOut' }, 0);
    });
  }

  /** Several markers overlap where the visitor tapped: zoom in until they separate. */
  function zoomToCluster(ids: number[]) {
    if (!globe) return;
    const vs = ids.map((i) => latLngToVec3(data[i].lat, data[i].lng, 1));
    let gap = Math.PI;
    vs.forEach((a, k) => vs.slice(k + 1).forEach((b) => (gap = Math.min(gap, a.angleTo(b)))));
    const c = vs.reduce((s, v) => s.add(v), new Vector3()).normalize();
    const lat = Math.asin(c.y) / (Math.PI / 180);
    const lng = Math.atan2(-c.z, c.x) / (Math.PI / 180);
    const zoom = Math.min(globe.view.zoom, globe.zoomForGap(gap, 44));
    globe.halt();
    globe.setFlying(true);
    gsap.killTweensOf(globe.view, 'lat,lng,zoom');
    gsap.to(globe.view, {
      lat: lat - 6 * zoom,
      lng: globe.view.lng + angleDelta(globe.view.lng, lng),
      zoom,
      duration: reduced ? 0 : 1.2,
      ease: 'power3.inOut',
      onComplete: () => globe?.setFlying(false),
    });
    announcer.textContent = `Zoomed in on ${ids.map((i) => data[i].name).join(', ')}.`;
  }

  $('[data-back-earth]')?.addEventListener('click', () => {
    if (mode === 'globe' && globe?.onMoon) select(lastEarth);
  });

  // Keep the strip's scroll arrows vertically centred on the thumbnails.
  const firstThumb = document.querySelector<HTMLElement>('.strip-thumb');
  const stripEl = document.querySelector<HTMLElement>('.strip');
  if (firstThumb && stripEl) {
    new ResizeObserver(() => stripEl.style.setProperty('--thumb-h', `${firstThumb.offsetHeight}px`)).observe(firstThumb);
  }

  track?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-select]');
    if (!b) return;
    const i = indexOf(b.dataset.select!);
    if (i === selected && mode === 'globe') enter(i);
    else select(i);
  });
  const scrollStrip = (d: number) =>
    track.scrollBy({ left: d * track.clientWidth * 0.75, behavior: reduced ? 'auto' : 'smooth' });
  $('[data-strip-prev]')?.addEventListener('click', () => scrollStrip(-1));
  $('[data-strip-next]')?.addEventListener('click', () => scrollStrip(1));
  $('[data-more]')?.addEventListener('click', () => select((selected + 1) % data.length));

  // ------------------------------------------------------------ gallery loading
  const fragments = new Map<string, Promise<HTMLElement>>();
  function fetchGallery(l: Loc): Promise<HTMLElement> {
    if (!fragments.has(l.slug)) {
      const p = fetch(l.href, { credentials: 'same-origin' })
        .then((r) => {
          if (!r.ok) throw new Error(`Could not load ${l.href} (${r.status})`);
          return r.text();
        })
        .then((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const article = doc.querySelector('[data-gallery]');
          if (!article) throw new Error('Gallery markup missing');
          return document.importNode(article, true) as HTMLElement;
        });
      p.catch(() => fragments.delete(l.slug));
      fragments.set(l.slug, p);
    }
    return fragments.get(l.slug)!;
  }
  function prefetch(l: Loc) {
    const go = () => fetchGallery(l).catch(() => {});
    if ('requestIdleCallback' in window) (window as any).requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 300);
  }

  function heroReady(article: HTMLElement, timeout = 2500): Promise<void> {
    const img = $<HTMLImageElement>('[data-hero-img]', article);
    if (!img) return Promise.resolve();
    const decoded = img.complete ? Promise.resolve() : new Promise<void>((res) => {
      img.addEventListener('load', () => res(), { once: true });
      img.addEventListener('error', () => res(), { once: true });
    });
    return Promise.race([decoded.then(() => img.decode?.().catch(() => {})), new Promise<void>((r) => setTimeout(r, timeout))]) as Promise<void>;
  }

  function setSky(l: Loc) {
    sky.style.setProperty('--sky-top', l.palette.top);
    sky.style.setProperty('--sky-mid', l.palette.mid);
    sky.style.setProperty('--sky-bottom', l.palette.bottom);
    if (globe) globe.clouds.tint.copy(hexToVec(l.palette.mid));
  }

  // ------------------------------------------------------------ journeys
  async function enter(i: number, push = true) {
    if (busy) { queued = () => enter(i, push); return; }
    if (mode !== 'globe') return;
    const l = data[i];
    busy = true;
    mode = 'travelling';
    select(i, { fly: false });
    current = i;
    if (push) history.pushState({ view: 'gallery', slug: l.slug }, '', l.href);
    const fragment = fetchGallery(l);
    root.classList.add('is-travelling');
    tip.classList.remove('is-visible');
    setSky(l);

    let article: HTMLElement;
    try {
      if (globe) {
        if (isMoon(i) !== globe.onMoon) {
          globe.start();
          await flyToBody(i);
        }
        globe.interactive = false;
        globe.halt();
        globe.hovered = -1;
        gsap.killTweensOf(globe.view);
        globe.start();
      }
      // Insert the gallery (hidden) as soon as it arrives so the hero image starts loading mid-flight.
      const insert = fragment.then((a) => {
        layer.replaceChildren(a);
        a.classList.add('is-arriving');
        return a;
      });

      if (globe && !reduced) {
        const v = globe.view;
        const p = globe.pointLatLng(i);
        const lng = v.lng + angleDelta(v.lng, p.lng);
        const tl = gsap.timeline();
        tl.to(v, { lat: p.lat, lng, layout: 0, zoom: Math.min(v.zoom, 1), duration: 1.25, ease: 'power2.inOut' }, 0)
          .to(v, { descend: 0.42, duration: 1.25, ease: 'power1.in' }, 0)
          .to(v, { descend: 1, fov: 52, duration: 1.15, ease: 'power2.in' }, 1.25)
          .to(v, { atmosphere: 2.2, duration: 1.0, ease: 'none' }, 1.0)
          .to(globe.clouds, { opacity: 1, duration: 0.55, ease: 'power1.in' }, 1.75)
          .fromTo(globe.clouds, { travel: 0 }, { travel: 1.6, duration: 2.6, ease: 'none' }, 1.65)
          .to(sky, { opacity: 1, duration: 0.5, ease: 'power1.inOut' }, 2.2);
        await Promise.all([new Promise((r) => tl.call(r as any, undefined, 2.75)), insert]);
      } else {
        sky.style.opacity = '1';
        await insert;
      }

      article = await insert;
      await heroReady(article);
    } catch (err) {
      console.error(err);
      window.location.href = l.href; // Fall back to a normal page load
      return;
    }

    document.title = article.dataset.title || homeTitle;
    layer.scrollTop = 0;
    root.classList.add('is-gallery');
    article.classList.remove('is-arriving');
    const media = $('[data-hero-media]', article);
    const text = $('[data-hero-text]', article);
    const extras = $$('.back-link, .scroll-cue', article);

    if (reduced) {
      gsap.fromTo(article, { opacity: 0 }, { opacity: 1, duration: 0.35 });
    } else {
      const tl = gsap.timeline();
      tl.fromTo(media, { opacity: 0, scale: 1.12, filter: 'blur(26px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 1.15, ease: 'power2.out', clearProps: 'filter,transform' }, 0)
        .to(globe ? globe.clouds : {}, { opacity: 0, duration: 0.8, ease: 'power1.out' }, 0.05)
        .fromTo(text, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', clearProps: 'transform' }, 0.5)
        .fromTo(extras, { opacity: 0 }, { opacity: 1, duration: 0.6, clearProps: 'opacity' }, 0.85);
      await tl;
    }

    sky.style.opacity = '0';
    if (globe) {
      globe.clouds.opacity = 0;
      globe.stop();
    }
    gsap.killTweensOf(globe?.clouds ?? {});
    root.classList.remove('is-travelling');
    mode = 'gallery';
    busy = false;
    $<HTMLElement>('.back-link', article)?.focus({ preventScroll: true });
    announcer.textContent = `Gallery: ${l.name}, ${l.country}. ${l.photos} photos.`;
    runQueued();
  }

  async function leave(push = true) {
    if (busy) { queued = () => leave(push); return; }
    if (mode !== 'gallery') return;
    busy = true;
    mode = 'travelling';
    root.classList.add('is-travelling');
    lightbox.close();
    const article = $('[data-gallery]', layer);
    const l = data[current] ?? data[selected];
    if (push) history.pushState({ view: 'globe' }, '', base);
    setSky(l);

    // If the visitor scrolled down, bring the hero back first.
    if (layer.scrollTop > 4) {
      if (reduced) layer.scrollTop = 0;
      else {
        await gsap.to(article, { opacity: 0, duration: 0.25 });
        layer.scrollTop = 0;
        gsap.set(article, { opacity: 1 });
      }
    }
    document.title = homeTitle;

    if (globe) {
      gsap.killTweensOf(globe.view);
      globe.start();
    }

    if (reduced || !globe) {
      await gsap.to(article, { opacity: 0, duration: reduced ? 0.3 : 0.5 });
      root.classList.remove('is-gallery', 'is-travelling');
      if (globe) Object.assign(globe.view, { descend: 0, layout: 1, fov: 35, atmosphere: 1 });
    } else {
      const v = globe.view;
      const media = $('[data-hero-media]', article);
      sky.style.opacity = '1';
      Object.assign(globe.clouds, { opacity: 0, travel: 1.6 });
      const tl = gsap.timeline();
      tl.to($$('[data-hero-text], .back-link, .scroll-cue', article), { opacity: 0, y: -10, duration: 0.35, ease: 'power1.in' }, 0)
        .to(media, { opacity: 0, scale: 1.06, filter: 'blur(22px)', duration: 0.6, ease: 'power2.in' }, 0)
        .to(globe.clouds, { opacity: 1, duration: 0.35, ease: 'power1.out' }, 0.25)
        .call(() => root.classList.remove('is-gallery'), undefined, 0.55)
        .to(sky, { opacity: 0, duration: 0.45 }, 0.5)
        .to(globe.clouds, { travel: 0.75, duration: 1.1, ease: 'power1.out' }, 0.3)
        .to(globe.clouds, { opacity: 0, duration: 0.55, ease: 'power1.in' }, 0.8)
        .to(v, { descend: 0, fov: 35, atmosphere: 1, duration: 1.7, ease: 'power3.out' }, 0.55)
        .to(v, { layout: 1, duration: 1.4, ease: 'power2.inOut' }, 0.8)
        .to(v, { lat: globe.targetFor(selected).lat, duration: 1.4, ease: 'power2.inOut' }, 0.8)
        .call(() => root.classList.remove('is-travelling'), undefined, 1.35);
      await tl;
    }

    layer.replaceChildren();
    sky.style.opacity = '0';
    if (globe) {
      globe.clouds.opacity = 0;
      globe.interactive = true;
      globe.setFlying(false);
    }
    cued = true;
    current = -1;
    mode = 'globe';
    busy = false;
    stage.focus({ preventScroll: true });
    announcer.textContent = 'Back to the globe.';
    runQueued();
  }

  async function hop(i: number, push = true) {
    await leave(false);
    await enter(i, push);
  }

  function runQueued() {
    const q = queued;
    queued = null;
    q?.();
  }

  // ------------------------------------------------------------ links + history
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target as HTMLElement;

    const loc = t.closest<HTMLAnchorElement>('a[data-location]');
    if (loc) {
      const i = indexOf(loc.dataset.location!);
      if (i < 0) return;
      e.preventDefault();
      if (mode === 'gallery') hop(i);
      else enter(i);
      return;
    }

    const back = t.closest('a[data-back], a[data-nav-home]');
    if (back && (mode === 'gallery' || mode === 'travelling')) {
      e.preventDefault();
      leave();
      return;
    }
    if (back && mode === 'globe' && back.matches('[data-nav-home]')) {
      e.preventDefault();
      document.body.classList.remove('menu-open');
      $('[data-menu-toggle]')?.setAttribute('aria-expanded', 'false');
      return;
    }

    const cue = t.closest<HTMLAnchorElement>('[data-scroll-cue]');
    if (cue) {
      e.preventDefault();
      const target = $(cue.getAttribute('href')!);
      target?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      return;
    }

    const photo = t.closest<HTMLButtonElement>('.g-open');
    if (photo) {
      const items = $$<HTMLButtonElement>('.g-open', photo.closest('[data-gallery]')!);
      lightbox.open(items, items.indexOf(photo));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'gallery' && !lightbox.isOpen) leave();
  });

  history.replaceState(initialSlug ? { view: 'gallery', slug: initialSlug } : { view: 'globe' }, '');
  window.addEventListener('popstate', (e) => {
    const s = e.state as { view?: string; slug?: string } | null;
    if (s?.view === 'gallery' && s.slug) {
      const i = indexOf(s.slug);
      if (i < 0) return;
      if (mode === 'gallery' && current !== i) hop(i, false);
      else enter(i, false);
    } else {
      leave(false);
    }
  });

  // Prefetch the featured gallery so the first journey starts instantly.
  if (mode === 'globe') prefetch(data[selected]);
}
