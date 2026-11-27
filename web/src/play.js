// Play as the fly, the frog or the toad (optional: "Watch" leaves them to themselves).
// Controls, on any device:
//   move   keyboard W A S D or the arrow keys, a game controller's left stick or D-pad, or the
//          joystick on a touch screen. The fly: forward/back and turn. A frog: hop (or swim)
//          that way, relative to the camera.
//   jump   Space, controller A, or the first button: the fly takes off or lands; a frog jumps.
//   act    E or Enter, controller X / B / right trigger, or the second button: the fly
//          grooms; a frog strikes with its tongue (at the fly, if it is in reach).
//   view   V, controller Y, or the View button: orbit, third person (behind it), first
//          person (from its eyes).
// The fly's brain still runs: a looming threat can still make it escape, stress still builds.
import * as THREE from "three";

const CSS = `
  .play-pad { position: fixed; inset: auto 0 0 0; height: 0; z-index: 7; display: none; }
  .play-pad.on { display: block; }
  .play-stick { position: fixed; left: 18px; bottom: max(110px, calc(env(safe-area-inset-bottom) + 96px)); width: 130px; height: 130px;
    border-radius: 50%; background: rgba(20, 17, 14, 0.38); border: 1px solid rgba(255, 240, 220, 0.25); touch-action: none; }
  .play-stick i { position: absolute; left: 50%; top: 50%; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
    background: rgba(255, 240, 220, 0.6); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); pointer-events: none; }
  .play-btn { position: fixed; right: 18px; width: 78px; height: 78px; border-radius: 50%; border: 1px solid rgba(255, 240, 220, 0.3);
    background: rgba(40, 34, 28, 0.7); color: #f4ede2; font: 700 15px system-ui, sans-serif; touch-action: none; }
  .play-btn:active { transform: scale(0.95); background: rgba(70, 58, 44, 0.85); }
  .play-btn.a { bottom: max(196px, calc(env(safe-area-inset-bottom) + 182px)); right: 26px; background: rgba(214, 150, 70, 0.8); color: #2a1c0a; }
  .play-btn.b { bottom: max(110px, calc(env(safe-area-inset-bottom) + 96px)); right: 100px; }
  .play-btn.v { width: 56px; height: 40px; border-radius: 12px; font-size: 12px; bottom: max(290px, calc(env(safe-area-inset-bottom) + 276px)); right: 30px; }
`;

const LABELS = {
  fly: (air) => [air ? "Land" : "Fly", "Groom"],
  small: () => ["Jump", "Tongue"],
  big: () => ["Jump", "Tongue"],
};

