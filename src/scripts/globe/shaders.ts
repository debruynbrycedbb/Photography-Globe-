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
  uniform vec3 uLightDir;
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

    float light = clamp(dot(N, uLightDir) * 0.55 + 0.6, 0.28, 1.0);

    vec3 oceanDeep = vec3(0.006, 0.017, 0.023);
    vec3 oceanEdge = vec3(0.014, 0.052, 0.062);
    vec3 ocean = mix(oceanDeep, oceanEdge, pow(1.0 - ndv, 2.0));
    ocean += uAccent * coast * (1.0 - land) * 0.10;

    float surf = clamp(det.b * 1.15 + det.r * 0.5, 0.0, 1.0);
    vec3 landDark = vec3(0.046, 0.168, 0.122);
    vec3 landLight = vec3(0.118, 0.395, 0.282);
    vec3 landCol = mix(landDark, landLight, surf) * mix(0.62, 1.38, hill);

    vec3 col = mix(ocean, landCol, land) * light;

    // City lights, very restrained.
    float lights = pow(det.g, 2.4) * land;
    col += mix(uAccent, vec3(1.0), 0.35) * lights * mix(0.35, 0.9, 1.0 - light);

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
  varying float vFacing;
  varying float vActive;
  varying float vIndex;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * w;
    vFacing = dot(normalize(w.xyz), normalize(cameraPosition - w.xyz));
    float sel = 1.0 - step(0.5, abs(aIndex - uSelected));
    float hov = 1.0 - step(0.5, abs(aIndex - uHover));
    vActive = max(sel, hov * 0.7);
    vIndex = aIndex;
    float size = uSize * (1.0 + sel * 0.55 + hov * 0.35);
    gl_PointSize = size * uPixelRatio * (6.0 / -mv.z) * uVisible;
    gl_Position = projectionMatrix * mv;
  }
`;

export const markerFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vFacing;
  varying float vActive;
  varying float vIndex;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float core = smoothstep(0.30, 0.18, d);
    float halo = exp(-d * d * 7.0) * 0.55;
    float pulse = 0.5 + 0.5 * sin(uTime * 2.2 + vIndex * 1.7);
    float a = core + halo * (0.6 + 0.4 * pulse + vActive * 0.5);
    a *= smoothstep(0.02, 0.3, vFacing);
    vec3 col = mix(uColor, vec3(1.0), core * (0.3 + vActive * 0.55));
    gl_FragColor = vec4(col * a, a);
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
