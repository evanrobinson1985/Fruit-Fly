// Grass floor and small weeds for the arena, at true scale for a 2.5 mm fly (units: mm).
//
// Blades are generated on the GPU: each instance is a cell offset in one of several
// nested level-of-detail rings around the fly (cells double in size per ring), and the
// vertex shader places the blade at a hashed spot in that world cell. Every blade has a
// fixed place in the world, nothing is rebuilt on the CPU as the fly moves, and grass
// covers the whole arena. The same shader bends blades only where the fly's body and legs
// actually press them, keeps them under any leaf lying on the turf (from a baked height
// map of the weeds) and knocks them down where raindrops hit.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const TURF_TOP = 0.35; // a fly walks on the matted turf, about this high (mm)
const C0 = 0.29;              // level-0 cell size (mm): 12 blades per mm^2 next to the fly
const R0 = 16;                // radius of level 0; level L reaches R0 * 2^L
const LEVELS = 5;             // out to 256 mm
const MAX_IMPACTS = 16;       // raindrop impacts the shaders animate at once
const MAX_EXCL = 16;
const HMAP = 2048;            // height map resolution over the arena (~0.45 mm)
const HZ0 = 40;               // height map offset (mm): it holds -40 .. +91 mm (the pond is below ground)

// Seeded RNG for weed placement.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296;
}

