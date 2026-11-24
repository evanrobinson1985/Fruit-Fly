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
    start: [-58, 42],
    heading: -0.6,
  },
  {
    id: "big",
    name: "Japanese Toad",
    rootName: "rig.Big.Frog",
    meshName: "Japanese Toad (M).lower",
    targetLength: 66,
    start: [58, -42],
    heading: 2.5,
  },
];

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class FrogPredators {
  constructor(scene, url, onCatch = () => {}) {
    this.scene = scene;
    this.url = url;
    this.onCatch = onCatch;
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
    const normalizeNodeName = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
          if (object.isBone) bones.set(object.name, { bone: object, rest: object.quaternion.clone() });
        });

        const actor = new THREE.Group();
        actor.name = "predator-" + def.id;
        actor.add(model);
        actor.position.set(def.start[0], def.start[1], 0);
        actor.rotation.z = def.heading;
        this.scene.add(actor);

        this.frogs.push({
          ...def, actor, model, bones,
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
    const moving = frog.speed > 0.4;
    frog.phase += dt * (moving ? 5.5 : 0.65);
    const swing = moving ? Math.sin(frog.phase) : 0;
    const crouch = frog.state === "stalking" || frog.state === "lunging" ? 1 : 0;
    const setBone = (name, angle) => {
      const entry = frog.bones.get(name);
      if (!entry) return;
      this.delta.setFromAxisAngle(this.axis, angle);
      entry.bone.quaternion.copy(entry.rest).multiply(this.delta);
    };
    for (const side of ["L", "R"]) {
      const s = side === "L" ? 1 : -1;
      const phase = swing * s;
      setBone("DEF-thigh." + side, phase * 0.16);
      setBone("DEF-shin." + side, Math.max(0, phase) * 0.22);
      setBone("DEF-foot." + side, -phase * 0.12);
      setBone("DEF-upper_arm." + side, -phase * 0.10);
      setBone("DEF-forearm." + side, Math.max(0, -phase) * 0.14);
      setBone("DEF-hand." + side, phase * 0.08);
    }
    setBone("DEF-spine.003", -0.035 * crouch + Math.sin(frog.phase * 2) * 0.012);
    const bob = moving ? Math.max(0, Math.sin(frog.phase * 2)) * 0.32 : 0;
    frog.actor.position.set(frog.x, frog.y, bob);
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
      if (distance > 48) {
        frog.state = "approaching";
        targetSpeed = 13;
      } else if (distance > 18) {
        frog.state = "stalking";
        targetSpeed = 5.5;
      } else if (distance > 7 && fly.z < 10) {
        frog.state = "lunging";
        targetSpeed = 27;
      } else {
        frog.state = "waiting";
      }
      if (fly.z >= 10 && distance < 24) targetSpeed = 0;
      frog.speed += (targetSpeed - frog.speed) * Math.min(1, dt * 3.5);
      frog.x += Math.cos(frog.heading) * frog.speed * dt;
      frog.y += Math.sin(frog.heading) * frog.speed * dt;

      const maxR = 91;
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
      if (this.catchLock <= 0 && frog.catchCooldown <= 0 && fly.z < 10 && mouthDistance < 5.5) {
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
