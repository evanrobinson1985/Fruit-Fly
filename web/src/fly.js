// The FlyBody 3D fly (web/assets/fly.json + fly.bin, from web/tools/export_body.py),
// posed by forward kinematics over its 99 hinge joints. Legs replay one step
// cycle per leg recorded from a real walking fly (NeuroMechFly / flygym), in a
// tripod gait whose frequency and per-side stride come from the body model.
import * as THREE from "three";
import { loadPng } from "./pngdata.js";

const LEGS = ["lf", "lm", "lh", "rf", "rm", "rh"];
const LEG_POS = { f: 0, m: 1, h: 2 };
const TRIPOD = { lf: 0, rm: 0, lh: 0, rf: Math.PI, lm: Math.PI, rh: Math.PI };
const TAU = 2 * Math.PI;

export async function loadFly(base) {
  const sk = await fetch(base + "fly.json").then((r) => r.json());
  const bytes = await loadPng(base + "fly.png", sk.mesh_bytes);
  return new Fly(sk, bytes.buffer);
}

// ---------- skin ----------
// FlyBody's meshes come with flat colours per part. The skin below adds what a real
// Drosophila melanogaster looks like up close, drawn from anatomy rather than a photo:
// golden-brown thorax with faint scutal stripes; the male abdomen's tergites tan with a
// dark posterior band, the last two (A5, A6) wholly dark; pale sternites and legs with
// darker tarsi; ~780 hexagonal lens facets per eye with the dark pseudopupil that
// follows the viewer; a grainy, waxy cuticle; dark-brown bristles; clear iridescent wings.
const SRGB = (hex) => new THREE.Color(hex).convertSRGBToLinear();
const SKIN = {
  thorax: SRGB(0xa86f35), thoraxDark: SRGB(0x6e4420), head: SRGB(0xb2723a), frons: SRGB(0xc4823e),
  tergite: SRGB(0xc79a5a), band: SRGB(0x2b1a0e), sternite: SRGB(0xe0c69a), leg: SRGB(0xc99a5c),
  tarsus: SRGB(0x8a5e30), mouth: SRGB(0xd8b27a), antenna: SRGB(0xb5743a), haltere: SRGB(0xd9c39a),
  eye: SRGB(0x9e1c12), bristle: SRGB(0x1c120b), vein: SRGB(0x5a3b22), ocelli: SRGB(0x3a1d10),
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
// Smooth value noise for gentle mottling (vertex resolution).
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
    r += hash3(xi + a, yi + b, zi + c) * (a ? u : 1 - u) * (b ? v : 1 - v) * (c ? w : 1 - w);
  }
  return r;
}

