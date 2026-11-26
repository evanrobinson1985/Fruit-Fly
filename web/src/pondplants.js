// Cattails and water-lily pads modelled in 3D. The pond model (pond.glb) draws them as flat
// painted cards, which look like cut-outs from a fly's height; here every card is taken out
// and a modelled plant goes in its place: cattails with arching, twisting, folded leaves and
// velvety brown spikes on their stalks, and lily pads with their notch, upturned rim, radial
// veins, waxy sheen and stalks down to the bed. The rushes and flowers stay as they are.
import * as THREE from "three";
import { reflectable, underwater, LAYER_UNDER } from "./water.js";

const NOISE = `
float pH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float pN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(pH(i), pH(i + vec3(1,0,0)), f.x), mix(pH(i + vec3(0,1,0)), pH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(pH(i + vec3(0,0,1)), pH(i + vec3(1,0,1)), f.x), mix(pH(i + vec3(0,1,1)), pH(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float pF(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * pN(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
vec3 pBump(vec3 pos, vec3 n, vec2 dH, float face) {
  vec3 sx = normalize(dFdx(pos)), sy = normalize(dFdy(pos));
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * face;
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`;

// Grows geometry: positions, colours, a uv-like pair and a sway (amplitude, phase) per vertex.
class Builder {
  constructor() { this.p = []; this.c = []; this.u = []; this.s = []; this.i = []; }
  get n() { return this.p.length / 3; }
  v(x, y, z, col, u, v, amp = 0, ph = 0) { this.p.push(x, y, z); this.c.push(col.r, col.g, col.b); this.u.push(u, v); this.s.push(amp, ph); return this.n - 1; }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute("aUv", new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute("aSway", new THREE.Float32BufferAttribute(this.s, 2));
    g.setIndex(this.i);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const swayVertex = (sh, shared) => {
  Object.assign(sh.uniforms, shared);
  sh.vertexShader = "uniform float uWTime; attribute vec2 aSway; attribute vec2 aUv; varying vec2 vP; varying vec3 vObj;\n" + sh.vertexShader
    .replace("#include <begin_vertex>", `#include <begin_vertex>
  vP = aUv; vObj = position;
  transformed.x += sin(uWTime * 1.15 + aSway.y) * aSway.x + sin(uWTime * 2.9 + aSway.y * 3.1) * aSway.x * 0.18;
  transformed.y += cos(uWTime * 0.83 + aSway.y * 1.7) * aSway.x * 0.65;`);
  sh.fragmentShader = "varying vec2 vP; varying vec3 vObj;\n" + NOISE + sh.fragmentShader;
};

// ---------- cattails ----------
function cattail(B, S, x, y, z, H, r, leafCount) {
  const col = new THREE.Color(), up = new THREE.Vector3(0, 0, 1);
  const phase = r() * 6.28, swayAt = (h) => Math.pow(Math.max(0, h) / H, 2) * H * 0.035;
  // leaves: long, strap-like, folded along the midrib, leaning out and arching over at the tip
  const nL = leafCount + Math.floor(r() * 4), fan = r() * Math.PI;
  for (let l = 0; l < nL; l++) {
    // cattail leaves come up in a flattened fan, two ranks facing each other
    const a = fan + (l % 2) * Math.PI + (r() - 0.5) * 1.1;
    const L = H * (0.62 + r() * 0.45), W = H * (0.017 + r() * 0.01);
    const lean = 0.04 + r() * 0.22, droop = r() < 0.35 ? 0.6 + r() * 1.1 : 0.1 + r() * 0.35, twist = (r() - 0.5) * 2.4;
    const hue = 0.2 + r() * 0.06, sat = 0.38 + r() * 0.18, lit = 0.2 + r() * 0.09, browned = r() < 0.3;
    const out = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    const p = new THREE.Vector3(x + out.x * W * 0.4, y + out.y * W * 0.4, z - H * 0.02);
    const segs = 18, rows = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, th = lean + droop * t * t;
      const tan = new THREE.Vector3().copy(out).multiplyScalar(Math.sin(th)).addScaledVector(up, Math.cos(th)).normalize();
      // the blade's flat side faces along the fan; twisted along its length
      let side = new THREE.Vector3(-out.y, out.x, 0).applyAxisAngle(tan, twist * t);
      side.sub(tan.clone().multiplyScalar(side.dot(tan))).normalize();
      const nrm = new THREE.Vector3().crossVectors(side, tan);
      const w = W * Math.min(1, 0.55 + t * 6) * Math.pow(1 - t, 0.55) * 0.5;
      // colour: pale sheath at the base, green blade, yellowing or brown at the tip
      col.setHSL(hue, sat, lit);
      if (t < 0.12) col.lerp(new THREE.Color().setHSL(0.15, 0.3, 0.52), 1 - t / 0.12);
      if (t > 0.75) col.lerp(browned ? new THREE.Color(0.36, 0.27, 0.14) : new THREE.Color().setHSL(0.16, 0.45, 0.36), (t - 0.75) / 0.25 * (browned ? 0.9 : 0.5));
      const amp = swayAt(p.z - z), fold = w * 0.35;
      const m = p.clone().addScaledVector(nrm, -fold);
      rows.push([
        B.v(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w, col, 0, t, amp, phase),
        B.v(m.x, m.y, m.z, col, 0.5, t, amp, phase),
        B.v(p.x + side.x * w, p.y + side.y * w, p.z + side.z * w, col, 1, t, amp, phase),
      ]);
      p.addScaledVector(tan, L / segs);
    }
    for (let i = 0; i < segs; i++) {
      const [a0, b0, c0] = rows[i], [a1, b1, c1] = rows[i + 1];
      B.quad(a0, b0, b1, a1); B.quad(b0, c0, c1, b1);
    }
  }
  // flower stalks: a round stem with the brown spike near the top, the thin male spike above
  const nS = r() < 0.55 ? 1 : r() < 0.7 ? 2 : 0;
  for (let s = 0; s < nS; s++) {
    const h = H * (0.82 + r() * 0.25), rs = H * 0.0065, a = r() * 6.28, lean = r() * 0.07;
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(lean), Math.sin(a) * Math.sin(lean), Math.cos(lean));
    const at = (f) => new THREE.Vector3(x, y, z).addScaledVector(dir, h * f).add(new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(h * 0.03 * f * f));
    const ring = (geo, f, rad, c, sides, u) => {
      const o = at(f), k = [];
      for (let j = 0; j <= sides; j++) {
        const q = (j / sides) * Math.PI * 2;
        k.push(geo.v(o.x + Math.cos(q) * rad, o.y + Math.sin(q) * rad, o.z, c, j / sides, u, swayAt(o.z - z), phase));
      }
      return k;
    };
    const tube = (geo, rings) => {
      for (let i = 0; i + 1 < rings.length; i++) for (let j = 0; j + 1 < rings[i].length; j++)
        geo.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
    };
    const f0 = 0.66 + r() * 0.06, len = 0.12 + r() * 0.05, R = H * (0.017 + r() * 0.005);
    // the stem, all the way up through the spike
    const stemCol = new THREE.Color().setHSL(0.21, 0.35, 0.3), stem = [];
    for (let i = 0; i <= 16; i++) stem.push(ring(B, (i / 16), rs * (1 - 0.5 * i / 16), stemCol, 6, i / 16));
    tube(B, stem);
    // the female spike: dark brown, velvety, rounded at both ends
    const brown = new THREE.Color().setHSL(0.06 + r() * 0.02, 0.5, 0.15 + r() * 0.05), sp = [];
    for (let i = 0; i <= 14; i++) {
      const u = i / 14, rad = R * Math.pow(Math.sin(Math.PI * (0.03 + 0.94 * u)), 0.4);
      sp.push(ring(S, f0 + len * u, rad, brown, 14, u));
    }
    tube(S, sp);
    // the male spike above it, thin and straw-coloured (bare in older heads)
    const male = new THREE.Color().setHSL(0.1, 0.4, 0.42), ms = [], f1 = f0 + len + 0.012, ml = 0.08 + r() * 0.05;
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      ms.push(ring(S, f1 + ml * u, H * 0.0085 * Math.pow(Math.sin(Math.PI * (0.05 + 0.9 * u)), 0.5), male, 8, u));
    }
    tube(S, ms);
  }
}

