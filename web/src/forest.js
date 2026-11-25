// Forest-floor scenery for the grass arena: stones, moss tufts, bracken and lady ferns
// (web/assets/env). Laid out once from a fixed seed, clear of where the fly and the frogs
// start. Stones and moss are solid: they go into the terrain's height map, so the fly walks
// and hops up onto them, rain lands on them, grass stays under them and frogs sit on them.
// The ferns are a backdrop the fly walks under.
//
// The plants are web-optimised GLBs (meshopt geometry, KTX2 textures). The stones come from
// a stone set (StoneSets.fbx, converted to stones.glb) whose texture maps were not supplied,
// so they get a procedural stone surface until StonesA/B/C_BaseColor/Normal/Roughness
// textures are added.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

// The Basis transcoder (KTX2 textures) sits next to the loaders: from the import map on the
// website, from the APK's copy of three.js in the phone app.
function transcoderPath() {
  try { return import.meta.resolve("three/addons/libs/basis/"); } catch { /* old browser */ }
  return "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/basis/";
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Procedural stone: grain and flecks in the stone's own space (so they stay on it), pale
// lichen on its upper faces, and fine relief from the same noise as a bump map.
const NOISE = `
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n3(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
vec3 perturb(vec3 pos, vec3 n, vec2 dH, float face) {
  vec3 sx = normalize(dFdx(pos)), sy = normalize(dFdy(pos));
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * face;
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`;

function stoneMaterial(color, seed, base = 0) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSeed = { value: seed };
    sh.uniforms.uBase = { value: base };
    sh.vertexShader = "varying vec3 vObj; varying vec3 vWN; varying float vWZ;\n" + sh.vertexShader.replace("#include <begin_vertex>",
      "#include <begin_vertex>\nvObj = position;\nvWN = normalize(mat3(modelMatrix) * normal);\nvWZ = (modelMatrix * vec4(position, 1.0)).z;");
    sh.fragmentShader = "uniform float uSeed; uniform float uBase; varying vec3 vObj; varying vec3 vWN; varying float vWZ;\n" + NOISE + "\n" + sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  vec3 sp = vObj * 0.12 + uSeed;
  float g = fbm(sp), band = fbm(vec3(vObj.y * 0.35, vObj.x * 0.05, uSeed));
  float speck = smoothstep(0.8, 0.9, n3(vObj * 0.7 - uSeed));
  diffuseColor.rgb *= 0.62 + 0.6 * g;
  diffuseColor.rgb *= 0.9 + 0.2 * band;                                   // faint strata
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, speck * 0.6);
  float lichen = smoothstep(0.6, 0.7, fbm(vObj * 0.09 + uSeed * 3.0)) * smoothstep(0.4, 0.85, vWN.z);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.57, 0.45), lichen * 0.55);
  // damp and greenish where it meets the soil
  float damp = 1.0 - smoothstep(uBase, uBase + 2.5, vWZ);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.62, 0.45), damp * 0.8);`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  float hgt = fbm(vObj * 0.35 + uSeed);
  normal = perturb(-vViewPosition, normal, vec2(dFdx(hgt), dFdy(hgt)) * 1.1, faceDirection);`);
  };
  return m;
}

/**
 * Load and place the scenery into terrain.group. Returns the solid meshes (stones, moss)
 * that terrain.bake() should include.
 */
