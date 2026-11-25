import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

// Two frogs from web/assets/frogs-original.glb, the most detailed version of the models:
// the full meshes with their eyes and textures, each skinned by its author to a Rigify rig
// (96 deform bones: spine, pelvis, belly, chest, shoulders, both pairs of legs down to each
// toe). Rigify's deform bones follow control bones through Blender constraints, which a GLB
// doesn't carry, so the frogs are re-rigged here when they load: each deform bone is
// re-parented to its anatomical parent (legs to the hips, arms to the chest, toes to the
// feet) without moving it, which keeps the author's skin weights exactly. The eyes are
// attached to the head. Everything the frogs do is then posed on that skeleton: breathing,
// croaking, hops and big jumps with the hind legs pushing off and trailing and the forelegs
// reaching to land, and a tongue that shoots out to the fly.
const FROG_DEFINITIONS = [
  {
    id: "small",
    name: "Montane Brown Frog",
    rootName: "rig",
    meshName: "Montane Brown Frog (F).lower",
    length: 42,            // mm, snout to vent
    hopBodyLengths: 1.4,   // a frog: long, quick hops
    hopTime: [0.12, 0.3, 0.26], // gather, flight, settle (s)
    sight: 170,            // mm at which it notices the fly
    // Its model is posed mid-stride with the hind legs stretched out; a sitting frog folds
    // them in a Z beside its body: thigh forward, shin back, foot forward again.
    sit: {
      // tucked in close along the flanks, not splayed
      hind: [[0.62, 0.5, -0.3], [-0.95, 0.12, -0.28], [0.97, 0.15, -0.08], [0.92, 0.35, -0.08]],
      fore: [[0.2, 0.2, -0.96], [0.25, 0.04, -0.97], [0.75, 0.15, -0.64], [0.8, 0.45, -0.3]], // propping up the chest
    },
    sitPitch: -0.06,       // and sits a little nose-up (the model's spine is already arched)
    start: [-176, 128],
    heading: -0.6,
  },
  {
    id: "big",
    name: "Japanese Toad",
    rootName: "rig.Big.Frog",
    meshName: "Japanese Toad (M).lower",
    length: 70,
    hopBodyLengths: 0.55,  // a toad: short, low, slower hops
    hopTime: [0.2, 0.26, 0.4],
    hopHeight: 0.6,        // relative to a frog's arc
    sight: 200,
    start: [176, -128],
    heading: 2.5,
  },
];

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const normalizeNodeName = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// three.js drops dots and other reserved characters from node names when it loads a GLB
// ("DEF-spine.001" -> "DEF-spine001"); look names up the same way.
const N = (name) => THREE.PropertyBinding.sanitizeNodeName(name);

// Limb chains: each segment is aimed from its own head toward the next bone's head.
// The last bone is the middle toe's second joint: the toes are aimed as one more segment.
const HIND = ["thigh", "shin", "foot", "r_toe", "r_middle.002"];
const FORE = ["upper_arm", "forearm", "hand", "f_toe", "f_middle.002"];
const SPINE = ["DEF-spine", "DEF-spine.001", "DEF-spine.002", "DEF-spine.003", "DEF-spine.004", "DEF-spine.005", "DEF-spine.006"];

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();

export class FrogPredators {
  constructor(scene, url, onCatch = () => {}, arenaRadius = 100) {
    this.scene = scene;
    this.url = url;
    this.onCatch = onCatch;
    this.arenaRadius = arenaRadius;
    this.loader = new GLTFLoader();
    this.frogs = [];
    this.mode = "both";
    this.ready = false;
    this.catchLock = 0;
  }