function cattailMaterials(shared, high) {
  const leaf = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
  leaf.onBeforeCompile = (sh) => {
    swayVertex(sh, shared);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  // fine parallel veins along the blade, a paler midrib and a little mottling
  float vein = pow(abs(sin(vP.x * 3.14159 * 9.0)), 6.0);
  diffuseColor.rgb *= 0.9 + 0.1 * vein;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.25, (1.0 - smoothstep(0.0, 0.06, abs(vP.x - 0.5))) * 0.6);
  diffuseColor.rgb *= 0.85 + 0.3 * pF(vObj * vec3(1.5, 1.5, 0.2));`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  float hv = vein * 0.6;
  normal = pBump(-vViewPosition, normal, vec2(dFdx(hv), dFdy(hv)) * 0.5, faceDirection);`)
      .replace("#include <opaque_fragment>", `
  // light through the thin blade
  outgoingLight += diffuseColor.rgb * vec3(0.9, 1.0, 0.55) * 0.12;
  #include <opaque_fragment>`);
  };
  const spike = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  spike.onBeforeCompile = (sh) => {
    swayVertex(sh, shared);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  // densely packed seed hairs: fine speckle, darker flecks
  float fz = pF(vObj * 9.0), fl = pN(vObj * 26.0);
  diffuseColor.rgb *= 0.7 + 0.55 * fz;
  diffuseColor.rgb *= 0.85 + 0.3 * fl;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  normal = pBump(-vViewPosition, normal, vec2(dFdx(fl), dFdy(fl)) * 0.35, faceDirection);`)
      .replace("#include <opaque_fragment>", `
  // velvet: a soft sheen at grazing angles
  float rim = 1.0 - abs(dot(normal, normalize(vViewPosition)));
  outgoingLight += diffuseColor.rgb * pow(rim, 2.5) * 0.9;
  #include <opaque_fragment>`);
  };
  return { leaf, spike };
}

