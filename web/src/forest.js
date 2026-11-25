// Forest-floor scenery for the grass arena: a pond in the middle, the lawn (a grass model),
// stones, moss tufts, bracken and lady ferns
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
import { PondWater, RIPPLE_GLSL, reflectable, underwater, LAYER_UNDER } from "./water.js";

// The Basis transcoder (KTX2 textures) sits next to the loaders: from the import map on the
// website, from the APK's copy of three.js in the phone app.
function transcoderPath() {
  try { return import.meta.resolve("three/addons/libs/basis/"); } catch { /* old browser */ }
  return "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/basis/";
}

// The pond (pond.glb: its basin, cut from the ground tile it came with, plus margin stones,
// rushes, cattails, water lilies and the water) is 21 m across as modelled; here it is
// POND_R mm in radius, set into a matching hole in the arena floor.
export const POND_R = 140;
const POND_MODEL_R = 10.5; // m: where the basin meets the level ground in the model
const POND_WATER_Y = -0.3; // m: the model's water level

// Pond bed, banks and shore stones: wet and darker just above the waterline; under the water
// fine silt that greys the bed with depth, green algae in the shallows, and the dancing
// light (caustics) the ripples focus onto the bed.
const SHORE_GLSL = RIPPLE_GLSL + `
uniform float uWaterZ, uWTime;
varying vec3 vWPos;
vec2 cHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float causticLayer(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), h = cHash(i + g);
    vec2 o = 0.5 + 0.45 * sin(t * (0.6 + 0.5 * h) + 6.2831 * h);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return pow(1.0 - smoothstep(0.0, 0.3, d2 - d1), 2.0);
}
float caustics(vec2 p, float t) {
  // warped by the drifting ripples, so the web of light wavers instead of tiling
  p += 6.0 * vec2(wNoise(p * 0.02 + t * 0.15), wNoise(p * 0.02 - t * 0.13 + 5.0));
  return causticLayer(p * 0.08, t) * 0.55 + causticLayer(p * 0.115 + 3.7, t * 1.3) * 0.45;
}`;
function shoreMaterial(mat, shared) {
  const m = mat.clone();
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    sh.vertexShader = "varying vec3 vWPos;\n" + sh.vertexShader.replace("#include <worldpos_vertex>",
      "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = SHORE_GLSL + "\n" + sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
  float below = uWaterZ - vWPos.z;                          // mm under the surface (< 0 above it)
  float wet = below > 0.0 ? 1.0 : 1.0 - smoothstep(0.0, 3.0, -below);
  diffuseColor.rgb *= mix(1.0, 0.6, wet);
  float silt = smoothstep(2.0, 50.0, below);
  vec3 siltCol = vec3(0.22, 0.19, 0.14) * (0.75 + 0.5 * wNoise(vWPos.xy * 0.12));
  diffuseColor.rgb = mix(diffuseColor.rgb, siltCol, silt * 0.6);
  float patchy = wNoise(vWPos.xy * 0.035) * 0.65 + wNoise(vWPos.xy * 0.35) * 0.35;
  float alg = smoothstep(0.5, 0.72, patchy) * smoothstep(-3.0, 3.0, below) * (1.0 - smoothstep(22.0, 45.0, below));
  float slime = (1.0 - smoothstep(0.0, 3.0, abs(below + 1.0))) * smoothstep(0.35, 0.6, wNoise(vWPos.xy * 0.2));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14, 0.24, 0.06), max(alg * 0.75, slime * 0.6));`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.45, wet * (1.0 - silt));      // wet and glossier at the waterline`)
      .replace("#include <opaque_fragment>", `
  if (below > 0.0) outgoingLight += diffuseColor.rgb * caustics(vWPos.xy, uWTime) * 0.5 * exp(-below * 0.025) * smoothstep(0.0, 3.0, below);
  #include <opaque_fragment>`);
  };
  return m;
}