  async load() {
    let gltf;
    try {
      gltf = await this.loader.loadAsync(this.url);
    } catch (error) {
      throw new Error("Could not fetch or parse " + this.url + ": " + (error?.message || String(error)));
    }
    gltf.scene.updateMatrixWorld(true);
    const errors = [];
    for (const def of FROG_DEFINITIONS) {
      try {
        this.frogs.push(this._build(gltf, def));
      } catch (error) {
        errors.push(def.name + ": " + (error?.message || String(error)));
        console.warn("Could not prepare frog model " + def.name, error);
      }
    }
    if (!this.frogs.length) throw new Error("The GLB opened, but neither frog could be prepared. " + errors.join(" | "));
    if (errors.length) console.warn("Some frog models were skipped:", errors.join(" | "));
    this.ready = true;
    this.setMode(this.mode);
    return this.frogs.length;
  }

  // ---------- re-rigging ----------

  _build(gltf, def) {
    const source = gltf.scene.getObjectByName(N(def.rootName)) || gltf.scene.getObjectByName(def.rootName);
    if (!source) throw new Error("No rig '" + def.rootName + "' in the GLB");
    const rig = cloneSkinned(source);
    let mesh = null;
    const eyes = [];
    rig.traverse((o) => {
      if (o.isSkinnedMesh && normalizeNodeName(o.name) === normalizeNodeName(def.meshName)) mesh = o;
      else if (o.isMesh && /^eye/i.test(o.name)) eyes.push(o);
    });
    if (!mesh) throw new Error("No skinned mesh '" + def.meshName + "' under '" + def.rootName + "'");

    // glTF is Y-up; the arena is Z-up.
    const model = new THREE.Group();
    model.rotation.x = Math.PI / 2;
    model.add(rig);
    const orient = new THREE.Group();
    orient.add(model);
    const actor = new THREE.Group();
    actor.name = "predator-" + def.id;
    actor.rotation.order = "ZYX"; // heading, then pitch about the frog's own side axis
    actor.add(orient);
    actor.updateMatrixWorld(true);

    // Clean skeleton: every deform bone under its anatomical parent, kept where it is.
    const bones = new Map();
    // (the second rig's bone names carry a "_1" suffix: three.js keeps node names unique)
    const base = (name) => name.replace(/_\d+$/, "");
    rig.traverse((o) => { if (o.isBone) bones.set(base(o.name), o); });
    const def_ = (n) => bones.get(N(n));
    const logicalParent = (bone) => {
      for (let p = bone.parent; p; p = p.parent) {
        const m = /^ORG-spine(\d*)$/.exec(base(p.name));
        if (m && bones.get("DEF-spine" + m[1])) return bones.get("DEF-spine" + m[1]);
        if (p.name.startsWith("DEF-")) return p;
        if (p === rig) break;
      }
      return def_("root") || rig;
    };
    const deform = [...bones.entries()].filter(([n]) => n.startsWith("DEF-")).map(([, b]) => b);
    const depth = (b) => { let d = 0; for (let p = b; p; p = p.parent) d++; return d; };
    for (const b of deform.sort((a, c) => depth(a) - depth(c))) {
      const parent = logicalParent(b);
      if (parent !== b.parent) parent.attach(b);
    }
    // The eyes follow the head.
    const head = def_("DEF-spine.006") || def_("DEF-spine.005");
    for (const e of eyes) head.attach(e);

    // Face +X: the snout is ahead of the hips.
    actor.updateMatrixWorld(true);
    const hips = def_("DEF-spine").getWorldPosition(new THREE.Vector3());
    const snout = head.getWorldPosition(new THREE.Vector3());
    orient.rotation.z = -Math.atan2(snout.y - hips.y, snout.x - hips.x);
    actor.updateMatrixWorld(true);

    // Scale to its snout-vent length and set it on the ground (from the skinned rest pose).
    const box = this._skinnedBounds(mesh, actor);
    const scale = def.length / Math.max(1e-6, box.max.x - box.min.x);
    model.scale.setScalar(scale);
    actor.updateMatrixWorld(true);
    const b2 = this._skinnedBounds(mesh, actor);
    orient.position.set(-(b2.min.x + b2.max.x) / 2, -(b2.min.y + b2.max.y) / 2, -b2.min.z);
    actor.updateMatrixWorld(true);

    rig.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false; // posed limbs reach outside the bind-pose bounds
      }
    });

    // Chains of deform bones, and their rest pose.
    const side = (s) => ({
      hind: HIND.map((n) => def_(`DEF-${n}.${s}`)),
      fore: FORE.map((n) => def_(`DEF-${n}.${s}`)),
      sign: Math.sign(def_(`DEF-thigh.${s}`).getWorldPosition(_v1).y) || (s === "L" ? 1 : -1),
    });
    const limbs = { L: side("L"), R: side("R") };
    const rest = new Map(deform.map((b) => [b, { q: b.quaternion.clone(), s: b.scale.clone(), p: b.position.clone() }]));
    // "Down" for the throat, in the chest bone's parent space: the throat puffs out downward.
    const chest = def_("DEF-Breast.C");
    let throatDown = null;
    if (chest) {
      const at = chest.getWorldPosition(new THREE.Vector3());
      const below = at.clone().add(new THREE.Vector3(0, 0, -1).transformDirection(actor.matrixWorld));
      throatDown = chest.parent.worldToLocal(below).sub(chest.parent.worldToLocal(at.clone()));
    }

    // A tongue: frogs catch prey by flipping out a sticky tongue from the front of the mouth.
    const tongueMat = new THREE.MeshStandardMaterial({ color: 0xd9727a, roughness: 0.35 });
    const tongue = new THREE.Group();
    const r = def.length * 0.025;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.2, 1, 10, 1).rotateZ(-Math.PI / 2).translate(0.5, 0, 0), tongueMat);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(r * 2.2, 12, 8).scale(1, 1, 0.7), tongueMat);
    tongue.add(shaft, tip);
    tongue.visible = false;
    actor.add(tongue);

    const L = def.length;
    const frog = {
      ...def, actor, model, mesh, eyes, rest, limbs, tongue, tongueTip: tip, tongueShaft: shaft,
      spine: SPINE.map(def_).filter(Boolean), chest, throatDown, belly: def_("DEF-belly.C"),
      // the snout: the front of the body, at mouth height
      mouth: new THREE.Vector3(),
      x: def.start[0], y: def.start[1], heading: def.heading, phase: Math.random() * Math.PI * 2,
      speed: 0, catchCooldown: 0, state: "sitting", croakCooldown: 7 + Math.random() * 9,
      mode: "sit", t: 0, sitLeft: 1 + Math.random() * 3, hop: null, boutLeft: 0, hunting: 0, wander: null,
      hopLength: L * def.hopBodyLengths, reach: L * 0.75, sight: def.sight,
      // kept for the lab panel's diagnostics
      bones: new Map(deform.map((b) => [b.name, b])),
      animationActions: new Map([["re-rigged: " + deform.length + " deform bones", null]]),
    };
    // Sit it on the ground in its sitting pose.
    this._body(frog);
    this._pose(frog);
    const seated = this._skinnedBounds(mesh, actor, true);
    orient.position.z -= seated.min.z;
    // The snout: the front-most point well off the ground (the forefeet reach further).
    {
      const v = new THREE.Vector3(), inv = new THREE.Matrix4().copy(actor.matrixWorld).invert();
      const top = seated.max.z - seated.min.z, n = mesh.geometry.attributes.position.count;
      let best = -Infinity, bz = top * 0.4;
      for (let i = 0; i < n; i++) {
        mesh.getVertexPosition(i, v);
        v.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
        if (v.z > top * 0.38 && v.x > best) { best = v.x; bz = v.z; }
      }
      frog.mouth.set(best - L * 0.04, 0, bz - L * 0.03);
    }
    actor.position.set(def.start[0], def.start[1], 0);
    actor.rotation.z = def.heading;
    this.scene.add(actor);
    return frog;
  }

  /** Bounds of the skinned (posed) mesh in the actor's frame. */
  _skinnedBounds(mesh, actor, precise = false) {
    const box = new THREE.Box3(), v = new THREE.Vector3(), inv = new THREE.Matrix4().copy(actor.matrixWorld).invert();
    mesh.skeleton.update();
    const n = mesh.geometry.attributes.position.count, step = precise ? 1 : Math.max(1, Math.floor(n / 6000));
    for (let i = 0; i < n; i += step) {
      mesh.getVertexPosition(i, v);
      v.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
      box.expandByPoint(v);
    }
    return box;
  }

  setMode(mode) {
    this.mode = ["none", "small", "big", "both"].includes(mode) ? mode : "both";
    for (const frog of this.frogs) {
      frog.actor.visible = this.mode === "both" || this.mode === frog.id;
      if (!frog.actor.visible) { frog.speed = 0; frog.hunting = 0; }
    }
  }

  // ---------- posing ----------

  /**
   * Turn a chain segment (bone -> next bone's head) toward a direction given in the frog's
   * own frame (+X forward, +Y to its left, +Z up), by `w` (0 = rest, 1 = all the way).
   */
  _aim(frog, bone, next, dir, w) {
    if (!bone || !next || w <= 0) return;
    const from = next.getWorldPosition(_v1).sub(bone.getWorldPosition(_v2)).normalize();
    const to = _v3.copy(dir).normalize().transformDirection(frog.actor.matrixWorld);
    _q1.setFromUnitVectors(from, to);
    if (w < 1) _q1.copy(_q4.copy(IDENTITY).slerp(_q1, w));
    // world rotation -> bone-local: P^-1 * q * P * local
    bone.parent.getWorldQuaternion(_q2);
    _q3.copy(_q2).invert().multiply(_q1).multiply(_q2);
    bone.quaternion.premultiply(_q3);
    bone.updateMatrixWorld(true);
  }

  /** Aim a whole limb: dirs[i] for segment i (mirrored to the frog's right for R). */
  _limb(frog, chain, sign, dirs, w) {
    if (w <= 0) return;
    for (let i = 0; i < chain.length - 1 && i < dirs.length; i++) {
      const d = dirs[i];
      this._aim(frog, chain[i], chain[i + 1], _dir.set(d[0], d[1] * sign, d[2]), w);
    }
  }

  /** Pose the skeleton for this frame from the frog's mode and timers. */
  _pose(frog) {
    for (const [b, r] of frog.rest) { b.quaternion.copy(r.q); b.scale.copy(r.s); b.position.copy(r.p); }
    frog.actor.updateMatrixWorld(true);
    const t = frog.t;
    if (frog.sit) {
      for (const s of ["L", "R"]) {
        const { hind, fore, sign } = frog.limbs[s];
        if (frog.sit.hind) this._limb(frog, hind, sign, frog.sit.hind, 1);
        if (frog.sit.fore) this._limb(frog, fore, sign, frog.sit.fore, 1);
      }
    }
    let push = 0, trail = 0, tuck = 0, reach = 0, gather = 0;
    if ((frog.mode === "hop" || frog.mode === "jump") && frog.hop) {
      const h = frog.hop;
      const big = frog.mode === "jump" ? 1 : Math.min(1, h.dist / (frog.length * 0.8));
      if (t < h.start) gather = ease(t / h.start);
      else if (t <= h.end) {
        const u = (t - h.start) / (h.end - h.start);
        push = (1 - ease(u / 0.45)) * big;             // legs straighten as it leaves the ground
        trail = ease(u / 0.3) * (1 - ease((u - 0.55) / 0.45)) * big; // then trail behind
        tuck = ease(u / 0.25) * (1 - ease((u - 0.35) / 0.3)) * big;  // forelegs back along the body
        reach = ease((u - 0.4) / 0.45) * big;           // then forward to land on
      } else {
        const k = 1 - ease((t - h.end) / Math.max(0.05, h.dur - h.end));
        reach = k * big; // the forelegs take the landing, the hind legs fold back under
        gather = 0.4 * k;
      }
    }
    for (const s of ["L", "R"]) {
      const { hind, fore, sign } = frog.limbs[s];
      // Hind legs: straight back-and-down at push-off, trailing straight back in flight.
      this._limb(frog, hind, sign, [[-0.78, 0.2, -0.6], [-0.8, 0.16, -0.58], [-0.82, 0.12, -0.56], [-0.75, 0.12, -0.65]], push);
      this._limb(frog, hind, sign, [[-0.95, 0.24, -0.18], [-0.97, 0.18, -0.15], [-0.98, 0.1, -0.12], [-0.98, 0.15, -0.1]], trail * (1 - push));
      // Forelegs: pressed back in flight, then reaching forward and down for the landing.
      this._limb(frog, fore, sign, [[-0.7, 0.45, -0.55], [-0.75, 0.3, -0.6], [-0.6, 0.2, -0.75]], tuck);
      this._limb(frog, fore, sign, [[0.55, 0.45, -0.7], [0.5, 0.25, -0.83], [0.35, 0.2, -0.9]], reach * (1 - tuck));
      // Gathering for a jump: forelegs straighten a little, lifting the chest.
      this._limb(frog, fore, sign, [[0.15, 0.35, -0.92], [0.1, 0.2, -0.97]], gather * 0.6 * (1 - reach));
    }
    // Throat and flanks: breathing at rest, a big pulse of the throat when croaking.
    let throat = 0, flank = 0.5 + 0.5 * Math.sin(t * 2.6 + frog.phase);
    if (frog.mode === "sit") throat = 0.5 + 0.5 * Math.sin(t * 7 + frog.phase);
    if (frog.mode === "croak") throat = 2.2 * Math.max(0, Math.sin(Math.PI * (t % 0.5) / 0.5)) * (t < 1.8 ? 1 : 0);
    if (frog.chest && frog.throatDown) {
      // the throat swells down: gently with each breath, a lot with each call
      const k = (frog.mode === "croak" ? 0.07 : 0.012) * throat * frog.length;
      frog.chest.position.addScaledVector(frog.throatDown, k); // throatDown is one world mm
      frog.chest.scale.multiplyScalar(1 + (frog.mode === "croak" ? 0.06 : 0.01) * throat);
    }
    if (frog.belly) frog.belly.scale.multiplyScalar(1 + 0.012 * flank);
  }

  /** The tongue, out toward the fly during a strike. */
  _tongue(frog, fly) {
    const tg = frog.tongue;
    if (frog.mode !== "strike") { tg.visible = false; return; }
    const t = frog.t;
    const out = t < 0.07 ? ease(t / 0.07) : 1 - ease((t - 0.11) / 0.16);
    if (out <= 0.001) { tg.visible = false; return; }
    tg.visible = true;
    tg.position.copy(frog.mouth);
    // toward where the fly was when the strike started, at most the reach
    const target = frog.actor.worldToLocal(_v1.set(frog.strikeAt.x, frog.strikeAt.y, frog.strikeAt.z + 0.5));
    const dir = target.sub(frog.mouth);
    const len = Math.min(dir.length(), frog.reach * 1.1) * out;
    dir.normalize();
    tg.quaternion.setFromUnitVectors(_v2.set(1, 0, 0), dir);
    frog.tongueShaft.scale.set(Math.max(1e-3, len), 1, 1);
    frog.tongueTip.position.set(len, 0, 0);
  }

  // ---------- natural movement ----------
  // Frogs are sit-and-wait hunters. They sit still most of the time (breathing, an
  // occasional croak), turn by small pivot hops, cover ground in discrete hops with pauses
  // between them, and catch prey with the tongue when it moves within reach in front of
  // them; a big jump closes the last body length or two. The body moves forward only while
  // it is in the air: the feet stay planted at take-off and landing.

  /** Start one hop (or the big jump) from where the frog sits to (tx, ty), facing `toHeading`. */
  _startHop(frog, kind, tx, ty, toHeading) {
    const big = kind === "jump";
    const maxR = Math.max(20, this.arenaRadius - frog.length * 0.62 - 5);
    const r = Math.hypot(tx, ty);
    if (r > maxR) { tx *= maxR / r; ty *= maxR / r; }
    const dist = Math.hypot(tx - frog.x, ty - frog.y);
    const [g, a, s] = frog.hopTime;
    const k = 0.9 + Math.random() * 0.2;
    // longer leaps take a little longer in the air
    const air = a * k * (big ? 1.6 : 1) * (0.7 + 0.3 * Math.min(1.6, dist / Math.max(1, frog.hopLength)));
    const gather = g * k * (big ? 1.8 : 1), settle = s * k * (big ? 1.3 : 1);
    frog.mode = kind;
    frog.t = 0;
    frog.hop = { x0: frog.x, y0: frog.y, x1: tx, y1: ty, h0: frog.heading, h1: toHeading, dist,
      start: gather, end: gather + air, dur: gather + air + settle };
  }

  _sit(frog, seconds) {
    frog.mode = "sit";
    frog.t = 0;
    frog.sitLeft = seconds;
  }

  /** What to do next, after sitting for a while. */
  _decide(frog, fly, flyMoving) {
    const dx = fly.x - frog.x, dy = fly.y - frog.y;
    const dist = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);
    const err = wrapAngle(bearing - frog.heading);
    const L = frog.length;
    const mouth = frog.mouth.x, reach = frog.reach;
    const noticed = frog.catchCooldown <= 0 && dist < frog.sight && (flyMoving || dist < frog.sight * 0.6 || frog.hunting > 0);
    if (noticed) frog.hunting = 12; // keeps hunting for a while after losing sight of movement
    if (frog.hunting > 0 && fly.z < 12) {
      // Turn to face it first: a short pivot hop, turning up to ~70 degrees.
      if (Math.abs(err) > 0.4) {
        const turn = clamp(err, -1.2, 1.2);
        const h = frog.heading + turn;
        const step = L * 0.12;
        return this._startHop(frog, "hop", frog.x + Math.cos(h) * step, frog.y + Math.sin(h) * step, h);
      }
      const gap = dist - mouth; // from the mouth to the fly
      if (gap < reach) return this._sit(frog, 0.4 + Math.random() * 0.6); // in reach: wait for it to move
      if (gap < reach + L * 2.2 && Math.random() < 0.6) {
        // A big jump that lands with the fly just inside tongue reach.
        const d = gap - reach * 0.5;
        return this._startHop(frog, "jump", frog.x + Math.cos(bearing) * d, frog.y + Math.sin(bearing) * d, bearing);
      }
      // Approach in short bouts of hops; closer in, shorter and more careful.
      const d = Math.min(frog.hopLength * (gap < L * 3 ? 0.6 : 1), gap - reach * 0.6);
      const h = bearing + (Math.random() - 0.5) * 0.25;
      frog.boutLeft = frog.boutLeft > 0 ? frog.boutLeft - 1 : 1 + Math.floor(Math.random() * 3);
      return this._startHop(frog, "hop", frog.x + Math.cos(h) * d, frog.y + Math.sin(h) * d, h);
    }
    // Nothing to hunt: mostly sit; sometimes croak or move to a new spot.
    const roll = Math.random();
    if (roll < 0.15 && frog.croakCooldown <= 0) {
      frog.croakCooldown = 15 + Math.random() * 20;
      frog.mode = "croak";
      frog.t = 0;
      return;
    }
    if (roll < 0.45) {
      if (!frog.wander || Math.hypot(frog.wander[0] - frog.x, frog.wander[1] - frog.y) < frog.hopLength) {
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * (this.arenaRadius - frog.length * 1.5);
        frog.wander = [rr * Math.cos(a), rr * Math.sin(a)];
      }
      const wb = Math.atan2(frog.wander[1] - frog.y, frog.wander[0] - frog.x);
      const we = wrapAngle(wb - frog.heading);
      const h = frog.heading + clamp(we, -1.0, 1.0) + (Math.random() - 0.5) * 0.3;
      const d = Math.abs(we) > 0.7 ? frog.hopLength * 0.25 : frog.hopLength * (0.6 + Math.random() * 0.4);
      frog.boutLeft = 1 + Math.floor(Math.random() * 3);
      return this._startHop(frog, "hop", frog.x + Math.cos(h) * d, frog.y + Math.sin(h) * d, h);
    }
    this._sit(frog, 2.5 + Math.random() * 6);
  }

  _strike(frog, fly) {
    frog.mode = "strike";
    frog.t = 0;
    frog.caught = false;
    frog.catchCooldown = 1.8;
    frog.ate = false;
    frog.strikeAt = { x: fly.x, y: fly.y, z: fly.z || 0 };
    this.catchLock = 0.8;
  }

  update(dt, fly) {
    if (!this.ready || !fly || dt <= 0) return;
    dt = Math.min(dt, 0.12);
    this.catchLock = Math.max(0, this.catchLock - dt);
    // Frogs see moving prey: is the fly moving?
    const pf = this.prevFly;
    const flySpeed = pf ? Math.hypot(fly.x - pf.x, fly.y - pf.y, (fly.z || 0) - (pf.z || 0)) / dt : 0;
    this.prevFly = { x: fly.x, y: fly.y, z: fly.z };
    const flyMoving = flySpeed > 1.5;
    for (const frog of this.frogs) {
      if (!frog.actor.visible) continue;
      frog.catchCooldown = Math.max(0, frog.catchCooldown - dt);
      frog.croakCooldown = Math.max(0, frog.croakCooldown - dt);
      frog.hunting = Math.max(0, frog.hunting - dt);
      frog.t += dt;
      const mouthX = frog.x + Math.cos(frog.heading) * frog.mouth.x;
      const mouthY = frog.y + Math.sin(frog.heading) * frog.mouth.x;
      const gap = Math.hypot(fly.x - mouthX, fly.y - mouthY);
      const err = Math.abs(wrapAngle(Math.atan2(fly.y - frog.y, fly.x - frog.x) - frog.heading));
      const inReach = fly.z < 12 && gap < frog.reach && err < 0.6;

      if (frog.mode === "hop" || frog.mode === "jump") {
        const h = frog.hop, t = frog.t;
        // Ballistic: constant horizontal speed while airborne, none on the ground.
        const p = clamp((t - h.start) / (h.end - h.start), 0, 1);
        frog.x = h.x0 + (h.x1 - h.x0) * p;
        frog.y = h.y0 + (h.y1 - h.y0) * p;
        // The body turns during the push-off and the first part of the flight.
        const turnP = clamp(t / (h.start + (h.end - h.start) * 0.5), 0, 1);
        frog.heading = h.h0 + wrapAngle(h.h1 - h.h0) * ease(turnP);
        if (t >= h.dur) {
          frog.heading = wrapAngle(h.h1);
          // Right after landing a hunting frog strikes if the fly is in reach.
          if (inReach && frog.catchCooldown <= 0 && this.catchLock <= 0) this._strike(frog, fly);
          else if (frog.boutLeft > 0 && frog.mode === "hop") this._sit(frog, 0.15 + Math.random() * 0.45);
          else this._sit(frog, frog.hunting > 0 ? 0.5 + Math.random() * 1.2 : 2 + Math.random() * 5);
        }
      } else if (frog.mode === "croak") {
        if (frog.t >= 2) this._sit(frog, 3 + Math.random() * 5);
      } else if (frog.mode === "strike") {
        // The tongue reaches the fly at ~0.07 s; it's caught then if it's still there.
        if (!frog.caught && frog.t >= 0.07) {
          frog.caught = true;
          // Not every strike lands (about a third miss, as in real frogs).
          frog.ate = gap < frog.reach * 1.15 && fly.z < 12 && Math.random() < 0.65;
          if (frog.ate) this.onCatch({ id: frog.id, name: frog.name, x: frog.x, y: frog.y });
        }
        if (frog.t >= 0.42) {
          if (frog.ate) {
            // Swallowing (the eyes retract to push prey down), then a while before hunting again.
            frog.hunting = 0;
            frog.catchCooldown = 20 + Math.random() * 20;
            this._sit(frog, 12 + Math.random() * 15);
          } else this._sit(frog, 0.6 + Math.random() * 1.2);
        }
      } else {
        // Sitting. Strike at a fly that moves within reach in front (or one that has sat
        // there a while), otherwise decide what to do when the pause is over.
        frog.sitLeft -= dt;
        frog.waitedInReach = inReach ? (frog.waitedInReach || 0) + dt : 0;
        if (inReach && frog.catchCooldown <= 0 && this.catchLock <= 0 && (flyMoving || frog.waitedInReach > 4)) this._strike(frog, fly);
        else if (frog.sitLeft <= 0) this._decide(frog, fly, flyMoving);
        else if (flyMoving && frog.catchCooldown <= 0 && Math.hypot(fly.x - frog.x, fly.y - frog.y) < frog.sight * 0.5 && frog.hunting <= 0) {
          frog.hunting = 12; // a fly moving nearby gets its attention: react sooner
          frog.sitLeft = Math.min(frog.sitLeft, 0.3 + Math.random() * 0.5);
        }
      }
      frog.state = frog.mode === "sit" ? (frog.hunting > 0 ? "watching" : "sitting") : frog.mode;
      this._body(frog);
      this._pose(frog);
      this._tongue(frog, fly);
    }
  }

  /**
   * Whole-body motion: position, heading, and the body's arc and pitch: a crouch with the
   * nose lifting before take-off, a ballistic arc pitched nose-up then nose-down, a
   * settle on landing, and a forward dip of the head as the tongue goes out.
   */
  _body(frog) {
    let z = 0, pitch = frog.sitPitch || 0;
    const L = frog.length;
    if ((frog.mode === "hop" || frog.mode === "jump") && frog.hop) {
      const h = frog.hop, t = frog.t;
      const height = clamp(h.dist * (frog.mode === "jump" ? 0.3 : 0.36), L * 0.06, L * 0.7) * (frog.hopHeight || 1);
      const base = frog.sitPitch || 0;
      if (t < h.start) {
        pitch = base + (frog.sitPitch ? 0.08 : -0.14) * ease(t / h.start); // a sitting frog levels out to aim
      } else if (t <= h.end) {
        const u = (t - h.start) / (h.end - h.start);
        z = height * 4 * u * (1 - u);
        // level out in flight: nose up leaving, nose down arriving
        const arc = -0.28 * Math.cos(Math.PI * u) * Math.min(1, h.dist / (L * 0.6)) * (frog.hopHeight || 1);
        pitch = base * (1 - Math.sin(Math.PI * u)) + arc;
      } else {
        const k = 1 - ease((t - h.end) / Math.max(0.05, h.dur - h.end));
        pitch = base * (1 - k) + 0.1 * k;
      }
    } else if (frog.mode === "strike") {
      pitch += 0.12 * Math.sin(Math.PI * clamp(frog.t / 0.3, 0, 1));
    }
    frog.actor.position.set(frog.x, frog.y, z);
    frog.actor.rotation.set(0, pitch, frog.heading);
  }

  dispose() {
    for (const frog of this.frogs) {
      this.scene.remove(frog.actor);
      frog.actor.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose();
          const materials = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of materials) m?.dispose();
        }
      });
    }
    this.frogs = [];
    this.ready = false;
  }
}

const _dir = new THREE.Vector3();
