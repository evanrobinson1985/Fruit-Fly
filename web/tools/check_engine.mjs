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