// Per-vertex colour from where a vertex sits on the body (root frame, neutral pose).
function paint(part, body, pts) {
  const n = pts.length / 3, col = new Float32Array(n * 3), c = new THREE.Color();
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, pts[3 * i]); x1 = Math.max(x1, pts[3 * i]); z0 = Math.min(z0, pts[3 * i + 2]); z1 = Math.max(z1, pts[3 * i + 2]); }
  const suffix = part.mesh.slice(part.mesh.lastIndexOf("_") + 1);
  const seg = /c_abdomen(\d)/.exec(body)?.[1];
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1], z = pts[3 * i + 2];
    const mott = vnoise(x * 18, y * 18, z * 18) - 0.5, grain = vnoise(x * 70, y * 70, z * 70) - 0.5;
    if (body === "c_thorax") {
      // Scutum: faint darker stripes either side of the midline, darker pleura below.
      const up = smooth(z0, z1, z);
      const stripes = Math.exp(-(((Math.abs(y) - 0.11) / 0.045) ** 2)) + 0.7 * Math.exp(-(((Math.abs(y) - 0.3) / 0.05) ** 2));
      c.copy(SKIN.thorax).lerp(SKIN.thoraxDark, Math.min(1, 0.35 * stripes * up + 0.35 * (1 - up)));
    } else if (body === "c_head") {
      c.copy(SKIN.head).lerp(SKIN.frons, smooth(0.3, 1, (z - z0) / (z1 - z0)) * 0.6);
    } else if (seg) {
      const k = +seg;
      if (suffix === "lower") c.copy(SKIN.sternite);
      else {
        // Tergites: anterior is toward +x. A male's A5 and A6 (and the terminalia) are dark.
        const t = (x1 - x) / Math.max(1e-6, x1 - x0); // 0 anterior .. 1 posterior
        const dors = smooth(z0, z1, z);
        const width = k <= 1 ? 0.15 : 0.32 + 0.18 * dors; // band widens over the midline
        const band = k >= 5 ? 0.92 + 0.08 * dors : smooth(1 - width - 0.08, 1 - width + 0.04, t) * (0.6 + 0.4 * dors);
        c.copy(SKIN.tergite).lerp(SKIN.band, band);
      }
    } else if (/tarsus[2-5]/.test(body)) c.copy(SKIN.tarsus);
    else if (/tarsus1|tibia/.test(body)) c.copy(SKIN.leg).lerp(SKIN.tarsus, 0.25);
    else if (/coxa|femur/.test(body)) c.copy(SKIN.leg);
    else if (/rostrum|haustellum|labrum/.test(body)) c.copy(SKIN.mouth);
    else if (/antenna/.test(body)) c.copy(SKIN.antenna);
    else if (/haltere/.test(body)) c.copy(SKIN.haltere);
    else c.copy(SKIN.leg);
    const k = 1 + 0.22 * mott + 0.1 * grain;
    col[3 * i] = c.r * k; col[3 * i + 1] = c.g * k; col[3 * i + 2] = c.b * k;
  }
  return col;
}

// Fine cuticle grain: a normal jitter from 3D noise in the mesh's own coordinates,
// faded out where it would be finer than a pixel.
const GRAIN_GLSL = `
uniform mat3 normalMatrix;
varying vec3 vObj;
float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 grainNormal(vec3 n, float freq, float amp) {
  vec3 p = vObj * freq;
  float fade = 1.0 - smoothstep(0.3, 1.0, length(fwidth(p)));
  vec3 j = vec3(vn(p), vn(p + 17.3), vn(p + 41.1)) - 0.5;
  j = normalMatrix * j;
  return normalize(n + amp * fade * (j - n * dot(j, n)));
}
`;

function withObjPos(shader) {
  shader.vertexShader = "varying vec3 vObj;\n" + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvObj = position;");
}

function cuticle(opts, freq = 140, amp = 0.35) {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.45,
    sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.55, 0.42, 0.28), side: THREE.DoubleSide, ...opts });
  m.onBeforeCompile = (shader) => {
    withObjPos(shader);
    shader.fragmentShader = GRAIN_GLSL + shader.fragmentShader.replace("#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>\n  normal = grainNormal(normal, ${freq.toFixed(1)}, ${amp.toFixed(2)});`);
  };
  return m;
}

