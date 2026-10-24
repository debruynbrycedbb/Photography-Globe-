// GLSL for the stylised Earth, its atmosphere, map lines, markers, stars and the descent clouds.

export const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export const earthFragment = /* glsl */ `
  uniform sampler2D uMask;     // r: land, g: soft coast glow
  uniform sampler2D uDetail;   // r: relief, g: city lights, b: surface brightness
  uniform vec2 uTexel;
  uniform vec3 uSunDir;      // direction of the real Sun (world space)
  uniform vec3 uAccent;
  uniform float uIntro;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = max(dot(N, V), 0.0);

    vec2 m = texture2D(uMask, vUv).rg;
    float land = smoothstep(0.25, 0.75, m.r);
    float coast = m.g;
    vec3 det = texture2D(uDetail, vUv).rgb;

    // Hill-shading from the relief channel gives the land a sculpted, faceted look.
    float hE = texture2D(uDetail, vUv + vec2(uTexel.x, 0.0)).r;
    float hW = texture2D(uDetail, vUv - vec2(uTexel.x, 0.0)).r;
    float hN = texture2D(uDetail, vUv - vec2(0.0, uTexel.y)).r;
    float hS = texture2D(uDetail, vUv + vec2(0.0, uTexel.y)).r;
    float hill = clamp(0.5 + ((hW - hE) + (hN - hS)) * 5.0, 0.0, 1.0);

    // Real day and night: the side facing the Sun is lit, the far side dims and its city lights come on.
    float sunDot = dot(N, uSunDir);
    float day = smoothstep(-0.10, 0.22, sunDot);
    float light = mix(0.26, 1.05, day);

    vec3 oceanDeep = vec3(0.006, 0.017, 0.023);
    vec3 oceanEdge = vec3(0.014, 0.052, 0.062);
    vec3 ocean = mix(oceanDeep, oceanEdge, pow(1.0 - ndv, 2.0));
    ocean += uAccent * coast * (1.0 - land) * 0.10;

    float surf = clamp(det.b * 1.15 + det.r * 0.5, 0.0, 1.0);
    vec3 landDark = vec3(0.046, 0.168, 0.122);
    vec3 landLight = vec3(0.118, 0.395, 0.282);
    vec3 landCol = mix(landDark, landLight, surf) * mix(0.62, 1.38, hill);

    vec3 col = mix(ocean, landCol, land) * light;

    // City lights: a warm glow on the night side, almost invisible in daylight.
    float city = smoothstep(0.09, 0.46, det.g);
    float lights = land * mix(pow(city, 1.3) * 1.5, pow(det.g, 2.4) * 0.1, day);
    col += vec3(1.0, 0.84, 0.55) * lights * 1.35; // warm amber, so the mint location markers stand apart
    // A faint glow along the line between day and night.
    col += uAccent * exp(-pow(sunDot / 0.07, 2.0)) * 0.045;

    // Rim light
    float fres = pow(1.0 - ndv, 3.2);
    col += uAccent * fres * 0.32;

    gl_FragColor = vec4(col * uIntro, 1.0);
  }
`;

export const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const atmosphereFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vec3 V = normalize(-vPosV);
    float d = dot(normalize(vNormalV), V);
    // Back-face shell: brightest just outside the Earth's edge, fading outwards.
    float glow = pow(clamp(-d / 0.42, 0.0, 1.0), 4.0);
    gl_FragColor = vec4(uColor * glow * uStrength, glow * uStrength);
  }
`;

export const lineVertex = /* glsl */ `
  varying float vFacing;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vFacing = dot(normalize(w.xyz), normalize(cameraPosition - w.xyz));
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFacing;
  void main() {
    float a = uOpacity * smoothstep(0.0, 0.45, vFacing);
    gl_FragColor = vec4(uColor * a, a);
  }
`;

export const markerVertex = /* glsl */ `
  attribute float aIndex;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uSelected;
  uniform float uHover;
  uniform float uVisible;
  uniform vec3 uSunDir;
  uniform float uUseSun;     // 1 for Earth markers: they get a night-time treatment
  varying float vFacing;
  varying float vActive;
  varying float vIndex;
  varying float vNight;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * w;
    vFacing = dot(normalize(w.xyz), normalize(cameraPosition - w.xyz));
    // 0 in daylight, 1 on the night side (where city lights would otherwise drown the markers out).
    vNight = uUseSun * (1.0 - smoothstep(-0.15, 0.12, dot(normalize(w.xyz), uSunDir)));
    float sel = 1.0 - step(0.5, abs(aIndex - uSelected));
    float hov = 1.0 - step(0.5, abs(aIndex - uHover));
    vActive = max(sel, hov * 0.7);
    vIndex = aIndex;
    float size = uSize * (1.0 + sel * 0.55 + hov * 0.35) * (1.0 + vNight * 0.45);
    // Grows a little as the camera gets closer, but never balloons when zoomed right in.
    gl_PointSize = size * uPixelRatio * clamp(6.0 / -mv.z, 0.6, 1.5) * uVisible;
    gl_Position = projectionMatrix * mv;
  }
