// Moving about the arena with the camera unlocked (not following the fly or a frog): on top of
// the orbit controls (drag to turn, pinch or wheel to zoom, two-finger or right-drag to pan
// along the ground), the keyboard glides the view (W A S D or the arrow keys; Q and E turn it,
// R and F zoom, Shift for speed), a joystick on touch screens does the same, and a double tap or
// double click glides the view to that spot. Speeds scale with how far out the camera is.
import * as THREE from "three";

const CSS = `
  .cam-stick { position: fixed; left: 18px; bottom: max(110px, calc(env(safe-area-inset-bottom) + 96px)); width: 120px; height: 120px;
    border-radius: 50%; background: rgba(20, 17, 14, 0.38); border: 1px solid rgba(255, 240, 220, 0.25); z-index: 6;
    touch-action: none; display: none; }
  .cam-stick.on { display: block; }
  .cam-stick i { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%;
    background: rgba(255, 240, 220, 0.55); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); pointer-events: none; }
  .cam-stick span { position: absolute; left: 0; right: 0; top: -20px; text-align: center; font: 600 11px system-ui, sans-serif;
    color: rgba(255, 245, 230, 0.8); text-shadow: 0 1px 2px #000; pointer-events: none; }
`;

export class FreeCam {
  /**
   * camera, controls (OrbitControls), canvas; pick(clientX, clientY): a point on the ground
   * there (or null); groundAt(x, y); radius: keep the view inside the arena.
   */
  constructor(camera, controls, canvas, { pick, groundAt = () => 0, radius = 450 } = {}) {
    Object.assign(this, { camera, controls, canvas, pick, groundAt, radius });
    this.keys = new Set();
    this.stick = { x: 0, y: 0 };
    this.glide = null;
    this.active = false;
    controls.screenSpacePanning = false; // panning slides along the ground
    controls.panSpeed = 1.2;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    // keyboard
    const typing = (e) => /input|select|textarea/i.test(e.target?.tagName || "") || e.target?.isContentEditable;
    addEventListener("keydown", (e) => { if (!typing(e)) this.keys.add(e.key.toLowerCase()); });
    addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener("blur", () => this.keys.clear());
    // joystick (touch screens)
    const el = (this.el = document.createElement("div"));
    el.className = "cam-stick";
    el.innerHTML = "<span>Move</span><i></i>";
    document.body.append(el);
    const knob = el.querySelector("i");
    let pid = null;
    const setStick = (e) => {
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
      let dx = (e.clientX - cx) / R, dy = (e.clientY - cy) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.stick.x = dx; this.stick.y = -dy;
      knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
    };
    el.addEventListener("pointerdown", (e) => { pid = e.pointerId; el.setPointerCapture(pid); setStick(e); e.preventDefault(); e.stopPropagation(); });
    el.addEventListener("pointermove", (e) => { if (e.pointerId === pid) { setStick(e); e.preventDefault(); } });
    const release = (e) => { if (e.pointerId !== pid) return; pid = null; this.stick.x = this.stick.y = 0; knob.style.transform = ""; };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    // double tap / double click: glide there
    let lastTap = 0, lastXY = [0, 0];
    canvas.addEventListener("dblclick", (e) => this._goTo(e.clientX, e.clientY));
    canvas.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "touch") return;
      const now = performance.now();
      if (now - lastTap < 320 && Math.hypot(e.clientX - lastXY[0], e.clientY - lastXY[1]) < 30) { this._goTo(e.clientX, e.clientY); lastTap = 0; }
      else { lastTap = now; lastXY = [e.clientX, e.clientY]; }
    });
    this.touch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  }

  /** Whether the camera is free (unlocked): shows the joystick on touch screens. */
  setActive(on) {
    this.active = on;
    this.el.classList.toggle("on", on && this.touch);
    if (!on) { this.glide = null; this.stick.x = this.stick.y = 0; }
  }

  _goTo(x, y) {
    if (!this.active || !this.pick) return;
    const p = this.pick(x, y);
    if (!p) return;
    this.glide = { from: this.controls.target.clone(), to: p.clone(), t: 0 };
  }

  /** Move the camera and its target together by `d` (world). */
  _shift(d) {
    const t = this.controls.target, r = Math.hypot(t.x + d.x, t.y + d.y), R = this.radius;
    if (r > R) { const k = R / r; d.x = (t.x + d.x) * k - t.x; d.y = (t.y + d.y) * k - t.y; }
    t.add(d);
    this.camera.position.add(d);
  }

  /** Per frame (dt seconds), while free. */
  update(dt) {
    if (!this.active) return;
    const c = this.controls, cam = this.camera, k = this.keys;
    const dist = cam.position.distanceTo(c.target);
    const fast = k.has("shift") ? 3 : 1;
    // along the ground, relative to where the camera looks
    const fwd = new THREE.Vector3().subVectors(c.target, cam.position).setZ(0);
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 1, 0);
    fwd.normalize();
    const right = new THREE.Vector3(fwd.y, -fwd.x, 0);
    let mx = this.stick.x, my = this.stick.y;
    if (k.has("w") || k.has("arrowup")) my += 1;
    if (k.has("s") || k.has("arrowdown")) my -= 1;
    if (k.has("d") || k.has("arrowright")) mx += 1;
    if (k.has("a") || k.has("arrowleft")) mx -= 1;
    const speed = Math.min(700, Math.max(15, dist * 1.4)) * fast; // mm/s
    if (mx || my) {
      this.glide = null;
      this._shift(fwd.multiplyScalar(my * speed * dt).addScaledVector(right, mx * speed * dt));
    }
    // turn about the target, and zoom
    let turn = 0, zoom = 0;
    if (k.has("q")) turn += 1;
    if (k.has("e")) turn -= 1;
    if (k.has("r") || k.has("+") || k.has("=")) zoom -= 1;
    if (k.has("f") || k.has("-")) zoom += 1;
    if (turn) {
      const off = cam.position.clone().sub(c.target).applyAxisAngle(new THREE.Vector3(0, 0, 1), turn * 1.6 * fast * dt);
      cam.position.copy(c.target).add(off);
    }
    if (zoom) {
      const off = cam.position.clone().sub(c.target), d = off.length();
      const nd = Math.min(c.maxDistance, Math.max(c.minDistance, d * Math.exp(zoom * 1.4 * fast * dt)));
      cam.position.copy(c.target).add(off.multiplyScalar(nd / d));
    }
    // a glide to a double-tapped spot
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / 0.7);
      const e = g.t * g.t * (3 - 2 * g.t);
      const want = g.from.clone().lerp(g.to, e);
      this._shift(want.sub(c.target));
      if (g.t >= 1) this.glide = null;
    }
    // the target stays on the ground (a little above it), so turning and zooming stay natural
    const gz = this.groundAt(c.target.x, c.target.y) + 0.8;
    if (Math.abs(c.target.z - gz) > 0.01) {
      const dz = (gz - c.target.z) * Math.min(1, dt * 6);
      c.target.z += dz;
      cam.position.z += dz;
    }
  }
}