// ---------- water-lily pads ----------
function lilyPad(B, cx, cy, z, R, rot, r) {
  const g = 0.07 + r() * 0.05; // half-width of the notch, radians
  const na = 56, nr = 8, wav = r() * 6.28, edgeUp = R * (0.02 + r() * 0.03);
  const top = new THREE.Color().setHSL(0.27 + r() * 0.04, 0.42 + r() * 0.15, 0.2 + r() * 0.07);
  const under = new THREE.Color().setHSL(0.97, 0.45, 0.22);
  const shape = (f, q) => [cx + Math.cos(q + rot) * f * R, cy + Math.sin(q + rot) * f * R,
    z + edgeUp * Math.pow(f, 4) + R * 0.012 * Math.sin(5 * q + wav) * f * f * f];
  const T = [], U = [], thick = R * 0.035;
  for (let i = 0; i <= nr; i++) {
    const f = i / nr, rowT = [], rowU = [];
    for (let j = 0; j <= na; j++) {
      const q = g + (j / na) * (Math.PI * 2 - 2 * g);
      const [x, y, zz] = shape(f, q);
      rowT.push(B.v(x, y, zz, top, f, (q - Math.PI) / Math.PI));
      rowU.push(B.v(x, y, zz - thick, under, f, -9));
    }
    T.push(rowT); U.push(rowU);
  }
  for (let i = 0; i < nr; i++) for (let j = 0; j < na; j++) {
    B.quad(T[i][j], T[i + 1][j], T[i + 1][j + 1], T[i][j + 1]);
    B.quad(U[i][j], U[i][j + 1], U[i + 1][j + 1], U[i + 1][j]);
  }
  // the cut edge all round: one side of the notch, the rim, back down the other side
  const loop = [];
  for (let i = 0; i <= nr; i++) loop.push([i, 0]);
  for (let j = 1; j <= na; j++) loop.push([nr, j]);
  for (let i = nr - 1; i >= 0; i--) loop.push([i, na]);
  const rim = new THREE.Color().setHSL(0.98, 0.4, 0.2);
  let prev = null;
  for (const [i, j] of loop) {
    const pt = B.p.slice(T[i][j] * 3, T[i][j] * 3 + 3);
    const a = B.v(pt[0], pt[1], pt[2], rim, 1, -9), b = B.v(pt[0], pt[1], pt[2] - thick, rim, 1, -9);
    if (prev) B.quad(prev[0], prev[1], b, a);
    prev = [a, b];
  }
}

