// Rain and snow at fly scale (units: mm, s, mg), with the physics that matters to a 1 mg fly.
//
// Rain: drop sizes follow Marshall & Palmer (1948), N(D) = 8000 exp(-4.1 R^-0.21 D) per m^3
// per mm, and fall at their terminal speed, v(D) = 9.65 - 10.3 exp(-0.6 D) m/s (Atlas et al.
// 1973). The number landing per second is that size spectrum times its fall speed, so the
// rainfall rate sets both how many drops fall and how big they are. A 2 mm drop weighs
// about 4 mg, four times the fly. Drops are straight-line projectiles; where they land on
// the turf, a leaf, food or the fly comes from the baked height map and a capsule around
// the fly, so a fly under a clover leaf is sheltered. Bigger drops splash: crown droplets
// fly off ballistically (gravity only) and can hit the fly too; drops on leaves leave beads.
//
// Snow: aggregate flakes with sizes from an exponential spectrum whose mean grows with the
// snowfall rate, mass m = 0.037 D^1.9 mg and speed v = 0.8 D^0.16 m/s (Locatelli & Hobbs
// 1974), wobbling as they fall. Flakes settle where they land (turf, leaves, food, the fly)
// and melt slowly; on a walking fly they stay until they melt.
//
// The weather reports every hit on the fly with the drop's mass and velocity; main.js
// turns that into touch-neuron input and a push on the body.
import * as THREE from "three";

const GRAVITY = 9810;        // mm/s^2
const MAX_FALLING = 2500;    // streaks drawn at once (drops, splash droplets, flakes)
const MAX_RINGS = 160;
const MAX_BEADS = 400;
const MAX_SETTLED = 5000;
const MAX_ON_FLY = 40;
const SHUTTER = 1 / 250;     // motion blur of the falling streaks (s)

export const RAIN_LEVELS = [
  { name: "Drizzle", rate: 1 }, { name: "Light", rate: 2.5 }, { name: "Moderate", rate: 8 },
  { name: "Heavy", rate: 25 }, { name: "Downpour", rate: 75 },
];
// Snowfall as liquid-water equivalent (mm/h); fresh snow is about 10x deeper.
export const SNOW_LEVELS = [
  { name: "Flurries", rate: 0.2 }, { name: "Light", rate: 0.5 }, { name: "Moderate", rate: 1.5 },
  { name: "Heavy", rate: 3 }, { name: "Blizzard", rate: 6 },
];

export const rainSpeed = (D) => Math.max(0.5, 9.65 - 10.3 * Math.exp(-0.6 * D)) * 1000;
const dropMass = (D) => (Math.PI / 6) * D * D * D; // mg (water: 1 mg/mm^3)
const flakeMass = (D) => 0.037 * D ** 1.9;
const flakeSpeed = (D) => 800 * D ** 0.16;

// Drops landing per mm^2 per second, and a sampler for their diameters (flux-weighted).
function rainSpectrum(R) {
  const lam = 4.1 * R ** -0.21, N0 = 8000, Dmin = 0.3, Dmax = 6, n = 300;
  const cdf = new Float64Array(n + 1), Ds = new Float64Array(n + 1);
  let total = 0;
  for (let i = 0; i <= n; i++) {
    const D = Dmin + ((Dmax - Dmin) * i) / n;
    Ds[i] = D;
    if (i) total += N0 * Math.exp(-lam * D) * (rainSpeed(D) / 1000) * ((Dmax - Dmin) / n);
    cdf[i] = total;
  }
  return {
    rate: total * 1e-6, // per m^2 per s -> per mm^2 per s
    sample(u) {
      const x = u * total;
      let lo = 0, hi = n;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m; else hi = m; }
      return Ds[hi];
    },
  };
}

function snowSpectrum(S) {
  const mean = Math.min(9, 2 + 1.2 * S); // mm: big aggregate flakes in heavy snow
  const sample = (u) => Math.min(15, Math.max(0.6, -mean * Math.log(1 - u * 0.999)));
  let m = 0;
  for (let i = 0; i < 2000; i++) m += flakeMass(sample((i + 0.5) / 2000));
  m /= 2000;
  return { rate: S / 3600 / m, sample }; // water mm/s = mg per mm^2 per s
}