`;

export const markerFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vFacing;
  varying float vActive;
  varying float vIndex;
  varying float vNight;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    // At night the point is drawn larger, so shrink the shapes back to keep the dot crisp, then add a ring.
    float k = mix(1.0, 1.45, vNight);
    float dd = d * k;
    float core = smoothstep(0.30, 0.18, dd);
    float halo = exp(-dd * dd * 7.0) * 0.55;
    float pulse = 0.5 + 0.5 * sin(uTime * 2.2 + vIndex * 1.7);
    float ring = smoothstep(0.10, 0.0, abs(d - 0.78)) * vNight * (0.75 + 0.25 * pulse);
    float a = core + halo * (0.6 + 0.4 * pulse + vActive * 0.5) + ring;
    a *= smoothstep(0.02, 0.3, vFacing);
    vec3 col = mix(uColor, vec3(1.0), core * (0.3 + vActive * 0.55 + vNight * 0.3));
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Dark disc drawn under Earth markers on the night side so they stand out from city lights. */
export const markerBackFragment = /* glsl */ `
  uniform float uVisible;
  varying float vFacing;
  varying float vNight;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float disc = smoothstep(0.95, 0.6, d);
    float a = disc * 0.72 * vNight * uVisible * smoothstep(0.02, 0.3, vFacing);
    gl_FragColor = vec4(0.0, 0.03, 0.035, a);
  }
`;

export const starVertex = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    vColor = aColor;
    vTwinkle = 0.78 + 0.22 * sin(uTime * (0.6 + aSeed * 1.4) + aSeed * 40.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    gl_Position = projectionMatrix * mv;
  }
`;

export const starFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a = a * a * vTwinkle;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export const ringVertex = /* glsl */ `
  attribute float aT;
  varying float vT;
  void main() {
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vT;
  void main() {
    // Brighter on one side, fading out on the other — like a lit orbit.
    float a = uOpacity * (0.25 + 0.75 * pow(0.5 + 0.5 * cos((vT - 0.15) * 6.2831853), 1.5));
    gl_FragColor = vec4(uColor * a, a);
  }
`;

// The Moon: procedural albedo (r) + height (g), lit from a fixed direction in view space
// so it always reads as a softly lit gibbous moon with black shadows.
export const moonVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vUv = uv;
    vNormalV = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const moonFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uTexel;
  uniform vec3 uAccent;
  uniform float uFade;
  uniform float uHover;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vec3 N = normalize(vNormalV);
    vec3 V = normalize(-vPosV);
    vec2 t = texture2D(uMap, vUv).rg;
    float hE = texture2D(uMap, vUv + vec2(uTexel.x, 0.0)).g;
    float hW = texture2D(uMap, vUv - vec2(uTexel.x, 0.0)).g;
    float hN = texture2D(uMap, vUv - vec2(0.0, uTexel.y)).g;
    float hS = texture2D(uMap, vUv + vec2(0.0, uTexel.y)).g;
    float hill = clamp(0.5 + ((hW - hE) + (hN - hS)) * 6.0, 0.0, 1.0);
    vec3 L = normalize(vec3(-0.55, 0.45, 0.7));
    float diff = smoothstep(-0.12, 0.6, dot(N, L));
    // Neutral grey surface; the unlit side falls off to black (no coloured rim).
    vec3 base = mix(vec3(0.31), vec3(0.82, 0.82, 0.80), t.r);
    vec3 col = base * mix(0.62, 1.32, hill) * (0.02 + 0.98 * diff);
    col *= 1.0 + 0.12 * uHover; // slight brighten on hover instead of a glow
    gl_FragColor = vec4(col * uFade, uFade);
  }
`;

// Live ISS orbit path: brighter ahead of the station, dimmer behind, fading at both ends.
export const trackVertex = /* glsl */ `
  attribute float aT;
  varying float vT;
  varying float vFacing;
  void main() {
    vT = aT;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vFacing = dot(normalize(w.xyz), normalize(cameraPosition - w.xyz));
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export const trackFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vT;
  varying float vFacing;
  void main() {
    float ends = smoothstep(0.0, 0.2, vT) * smoothstep(1.0, 0.8, vT);
    float ahead = mix(0.35, 1.0, step(0.5, vT));
    float a = uOpacity * ends * ahead * mix(0.35, 1.0, smoothstep(-0.2, 0.3, vFacing));
    gl_FragColor = vec4(uColor * a, a);
  }
`;

export const cloudVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Layers of fractal noise rushing towards the camera.
export const cloudFragment = /* glsl */ `
  uniform float uTravel;
  uniform float uOpacity;
  uniform float uAspect;
  uniform vec3 uTint;
  uniform float uTime;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    float acc = 0.0;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float z = fract(fi / 4.0 - uTravel * 1.35);
      float scale = mix(0.25, 3.5, z);
      float fade = smoothstep(0.0, 0.25, z) * smoothstep(1.0, 0.7, z);
      vec2 p = uv * scale + vec2(fi * 7.31, fi * 3.17) + uTime * 0.02;
      float n = fbm(p * 1.6);
      float dens = smoothstep(0.34, 0.72, n) * fade;
      float shade = 0.75 + 0.25 * fbm(p * 3.1 + 4.0);
      col += mix(uTint, vec3(0.92, 0.95, 0.96), 0.55) * shade * dens * (1.0 - acc);
      acc += dens * (1.0 - acc);
    }
    float vign = smoothstep(1.3, 0.2, length(uv));
    float a = clamp(acc * 1.25, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(col / max(acc, 0.001) * mix(0.8, 1.0, vign), a);
  }
