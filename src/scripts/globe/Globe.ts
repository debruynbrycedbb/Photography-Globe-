import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Group,
  LineLoop,
  LineSegments,
  LinearMipmapLinearFilter,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { DEG, angleDelta, clamp, graticule, latLngToVec3, lerp, loadLines } from './geo';
import * as S from './shaders';

export interface GlobePoint {
  slug: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
}

export interface GlobeOptions {
  base: string;
  reducedMotion: boolean;
  onHover?: (index: number | null, x: number, y: number) => void;
  onPick?: (index: number) => void;
  onActivate?: (index: number) => void;
  onInteract?: () => void;
}

const ACCENT = hexVec('#3ef0b1');
const ATMOS = hexVec('#37d6c4');

function hexVec(h: string): Vector3 {
  const n = parseInt(h.slice(1), 16);
  return new Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Everything the transition timeline is allowed to animate. */
export interface GlobeView {
  lat: number;
  lng: number;
  zoom: number;
  /** 0 = in orbit, 1 = at the surface. Altitude is interpolated exponentially. */
  descend: number;
  /** 1 = globe sits where the layout wants it, 0 = location centred on screen. */
  layout: number;
  fov: number;
  intro: number;
  atmosphere: number;
}

export interface CloudState {
  opacity: number;
  travel: number;
  tint: Vector3;
}

export class Globe {
  readonly view: GlobeView = { lat: 28, lng: 12, zoom: 1, descend: 0, layout: 1, fov: 35, intro: 0, atmosphere: 1 };
  readonly clouds: CloudState = { opacity: 0, travel: 0, tint: new Vector3(0.8, 0.85, 0.9) };
  interactive = true;
  selected = -1;
  hovered = -1;
  points: GlobePoint[] = [];

  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(35, 1, 0.01, 400);
  private cloudScene = new Scene();
  private cloudCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private earthMat!: ShaderMaterial;
  private atmosMat!: ShaderMaterial;
  private markerMat!: ShaderMaterial;
  private markerGeo = new BufferGeometry();
  private markerPos: Vector3[] = [];
  private starMat!: ShaderMaterial;
  private cloudMat!: ShaderMaterial;
  private orbit = new Group();
  private orbitDots!: Points;
  private lineMats: ShaderMaterial[] = [];
  private w = 1;
  private h = 1;
  private baseDist = 5.5;
  private centerY = 0.5;
  private radiusPx = 300;
  private running = false;
  private raf = 0;
  private last = 0;
  private time = 0;
  private idleSince = performance.now();
  private vel = { lat: 0, lng: 0 };
  private tmp = new Vector3();
  private screen: { x: number; y: number; facing: number }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private stage: HTMLElement,
    private opts: GlobeOptions,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
  }

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  async init(points: GlobePoint[]): Promise<void> {
    const big = this.renderer.capabilities.maxTextureSize >= 8192 && !matchMedia('(pointer: coarse)').matches;
    const size = big ? 4096 : 2048;
    const loader = new TextureLoader();
    const load = (url: string) =>
      new Promise<Texture>((res, rej) =>
        loader.load(
          url,
          (t) => {
            t.colorSpace = NoColorSpace;
            t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
            t.minFilter = LinearMipmapLinearFilter;
            res(t);
          },
          undefined,
          rej,
        ),
      );

    const [mask, detail, borders, coast] = await Promise.all([
      load(`${this.opts.base}textures/globe-mask-${size}.png`),
      load(`${this.opts.base}textures/globe-detail-${size}.jpg`),
      loadLines(`${this.opts.base}data/borders.bin`, 1.0015),
      loadLines(`${this.opts.base}data/coast.bin`, 1.0018),
    ]);

    this.buildEarth(mask, detail, size);
    this.buildLines(borders, coast);
    this.buildStars();
    this.buildOrbit();
    this.buildClouds();
    this.setPoints(points);
    this.bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.renderer.compile(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ scene

  private buildEarth(mask: Texture, detail: Texture, size: number) {
    this.earthMat = new ShaderMaterial({
      vertexShader: S.earthVertex,
      fragmentShader: S.earthFragment,
      uniforms: {
        uMask: { value: mask },
        uDetail: { value: detail },
        uTexel: { value: [1.5 / size, 1.5 / (size / 2)] },
        uLightDir: { value: new Vector3(-0.5, 0.6, 0.6).normalize() },
        uAccent: { value: ACCENT },
        uIntro: { value: 0 },
      },
    });
    const earth = new Mesh(new SphereGeometry(1, 192, 128), this.earthMat);
    this.scene.add(earth);

    this.atmosMat = new ShaderMaterial({
      vertexShader: S.atmosphereVertex,
      fragmentShader: S.atmosphereFragment,
      uniforms: { uColor: { value: ATMOS }, uStrength: { value: 0 } },
      side: BackSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.scene.add(new Mesh(new SphereGeometry(1.1, 96, 64), this.atmosMat));
  }

  private lineMaterial(opacity: number, color = ACCENT) {
    const m = new ShaderMaterial({
      vertexShader: S.lineVertex,
      fragmentShader: S.lineFragment,
      uniforms: { uColor: { value: color }, uOpacity: { value: opacity } },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    (m as any).baseOpacity = opacity;
    this.lineMats.push(m);
    return m;
  }

  private buildLines(borders: Float32Array, coast: Float32Array) {
    const seg = (arr: Float32Array, mat: ShaderMaterial) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(arr, 3));
      const l = new LineSegments(g, mat);
      l.frustumCulled = false;
      this.scene.add(l);
    };
    seg(graticule(1.001), this.lineMaterial(0.05));
    seg(borders, this.lineMaterial(0.32));
    seg(coast, this.lineMaterial(0.62));
  }

  private buildStars() {
    const n = 5200;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const seed = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const v = new Vector3();
    // A faint band of extra stars along a tilted great circle (a hint of the Milky Way).
    const bandN = new Vector3(0.3, 0.85, 0.42).normalize();
    for (let i = 0; i < n; i++) {
      if (i < n * 0.35) {
        const a = Math.random() * Math.PI * 2;
        const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 0.18;
        const t1 = new Vector3(1, 0, 0).cross(bandN).normalize();
        const t2 = bandN.clone().cross(t1);
        v.copy(t1).multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a)).addScaledVector(bandN, spread).normalize();
      } else {
        v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
        if (v.lengthSq() > 1 || v.lengthSq() < 0.01) { i--; continue; }
        v.normalize();
      }
      v.multiplyScalar(120);
      pos.set([v.x, v.y, v.z], i * 3);
      const r = Math.random();
      size[i] = 0.7 + Math.pow(r, 7) * 3.4;
      seed[i] = Math.random();
      const t = Math.random();
      const c = t < 0.15 ? [0.75, 0.85, 1.0] : t < 0.25 ? [1.0, 0.9, 0.78] : [0.88, 0.92, 0.95];
      const b = 0.35 + Math.pow(Math.random(), 2.2) * 0.65;
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.setAttribute('aSeed', new BufferAttribute(seed, 1));
    g.setAttribute('aColor', new BufferAttribute(col, 3));
    this.starMat = new ShaderMaterial({
      vertexShader: S.starVertex,
      fragmentShader: S.starFragment,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const stars = new Points(g, this.starMat);
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  /** Decorative orbit ring. It is attached to the camera so it always frames the globe the same way. */
  private buildOrbit() {
    const n = 360;
    const pos = new Float32Array(n * 3);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pos.set([Math.cos(a) * 1.5, Math.sin(a) * 1.5, 0], i * 3);
      t[i] = i / n;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aT', new BufferAttribute(t, 1));
    const mat = new ShaderMaterial({
      vertexShader: S.ringVertex,
      fragmentShader: S.ringFragment,
      uniforms: { uColor: { value: ACCENT }, uOpacity: { value: 0.5 } },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    (mat as any).baseOpacity = 0.5;
    this.lineMats.push(mat);
    const ring = new LineLoop(g, mat);
    ring.rotation.set(1.22, 0.0, -0.32);
    ring.frustumCulled = false;
    const dotsGeo = new BufferGeometry();
    dotsGeo.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    dotsGeo.setAttribute('aIndex', new BufferAttribute(new Float32Array([100, 101]), 1));
    this.orbitDots = new Points(dotsGeo, this.makeMarkerMaterial(5.5));
    this.orbitDots.rotation.copy(ring.rotation);
    this.orbitDots.frustumCulled = false;
    this.orbit.add(ring, this.orbitDots);
    this.scene.add(this.orbit);
  }

  private makeMarkerMaterial(size: number) {
    return new ShaderMaterial({
      vertexShader: S.markerVertex,
      fragmentShader: S.markerFragment,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uSize: { value: size },
        uSelected: { value: -1 },
        uHover: { value: -1 },
        uVisible: { value: 1 },
        uColor: { value: ACCENT },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
  }

  private buildClouds() {
    this.cloudMat = new ShaderMaterial({
      vertexShader: S.cloudVertex,
      fragmentShader: S.cloudFragment,
      uniforms: {
        uTravel: { value: 0 },
        uOpacity: { value: 0 },
        uAspect: { value: 1 },
        uTint: { value: this.clouds.tint },
        uTime: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.cloudMat);
    quad.frustumCulled = false;
    this.cloudScene.add(quad);
  }

  setPoints(points: GlobePoint[]) {
    this.points = points;
    this.markerPos = points.map((p) => latLngToVec3(p.lat, p.lng, 1.008));
    const pos = new Float32Array(points.length * 3);
    const idx = new Float32Array(points.length);
    this.markerPos.forEach((v, i) => {
      pos.set([v.x, v.y, v.z], i * 3);
      idx[i] = i;
    });
    this.markerGeo.setAttribute('position', new BufferAttribute(pos, 3));
    this.markerGeo.setAttribute('aIndex', new BufferAttribute(idx, 1));
    if (!this.markerMat) {
      this.markerMat = this.makeMarkerMaterial(12);
      const m = new Points(this.markerGeo, this.markerMat);
      m.frustumCulled = false;
      m.renderOrder = 2;
      this.scene.add(m);
    }
    this.screen = points.map(() => ({ x: 0, y: 0, facing: 0 }));
  }

  // ------------------------------------------------------------------ layout

  /** Camera distance that keeps the globe the size the layout asks for. */
  orbitDistance(): number {
    return this.baseDist * this.view.zoom;
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    const coarse = matchMedia('(pointer: coarse)').matches;
    const pr = Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;

    // Desired on-screen globe radius and vertical centre (matches the CSS layout).
    const wide = this.w >= 900;
    const radius = wide
      ? Math.min(0.285 * this.h, (this.w < 1180 ? 0.168 : 0.2) * this.w)
      : Math.min(0.39 * this.w, 0.25 * this.h);
    this.centerY = wide ? 0.386 : 0.43;
    this.radiusPx = radius;
    const tanHalf = Math.tan((35 * DEG) / 2);
    const alpha = Math.atan((radius / (this.h / 2)) * tanHalf);
    this.baseDist = 1 / Math.sin(alpha);

    [this.markerMat, this.starMat, this.orbitDots.material as ShaderMaterial].forEach(
      (m) => (m.uniforms.uPixelRatio.value = pr),
    );
    this.cloudMat.uniforms.uAspect.value = this.w / this.h;
    if (!this.running) this.renderFrame();
  }

  private updateCamera() {
    const v = this.view;
    const orbitAlt = this.orbitDistance() - 1;
    const nearAlt = 0.012;
    const alt = orbitAlt * Math.pow(nearAlt / orbitAlt, clamp(v.descend, 0, 1));
    latLngToVec3(v.lat, v.lng, 1 + alt, this.camera.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.fov = v.fov;
    const offset = (this.h / 2 - this.centerY * this.h) * v.layout;
    this.camera.setViewOffset(this.w, this.h, 0, offset, this.w, this.h);
    this.camera.updateProjectionMatrix();
    this.orbit.position.set(0, 0, 0);
    this.orbit.quaternion.copy(this.camera.quaternion);
  }

  // ------------------------------------------------------------------ loop

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt, now);
      this.renderFrame();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private step(dt: number, now: number) {
    this.time += dt;
    const v = this.view;
    if (this.interactive && !this.dragging) {
      // Inertia
      v.lng += this.vel.lng;
      v.lat = clamp(v.lat + this.vel.lat, -75, 75);
      const decay = Math.pow(0.04, dt);
      this.vel.lng *= decay;
      this.vel.lat *= decay;
      // Slow drift when nobody is touching the globe
      if (!this.opts.reducedMotion && now - this.idleSince > 7000 && !this.flying) {
        const ramp = clamp((now - this.idleSince - 7000) / 3000, 0, 1);
        v.lng += 2.2 * dt * ramp;
      }
    }
    v.lng = ((v.lng + 540) % 360) - 180;
  }

  renderFrame() {
    if (!this.earthMat) return;
    this.updateCamera();
    const t = this.time;
    const intro = this.view.intro;
    this.earthMat.uniforms.uIntro.value = 0.15 + 0.85 * intro;
    this.atmosMat.uniforms.uStrength.value = intro * this.view.atmosphere;
    const fadeOrbit = intro * (1 - clamp(this.view.descend * 3, 0, 1));
    for (const m of this.lineMats) m.uniforms.uOpacity.value = (m as any).baseOpacity * intro * (1 - this.view.descend * 0.6);
    this.lineMats[this.lineMats.length - 1].uniforms.uOpacity.value = 0.5 * fadeOrbit;
    this.markerMat.uniforms.uTime.value = t;
    this.markerMat.uniforms.uSelected.value = this.selected;
    this.markerMat.uniforms.uHover.value = this.hovered;
    this.markerMat.uniforms.uVisible.value = fadeOrbit;
    this.starMat.uniforms.uTime.value = t;

    // Orbiting dots on the decorative ring
    const dots = this.orbitDots.geometry.getAttribute('position') as BufferAttribute;
    const a1 = t * 0.12;
    const a2 = t * 0.12 + 2.4;
    dots.setXYZ(0, Math.cos(a1) * 1.5, Math.sin(a1) * 1.5, 0);
    dots.setXYZ(1, Math.cos(a2) * 1.5, Math.sin(a2) * 1.5, 0);
    dots.needsUpdate = true;
    (this.orbitDots.material as ShaderMaterial).uniforms.uVisible.value = fadeOrbit * 0.8;
    (this.orbitDots.material as ShaderMaterial).uniforms.uTime.value = t;

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.clouds.opacity > 0.002) {
      this.cloudMat.uniforms.uOpacity.value = this.clouds.opacity;
      this.cloudMat.uniforms.uTravel.value = this.clouds.travel;
      this.cloudMat.uniforms.uTime.value = t;
      this.renderer.render(this.cloudScene, this.cloudCam);
    }
    this.projectMarkers();
  }

  private projectMarkers() {
    const camDir = this.tmp;
    for (let i = 0; i < this.markerPos.length; i++) {
      const p = this.markerPos[i];
      camDir.copy(this.camera.position).sub(p).normalize();
      const facing = camDir.dot(p) / p.length();
      const s = p.clone().project(this.camera);
      this.screen[i].x = (s.x * 0.5 + 0.5) * this.w;
      this.screen[i].y = (-s.y * 0.5 + 0.5) * this.h;
      this.screen[i].facing = facing;
    }
    this.onFrame?.(this.screen);
  }

  /** Called after every rendered frame with marker screen positions. */
  onFrame?: (screen: { x: number; y: number; facing: number }[]) => void;

  screenOf(i: number) {
    return this.screen[i];
  }

  // ------------------------------------------------------------------ navigation

  private flying = false;

  /** Rotate so that a location sits in the middle of the globe. Returns the target view. */
  targetFor(i: number) {
    const p = this.points[i];
    // Aim slightly south of the point so the marker sits in the upper-middle of the disc, like the layout.
    return { lat: clamp(p.lat - 8, -70, 70), lng: this.view.lng + angleDelta(this.view.lng, p.lng) };
  }

  markIdle() {
    this.idleSince = performance.now();
  }

  setFlying(v: boolean) {
    this.flying = v;
    if (!v) this.markIdle();
  }

  /** Stop any drift or inertia (before an animated flight). */
  halt() {
    this.vel.lat = this.vel.lng = 0;
    this.dragging = false;
    this.pointers.clear();
  }

  nudge(dLat: number, dLng: number) {
    this.vel.lat += dLat;
    this.vel.lng += dLng;
    this.markIdle();
    this.opts.onInteract?.();
  }

  zoomBy(factor: number) {
    this.view.zoom = clamp(this.view.zoom * factor, 0.62, 1.55);
    this.markIdle();
  }

  // ------------------------------------------------------------------ input

  private dragging = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private down = { x: 0, y: 0, t: 0, moved: 0 };
  private pinchStart = 0;
  private zoomStart = 1;
  private lastMove = { x: 0, y: 0, t: 0 };

  private pick(x: number, y: number): number {
    let best = -1;
    let bestD = 22 * 22;
    this.screen.forEach((s, i) => {
      if (s.facing < 0.15) return;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    // The selected location has arrows around it; treat that whole area as its tap target.
    const sel = this.screen[this.selected];
    if (best < 0 && sel && sel.facing >= 0.15 && (sel.x - x) ** 2 + (sel.y - y) ** 2 < 46 * 46) best = this.selected;
    return best;
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindInput() {
    const el = this.stage;
    el.addEventListener('pointerdown', (e) => {
      if (!this.interactive) return;
      const { x, y } = this.local(e);
      this.pointers.set(e.pointerId, { x, y });
      el.setPointerCapture(e.pointerId);
      if (this.pointers.size === 1) {
        this.dragging = true;
        this.down = { x, y, t: performance.now(), moved: 0 };
        this.lastMove = { x, y, t: performance.now() };
        this.vel.lat = this.vel.lng = 0;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomStart = this.view.zoom;
      }
      this.markIdle();
      this.opts.onInteract?.();
    });

    el.addEventListener('pointermove', (e) => {
      const { x, y } = this.local(e);
      if (!this.interactive) return;
      if (!this.pointers.has(e.pointerId)) {
        // Hover
        if (e.pointerType === 'mouse') {
          const i = this.pick(x, y);
          if (i !== this.hovered) {
            this.hovered = i;
            el.style.cursor = i >= 0 ? 'pointer' : '';
          }
          this.opts.onHover?.(i >= 0 ? i : null, x, y);
        }
        return;
      }
      const prev = this.pointers.get(e.pointerId)!;
      this.pointers.set(e.pointerId, { x, y });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchStart > 0) this.view.zoom = clamp(this.zoomStart * (this.pinchStart / d), 0.62, 1.55);
        this.down.moved = 999;
        return;
      }
      const dx = x - prev.x;
      const dy = y - prev.y;
      this.down.moved += Math.abs(dx) + Math.abs(dy);
      // Rotate so the surface follows the pointer.
      const degPerPx = (57.3 / this.radiusPx) * this.view.zoom * 0.9;
      this.view.lng -= dx * degPerPx;
      this.view.lat = clamp(this.view.lat + dy * degPerPx, -75, 75);
      const now = performance.now();
      const dt = Math.max(1, now - this.lastMove.t);
      this.vel.lng = (-dx * degPerPx * 16) / dt;
      this.vel.lat = (dy * degPerPx * 16) / dt;
      this.lastMove = { x, y, t: now };
      if (this.hovered !== -1) {
        this.hovered = -1;
        this.opts.onHover?.(null, x, y);
      }
      this.markIdle();
    });

    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      const { x, y } = this.local(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        this.dragging = false;
        if (performance.now() - this.lastMove.t > 80) this.vel.lat = this.vel.lng = 0;
        const quick = performance.now() - this.down.t < 500;
        if (this.down.moved < 8 && quick && this.interactive && e.type === 'pointerup') {
          const i = this.pick(x, y);
          if (i >= 0) {
            if (i === this.selected) this.opts.onActivate?.(i);
            else this.opts.onPick?.(i);
          }
        }
      }
      this.pinchStart = 0;
      this.markIdle();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => {
      if (this.hovered !== -1) {
        this.hovered = -1;
        el.style.cursor = '';
        this.opts.onHover?.(null, 0, 0);
      }
    });

    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.interactive) return;
        e.preventDefault();
        this.zoomBy(Math.exp(e.deltaY * 0.0011));
        this.opts.onInteract?.();
      },
      { passive: false },
    );

    el.addEventListener('keydown', (e) => {
      if (!this.interactive) return;
      const step = 1.4;
      switch (e.key) {
        case 'ArrowLeft': this.nudge(0, -step); break;
        case 'ArrowRight': this.nudge(0, step); break;
        case 'ArrowUp': this.nudge(step, 0); break;
        case 'ArrowDown': this.nudge(-step, 0); break;
        case '+': case '=': this.zoomBy(0.88); break;
        case '-': case '_': this.zoomBy(1.12); break;
        case 'Enter': case ' ':
          if (this.selected >= 0) this.opts.onActivate?.(this.selected);
          break;
        default: return;
      }
      e.preventDefault();
    });

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stop();
      this.stage.dispatchEvent(new CustomEvent('globe:lost', { bubbles: true }));
    });
  }

  lerpView(a: Partial<GlobeView>, b: Partial<GlobeView>, t: number) {
    for (const k of Object.keys(b) as (keyof GlobeView)[]) {
      (this.view as any)[k] = lerp((a as any)[k], (b as any)[k], t);
    }
  }
}