function soilTexture(repeat) {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#4a5a2a";
  g.fillRect(0, 0, 512, 512);
  // Soil showing through the turf.
  for (let i = 0; i < 2500; i++) {
    const v = 50 + Math.random() * 40;
    g.fillStyle = `rgba(${v + 30},${v + 15},${v - 10},0.5)`;
    g.beginPath();
    g.arc(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 3, 0, 7);
    g.fill();
  }
  // Short grass strokes.
  for (let i = 0; i < 16000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512, a = Math.random() * 6.28, l = 3 + Math.random() * 7;
    const gr = 90 + Math.random() * 80;
    g.strokeStyle = `rgba(${gr * 0.45},${gr},${gr * 0.25},0.55)`;
    g.lineWidth = 1 + Math.random();
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// A tapered blade, 1 wide at the base and 1 tall, curving forward (+y) toward the tip.
function bladeGeometry() {
  const levels = [0, 0.3, 0.6, 0.85, 1];
  const widths = [1, 0.85, 0.6, 0.3, 0];
  const pos = [], col = [], uvs = [], idx = [];
  levels.forEach((t, i) => {
    const w = widths[i] / 2, bend = 0.35 * t * t;
    pos.push(-w, bend, t, w, bend, t);
    uvs.push(0, t, 1, t);
    const shade = 0.45 + 0.55 * t;
    col.push(shade, shade, shade, shade, shade, shade);
  });
  for (let i = 0; i < levels.length - 1; i++) {
    const a = 2 * i;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("aUV", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // One instance per cell offset of each ring: (dx, dy, level).
  const cells = [];
  for (let L = 0; L < LEVELS; L++) {
    const c = C0 * 2 ** L, rOut = R0 * 2 ** L + 2 * c, rIn = L ? Math.max(0, 0.8 * R0 * 2 ** (L - 1) - 2 * c) : -1;
    const n = Math.ceil(rOut / c);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const d = Math.hypot(i, j) * c;
        if (d <= rOut && d >= rIn) cells.push(i, j, L);
      }
    }
  }
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(new Float32Array(cells), 3));
  geo.instanceCount = cells.length / 3;
  return geo;
}

const GLSL_COMMON = `
uniform float uTime, uSimT;
uniform vec3 uFly;            // fly x, y and the height of its feet
uniform vec2 uFlyDir;         // fly heading (cos, sin)
uniform vec4 uImp[${MAX_IMPACTS}];  // raindrop impacts: x, y, sim time, drop diameter
`;

// Plant skins, drawn per pixel: vein lines, a cell network between them, and a bump
// from both (veins raised underneath, sunken on top), faded out where finer than a pixel.
const PLANT_GLSL = `
float veinLine(float x, float w) { float f = abs(fract(x) - 0.5) * 2.0; return smoothstep(1.0 - w, 1.0, f); }
float aaFade(float x) { return 1.0 - smoothstep(0.35, 0.9, fwidth(x)); }
vec2 ph22(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
// Edges of a cell network (F2 - F1), 1 on an edge.
float cellEdge(vec2 p) {
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), o = ph22(i + g);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return 1.0 - smoothstep(0.0, 0.08, d2 - d1);
}
float pnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ph22(i).x, ph22(i + vec2(1, 0)).x, f.x), mix(ph22(i + vec2(0, 1)).x, ph22(i + vec2(1, 1)).x, f.x), f.y); }
// Bump from a height field (Mikkelsen's screen-space method, as in three.js).
vec3 bumpNormal(vec3 n, float h, float scale, vec3 p) { // p: view-space position
  vec3 dpx = dFdx(p), dpy = dFdy(p);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 b = abs(det) * n - scale * grad;
  return dot(b, b) > 1e-30 ? normalize(b) : n;
}
`;

// Grass blades: place each instance, then press, clamp under leaves, sway and splash.
function grassMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = GLSL_COMMON + `
attribute vec3 aCell;
attribute vec2 aUV;
varying vec2 vBlade;
varying vec3 vSide;
varying float vTone;
uniform vec2 uCenter;
uniform float uArena;
uniform float uHole;
uniform vec3 uExcl[${MAX_EXCL}];
uniform int uNExcl;
uniform sampler2D uLeaf;
uniform vec3 uLeafBox;        // min x, min y, size of the height map
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h01(ivec2 c, uint k) { return float(pcg(uint(c.x) * 73856093u ^ pcg(uint(c.y) * 19349663u ^ k))) / 4294967295.0; }
vec3 hsl2rgb(vec3 c) { vec3 r = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return c.z + c.y * (r - 0.5) * (1.0 - abs(2.0 * c.z - 1.0)); }
float leafTop(vec2 p) {
  vec2 uv = (p - uLeafBox.xy) / uLeafBox.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  vec4 t = textureLod(uLeaf, uv, 0.0);
  float v = t.r * 65280.0 + t.g * 255.0;
  return v < 0.5 ? 0.0 : v / 500.0 - ${HZ0}.0;
}
` + shader.vertexShader
      .replace("#include <color_vertex>", `
  float lvl = aCell.z, cs = ${C0} * exp2(lvl);
  ivec2 cell = ivec2(floor(uCenter / cs) + aCell.xy);
  uint L = uint(lvl) * 16u;
  vec2 bpos = (vec2(cell) + vec2(h01(cell, L + 1u), h01(cell, L + 2u))) * cs;
  float d = length(bpos - uCenter);
  // Rings overlap by 20%: the inner one thins out as the outer one fills in.
  float rOut = ${R0}.0 * exp2(lvl), rIn = ${R0}.0 * exp2(lvl - 1.0);
  float keep = (1.0 - smoothstep(0.8 * rOut, rOut, d)) * (lvl < 0.5 ? 1.0 : smoothstep(0.8 * rIn, rIn, d));
  float alive = step(h01(cell, L + 3u), keep);
  float rr = length(bpos);
  alive *= 1.0 - step(uArena - 1.2, rr); // grass only inside the arena
  alive *= step(uHole + 10.0, rr); // keep fallback blades clear of the pond
  for (int i = 0; i < ${MAX_EXCL}; i++) { if (i >= uNExcl) break; if (distance(bpos, uExcl[i].xy) < uExcl[i].z) alive = 0.0; }
  float h0 = h01(cell, L + 4u);
  float bh = (0.4 + 1.4 * h0 * h0) * (1.0 + 0.25 * lvl);             // fine, freshly mown turf
  float bw = (0.12 + 0.22 * h01(cell, L + 5u)) * pow(2.0, 0.7 * lvl);
  float yaw = h0 * 97.3, tilt = (h01(cell, L + 6u) - 0.5) * 0.5;
  mat3 Rz = mat3(cos(yaw), sin(yaw), 0.0, -sin(yaw), cos(yaw), 0.0, 0.0, 0.0, 1.0);
  mat3 Rx = mat3(1.0, 0.0, 0.0, 0.0, cos(tilt), sin(tilt), 0.0, -sin(tilt), cos(tilt));
  mat3 bladeR = Rz * Rx;
  bool dry = h01(cell, L + 7u) < 0.06;
  vec3 bc = hsl2rgb(dry ? vec3(0.13, 0.35, 0.55) : vec3(0.24 + 0.08 * h01(cell, L + 8u), 0.55, 0.28 + 0.2 * h01(cell, L + 9u)));
  vColor = color * pow(bc, vec3(2.2));
  vBlade = aUV;
  vTone = h01(cell, L + 10u);
  vSide = normalize((viewMatrix * vec4(bladeR * vec3(1.0, 0.0, 0.0), 0.0)).xyz);`)
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = bladeR * normal;")
      .replace("#include <begin_vertex>", `
  vec3 transformed = alive > 0.5 ? bladeR * (position * vec3(bw, bw, bh)) + vec3(bpos, 0.0) : vec3(0.0);`)
      .replace("#include <project_vertex>", `
  if (alive > 0.5) {
    // Pressed only where the fly's body and legs are: an ellipse around it, capped just under its belly.
    vec2 o = transformed.xy - uFly.xy;
    float a = dot(o, uFlyDir), b = dot(o, vec2(-uFlyDir.y, uFlyDir.x));
    float e = a * a / 2.1 + b * b / 1.3;
    float cap = uFly.z + 0.22 + max(0.0, e - 0.7) * 8.0;
    if (transformed.z > cap) { float ex = transformed.z - cap; transformed.z = cap; transformed.xy += normalize(o + 1e-4) * ex * 0.7; }
    // A leaf lying on the turf is solid: blades stay underneath it.
    float lz = leafTop(transformed.xy);
    if (lz > 0.01 && transformed.z > lz - 0.06) transformed.z = max(0.01, lz - 0.06);
    float sw = position.z * position.z;
    transformed.x += sin(uTime * 1.7 + transformed.y * 0.35) * 0.22 * sw;
    transformed.y += cos(uTime * 1.3 + transformed.x * 0.3) * 0.15 * sw;
    // Raindrops flatten the blades they hit, which then spring back.
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      float age = uSimT - uImp[i].z;
      if (age < 0.0 || age > 0.8 || uImp[i].w <= 0.0) continue;
      vec2 q = transformed.xy - uImp[i].xy;
      float R = 0.5 * uImp[i].w + 0.35;
      float f = exp(-dot(q, q) / (R * R)) * exp(-age / 0.15) * cos(age * 35.0);
      float hz = transformed.z;
      transformed.z -= hz * 0.85 * clamp(f, -0.3, 1.0);
      transformed.xy += normalize(q + 1e-4) * hz * 0.6 * max(f, 0.0);
    }
  }
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = "varying vec2 vBlade;\nvarying vec3 vSide;\nvarying float vTone;\n" + PLANT_GLSL + shader.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  {
    // A grass blade: pale sheath at the base, green lamina, yellowing tip (dry and brown on
    // some), fine parallel veins with a stronger midrib, and faint flecks.
    float u = vBlade.x, v = vBlade.y;
    float veins = veinLine(u * 9.0, 0.22) * aaFade(u * 9.0);
    float rib = 1.0 - smoothstep(0.0, 0.09, abs(u - 0.5));
    vec3 tint = vec3(1.0);
    tint *= mix(vec3(1.0), vec3(1.25, 1.2, 0.85), (1.0 - smoothstep(0.0, 0.12, v)));   // sheath
    tint *= mix(vec3(1.0), vec3(1.25, 1.12, 0.6), smoothstep(0.7, 1.0, v) * 0.6);       // tip
    if (vTone < 0.12) tint = mix(tint, vec3(1.3, 0.95, 0.55), smoothstep(0.8, 0.98, v)); // dry tip
    tint *= 1.0 + 0.12 * veins + 0.1 * rib;
    tint *= 0.9 + 0.2 * pnoise(vec2(u * 6.0, v * 40.0 + vTone * 50.0));
    diffuseColor.rgb *= tint;
  }`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  {
    // Folded along the midrib (a shallow V), with the veins as ridges.
    float u = vBlade.x;
    normal = normalize(normal + faceDirection * vSide * (u - 0.5) * 0.9);
    normal = bumpNormal(normal, veinLine(u * 9.0, 0.3) * aaFade(u * 9.0) * 0.5 + (1.0 - smoothstep(0.0, 0.1, abs(u - 0.5))), 0.0025, -vViewPosition);
  }`);
  };
  return m;
}

// Weed leaves: a faint breeze, and a bob where a raindrop lands (the base stays put).
function leafMaterial(color, u, opts = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color, side: THREE.DoubleSide, roughness: 0.55, specularIntensity: 0.45, sheen: 0.12, sheenRoughness: 0.7, sheenColor: new THREE.Color(0.35, 0.5, 0.3), ...opts });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = "varying vec3 vLeaf;\n" + PLANT_GLSL + shader.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  float leafH = 0.0;
  {
    float s = vLeaf.x, t = vLeaf.y, at = abs(t);
    int kind = int(vLeaf.z + 0.5);
    vec3 tint = vec3(1.0);
    if (kind == 0) {
      // Stem: fine lengthwise ridges, paler toward the base.
      float r = veinLine(t * 6.0, 0.35) * aaFade(t * 6.0);
      tint *= (1.0 + 0.15 * r) * mix(vec3(1.2, 1.15, 0.85), vec3(1.0), smoothstep(0.0, 0.4, s));
      leafH = r;
    } else {
      // Midrib, side veins running out toward the margin, and the network between them.
      float ribW = kind == 2 ? 0.11 : 0.05;
      float rib = 1.0 - smoothstep(ribW * 0.4, ribW, at);
      float n = kind == 1 ? 16.0 : kind == 2 ? 11.0 : 5.0, slope = kind == 1 ? 0.25 : 0.55;
      float x = (s - at * slope) * n;
      float side = veinLine(x, 0.16) * aaFade(x) * (1.0 - rib) * smoothstep(1.0, 0.75, at);
      vec2 cp = vec2(s * n * 2.2, t * n * 0.9);
      float net = cellEdge(cp) * aaFade(cp.x) * (1.0 - rib);
      tint *= 0.85 * (1.0 + 0.45 * rib + 0.3 * side + 0.12 * net);
      tint *= 0.92 + 0.16 * pnoise(vec2(s, t) * 9.0);
      tint *= mix(vec3(1.0), vec3(1.15, 1.1, 0.75), smoothstep(0.85, 1.0, at) * 0.5); // paler, yellower margin
      if (kind == 1) {
        // White clover's pale chevron ("watermark") across each leaflet.
        float chev = 1.0 - smoothstep(0.03, 0.09, abs(s - (0.42 + 0.3 * at)));
        tint = mix(tint, vec3(1.7, 1.75, 1.45), chev * smoothstep(0.95, 0.6, at) * 0.55);
      }
      if (kind == 2) {
        // Dandelion: broad pale midrib, flushed red-purple toward the base; matte blue-green.
        tint = mix(tint, mix(vec3(1.5, 0.75, 0.9), vec3(1.55, 1.5, 1.2), smoothstep(0.0, 0.35, s)), rib * 0.85);
        tint *= vec3(0.95, 1.0, 1.05);
      }
      if (!gl_FrontFacing) tint *= vec3(1.08, 1.1, 1.0); // undersides are paler
      leafH = -(rib + 0.55 * side + 0.25 * net); // veins sunken into the upper surface
    }
    diffuseColor.rgb *= tint;
  }`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  normal = bumpNormal(normal, leafH, 0.004, -vViewPosition);`);
    shader.vertexShader = "attribute vec3 aLeaf;\nvarying vec3 vLeaf;\n" + GLSL_COMMON + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvLeaf = aLeaf;").replace("#include <project_vertex>", `
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  mvPosition = modelMatrix * mvPosition;
  float sw = transformed.z * transformed.z * 0.004;
  mvPosition.x += sin(uTime * 1.7 + mvPosition.y * 0.35) * sw;
  mvPosition.z += leafBob(mvPosition.xyz);
  mvPosition = viewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`).replace("void main() {", `
float leafBob(vec3 p) {
  float dz = 0.0;
  for (int i = 0; i < ${MAX_IMPACTS}; i++) {
    float age = uSimT - uImp[i].z;
    if (age < 0.0 || age > 1.0 || uImp[i].w <= 0.0) continue;
    vec2 q = p.xy - uImp[i].xy;
    dz -= 0.12 * uImp[i].w * exp(-dot(q, q) / 9.0) * exp(-age / 0.18) * cos(age * 50.0);
  }
  return dz * smoothstep(0.3, 1.5, p.z);
}
void main() {`);
  };
  return m;
}

// Leaf outline in the XY plane, base at the origin, pointing +x.
function leafShape(len, wid, teeth = 0) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  const n = 24;
  const upper = [], lower = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    let w = wid * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.15 * t);
    if (teeth && i % 3 === 0 && t < 0.9) w *= 1.35; // dandelion "lion's teeth"
    upper.push([t * len, w]);
    lower.push([t * len, -w]);
  }
  upper.forEach(([x, y]) => s.lineTo(x, y));
  lower.reverse().forEach(([x, y]) => s.lineTo(x, y));
  s.lineTo(0, 0);
  return s;
}

function heartLeaflet(r) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(r * 0.3, r * 0.6, r * 1.1, r * 0.8, r * 1.05, r * 0.15);
  s.quadraticCurveTo(r * 0.95, -0.02 * r, r * 0.9, 0);
  s.quadraticCurveTo(r * 0.95, 0.02 * r, r * 1.05, -r * 0.15);
  s.bezierCurveTo(r * 1.1, -r * 0.8, r * 0.3, -r * 0.6, 0, 0);
  return s;
}

// Shape -> geometry tilted up by `lift` radians and rotated `yaw` about z, raised to height z.
// Leaf coordinates for the skin shader: s from base (0) to tip (1), t across the blade
// (-1..1, 0 on the midrib), and which kind of leaf it is.
const KIND = { stem: 0, clover: 1, dandelion: 2, seedling: 3 };

function placed(shape, { yaw = 0, lift = 0, z = 0, droop = 0, kind = KIND.seedling } = {}) {
  const g = new THREE.ShapeGeometry(shape, 12);
  const p = g.attributes.position;
  let len = 0, wid = 0;
  for (let i = 0; i < p.count; i++) { len = Math.max(len, p.getX(i)); wid = Math.max(wid, Math.abs(p.getY(i))); }
  const leaf = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    leaf.set([x / len, p.getY(i) / wid, kind], 3 * i);
    p.setZ(i, -droop * x * x); // leaf tips curve down
  }
  g.setAttribute("aLeaf", new THREE.BufferAttribute(leaf, 3));
  g.rotateY(-lift);
  g.rotateZ(yaw);
  g.translate(0, 0, z);
  g.computeVertexNormals();
  return g;
}

function stem(h, r = 0.12) {
  const g = new THREE.CylinderGeometry(r * 0.7, r, h, 6);
  const uv = g.attributes.uv, leaf = new Float32Array(uv.count * 3);
  for (let i = 0; i < uv.count; i++) leaf.set([uv.getY(i), uv.getX(i) * 2 - 1, KIND.stem], 3 * i);
  g.setAttribute("aLeaf", new THREE.BufferAttribute(leaf, 3));
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, h / 2);
  return g;
}

function cloverGeometry(leaflets = 3) {
  const h = 3.5;
  const parts = [stem(h, 0.15)];
  const r = leaflets === 4 ? 2.9 : 3.2; // four-leaf clovers: same plant, one more (slightly smaller) leaflet
  for (let k = 0; k < leaflets; k++) parts.push(placed(heartLeaflet(r), { yaw: (k * 2 * Math.PI) / leaflets, lift: 0.15, z: h, droop: 0.03, kind: KIND.clover }));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function dandelionGeometry() {
  const parts = [];
  for (let k = 0; k < 11; k++) {
    const len = 14 + (k % 4) * 3;
    parts.push(placed(leafShape(len, 2.6, 1), { yaw: (k * 2 * Math.PI) / 11 + 0.2 * Math.sin(k * 3), lift: 0.06, z: 0.15, droop: 0.001, kind: KIND.dandelion }));
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function seedlingGeometry() {
  const h = 4.5;
  return mergeGeometries([
    stem(h, 0.12),
    placed(leafShape(2.6, 1.0), { yaw: 0, lift: 0.5, z: h }),
    placed(leafShape(2.6, 1.0), { yaw: Math.PI, lift: 0.5, z: h }),
  ].map((g) => g.toNonIndexed()));
}

// ---------- grass from a model (web/assets/env/grass.glb: Poly Haven grass_medium_01) ----------
// The same ring placement as the blades, one clump per cell instead of one blade. Clumps
// near the fly are the model's fuller tufts; further rings use lighter ones, spread wider.
let GC0 = 1.9;                // level-0 cell size (mm): one clump per cell (smaller: denser, see useGrassModel)
const GR0 = 20;               // radius of level 0; level L reaches GR0 * 2^L
// Levels 0-5 reach 640 mm; on a computer a level 6 takes the lawn to 1.3 m, so the whole
// arena is covered wherever the camera looks.
export const GRASS_H = 2.4;   // a clump's height near the fly (mm): a lawn at a fly's scale
const MAX_FROGS = 2;

/** Keep about `keep` of a clump's blades (its separate pieces): lighter clumps far away. */
function thinBlades(g, keep) {
  const idx = g.getIndex().array, nv = g.attributes.position.count, parent = new Int32Array(nv).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]); parent[find(idx[t + 1])] = a; parent[find(idx[t + 2])] = a; }
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const c = find(idx[t]);
    if (((c * 2654435761) >>> 0) / 4294967296 < keep) out.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  g.setIndex(out);
  return g;
}

// With several clump models mixed (on a computer), each takes its share of an 8 x 8 tiling
// of the cells, the tiling fixed to the ground: a cell keeps its clump as the rings move.
const SLOTS = 8;
// On a computer (the mixed lawn) the cells only grow by 2^0.5 per ring instead of doubling,
// and the clumps keep their height and spread only a little: the lawn looks the same all
// the way out instead of thinning into a different, sparser grass away from the fly.
const TILED_CELL_GROWTH = 0.5, TILED_SPREAD = 0.35;

/**
 * An instanced clump: the model's geometry (Y-up, any units) turned Z-up, 1 unit tall, or
 * scaled by `refH` (the model's units per unit) to keep its size among the other clumps.
 * `slots`: the cells of the 8 x 8 tiling it grows in (all cells if not given).
 */
function clumpBase(src, keep = 1, refH = 0) {
  const g = keep < 1 ? thinBlades(src.clone(), keep) : src.clone();
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  const k = 1 / (refH || b.max.z - b.min.z);
  g.scale(k, k, k);
  return g;
}
function instanced(g, cells) {
  const geo = new THREE.InstancedBufferGeometry();
  for (const k of ["position", "normal", "uv"]) geo.setAttribute(k, g.getAttribute(k));
  geo.setIndex(g.getIndex());
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(new Float32Array(cells), 3));
  geo.instanceCount = cells.length / 3;
  return geo;
}
function clumpGeometry(src, levels, keep = 1, slots = null, refH = 0) {
  const g = clumpBase(src, keep, refH);
  const geo = new THREE.InstancedBufferGeometry();
  for (const k of ["position", "normal", "uv"]) geo.setAttribute(k, g.getAttribute(k));
  geo.setIndex(g.getIndex());
  const cells = [];
  for (const L of levels) {
    // (snapped to the tiling, the rings' centre is up to 8 cells off: a wider margin)
    const c = GC0 * 2 ** (L * (slots ? TILED_CELL_GROWTH : 1)), m = (slots ? SLOTS : 0) * c;
    const rOut = GR0 * 2 ** L + 2 * c + m, rIn = L ? Math.max(0, 0.8 * GR0 * 2 ** (L - 1) - 2 * c - m) : -1;
    const n = Math.ceil(rOut / c);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const d = Math.hypot(i, j) * c;
      const slot = (((i % SLOTS) + SLOTS) % SLOTS) * SLOTS + (((j % SLOTS) + SLOTS) % SLOTS);
      if (d <= rOut && d >= rIn && (!slots || slots.has(slot))) cells.push(i, j, L);
    }
  }
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(new Float32Array(cells), 3));
  geo.instanceCount = cells.length / 3;
  return geo;
}

function clumpMaterial(u, maps, tiled = false, fixed = false) {
  const m = new THREE.MeshStandardMaterial({
    map: maps.map, normalMap: maps.normalMap, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.78, metalness: 0,
  });
  // the model's roughness map (green channel, as glTF packs it)
  if (maps.roughnessMap) Object.assign(m, { roughnessMap: maps.roughnessMap, roughness: 1 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = GLSL_COMMON + `
attribute vec3 aCell;
varying float vH;
varying float vWet;
varying vec3 vTint;
uniform vec2 uCenter;
uniform float uArena;
uniform vec3 uExcl[${MAX_EXCL}];
uniform int uNExcl;
uniform sampler2D uLeaf;
uniform vec3 uLeafBox;
uniform vec4 uFrog[${MAX_FROGS}];   // frogs: x, y, heading, length (0: none)
uniform float uFrogZ[${MAX_FROGS}]; // height of each frog's belly (world z)
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h01(ivec2 c, uint k) { return float(pcg(uint(c.x) * 73856093u ^ pcg(uint(c.y) * 19349663u ^ k))) / 4294967295.0; }
float leafTop(vec2 p) {
  vec2 uv = (p - uLeafBox.xy) / uLeafBox.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  vec4 t = textureLod(uLeaf, uv, 0.0);
  float v = t.r * 65280.0 + t.g * 255.0;
  return v < 0.5 ? 0.0 : v / 500.0 - ${HZ0}.0;
}
uniform float uHole;   // no grass inside this radius (the pond)
uniform float uWaterLine; // grass grows down the banks to just above this height
` + shader.vertexShader
      .replace("#include <color_vertex>", `#include <color_vertex>
  float lvl = aCell.z, cs = ${GC0} * exp2(lvl * ${tiled ? TILED_CELL_GROWTH.toFixed(2) : "1.0"});
  ivec2 cell = ${fixed ? "ivec2(aCell.xy)" : `ivec2(${tiled ? `floor(uCenter / (cs * ${SLOTS}.0)) * ${SLOTS}.0` : "floor(uCenter / cs)"} + aCell.xy)`};
  uint L = uint(lvl) * 16u + 3u;
  vec2 bpos = (vec2(cell) + vec2(h01(cell, L + 1u), h01(cell, L + 2u))) * cs;
  float d = length(bpos - uCenter);
  float rOut = ${GR0}.0 * exp2(lvl), rIn = ${GR0}.0 * exp2(lvl - 1.0);
  float keep = ${fixed ? "1.0" : "(1.0 - smoothstep(0.8 * rOut, rOut, d)) * (lvl < 0.5 ? 1.0 : smoothstep(0.8 * rIn, rIn, d))"};
  float alive = step(h01(cell, L + 3u), keep);
  float jit = 0.75 + 0.5 * h01(cell, L + 4u);
  float sz = ${GRASS_H} * jit * ${tiled ? "1.0" : "(1.0 + 0.25 * lvl)"};   // (a phone: taller rings further out read as a meadow)
  float sxy = 1.5 * ${GRASS_H} * jit * ${fixed ? "max(1.0, cs / 1.6)" : `exp2(${tiled ? TILED_SPREAD.toFixed(2) : "0.85"} * lvl)`}; // spread wider where the clumps are further apart
  float rr = length(bpos);
  alive *= 1.0 - step(uArena - 0.5 * sxy, rr);                 // grass only inside the arena
  // Down the pond's banks it follows the ground; it stops where the mud and water begin.
  float g0 = leafTop(bpos), base = 0.0;
  if (g0 < 0.0) { base = g0; alive *= step(uWaterLine + 2.5, g0); }
  alive *= step(uHole + 12.0 + 0.5 * sxy, rr); // keep complete asset clumps on dry ground
  for (int i = 0; i < ${MAX_EXCL}; i++) { if (i >= uNExcl) break; if (distance(bpos, uExcl[i].xy) < uExcl[i].z + 0.4 * sxy) alive = 0.0; }
  float yaw = h01(cell, L + 5u) * 6.2832;
  mat3 R = mat3(cos(yaw), sin(yaw), 0.0, -sin(yaw), cos(yaw), 0.0, 0.0, 0.0, 1.0);
  float hue = h01(cell, L + 6u);
  vTint = mix(vec3(1.0, 1.12, 0.95), vec3(1.2, 1.14, 0.85), hue) * (1.0 + 0.3 * h01(cell, L + 7u));
  vH = position.z;
  vWet = 1.0 - smoothstep(0.0, 6.0, base - uWaterLine);        // at the water's edge: wet and dark`)
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = R * normal;")
      .replace("#include <begin_vertex>", `
  vec3 transformed = alive > 0.5 ? R * (position * vec3(sxy, sxy, sz)) + vec3(bpos, base) : vec3(0.0);`)
      .replace("#include <project_vertex>", `
  if (alive > 0.5) {
    float h = transformed.z;
    // Pressed where the fly's body and legs are: an ellipse around it, capped just under its belly.
    vec2 o = transformed.xy - uFly.xy;
    float a = dot(o, uFlyDir), b = dot(o, vec2(-uFlyDir.y, uFlyDir.x));
    float e = a * a / 2.1 + b * b / 1.3;
    float cap = uFly.z + 0.22 + max(0.0, e - 0.7) * 8.0;
    if (transformed.z > cap) { float ex = transformed.z - cap; transformed.z = cap; transformed.xy += normalize(o + 1e-4) * ex * 0.7; }
    // And under each frog: its body and folded legs flatten the grass, which leans out around it.
    for (int k = 0; k < ${MAX_FROGS}; k++) {
      vec4 F = uFrog[k];
      if (F.w <= 0.0) continue;
      vec2 q = transformed.xy - F.xy, fd = vec2(cos(F.z), sin(F.z));
      float fa = dot(q, fd) / (0.62 * F.w), fb = dot(q, vec2(-fd.y, fd.x)) / (0.5 * F.w);
      float fe = fa * fa + fb * fb;
      float fcap = uFrogZ[k] + 0.12 + max(0.0, fe - 0.8) * F.w * 0.9;
      if (transformed.z > fcap) { float ex = transformed.z - fcap; transformed.z = fcap; transformed.xy += normalize(q + 1e-4) * ex * 0.65; }
    }
    // A leaf or a stone is solid: grass stays underneath it.
    float lz = leafTop(transformed.xy);
    if (lz > 0.01 && transformed.z > lz - 0.06) transformed.z = max(0.01, lz - 0.06);
    float sw = vH * vH;
    transformed.x += sin(uTime * 1.7 + transformed.y * 0.35) * 0.2 * sw;
    transformed.y += cos(uTime * 1.3 + transformed.x * 0.3) * 0.14 * sw;
    // Raindrops flatten the blades they hit, which then spring back.
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      float age = uSimT - uImp[i].z;
      if (age < 0.0 || age > 0.8 || uImp[i].w <= 0.0) continue;
      vec2 q = transformed.xy - uImp[i].xy;
      float Rr = 0.5 * uImp[i].w + 0.35;
      float f = exp(-dot(q, q) / (Rr * Rr)) * exp(-age / 0.15) * cos(age * 35.0);
      float hz = transformed.z;
      transformed.z -= hz * 0.85 * clamp(f, -0.3, 1.0);
      transformed.xy += normalize(q + 1e-4) * hz * 0.6 * max(f, 0.0);
    }
  }
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = "varying float vH;\nvarying float vWet;\nvarying vec3 vTint;\n" + shader.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  diffuseColor.rgb *= vTint * mix(0.7, 1.15, smoothstep(0.0, 0.6, vH)); // shaded low in the clump
  diffuseColor.rgb *= mix(1.0, 0.68, vWet * (1.0 - 0.6 * vH));             // wet at the water's edge`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.35, vWet);`);
  };
  return m;
}

export class Terrain {
  constructor(scene, radius) {
    this.radius = radius;
    this.exclusions = [];
    this.impacts = Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4(0, 0, -99, 0));
    this.nextImpact = 0;
    this.simT = 0;
    const box = radius + 8;
    this.leafBox = { x: -box, y: -box, size: 2 * box };
    this.leafHeights = null; // CPU copy of the baked leaf height map
    this.uniforms = {
      uTime: { value: 0 }, uSimT: { value: 0 },
      uFly: { value: new THREE.Vector3(0, 0, 0) }, uFlyDir: { value: new THREE.Vector2(1, 0) },
      uImp: { value: this.impacts },
      uCenter: { value: new THREE.Vector2() }, uArena: { value: radius + 1 },
      uExcl: { value: Array.from({ length: MAX_EXCL }, () => new THREE.Vector3()) }, uNExcl: { value: 0 },
      uLeaf: { value: null }, uLeafBox: { value: new THREE.Vector3(-box, -box, 2 * box) },
      uFrog: { value: Array.from({ length: MAX_FROGS }, () => new THREE.Vector4()) },
      uFrogZ: { value: new Array(MAX_FROGS).fill(0) },
      uHole: { value: -1 },
      uWaterLine: { value: -1.4 },
    };
    this._ray = new THREE.Raycaster(undefined, undefined, 0, 40);
    this.group = new THREE.Group(); // toggled as a whole by the floor switch
    scene.add(this.group);
    scene = this.group;

    this.floor = new THREE.Mesh(new THREE.CircleGeometry(radius, 128),
      new THREE.MeshStandardMaterial({ map: soilTexture(16), roughness: 1 }));
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    this.blades = new THREE.Mesh(bladeGeometry(), grassMaterial(this.uniforms));
    this.blades.receiveShadow = true;
    this.blades.frustumCulled = false;
    this.blades.visible = false; // only the grass model's lawn is ever shown (forest.js); never these placeholder blades
    scene.add(this.blades);

    this._addWeeds(scene);
  }

  get bladeCount() {
    return this.blades.geometry.instanceCount;
  }

  /**
   * Cover the floor with clumps of a grass model instead of the generated blades.
   * variants: { near, mid, far } BufferGeometries; maps: { map, normalMap }.
   */
  /**
   * The lawn from a grass model. `variants`: {near, mid, far} clump geometries, one per ring
   * (a phone); or {mix: [{levels, keep, mix: [[geometry, weight], ...]}, ...], refH} to mix
   * all the model's clumps through each ring, each at its own size (a computer).
   */
  useGrassModel(variants, maps, cell = 1.9) {
    GC0 = cell;
    const tiled = !!variants.mix;
    const mat = clumpMaterial(this.uniforms, maps, tiled);
    // Far rings are small on screen: their clumps keep about a third of their blades.
    const parts = [];
    if (!tiled) {
      for (const [src, levels, keep] of [[variants.near, [0], 1], [variants.mid, [1], 1], [variants.far, [2], 1], [variants.far, [3, 4, 5], 0.35]])
        parts.push(clumpGeometry(src, levels, keep));
    } else {
      let seed = 99;
      const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (const group of variants.mix) {
        // share the 64 cells of the tiling out by weight, in a shuffled order
        const order = [...Array(SLOTS * SLOTS).keys()].sort(() => rand() - 0.5);
        const total = group.mix.reduce((a, [, w]) => a + w, 0);
        let at = 0;
        group.mix.forEach(([src, w], i) => {
          const n = i === group.mix.length - 1 ? SLOTS * SLOTS - at : Math.max(1, Math.round((w / total) * SLOTS * SLOTS));
          const slots = new Set(order.slice(at, at + n));
          at += n;
          if (slots.size && src) parts.push(clumpGeometry(src, group.levels, group.keep ?? 1, slots, variants.refH));
        });
      }
    }
    this.clumps = parts.map((geo) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    });
    this.group.remove(this.blades);
  }

  /**
   * The whole lawn at one density, fixed to the ground: one clump per `cell` mm square over
   * the entire arena, the same everywhere, wherever the fly or the camera is. `mix`:
   * [[geometry, weight], ...], each clump at its size relative to `refH`, keeping `keep` of
   * its blades. No clumps inside `holeR` (the pond); those within `nearR` of the centre
   * are separate meshes (marked nearPond), so only they need drawing in the reflection.
   */
  useLawn({ mix, refH = 0, keep = 1, holeR = 0, nearR = 0 }, maps, cell) {
    GC0 = cell;
    const mat = clumpMaterial(this.uniforms, maps, false, true);
    const total = mix.reduce((a, [, w]) => a + w, 0);
    const near = mix.map(() => []), far = mix.map(() => []);
    const R = this.radius, n = Math.ceil(R / cell);
    const hash = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7 + 0.5) * 43758.5453; return v - Math.floor(v); };
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const rr = Math.hypot(i + 0.5, j + 0.5) * cell;
      if (rr > R + cell || rr < holeR) continue;
      let w = hash(i, j) * total, k = 0;
      while (k < mix.length - 1 && w >= mix[k][1]) { w -= mix[k][1]; k++; }
      (rr < nearR ? near : far)[k].push(i, j, 0);
    }
    this.clumps = [];
    mix.forEach(([src], k) => {
      if (!src) return;
      const base = clumpBase(src, keep, refH);
      if (!base.getIndex()?.count) return;
      for (const [cells, nearPond] of [[near[k], true], [far[k], false]]) {
        if (!cells.length) continue;
        const mesh = new THREE.Mesh(instanced(base, cells), mat);
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.userData.nearPond = nearPond;
        this.group.add(mesh);
        this.clumps.push(mesh);
      }
    });
    this.group.remove(this.blades);
  }

  /** A round hole in the floor (for the pond's basin), with no grass or weeds inside it. */
  cutHole(r) {
    const R = this.radius, shape = new THREE.Shape().absarc(0, 0, R, 0, Math.PI * 2, false);
    shape.holes.push(new THREE.Path().absarc(0, 0, r, 0, Math.PI * 2, true));
    const g = new THREE.ShapeGeometry(shape, 96);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (2 * R) + 0.5, p.getY(i) / (2 * R) + 0.5); // as the disc's
    this.floor.geometry.dispose();
    this.floor.geometry = g;
    Object.assign(this.floor.material, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    this.uniforms.uHole.value = r;
    this.clearWeeds([{ x: 0, y: 0, r }]);
  }

  /** Frogs pressing the grass: [{x, y, heading (rad), length, lift (belly above ground)}]. */
  setFrogs(list) {
    for (let i = 0; i < MAX_FROGS; i++) {
      const f = list[i];
      if (f) this.uniforms.uFrog.value[i].set(f.x, f.y, f.heading, f.length);
      else this.uniforms.uFrog.value[i].set(0, 0, 0, 0);
      this.uniforms.uFrogZ.value[i] = f ? f.lift : 0;
    }
  }

  _addWeeds(scene) {
    const r = rng(7);
    const kinds = [
      { geo: cloverGeometry(), color: 0x3f7a2e, n: 160, scale: [0.8, 1.3], hue: [0.27, 0.32] },
      { geo: dandelionGeometry(), color: 0x4d7f2c, n: 22, scale: [0.7, 1.2], hue: [0.22, 0.27] },
      { geo: seedlingGeometry(), color: 0x6aa13a, n: 260, scale: [0.7, 1.4], hue: [0.22, 0.3] },
      // Two lucky ones, somewhere new every visit.
      { geo: cloverGeometry(4), color: 0x3f7a2e, n: 2, scale: [1.05, 1.15], hue: [0.28, 0.3], lucky: true },
    ];
    this.weeds = [];
    this.weedMeshes = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    for (const k of kinds) {
      const mesh = new THREE.InstancedMesh(k.geo, leafMaterial(k.color, this.uniforms), k.n);
      for (let i = 0; i < k.n; i++) {
        // Uniform in the disc, clear of the wall.
        const rad = Math.sqrt(r()) * (this.radius - 8), a = r() * 2 * Math.PI;
        const [x, y] = k.lucky ? this._luckySpot() : [rad * Math.cos(a), rad * Math.sin(a)];
        const s = k.scale[0] + r() * (k.scale[1] - k.scale[0]);
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), r() * 2 * Math.PI);
        m.compose(new THREE.Vector3(x, y, 0), q, new THREE.Vector3(s, s, s));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, c.setHSL(k.hue[0] + r() * (k.hue[1] - k.hue[0]), 0.3 + r() * 0.2, 0.6 + r() * 0.2));
        this.weeds.push({ x, y, r: 3 * s });
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.weedMeshes.push(mesh);
    }
  }

  // Remove the weeds inside these circles ({x, y, r}: where stones sit).
  clearWeeds(circles) {
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const mesh of this.weedMeshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        if (circles.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < c.r + 1)) mesh.setMatrixAt(i, zero);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.weeds = this.weeds.filter((w) => !circles.some((c) => Math.hypot(c.x - w.x, c.y - w.y) < c.r + 1));
  }

  // A random spot in the arena (not the seeded layout) clear of the other weeds' leaves.
  _luckySpot() {
    for (let tries = 0; ; tries++) {
      const rad = Math.sqrt(Math.random()) * (this.radius - 8), a = Math.random() * 2 * Math.PI;
      const x = rad * Math.cos(a), y = rad * Math.sin(a);
      if (tries > 200 || this.weeds.every((w) => Math.hypot(w.x - x, w.y - y) > w.r + 3)) return [x, y];
    }
  }

  // Render the weeds (and the stones and moss: this.solids, see forest.js) from straight
  // above into a height map (top surface z, packed into two 8-bit channels at 2 um steps,
  // up to 131 mm). The grass shader reads it on the GPU; rain and
  // snow read the CPU copy.
  bake(renderer) {
    const { x, y, size } = this.leafBox;
    const rt = new THREE.WebGLRenderTarget(HMAP, HMAP, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: `varying float vZ;
        void main() {
          vec4 p = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            p = instanceMatrix * p;
          #endif
          p = modelMatrix * p;
          vZ = p.z;
          gl_Position = projectionMatrix * viewMatrix * p;
        }`,
      fragmentShader: `varying float vZ;
        void main() {
          float v = clamp(floor((vZ + ${HZ0}.0) * 500.0 + 0.5), 1.0, 65535.0); // 0 = nothing there
          gl_FragColor = vec4(floor(v / 256.0) / 255.0, mod(v, 256.0) / 255.0, 0.0, 1.0);
        }`,
    });
    const bakeScene = new THREE.Scene();
    for (const w of this.weedMeshes) {
      const copy = new THREE.InstancedMesh(w.geometry, mat, w.count);
      copy.instanceMatrix = w.instanceMatrix;
      copy.frustumCulled = false;
      bakeScene.add(copy);
    }
    this.group.updateMatrixWorld(true);
    for (const s of this.solids || []) {
      const copy = new THREE.Mesh(s.geometry, mat);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(s.matrixWorld);
      copy.frustumCulled = false;
      bakeScene.add(copy);
    }
    const cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0.1, 100);
    cam.position.set(x + size / 2, y + size / 2, 60); // looking straight down, +y up in the image
    cam.lookAt(x + size / 2, y + size / 2, 0);
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(bakeScene, cam);
    const buf = new Uint8Array(HMAP * HMAP * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, HMAP, HMAP, buf);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.toneMapping = prevTone;
    const hm = new Float32Array(HMAP * HMAP);
    for (let i = 0; i < hm.length; i++) { const v = buf[4 * i] * 256 + buf[4 * i + 1]; hm[i] = v ? v / 500 - HZ0 : 0; }
    this.leafHeights = hm;
    this.uniforms.uLeaf.value = rt.texture;
    mat.dispose();
  }

  // Height of the top of any weed at (x, y), from the baked map; 0 where there is none.
  leafHeightAt(x, y) {
    if (!this.leafHeights) return 0;
    const { x: x0, y: y0, size } = this.leafBox;
    const i = Math.floor(((x - x0) / size) * HMAP), j = Math.floor(((y - y0) / size) * HMAP);
    if (i < 0 || j < 0 || i >= HMAP || j >= HMAP) return 0;
    return this.leafHeights[j * HMAP + i];
  }

  // Top of everything at (x, y) that rain or snow can land on: leaves, stones, the pond's
  // water, or the turf.
  topAt(x, y) {
    if (!this.group.visible || x * x + y * y > this.radius * this.radius) return 0;
    const h = this.leafHeightAt(x, y);
    return h < 0 ? h : Math.max(TURF_TOP + 0.2, h);
  }

  // Where feet rest at (x, y): the turf, or anything on it, or down in the pond.
  groundAt(x, y) {
    if (!this.group.visible) return 0;
    const h = this.leafHeightAt(x, y);
    return h < 0 ? h : Math.max(TURF_TOP, h);
  }

  // A raindrop landed: the grass and leaves there react (see the shaders).
  addImpact(x, y, t, D) {
    this.impacts[this.nextImpact].set(x, y, t, D);
    this.nextImpact = (this.nextImpact + 1) % MAX_IMPACTS;
  }

  // Same leaf bob as the shader, for a fly standing on a leaf.
  leafBobAt(x, y, z) {
    let dz = 0;
    for (const im of this.impacts) {
      const age = this.simT - im.z;
      if (age < 0 || age > 1 || im.w <= 0) continue;
      const q2 = (x - im.x) ** 2 + (y - im.y) ** 2;
      dz -= 0.12 * im.w * Math.exp(-q2 / 9) * Math.exp(-age / 0.18) * Math.cos(age * 50);
    }
    const s = Math.min(1, Math.max(0, (z - 0.3) / 1.2));
    return dz * s * s * (3 - 2 * s);
  }

  // Keep blades out of food drops and from under odor sources.
  setExclusions(list) {
    this.exclusions = list.slice(0, MAX_EXCL);
    this.exclusions.forEach((e, i) => this.uniforms.uExcl.value[i].set(e.x, e.y, e.r));
    this.uniforms.uNExcl.value = this.exclusions.length;
  }

  // Where a fly at (x, y) stands: the top walkable leaf, or the matted turf.
  // Returns {z, normal} in world coordinates.
  surfaceAt(x, y) {
    const turf = { z: TURF_TOP, normal: new THREE.Vector3(0, 0, 1) };
    if (!this.group.visible) return { z: 0, normal: turf.normal };
    this._ray.set(new THREE.Vector3(x, y, 30), new THREE.Vector3(0, 0, -1));
    for (const hit of this._ray.intersectObjects(this.weedMeshes, false)) {
      const n = hit.face.normal.clone();
      if (hit.instanceId !== undefined) {
        const im = new THREE.Matrix4();
        hit.object.getMatrixAt(hit.instanceId, im);
        n.transformDirection(im);
      }
      n.transformDirection(hit.object.matrixWorld);
      if (n.z < 0) n.negate(); // leaves are double-sided
      if (n.z > 0.45 && hit.point.z > turf.z) return { z: hit.point.z, normal: n };
    }
    return turf;
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v) {
    this.group.visible = v;
  }

  // Per frame: time, where the fly is and where its feet are, which way it faces.
  update(x, y, timeS, feetZ = 0, headingDeg = 0, simT = 0, camera = null, focus = null) {
    this.simT = simT;
    this.uniforms.uTime.value = timeS;
    this.uniforms.uSimT.value = simT;
    this.uniforms.uFly.value.set(x, y, feetZ);
    const h = (headingDeg * Math.PI) / 180;
    this.uniforms.uFlyDir.value.set(Math.cos(h), Math.sin(h));
    // Finest grass where the camera looks (the fly, or a frog it follows), leaning toward a
    // nearby camera so both are in it.
    const fx = focus ? focus.x : x, fy = focus ? focus.y : y;
    const c = this.uniforms.uCenter.value.set(fx, fy);
    if (camera) {
      const dx = camera.position.x - fx, dy = camera.position.y - fy, d = Math.hypot(dx, dy);
      const k = Math.min(0.5, 12 / Math.max(d, 1e-3));
      c.set(fx + dx * k, fy + dy * k);
    }
  }
}