// Underwater weed (pondweed / Elodea): ribbon stems rooted on the bed, swaying in the water.
function pondweedGeometry() {
  const pos = [], idx = [], segs = 10;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, w = 0.5 * (1 - 0.6 * t);
    pos.push(-w, 0, t, w, 0, t);
  }
  for (let i = 0; i < segs; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  // little leaves in whorls up the stem
  let base = pos.length / 3;
  for (let i = 1; i <= 2 * segs; i++) {
    const t = i / (2 * segs);
    for (let k = 0; k < 3; k++) {
      // a narrow leaf, angled up from the stem, in whorls of three
      const a = (k / 3) * Math.PI * 2 + i * 1.1, c = Math.cos(a), s = Math.sin(a), L = 1.6 * (1 - 0.4 * t), W = 0.22;
      pos.push(0, 0, t, c * L * 0.5 - s * W, s * L * 0.5 + c * W, t + 0.02, c * L, s * L, t + 0.05, c * L * 0.5 + s * W, s * L * 0.5 - c * W, t + 0.02);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Procedural stone: grain and flecks in the stone's own space (so they stay on it), pale
// lichen on its upper faces, and fine relief from the same noise as a bump map.
function wnoise2(x, y) {
  const h = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return (h(ix, iy) * (1 - ux) + h(ix + 1, iy) * ux) * (1 - uy) + (h(ix, iy + 1) * (1 - ux) + h(ix + 1, iy + 1) * ux) * uy;
}

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
export async function loadForest(terrain, renderer, base, keepClear = [], { high = false } = {}) {
  const ktx2 = new KTX2Loader().setTranscoderPath(transcoderPath()).detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const [stones, moss, bracken, fern, pond] = await Promise.all(
    ["stones.glb", "moss-tufts.glb", "bracken.glb", "lady-fern.glb", "pond.glb"].map((f) => loader.loadAsync(base + f)));
  const R = terrain.radius, r = rng(2024);
  const group = new THREE.Group();
  group.name = "forest";
  terrain.group.add(group);
  keepClear = [...keepClear, { x: 0, y: 0, r: POND_R + 10 }];
  const placed = [...keepClear]; // {x, y, r}

  // ---------- the pond, in the middle ----------
  const solids = [];
  const k = POND_R / POND_MODEL_R; // mm per model metre
  const waterZ = POND_WATER_Y * k;
  const shared = { uWaterZ: { value: waterZ }, uWTime: { value: 0 } };
  let water = null, bed = null;
  {
    const holder = new THREE.Group();
    holder.rotation.x = Math.PI / 2; // Y-up -> Z-up
    holder.scale.setScalar(k);
    holder.add(pond.scene);
    group.add(holder);
    holder.updateMatrixWorld(true);
    const meshes = [];
    pond.scene.traverse((m) => { if (m.isMesh) meshes.push(m); });
    for (const m of meshes) {
      const name = (m.material.name || "") + " " + m.name;
      if (/water/i.test(name)) {
        // Our own water (water.js) takes the model's place, on its outline.
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        m.parent.remove(m);
        // On a computer: full-resolution passes, the reflection redrawn every frame.
        water = new PondWater(renderer, geo, waterZ, high ? { scale: 1, reflectEvery: 1 } : { scale: renderer.getPixelRatio() > 1.5 ? 0.3 : 0.4, reflectEvery: 2 });
        group.add(water.mesh);
        solids.push(water.mesh); // the fly can stand on the water
        continue;
      }
      m.receiveShadow = true;
      reflectable(m);
      underwater(m);
      if (/plants|lilies|cattails|rushes/i.test(name)) { m.castShadow = true; continue; }
      m.castShadow = /stone/i.test(name);
      m.material = shoreMaterial(m.material, shared);
      if (/bed/i.test(name)) bed = m;
      solids.push(m); // walkable: the banks, the bed, the stones
    }
  }
  // Height of the pond bed at (x, y), by a ray down onto it.
  const ray = new THREE.Raycaster();
  const bedAt = (x, y) => {
    ray.set(new THREE.Vector3(x, y, 200), new THREE.Vector3(0, 0, -1));
    const h = bed && ray.intersectObject(bed, false)[0];
    return h ? h.point.z : 0;
  };

  // ---------- underwater weed ----------
  {
    const geo = pondweedGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: 0x3f6a22, roughness: 0.6, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, shared);
      sh.vertexShader = "uniform float uWTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
  float ph = instanceMatrix[3].x * 0.07 + instanceMatrix[3].y * 0.05;
  float sw = transformed.z * transformed.z;
  transformed.x += sin(uWTime * 0.9 + ph) * 0.18 * sw;
  transformed.y += cos(uWTime * 0.7 + ph * 1.3) * 0.12 * sw;`);
    };
    const n = 160, weed = new THREE.InstancedMesh(geo, mat, n), mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    let placed = 0;
    for (let tries = 0; placed < n && tries < n * 6; tries++) {
      // in clumps, in water 15+ mm deep
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * POND_R * 0.92;
      const x = d * Math.cos(a), y = d * Math.sin(a), z = bedAt(x, y), depth = waterZ - z;
      if (depth < 5 || wnoise2(x * 0.04, y * 0.04) < 0.45) continue;
      const h = depth * (0.45 + r() * 0.5), wdt = 0.9 + r() * 0.8;
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), r() * Math.PI * 2);
      mtx.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(wdt, wdt, h));
      weed.setMatrixAt(placed, mtx);
      weed.setColorAt(placed, col.setHSL(0.24 + r() * 0.06, 0.45 + r() * 0.2, 0.22 + r() * 0.12));
      placed++;
    }
    weed.count = placed;
    weed.layers.set(LAYER_UNDER); // only ever seen through the water
    weed.frustumCulled = false;
    group.add(weed);
  }

  // ---------- duckweed floating near the shore ----------
  {
    const frond = new THREE.CircleGeometry(1, 7);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6aa83a, roughness: 0.45 });
    const n = 2600, duck = new THREE.InstancedMesh(frond, mat, n), mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    duck.frustumCulled = false;
    let placed = 0;
    for (let c = 0; c < 9 && placed < n; c++) {
      // a raft of fronds drifted against the bank
      const a = r() * Math.PI * 2, d = POND_R * (0.7 + r() * 0.2), cx = d * Math.cos(a), cy = d * Math.sin(a);
      const m = 30 + Math.floor(r() * 40);
      for (let i = 0; i < m && placed < n; i++) {
        const rr = 8 * Math.sqrt(-Math.log(1 - r() * 0.98)), aa = r() * Math.PI * 2;
        const x = cx + rr * Math.cos(aa), y = cy + rr * Math.sin(aa);
        if (waterZ - bedAt(x, y) < 1.5) continue; // only on open water
        const s = 0.6 + r() * 0.6;
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), r() * 6.28);
        mtx.compose(new THREE.Vector3(x, y, waterZ + 0.25), q, new THREE.Vector3(s * 1.2, s, 1));
        duck.setMatrixAt(placed, mtx);
        duck.setColorAt(placed, col.setHSL(0.24 + r() * 0.04, 0.55, 0.32 + r() * 0.12));
        placed++;
      }
    }
    duck.count = placed;
    duck.receiveShadow = true;
    reflectable(duck);
    group.add(duck);
  }
  water.isWater = (x, y) => terrain.groundAt(x, y) <= waterZ + 0.05;
  terrain.uniforms.uWaterLine.value = waterZ; // grass down the banks to the water's edge
  reflectable(terrain.floor); // the far banks show in the water
  for (const m of terrain.weedMeshes || []) reflectable(m);
  // The basin's outline is whole triangles, so the hole is a little smaller and the floor
  // draws behind the basin where they overlap: no gap at the seam.
  terrain.cutHole(POND_R - 5);
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
    holder.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; } });
    group.add(holder);
    return { holder, height: size.y * s };
  };

  // ---------- stones ----------
  const sets = { A: [], B: [], C: [] };
  stones.scene.traverse((o) => { if (o.isMesh) sets[o.name[0]]?.push(o); });
  const tones = { A: [0.09, 0.09, 0.25], B: [0.08, 0.07, 0.23], C: [0.1, 0.08, 0.21] }; // hue, saturation, lightness
  const addStone = (src, width, rMin, rMax, sink) => {
    const at = spot(width * 0.5, rMin, rMax);
    if (!at) return;
    const { holder } = stand(src, width, at[0], at[1], r() * Math.PI * 2, sink);
    // each stone its own tone and grain
    const [h, sat, l] = tones[src.name[0]];
    const mat = stoneMaterial(new THREE.Color().setHSL(h + (r() - 0.5) * 0.04, sat + r() * 0.05, l + (r() - 0.5) * 0.1), r() * 50, 0);
    holder.traverse((m) => { if (m.isMesh) { m.material = mat; solids.push(m); } });
    reflectable(holder);
    placed.push({ x: at[0], y: at[1], r: width * 0.5 });
  };
  // A few larger rocks toward the wall, then pebbles and small stones all over.
  const big = [...sets.A, ...sets.C];
  for (let i = 0; i < 3 && big.length; i++) addStone(big[Math.floor(r() * big.length)], 75 + r() * 45, R * 0.5, R * 0.9, 0.15);
  for (let i = 0; i < 13 && sets.B.length; i++) addStone(sets.B[i % sets.B.length], 16 + r() * 30, 20, R * 0.93, 0.12);

  // ---------- shoreline stones: half in the water, all round the edge ----------
  // With the pond's own photographed stone texture, wet and slimy at the waterline.
  {
    let marginSrc = null, lastA = 0;
    pond.scene.traverse((m) => { if (m.isMesh && /stone/i.test(m.material.name || "")) marginSrc = m.material; });
    for (let i = 0; i < 9 && sets.B.length; i++) {
      // scattered, some in little groups, not evenly round the edge
      const a = i > 0 && r() < 0.35 ? lastA + (r() - 0.5) * 0.35 : r() * Math.PI * 2;
      lastA = a;
      // the shoreline along this bearing: where the bed comes up to the water
      let shore = 0;
      for (let d = POND_R * 0.98; d > POND_R * 0.4; d -= 1.5) if (bedAt(d * Math.cos(a), d * Math.sin(a)) < waterZ + 1) { shore = d; break; }
      if (!shore) continue;
      const d = shore + (r() - 0.5) * 6, x = d * Math.cos(a), y = d * Math.sin(a), w = 7 + r() * r() * 26;
      const { holder, height } = stand(sets.B[Math.floor(r() * sets.B.length)], w, x, y, r() * Math.PI * 2, 0);
      holder.position.z = bedAt(x, y) - 0.4 * height;
      const mat = marginSrc ? marginSrc : stoneMaterial(new THREE.Color().setHSL(0.08, 0.07, 0.22), r() * 50, 0);
      holder.traverse((m) => { if (m.isMesh) { m.material = mat; solids.push(m); } });
      reflectable(holder);
      underwater(holder);
    }
  }

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
    reflectable(holder);
  }

  // ---------- ferns: young bracken and lady ferns toward the wall ----------
  for (const [src, n, wMin, wMax] of [[bracken.scene, 3, 190, 260], [fern.scene, 3, 200, 290]]) {
    for (let i = 0; i < n; i++) {
      const w = wMin + r() * (wMax - wMin);
      const at = spot(w * 0.22, R * 0.62, R * 0.9);
      if (!at) continue;
      reflectable(stand(src, w, at[0], at[1], r() * Math.PI * 2, 0.02).holder);
      placed.push({ x: at[0], y: at[1], r: w * 0.22 });
    }
  }
  // ---------- grass: the lawn itself, from the grass model ----------
  try {
    const tl = new THREE.TextureLoader();
    const [grass, map, normalMap] = await Promise.all([
      loader.loadAsync(base + "grass.glb"), tl.loadAsync(base + "grass_diff.png"), tl.loadAsync(base + "grass_nor.jpg")]);
    map.colorSpace = THREE.SRGBColorSpace;
    for (const t of [map, normalMap]) { t.flipY = false; t.anisotropy = high ? renderer.capabilities.getMaxAnisotropy() : 4; } // glTF UVs
    const geo = (name) => { let g = null; grass.scene.traverse((o) => { if (o.isMesh && o.name === name) g = o.geometry; }); return g; };
    terrain.useGrassModel({ near: geo("mid_b"), mid: geo("small_a"), far: geo("small_b") }, { map, normalMap }, high ? 1.45 : 1.9);
    // the grass round the fly and the light far grass show in the water
    // the grass shows in the water: all of it on a computer, only round the fly on a phone
    for (const c of high ? terrain.clumps : terrain.clumps.slice(0, 1)) reflectable(c);
  } catch (e) {
    console.warn("Grass model did not load; keeping the generated grass:", e);
  }
  // Weeds don't grow through stones.
  terrain.clearWeeds?.(stonesPlaced);
  terrain.solids = solids;
  const update = (t) => { shared.uWTime.value = t; };
  return { group, solids, stones: stonesPlaced, update, water, waterZ };
}
