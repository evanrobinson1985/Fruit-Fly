// Flies land on anything: a fern frond, a cattail leaf, a lily pad, the side of a stone, the
// underside of a leaf, and walk about on it at any angle, upside down included.
//
// When the scenery loads, the surfaces of the plants and stones are sampled into perch points
// (position and surface normal, about one per 3 mm^2), skipping the see-through parts of leaves
// drawn as cut-outs. As a flight ends the fly may pick one ahead of it and land there, turning
// its body to the surface; while it stands on one, its walking (from the brain, world.js)
// carries it along the surface, which is followed from point to point; off an edge it lets go.
import * as THREE from "three";

const CELL = 3; // mm: the spatial hash's cell

/** Read a texture's alpha back from the GPU (works for compressed textures too). */
function alphaOf(renderer, tex, size = 256) {
  const rt = new THREE.WebGLRenderTarget(size, size);
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.NoBlending }));
  scene.add(quad);
  const prevTarget = renderer.getRenderTarget(), prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const buf = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
  renderer.setRenderTarget(prevTarget);
  renderer.toneMapping = prevTone;
  rt.dispose(); quad.geometry.dispose(); quad.material.dispose();
  // pixel (i, j) holds uv (i / size, j / size): the plane's uv runs with x and y
  return (u, v) => {
    const i = Math.floor((((u % 1) + 1) % 1) * size), j = Math.floor((((v % 1) + 1) % 1) * size);
    return buf[(j * size + i) * 4 + 3] / 255;
  };
}

export class Perches {
  constructor() {
    this.pos = new Float32Array(0);
    this.nrm = new Float32Array(0);
    this.grid = new Map();
    this.count = 0;
  }

  /** Sample the surfaces of `roots` (meshes or groups of them) into perch points. */
  build(renderer, roots, { density = 1 / 3, max = 120000 } = {}) {
    const P = [], N = [], alphas = new Map();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
    const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2();
    const meshes = [];
    for (const r of roots) r?.traverse?.((o) => { if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && o.geometry?.attributes.position) meshes.push(o); });
    // total area first, to spread the budget
    let area = 0;
    const tris = [];
    for (const m of meshes) {
      m.updateMatrixWorld(true);
      const g = m.geometry, pos = g.attributes.position, idx = g.index, uv = g.attributes.uv;
      const mat = [].concat(m.material)[0];
      let alpha = null;
      if (mat?.map && uv && (mat.alphaTest > 0 || mat.transparent)) {
        if (!alphas.has(mat.map)) { try { alphas.set(mat.map, alphaOf(renderer, mat.map)); } catch { alphas.set(mat.map, null); } }
        alpha = alphas.get(mat.map);
      }
      const nt = idx ? idx.count / 3 : pos.count / 3;
      for (let t = 0; t < nt; t++) {
        const i0 = idx ? idx.getX(3 * t) : 3 * t, i1 = idx ? idx.getX(3 * t + 1) : 3 * t + 1, i2 = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
        const ar = n.subVectors(b, a).cross(p.subVectors(c, a)).length() / 2;
        if (ar <= 1e-6) continue;
        area += ar;
        tris.push([m, i0, i1, i2, ar, alpha, uv]);
      }
    }
    const want = Math.min(max, Math.round(area * density));
    let carry = 0;
    for (const [m, i0, i1, i2, ar, alpha, uv] of tris) {
      carry += (ar / area) * want;
      while (carry >= 1) {
        carry -= 1;
        let r1 = Math.random(), r2 = Math.random();
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        if (alpha) {
          ua.fromBufferAttribute(uv, i0); ub.fromBufferAttribute(uv, i1); uc.fromBufferAttribute(uv, i2);
          const u = ua.x + (ub.x - ua.x) * r1 + (uc.x - ua.x) * r2, v = ua.y + (ub.y - ua.y) * r1 + (uc.y - ua.y) * r2;
          if (alpha(u, v) < 0.5) continue; // a see-through part of the leaf
        }
        const pos = m.geometry.attributes.position;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
        p.copy(a).addScaledVector(b.clone().sub(a), r1).addScaledVector(c.clone().sub(a), r2);
        n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
        P.push(p.x, p.y, p.z);
        N.push(n.x, n.y, n.z);
      }
    }
    this.pos = new Float32Array(P);
    this.nrm = new Float32Array(N);
    this.count = P.length / 3;
    this.grid.clear();
    for (let i = 0; i < this.count; i++) {
      const k = this._key(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(i);
    }
    return this.count;
  }

  _key(x, y, z) { return `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`; }

