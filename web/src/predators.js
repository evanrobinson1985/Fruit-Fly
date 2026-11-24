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
    start: [-176, 128],
    heading: -0.6,
  },
  {
    id: "big",
    name: "Japanese Toad",
    rootName: "rig.Big.Frog",
    meshName: "Japanese Toad (M).lower",
    targetLength: 66,
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
        for (const clip of gltf.animations || []) {
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
        };
        if (!animationSet.walk && animationActions.size === 1) {
          animationSet.walk = animationActions.values().next().value;
        }

        const actor = new THREE.Group();
        actor.name = "predator-" + def.id;
        actor.add(model);
        actor.position.set(def.start[0], def.start[1], 0);
        actor.rotation.z = def.heading;
        this.scene.add(actor);

        this.frogs.push({
          ...def, actor, model, bones, mixer, animationActions, animationSet,
          activeAction: null, activeAnimationState: null,
          x: def.start[0], y: def.start[1], heading: def.heading,
          phase: Math.random() * Math.PI * 2, speed: 0,
          length: def.targetLength, catchCooldown: 0, state: "waiting",
          stateTimer: 0, landingTimer: 0, tongueTimer: 0, hopClock: Math.random() * 2,
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
      if (!frog.actor.visible) frog.speed = 0;
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
      set("hips", -0.10 * crouch);
      set("spine_1", 0.12 * crouch);
      set("spine_2", 0.08 * crouch);
      set("head", -0.16 + 0.025 * wave);
      set("thigh_l", -0.48 * crouch); set("thigh_r", -0.48 * crouch);
      set("shin_l", 0.72 * crouch); set("shin_r", 0.72 * crouch);
      set("ankle_l", -0.22 * crouch); set("ankle_r", -0.22 * crouch);
      set("foot_l", 0.16 * crouch); set("foot_r", 0.16 * crouch);
      set("upperarm_l", -0.18); set("upperarm_r", -0.18);
      set("forearm_l", 0.22); set("forearm_r", 0.22);
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
        if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0);
        entry.bone.position.add(direction.normalize().multiplyScalar(direction.length() * strike * 0.8));
      }
    }
  }

  _pose(frog, dt) {
    const state = frog.state;
    const desired = state === "lunging" ? frog.animationSet.lunge :
      state === "approaching" ? frog.animationSet.walk : null;
    const next = desired || null;

    if (next && next !== frog.activeAction) {
      const previous = frog.activeAction;
      next.reset();
      next.enabled = true;
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      next.setEffectiveTimeScale(state === "approaching" ? 0.82 : 1);
      next.setEffectiveWeight(1);
      next.play();
      if (previous) previous.crossFadeTo(next, 0.16, false);
      else next.fadeIn(0.12);
      frog.activeAction = next;
      frog.activeAnimationState = state;
    } else if (!next && frog.activeAction) {
      frog.activeAction.fadeOut(0.08);
      frog.activeAction = null;
      frog.activeAnimationState = null;
    } else if (next && frog.activeAnimationState !== state) {
      next.reset();
      next.setEffectiveTimeScale(state === "approaching" ? 0.82 : 1);
      frog.activeAnimationState = state;
    }

    frog.mixer.update(dt);
    if (!next) this._proceduralPose(frog, dt, state);

    // Hop cadence adds a real body lift to the authored leg cycle. The model
    // is airborne briefly during each stride instead of translating flatly.
    let lift = 0;
    if (state === "approaching" || state === "lunging") {
      frog.hopClock += dt * (state === "lunging" ? 8.2 : 5.0);
      const pulse = Math.max(0, Math.sin(frog.hopClock));
      lift = pulse * pulse * (state === "lunging" ? 5.5 : 2.2);
    } else if (state === "landing") {
      lift = Math.max(0, 2.2 * (1 - frog.stateTimer / 0.34));
    }
    frog.actor.position.set(frog.x, frog.y, lift);
    frog.actor.rotation.z = frog.heading;
  }

  update(dt, fly) {
    if (!this.ready || !fly || dt <= 0) return;
    dt = Math.min(dt, 0.12);
    this.catchLock = Math.max(0, this.catchLock - dt);
    for (const frog of this.frogs) {
      if (!frog.actor.visible) continue;
      frog.catchCooldown = Math.max(0, frog.catchCooldown - dt);
      frog.stateTimer += dt;
      if (frog.tongueTimer > 0) {
        frog.tongueTimer = Math.max(0, frog.tongueTimer - dt);
        frog.state = "catching";
        frog.speed = 0;
        this._pose(frog, dt);
        continue;
      }
      if (frog.landingTimer > 0) {
        frog.landingTimer = Math.max(0, frog.landingTimer - dt);
        frog.state = "landing";
        frog.speed *= Math.exp(-dt * 8);
        this._pose(frog, dt);
        continue;
      }
      const dx = fly.x - frog.x;
      const dy = fly.y - frog.y;
      const distance = Math.hypot(dx, dy);
      const desired = Math.atan2(dy, dx);
      const turn = clamp(wrapAngle(desired - frog.heading), -2.4 * dt, 2.4 * dt);
      frog.heading = wrapAngle(frog.heading + turn);

      let targetSpeed = 0;
      const previousState = frog.state;
      if (distance > 96) {
        frog.state = "approaching";
        targetSpeed = 26;
      } else if (distance > 36) {
        frog.state = "stalking";
        targetSpeed = 11;
      } else if (distance > frog.length * 0.38 && fly.z < 12) {
        frog.state = "lunging";
        targetSpeed = 48;
      } else {
        frog.state = "waiting";
      }
      if (previousState === "lunging" && frog.state !== "lunging") {
        frog.landingTimer = 0.34;
        frog.stateTimer = 0;
        frog.state = "landing";
      } else if (previousState !== frog.state) {
        frog.stateTimer = 0;
      }
      if (fly.z >= 12 && distance < 48) targetSpeed = 0;
      frog.speed += (targetSpeed - frog.speed) * Math.min(1, dt * 3.5);
      frog.x += Math.cos(frog.heading) * frog.speed * dt;
      frog.y += Math.sin(frog.heading) * frog.speed * dt;

      const maxR = Math.max(20, this.arenaRadius - frog.length * 0.62 - 5);
      const r = Math.hypot(frog.x, frog.y);
      if (r > maxR) {
        frog.x *= maxR / r;
        frog.y *= maxR / r;
      }
      this._pose(frog, dt);

      // The model's head is toward local +X. Its mouth sits forward of the body centre.
      const mouthX = frog.x + Math.cos(frog.heading) * frog.length * 0.34;
      const mouthY = frog.y + Math.sin(frog.heading) * frog.length * 0.34;
      const mouthDistance = Math.hypot(fly.x - mouthX, fly.y - mouthY);
      const attackRange = Math.max(12, frog.length * 0.48);
      const withinBite = mouthDistance < attackRange || distance < attackRange * 0.85;
      if (this.catchLock <= 0 && frog.catchCooldown <= 0 && fly.z < 12 && withinBite) {
        frog.catchCooldown = 1.8;
        this.catchLock = 0.8;
        frog.state = "catching";
        frog.stateTimer = 0;
        frog.tongueTimer = 0.42;
        frog.speed = 0;
        this._pose(frog, 0);
        this.onCatch({ id: frog.id, name: frog.name, x: frog.x, y: frog.y });
        break;
      }
    }
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
