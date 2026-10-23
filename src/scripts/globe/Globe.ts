import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineSegments,
  LinearMipmapLinearFilter,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { DEG, angleDelta, clamp, graticule, latLngToVec3, lerp, loadLines, slerpDir } from './geo';
import { subsolarPoint } from './sun';
import { IssTracker, type IssState } from './iss';
import * as S from './shaders';

export interface GlobePoint {
  slug: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  /** Which sphere the point sits on. Moon points use the Moon's own lat/lng. */
  body?: 'earth' | 'moon';
}

/** Marker index used for "the Moon itself" in hover callbacks. */
export const MOON_HOVER = -2;
/** Hover index for the live ISS. */
export const ISS_HOVER = -3;

export interface GlobeOptions {
  base: string;
  reducedMotion: boolean;
  onHover?: (index: number | null, x: number, y: number) => void;
  onPick?: (index: number) => void;
  onActivate?: (index: number) => void;
  onInteract?: () => void;
  /** The small Moon was clicked while looking at the Earth. */
  onMoon?: () => void;
  /** Pointer over (or tap on) the live ISS. */
  onIss?: (over: boolean, x: number, y: number, tapped?: boolean) => void;
  /** Several markers overlap where the visitor tapped; app zooms in to separate them. */
  onCluster?: (indices: number[]) => void;
  /**
   * Free vertical space for the globe on wide screens, in pixels from the top of the
   * stage (between the header and the location strip). The globe is sized and centred
   * to fit inside it, so it is never covered on short screens.
   */
  fitBox?: () => { top: number; bottom: number } | null;
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
  /** 0 = camera frames the Earth, 1 = camera frames the Moon. */
  body: number;
}

/** Fallback; the real limit depends on the screen (see minZoom()). */
export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 1.55;

export interface CloudState {
  opacity: number;
  travel: number;
  tint: Vector3;
}

export class Globe {
  readonly view: GlobeView = { lat: 28, lng: 12, zoom: 1, descend: 0, layout: 1, fov: 35, intro: 0, atmosphere: 1, body: 0 };
  /**
   * 0 = the small Moon follows the camera (always in the same corner of the screen),
   * 1 = the Moon is fixed in space (while the camera flies to or around it).
   */
  moonLock = 0;
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
  private moonGroup = new Group();
  private moonMat!: ShaderMaterial;
  private moonMarkerMat!: ShaderMaterial;
  private moonMarkerGeo = new BufferGeometry();
  private moonIdx: number[] = [];
  /** Where the Moon was frozen in space when the camera set off towards it. */
  private moonFrozen = { pos: new Vector3(), quat: new Quaternion(), scale: 0.2 };
  private moonFollow = { pos: new Vector3(), quat: new Quaternion(), scale: 0.2 };
  private moonScreen = { x: -999, y: -999, r: 0 };
  private center = new Vector3();
  private bodyR = 1;
  private starMat!: ShaderMaterial;
  private cloudMat!: ShaderMaterial;
  private sunDir = new Vector3(1, 0, 0);
  private sunUpdated = -1;
  private iss = new IssTracker();
  private issState: IssState | null = null;
  private issDot!: Points;
  private issTrack!: Line;
  private issTrackMat!: ShaderMaterial;
  private issTrackUpdated = -1;
  private issScreen = { x: -999, y: -999, visible: false };
  /** Journey arcs drawn by playJourney (see addArc). */
  private arcs: { line: Line; n: number }[] = [];
  private arcMat!: ShaderMaterial;
  private arcHead!: Points;
  /** 0–1, fades all journey arcs together. */
  arcOpacity = 1;
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

    const [mask, detail, borders, coast, moonTex] = await Promise.all([
      load(`${this.opts.base}textures/globe-mask-${size}.png`),
      load(`${this.opts.base}textures/globe-detail-${size}.jpg`),
      loadLines(`${this.opts.base}data/borders.bin`, 1.0015),
      loadLines(`${this.opts.base}data/coast.bin`, 1.0018),
      load(`${this.opts.base}textures/moon-2048.jpg`),
    ]);