function lilyMaterial(high) {
  const opts = { vertexColors: true, roughness: 0.42, side: THREE.DoubleSide };
  const m = high ? new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 0.6, clearcoatRoughness: 0.25 }) : new THREE.MeshStandardMaterial(opts);
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = "attribute vec2 aUv; varying vec2 vP; varying vec3 vObj;\n" + sh.vertexShader
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvP = aUv; vObj = position;");
    sh.fragmentShader = "varying vec2 vP; varying vec3 vObj;\n" + NOISE + sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  float vein = 0.0;
  if (vP.y > -2.0) {
    // radial veins from the centre, forking toward the rim; lighter near the middle,
    // a reddish margin, and the odd brown blemish
    float q = vP.y * 3.14159, f = vP.x;
    float n1 = 21.0, a1 = abs(fract(q * n1 / 6.28318) - 0.5) * 2.0;
    float a2 = abs(fract(q * n1 * 2.0 / 6.28318 + 0.5) - 0.5) * 2.0;
    vein = (1.0 - smoothstep(0.0, 0.09 * (1.0 - 0.5 * f), a1)) * smoothstep(0.04, 0.12, f)
         + (1.0 - smoothstep(0.0, 0.1, a2)) * smoothstep(0.45, 0.6, f) * 0.6;
    vein = min(vein, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.35, 1.35, 0.9), vein * 0.55);
    diffuseColor.rgb *= 1.12 - 0.25 * f;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.12, 0.08), smoothstep(0.93, 1.0, f) * 0.6);
    float spot = smoothstep(0.72, 0.8, pF(vObj * 1.6));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.33, 0.24, 0.1), spot * 0.7);
    diffuseColor.rgb *= 0.9 + 0.2 * pN(vObj * 6.0);
  }`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  float hv = -vein;
  normal = pBump(-vViewPosition, normal, vec2(dFdx(hv), dFdy(hv)) * 0.25, faceDirection);`);
  };
  return m;
}

/**
 * Take the cattail and lily-pad cards out of the pond model's plant mesh `cards` and put
 * modelled ones into `group` in their places. `bedAt(x, y)` is the pond bed's height.
 */