export async function loadForest(terrain, renderer, base, keepClear = []) {
  const ktx2 = new KTX2Loader().setTranscoderPath(transcoderPath()).detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const [stones, moss, bracken, fern] = await Promise.all(
    ["stones.glb", "moss-tufts.glb", "bracken.glb", "lady-fern.glb"].map((f) => loader.loadAsync(base + f)));
  const R = terrain.radius, r = rng(2024);
  const group = new THREE.Group();
  group.name = "forest";
  terrain.group.add(group);
  const placed = [...keepClear]; // {x, y, r}
  const free = (x, y, rad, pad = 4) => Math.hypot(x, y) + rad < R - 6 && placed.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + rad + pad);
  const spot = (rad, rMin, rMax, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      const a = r() * Math.PI * 2, d = rMin + Math.sqrt(r()) * (rMax - rMin);
      const x = d * Math.cos(a), y = d * Math.sin(a);
      if (free(x, y, rad)) return [x, y];
    }
    return null;
  };
  // A glTF model (Y-up) stood on the arena floor (Z-up), scaled to `width` mm across.
  const stand = (src, width, x, y, yaw, sink = 0) => {
    const o = src.clone(true);
    const box = new THREE.Box3().setFromObject(o), size = box.getSize(new THREE.Vector3());
    const s = width / Math.max(size.x, size.z);
    const holder = new THREE.Group();
    o.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
    holder.add(o);
    holder.rotation.set(Math.PI / 2, yaw, 0, "XYZ"); // Y-up -> Z-up, then turned about the vertical
    holder.scale.setScalar(s);
    holder.position.set(x, y, -sink * size.y * s);
    holder.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    group.add(holder);
    return { holder, height: size.y * s };
  };

  // ---------- stones ----------
  const sets = { A: [], B: [], C: [] };
  stones.scene.traverse((o) => { if (o.isMesh) sets[o.name[0]]?.push(o); });
  const tones = { A: [0.09, 0.09, 0.25], B: [0.08, 0.07, 0.23], C: [0.1, 0.08, 0.21] }; // hue, saturation, lightness
  const solids = [];
  const addStone = (src, width, rMin, rMax, sink) => {
    const at = spot(width * 0.5, rMin, rMax);
    if (!at) return;
    const { holder } = stand(src, width, at[0], at[1], r() * Math.PI * 2, sink);
    // each stone its own tone and grain
    const [h, sat, l] = tones[src.name[0]];
    const mat = stoneMaterial(new THREE.Color().setHSL(h + (r() - 0.5) * 0.04, sat + r() * 0.05, l + (r() - 0.5) * 0.1), r() * 50, 0);
    holder.traverse((m) => { if (m.isMesh) { m.material = mat; solids.push(m); } });
    placed.push({ x: at[0], y: at[1], r: width * 0.5 });
  };
  // A few larger rocks toward the wall, then pebbles and small stones all over.
  const big = [...sets.A, ...sets.C];
  for (let i = 0; i < 3 && big.length; i++) addStone(big[Math.floor(r() * big.length)], 75 + r() * 45, R * 0.5, R * 0.85, 0.15);
  for (let i = 0; i < 13 && sets.B.length; i++) addStone(sets.B[i % sets.B.length], 16 + r() * 30, 20, R * 0.9, 0.12);

  // ---------- moss: around the stones' bases mostly ----------
  const mossSrc = moss.scene;
  const stonesPlaced = placed.slice(keepClear.length);
  for (let i = 0; i < 20; i++) {
    const w = 22 + r() * 38;
    let at = null;
    if (i < 14 && stonesPlaced.length) {
      const st = stonesPlaced[Math.floor(r() * stonesPlaced.length)], a = r() * Math.PI * 2, d = st.r * (0.75 + r() * 0.4);
      const x = st.x + d * Math.cos(a), y = st.y + d * Math.sin(a);
      if (Math.hypot(x, y) + w / 2 < R - 6 && keepClear.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + w / 2)) at = [x, y];
    }
    at ||= spot(w * 0.4, 15, R * 0.92);
    if (!at) continue;
    const { holder } = stand(mossSrc, w, at[0], at[1], r() * Math.PI * 2, 0.1);
    holder.traverse((m) => { if (m.isMesh) solids.push(m); });
  }

  // ---------- ferns: young bracken and lady ferns toward the wall ----------
  for (const [src, n, wMin, wMax] of [[bracken.scene, 3, 190, 260], [fern.scene, 3, 200, 290]]) {
    for (let i = 0; i < n; i++) {
      const w = wMin + r() * (wMax - wMin);
      const at = spot(w * 0.22, R * 0.62, R * 0.9);
      if (!at) continue;
      stand(src, w, at[0], at[1], r() * Math.PI * 2, 0.02);
      placed.push({ x: at[0], y: at[1], r: w * 0.22 });
    }
  }
  // Weeds don't grow through stones.
  terrain.clearWeeds?.(stonesPlaced);
  terrain.solids = solids;
  return { group, solids, stones: stonesPlaced };
}