    this.updateSun();
    this.buildEarth(mask, detail, size);
    this.buildLines(borders, coast);
    this.buildStars();
    this.buildIss();
    this.buildArcs();
    this.buildClouds();
    this.buildMoon(moonTex);
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
        uSunDir: { value: this.sunDir },
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

  /**
   * The live International Space Station: a bright dot at its real position and its
   * path for half an orbit either side. Altitude is drawn 2.5x higher than reality
   * (420 km would hug the globe too closely to see); latitude and longitude are exact.
   */
  private buildIss() {
    this.issTrackMat = new ShaderMaterial({
      vertexShader: S.trackVertex,
      fragmentShader: S.trackFragment,
      uniforms: { uColor: { value: ACCENT }, uOpacity: { value: 0 } },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.issTrack = new Line(new BufferGeometry(), this.issTrackMat);
    this.issTrack.frustumCulled = false;
    this.scene.add(this.issTrack);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
    g.setAttribute('aIndex', new BufferAttribute(new Float32Array([200]), 1));
    const issMat = this.makeMarkerMaterial(8);
    issMat.uniforms.uColor.value = hexVec('#f4f1e8');
    this.issDot = new Points(g, issMat);
    this.issDot.frustumCulled = false;
    this.issDot.renderOrder = 3;
    this.scene.add(this.issDot);
    this.iss.load().then((ok) => {
      if (!ok) console.info('ISS orbit data unavailable; tracker hidden.');
    });
  }

  private static ISS_VIS = 2.5;

  private issVec(s: IssState, out = new Vector3()) {
    return latLngToVec3(s.lat, s.lng, 1 + (s.heightKm / 6371) * Globe.ISS_VIS, out);
  }

  private updateIss(nowMs: number) {
    if (!this.iss.ready) return;
    this.issState = this.iss.at(new Date(nowMs));
    if (!this.issState) return;
    const p = this.issVec(this.issState);
    const attr = this.issDot.geometry.getAttribute('position') as BufferAttribute;
    attr.setXYZ(0, p.x, p.y, p.z);
    attr.needsUpdate = true;
    // Rebuild the path every 20 s: half an orbit behind and ahead (one orbit is ~93 minutes).
    if (nowMs - this.issTrackUpdated > 20000) {
      this.issTrackUpdated = nowMs;
      const n = 160;
      const half = 46.5 * 60000;
      const pos = new Float32Array(n * 3);
      const tt = new Float32Array(n);
      const v = new Vector3();
      for (let k = 0; k < n; k++) {
        const s = this.iss.at(new Date(nowMs - half + (2 * half * k) / (n - 1)));
        if (s) this.issVec(s, v);
        pos.set([v.x, v.y, v.z], k * 3);
        tt[k] = k / (n - 1);
      }
      const geo = this.issTrack.geometry;
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('aT', new BufferAttribute(tt, 1));
    }
  }

  /** Live ISS details for the tooltip (null until the orbit data has loaded). */
  issInfo() {
    return this.issState ? { ...this.issState, screen: this.issScreen } : null;
  }

  private buildArcs() {
    this.arcMat = new ShaderMaterial({
      vertexShader: S.lineVertex,
      fragmentShader: S.lineFragment,
      uniforms: { uColor: { value: ACCENT }, uOpacity: { value: 0.85 } },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
    g.setAttribute('aIndex', new BufferAttribute(new Float32Array([201]), 1));
    this.arcHead = new Points(g, this.makeMarkerMaterial(9));
    this.arcHead.frustumCulled = false;
    this.arcHead.visible = false;
    this.scene.add(this.arcHead);
  }

  /**
   * Draw a flight arc from location a to location b. Returns a function that sets
   * how much of it is drawn (0–1); the glowing head follows the leading end.
   */
  addArc(a: number, b: number): (progress: number) => void {
    const A = latLngToVec3(this.points[a].lat, this.points[a].lng, 1);
    const B = latLngToVec3(this.points[b].lat, this.points[b].lng, 1);
    const ang = A.angleTo(B);
    const h = 0.03 + 0.32 * (ang / Math.PI); // longer flights arc higher
    const n = Math.max(24, Math.ceil(ang * 90));
    const pos = new Float32Array((n + 1) * 3);
    const v = new Vector3();
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      slerpDir(A, B, t, v).normalize().multiplyScalar(1.006 + h * Math.sin(Math.PI * t));
      pos.set([v.x, v.y, v.z], k * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const line = new Line(geo, this.arcMat);
    line.frustumCulled = false;
    line.renderOrder = 1;
    this.scene.add(line);
    this.arcs.push({ line, n });
    const head = this.arcHead.geometry.getAttribute('position') as BufferAttribute;
    return (p: number) => {
      const c = Math.round(clamp(p, 0, 1) * n);
      geo.setDrawRange(0, c + 1);
      head.setXYZ(0, pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
      head.needsUpdate = true;
      this.arcHead.visible = p > 0 && p < 1;
    };
  }

  clearArcs() {
    for (const a of this.arcs) {
      this.scene.remove(a.line);
      a.line.geometry.dispose();
    }
    this.arcs = [];
    this.arcHead.visible = false;
    this.arcOpacity = 1;
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

  private buildMoon(tex: Texture) {
    this.moonMat = new ShaderMaterial({
      vertexShader: S.moonVertex,
      fragmentShader: S.moonFragment,
      uniforms: {
        uMap: { value: tex },
        uTexel: { value: [1.5 / 2048, 1.5 / 1024] },
        uAccent: { value: ACCENT },
        uFade: { value: 0 },
        uHover: { value: 0 },
      },
      transparent: true,
    });
    const moon = new Mesh(new SphereGeometry(1, 96, 64), this.moonMat);
    this.moonGroup.add(moon);
    this.scene.add(this.moonGroup);
  }

  setPoints(points: GlobePoint[]) {
    this.points = points;
    const earth: number[] = [];
    this.moonIdx = [];
    points.forEach((p, i) => (p.body === 'moon' ? this.moonIdx : earth).push(i));
    // Positions: Earth markers in world space, Moon markers in the Moon's local space (radius 1).
    this.markerPos = points.map((p) => latLngToVec3(p.lat, p.lng, 1.008));
    const fill = (geo: BufferGeometry, ids: number[]) => {
      const pos = new Float32Array(ids.length * 3);
      const idx = new Float32Array(ids.length);
      ids.forEach((i, k) => {
        const v = this.markerPos[i];
        pos.set([v.x, v.y, v.z], k * 3);
        idx[k] = i;
      });
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('aIndex', new BufferAttribute(idx, 1));
    };
    fill(this.markerGeo, earth);
    fill(this.moonMarkerGeo, this.moonIdx);
    if (!this.markerMat) {
      this.markerMat = this.makeMarkerMaterial(12);
      const m = new Points(this.markerGeo, this.markerMat);
      m.frustumCulled = false;
      m.renderOrder = 2;
      this.scene.add(m);
      this.moonMarkerMat = this.makeMarkerMaterial(12);
      const mm = new Points(this.moonMarkerGeo, this.moonMarkerMat);
      mm.frustumCulled = false;
      mm.renderOrder = 2;
      this.moonGroup.add(mm);
    }
    this.screen = points.map(() => ({ x: 0, y: 0, facing: 0 }));
  }

  isMoon(i: number) {
    return this.points[i]?.body === 'moon';
  }

  /** Which body the camera is (mostly) looking at. */
  get onMoon() {
    return this.view.body > 0.5;
  }

  // ------------------------------------------------------------------ layout

  /** Camera distance that keeps the globe the size the layout asks for. */
  orbitDistance(): number {
    return this.baseDist * this.view.zoom;
  }

  resize() {
    if (!this.issDot) return; // not set up yet; init() calls resize() when ready
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
    let radius = wide
      ? Math.min(0.285 * this.h, (this.w < 1180 ? 0.168 : 0.2) * this.w)
      : Math.min(0.39 * this.w, 0.25 * this.h);
    this.centerY = wide ? 0.386 : 0.43;
    const box = wide ? this.opts.fitBox?.() : null;
    if (box && box.bottom - box.top > 120) {
      // 1.09 leaves room for the atmosphere glow around the edge.
      radius = Math.min(radius, (box.bottom - box.top) / 2 / 1.09);
      this.centerY = (box.top + box.bottom) / 2 / this.h;
    }
    this.radiusPx = radius;
    const tanHalf = Math.tan((35 * DEG) / 2);
    const alpha = Math.atan((radius / (this.h / 2)) * tanHalf);
    this.baseDist = 1 / Math.sin(alpha);

    [this.markerMat, this.moonMarkerMat, this.starMat, this.issDot.material as ShaderMaterial, this.arcHead.material as ShaderMaterial].forEach(
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
    // Frame whichever body the view is on (blending while flying between them).
    const f = clamp(v.body, 0, 1);
    this.center.set(0, 0, 0).lerp(this.moonFrozen.pos, f);
    this.bodyR = lerp(1, this.moonFrozen.scale, f);
    latLngToVec3(v.lat, v.lng, this.bodyR * (1 + alt), this.camera.position).add(this.center);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.center);
    this.camera.fov = v.fov;
    const offset = (this.h / 2 - this.centerY * this.h) * v.layout;
    this.camera.setViewOffset(this.w, this.h, 0, offset, this.w, this.h);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.placeMoon();
  }

  /**
   * While on the Earth the small Moon is pinned to the same spot of the screen
   * (up and to the right of the globe, behind it) whatever the rotation or zoom.
   */
  private computeMoonFollow() {
    const wide = this.w >= 900;
    const s = wide ? 1.4 : 1.24; // distance from the globe centre, in globe radii (on screen)
    const ang = (wide ? 36 : 33) * DEG;
    const k = wide ? 0.12 : 0.13; // Moon radius relative to the globe's
    const D0 = this.baseDist;
    const tanA = 1 / Math.sqrt(D0 * D0 - 1);
    const D = this.camera.position.length();
    const Dm = Math.max(D, D0) + 3;
    const local = this.tmp.set(s * Math.cos(ang) * Dm * tanA, s * Math.sin(ang) * Dm * tanA, -Dm);
    this.moonFollow.pos.copy(local).applyMatrix4(this.camera.matrixWorld);
    this.moonFollow.quat.copy(this.camera.quaternion);
    this.moonFollow.scale = k * Dm * tanA;
  }

  private placeMoon() {
    this.computeMoonFollow();
    const t = clamp(this.moonLock, 0, 1);
    const g = this.moonGroup;
    g.position.copy(this.moonFollow.pos).lerp(this.moonFrozen.pos, t);
    g.quaternion.copy(this.moonFollow.quat).slerp(this.moonFrozen.quat, t);
    g.scale.setScalar(lerp(this.moonFollow.scale, this.moonFrozen.scale, t));
    g.updateMatrixWorld();
  }

  /** Fix the Moon where it currently is, ready for the camera to fly to it. */
  freezeMoon() {
    this.updateCamera();
    this.moonFrozen.pos.copy(this.moonGroup.position);
    this.moonFrozen.quat.copy(this.moonGroup.quaternion);
    this.moonFrozen.scale = this.moonGroup.scale.x;
    this.moonLock = 1;
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

  /** Point the light at where the Sun really is (refreshed every minute). */
  private updateSun(nowMs = Date.now()) {
    const s = subsolarPoint(new Date(nowMs));
    latLngToVec3(s.lat, s.lng, 1, this.sunDir);
    this.sunUpdated = nowMs;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private step(dt: number, now: number) {
    this.time += dt;
    const wall = Date.now();
    if (wall - this.sunUpdated > 60000) this.updateSun(wall);
    this.updateIss(wall);
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
    const f = clamp(this.view.body, 0, 1);
    // The small Moon fades out when diving to an Earth location; it is the subject when f = 1.
    this.moonMat.uniforms.uFade.value = intro * Math.max(f, 1 - clamp(this.view.descend * 4, 0, 1));
    this.moonMat.uniforms.uHover.value = this.hovered === MOON_HOVER ? 1 : 0;
    this.moonMarkerMat.uniforms.uTime.value = t;
    this.moonMarkerMat.uniforms.uSelected.value = this.selected;
    this.moonMarkerMat.uniforms.uHover.value = this.hovered;
    this.moonMarkerMat.uniforms.uVisible.value = fadeOrbit * clamp((f - 0.6) / 0.4, 0, 1);
    for (const m of this.lineMats) m.uniforms.uOpacity.value = (m as any).baseOpacity * intro * (1 - this.view.descend * 0.6);
    // ISS: fades out when zoomed right in (the camera would be inside its path) and during a descent.
    const issZoom = clamp((this.view.zoom - 0.45) / 0.35, 0, 1) * (this.issState ? 1 : 0);
    this.issTrackMat.uniforms.uOpacity.value = 0.55 * fadeOrbit * issZoom;
    const issMat = this.issDot.material as ShaderMaterial;
    issMat.uniforms.uVisible.value = fadeOrbit * issZoom;
    issMat.uniforms.uTime.value = t;
    issMat.uniforms.uHover.value = this.hovered === ISS_HOVER ? 200 : -1;
    this.arcMat.uniforms.uOpacity.value = 0.85 * this.arcOpacity * fadeOrbit;
    const headMat = this.arcHead.material as ShaderMaterial;
    headMat.uniforms.uVisible.value = fadeOrbit * this.arcOpacity;
    headMat.uniforms.uTime.value = t;
    this.markerMat.uniforms.uTime.value = t;
    this.markerMat.uniforms.uSelected.value = this.selected;
    this.markerMat.uniforms.uHover.value = this.hovered;
    this.markerMat.uniforms.uVisible.value = fadeOrbit * clamp(1 - f / 0.4, 0, 1);
    this.starMat.uniforms.uTime.value = t;

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

  /** World position of marker i (Moon markers move with the Moon). */
  worldPos(i: number, out = new Vector3()) {
    out.copy(this.markerPos[i]);
    if (this.isMoon(i)) this.moonGroup.localToWorld(out);
    return out;
  }

  private projectMarkers() {
    const camDir = new Vector3();
    const p = new Vector3();
    const n = new Vector3();
    for (let i = 0; i < this.markerPos.length; i++) {
      this.worldPos(i, p);
      n.copy(p);
      if (this.isMoon(i)) n.sub(this.moonGroup.position);
      n.normalize();
      camDir.copy(this.camera.position).sub(p).normalize();
      const s = p.clone().project(this.camera);
      this.screen[i].x = (s.x * 0.5 + 0.5) * this.w;
      this.screen[i].y = (-s.y * 0.5 + 0.5) * this.h;
      this.screen[i].facing = camDir.dot(n);
    }
    // The ISS on screen (for its tooltip): hidden when the Earth is in the way.
    if (this.issState) {
      const a = this.issDot.geometry.getAttribute('position') as BufferAttribute;
      p.set(a.getX(0), a.getY(0), a.getZ(0));
      const C = this.camera.position;
      const D = n.copy(p).sub(C);
      const len = D.length();
      D.divideScalar(len);
      const b = C.dot(D);
      const disc = b * b - (C.lengthSq() - 1);
      const hidden = disc > 0 && -b - Math.sqrt(disc) < len;
      const s = p.clone().project(this.camera);
      this.issScreen.x = (s.x * 0.5 + 0.5) * this.w;
      this.issScreen.y = (-s.y * 0.5 + 0.5) * this.h;
      this.issScreen.visible = !hidden && this.view.body < 0.05 && this.view.zoom > 0.6 && this.view.descend < 0.05;
    } else this.issScreen.visible = false;
    // The Moon's own outline on screen (for clicking it).
    const c = this.moonGroup.position.clone().project(this.camera);
    const edge = this.moonGroup.position
      .clone()
      .add(new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(this.moonGroup.scale.x))
      .project(this.camera);
    this.moonScreen.x = (c.x * 0.5 + 0.5) * this.w;
    this.moonScreen.y = (-c.y * 0.5 + 0.5) * this.h;
    this.moonScreen.r = Math.abs(edge.x - c.x) * 0.5 * this.w;
    this.onFrame?.(this.screen);
  }

  /** Screen-space circle of the small Moon (for UI hints). */
  moonOnScreen() {
    return this.moonScreen;
  }

  /** Called after every rendered frame with marker screen positions. */
  onFrame?: (screen: { x: number; y: number; facing: number }[]) => void;

  screenOf(i: number) {
    return this.screen[i];
  }

  // ------------------------------------------------------------------ navigation

  private flying = false;

  /** Rotate so that a location sits in the middle of the globe. Returns the target view. */
  targetFor(i: number, zoom = this.view.zoom) {
    const p = this.pointLatLng(i);
    // Aim slightly south of the point so the marker sits in the upper-middle of the disc, like the layout.
    // The offset shrinks when zoomed in, so close-up markers stay near the middle.
    const off = 8 * clamp(zoom, 0, 1) ** 2;
    return { lat: clamp(p.lat - off, -70, 70), lng: this.view.lng + angleDelta(this.view.lng, p.lng) };
  }

  /** Direction of marker i from the centre of its body, as world lat/lng (what the camera uses). */
  pointLatLng(i: number) {
    const p = this.points[i];
    if (!this.isMoon(i)) return { lat: p.lat, lng: p.lng };
    const d = latLngToVec3(p.lat, p.lng, 1).applyQuaternion(this.moonFrozen.quat);
    return { lat: Math.asin(clamp(d.y, -1, 1)) / DEG, lng: Math.atan2(-d.z, d.x) / DEG };
  }

  /**
   * Zoom level at which marker i is at least `px` pixels from its nearest neighbour
   * on the same body (1 when it is already well separated).
   */
  zoomToSeparate(i: number, px = 40) {
    const mine = this.isMoon(i);
    const a = latLngToVec3(this.points[i].lat, this.points[i].lng, 1);
    let nearest = Infinity;
    this.points.forEach((q, j) => {
      if (j === i || this.isMoon(j) !== mine) return;
      nearest = Math.min(nearest, a.angleTo(latLngToVec3(q.lat, q.lng, 1)));
    });
    if (!isFinite(nearest)) return 1;
    // Already far enough apart at the normal zoom? Then don't zoom at all.
    if (this.zoomForGap(nearest, 10) >= 1) return 1;
    return this.zoomForGap(nearest, px);
  }

  /** Zoom at which an angular gap (radians) on the surface spans about `px` pixels. */
  zoomForGap(gapRad: number, px: number) {
    const D0 = this.baseDist;
    const focal = this.radiusPx * Math.sqrt(D0 * D0 - 1);
    const z = (1 + (focal * gapRad) / px) / D0;
    return clamp(Math.min(1, z), this.minZoom(), 1);
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

  /** Closest the camera may get: about 12% of the Earth's radius above the surface. */
  minZoom() {
    return Math.max(ZOOM_MIN, 1.12 / this.baseDist);
  }

  /** Degrees of rotation per dragged pixel, so the surface stays under the finger at any zoom. */
  private degPerPx() {
    const D0 = this.baseDist;
    const focal = this.radiusPx * Math.sqrt(D0 * D0 - 1);
    return Math.max(0.0005, D0 * this.view.zoom - 1) / (focal * DEG);
  }

  zoomBy(factor: number) {
    this.view.zoom = clamp(this.view.zoom * factor, this.minZoom(), ZOOM_MAX);
    this.markIdle();
  }

  // ------------------------------------------------------------------ input

  private dragging = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private down = { x: 0, y: 0, t: 0, moved: 0 };
  private pinchStart = 0;
  private zoomStart = 1;
  private lastMove = { x: 0, y: 0, t: 0 };

  private pickable(i: number) {
    return this.isMoon(i) === this.onMoon && this.screen[i].facing >= 0.15;
  }

  /** Markers within the tap radius of (x, y), nearest first. */
  private near(x: number, y: number, r = 22) {
    return this.screen
      .map((s, i) => ({ i, d: (s.x - x) ** 2 + (s.y - y) ** 2 }))
      .filter(({ i, d }) => d < r * r && this.pickable(i))
      .sort((a, b) => a.d - b.d)
      .map(({ i }) => i);
  }

  private pick(x: number, y: number): number {
    let best = this.near(x, y)[0] ?? -1;
    // The selected location has arrows around it; treat that whole area as its tap target.
    const sel = this.screen[this.selected];
    if (best < 0 && sel && this.pickable(this.selected) && (sel.x - x) ** 2 + (sel.y - y) ** 2 < 46 * 46) best = this.selected;
    // The live ISS.
    const iss = this.issScreen;
    if (best < 0 && iss.visible && (iss.x - x) ** 2 + (iss.y - y) ** 2 < 16 * 16) best = ISS_HOVER;
    // The small Moon, while looking at the Earth.
    if (best < 0 && !this.onMoon && this.view.body < 0.05) {
      const m = this.moonScreen;
      if ((m.x - x) ** 2 + (m.y - y) ** 2 < (m.r + 12) ** 2) best = MOON_HOVER;
    }
    return best;
  }

  /** Markers that overlap at (x, y) closely enough that a tap can't tell them apart. */
  private cluster(x: number, y: number): number[] {
    const hits = this.near(x, y, 24);
    if (hits.length < 2) return [];
    // Tapped right on a dot: that's a clear choice, not an ambiguous group.
    const first = this.screen[hits[0]];
    if ((first.x - x) ** 2 + (first.y - y) ** 2 < 9 * 9) return [];
    // Already zoomed in as far as possible: just pick the nearest.
    if (this.view.zoom <= this.minZoom() * 1.05) return [];
    const a = this.screen[hits[0]];
    const close = hits.filter((i) => Math.hypot(this.screen[i].x - a.x, this.screen[i].y - a.y) < 22);
    return close.length > 1 && !close.includes(this.selected) ? close : [];
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
          this.opts.onIss?.(i === ISS_HOVER, x, y);
        }
        return;
      }
      const prev = this.pointers.get(e.pointerId)!;
      this.pointers.set(e.pointerId, { x, y });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchStart > 0) this.view.zoom = clamp(this.zoomStart * (this.pinchStart / d), this.minZoom(), ZOOM_MAX);
        this.down.moved = 999;
        return;
      }
      const dx = x - prev.x;
      const dy = y - prev.y;
      this.down.moved += Math.abs(dx) + Math.abs(dy);
      // Rotate so the surface follows the pointer.
      const degPerPx = this.degPerPx();
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
          const group = this.cluster(x, y);
          const i = this.pick(x, y);
          if (group.length) this.opts.onCluster?.(group);
          else if (i === MOON_HOVER) this.opts.onMoon?.();
          else if (i === ISS_HOVER) this.opts.onIss?.(true, x, y, true);
          else if (i >= 0) {
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
      this.opts.onIss?.(false, 0, 0);
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
