// Four-leaf clovers. Two grow somewhere new on every visit (terrain.js: _addWeeds), giving
// a faint glint now and then. Tap or click one and it is picked: it rises, spinning and
// glowing gold, bursts into golden sparkles with a chime, a rainbow arches over the arena,
// and gold motes drift down round the fly for a while. In the game the pet feels lucky
// (mood and energy full). Then it is gone, and grows again at a random spot elsewhere.
import * as THREE from "three";

const RAINBOW_S = 28;  // how long the rainbow stays (s)
const MOTES_S = 22;    // how long gold motes fall round the fly (s)
const REGROW_S = 3;    // once picked (and burst), it grows again at a random spot elsewhere (s)

function sparkleTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.2, "rgba(255,236,160,0.9)");
  grd.addColorStop(0.5, "rgba(255,200,60,0.25)");
  grd.addColorStop(1, "rgba(255,180,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  // a four-pointed star
  g.strokeStyle = "rgba(255,255,230,0.9)";
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(32, 2); g.lineTo(32, 62); g.moveTo(2, 32); g.lineTo(62, 32); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class LuckyClovers {
  /** terrain: its `lucky` clovers ({mesh, items: [{x, y, s, i}]}); onFound(count) when one is picked. */
  constructor(scene, camera, terrain, { onFound, groundAt } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.terrain = terrain;
    this.onFound = onFound;
    this.groundAt = groundAt || (() => 0);
    this.tex = sparkleTexture();
    this.effects = [];
    this.regrow = [];
    this.t = 0;
    try { this.found = +localStorage.getItem("clovers-found") || 0; } catch { this.found = 0; }
    // the glints that give them away, one per clover
    this.glints = [];
  }

  get clovers() { return this.terrain.lucky?.items.filter((c) => !c.picked) || []; }

  /** A tap or click at (clientX, clientY) on `canvas`: picks a clover within reach of it. */
  tryPick(clientX, clientY, canvas, flyAt) {
    const r = canvas.getBoundingClientRect(), v = new THREE.Vector3();
    let best = null, bestD = Infinity;
    for (const c of this.clovers) {
      v.set(c.x, c.y, this.groundAt(c.x, c.y) + 1.2).project(this.camera);
      if (v.z > 1) continue; // behind the camera
      const sx = r.left + (v.x * 0.5 + 0.5) * r.width, sy = r.top + (-v.y * 0.5 + 0.5) * r.height;
      // generous on a touch screen: within ~30 px, or the clover's own size on screen if larger
      const dist = this.camera.position.distanceTo(v.set(c.x, c.y, 0));
      const px = Math.max(30, (c.s * 3.2 / (dist * Math.tan((this.camera.fov * Math.PI) / 360))) * r.height * 0.5);
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < px && d < bestD) { best = c; bestD = d; }
    }
    if (!best) return false;
    this._pick(best, flyAt);
    return true;
  }

  _pick(c, flyAt) {
    c.picked = true;
    const { mesh } = this.terrain.lucky;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(c.i, m);
    mesh.setMatrixAt(c.i, new THREE.Matrix4().makeScale(0, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
    this.found++;
    try { localStorage.setItem("clovers-found", String(this.found)); } catch {}
    const z0 = this.groundAt(c.x, c.y);
    // 1. the clover itself, rising and spinning, turning gold
    const geo = mesh.geometry, mat = new THREE.MeshStandardMaterial({ color: 0x4f9a36, emissive: 0xffc23a, emissiveIntensity: 0, metalness: 0.3, roughness: 0.35, side: THREE.DoubleSide });
    const leaf = new THREE.Mesh(geo, mat);
    leaf.applyMatrix4(m);
    leaf.position.z = z0;
    this.scene.add(leaf);
    // (no extra light: adding one would make every material recompile, a stall on a phone)
    this.effects.push({ kind: "rise", t: 0, leaf, mat, x: c.x, y: c.y, z0, s: leaf.scale.x });
    this._chime();
    // 2. the rainbow over the arena, across the camera's view
    this._rainbow();
    // 3. gold motes round the fly
    this.effects.push({ kind: "motes", t: 0, flyAt, pts: this._points(220, 0.9), seeded: false });
    // a new one grows somewhere else later
    this.regrow.push({ at: this.t + REGROW_S, c });
    this.onFound?.(this.found);
  }

  _points(n, size) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const m = new THREE.PointsMaterial({ map: this.tex, size, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe08a });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    p.userData.vel = new Float32Array(n * 3);
    p.userData.life = new Float32Array(n);
    this.scene.add(p);
    return p;
  }

  _burst(x, y, z) {
    const p = this._points(160, 1.6), pos = p.geometry.attributes.position.array, vel = p.userData.vel, life = p.userData.life;
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2, sp = 10 + Math.random() * 35;
      pos.set([x, y, z], i * 3);
      vel.set([Math.cos(a) * Math.cos(e) * sp, Math.sin(a) * Math.cos(e) * sp, Math.abs(Math.sin(e)) * sp + 8], i * 3);
      life[i] = 0.8 + Math.random() * 1.4;
    }
    this.effects.push({ kind: "burst", t: 0, pts: p });
  }

  _rainbow() {
    const R = this.terrain.radius;
    const g = new THREE.RingGeometry(R * 1.55, R * 1.85, 128, 1, 0, Math.PI);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uA: { value: 0 }, uIn: { value: R * 1.55 }, uOut: { value: R * 1.85 } },
      vertexShader: "varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform float uA, uIn, uOut; varying vec2 vP;
        vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
        void main() {
          float f = (length(vP) - uIn) / (uOut - uIn);              // 0 inside (violet) .. 1 outside (red)
          float edge = smoothstep(0.0, 0.12, f) * smoothstep(1.0, 0.88, f);
          float ends = smoothstep(0.0, 0.25, vP.y / uOut);            // fading into the ground at its feet
          gl_FragColor = vec4(hue(0.78 * (1.0 - f)) * edge * ends * uA * 0.55, 1.0);
        }`,
    });
    const bow = new THREE.Mesh(g, m);
    bow.frustumCulled = false;
    // standing up (Z), facing the camera across the arena, its feet beyond the far side
    const dir = new THREE.Vector3().subVectors(new THREE.Vector3(0, 0, 0), this.camera.position).setZ(0);
    if (dir.lengthSq() < 1) dir.set(0, 1, 0);
    dir.normalize();
    bow.position.set(dir.x * R * 1.4, dir.y * R * 1.4, -R * 0.3);
    bow.up.set(0, 0, 1);
    bow.lookAt(bow.position.clone().sub(dir));
    this.scene.add(bow);
    this.effects.push({ kind: "rainbow", t: 0, bow, mat: m });
  }

  _chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = this.ctx || (this.ctx = new AC());
      ctx.resume?.();
      const t0 = ctx.currentTime + 0.02;
      [784, 988, 1175, 1568, 1976].forEach((f, k) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + k * 0.09);
        g.gain.linearRampToValueAtTime(0.12, t0 + k * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + k * 0.09 + 1.4);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + k * 0.09); o.stop(t0 + k * 0.09 + 1.5);
      });
    } catch { /* no sound */ }
  }

  /** Per frame: dt (s), the fly's position {x, y, z}. */
  update(dt, fly) {
    this.t += dt;
    dt = Math.min(dt, 0.1);
    // glints: every few seconds a brief sparkle on each unpicked clover
    const live = this.clovers;
    while (this.glints.length < live.length) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      s.scale.setScalar(2.2);
      this.scene.add(s);
      this.glints.push(s);
    }
    this.glints.forEach((s, k) => {
      const c = live[k];
      if (!c) { s.visible = false; return; }
      s.visible = true;
      const ph = (this.t + k * 2.7) % 6.5, a = ph < 0.6 ? Math.sin((ph / 0.6) * Math.PI) : 0;
      s.material.opacity = a * 0.9;
      s.material.rotation = this.t * 2;
      s.position.set(c.x + 0.6, c.y - 0.4, this.groundAt(c.x, c.y) + 1.4);
    });
    for (const e of this.effects) {
      e.t += dt;
      if (e.kind === "rise") {
        const u = Math.min(1, e.t / 1.6);
        e.leaf.position.z = e.z0 + 18 * (1 - (1 - u) ** 3);
        e.leaf.rotation.z += dt * (3 + 9 * u);
        e.mat.emissiveIntensity = 2.2 * u;
        e.mat.color.lerpColors(new THREE.Color(0x4f9a36), new THREE.Color(0xffd45a), u);
        if (e.t >= 1.6 && !e.burst) {
          e.burst = true;
          this._burst(e.x, e.y, e.leaf.position.z);
          this.scene.remove(e.leaf);
          e.mat.dispose();
        }
        if (e.t > 2.4) e.done = true;
      } else if (e.kind === "burst") {
        const pos = e.pts.geometry.attributes.position.array, vel = e.pts.userData.vel, life = e.pts.userData.life;
        for (let i = 0; i < life.length; i++) {
          vel[i * 3 + 2] -= 25 * dt;
          for (let k = 0; k < 3; k++) { vel[i * 3 + k] *= Math.exp(-1.6 * dt); pos[i * 3 + k] += vel[i * 3 + k] * dt; }
        }
        e.pts.geometry.attributes.position.needsUpdate = true;
        e.pts.material.opacity = Math.max(0, 1 - e.t / 2.2);
        e.pts.material.size = 1.6 * (1 + 0.3 * Math.sin(e.t * 30));
        if (e.t > 2.2) { this.scene.remove(e.pts); e.pts.geometry.dispose(); e.pts.material.dispose(); e.done = true; }
      } else if (e.kind === "rainbow") {
        e.mat.uniforms.uA.value = Math.min(1, e.t / 3) * Math.min(1, Math.max(0, (RAINBOW_S - e.t) / 5));
        if (e.t > RAINBOW_S) { this.scene.remove(e.bow); e.bow.geometry.dispose(); e.mat.dispose(); e.done = true; }
      } else if (e.kind === "motes" && fly) {
        // gold motes drifting down round the fly, gently twinkling
        const pos = e.pts.geometry.attributes.position.array, vel = e.pts.userData.vel, life = e.pts.userData.life, n = life.length;
        const spawn = e.t < MOTES_S - 4;
        for (let i = 0; i < n; i++) {
          life[i] -= dt;
          if (life[i] <= 0 || !e.seeded) {
            if (!spawn && e.seeded) { pos[i * 3 + 2] = -1e4; continue; }
            const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 14;
            pos.set([fly.x + Math.cos(a) * rr, fly.y + Math.sin(a) * rr, (fly.z || 0) + 6 + Math.random() * 14], i * 3);
            vel.set([(Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, -(1.5 + Math.random() * 2.5)], i * 3);
            life[i] = 2 + Math.random() * 4;
          }
          for (let k = 0; k < 3; k++) pos[i * 3 + k] += vel[i * 3 + k] * dt;
          pos[i * 3] += Math.sin(this.t * 2 + i) * 0.4 * dt;
        }
        e.seeded = true;
        e.pts.geometry.attributes.position.needsUpdate = true;
        e.pts.material.opacity = Math.min(1, e.t / 1.5) * Math.min(1, Math.max(0, (MOTES_S - e.t) / 3));
        e.pts.material.size = 0.7 + 0.25 * Math.sin(this.t * 9);
        if (e.t > MOTES_S) { this.scene.remove(e.pts); e.pts.geometry.dispose(); e.pts.material.dispose(); e.done = true; }
      }
    }
    this.effects = this.effects.filter((e) => !e.done);
    // a new four-leaf clover grows somewhere else
    for (const g of this.regrow) {
      if (this.t < g.at) continue;
      g.done = true;
      const c = g.c, [x, y] = this.terrain._luckySpot();
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * 6.28), new THREE.Vector3(c.s, c.s, c.s));
      this.terrain.lucky.mesh.setMatrixAt(c.i, m);
      this.terrain.lucky.mesh.instanceMatrix.needsUpdate = true;
      Object.assign(c, { x, y, picked: false });
    }
    this.regrow = this.regrow.filter((g) => !g.done);
  }
}