// Compound eyes: a hexagonal lattice of lenses on an equal-area map around each eye's
// axis, each lens a little dome, with dark gaps and the pseudopupil.
function eyeMaterial(axes) {
  const m = new THREE.MeshPhysicalMaterial({ color: SKIN.eye, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uE1 = { value: axes.map((a) => a.e1) };
    shader.uniforms.uE2 = { value: axes.map((a) => a.e2) };
    shader.vertexShader = "attribute vec3 aEye;\nvarying vec3 vEye;\n" + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvEye = aEye;");
    shader.fragmentShader = `uniform mat3 normalMatrix;\nvarying vec3 vEye;\nuniform vec3 uE1[2], uE2[2];\n` + shader.fragmentShader.replace("#include <normal_fragment_maps>", `
  #include <normal_fragment_maps>
  {
    // Hex lattice, spacing s: ~780 facets per eye.
    const float s = 0.082;
    vec2 p = vEye.xy / s;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 a = mod(p, r) - r * 0.5, b = mod(p - r * 0.5, r) - r * 0.5;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;       // offset from the nearest lens centre
    float d = length(g) * 2.0;                    // 0 centre .. ~1.15 corner
    int side = vEye.z > 0.5 ? 1 : 0;
    vec3 e1 = normalize(normalMatrix * uE1[side]), e2 = normalize(normalMatrix * uE2[side]);
    float fade = 1.0 - smoothstep(0.25, 0.9, length(fwidth(p)));
    normal = normalize(normal + fade * 0.9 * (g.x * e1 + g.y * e2));
    diffuseColor.rgb *= mix(1.0, 0.35, fade * smoothstep(0.82, 1.0, d));
    // Pseudopupil: looking straight down the ommatidia, light is absorbed by the pigment.
    float look = dot(normalize(vNormal), normalize(vViewPosition));
    diffuseColor.rgb *= 1.0 - 0.8 * smoothstep(0.93, 0.995, abs(look));
  }`);
  };
  return m;
}

function material(part, eyeAxes) {
  const [r, g, b] = part.rgba;
  const suffix = part.mesh.slice(part.mesh.lastIndexOf("_") + 1);
  if (suffix === "membrane") {
    // Wing membrane: nearly clear, with thin-film colours.
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.86, 0.88, 0.9), transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0,
      iridescence: 1, iridescenceIOR: 1.55, iridescenceThicknessRange: [200, 600],
      side: THREE.DoubleSide, depthWrite: false,
    });
  }
  if (suffix === "red") return eyeMaterial(eyeAxes);
  if (suffix === "black" || suffix === "bristle-brown") {
    return new THREE.MeshPhysicalMaterial({ color: SKIN.bristle, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3, side: THREE.DoubleSide });
  }
  if (suffix === "brown" && part.mesh.includes("wing")) {
    return new THREE.MeshPhysicalMaterial({ color: SKIN.vein, roughness: 0.4, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  }
  if (suffix === "ocelli") return new THREE.MeshPhysicalMaterial({ color: SKIN.ocelli, roughness: 0.25, clearcoat: 1, side: THREE.DoubleSide });
  // Double-sided: decimation leaves some triangles with flipped winding.
  return cuticle({}, part.mesh.includes("abdomen") ? 110 : 140);
}

export class Fly {
  constructor(sk, bin) {
    this.sk = sk;
    this.bodies = sk.bodies;
    this.q = Float64Array.from(sk.neutral);
    this.neutral = Float64Array.from(sk.neutral);
    this.jointIdx = {};
    for (const b of this.bodies) for (const j of b.joints) this.jointIdx[j.name] = j.qpos;
    this.root = new THREE.Group();
    this.nodes = this.bodies.map(() => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      this.root.add(g);
      return g;
    });
    this._prepSteps();
    this.poses = this.bodies.map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    this.override = this.bodies.map(() => null);
    this._tmp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), jq: new THREE.Quaternion(), ax: new THREE.Vector3() };
    this.update(); // neutral pose: the skin is painted in the body's rest frame
    this._buildMeshes(bin);
    // this.override: optional orientation (relative to the parent) blended over the joint result.
    this.byName = Object.fromEntries(this.bodies.map((b) => [b.name, b]));
    this.wingSpread = {};
    for (const s of ["l", "r"]) {
      const b = this.byName[`${s}_wing`];
      const q = new THREE.Quaternion(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
      for (const [axis, th] of [[[0, 0, 1], WING_SPREAD[0]], [[1, 0, 0], WING_SPREAD[1]], [[0, 1, 0], WING_SPREAD[2]]]) {
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), th));
      }
      this.wingSpread[s] = q;
      this.override[b.id] = { q: new THREE.Quaternion(), blend: 0 };
    }
    this.wingRest = { l: WING_FOLDED.l.slice(), r: WING_FOLDED.r.slice() };
    this.setWings(0, 0);
    this.setProboscis(0);
    this.setWalk(0, 0, 0);
    this.update();
    this.groundOffset = this._lowestClaw();
  }

  _buildMeshes(bin) {
    const parts = this.sk.parts.map((part) => {
      const q = new Uint16Array(bin, part.offset, part.nv * 3);
      const pos = new Float32Array(part.nv * 3);
      for (let i = 0; i < q.length; i++) pos[i] = part.min[i % 3] + q[i] * part.scale[i % 3];
      const idx = new (part.index32 ? Uint32Array : Uint16Array)(bin, part.index_offset, part.nf * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      // Positions in the root frame at rest, for painting.
      const node = this.nodes[part.body], v = new THREE.Vector3(), root = new Float32Array(pos.length);
      for (let i = 0; i < part.nv; i++) {
        v.fromArray(pos, 3 * i).applyMatrix4(node.matrix);
        root[3 * i] = v.x; root[3 * i + 1] = v.y; root[3 * i + 2] = v.z;
      }
      return { part, geo, pos, root };
    });
    // Each eye's axis: from the head's centre out through the centre of that eye.
    const eyeAxes = [];
    const eye = parts.find((p) => p.part.mesh.endsWith("_red"));
    if (eye) {
      const sums = [new THREE.Vector3(), new THREE.Vector3()], counts = [0, 0];
      const head = new THREE.Vector3();
      for (let i = 0; i < eye.pos.length; i += 3) head.add(v3(eye.pos, i));
      head.divideScalar(eye.pos.length / 3);
      for (let i = 0; i < eye.pos.length; i += 3) { const k = eye.pos[i + 1] > head.y ? 1 : 0; sums[k].add(v3(eye.pos, i)); counts[k]++; }
      const centres = sums.map((s, k) => s.divideScalar(Math.max(1, counts[k])));
      for (let k = 0; k < 2; k++) {
        // Sphere fitted loosely: centre pulled in toward the head's midline.
        const c = centres[k].clone().lerp(head, 0.6);
        const ax = centres[k].clone().sub(c).normalize();
        const e1 = new THREE.Vector3(0, 0, 1).cross(ax).normalize(), e2 = ax.clone().cross(e1).normalize();
        eyeAxes.push({ c, ax, e1, e2 });
      }
      const aEye = new Float32Array(eye.pos.length);
      for (let i = 0; i < eye.pos.length; i += 3) {
        const k = eye.pos[i + 1] > head.y ? 1 : 0, A = eyeAxes[k];
        const d = v3(eye.pos, i).sub(A.c).normalize();
        const f = Math.sqrt(2 / Math.max(0.05, 1 + d.dot(A.ax))); // Lambert equal-area projection
        aEye[i] = d.dot(A.e1) * f; aEye[i + 1] = d.dot(A.e2) * f; aEye[i + 2] = k;
      }
      eye.geo.setAttribute("aEye", new THREE.BufferAttribute(aEye, 3));
    }
    for (const { part, geo, root } of parts) {
      const suffix = part.mesh.slice(part.mesh.lastIndexOf("_") + 1);
      if (suffix === "body" || suffix === "lower") geo.setAttribute("color", new THREE.BufferAttribute(paint(part, this.bodies[part.body].name, root), 3));
      const mesh = new THREE.Mesh(geo, material(part, eyeAxes));
      mesh.castShadow = !part.mesh.endsWith("membrane");
      this.nodes[part.body].add(mesh);
    }
  }

  _prepSteps() {
    const st = this.sk.steps;
    this.stepAngles = st.angles; // [F,M,H][dof][bin]
    this.nBins = st.angles[0][0].length;
    this.swing = st.swing_fraction;
    // Neutral leg pose is the step cycle at phase pi (as in flygym).
    this.stepNeutral = [0, 1, 2].map((p) => this.stepAngles[p].map((dof) => this._interp(dof, Math.PI)));
  }

  _interp(arr, phase) {
    const x = (((phase % TAU) + TAU) % TAU) / TAU * this.nBins;
    const i = Math.floor(x), f = x - i;
    return arr[i % this.nBins] * (1 - f) + arr[(i + 1) % this.nBins] * f;
  }

  // Legs follow the recorded step cycle; amplitude 0 holds the neutral stance.
  setWalk(phase, ampL, ampR) {
    for (const leg of LEGS) {
      const p = LEG_POS[leg[1]];
      const amp = leg[0] === "l" ? ampL : ampR;
      const qp = this.sk.steps.leg_qpos[leg];
      for (let d = 0; d < 7; d++) {
        const n = this.stepNeutral[p][d];
        this.q[qp[d]] = n + amp * (this._interp(this.stepAngles[p][d], phase + TRIPOD[leg]) - n);
      }
    }
  }

  // Legs tucked under the body for flight (flygym's flight pose).
  setFlightLegs(blend) {
    for (const [name, v] of Object.entries(FLIGHT_LEGS)) {
      const i = this.jointIdx[name];
      if (i !== undefined) this.q[i] = this.q[i] * (1 - blend) + v * blend;
    }
  }

  set(name, value) {
    const i = this.jointIdx[name];
    if (i !== undefined) this.q[i] = value;
  }

  // Wings: folded over the abdomen (0) to flapping (1); stroke phase in radians.
  setWings(open, stroke) {
    const Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
    for (const s of ["l", "r"]) {
      const rest = this.wingRest[s];
      this.set(`c_thorax-${s}_wing-yaw`, rest[0]);
      this.set(`c_thorax-${s}_wing-roll`, rest[1]);
      this.set(`c_thorax-${s}_wing-pitch`, rest[2]);
      const sign = s === "l" ? 1 : -1;
      // Stroke: sweep forward/back in a plane tilted 20 deg, with wing rotation at reversal.
      const sweep = new THREE.Quaternion().setFromAxisAngle(Z, -sign * 1.1 * Math.sin(stroke));
      const tilt = new THREE.Quaternion().setFromAxisAngle(X, sign * 0.35 * Math.cos(stroke));
      const o = this.override[this.byName[`${s}_wing`].id];
      o.q.copy(sweep).multiply(tilt).multiply(this.wingSpread[s]);
      o.blend = open;
      this.set(`c_thorax-${s}_haltere-pitch`, open * 0.2 * Math.sin(stroke + Math.PI));
    }
  }

  // Proboscis: 0 retracted, 1 fully extended toward the substrate.
  setProboscis(ext) {
    this.set("c_head-c_rostrum-pitch", PROBOSCIS.rostrum[0] + ext * (PROBOSCIS.rostrum[1] - PROBOSCIS.rostrum[0]));
    this.set("c_rostrum-c_haustellum-pitch", PROBOSCIS.haustellum[0] + ext * (PROBOSCIS.haustellum[1] - PROBOSCIS.haustellum[0]));
    this.set("c_haustellum-l_labrum-pitch", ext * 0.6);
    this.set("c_haustellum-r_labrum-pitch", ext * 0.6);
  }

  // Forward kinematics (identical to forward_kinematics() in export_body.py).
  update() {
    const { jq, ax } = this._tmp;
    for (const b of this.bodies) {
      const out = this.poses[b.id];
      const local = new THREE.Vector3(...b.pos);
      const bq = new THREE.Quaternion(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
      if (b.parent < 0) {
        out.p.copy(local);
        out.q.copy(bq);
      } else {
        const par = this.poses[b.parent];
        out.p.copy(local.applyQuaternion(par.q)).add(par.p);
        out.q.copy(par.q).multiply(bq);
      }
      const ov = this.override[b.id];
      if (ov && ov.blend > 0) {
        const lq = bq.clone();
        for (const j of b.joints) lq.multiply(jq.setFromAxisAngle(ax.set(...j.axis), this.q[j.qpos]));
        lq.slerp(ov.q, ov.blend);
        out.q.copy(b.parent < 0 ? lq : this.poses[b.parent].q.clone().multiply(lq));
      } else {
        for (const j of b.joints) {
          ax.set(j.axis[0], j.axis[1], j.axis[2]);
          jq.setFromAxisAngle(ax, this.q[j.qpos]);
          out.q.multiply(jq);
        }
      }
      this.nodes[b.id].matrix.compose(out.p, out.q, ONE);
    }
  }

  _lowestClaw() {
    let lo = Infinity;
    const v = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    this.nodes.forEach((node, k) => {
      if (!/tarsus5/.test(this.bodies[k].name)) return;
      for (const m of node.children) {
        const pos = m.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(node.matrix);
          lo = Math.min(lo, v.z);
        }
      }
    });
    return lo;
  }
}