  /** The nearest perch point to `p` within `r` mm (index, or -1). */
  nearest(p, r = CELL) {
    let best = -1, bd = r * r;
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), cz = Math.floor(p.z / CELL), s = Math.ceil(r / CELL);
    for (let i = -s; i <= s; i++) for (let j = -s; j <= s; j++) for (let k = -s; k <= s; k++) {
      const l = this.grid.get(`${cx + i},${cy + j},${cz + k}`);
      if (!l) continue;
      for (const q of l) {
        const dx = this.pos[3 * q] - p.x, dy = this.pos[3 * q + 1] - p.y, dz = this.pos[3 * q + 2] - p.z, d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best;
  }

  /**
   * Somewhere to land, for a fly at `from` (world) flying along `dir`: a perch point within
   * `range` mm, mostly ahead, on the side of the surface that faces the fly. Returns
   * {p, n} or null.
   */
  pickLanding(from, dir, range = 30) {
    if (!this.count) return null;
    const cands = [];
    const s = Math.ceil(range / CELL), cx = Math.floor(from.x / CELL), cy = Math.floor(from.y / CELL), cz = Math.floor(from.z / CELL);
    for (let i = -s; i <= s; i++) for (let j = -s; j <= s; j++) for (let k = -s; k <= s; k++) {
      const l = this.grid.get(`${cx + i},${cy + j},${cz + k}`);
      if (!l) continue;
      for (let m = 0; m < l.length; m += 3) {
        const q = l[m];
        const dx = this.pos[3 * q] - from.x, dy = this.pos[3 * q + 1] - from.y, dz = this.pos[3 * q + 2] - from.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > range || d < 1) continue;
        // the side facing the fly (leaves are two-sided: turn the normal to face it)
        const nd = (this.nrm[3 * q] * dx + this.nrm[3 * q + 1] * dy + this.nrm[3 * q + 2] * dz) / d;
        const ahead = (dx * dir.x + dy * dir.y) / d;
        if (ahead < -0.2) continue;
        cands.push([q, (1.2 + ahead) / (1 + d * 0.08), nd > 0 ? -1 : 1]);
      }
    }
    if (!cands.length) return null;
    let tot = cands.reduce((s, c) => s + c[1], 0), r = Math.random() * tot;
    for (const [q, w, sign] of cands) {
      if ((r -= w) > 0) continue;
      return {
        p: new THREE.Vector3(this.pos[3 * q], this.pos[3 * q + 1], this.pos[3 * q + 2]),
        n: new THREE.Vector3(this.nrm[3 * q], this.nrm[3 * q + 1], this.nrm[3 * q + 2]).multiplyScalar(sign),
      };
    }
    return null;
  }

  /**
   * Walk `dist` mm along the surface from s.p (normal s.n) toward the fly's heading (degrees,
   * a world direction projected onto the surface). Updates s.p, s.n and s.fwd; returns false
   * when the surface ends there (the fly lets go).
   */
  walk(s, headingDeg, dist) {
    const h = (headingDeg * Math.PI) / 180;
    const fwd = _f.set(Math.cos(h), Math.sin(h), 0);
    fwd.addScaledVector(s.n, -fwd.dot(s.n));
    if (fwd.lengthSq() < 1e-4) {
      // heading straight into or out of the surface: keep the way it was facing
      fwd.copy(s.fwd || _t.set(1, 0, 0));
      fwd.addScaledVector(s.n, -fwd.dot(s.n));
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1).cross(s.n);
      if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
    }
    fwd.normalize();
    s.fwd = (s.fwd || new THREE.Vector3()).copy(fwd);
    if (Math.abs(dist) < 1e-5) return true;
    const target = _t.copy(s.p).addScaledVector(fwd, dist);
    const q = this.nearest(target, 2.6);
    if (q < 0) return false; // the edge: nothing to stand on there
    const nq = _n.set(this.nrm[3 * q], this.nrm[3 * q + 1], this.nrm[3 * q + 2]);
    if (nq.dot(s.n) < 0) nq.negate(); // the same side of a two-sided leaf
    if (nq.dot(s.n) < 0.2) return false; // folds over too sharply
    // onto the surface there (the plane of the nearest point), the normal turning smoothly
    const qp = _q.set(this.pos[3 * q], this.pos[3 * q + 1], this.pos[3 * q + 2]);
    target.addScaledVector(nq, -nq.dot(_d.subVectors(target, qp)));
    s.p.copy(target);
    s.n.lerp(nq, 0.25).normalize();
    return true;
  }
}

const _f = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Vector3(), _d = new THREE.Vector3();