export function modelPondPlants(cards, group, { waterZ, bedAt, shared, high, rand }) {
  group.updateMatrixWorld(true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert().multiply(cards.matrixWorld);
  const geo = cards.geometry, pos = geo.attributes.position, uv = geo.attributes.uv;
  const idx = geo.index ? Array.from(geo.index.array) : [...Array(pos.count).keys()];
  const keep = [], v = new THREE.Vector3();
  // the atlas: cattails in the right-hand column of the top half (u 0.75-1, v 0-0.5), the lily
  // pad bottom middle (u 0.38-0.62, v 0.75-1); the rushes next to it (u 0.62-0.88) stay
  const kind = (u, w) => (u >= 0.75 && w < 0.5 ? "cattail" : u < 0.62 && w >= 0.75 ? "lily" : null);
  // each card is a few triangles sharing corners: join them up (union-find on the corners)
  const parent = new Map(), kindOf = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (let t = 0; t < idx.length; t += 3) {
    let u = 0, w = 0;
    for (let k = 0; k < 3; k++) { u += uv.getX(idx[t + k]) / 3; w += uv.getY(idx[t + k]) / 3; }
    const kd = kind(u, w);
    if (!kd) { keep.push(idx[t], idx[t + 1], idx[t + 2]); continue; }
    for (let k = 0; k < 3; k++) { if (!parent.has(idx[t + k])) parent.set(idx[t + k], idx[t + k]); kindOf.set(idx[t + k], kd); }
    parent.set(find(idx[t]), find(idx[t + 1]));
    parent.set(find(idx[t + 1]), find(idx[t + 2]));
  }
  geo.setIndex(keep);
  // each card's extent, in the group's frame (Z up)
  const box = new Map();
  for (const i of parent.keys()) {
    const root = find(i);
    v.fromBufferAttribute(pos, i).applyMatrix4(toGroup);
    let c = box.get(root);
    if (!c) box.set(root, c = { kind: kindOf.get(i), b: new THREE.Box3() });
    c.b.expandByPoint(v);
  }
  const cardsOf = (kd) => [...box.values()].filter((c) => c.kind === kd).map((c) => c.b);
  // cattails: crossed cards standing on the same spot make one plant
  const plants = [];
  for (const b of cardsOf("cattail")) {
    const x = (b.min.x + b.max.x) / 2, y = (b.min.y + b.max.y) / 2;
    if (plants.some((p) => Math.hypot(p.x - x, p.y - y) < 1)) continue;
    plants.push({ x, y, z: b.min.z, H: b.max.z - b.min.z });
  }
  const B = new Builder(), S = new Builder(), r = rand;
  for (const p of plants) cattail(B, S, p.x, p.y, p.z, Math.max(8, p.H * (0.95 + r() * 0.15)), r, high ? 9 : 6);
  const mats = cattailMaterials(shared, high);
  const out = [];
  for (const [b, mat] of [[B, mats.leaf], [S, mats.spike]]) {
    if (!b.n) continue;
    const m = new THREE.Mesh(b.geometry(), mat);
    m.castShadow = m.receiveShadow = true;
    m.name = "cattails";
    reflectable(m); underwater(m);
    group.add(m); out.push(m);
  }
  // lily pads: one per card (four or six corners, flat on the water)
  const L = new Builder(), stalks = new Builder(), stalkCol = new THREE.Color().setHSL(0.02, 0.35, 0.22);
  const padsAt = cardsOf("lily").map((b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, R: Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2 }));
  for (const p of padsAt) {
    const R = Math.max(1.6, p.R * (0.95 + r() * 0.2));
    lilyPad(L, p.x, p.y, waterZ + 0.08, R, r() * 6.28, r);
    // its stalk, wandering down to the bed (seen only through the water)
    const bz = bedAt(p.x, p.y), a = r() * 6.28, d = R * 0.6, rings = [];
    for (let i = 0; i <= 8; i++) {
      const f = i / 8, cx = p.x + Math.cos(a) * d * Math.sin(Math.PI * f), cy = p.y + Math.sin(a) * d * Math.sin(Math.PI * f);
      const zz = waterZ - 0.1 - (waterZ - 0.1 - bz) * f, ring = [];
      for (let j = 0; j <= 5; j++) {
        const q = (j / 5) * 6.28;
        ring.push(stalks.v(cx + Math.cos(q) * 0.12, cy + Math.sin(q) * 0.12, zz, stalkCol, j / 5, f));
      }
      rings.push(ring);
    }
    for (let i = 0; i < 8; i++) for (let j = 0; j < 5; j++) stalks.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
  }
  if (L.n) {
    const m = new THREE.Mesh(L.geometry(), lilyMaterial(high));
    m.castShadow = m.receiveShadow = true;
    m.name = "lily pads";
    reflectable(m);
    group.add(m); out.push(m);
  }
  if (stalks.n) {
    const m = new THREE.Mesh(stalks.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    m.layers.set(LAYER_UNDER);
    group.add(m); out.push(m);
  }
  return { meshes: out, cattails: plants.length, pads: padsAt.length };
}
