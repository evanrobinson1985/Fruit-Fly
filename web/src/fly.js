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

function material(part) {
  const [r, g, b, a] = part.rgba;
  const suffix = part.mesh.slice(part.mesh.lastIndexOf("_") + 1);
  const color = new THREE.Color(r, g, b).convertSRGBToLinear();
  if (suffix === "membrane") {
    return new THREE.MeshPhysicalMaterial({
      color, transparent: true, opacity: 0.28, roughness: 0.15, metalness: 0,
      iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [250, 700],
      side: THREE.DoubleSide, depthWrite: false,
    });
  }
  if (suffix === "red") {
    // Compound eyes: deep red with a glossy corneal sheen.
    return new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.2, sheen: 0.4, side: THREE.DoubleSide });
  }
  if (suffix === "black" || suffix === "bristle-brown") {
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.015, 0.01), roughness: 0.6, side: THREE.DoubleSide });
  }
  // Double-sided: decimation leaves some triangles with flipped winding.
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
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
    for (const part of sk.parts) {
      const q = new Uint16Array(bin, part.offset, part.nv * 3);
      const pos = new Float32Array(part.nv * 3);
      for (let i = 0; i < q.length; i++) pos[i] = part.min[i % 3] + q[i] * part.scale[i % 3];
      const idx = new (part.index32 ? Uint32Array : Uint16Array)(bin, part.index_offset, part.nf * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material(part));
      mesh.castShadow = !part.mesh.endsWith("membrane");
      this.nodes[part.body].add(mesh);
    }
    this._prepSteps();
    this._tmp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), jq: new THREE.Quaternion(), ax: new THREE.Vector3() };
    this.poses = this.bodies.map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    // Optional orientation (relative to the parent) blended over the joint result.
    this.override = this.bodies.map(() => null);
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
    this.setWings(0, 0);
    this.setProboscis(0);
    this.setWalk(0, 0, 0);
    this.update();
    this.groundOffset = this._lowestClaw();
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
      this.set(`c_thorax-${s}_wing-yaw`, WING_FOLDED[0]);
      this.set(`c_thorax-${s}_wing-roll`, WING_FOLDED[1]);
      this.set(`c_thorax-${s}_wing-pitch`, WING_FOLDED[2]);
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

// Wing joint angles (yaw, roll, pitch) in flygym's FlyBody rigging, found by
// orienting the wing mesh: folded back over the abdomen, and spread sideways.
const WING_FOLDED = [-0.2, -0.3, -0.07];
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
