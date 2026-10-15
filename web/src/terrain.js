// Grass floor and small weeds for the arena, at true scale for a 2.5 mm fly (units: mm).
//
// Blades are generated on the GPU: each instance is a cell offset in one of several
// nested level-of-detail rings around the fly (cells double in size per ring), and the
// vertex shader places the blade at a hashed spot in that world cell. Every blade has a
// fixed place in the world, nothing is rebuilt on the CPU as the fly moves, and grass
// reaches the horizon. The same shader bends blades only where the fly's body and legs
// actually press them, keeps them under any leaf lying on the turf (from a baked height
// map of the weeds) and knocks them down where raindrops hit.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const TURF_TOP = 0.35; // a fly walks on the matted turf, about this high (mm)
const C0 = 0.29;              // level-0 cell size (mm): 12 blades per mm^2 next to the fly
const R0 = 16;                // radius of level 0; level L reaches R0 * 2^L
const LEVELS = 5;             // out to 256 mm
const GROUND = 520;           // radius of the outdoor ground disc
const MAX_IMPACTS = 16;       // raindrop impacts the shaders animate at once
const MAX_EXCL = 16;
const HMAP = 1024;            // leaf height map resolution over the arena

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
  const pos = [], col = [], idx = [];
  levels.forEach((t, i) => {
    const w = widths[i] / 2, bend = 0.35 * t * t;
    pos.push(-w, bend, t, w, bend, t);
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

// Grass blades: place each instance, then press, clamp under leaves, sway and splash.
function grassMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = GLSL_COMMON + `
attribute vec3 aCell;
uniform vec2 uCenter;
uniform float uArena;
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
  return (t.r * 65280.0 + t.g * 255.0) / 2500.0;
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
  alive *= step(rr, ${GROUND - 4}.0) * (1.0 - step(uArena - 1.2, rr) * step(rr, uArena + 2.5));
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
  vColor = color * pow(bc, vec3(2.2));`)
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
  };
  return m;
}

// Weed leaves: a faint breeze, and a bob where a raindrop lands (the base stays put).
function leafMaterial(color, u) {
  const m = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.7 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = GLSL_COMMON + shader.vertexShader.replace("#include <project_vertex>", `
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
function placed(shape, { yaw = 0, lift = 0, z = 0, droop = 0 } = {}) {
  const g = new THREE.ShapeGeometry(shape, 6);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, -droop * x * x); // leaf tips curve down
  }
  g.rotateY(-lift);
  g.rotateZ(yaw);
  g.translate(0, 0, z);
  g.computeVertexNormals();
  return g;
}

function stem(h, r = 0.12) {
  const g = new THREE.CylinderGeometry(r * 0.7, r, h, 5);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, h / 2);
  return g;
}

function cloverGeometry() {
  const h = 3.5;
  const parts = [stem(h, 0.15)];
  for (let k = 0; k < 3; k++) parts.push(placed(heartLeaflet(3.2), { yaw: (k * 2 * Math.PI) / 3, lift: 0.15, z: h, droop: 0.03 }));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function dandelionGeometry() {
  const parts = [];
  for (let k = 0; k < 11; k++) {
    const len = 14 + (k % 4) * 3;
    parts.push(placed(leafShape(len, 2.6, 1), { yaw: (k * 2 * Math.PI) / 11 + 0.2 * Math.sin(k * 3), lift: 0.06, z: 0.15, droop: 0.001 }));
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
    };
    this._ray = new THREE.Raycaster(undefined, undefined, 0, 40);
    this.group = new THREE.Group(); // toggled as a whole by the floor switch
    scene.add(this.group);
    scene = this.group;

    // Outdoors the ground carries on past the glass wall to the horizon.
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(GROUND, 160),
      new THREE.MeshStandardMaterial({ map: soilTexture(16 * GROUND / radius), roughness: 1 }));
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    this.blades = new THREE.Mesh(bladeGeometry(), grassMaterial(this.uniforms));
    this.blades.receiveShadow = true;
    this.blades.frustumCulled = false;
    scene.add(this.blades);

    this._addWeeds(scene);
  }

  get bladeCount() {
    return this.blades.geometry.instanceCount;
  }

  _addWeeds(scene) {
    const r = rng(7);
    const kinds = [
      { geo: cloverGeometry(), color: 0x3f7a2e, n: 160, scale: [0.8, 1.3], hue: [0.27, 0.32] },
      { geo: dandelionGeometry(), color: 0x4d7f2c, n: 22, scale: [0.7, 1.2], hue: [0.22, 0.27] },
      { geo: seedlingGeometry(), color: 0x6aa13a, n: 260, scale: [0.7, 1.4], hue: [0.22, 0.3] },
    ];
    this.weeds = [];
    this.weedMeshes = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    for (const k of kinds) {
      const mesh = new THREE.InstancedMesh(k.geo, leafMaterial(k.color, this.uniforms), k.n);
      for (let i = 0; i < k.n; i++) {
        // Uniform in the disc, clear of the wall.
        const rad = Math.sqrt(r()) * (this.radius - 8), a = r() * 2 * Math.PI;
        const x = rad * Math.cos(a), y = rad * Math.sin(a);
        const s = k.scale[0] + r() * (k.scale[1] - k.scale[0]);
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), r() * 2 * Math.PI);
        m.compose(new THREE.Vector3(x, y, 0), q, new THREE.Vector3(s, s, s));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, c.setHSL(k.hue[0] + r() * (k.hue[1] - k.hue[0]), 0.45 + r() * 0.2, 0.75 + r() * 0.35));
        this.weeds.push({ x, y, r: 3 * s });
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.weedMeshes.push(mesh);
    }
  }

  // Render the weeds from straight above into a height map (top surface z, packed into
  // two 8-bit channels at 0.4 um steps). The grass shader reads it on the GPU; rain and
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
          float v = clamp(floor(vZ * 2500.0 + 0.5), 0.0, 65535.0);
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
    for (let i = 0; i < hm.length; i++) hm[i] = (buf[4 * i] * 256 + buf[4 * i + 1]) / 2500;
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

  // Top of everything at (x, y) that rain or snow can land on: leaves, or the turf.
  topAt(x, y) {
    if (!this.group.visible) return 0;
    return Math.max(TURF_TOP + 0.2, this.leafHeightAt(x, y));
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
  update(x, y, timeS, feetZ = 0, headingDeg = 0, simT = 0) {
    this.simT = simT;
    this.uniforms.uTime.value = timeS;
    this.uniforms.uSimT.value = simT;
    this.uniforms.uFly.value.set(x, y, feetZ);
    const h = (headingDeg * Math.PI) / 180;
    this.uniforms.uFlyDir.value.set(Math.cos(h), Math.sin(h));
    this.uniforms.uCenter.value.set(x, y);
  }
}
