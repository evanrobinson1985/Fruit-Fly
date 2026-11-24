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

        const rawBounds = new THREE.Box3().setFromObject(rig);
        const rawLength = Math.max(0.001, rawBounds.max.x - rawBounds.min.x);
        const scale = def.targetLength / rawLength;
        const model = new THREE.Group();
        model.add(rig);
        // glTF models use +Y as up; the lab world uses +Z. Rotate +90° about X.
        model.rotation.x = Math.PI / 2;
        model.scale.setScalar(scale);
        model.updateMatrixWorld(true);

        const bounds = new THREE.Box3().setFromObject(model);
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
          walk: findAction(/walk|locomotion|run|move/i),
          stalk: findAction(/stalk|crouch|sneak/i),
          lunge: findAction(/lunge|jump|leap|attack/i),
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

  _pose(frog, dt) {
    const state = frog.state;
    const desired = state === "catching" ? frog.animationSet.catch :
      state === "lunging" ? frog.animationSet.lunge :
      state === "stalking" ? (frog.animationSet.stalk || frog.animationSet.walk) :
      state === "approaching" ? frog.animationSet.walk :
      frog.animationSet.idle;
    const next = desired || (state !== "waiting" ? frog.animationSet.walk : null);

    if (next && next !== frog.activeAction) {
      const previous = frog.activeAction;
      next.reset();
      next.enabled = true;
      next.setEffectiveTimeScale(state === "stalking" ? 0.55 : state === "approaching" ? 0.85 : 1);
      next.setEffectiveWeight(1);
      next.play();
      if (previous) previous.crossFadeTo(next, 0.28, false);
      else next.fadeIn(0.2);
      frog.activeAction = next;
      frog.activeAnimationState = state;
    } else if (next && frog.activeAnimationState !== state) {
      next.setEffectiveTimeScale(state === "stalking" ? 0.55 : state === "approaching" ? 0.85 : 1);
      frog.activeAnimationState = state;
    }

    // Keep rigs with no authored clips in their correct rest pose rather than
    // applying the old, visibly incorrect global-axis bone rotations.
    frog.mixer.update(dt);
    frog.actor.position.set(frog.x, frog.y, 0);
    frog.actor.rotation.z = frog.heading;
  }

  update(dt, fly) {
    if (!this.ready || !fly || dt <= 0) return;
    dt = Math.min(dt, 0.12);
    this.catchLock = Math.max(0, this.catchLock - dt);
    for (const frog of this.frogs) {
      if (!frog.actor.visible) continue;
      frog.catchCooldown = Math.max(0, frog.catchCooldown - dt);
      const dx = fly.x - frog.x;
      const dy = fly.y - frog.y;
      const distance = Math.hypot(dx, dy);
      const desired = Math.atan2(dy, dx);
      const turn = clamp(wrapAngle(desired - frog.heading), -2.4 * dt, 2.4 * dt);
      frog.heading = wrapAngle(frog.heading + turn);

      let targetSpeed = 0;
      if (distance > 96) {
        frog.state = "approaching";
        targetSpeed = 26;
      } else if (distance > 36) {
        frog.state = "stalking";
        targetSpeed = 11;
      } else if (distance > frog.length * 0.38 && fly.z < 12) {
        // Close-range attack: accelerate toward the fly instead of stopping just outside it.
        frog.state = "lunging";
        targetSpeed = 48;
      } else {
        frog.state = "waiting";
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