const ONE = new THREE.Vector3(1, 1, 1);
const v3 = (a, i) => new THREE.Vector3(a[i], a[i + 1], a[i + 2]);

// Wing joint angles (yaw, roll, pitch) in flygym's FlyBody rigging, found by
// orienting the wing mesh: folded back over the abdomen, and spread sideways.
const WING_FOLDED = { l: [-0.2, -0.3, -0.07], r: [-0.2, -0.3, -0.07] };
const WING_SPREAD = [-1.5, -0.9, 2.32];

// Retracted -> extended (rostrum, haustellum) pitch; found by posing the mesh.
const PROBOSCIS = { rostrum: [0.18, -1.1], haustellum: [0.7, -1.4] };

const FLIGHT_LEGS = {
  "c_thorax-lf_coxa-pitch": 0.0584, "lf_coxa-lf_trochanterfemur-pitch": -0.142, "lf_trochanterfemur-lf_tibia-pitch": -1.29, "lf_tibia-lf_tarsus1-pitch": -0.242,
  "c_thorax-rf_coxa-pitch": 0.0584, "rf_coxa-rf_trochanterfemur-pitch": -0.142, "rf_trochanterfemur-rf_tibia-pitch": -1.29, "rf_tibia-rf_tarsus1-pitch": -0.242,
  "c_thorax-lm_coxa-yaw": -0.292, "c_thorax-lm_coxa-roll": -0.742, "c_thorax-lm_coxa-pitch": 0.408, "lm_coxa-lm_trochanterfemur-roll": 0.608, "lm_coxa-lm_trochanterfemur-pitch": 0.208, "lm_trochanterfemur-lm_tibia-pitch": -1.34, "lm_tibia-lm_tarsus1-pitch": 0.608,
  "c_thorax-rm_coxa-yaw": -0.292, "c_thorax-rm_coxa-roll": -0.742, "c_thorax-rm_coxa-pitch": 0.408, "rm_coxa-rm_trochanterfemur-roll": 0.608, "rm_coxa-rm_trochanterfemur-pitch": 0.208, "rm_trochanterfemur-rm_tibia-pitch": -1.34, "rm_tibia-rm_tarsus1-pitch": 0.608,
  "c_thorax-lh_coxa-roll": 0.00841, "c_thorax-lh_coxa-pitch": 0.158, "lh_coxa-lh_trochanterfemur-roll": 0.558, "lh_coxa-lh_trochanterfemur-pitch": 0.258, "lh_trochanterfemur-lh_tibia-pitch": -0.292, "lh_tibia-lh_tarsus1-pitch": 0.258,
  "c_thorax-rh_coxa-roll": 0.00841, "c_thorax-rh_coxa-pitch": 0.158, "rh_coxa-rh_trochanterfemur-roll": 0.558, "rh_coxa-rh_trochanterfemur-pitch": 0.258, "rh_trochanterfemur-rh_tibia-pitch": -0.292, "rh_tibia-rh_tarsus1-pitch": 0.258,
};