// Closest approach of segment p0->p1 to segment a->b; returns {d2, s (on p), t (on ab)}.
function segSeg(p0, p1, a, b) {
  const d1 = p1.clone().sub(p0), d2 = b.clone().sub(a), r = p0.clone().sub(a);
  const A = d1.dot(d1), E = d2.dot(d2), F = d2.dot(r);
  let s, t;
  if (A < 1e-12) { s = 0; t = Math.min(1, Math.max(0, F / E)); }
  else {
    const C = d1.dot(r), B = d1.dot(d2), den = A * E - B * B;
    s = den > 1e-12 ? Math.min(1, Math.max(0, (B * F - C * E) / den)) : 0;
    t = (B * s + F) / E;
    if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -C / A)); }
    else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (B - C) / A)); }
  }
  const q = p0.clone().addScaledVector(d1, s), w = a.clone().addScaledVector(d2, t);
  return { d2: q.distanceToSquared(w), s, t, point: q };
}

// Camera-facing streaks stretched along the velocity (rain, splash droplets, falling flakes).
function streakMesh(max, snow) {
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iSize = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
  quad.setAttribute("iPos", iPos);
  quad.setAttribute("iVel", iVel);
  quad.setAttribute("iSize", iSize);
  quad.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uShutter: { value: SHUTTER } },
    vertexShader: `
      attribute vec3 iPos, iVel; attribute float iSize;
      uniform float uShutter;
      varying vec2 vUv; varying float vLen;
      void main() {
        float sp = length(iVel);
        vec3 axis = sp > 1e-3 ? iVel / sp : vec3(0.0, 0.0, -1.0);
        float len = iSize + sp * uShutter;
        vec3 view = normalize(cameraPosition - iPos);
        vec3 side = cross(axis, view);
        side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
        vec3 p = iPos - axis * (position.x * len - 0.5 * iSize) + side * (position.y * 0.5 * iSize);
        vUv = vec2(position.x, position.y);
        vLen = len / iSize;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vLen;
      void main() {
        // A round drop at the head (u = 0.5 drop widths from the front), its blur trailing behind.
        float u = vUv.x * vLen, w = abs(vUv.y);
        float head = smoothstep(1.0, 0.7, length(vec2((u - 0.5) * 2.0, vUv.y)));
        float trail = u > 0.5 ? smoothstep(1.0, 0.6, w) * (1.0 - vUv.x) / max(1.0, 0.35 * vLen) : 0.0;
        float a = max(head, trail);
        ${snow
          ? "gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), a * 0.85);"
          : "gl_FragColor = vec4(mix(vec3(0.62, 0.7, 0.8), vec3(0.95), smoothstep(0.6, 0.0, w)), a * (0.3 + 0.25 * smoothstep(0.8, 0.0, w)));"}
      }`,
  });
  const mesh = new THREE.Mesh(quad, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return { mesh, iPos, iVel, iSize, quad };
}

