// Grass floor and small weeds for the arena, at true scale for a 2.5 mm fly (units: mm).
//
// Blades are instanced in a circular window around the fly and rebuilt as it
// moves; positions come from a hash of the 1 mm ground cell, so every blade has
// a fixed place in the world. Beyond the window the ground texture carries the
// look. Weeds (clover, dandelion rosettes, seedlings) are placed once.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const WINDOW = 26;          // radius of the bladed area around the fly
const PER_CELL = 12;         // blades per mm^2
const TURF_TOP = 0.35;      // a fly walks on the matted turf, about this high (mm)
const MAX_BLADES = Math.ceil(Math.PI * WINDOW * WINDOW * PER_CELL);

function hash(x, y, k) {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Seeded RNG for weed placement.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296;
}

function soilTexture() {
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
  t.repeat.set(16, 16);
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Breeze: sway each vertex by the square of its height, after instancing.
// sway: mm of tip motion per unit of local height squared; press: whether the fly flattens it.
function addWind(material, uniforms, sway = 0.22, press = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uFly = uniforms.uFly;
    shader.vertexShader = `uniform float uTime;\nuniform vec3 uFly;\nconst float SWAY = ${sway.toFixed(4)};\nconst float PRESS = ${press.toFixed(1)};\n` + shader.vertexShader.replace(
      "#include <project_vertex>",
      `vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        // Blades under and beside the fly are pressed down as it walks through.
        vec2 off = mvPosition.xy - uFly.xy;
        float press = smoothstep( 0.6, 2.2, length( off ) ) * 0.75 + 0.25;
        if ( PRESS > 0.5 && uFly.z < 0.5 ) { mvPosition.z *= press; mvPosition.xy += normalize( off + 1e-4 ) * ( 1.0 - press ) * mvPosition.z * 0.6; }
        float sw = transformed.z * transformed.z;
        mvPosition.x += sin( uTime * 1.7 + mvPosition.y * 0.35 ) * SWAY * sw;
        mvPosition.y += cos( uTime * 1.3 + mvPosition.x * 0.3 ) * SWAY * 0.7 * sw;
      #endif
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`);
  };
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
    this.uniforms = { uTime: { value: 0 }, uFly: { value: new THREE.Vector3() } };
    this.exclusions = [];
    this.center = null;
    this._ray = new THREE.Raycaster(undefined, undefined, 0, 40);
    this.group = new THREE.Group(); // toggled as a whole by the floor switch
    scene.add(this.group);
    scene = this.group;

    this.floor = new THREE.Mesh(new THREE.CircleGeometry(radius, 128),
      new THREE.MeshStandardMaterial({ map: soilTexture(), roughness: 1 }));
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
    addWind(bladeMat, this.uniforms);
    this.blades = new THREE.InstancedMesh(bladeGeometry(), bladeMat, MAX_BLADES);
    this.blades.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blades.setColorAt(0, new THREE.Color());
    this.blades.receiveShadow = true;
    this.blades.frustumCulled = false;
    this.blades.count = 0;
    scene.add(this.blades);

    this._addWeeds(scene);
  }

  _addWeeds(scene) {
    const r = rng(7);
    const leafMat = (color) => {
      const m = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.7 });
      addWind(m, this.uniforms, 0.004, 0); // leaves barely sway, so a fly standing on one stays on it
      return m;
    };
    const kinds = [
      { geo: cloverGeometry(), mat: leafMat(0x3f7a2e), n: 160, scale: [0.8, 1.3], hue: [0.27, 0.32] },
      { geo: dandelionGeometry(), mat: leafMat(0x4d7f2c), n: 22, scale: [0.7, 1.2], hue: [0.22, 0.27] },
      { geo: seedlingGeometry(), mat: leafMat(0x6aa13a), n: 260, scale: [0.7, 1.4], hue: [0.22, 0.3] },
    ];
    this.weeds = [];
    this.weedMeshes = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    for (const k of kinds) {
      const mesh = new THREE.InstancedMesh(k.geo, k.mat, k.n);
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

  // Keep blades out of food drops and from under odor sources.
  setExclusions(list) {
    this.exclusions = list;
    this.center = null;
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
    this.center = null;
  }

  // Rebuild the bladed window when the fly has moved far enough.
  update(x, y, timeS, flyZ = 0) {
    if (!this.group.visible) return;
    this.uniforms.uTime.value = timeS;
    this.uniforms.uFly.value.set(x, y, flyZ);
    if (this.center && Math.hypot(x - this.center[0], y - this.center[1]) < 5) return;
    this.center = [x, y];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const c = new THREE.Color(), Z = new THREE.Vector3(0, 0, 1), tilt = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);
    let n = 0;
    const R = this.radius - 1.5;
    for (let gx = Math.floor(x - WINDOW); gx <= Math.ceil(x + WINDOW); gx++) {
      for (let gy = Math.floor(y - WINDOW); gy <= Math.ceil(y + WINDOW); gy++) {
        for (let k = 0; k < PER_CELL && n < MAX_BLADES; k++) {
          const bx = gx + hash(gx, gy, 3 * k), by = gy + hash(gx, gy, 3 * k + 1);
          const d = Math.hypot(bx - x, by - y);
          if (d > WINDOW || Math.hypot(bx, by) > R) continue;
          if (this.exclusions.some((e) => (bx - e.x) ** 2 + (by - e.y) ** 2 < e.r * e.r)) continue;
          const h0 = hash(gx, gy, 3 * k + 2);
          // Fade blade height toward the window edge so the boundary is invisible.
          const fade = Math.min(1, (WINDOW - d) / 8);
          const h = (0.4 + 1.4 * h0 * h0) * fade; // fine, freshly mown turf at fly scale
          if (h < 0.1) continue;
          q.setFromAxisAngle(Z, h0 * 97.3);
          tilt.setFromAxisAngle(X, (hash(gy, gx, k) - 0.5) * 0.5);
          q.multiply(tilt);
          const w = 0.12 + 0.22 * hash(gy, gx, k + 11);
          m.compose(p.set(bx, by, 0), q, s.set(w, w, h));
          this.blades.setMatrixAt(n, m);
          const dry = hash(gx, gy, k + 23) < 0.06;
          c.setHSL(dry ? 0.13 : 0.24 + 0.08 * hash(gx, gy, k + 5), dry ? 0.35 : 0.55, dry ? 0.55 : 0.28 + 0.2 * hash(gx, gy, k + 7));
          this.blades.setColorAt(n, c);
          n++;
        }
      }
    }
    this.blades.count = n;
    this.blades.instanceMatrix.needsUpdate = true;
    this.blades.instanceColor.needsUpdate = true;
  }
}
