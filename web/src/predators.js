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
      // folded flat beside the body, so it rests low on its belly and haunches
      hind: [[0.7, 0.55, -0.35], [-0.97, 0.05, -0.2], [0.98, 0.12, -0.08], [0.9, 0.38, -0.08]],
      fore: [[0.2, 0.2, -0.96], [0.25, 0.04, -0.97], [0.75, 0.15, -0.64], [0.8, 0.45, -0.3]], // propping up the chest
    },
    sitPitch: -0.06,       // and sits a little nose-up (the model's spine is already arched)
    gape: 0.48,            // rad: how wide the mouth opens to strike
    swims: true,           // a frog: at home in the pond, swims and hunts there
    aquatic: true,         // and lives in it: always in the water, swimming about, stalking the fly from it
    start: [-60, 45],      // (in the pond)
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
    gape: 0.42,
    swims: true,
    landlubber: true,      // a toad: doesn't go in the water on purpose; if it ends up in it, it swims out
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

  /**
   * `this.url` may be a list: each file is tried in turn until one gives both frogs (the PC
   * app tries the full-resolution originals, if they have been put on the computer, before
   * the copy that ships with it).
   */
  async load() {
    const urls = [].concat(this.url);
    let lastError = null;
    for (const url of urls) {
      try {
        await this._loadFrom(url);
        if (this.frogs.length === FROG_DEFINITIONS.length || url === urls[urls.length - 1]) { this.loadedFrom = url; break; }
        throw new Error("only " + this.frogs.length + " of the frogs could be prepared");
      } catch (error) {
        lastError = error;
        if (url !== urls[urls.length - 1]) console.info("Frogs: not using " + decodeURIComponent(url.split("/").pop()) + " (" + (error?.message || error) + "); trying the next file");
        for (const f of this.frogs) this.scene.remove(f.actor);
        this.frogs = [];
      }
    }
    if (!this.frogs.length) throw lastError || new Error("no frog models");
    this.ready = true;
    this.setMode(this.mode);
    return this.frogs.length;
  }

  async _loadFrom(url) {
    let gltf;
    try {
      gltf = await this.loader.loadAsync(url);
    } catch (error) {
      throw new Error("Could not fetch or parse " + url + ": " + (error?.message || String(error)));
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
    // (another export of the models may name the skin differently: then the most detailed one)
    if (!mesh) rig.traverse((o) => { if (o.isSkinnedMesh && (!mesh || o.geometry.attributes.position.count > mesh.geometry.attributes.position.count)) mesh = o; });
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
    // Frogs swallow with their eyes: they pull them down into the head to push prey down.

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

    // A tongue: frogs catch prey by flipping out a sticky tongue that is rooted at the front
    // of the lower jaw: it lies folded back in the mouth and flips forward, over, onto the prey.
    // A broad, flat, wet pad, wider toward its tip; its shape is rebuilt every frame (_tongue).
    const tongueMat = new THREE.MeshPhysicalMaterial({ color: 0xd8707c, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.15, side: THREE.DoubleSide });
    const tongue = new THREE.Mesh(tongueGeometry(), tongueMat);
    tongue.castShadow = true;
    tongue.frustumCulled = false;
    tongue.visible = false;
    const tip = new THREE.Object3D(); // where the sticky pad is: a caught fly sits here
    tongue.add(tip);
    actor.add(tongue);

    const L = def.length;
    const frog = {
      ...def, actor, model, mesh, eyes, rest, limbs, tongue, tongueTip: tip, jaw: null, jawOpen: 0,
      eyeRest: eyes.map((e) => e.position.clone()), eyeDown: null, holding: false, gulp: 0,
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
    // "Down" for each eye in the head's space (one world mm).
    frog.eyeDown = eyes.map((e) => {
      const at = e.getWorldPosition(new THREE.Vector3());
      const below = at.clone().add(new THREE.Vector3(0, 0, -1).transformDirection(actor.matrixWorld));
      return e.parent.worldToLocal(below).sub(e.parent.worldToLocal(at.clone()));
    });
    // Sit it on the ground in its sitting pose.
    this._body(frog);
    this._pose(frog);
    const seated = this._skinnedBounds(mesh, actor, true);
    orient.position.z -= seated.min.z;
    // The snout: the front-most point well off the ground (the forefeet reach further),
    // measured with the frog sat on the ground (after the lift above).
    actor.updateMatrixWorld(true);
    mesh.skeleton.update();
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
      frog.snout = new THREE.Vector2(best, bz);
    }
    try { this._buildJaw(frog, head); } catch (e) { console.warn("No jaw for " + def.name + ":", e); }
    try { this._findSoles(frog); } catch (e) { console.warn("Feet not planted for " + def.name + ":", e); }
    actor.position.set(def.start[0], def.start[1], 0);
    actor.rotation.z = def.heading;
    this.scene.add(actor);
    return frog;
  }

  /**
   * A lower jaw. The models have none (the mouth is shut in the skin), so one is made: a jaw
   * bone hinged on the head behind the eyes, and the skin of the lower lip, chin and the
   * front of the throat moved onto it (the share of each vertex the head carried). Opening
   * it parts the skin along the lip line, where the triangles that join upper and lower lip
   * are hidden while it is open, and shows a mouth: palate, floor and inner cheeks.
   */
  _buildJaw(frog, head) {
    const { mesh, actor } = frog, L = frog.length;
    actor.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(actor.matrixWorld).invert();
    const geo = (mesh.geometry = mesh.geometry.clone());
    const pos = geo.attributes.position, n = pos.count;
    // The skin as it sits, in the frog's frame (+X forward, +Z up).
    const P = new Float32Array(n * 3), v = new THREE.Vector3();
    mesh.skeleton.update();
    for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv); v.toArray(P, i * 3); }
    // The lip line: from just under the snout tip back to the angle of the jaw, below and
    // behind the eye (under the eardrum).
    const eye = new THREE.Vector3(), eyeR = L * 0.055;
    if (frog.eyes.length) {
      for (const e of frog.eyes) eye.add(e.getWorldPosition(v).applyMatrix4(inv));
      eye.multiplyScalar(1 / frog.eyes.length);
    } else eye.set(frog.snout.x - L * 0.2, 0, frog.snout.y);
    // (the corner of the mouth: under the eye, a little behind its middle)
    const xs = frog.snout.x, zs = frog.snout.y - L * 0.02;
    const xh = eye.x - eyeR * 0.8, zh = eye.z - eyeR * 1.5;
    const lipZ = (x) => zh + (zs - zh) * clamp((x - xh) / (xs - xh), 0, 1.2);
    // The head's bones (whichever trunk bones the author weighted the snout to): their share
    // of each vertex below the lip line goes to the jaw.
    const bones = mesh.skeleton.bones, si0 = geo.attributes.skinIndex, sw0 = geo.attributes.skinWeight;
    const tally = new Map();
    for (let i = 0; i < n; i++) {
      if (P[i * 3] < xh || Math.abs(P[i * 3 + 2] - lipZ(P[i * 3])) > L * 0.1) continue;
      for (let k = 0; k < 4; k++) {
        const b = si0.getComponent(i, k), w = sw0.getComponent(i, k);
        if (w > 0 && /spine|breast|belly|head|neck|jaw/i.test(bones[b].name)) tally.set(b, (tally.get(b) || 0) + w);
      }
    }
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    // (the chin and throat skin carry the chest's and neck's weights too: all trunk bones)
    const headSet = new Set(bones.map((b, i) => (/spine|breast|belly|head|neck/i.test(b.name) ? i : -1)).filter((i) => i >= 0));
    const mainHead = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (mainHead) head = bones[mainHead[0]]; // the jaw hangs from the bone the head moves with
    const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const share = new Float32Array(n), below = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], z = P[i * 3 + 2], d = lipZ(x) - z;
      if (d <= 0 || x < xh - L * 0.04) continue;
      below[i] = 1;
      share[i] = sm(xh - L * 0.04, xh + L * 0.1, x) * (1 - sm(L * 0.2, L * 0.34, d));
    }
    // Skin weights: move the head's share onto the jaw (a 5th bone index, maybe > 255).
    const jawIndex = bones.length;
    let si = geo.attributes.skinIndex;
    if (jawIndex > 255 && !(si.array instanceof Uint16Array || si.array instanceof Uint32Array)) {
      si = new THREE.BufferAttribute(new Uint16Array(si.array), 4);
      geo.setAttribute("skinIndex", si);
    }
    const sw = geo.attributes.skinWeight;
    // The lower lip and chin go with the jaw entirely (whatever bones the author weighted them
    // to: shoulders and arms as well as the trunk), fading back into the throat.
    for (let i = 0; i < n; i++) {
      const m = share[i];
      if (m <= 0) continue;
      let free = -1, least = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0 && free < 0) free = k;
        if (w < sw.getComponent(i, least)) least = k;
      }
      for (let k = 0; k < 4; k++) sw.setComponent(i, k, sw.getComponent(i, k) * (1 - m));
      const k = free >= 0 ? free : least;
      const given = free >= 0 ? 0 : sw.getComponent(i, k); // the smallest influence gives way to the jaw
      si.setComponent(i, k, jawIndex);
      sw.setComponent(i, k, m + given);
    }
    si.needsUpdate = sw.needsUpdate = true;
    // The jaw bone: on the head, at the hinge, turned about the frog's side-to-side axis.
    const jaw = new THREE.Bone();
    jaw.name = "jaw";
    head.add(jaw);
    jaw.position.copy(head.worldToLocal(actor.localToWorld(new THREE.Vector3(xh, 0, zh))));
    jaw.updateMatrixWorld(true);
    const sk = mesh.skeleton, hi = bones.indexOf(head);
    const jawInverse = jaw.matrix.clone().invert().multiply(sk.boneInverses[hi]); // closed: moves exactly as the head
    mesh.bind(new THREE.Skeleton([...bones, jaw], [...sk.boneInverses, jawInverse]), mesh.bindMatrix);
    const headQ = head.getWorldQuaternion(new THREE.Quaternion()).invert();
    const axis = new THREE.Vector3(0, 1, 0).transformDirection(actor.matrixWorld).applyQuaternion(headQ).normalize();
    // While open, the triangles across the lip line are hidden (made empty, keeping the order).
    const closed = geo.index;
    const open = closed.clone();
    for (let t = 0; t < open.count; t += 3) {
      const a = open.getX(t), b = open.getX(t + 1), c = open.getX(t + 2);
      const jawSide = (i) => below[i] && share[i] > 0.5;
      // (only along the lips: further down the throat the skin stretches instead of parting)
      const nearLip = [a, b, c].every((i) => Math.abs(P[i * 3 + 2] - lipZ(P[i * 3])) < L * 0.035);
      const lips = nearLip && [a, b, c].some(jawSide) && [a, b, c].some((i) => !jawSide(i)) && Math.min(P[a * 3], P[b * 3], P[c * 3]) > xh + L * 0.02;
      if (lips) { open.setX(t + 1, a); open.setX(t + 2, a); }
    }
    // The inside of the mouth, in the head's space; its lower half follows the jaw (_pose).
    const st = 9, ring = [];
    for (let k = 0; k <= st; k++) {
      const x = xh + (xs - xh) * (k / st) * 0.97, zl = lipZ(x);
      let w = 0;
      for (let i = 0; i < n; i++) {
        // the lower jaw's width (narrower than the cheeks above it): the mouth fits inside it
        if (Math.abs(P[i * 3] - x) < L * 0.025 && P[i * 3 + 2] < zl && P[i * 3 + 2] > zl - L * 0.035) w = Math.max(w, Math.abs(P[i * 3 + 1]));
      }
      ring.push([x, w * 0.8 * (1 - 0.6 * (k / st) ** 4), zl]);
    }
    const loop = [...ring.map(([x, w, z]) => [x, w, z]), ...ring.slice().reverse().map(([x, w, z]) => [x, -w, z])];
    const toHead = (x, y, z) => head.worldToLocal(actor.localToWorld(new THREE.Vector3(x, y, z)));
    // A hollow pocket, not a box: the palate a dome rising into the head and the floor a bowl
    // sinking into the jaw, each a stack of rings from the lips in to the midline; walls only
    // at the corners and the back (the throat), so from the side you look into the mouth.
    const NU = 5, nl = loop.length, front = loop.map(([x]) => clamp((x - xh) / (xs - xh), 0, 1));
    const shell = (sign, depth) => {
      const pts = [];
      for (let u = 0; u < NU; u++) {
        const t = u / (NU - 1), lift = Math.sin((t * Math.PI) / 2);
        for (let i = 0; i < nl; i++) {
          const [x, y, z] = loop[i], d = depth * (1 - 0.55 * front[i] ** 2);
          pts.push(toHead(x, y * (1 - t), z + sign * d * lift));
        }
      }
      return pts;
    };
    const upper = shell(1, L * 0.065), lower = shell(-1, L * 0.055);
    const NP = upper.length, mp = new Float32Array(NP * 2 * 3), col = new Float32Array(NP * 2 * 3), idx = [];
    for (let u = 0; u + 1 < NU; u++) for (let i = 0; i < nl; i++) {
      const j = (i + 1) % nl, a0 = u * nl + i, b0 = u * nl + j, a1 = a0 + nl, b1 = b0 + nl;
      idx.push(a0, b0, a1, b0, b1, a1);                          // palate
      idx.push(NP + a0, NP + a1, NP + b0, NP + b0, NP + a1, NP + b1); // floor
    }
    // the corners and the back: palate rim to floor rim, in shadow
    for (let i = 0; i < nl; i++) {
      const j = (i + 1) % nl;
      if (Math.max(front[i], front[j]) < 0.22) idx.push(i, j, NP + i, j, NP + j, NP + i);
    }
    // pink at the lips, darker inside and toward the throat
    const shade = (base, back, fore) => {
      for (let u = 0; u < NU; u++) for (let i = 0; i < nl; i++) {
        const f = front[i], dark = 1 - 0.55 * (u / (NU - 1)) - (f < 0.22 ? 0.35 * (1 - f / 0.22) : 0);
        col.set(back.map((c, k) => (c + (fore[k] - c) * f) * Math.max(0.15, dark)), (base + u * nl + i) * 3);
      }
    };
    shade(0, [0.2, 0.06, 0.07], [0.62, 0.3, 0.32]);
    shade(NP, [0.24, 0.07, 0.08], [0.74, 0.4, 0.42]);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(mp, 3));
    mg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    mg.setIndex(idx);
    const mouthMesh = new THREE.Mesh(mg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, side: THREE.DoubleSide }));
    mouthMesh.frustumCulled = false;
    mouthMesh.visible = false;
    head.add(mouthMesh);
    const hinge = jaw.position.clone();
    frog.jaw = { bone: jaw, axis, closed, open, mouthMesh, upper, lower, hinge, max: frog.gape || 0.6, lip: { xs, zs, xh, zh },
      root: jaw.worldToLocal(actor.localToWorld(new THREE.Vector3(xs - L * 0.07, 0, lipZ(xs - L * 0.07) - L * 0.015))) };
  }

  /**
   * The soles of its four feet: for each foot (the foot or hand bone and its toes), the skin
   * vertices lowest in the sitting pose. Each frame a standing frog puts each foot's sole
   * down on the ground under it (_plant).
   */
  _findSoles(frog) {
    const { mesh } = frog, bones = mesh.skeleton.bones, g = mesh.geometry;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = si.count, v = new THREE.Vector3();
    frog.actor.updateMatrixWorld(true);
    // each vertex's main bone
    const main = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let best = -1, bw = 0;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      main[i] = best;
    }
    frog.feet = [];
    for (const s of ["L", "R"]) for (const limb of ["hind", "fore"]) {
      const chain = frog.limbs[s][limb];
      if (!chain[0] || !chain[1] || !chain[2]) continue;
      const set = new Set();
      chain[2].traverse((b) => { if (b.isBone) set.add(bones.indexOf(b)); });
      const ids = [];
      for (let i = 0; i < n; i++) if (set.has(main[i])) { mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld); ids.push([v.z, i]); }
      ids.sort((a, b) => a[0] - b[0]);
      if (ids.length) frog.feet.push({ chain, ids: ids.slice(0, 40).map((x) => x[1]) });
    }
  }

  /** Turn a bone by a rotation given in world space, about its own head. */
  _turnWorld(bone, q) {
    bone.parent.getWorldQuaternion(_pq);
    _pq2.copy(_pq).invert().multiply(q).multiply(_pq);
    bone.quaternion.premultiply(_pq2);
    bone.updateMatrixWorld(true);
  }

  /** Two-bone IK: bend at B and swing at A so that C's head reaches T (all world). */
  _ik2(A, B, C, T) {
    const a = A.getWorldPosition(_pa), b = B.getWorldPosition(_pb), c = C.getWorldPosition(_pc);
    const lab = a.distanceTo(b), lbc = b.distanceTo(c);
    if (lab < 1e-6 || lbc < 1e-6) return;
    const d = clamp(a.distanceTo(T), Math.abs(lab - lbc) + 1e-4, lab + lbc - 1e-4);
    const ba = _pd.copy(a).sub(b), bc = _pe.copy(c).sub(b);
    const cur = ba.angleTo(bc), want = Math.acos(clamp((lab * lab + lbc * lbc - d * d) / (2 * lab * lbc), -1, 1));
    const axis = _pf.crossVectors(bc, ba);
    if (axis.lengthSq() > 1e-12) this._turnWorld(B, _pq3.setFromAxisAngle(axis.normalize(), cur - want));
    const c2 = C.getWorldPosition(_pc).sub(a).normalize(), to = _pd.copy(T).sub(a).normalize();
    this._turnWorld(A, _pq3.setFromUnitVectors(c2, to));
  }

  /**
   * A standing frog's four feet flat on the ground: each foot is moved, by bending its leg at
   * the knee or elbow and swinging it at the hip or shoulder, until the lowest point of its
   * sole is on the ground under it (a slope, a stone's edge, a bank), keeping its own angle.
   */
  _plant(frog) {
    if (!frog.feet || !this.groundAt) return;
    const h = frog.hop, t = frog.t;
    const standing = frog.mode === "sit" || frog.mode === "croak" || (frog.mode === "strike" && !frog.lastSwam) ||
      ((frog.mode === "hop" || frog.mode === "jump") && h && (t < h.start || t > h.end));
    if (!standing || this.isWater?.(frog.x, frog.y)) return;
    const mesh = frog.mesh, L = frog.length;
    // how high a foot's sole is above the ground under it
    const sole = (ft) => {
      let low = Infinity, lx = 0, ly = 0;
      for (const i of ft.ids) {
        mesh.getVertexPosition(i, _pa).applyMatrix4(mesh.matrixWorld);
        if (_pa.z < low) { low = _pa.z; lx = _pa.x; ly = _pa.y; }
      }
      return low - this.groundAt(lx, ly);
    };
    const reachDown = () => {
      for (const ft of frog.feet) {
        const dz = clamp(-sole(ft), -L * 0.25, L * 0.25);
        if (Math.abs(dz) < 0.01) continue;
        const C = ft.chain[2];
        C.getWorldQuaternion(_pqFoot);
        const target = C.getWorldPosition(_pg).add(_ph.set(0, 0, dz));
        this._ik2(ft.chain[0], ft.chain[1], C, target);
        // the foot keeps its own angle (flat, as posed), however the leg above it turned
        C.parent.getWorldQuaternion(_pq);
        C.quaternion.copy(_pq.invert().multiply(_pqFoot));
        C.updateMatrixWorld(true);
      }
    };
    frog.actor.updateMatrixWorld(true);
    reachDown();
    // A foot its leg can't reach down far enough to (a straight foreleg): the body comes down
    // until it can, and the other legs fold a little more.
    const hover = Math.max(...frog.feet.map(sole));
    if (hover > 0.03) {
      frog.actor.position.z -= Math.min(hover, L * 0.15);
      frog.actor.updateMatrixWorld(true);
      reachDown();
    }
  }

  /** Open the jaw by `k` (0 shut, 1 the full gape). */
  _openJaw(frog, k) {
    const J = frog.jaw;
    if (!J) return;
    const a = k * J.max;
    J.bone.quaternion.setFromAxisAngle(J.axis, a);
    const isOpen = k > 0.02;
    if (frog.mesh.geometry.index !== (isOpen ? J.open : J.closed)) frog.mesh.geometry.setIndex(isOpen ? J.open : J.closed);
    J.mouthMesh.visible = isOpen;
    if (!isOpen) return;
    // the palate stays with the head; the floor turns with the jaw about its hinge
    const p = J.mouthMesh.geometry.attributes.position, np = J.upper.length;
    _q1.setFromAxisAngle(J.axis, a);
    for (let i = 0; i < np; i++) {
      p.setXYZ(i, J.upper[i].x, J.upper[i].y, J.upper[i].z);
      _v1.copy(J.lower[i]).sub(J.hinge).applyQuaternion(_q1).add(J.hinge);
      p.setXYZ(np + i, _v1.x, _v1.y, _v1.z);
    }
    p.needsUpdate = true;
    J.mouthMesh.geometry.computeVertexNormals();
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
    // Swimming: hind legs kick back and trail, forelegs lie back along the body; floating,
    // all four hang spread out.
    const inWater = frog.mode === "swim" || (frog.mode === "strike" && frog.lastSwam);
    if (inWater) {
      const k = frog.mode === "swim" ? frog.kick || 0 : 0, fl = frog.floatW ?? 1;
      for (const s of ["L", "R"]) {
        const { hind, fore, sign } = frog.limbs[s];
        this._limb(frog, hind, sign, [[-0.5, 0.75, -0.42], [-0.72, 0.5, -0.48], [-0.62, 0.45, -0.64], [-0.5, 0.55, -0.66]], fl * (1 - k));
        this._limb(frog, hind, sign, [[-0.93, 0.3, -0.18], [-0.97, 0.18, -0.12], [-0.98, 0.12, -0.12], [-0.96, 0.18, -0.16]], k);
        this._limb(frog, fore, sign, [[-0.75, 0.5, -0.4], [-0.85, 0.35, -0.38], [-0.7, 0.3, -0.62]], (1 - fl) * 0.9);
        this._limb(frog, fore, sign, [[0.3, 0.78, -0.55], [0.45, 0.6, -0.65], [0.35, 0.6, -0.72]], fl * 0.8);
      }
    }
    // Standing: all four feet flat on the ground.
    this._plant(frog);
    // The mouth: open to strike; shut otherwise.
    frog.jawOpen = frog.mode === "strike" ? this._strikeTimes(frog).jaw : 0;
    this._openJaw(frog, frog.jawOpen);
    // Swallowing: the eyes sink into the head twice.
    frog.eyes.forEach((e, i) => {
      e.position.copy(frog.eyeRest[i]);
      if (frog.gulp > 0 && frog.eyeDown) {
        const g = Math.max(0, Math.sin(Math.PI * 2 * (1.4 - frog.gulp) / 0.7)) * frog.length * 0.035;
        e.position.addScaledVector(frog.eyeDown[i], g);
      }
    });
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

  /**
   * The strike, as filmed (slowed down here so it reads): the mouth gapes, the tongue flips
   * out over the lower jaw, tip first, onto the prey; back in, with the prey stuck to it,
   * and only then does the mouth shut (a swallow follows, the eyes pressing down).
   *   0-0.05 s jaw opens · 0.03-0.11 s tongue flips out (fully out: 0.11 s, the catch) ·
   *   from 0.13 s (0.15 s holding prey) back in · the jaw shuts once it is in.
   */
  _strikeTimes(frog) {
    const t = frog.t, back = frog.holding ? [0.15, 0.32] : [0.13, 0.15];
    let out, flip;
    if (t < 0.11) { out = ease((t - 0.03) / 0.08); flip = ease((t - 0.03) / 0.06); }
    else { out = 1 - ease((t - back[0]) / back[1]); flip = Math.min(1, out * 1.8); }
    const shut = back[0] + back[1];
    const jaw = t < 0.05 ? ease(t / 0.05) : t < shut ? 1 : 1 - ease((t - shut) / 0.09);
    return { out, flip, jaw };
  }

  /** The tongue, out toward the fly during a strike. */
  _tongue(frog) {
    const tg = frog.tongue;
    if (frog.mode !== "strike") { tg.visible = false; frog.tongueOut = 0; return; }
    const { out, flip } = this._strikeTimes(frog);
    frog.tongueOut = out;
    if (out <= 0.001 || !frog.strikeAt) { tg.visible = false; return; }
    tg.visible = true;
    // Its root, on the floor of the mouth at the front of the jaw (or under the snout).
    const root = frog.jaw ? frog.actor.worldToLocal(frog.jaw.bone.localToWorld(_v4.copy(frog.jaw.root))) : _v4.copy(frog.mouth);
    // toward where it aimed (where the fly was as it struck), at most the reach
    const aim = frog.actor.worldToLocal(_v1.set(frog.strikeAt.x, frog.strikeAt.y, frog.strikeAt.z)).sub(root);
    const len = Math.max(frog.length * 0.06, Math.min(aim.length(), frog.reach * 1.1) * out);
    aim.normalize();
    // Flipping over: folded back (pointing into the mouth) to pointing at the prey, rolling
    // forward over the top: a turn about the axis across its path.
    const axis = _v2.crossVectors(aim, _up).normalize();
    if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0);
    const phi = (1 - flip) * Math.PI * 0.95;
    const dirTip = _v3.copy(aim).applyAxisAngle(axis, phi);
    const tip = _t0.copy(root).addScaledVector(dirTip, len);
    const ctrl = _t1.copy(root).addScaledVector(_t2.copy(aim).applyAxisAngle(axis, phi * 0.55), len * 0.55).addScaledVector(_up, len * 0.12 * Math.sin(phi));
    buildTongue(tg.geometry, root, ctrl, tip, frog.length, Math.min(1, 0.45 + out));
    frog.tongueTip.position.copy(tip);
  }

  /** Where a fly stuck to a tongue is (world), or null. */
  heldFly() {
    for (const frog of this.frogs) {
      if (frog.holding && frog.tongue.visible) {
        frog.tongue.updateMatrixWorld(true);
        return frog.tongueTip.getWorldPosition(new THREE.Vector3());
      }
    }
    return null;
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
    // Everything is solid: a stone (or anything else in the ground's height map) in the way is
    // jumped onto if it is within the leap, otherwise the hop stops short at its foot; and it
    // never lands with its head in a stone's side.
    const gnd = (x, y) => (this.groundAt ? this.groundAt(x, y) : 0);
    const L = frog.length, g0 = gnd(frog.x, frog.y), leap = L * (big ? 0.9 : 0.6);
    {
      const dx = tx - frog.x, dy = ty - frog.y, len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const ux = dx / len, uy = dy / len, N = Math.max(4, Math.ceil(len / (L * 0.12)));
        let stop = len;
        for (let i = 1; i <= N; i++) {
          const d = (i / N) * len;
          if (gnd(frog.x + ux * d, frog.y + uy * d) > g0 + leap) { stop = Math.max(0, d - L * 0.45); break; } // too high: stop before it
        }
        // a stone's side just ahead of where it lands: land a little short (or on top)
        for (let k = 0; k < 8 && stop > 0; k++) {
          const gl = gnd(frog.x + ux * stop, frog.y + uy * stop), gf = gnd(frog.x + ux * (stop + L * 0.4), frog.y + uy * (stop + L * 0.4));
          if (gf - gl <= L * 0.15) break;
          stop = Math.max(0, stop - L * 0.12);
        }
        tx = frog.x + ux * stop; ty = frog.y + uy * stop;
      }
    }
    const dist = Math.hypot(tx - frog.x, ty - frog.y);
    const [g, a, s] = frog.hopTime;
    const k = 0.9 + Math.random() * 0.2;
    // longer leaps take a little longer in the air
    const air = a * k * (big ? 1.6 : 1) * (0.7 + 0.3 * Math.min(1.6, dist / Math.max(1, frog.hopLength)));
    const gather = g * k * (big ? 1.8 : 1), settle = s * k * (big ? 1.3 : 1);
    frog.mode = kind;
    frog.t = 0;
    // The arc must clear whatever is under the path (a stone it hops over or onto).
    const g1 = gnd(tx, ty);
    let clear = 0;
    for (let i = 1; i < 12; i++) {
      const u = i / 12, under = gnd(frog.x + (tx - frog.x) * u, frog.y + (ty - frog.y) * u) - (g0 + (g1 - g0) * u);
      if (under > 0) clear = Math.max(clear, (under + L * 0.04) / (4 * u * (1 - u)));
    }
    frog.hop = { x0: frog.x, y0: frog.y, x1: tx, y1: ty, h0: frog.heading, h1: toHeading, dist, g0, g1, clear,
      start: gather, end: gather + air, dur: gather + air + settle };
  }

  _sit(frog, seconds) {
    frog.mode = "sit";
    frog.t = 0;
    frog.sitLeft = seconds;
    // In the pond a frog doesn't sit: it floats, and swims from there.
    if (frog.swims && this.isWater?.(frog.x, frog.y)) {
      frog.mode = "swim";
      frog.swimGoal = null;
      frog.vel = frog.vel || 0;
    }
  }

  /** A random spot in the arena: in the pond (`water` true) or out of it. */
  _spot(water, near = null, within = Infinity) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = near ? Math.sqrt(Math.random()) * Math.min(within, this.arenaRadius) : Math.sqrt(Math.random()) * (this.arenaRadius - 30);
      const x = (near ? near.x : 0) + rr * Math.cos(a), y = (near ? near.y : 0) + rr * Math.sin(a);
      if (Math.hypot(x, y) > this.arenaRadius - 30) continue;
      if (!!this.isWater?.(x, y) === water) return [x, y];
    }
    return null;
  }

  /** What to do next, after sitting for a while. */
  _decide(frog, fly, flyMoving) {
    // The frog lives in the pond: out of it, it heads straight back (the pond is in the middle).
    if (frog.aquatic && this.isWater && !this.isWater(frog.x, frog.y)) {
      const d = Math.hypot(frog.x, frog.y), b = Math.atan2(-frog.y, -frog.x), step = Math.min(frog.hopLength, Math.max(frog.length * 0.6, d));
      return this._startHop(frog, "hop", frog.x + Math.cos(b) * step, frog.y + Math.sin(b) * step, b);
    }
    const dx = fly.x - frog.x, dy = fly.y - frog.y;
    const dist = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);
    const err = wrapAngle(bearing - frog.heading);
    const L = frog.length;
    const mouth = frog.mouth.x, reach = frog.reach;
    const noticed = frog.catchCooldown <= 0 && dist < frog.sight && (flyMoving || dist < frog.sight * 0.6 || frog.hunting > 0);
    if (noticed) frog.hunting = 12; // keeps hunting for a while after losing sight of movement
    // a toad watches a fly out on the water, but doesn't go in after it
    const outOfBounds = frog.landlubber && this.isWater?.(fly.x, fly.y);
    if (outOfBounds && frog.hunting > 0) return this._sit(frog, 1 + Math.random() * 2);
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
        // a frog heads for the pond now and then; a toad keeps to dry ground
        frog.wander = (!frog.landlubber && Math.random() < 0.4 && this._spot(true)) || this._spot(false) || [0, 0];
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

  // ---------- in the pond ----------
  // A frog swims with its hind legs: both kick back together (a frog kick), it glides with
  // them trailing straight behind, draws them up again and kicks again; the forelegs lie
  // back along its sides. At rest it floats at the surface, eyes and back out, legs hanging
  // spread. It hunts from the water: flies on the surface or the bank in front of it.

  _swim(frog, fly, dt, flyMoving, inReach) {
    const L = frog.length;
    frog.swimT = (frog.swimT ?? 9) + dt;
    frog.sitLeft -= dt;
    if (!this.isWater?.(frog.x, frog.y)) { frog.vel = 0; frog.mode = "sit"; frog.sitLeft = 0.5; return; } // drifted ashore
    // Run aground: the bank under it lifts it out of the water (see _body), or it keeps
    // kicking into the bank. It climbs out onto the nearest dry ground instead.
    if (frog.aquatic && (frog.beached || (frog.blockedT || 0) > 1.2)) {
      // it stays in: turns back toward open water
      frog.beached = false; frog.blockedT = 0; frog.vel = 0;
      const b = Math.atan2(-frog.y, -frog.x);
      frog.heading = wrapAngle(b + (Math.random() - 0.5) * 0.8);
      frog.swimGoal = null;
      frog.swimT = 0; // a kick away from the bank
    }
    if (frog.beached || (frog.blockedT || 0) > 1.2) {
      const out = this._shore(frog);
      frog.blockedT = 0;
      frog.beached = false;
      if (out) {
        const b = Math.atan2(out[1] - frog.y, out[0] - frog.x), d = Math.min(frog.hopLength, Math.max(L * 0.6, Math.hypot(out[0] - frog.x, out[1] - frog.y)));
        frog.vel = 0;
        frog.swimGoal = null;
        this.onRipple?.(frog.x, frog.y, L / 18);
        return this._startHop(frog, "hop", frog.x + Math.cos(b) * d, frog.y + Math.sin(b) * d, b);
      }
    }
    const dx = fly.x - frog.x, dy = fly.y - frog.y, dist = Math.hypot(dx, dy);
    if (!fly.gone && frog.catchCooldown <= 0 && fly.z < 12 && dist < frog.sight && (flyMoving || dist < frog.sight * 0.6)) frog.hunting = 12;
    // In reach: strike (from a glide too).
    frog.waitedInReach = inReach ? (frog.waitedInReach || 0) + dt : 0;
    if (inReach && frog.catchCooldown <= 0 && this.catchLock <= 0 && (flyMoving || frog.waitedInReach > 1.5)) { frog.vel = 0; return this._strike(frog, fly); }
    // Where to: the fly when hunting, else a goal of its own (or none: floating).
    let goal = frog.swimGoal;
    if (frog.hunting > 0 && !fly.gone && fly.z < 12 && !(frog.landlubber && this.isWater(fly.x, fly.y))) goal = { x: fly.x, y: fly.y, prey: true };
    else if (frog.swimGoal?.prey) goal = frog.swimGoal = null;
    // A toad in the water wants out: it swims for the nearest bank, straight away.
    if (frog.landlubber && !goal?.prey && !goal?.land) {
      const out = this._shore(frog);
      if (out) goal = frog.swimGoal = { x: out[0], y: out[1], land: true };
    }
    if (!goal && frog.sitLeft <= 0) {
      const roll = Math.random();
      // (the frog keeps to the pond: it swims about, now and then floating still)
      const there = frog.aquatic ? (roll < 0.75 ? this._spot(true, frog, 160) : null)
        : roll < 0.45 ? this._spot(true, frog, 160) : roll < 0.75 ? this._spot(false, frog, 220) : null;
      if (there) goal = frog.swimGoal = { x: there[0], y: there[1], land: !this.isWater(there[0], there[1]) };
      else frog.sitLeft = 3 + Math.random() * 6;
    }
    if (goal) {
      const bearing = Math.atan2(goal.y - frog.y, goal.x - frog.x), err = wrapAngle(bearing - frog.heading);
      const gd = Math.hypot(goal.x - frog.x, goal.y - frog.y) - (goal.prey ? frog.mouth.x : 0);
      // close enough: prey within reach (wait for the strike), or there
      if (goal.prey ? gd < frog.reach * 0.75 : gd < L * 0.5) {
        if (!goal.prey) { frog.swimGoal = null; frog.sitLeft = 2 + Math.random() * 5; }
        else frog.heading = wrapAngle(frog.heading + clamp(err, -1, 1) * 2 * dt); // paddling round to face it
      } else {
        // steer: briskly during a kick, slowly in the glide
        const kicking = frog.swimT < 0.2;
        frog.heading = wrapAngle(frog.heading + clamp(err, -1, 1) * (kicking ? 6 : 1.6) * dt);
        // out onto the bank: the shore is just ahead, the goal beyond it
        const ax = frog.x + Math.cos(frog.heading) * L * 0.8, ay = frog.y + Math.sin(frog.heading) * L * 0.8;
        let waiting = false;
        if (frog.aquatic && !this.isWater(ax, ay)) {
          // the bank ahead: it stays in the water, at the edge, facing the fly, waiting
          // (it strikes from there once the fly is in reach)
          waiting = true;
          frog.vel = 0;
          frog.swimT = Math.max(frog.swimT, 0.2);
          if (!goal.prey) frog.swimGoal = null;
        } else if ((goal.land || goal.prey) && !this.isWater(ax, ay) && Math.abs(err) < 0.6) {
          const d = goal.prey ? Math.min(frog.hopLength, gd - frog.reach * 0.6) : Math.min(frog.hopLength, gd);
          frog.vel = 0;
          frog.swimGoal = null;
          this.onRipple?.(frog.x, frog.y, L / 18);
          return this._startHop(frog, "hop", frog.x + Math.cos(bearing) * Math.max(L * 0.6, d), frog.y + Math.sin(bearing) * Math.max(L * 0.6, d), bearing);
        }
        // the next kick, once drawn up again (and roughly facing the way)
        // stalking: closing on a fly that sits still, it creeps in with slow, gentle kicks
        frog.stalk = !!goal.prey && !flyMoving && gd < L * 5;
        if (!waiting && frog.swimT > (frog.stalk ? 1.5 : goal.prey && gd < L * 2 ? 0.55 : 0.75) && Math.abs(err) < 1.1) {
          frog.swimT = 0;
          this.onRipple?.(frog.x - Math.cos(frog.heading) * L * 0.7, frog.y - Math.sin(frog.heading) * L * 0.7, L / 20);
        }
      }
    }
    // the kick drives it forward; the water slows it in the glide
    if (frog.swimT < 0.16) frog.vel += (L * 2.4 / 0.16) * dt * (frog.stalk ? 0.4 : 1);
    frog.vel *= Math.exp(-2.6 * dt);
    if (frog.vel < 0.02 * L) frog.vel = 0;
    const nx = frog.x + Math.cos(frog.heading) * frog.vel * dt, ny = frog.y + Math.sin(frog.heading) * frog.vel * dt;
    if (this.isWater(nx, ny) && Math.hypot(nx, ny) < this.arenaRadius - 20) { frog.x = nx; frog.y = ny; frog.blockedT = 0; }
    else { if (frog.vel > 0) frog.blockedT = (frog.blockedT || 0) + dt; frog.vel = 0; }
    // legs: extended through the kick and the glide, then drawn up; floating when still
    frog.kick = frog.swimT < 0.13 ? ease(frog.swimT / 0.13) : frog.swimT < 0.42 ? 1 : 1 - ease((frog.swimT - 0.42) / 0.3);
    const still = frog.vel < L * 0.25 && frog.swimT > 0.75;
    frog.floatW = clamp((frog.floatW || 0) + (still ? 1.5 : -4) * dt, 0, 1);
  }

  /** The nearest dry ground from a frog in the water: a spot a little way up the bank. */
  _shore(frog) {
    let best = null;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      for (let d = 4; d < 320 && (!best || d < best.d); d += 4) {
        const x = frog.x + c * d, y = frog.y + s * d;
        if (Math.hypot(x, y) > this.arenaRadius - 30) break;
        if (!this.isWater(x, y)) { best = { d, x: frog.x + c * (d + frog.length * 0.8), y: frog.y + s * (d + frog.length * 0.8) }; break; }
      }
    }
    return best && [best.x, best.y];
  }

  _strike(frog, fly) {
    frog.lastSwam = frog.mode === "swim";
    frog.mode = "strike";
    frog.t = 0;
    frog.caught = false;
    frog.catchCooldown = 1.8;
    frog.ate = false;
    frog.holding = false;
    // Aimed at the fly's body, with a frog's aiming error of a millimetre or so.
    const a = Math.random() * Math.PI * 2, e = Math.random() * 1.6;
    frog.strikeAt = { x: fly.x + e * Math.cos(a), y: fly.y + e * Math.sin(a), z: (fly.z || 0) + 0.8 };
    this.catchLock = 0.8;
  }

  update(dt, fly) {
    if (!this.ready || !fly || dt <= 0) return;
    dt = Math.min(dt, 0.12);
    if (fly.gone) { fly = { x: 1e6, y: 1e6, z: 1e3, gone: true }; this.prevFly = null; } // eaten: nothing to hunt
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
      frog.gulp = Math.max(0, frog.gulp - dt);
      frog.t += dt;
      const mouthX = frog.x + Math.cos(frog.heading) * frog.mouth.x;
      const mouthY = frog.y + Math.sin(frog.heading) * frog.mouth.x;
      const gap = Math.hypot(fly.x - mouthX, fly.y - mouthY);
      const err = Math.abs(wrapAngle(Math.atan2(fly.y - frog.y, fly.x - frog.x) - frog.heading));
      const inReach = fly.z < 12 && gap < frog.reach && err < 0.6;

      // a swimmer "sitting" in the water (where it started, say) floats and swims instead
      if (frog.mode === "sit" && frog.swims && this.isWater?.(frog.x, frog.y)) this._sit(frog, Math.max(0.5, frog.sitLeft));
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
      } else if (frog.mode === "swim") {
        this._swim(frog, fly, dt, flyMoving, inReach);
      } else if (frog.mode === "croak") {
        if (frog.t >= 2) this._sit(frog, 3 + Math.random() * 5);
      } else if (frog.mode === "strike") {
        // The tongue is fully out at 0.11 s: if its sticky tip touches the fly, the fly sticks
        // to it and is reeled in. If the fly moved, or the aim was off, it misses.
        if (!frog.caught && frog.t >= 0.11 && !fly.gone) {
          frog.caught = true;
          // where the fully extended tip is: toward the aim point, at most the reach
          const mouth = _v2.set(frog.x + Math.cos(frog.heading) * frog.mouth.x, frog.y + Math.sin(frog.heading) * frog.mouth.x,
            frog.mouth.z + (this.groundAt ? this.groundAt(frog.x, frog.y) : 0));
          const aim = _v1.set(frog.strikeAt.x, frog.strikeAt.y, frog.strikeAt.z).sub(mouth);
          const tip = mouth.add(aim.setLength(Math.min(aim.length(), frog.reach * 1.1)));
          const touch = Math.hypot(tip.x - fly.x, tip.y - fly.y, tip.z - ((fly.z || 0) + 0.8));
          frog.ate = touch < frog.length * 0.025 * 2.2 + 1.3; // tip radius + the fly's body
          if (frog.ate) {
            frog.holding = true;
            this.onCatch({ id: frog.id, name: frog.name, x: frog.x, y: frog.y });
          }
        }
        if (frog.holding && frog.t > 0.2 && frog.tongueOut <= 0.02) {
          frog.holding = false; // in the mouth: swallow
          frog.gulp = 1.4;
        }
        if (frog.t >= (frog.ate ? 0.6 : 0.42)) {
          if (frog.ate) {
            // Swallowing, then a while before it hunts again.
            frog.holding = false;
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
      frog.state = frog.mode === "sit" ? (frog.hunting > 0 ? "watching" : "sitting") : frog.mode === "swim" ? (frog.vel > frog.length * 0.3 ? "swimming" : "floating") : frog.mode;
      frog.lastMode = frog.mode;
      this._body(frog);
      this._pose(frog);
      this._tongue(frog);
    }
  }

  /**
   * Whole-body motion: position, heading, and the body's arc and pitch: a crouch with the
   * nose lifting before take-off, a ballistic arc pitched nose-up then nose-down, a
   * settle on landing, and a forward dip of the head as the tongue goes out.
   */
  _body(frog) {
    let z = 0, pitch = frog.sitPitch || 0;
    let ground = this.groundAt ? this.groundAt(frog.x, frog.y) : 0;
    const L = frog.length;
    if ((frog.mode === "hop" || frog.mode === "jump") && frog.hop) {
      const h = frog.hop, t = frog.t;
      const height = Math.max(clamp(h.dist * (frog.mode === "jump" ? 0.3 : 0.36), L * 0.06, L * 0.7) * (frog.hopHeight || 1), h.clear || 0);
      const base = frog.sitPitch || 0;
      // the ground under it: where it took off, then where it lands (a stone, say)
      ground = h.g0 + ((h.g1 ?? 0) - (h.g0 ?? 0)) * clamp((t - h.start) / (h.end - h.start), 0, 1) || 0;
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
    }
    let lunge = 0;
    if (frog.mode === "strike") {
      // the head dips and the body lunges a little toward the prey as the tongue goes out
      const k = Math.sin(Math.PI * clamp(frog.t / 0.32, 0, 1));
      pitch += 0.12 * k;
      lunge = L * 0.07 * k;
    }
    // It stands on the ground under it, its feet on the surface: the height under its middle
    // (a stone it hopped onto, the turf, a bank), and on a slope it tilts to lie along it.
    // A stone or a bank merely beside or behind it doesn't lift it (only the ground right
    // under it counts, and a tilt only follows a real slope, not the edge of a step).
    const ch = Math.cos(frog.heading), sh = Math.sin(frog.heading);
    const inWater = !!this.isWater?.(frog.x, frog.y);
    frog.beached = false;
    if (inWater) {
      // Afloat in the pond it rides low, eyes and back out of the water, level and bobbing;
      // a frog that sits in the shallows or a toad at the edge, less so. Where the water is
      // too shallow for that it stands on the bed, and a swimmer there is aground (_swim).
      const surface = ground;
      const sunk = frog.mode === "swim" || (frog.mode === "strike" && frog.lastSwam) ? 0.3 : 0.17;
      ground -= L * sunk * (1 - clamp(z / (L * 0.3), 0, 1));
      if (frog.mode === "swim") {
        pitch = -0.03 + 0.05 * (frog.kick || 0);
        ground += Math.sin(frog.phase + performance.now() * 0.002) * L * 0.006;
      }
      const bed = this.bedAt ? this.bedAt(frog.x, frog.y) : -Infinity;
      if (z <= 0 && bed > ground) {
        ground = Math.min(bed, surface);
        if (frog.mode === "swim" && bed > surface - L * 0.12) frog.beached = true;
      }
    } else if (z <= 0 && this.groundAt) {
      const span = L * 0.55, gF = this.groundAt(frog.x + ch * span * 0.55, frog.y + sh * span * 0.55),
        gB = this.groundAt(frog.x - ch * span * 0.45, frog.y - sh * span * 0.45);
      // only the edge of a stone under its middle, its feet on the turf in front and behind
      if (ground - Math.max(gF, gB) > L * 0.12) ground = Math.max(gF, gB);
      else if (Math.abs(gF - ground) < L * 0.12 && Math.abs(gB - ground) < L * 0.12 && !this.isWater?.(frog.x + ch * span * 0.55, frog.y + sh * span * 0.55)) {
        pitch += Math.atan2(gB - gF, span); // nose up a rise, down a fall (positive pitch: nose down)
        ground = Math.max(ground, (gF + gB) / 2 - L * 0.01);
      }
    }
    // in the air it is never inside anything under it
    if (z > 0 && this.groundAt && !inWater) z = Math.max(z, this.groundAt(frog.x, frog.y) - ground);
    frog.lift = z; // how high it is off the ground (in a hop)
    frog.actor.position.set(frog.x + ch * lunge, frog.y + sh * lunge, z + ground);
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

const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 0, 1), _v4 = new THREE.Vector3();
// (foot planting)
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pd = new THREE.Vector3(), _pe = new THREE.Vector3(),
  _pf = new THREE.Vector3(), _pg = new THREE.Vector3(), _ph = new THREE.Vector3(),
  _pq = new THREE.Quaternion(), _pq2 = new THREE.Quaternion(), _pq3 = new THREE.Quaternion(), _pqFoot = new THREE.Quaternion();
const _t0 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

// The tongue: a flattened tube along a curve, TS segments long and TR round.
const TS = 18, TR = 10;
function tongueGeometry() {
  const g = new THREE.BufferGeometry(), idx = [];
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((TS + 1) * TR * 3), 3));
  for (let i = 0; i < TS; i++) for (let j = 0; j < TR; j++) {
    const a = i * TR + j, b = i * TR + ((j + 1) % TR), c = a + TR, d = b + TR;
    idx.push(a, c, b, b, c, d);
  }
  g.setIndex(idx);
  return g;
}
const _p = new THREE.Vector3(), _tan = new THREE.Vector3(), _nrm = new THREE.Vector3(), _bin = new THREE.Vector3(), _side = new THREE.Vector3(0, 1, 0);
/** Lay the tongue along the curve root -> ctrl -> tip: narrow at the root, a broad pad at the tip. */
function buildTongue(g, root, ctrl, tip, L, fat) {
  const p = g.attributes.position;
  for (let i = 0; i <= TS; i++) {
    const s = i / TS, u = 1 - s;
    _p.set(0, 0, 0).addScaledVector(root, u * u).addScaledVector(ctrl, 2 * u * s).addScaledVector(tip, s * s);
    _tan.set(0, 0, 0).addScaledVector(ctrl.clone().sub(root), 2 * u).addScaledVector(_t2.copy(tip).sub(ctrl), 2 * s).normalize();
    // flat across the frog (its width side to side), thin in the plane it flips in
    _nrm.crossVectors(_side, _tan);
    if (_nrm.lengthSq() < 1e-6) _nrm.set(0, 0, 1);
    _nrm.normalize();
    _bin.crossVectors(_tan, _nrm).normalize();
    const pad = clamp((s - 0.5) / 0.32, 0, 1);
    let w = L * (0.02 + 0.014 * s + 0.05 * pad * pad * (3 - 2 * pad)) * fat; // a slender stalk, then the sticky pad
    if (s > 0.84) w *= Math.sqrt(Math.max(0, 1 - ((s - 0.84) / 0.16) ** 2)); // its rounded end
    const th = w * 0.5;
    for (let j = 0; j < TR; j++) {
      const a = (j / TR) * Math.PI * 2;
      p.setXYZ(i * TR + j, _p.x + _bin.x * w * Math.cos(a) + _nrm.x * th * Math.sin(a), _p.y + _bin.y * w * Math.cos(a) + _nrm.y * th * Math.sin(a),
        _p.z + _bin.z * w * Math.cos(a) + _nrm.z * th * Math.sin(a));
    }
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
}