`;

// The Moon's version of the descent: a dive into a crater instead of through clouds.
// Craters at several sizes, each layer fading in only once it's big enough on screen,
// lit from the upper left like the Moon itself, ending in the shadow of the crater floor.
export const craterFragment = /* glsl */ `
  uniform float uTravel;
  uniform float uOpacity;
  uniform float uAspect;
  uniform float uRes;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  // One crater's height, r in units of its radius: a shallow bowl with a flattish floor,
  // a soft raised rim and a little ejecta beyond it.
  float crater(float r) {
    float bowl = r < 1.0 ? max(r * r - 1.0, -0.62) * 0.55 : 0.0;
    float rim = 0.16 * exp(-pow((r - 1.0) / 0.2, 2.0));
    float ejecta = r > 1.0 ? 0.05 * exp(-(r - 1.0) * 2.5) : 0.05;
    return bowl + rim + ejecta;
  }

  // A scattering of craters of different sizes, one possible per cell.
  float field(vec2 p, float density) {
    vec2 c = floor(p);
    vec2 f = fract(p);
    float h = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        float pick = hash(c + g + 17.3);
        if (pick > density) continue;
        float R = mix(0.1, 0.48, pow(fract(pick * 7.13), 2.2)); // mostly small, a few large
        float r = length(g + hash2(c + g) - f) / R;
        if (r < 2.2) h += crater(r) * R;
      }
    }
    return h;
  }

  // Each layer of detail fades in only once its craters are big enough on screen not to shimmer.
  float octave(float freq, float px) {
    return smoothstep(3.0, 12.0, (1.0 / freq) / px);
  }

  float height(vec2 q, float px) {
    float h = crater(length(q)) * 1.3;                 // the crater we dive into (radius 1)
    h += (fbm(q * 0.9 + 4.0) - 0.5) * 0.25;           // gentle rolling ground
    float w;
    w = octave(3.0, px);   if (w > 0.0) h += field(q * 3.0 + 0.7, 0.32) / 3.0 * w;
    w = octave(9.0, px);   if (w > 0.0) h += field(q * 9.0 + 3.7, 0.38) / 9.0 * w;
    w = octave(27.0, px);  if (w > 0.0) h += field(q * 27.0 + 8.1, 0.42) / 27.0 * w;
    w = octave(81.0, px);  if (w > 0.0) h += field(q * 81.0 + 1.3, 0.45) / 81.0 * w;
    w = octave(243.0, px); if (w > 0.0) h += field(q * 243.0 + 5.9, 0.45) / 243.0 * w;
    w = octave(120.0, px); if (w > 0.0) h += (fbm(q * 120.0) - 0.5) * 0.0035 * w;
    return h;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    // A slow turn while diving, like the camera settling.
    float ang = uTravel * 0.22;
    uv = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * uv;
    float scale = exp(uTravel * 2.6);
    float span = 2.6 / scale;                          // world units across the screen height
    vec2 q = uv * span;
    float px = span / uRes;

    // Surface normal from the height field's screen-space slope, lit low from the upper left
    // like the Moon itself, so the relief throws long shadows.
    float h = height(q, px);
    vec3 n = normalize(vec3(-dFdx(h) / px, -dFdy(h) / px, 1.0));
    vec3 L = normalize(vec3(-0.62, 0.52, 0.42));
    float diff = max(dot(n, L), 0.0);

    // Darker plains and brighter highlands, with fine speckle once it's large enough to see.
    float plains = smoothstep(0.38, 0.62, fbm(q * 0.7 + 11.0));
    float albedo = mix(0.58, 0.36, plains) * mix(0.95, 1.04, fbm(q * 18.0 + 9.0));
    vec3 col = vec3(1.0, 0.985, 0.96) * albedo * (0.03 + 1.25 * diff);

    // Into the shadow of the crater floor at the end, so the dark gallery backdrop takes over.
    col *= 1.0 - 0.88 * smoothstep(1.0, 1.55, uTravel);
    col *= mix(0.5, 1.0, smoothstep(1.2, 0.2, length(uv)));
    gl_FragColor = vec4(col, uOpacity);
  }
`;
