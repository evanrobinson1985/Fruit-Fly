import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const FROG_DEFINITIONS = [
  {
    id: "small",
    name: "Montane Brown Frog",
    rootName: "rig",
    meshName: "Montane Brown Frog (F).lower",
    targetLength: 42,
    hopBodyLengths: 1.3,   // a frog: long hops
    hopTimeScale: 1,
    sight: 170,            // mm at which it notices the fly
    // Turn that points the model's head along the actor's +X (the direction it moves and
    // strikes). In the GLB this frog's head is along +Y after the Y-up -> Z-up turn.
    yaw: -Math.PI / 2,
    start: [-176, 128],
    heading: -0.6,
  },
  {
    id: "big",
    name: "Japanese Toad",
    rootName: "rig.Big.Frog",
    meshName: "Japanese Toad (M).lower",
    targetLength: 66,
    hopBodyLengths: 0.7,   // a toad: short, slower, low hops
    hopTimeScale: 0.75,
    clipLift: { Hop: 0.4, Big_Jump: 0.55 },
    sight: 200,
    yaw: Math.PI / 2,      // this one's head is along -Y in the GLB
    start: [176, -128],
    heading: 2.5,
  },
];

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normalizeNodeName = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

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
    this.axis = new THREE.Vector3(1, 0, 0);
    this.delta = new THREE.Quaternion();
  }

  async load() {
    let gltf;
    try {
      gltf = await this.loader.loadAsync(this.url);
    } catch (error) {
      throw new Error("Could not fetch or parse " + this.url + ": " + (error?.message || String(error)));
    }
    gltf.scene.updateMatrixWorld(true);
    const skinnedMeshes = [];
    gltf.scene.traverse((object) => { if (object.isSkinnedMesh) skinnedMeshes.push(object); });
    const availableMeshes = skinnedMeshes.map((mesh) => mesh.name || "(unnamed mesh)");
    const errors = [];

    for (const def of FROG_DEFINITIONS) {
      try {
        // Blender/GLB exports may replace spaces and punctuation with underscores.
        // Compare normalized names so "(F).lower" and "_(F)lower" resolve identically.
        const expectedMeshName = normalizeNodeName(def.meshName);
        const exactMesh = gltf.scene.getObjectByName(def.meshName);
        const meshSource = (exactMesh?.isSkinnedMesh ? exactMesh : null) ||
          skinnedMeshes.find((mesh) => normalizeNodeName(mesh.name) === expectedMeshName);
        if (!meshSource) {
          throw new Error("Could not find skinned mesh '" + def.meshName +
            "'. Available skinned meshes: " + (availableMeshes.join(", ") || "none"));
        }

        let source = gltf.scene.getObjectByName(def.rootName);
        if (!source) {
          source = meshSource;
          while (source.parent && source.parent !== gltf.scene) source = source.parent;
        }
        const rig = cloneSkinned(source);
        const mesh = rig.getObjectByName(meshSource.name);
        if (!mesh || !mesh.isSkinnedMesh) {
          throw new Error("Cloned rig did not contain skinned mesh '" + meshSource.name + "'.");
        }
        // The AFK export has two frog meshes bound to the same 31-joint rig.
        // Each predator gets its own cloned rig and only its own visible mesh.
        rig.traverse((object) => {
          if (object.isSkinnedMesh) object.visible = object.name === mesh.name;
        });

        const rawBounds = new THREE.Box3().setFromObject(mesh);
        const rawLength = Math.max(0.001, rawBounds.max.x - rawBounds.min.x);
        const scale = def.targetLength / rawLength;
        const model = new THREE.Group();
        model.add(rig);
        // glTF models use +Y as up; the lab world uses +Z. Rotate +90° about X.
        model.rotation.x = Math.PI / 2;
        model.scale.setScalar(scale);
        model.updateMatrixWorld(true);

        const bounds = new THREE.Box3().setFromObject(mesh);
        model.position.x -= (bounds.min.x + bounds.max.x) / 2;
        model.position.y -= (bounds.min.y + bounds.max.y) / 2;
        model.position.z -= bounds.min.z;

        const bones = new Map();
        rig.traverse((object) => {
          if (object.isMesh || object.isSkinnedMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            if (object.material) {
              const materials = Array.isArray(object.material) ? object.material : [object.material];
              for (const material of materials) {
                if ("roughness" in material) material.roughness = Math.max(0.32, material.roughness);
              }
            }
          }
          if (object.isBone) bones.set(object.name, { bone: object, rest: object.quaternion.clone(), normalized: normalizeNodeName(object.name) });
        });

        // Use the GLB's authored animation tracks instead of guessing bone roles
        // and rotating unrelated joints around one global axis.
        const mixer = new THREE.AnimationMixer(rig);
        const animationActions = new Map();
        for (const source of gltf.animations || []) {
          // The clips raise the hips a long way (the Hop by ~28 mm at the toad's size, the big
          // jump by ~60 mm). Scale that lift per frog so a toad's hop stays low.
          const clip = source.clone();
          const lift = def.clipLift?.[clip.name] ?? 1;
          if (lift !== 1) {
            for (const track of clip.tracks) {
              if (!/hips\.position$/.test(track.name)) continue;
              const v = track.values, base = [v[0], v[1], v[2]];
              for (let i = 0; i < v.length; i++) v[i] = base[i % 3] + (v[i] - base[i % 3]) * lift;
            }
          }
          const action = mixer.clipAction(clip, rig);
          action.enabled = true;
          action.setLoop(THREE.LoopRepeat, Infinity);
          animationActions.set(clip.name || ("animation-" + (animationActions.size + 1)), action);
        }
        const findAction = (pattern) => {
          for (const [name, action] of animationActions) if (pattern.test(name)) return action;
          return null;
        };
        const animationSet = {
          idle: findAction(/idle|rest|breath/i),
          walk: findAction(/hop|walk|locomotion|run|move/i),
          stalk: findAction(/stalk|crouch|sneak/i),
          lunge: findAction(/big.?jump|lunge|jump|leap|attack/i),
          catch: findAction(/catch|bite|eat|tongue/i),
          croak: findAction(/croak|call/i),
        };
        if (!animationSet.walk && animationActions.size === 1) {
          animationSet.walk = animationActions.values().next().value;
        }

        // Point the head along +X: the movement, the mouth position and the strike all use it.
        const orient = new THREE.Group();
        orient.rotation.z = def.yaw || 0;
        orient.add(model);
        // A mesh skinned only to the root bone can't use the leg clips: it hops as a whole body.
        const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
        const used = new Set();
        if (si && sw) for (let i = 0; i < si.count; i += 7) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.05) used.add(si.getComponent(i, k));
        const rigid = used.size <= 1;
        const actor = new THREE.Group();
        actor.name = "predator-" + def.id;
        actor.rotation.order = "ZYX"; // heading, then pitch about the frog's own side axis
        actor.add(orient);
        actor.position.set(def.start[0], def.start[1], 0);
        actor.rotation.z = def.heading;
        this.scene.add(actor);

        this.frogs.push({
          ...def, actor, model, bones, rigid, mixer, animationActions, animationSet,
          activeAction: null, activeAnimationState: null,
          x: def.start[0], y: def.start[1], heading: def.heading,
          phase: Math.random() * Math.PI * 2, speed: 0,
          length: def.targetLength, catchCooldown: 0, state: "waiting",
          stateTimer: 0, croakCooldown: 7 + Math.random() * 9,
          // Movement: sitting, hopping, big jumps, croaks and tongue strikes (see update()).
          mode: "sit", t: 0, sitLeft: 1 + Math.random() * 3, hop: null, boutLeft: 0, hunting: 0, wander: null,
          hopLength: def.targetLength * def.hopBodyLengths, hopTimeScale: def.hopTimeScale,
          reach: def.targetLength * 0.55, sight: def.sight,
        });
      } catch (error) {
        errors.push(def.name + ": " + (error?.message || String(error)));
        console.warn("Could not prepare frog model " + def.name, error);
      }
    }

    if (!this.frogs.length) {
      throw new Error("The GLB opened, but neither frog rig could be prepared. " + errors.join(" | "));
    }
    if (errors.length) console.warn("Some frog models were skipped:", errors.join(" | "));
    this.ready = true;
    this.setMode(this.mode);
    return this.frogs.length;
  }

  setMode(mode) {
    this.mode = ["none", "small", "big", "both"].includes(mode) ? mode : "both";
    for (const frog of this.frogs) {
      frog.actor.visible = this.mode === "both" || this.mode === frog.id;
      if (!frog.actor.visible) { frog.speed = 0; frog.hunting = 0; }
    }
  }

  _proceduralPose(frog, dt, state) {
    const bones = frog.bones;
    const t = frog.stateTimer;
    const wave = Math.sin(t * (state === "stalking" ? 3.2 : 5.5) + frog.phase);
    const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
    const rotations = {
      hips: [0, 0, 0],
      spine_1: [0, 0, 0],
      spine_2: [0, 0, 0],
      head: [0, 0, 0],
      jaw: [0, 0, 0],
      throat: [0, 0, 0],
      upperarm_l: [0, 0, 0],
      forearm_l: [0, 0, 0],
      hand_l: [0, 0, 0],
      upperarm_r: [0, 0, 0],
      forearm_r: [0, 0, 0],
      hand_r: [0, 0, 0],
      thigh_l: [0, 0, 0],
      shin_l: [0, 0, 0],
      ankle_l: [0, 0, 0],
      foot_l: [0, 0, 0],
      thigh_r: [0, 0, 0],
      shin_r: [0, 0, 0],
      ankle_r: [0, 0, 0],
      foot_r: [0, 0, 0],
    };
    const set = (name, x, y = 0, z = 0) => { if (rotations[name]) rotations[name] = [x, y, z]; };

    if (state === "idle" || state === "waiting") {
      set("spine_1", 0.018 * wave);
      set("spine_2", -0.014 * wave);
      set("head", -0.025 + 0.018 * Math.sin(t * 1.4));
      set("throat", 0.035 + 0.025 * Math.sin(t * 2.1));
      set("upperarm_l", 0.025); set("upperarm_r", 0.025);
    } else if (state === "stalking") {
      const crouch = 1;
      const stealthStep = Math.sin(t * 5.2 + frog.phase);
      set("hips", -0.10 * crouch + 0.018 * stealthStep);
      set("spine_1", 0.12 * crouch);
      set("spine_2", 0.08 * crouch);
      set("head", -0.16 + 0.025 * wave);
      set("thigh_l", -0.48 * crouch + 0.13 * stealthStep); set("thigh_r", -0.48 * crouch - 0.13 * stealthStep);
      set("shin_l", 0.72 * crouch + 0.16 * Math.max(0, stealthStep)); set("shin_r", 0.72 * crouch + 0.16 * Math.max(0, -stealthStep));
      set("ankle_l", -0.22 * crouch - 0.08 * stealthStep); set("ankle_r", -0.22 * crouch + 0.08 * stealthStep);
      set("foot_l", 0.16 * crouch + 0.05 * stealthStep); set("foot_r", 0.16 * crouch - 0.05 * stealthStep);
      set("upperarm_l", -0.18 + 0.06 * stealthStep); set("upperarm_r", -0.18 - 0.06 * stealthStep);
      set("forearm_l", 0.22 - 0.05 * stealthStep); set("forearm_r", 0.22 + 0.05 * stealthStep);
      set("head", -0.18 + 0.02 * wave);
    } else if (state === "landing") {
      const impact = 1 - ease(t / 0.34);
      set("hips", 0.18 * impact);
      set("spine_1", -0.12 * impact);
      set("spine_2", -0.08 * impact);
      set("thigh_l", 0.38 * impact); set("thigh_r", 0.38 * impact);
      set("shin_l", -0.58 * impact); set("shin_r", -0.58 * impact);
      set("ankle_l", 0.24 * impact); set("ankle_r", 0.24 * impact);
      set("upperarm_l", 0.16 * impact); set("upperarm_r", 0.16 * impact);
      set("forearm_l", -0.24 * impact); set("forearm_r", -0.24 * impact);
      set("head", 0.10 * impact);
    } else if (state === "catching") {
      const strike = ease(t / 0.075) * (1 - ease((t - 0.13) / 0.20));
      set("jaw", -0.24 * strike);
      set("head", -0.12 * strike);
      set("throat", 0.16 * strike);
      set("spine_2", 0.07 * strike);
      set("upperarm_l", -0.08); set("upperarm_r", -0.08);
    }

    // Restore the authored rest pose before applying our small, local joint offsets.
    // This prevents procedural angles accumulating or fighting the GLB animation mixer.
    for (const [name, entry] of bones) entry.bone.quaternion.copy(entry.rest);
    for (const [name, angles] of Object.entries(rotations)) {
      const entry = bones.get(name);
      if (!entry) continue;
      const offset = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(angles[0], angles[1], angles[2], "XYZ")
      );
      entry.bone.quaternion.copy(entry.rest).multiply(offset);
    }

    // The tongue is a three-segment chain. Extend its bones along their own
    // bind directions for a quick strike, then retract them without changing
    // the underlying skin weights.
    for (const name of ["tongue_1", "tongue_2", "tongue_tip"]) {
      const entry = bones.get(name);
      if (!entry) continue;
      if (!entry.positionRest) entry.positionRest = entry.bone.position.clone();
      entry.bone.position.copy(entry.positionRest);
      if (state === "catching") {
        const strike = ease(t / 0.075) * (1 - ease((t - 0.13) / 0.20));
        const direction = entry.positionRest.clone();
        const segmentLength = direction.length();
        if (segmentLength < 1e-4) direction.set(0, 1, 0);
        entry.bone.position.add(direction.normalize().multiplyScalar(Math.max(segmentLength, 0.08) * strike * 0.85));
      }
    }
  }

  // ---------- natural movement ----------
  // Frogs are sit-and-wait hunters. They sit still most of the time (breathing, an
  // occasional croak), turn by small pivot hops, cover ground in discrete hops with pauses
  // between them, and catch prey with the tongue when it moves within reach in front of
  // them; a big jump closes the last body length or two. The GLB clips are in place (the
  // hips rise and fall, nothing moves forward), so the body is carried forward only while
  // the clip has the frog in the air: the feet stay planted at take-off and landing.

  /** Start one hop (or the big jump) from where the frog sits to (tx, ty), facing `toHeading`. */
  _startHop(frog, kind, tx, ty, toHeading) {
    const big = kind === "jump";
    const action = big ? frog.animationSet.lunge : frog.animationSet.walk;
    const clip = action?.getClip();
    // Airborne part of each clip, from the hips' height track (Hop 0.67 s, Big_Jump 1.87 s).
    // A frog that hops as a whole body (no leg rig) gets its own gather, flight and settle.
    const clipDur = frog.rigid ? (big ? 1.2 : 0.62) : clip ? clip.duration : (big ? 1.87 : 0.67);
    const air = frog.rigid ? (big ? [0.3, 0.95] : [0.13, 0.47]) : big ? [0.36, 1.32] : [0.05, 0.56];
    const timeScale = big ? 1 : frog.hopTimeScale * (0.9 + Math.random() * 0.2);
    // Keep the landing inside the arena.
    const maxR = Math.max(20, this.arenaRadius - frog.length * 0.62 - 5);
    const r = Math.hypot(tx, ty);
    if (r > maxR) { tx *= maxR / r; ty *= maxR / r; }
    frog.mode = kind;
    frog.t = 0;
    frog.hop = { x0: frog.x, y0: frog.y, x1: tx, y1: ty, h0: frog.heading, h1: toHeading,
      start: air[0] / timeScale, end: air[1] / timeScale, dur: clipDur / timeScale };
    this._play(frog, action, timeScale);
  }

  _play(frog, action, timeScale = 1) {
    if (frog.rigid) action = null; // the clips don't move a root-only mesh: hops are body-level
    if (frog.activeAction && frog.activeAction !== action) frog.activeAction.stop();
    frog.activeAction = action || null;
    if (!action) return;
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.play();
  }

  _sit(frog, seconds) {
    if (frog.activeAction) { frog.activeAction.stop(); frog.activeAction = null; }
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
    const mouth = L * 0.34, reach = frog.reach;
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
      if (gap < reach + L * 2.2 && frog.animationSet.lunge && Math.random() < 0.6) {
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
    if (roll < 0.15 && frog.animationSet.croak && !frog.rigid && frog.croakCooldown <= 0) {
      frog.croakCooldown = 15 + Math.random() * 20;
      frog.mode = "croak";
      frog.t = 0;
      return this._play(frog, frog.animationSet.croak);
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

  _strike(frog) {
    frog.mode = "strike";
    frog.t = 0;
    frog.caught = false;
    frog.catchCooldown = 1.8;
    frog.ate = false;
    this.catchLock = 0.8;
    if (frog.activeAction) { frog.activeAction.stop(); frog.activeAction = null; }
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
      frog.stateTimer = frog.t;
      const L = frog.length;
      const mouthX = frog.x + Math.cos(frog.heading) * L * 0.34;
      const mouthY = frog.y + Math.sin(frog.heading) * L * 0.34;
      const gap = Math.hypot(fly.x - mouthX, fly.y - mouthY);
      const err = Math.abs(wrapAngle(Math.atan2(fly.y - frog.y, fly.x - frog.x) - frog.heading));
      const inReach = fly.z < 12 && gap < frog.reach && err < 0.6;

      if (frog.mode === "hop" || frog.mode === "jump") {
        const h = frog.hop;
        const a = frog.activeAction;
        const t = a ? a.time / Math.max(1e-6, a.getEffectiveTimeScale()) : frog.t;
        // Ballistic: constant horizontal speed while airborne, none on the ground.
        const p = clamp((t - h.start) / (h.end - h.start), 0, 1);
        frog.x = h.x0 + (h.x1 - h.x0) * p;
        frog.y = h.y0 + (h.y1 - h.y0) * p;
        // The body turns during the push-off and the first part of the flight.
        const turnP = clamp(t / (h.start + (h.end - h.start) * 0.5), 0, 1);
        frog.heading = h.h0 + wrapAngle(h.h1 - h.h0) * (turnP * turnP * (3 - 2 * turnP));
        if (frog.t >= h.dur) {
          frog.heading = wrapAngle(h.h1);
          // Right after landing a hunting frog strikes if the fly is in reach.
          if (inReach && frog.catchCooldown <= 0 && this.catchLock <= 0) this._strike(frog);
          else if (frog.boutLeft > 0 && frog.mode === "hop") this._sit(frog, 0.15 + Math.random() * 0.45);
          else this._sit(frog, frog.hunting > 0 ? 0.5 + Math.random() * 1.2 : 2 + Math.random() * 5);
        }
      } else if (frog.mode === "croak") {
        if (!frog.activeAction || frog.t >= frog.activeAction.getClip().duration) this._sit(frog, 3 + Math.random() * 5);
      } else if (frog.mode === "strike") {
        // The tongue is out at ~0.08 s; the fly is caught then if it's still there.
        if (!frog.caught && frog.t >= 0.08) {
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
        if (inReach && frog.catchCooldown <= 0 && this.catchLock <= 0 && (flyMoving || frog.waitedInReach > 4)) this._strike(frog);
        else if (frog.sitLeft <= 0) this._decide(frog, fly, flyMoving);
        else if (flyMoving && frog.catchCooldown <= 0 && Math.hypot(fly.x - frog.x, fly.y - frog.y) < frog.sight * 0.5 && frog.hunting <= 0) {
          frog.hunting = 12; // a fly moving nearby gets its attention: react sooner
          frog.sitLeft = Math.min(frog.sitLeft, 0.3 + Math.random() * 0.5);
        }
      }

      frog.mixer.update(dt);
      const pose = frog.mode === "strike" ? "catching" : frog.mode === "sit" ? "idle" : null;
      if (pose) this._proceduralPose(frog, dt, pose);
      frog.state = frog.mode === "sit" ? (frog.hunting > 0 ? "watching" : "sitting") : frog.mode;
      this._body(frog);
    }
  }

  /**
   * Whole-body motion: position and heading, plus, for a frog without a working leg rig, the
   * hop itself: a crouch before take-off, a ballistic arc pitched nose-up then nose-down,
   * a squash on landing, and a forward head dip when it strikes. (A rigged frog gets these
   * from its clips and procedural pose.)
   */
  _body(frog) {
    let z = 0, pitch = 0, squash = 1;
    if (frog.rigid) {
      const L = frog.length;
      if ((frog.mode === "hop" || frog.mode === "jump") && frog.hop) {
        const h = frog.hop, t = frog.t;
        const dist = Math.hypot(h.x1 - h.x0, h.y1 - h.y0);
        const height = clamp(dist * (frog.mode === "jump" ? 0.32 : 0.38), L * 0.08, L * 0.7);
        const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
        if (t < h.start) { // gathering: crouch, nose lifts
          const c = ease(t / h.start);
          squash = 1 - 0.14 * c; pitch = -0.12 * c;
        } else if (t <= h.end) { // in the air
          const u = (t - h.start) / (h.end - h.start);
          z = height * 4 * u * (1 - u);
          pitch = -0.38 * Math.cos(Math.PI * u) * (dist > L * 0.2 ? 1 : 0.4);
          squash = 1 + 0.08 * Math.sin(Math.PI * u); // stretched out mid-leap
        } else { // landing: absorb and settle
          const k = 1 - ease((t - h.end) / Math.max(0.05, h.dur - h.end));
          squash = 1 - 0.16 * k; pitch = 0.1 * k;
        }
      } else if (frog.mode === "strike") {
        const t = frog.t;
        const dip = Math.sin(Math.PI * clamp(t / 0.3, 0, 1));
        pitch = 0.22 * dip; squash = 1 - 0.05 * dip;
      } else if (frog.mode === "sit") {
        squash = 1 + 0.012 * Math.sin(frog.t * 4.2 + frog.phase); // throat breathing
      }
    }
    frog.actor.position.set(frog.x, frog.y, z);
    frog.actor.rotation.set(0, pitch, frog.heading);
    frog.actor.scale.set(1, 1, squash);
  }

  dispose() {
    for (const frog of this.frogs) {
      this.scene.remove(frog.actor);
      frog.mixer?.stopAllAction();
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