export class Play {
  /**
   * camera; body (the fly, world.js); predators (FrogPredators); onMode(mode): the app
   * follows the character with the camera, etc.
   */
  constructor({ camera, controls, body, predators, onMode }) {
    Object.assign(this, { camera, controls, body, predators, onMode });
    this.mode = "watch";
    this.view = "orbit"; // "orbit", "third" (behind it) or "first" (from its eyes): V, controller Y, the View button
    this.keys = new Set();
    this.stick = { x: 0, y: 0 };
    this.pads = navigator.getGamepads ? true : false;
    this.prevPad = {};
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const typing = (e) => /input|select|textarea/i.test(e.target?.tagName || "") || e.target?.isContentEditable;
    addEventListener("keydown", (e) => {
      if (this.mode === "watch" || typing(e)) return;
      const k = e.key.toLowerCase();
      if (!e.repeat && k === " ") { this.press("a"); e.preventDefault(); }
      if (!e.repeat && (k === "e" || k === "enter")) this.press("b", true);
      if (!e.repeat && k === "v") this.cycleView();
      this.keys.add(k);
    });
    addEventListener("keyup", (e) => { const k = e.key.toLowerCase(); this.keys.delete(k); if (k === "e" || k === "enter") this.press("b", false); });
    addEventListener("blur", () => this.keys.clear());
    // touch: a joystick and two buttons
    const pad = (this.pad = document.createElement("div"));
    pad.className = "play-pad";
    pad.innerHTML = `<div class="play-stick"><i></i></div><button class="play-btn a">Jump</button><button class="play-btn b">Act</button><button class="play-btn v">View</button>`;
    document.body.append(pad);
    const stick = pad.querySelector(".play-stick"), knob = stick.querySelector("i");
    let pid = null;
    const setStick = (e) => {
      const r = stick.getBoundingClientRect(), R = r.width / 2;
      let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.stick.x = dx; this.stick.y = -dy;
      knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
    };
    stick.addEventListener("pointerdown", (e) => { pid = e.pointerId; stick.setPointerCapture(pid); setStick(e); e.preventDefault(); });
    stick.addEventListener("pointermove", (e) => { if (e.pointerId === pid) setStick(e); });
    const release = (e) => { if (e.pointerId !== pid) return; pid = null; this.stick.x = this.stick.y = 0; knob.style.transform = ""; };
    stick.addEventListener("pointerup", release);
    stick.addEventListener("pointercancel", release);
    this.btnA = pad.querySelector(".a");
    this.btnB = pad.querySelector(".b");
    this.btnA.addEventListener("pointerdown", (e) => { e.preventDefault(); this.press("a"); });
    this.btnB.addEventListener("pointerdown", (e) => { e.preventDefault(); this.press("b", true); });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) this.btnB.addEventListener(ev, () => this.press("b", false));
    this.btnV = pad.querySelector(".v");
    this.btnV.addEventListener("pointerdown", (e) => { e.preventDefault(); this.cycleView(); });
    this.touch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  }

  /** The camera: orbit -> third person -> first person -> orbit. */
  cycleView(to) {
    const order = ["orbit", "third", "first"];
    this.view = to || order[(order.indexOf(this.view) + 1) % order.length];
    this.btnV.textContent = { orbit: "Orbit", third: "3rd", first: "1st" }[this.view];
    this.onView?.(this.view);
  }

  /** "watch", "fly", "small" (the frog) or "big" (the toad). */
  setMode(mode) {
    this.mode = mode;
    this.body.player = mode === "fly" ? { fwd: 0, turn: 0, takeoff: false, land: false, groom: false } : null;
    this.frogInput = mode === "small" || mode === "big" ? this.predators?.setPlayer(mode) : (this.predators?.setPlayer(null), null);
    this.pad.classList.toggle("on", mode !== "watch" && this.touch);
    this._labels();
    this.onMode?.(mode);
  }

  _labels() {
    const l = LABELS[this.mode]?.(this.body.airborne > 0);
    if (!l) return;
    if (this.btnA.textContent !== l[0]) this.btnA.textContent = l[0];
    if (this.btnB.textContent !== l[1]) this.btnB.textContent = l[1];
  }

  /** A button: "a" (jump / take off or land) pressed; "b" (act) pressed or released. */
  press(which, down = true) {
    if (this.mode === "fly") {
      const P = this.body.player;
      if (!P) return;
      if (which === "a" && down) { if (this.body.airborne > 0) P.land = true; else P.takeoff = true; }
      if (which === "b") P.groom = down;
    } else if (this.frogInput && down) {
      if (which === "a") this.frogInput.jump = true;
      if (which === "b") this.frogInput.tongue = true;
    }
  }

  /** Per frame: read the keyboard, controller and joystick into the character's input. */
  update() {
    if (this.mode === "watch") return;
    if (this.mode === "fly" && !this.body.player) this.setMode("fly"); // (after a respawn)
    let x = this.stick.x, y = this.stick.y;
    const k = this.keys;
    if (k.has("w") || k.has("arrowup")) y += 1;
    if (k.has("s") || k.has("arrowdown")) y -= 1;
    if (k.has("d") || k.has("arrowright")) x += 1;
    if (k.has("a") || k.has("arrowleft")) x -= 1;
    // a game controller: left stick / D-pad, A to jump, X / B / right trigger to act
    for (const gp of this.pads ? navigator.getGamepads() : []) {
      if (!gp) continue;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.18) { x += ax; y -= ay; }
      const b = (i) => !!gp.buttons[i]?.pressed;
      if (b(12)) y += 1; if (b(13)) y -= 1; if (b(15)) x += 1; if (b(14)) x -= 1;
      const prev = this.prevPad[gp.index] || {};
      const A = b(0), Bt = b(2) || b(1) || b(7), Y = b(3);
      if (A && !prev.A) this.press("a");
      if (Bt !== !!prev.B) this.press("b", Bt);
      if (Y && !prev.Y) this.cycleView();
      this.prevPad[gp.index] = { A, B: Bt, Y };
    }
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    if (this.mode === "fly" && this.body.player) {
      this.body.player.fwd = y;
      this.body.player.turn = x;
    } else if (this.frogInput) {
      // camera-relative: up on the stick is away from the camera, along the ground
      const f = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).setZ(0);
      if (f.lengthSq() < 1e-8) f.set(0, 1, 0);
      f.normalize();
      this.frogInput.mx = f.x * y + f.y * x;
      this.frogInput.my = f.y * y - f.x * x;
    }
    this._labels();
  }
}