// Splash rings on whatever a drop hits.
function ringMesh(max) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const iRing = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage); // x, y, z, radius
  const iA = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("iRing", iRing);
  g.setAttribute("iA", iA);
  g.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: `attribute vec4 iRing; attribute float iA; varying vec2 vUv; varying float vA;
      void main() { vUv = position.xy; vA = iA; gl_Position = projectionMatrix * viewMatrix * vec4(iRing.xyz + vec3(position.xy * iRing.w, 0.02), 1.0); }`,
    fragmentShader: `varying vec2 vUv; varying float vA;
      void main() { float r = length(vUv); float a = smoothstep(0.65, 0.85, r) * smoothstep(1.0, 0.88, r); gl_FragColor = vec4(0.85, 0.92, 1.0, a * vA * 0.7); }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return { mesh, iRing, iA, g };
}

function flakeTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.translate(64, 64);
  g.strokeStyle = "white";
  g.lineCap = "round";
  for (let k = 0; k < 6; k++) {
    g.rotate(Math.PI / 3);
    g.lineWidth = 7;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -58); g.stroke();
    g.lineWidth = 4;
    for (const [y, l] of [[-22, 16], [-38, 12], [-50, 7]]) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(l, y - l); g.moveTo(0, y); g.lineTo(-l, y - l); g.stroke();
    }
  }
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 20);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(-20, -20, 40, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Weather {
  /**
   * @param scene  three.js scene
   * @param env    { topAt(x, y) -> z of the surface a drop lands on, isLeaf(x, y, z),
   *                 impact(x, y, t, D), arenaRadius, wallHeight }
   */
  constructor(scene, env) {
    this.env = env;
    this.mode = "off";
    this.level = 2;
    this.wind = new THREE.Vector2(); // mm/s, from the wind tool
    this.falling = [];               // {x,y,z, vx,vy,vz, D, m, kind: rain|splash|flake, hitZ, phase, wob}
    this.rings = [];                 // {x,y,z, D, age}
    this.beads = [];                 // {x,y,z, r, age, life}
    this.settled = [];               // {x,y,z, D, yaw, age, life}
    this.onFly = [];                 // {p: local Vector3, D, yaw, age, life}
    this.spawnDebt = 0;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.rain = streakMesh(MAX_FALLING, false);
    this.snow = streakMesh(MAX_FALLING, true);
    this.ring = ringMesh(MAX_RINGS);
    this.group.add(this.rain.mesh, this.snow.mesh, this.ring.mesh);
    this.beadMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshPhysicalMaterial({ color: 0xe8f2ff, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.55, clearcoat: 1, envMapIntensity: 2.5 }), MAX_BEADS);
    this.beadMesh.count = 0;
    this.beadMesh.frustumCulled = false;
    const flakeMat = new THREE.MeshStandardMaterial({ map: flakeTexture(), transparent: true, alphaTest: 0.2, roughness: 0.9, side: THREE.DoubleSide, emissive: 0x9aa4b4, emissiveIntensity: 0.25, depthWrite: false });
    this.settledMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), flakeMat, MAX_SETTLED);
    this.settledMesh.count = 0;
    this.settledMesh.frustumCulled = false;
    this.flyFlakes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), flakeMat, MAX_ON_FLY);
    this.flyFlakes.count = 0;
    this.flyFlakes.frustumCulled = false;
    this.group.add(this.beadMesh, this.settledMesh);
    this.flyRoot = null;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._spectrum();
  }

  attachFly(root) {
    this.flyRoot = root;
    root.add(this.flyFlakes);
  }

  set(mode, level = this.level) {
    this.mode = mode;
    this.level = level;
    this._spectrum();
  }

  get levelInfo() {
    return (this.mode === "snow" ? SNOW_LEVELS : RAIN_LEVELS)[this.level];
  }

  _spectrum() {
    this.spec = this.mode === "rain" ? rainSpectrum(RAIN_LEVELS[this.level].rate)
      : this.mode === "snow" ? snowSpectrum(SNOW_LEVELS[this.level].rate) : null;
  }

  // Where a straight-falling drop from (x, y, z) with velocity v first meets a surface.
  _landing(d) {
    let z = Math.min(d.z, 14);
    const kx = d.vx / d.vz, ky = d.vy / d.vz;
    for (; z > -0.01; z -= 0.04) {
      const x = d.x + kx * (z - d.z), y = d.y + ky * (z - d.z);
      if (z <= this.env.topAt(x, y)) return z;
    }
    return 0;
  }

  _spawn(cx, cy, radius, top) {
    const D = this.spec.sample(Math.random());
    const a = Math.random() * 2 * Math.PI, r = radius * Math.sqrt(Math.random());
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (this.mode === "rain") {
      const v = rainSpeed(D);
      const d = { x, y, z: top, vx: this.wind.x, vy: this.wind.y, vz: -v, D, m: dropMass(D), kind: "rain" };
      // Start upwind so the slanted streak still lands near the fly.
      const fall = top / v;
      d.x -= d.vx * fall; d.y -= d.vy * fall;
      d.hitZ = this._landing(d);
      this.falling.push(d);
    } else {
      const v = flakeSpeed(D) * (0.85 + 0.3 * Math.random());
      this.falling.push({ x, y, z: top, vx: 0, vy: 0, vz: -v, D, m: flakeMass(D), kind: "flake",
        phase: Math.random() * 6.28, wob: 0.6 * D, f: 1 + Math.random(), wx: this.wind.x, wy: this.wind.y });
    }
  }

  // Splash: a crown of droplets thrown out and up, plus a ring, from a drop of diameter D.
  _splash(x, y, z, D, v, onLeaf) {
    this.rings.push({ x, y, z, D, age: 0 });
    // Only nearby impacts are animated in the grass and leaves (the shaders keep 16).
    if (D > 0.5 && Math.hypot(x - this._fx, y - this._fy) < 30) this.env.impact(x, y, D);
    if (onLeaf && D > 0.7 && Math.random() < 0.6) {
      this.beads.push({ x, y, z, r: 0.35 * D, age: 0, life: 25 + 20 * Math.random() });
      if (this.beads.length > MAX_BEADS) this.beads.shift();
    }
    if (D < 0.8) return;
    const n = Math.min(14, Math.round(D * D * 2));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 2 * Math.PI, el = 0.35 + Math.random() * 0.7;
      const sp = v * (0.06 + 0.12 * Math.random());
      const Dd = D * (0.08 + 0.15 * Math.random());
      this.falling.push({ x, y, z: z + 0.05, vx: sp * Math.cos(el) * Math.cos(a), vy: sp * Math.cos(el) * Math.sin(a), vz: sp * Math.sin(el),
        D: Dd, m: dropMass(Dd), kind: "splash" });
    }
  }

  /**
   * Advance by dt seconds of simulated time.
   * fly: {x, y, feetZ, heading (deg), flying, length}; returns hits on the fly:
   * [{kind, D, mass, v: Vector3, zone, side, point}]
   */
  update(dt, t, fly, view) {
    const hits = [];
    if (dt <= 0) return hits;
    this._fx = fly.x; this._fy = fly.y;
    dt = Math.min(dt, 0.05);
    // Fill the air the camera looks through: wider and higher when zoomed out.
    const top = 40 + view.dist;
    const radius = Math.min(260, 60 + 1.2 * view.dist);
    if (this.spec) {
      this.spawnDebt += this.spec.rate * Math.PI * radius * radius * dt;
      while (this.spawnDebt >= 1 && this.falling.length < MAX_FALLING) { this._spawn(view.x, view.y, radius, top); this.spawnDebt -= 1; }
      if (this.spawnDebt > 1) this.spawnDebt = 0; // over budget: drop the rest
    }
    // The fly as a capsule along its body axis; with wings beating it sweeps a wider disc.
    const h = (fly.heading * Math.PI) / 180, ax = Math.cos(h), ay = Math.sin(h);
    const cz = fly.feetZ + 0.7, half = 1.0, rad = fly.flying ? 1.4 : 0.55;
    const A = new THREE.Vector3(fly.x - ax * half, fly.y - ay * half, cz), B = new THREE.Vector3(fly.x + ax * half, fly.y + ay * half, cz);
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    const R = this.env.arenaRadius;
    const keep = [];
    for (const d of this.falling) {
      p0.set(d.x, d.y, d.z);
      if (d.kind === "flake") {
        d.phase += 2 * Math.PI * d.f * dt;
        d.vx = d.wx + d.wob * 2 * Math.PI * d.f * Math.cos(d.phase);
        d.vy = d.wy + d.wob * 2 * Math.PI * d.f * Math.sin(1.3 * d.phase);
      } else if (d.kind === "splash") d.vz -= GRAVITY * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      p1.set(d.x, d.y, d.z);
      // The fly first: it can be hit before the drop reaches the ground under it.
      const seg = segSeg(p0, p1, A, B);
      const rr = rad + d.D / 2;
      if (seg.d2 < rr * rr && seg.point.z > (d.hitZ ?? -1) - 0.01) {
        const along = (seg.t - 0.5) * 2; // -1 tail .. +1 head
        const side = (ax * (seg.point.y - fly.y) - ay * (seg.point.x - fly.x)) >= 0 ? "L" : "R";
        const zone = !fly.flying && seg.point.z < fly.feetZ + 0.35 ? "legs" : along > 0.55 ? "head" : along < -0.25 ? "abdomen" : "thorax";
        hits.push({ kind: d.kind, D: d.D, mass: d.m, v: new THREE.Vector3(d.vx, d.vy, d.vz), zone, side, point: seg.point.clone() });
        if (d.kind === "flake") {
          if (!fly.flying && this.flyRoot) this._stickToFly(seg.point, d.D);
        } else if (d.kind === "rain") this._splash(seg.point.x, seg.point.y, seg.point.z, d.D * 0.8, Math.abs(d.vz), false);
        continue;
      }
      // Then the ground, leaves, food; the glass wall stops anything inside it.
      const rNow = Math.hypot(d.x, d.y);
      if (rNow > R && Math.hypot(p0.x, p0.y) <= R && d.z < this.env.wallHeight) continue;
      if (d.kind === "rain") {
        if (d.z <= d.hitZ) {
          const k = (d.hitZ - p0.z) / (d.z - p0.z || -1);
          const x = p0.x + (d.x - p0.x) * k, y = p0.y + (d.y - p0.y) * k;
          this._splash(x, y, d.hitZ, d.D, Math.abs(d.vz), this.env.isLeaf(x, y, d.hitZ));
          continue;
        }
      } else {
        const ground = this.env.topAt(d.x, d.y);
        if (d.z <= ground) {
          if (d.kind === "flake") this._settle(d.x, d.y, ground, d.D);
          else if (d.D > 0.3) this.rings.push({ x: d.x, y: d.y, z: ground, D: d.D, age: 0 });
          continue;
        }
        if (d.z < -5 || Math.hypot(d.x - view.x, d.y - view.y) > 400) continue;
      }
      keep.push(d);
    }
    this.falling = keep;
    this._age(dt, fly);
    this._draw();
    return hits;
  }

  _settle(x, y, z, D) {
    this.settled.push({ x, y, z: z + 0.02 + Math.random() * 0.03, D, yaw: Math.random() * 6.28, age: 0, life: 60 + 60 * Math.random() });
    if (this.settled.length > MAX_SETTLED) this.settled.shift();
    this._settledDirty = true;
  }

  _stickToFly(point, D) {
    const p = this.flyRoot.worldToLocal(point.clone());
    this.onFly.push({ p, D: Math.min(D, 3), yaw: Math.random() * 6.28, age: 0, life: 8 + 6 * Math.random() });
    if (this.onFly.length > MAX_ON_FLY) this.onFly.shift();
  }

  _age(dt, fly) {
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < 0.12);
    if (this.rings.length > MAX_RINGS) this.rings.splice(0, this.rings.length - MAX_RINGS);
    for (const b of this.beads) b.age += dt;
    this.beads = this.beads.filter((b) => b.age < b.life);
    for (const s of this.settled) s.age += dt;
    const n = this.settled.length;
    this.settled = this.settled.filter((s) => s.age < s.life);
    if (this.settled.length !== n) this._settledDirty = true;
    // Flakes melt; a flying fly sheds them.
    for (const f of this.onFly) f.age += fly.flying ? dt * 20 : dt;
    this.onFly = this.onFly.filter((f) => f.age < f.life);
  }

  _draw() {
    const rain = this.rain, snow = this.snow;
    let nr = 0, ns = 0;
    for (const d of this.falling) {
      const o = d.kind === "flake" ? snow : rain;
      const i = d.kind === "flake" ? ns++ : nr++;
      o.iPos.setXYZ(i, d.x, d.y, d.z);
      o.iVel.setXYZ(i, d.vx, d.vy, d.vz);
      o.iSize.setX(i, d.kind === "flake" ? d.D : Math.max(0.15, d.D));
    }
    for (const [o, n] of [[rain, nr], [snow, ns]]) {
      o.quad.instanceCount = n;
      o.iPos.needsUpdate = o.iVel.needsUpdate = o.iSize.needsUpdate = true;
    }
    const g = this.ring;
    this.rings.forEach((r, i) => {
      const f = r.age / 0.12;
      g.iRing.setXYZW(i, r.x, r.y, r.z, r.D * (0.6 + 2.5 * f));
      g.iA.setX(i, 1 - f);
    });
    g.g.instanceCount = this.rings.length;
    g.iRing.needsUpdate = g.iA.needsUpdate = true;
    const m = this._m, q = this._q, s = this._s, v = this._v;
    this.beads.forEach((b, i) => {
      const k = 1 - Math.max(0, (b.age - b.life + 5) / 5); // evaporate over the last 5 s
      m.compose(v.set(b.x, b.y, b.z), q.identity(), s.set(b.r * k, b.r * k, b.r * k * 0.7));
      this.beadMesh.setMatrixAt(i, m);
    });
    this.beadMesh.count = this.beads.length;
    this.beadMesh.instanceMatrix.needsUpdate = true;
    if (this._settledDirty || (this.settled.length && Math.random() < 0.1)) {
      this.settled.forEach((f, i) => {
        const k = Math.min(1, (f.life - f.age) / 10); // shrink as it melts
        m.compose(v.set(f.x, f.y, f.z), q.setFromAxisAngle(v.set(0, 0, 1), f.yaw), s.set(f.D * k, f.D * k, 1));
        m.setPosition(f.x, f.y, f.z);
        this.settledMesh.setMatrixAt(i, m);
      });
      this.settledMesh.count = this.settled.length;
      this.settledMesh.instanceMatrix.needsUpdate = true;
      this._settledDirty = false;
    }
    this.onFly.forEach((f, i) => {
      const k = Math.min(1, (f.life - f.age) / 3);
      m.compose(f.p, q.setFromAxisAngle(v.set(0, 0, 1), f.yaw), s.set(f.D * k, f.D * k, 1));
      this.flyFlakes.setMatrixAt(i, m);
    });
    this.flyFlakes.count = this.onFly.length;
    this.flyFlakes.instanceMatrix.needsUpdate = true;
  }

  clearSettled() {
    this.settled = []; this.beads = []; this.onFly = [];
    this._settledDirty = true;
    this._draw();
  }

  get active() {
    return this.mode !== "off" || this.falling.length > 0;
  }
}
