// Compare the browser engine with the Python one (results/validation.md, "realistic").
//   node web/tools/check_engine.mjs
import { readFileSync } from "node:fs";
import { Brain, decodeConnectome } from "../src/brain-engine.js";
import { decodePng } from "../src/pngdata.js";

const dir = new URL("../assets/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("brain.json", dir)));
let t0 = Date.now();
const parts = await Promise.all(meta.chunks.map((c) => decodePng(new Uint8Array(readFileSync(new URL(c.file, dir))), c.bytes)));
const bytes = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
parts.reduce((o, p) => (bytes.set(p, o), o + p.length), 0);
const net = decodeConnectome(bytes, meta.n, meta.edges);
console.log(`decoded ${meta.n} neurons, ${meta.edges} edges in ${Date.now() - t0} ms`);
const brain = new Brain(net, meta.params, 7);
const G = meta.groups;
const both = (d) => [...d.L, ...d.R];

function probe(name, idx, hz = 100, ms = 500) {
  brain.reset();
  brain.clearRates();
  brain.setRates(idx, hz);
  const counts = new Uint16Array(meta.n);
  const t = Date.now();
  brain.run(ms, counts);
  const wall = Date.now() - t;
  brain.clearRates();
  brain.run(100);
  const after = new Uint16Array(meta.n);
  brain.run(200, after);
  const rate = (d) => both(d).reduce((s, i) => s + counts[i], 0) / both(d).length / (ms / 1000);
  const nz = (a) => a.reduce((s, c) => s + (c > 0), 0);
  console.log(`${name.padEnd(12)} GF ${rate(G.motor.escape).toFixed(0).padStart(4)} Hz  MN9 ${rate(G.motor.feed).toFixed(0).padStart(3)} Hz  ` +
    `active ${String(nz(counts)).padStart(5)}  still active ${String(nz(after)).padStart(4)}  ` +
    `(${(wall / ms).toFixed(2)}x real time)`);
}

probe("LC4+LPLC2", both(G.loom));
probe("vinegar", both(G.odor.vinegar));
probe("taste", G.taste);

// Detailed model (flysim.model.make_detailed; compare with results/validation.md).
const D = meta.detailed;
const all = new Int32Array((await decodePng(new Uint8Array(readFileSync(new URL(D.file, dir))), D.ints * 4)).buffer);
const arrays = Object.fromEntries(Object.entries(D.layout).map(([k, [o, n]]) => [k, all.subarray(o, o + n)]));
const types = JSON.parse(readFileSync(new URL("brain-types.json", dir))).types;
const tid = new Uint16Array((await decodePng(new Uint8Array(readFileSync(new URL("brain-type.png", dir))), meta.n * 2)).buffer);
const ofType = (...names) => { const ids = names.map((t) => types.indexOf(t) + 1); const out = []; tid.forEach((t, i) => ids.includes(t) && out.push(i)); return out; };
brain.setDetailed(true, arrays, D.params);
const hz = (counts, idx, ms) => idx.reduce((s, i) => s + counts[i], 0) / idx.length / (ms / 1000);

// Giant Fiber -> TTMn: electrical synapses make TTMn follow the GF.
for (const on of [false, true]) {
  brain.setDetailed(on);
  brain.reset(); brain.clearRates();
  brain.setRates(ofType("DNp01"), 120);
  const counts = new Uint16Array(meta.n);
  brain.run(300, counts);
  console.log(`${on ? "detailed" : "standard"} GF drive: GF ${hz(counts, ofType("DNp01"), 300).toFixed(0)} Hz, TTMn ${hz(counts, ofType("TTMn"), 300).toFixed(0)} Hz, PSI ${hz(counts, ofType("PSI"), 300).toFixed(0)} Hz`);
}

// Background activity, standard vs detailed (octopamine must not run away).
for (const on of [false, true]) {
  brain.setDetailed(on);
  brain.reset(); brain.clearRates();
  brain.setRates(G.background.idx, 0); G.background.idx.forEach((i, k) => (brain.rate[i] = G.background.hz[k])); brain._dirty = true;
  brain.run(500);
  const counts = new Uint16Array(meta.n);
  const t = Date.now();
  brain.run(2000, counts);
  const oa = ofType(...types.filter((t) => t.startsWith("OA-")));
  console.log(`${on ? "detailed" : "standard"} background: mean ${(counts.reduce((a, c) => a + c, 0) / meta.n / 2).toFixed(3)} Hz, OA ${hz(counts, oa, 2000).toFixed(1)} Hz (${((Date.now() - t) / 2000).toFixed(2)}x real time)`);
}

// Mushroom body learning: 200 KCs ("odor A") paired with PPL101, vs 200 others ("odor B").
brain.setDetailed(true);
brain.reset(); brain.clearRates();
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const kcs = [...arrays.kc].sort(() => rnd() - 0.5), A = kcs.slice(0, 200), B = kcs.slice(200, 400);
const mbon11 = ofType("MBON11"), mbons = [...arrays.mbon];
const test = (odor) => {
  let m11 = 0, all = 0;
  for (let r = 0; r < 3; r++) {
    brain.run(500); brain.setRates(odor, 20);
    const c = new Uint16Array(meta.n); brain.run(1000, c); brain.setRates(odor, 0);
    m11 += hz(c, mbon11, 1000) / 3; all += hz(c, mbons, 1000) * mbons.length / 3;
  }
  return [m11, all];
};
const [a0, A0] = test(A), [b0, B0] = test(B);
brain.setRates(ofType("PPL101"), 30); brain.setRates(A, 20); brain.run(10000); brain.setRates(ofType("PPL101"), 0); brain.setRates(A, 0);
const mem = brain.memory();
const [a1, A1] = test(A), [b1, B1] = test(B);
console.log(`learning: ${mem.weak} of ${mem.of} KC->MBON synapses weakened; MBON11 to A ${a0.toFixed(1)} -> ${a1.toFixed(1)} Hz, to B ${b0.toFixed(1)} -> ${b1.toFixed(1)} Hz; all MBONs A ${A0.toFixed(0)} -> ${A1.toFixed(0)}, B ${B0.toFixed(0)} -> ${B1.toFixed(0)}`);
