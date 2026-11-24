import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
const files = ["web/assets/frogs-rigged.glb", "web/assets/frogs-animated.glb"];
function inspect(path) {
  const file = resolve(path), data = readFileSync(file);
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "glTF") throw new Error(path + " is not a valid GLB");
  const version = data.readUInt32LE(4), declaredLength = data.readUInt32LE(8);
  if (version !== 2 || declaredLength !== data.length) throw new Error(path + " has an invalid GLB header/length");
  const jsonLength = data.readUInt32LE(12), jsonType = data.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a || 20 + jsonLength > data.length) throw new Error(path + " has no valid JSON chunk");
  const json = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).replace(/\\0+$/g, "").trim());
  const nodes = json.nodes || [];
  const skins = (json.skins || []).map((skin, i) => ({
    index: i, name: skin.name || "(unnamed skin)", jointCount: (skin.joints || []).length,
    joints: (skin.joints || []).map(n => nodes[n]?.name || ("node-" + n)),
    skeleton: skin.skeleton == null ? null : (nodes[skin.skeleton]?.name || ("node-" + skin.skeleton))
  }));
  const meshes = (json.meshes || []).map((mesh, index) => ({index, name: mesh.name || "(unnamed mesh)", primitives: (mesh.primitives || []).length}));
  const sceneRoots = json.scenes?.[json.scene || 0]?.nodes || [];
  const hierarchy = [];
  const walk = (index, depth = 0) => {
    const node = nodes[index]; if (!node) return;
    hierarchy.push({index, depth, name: node.name || "(unnamed node)", mesh: node.mesh ?? null, skin: node.skin ?? null, translation: node.translation || null, rotation: node.rotation || null});
    for (const child of node.children || []) walk(child, depth + 1);
  };
  for (const index of sceneRoots) walk(index);
  const animations = (json.animations || []).map(clip => {
    const targets = new Set(), paths = new Set();
    for (const channel of clip.channels || []) {
      const n = channel.target?.node;
      if (n != null) targets.add(nodes[n]?.name || ("node-" + n));
      if (channel.target?.path) paths.add(channel.target.path);
    }
    const rootTracks = (clip.channels || []).filter(channel => nodes[channel.target?.node]?.name === "root").map(channel => {
      const sampler = clip.samplers?.[channel.sampler], input = json.accessors?.[sampler?.input], output = json.accessors?.[sampler?.output];
      return {path: channel.target?.path, inputMin: input?.min, inputMax: input?.max, outputMin: output?.min, outputMax: output?.max, outputCount: output?.count};
    });
    return {name: clip.name || "(unnamed animation)", channels: (clip.channels || []).length,
      targetNodes: [...targets], targetPaths: [...paths], rootTracks,
      durationSeconds: Math.max(0, ...(clip.samplers || []).map(s => json.accessors?.[s.input]?.max?.[0] ?? 0))};
  });
  console.log("\n=== " + path + " (" + statSync(file).size + " bytes) ===");
  console.log(JSON.stringify({glbVersion:version, sceneNodes:nodes.length, sceneRoots, hierarchy, skins, meshes, animations}, null, 2));
}
for (const file of files) inspect(file);
