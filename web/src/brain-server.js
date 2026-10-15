// Loads the connectome and runs the spiking brain. Used inside a Web Worker
// (brain-worker.js) or, if workers are unavailable, on the main thread.
import { Brain, decodeConnectome } from "./brain-engine.js";
import { loadPng } from "./pngdata.js";

const MAX_EVENTS = 60000;

export function createBrainServer(post) {
  let brain = null, meta = null, counts = null, lastInputs = "";

  async function load(base) {
    meta = await (await fetch(base + "brain.json")).json();
    let loaded = 0;
    const total = meta.png_bytes;
    const size = meta.sections.reduce((a, b) => a + b, 0);
    const bytes = new Uint8Array(size);
    const progress = (n) => {
      loaded += n;
      post({ type: "progress", stage: "Downloading connectome", loaded, total });
    };
    // Fetch the parts in parallel; each is a PNG holding a slice of the stream.
    const parts = await Promise.all(meta.chunks.map((c) => loadPng(base + c.file, c.bytes, progress)));
    let off = 0;
    for (const p of parts) { bytes.set(p, off); off += p.length; }
    post({ type: "progress", stage: "Decoding 23 million connections", loaded: total, total });
    const net = decodeConnectome(bytes, meta.n, meta.edges);
    brain = new Brain(net, meta.params, (Math.random() * 2 ** 31) | 0);
    counts = new Uint16Array(meta.n);
    post({ type: "ready", n: meta.n, edges: meta.edges, groups: meta.groups });
  }

  function setInputs(inp) {
    const key = JSON.stringify(inp);
    if (key === lastInputs) return;
    lastInputs = key;
    const G = meta.groups;
    brain.clearRates();
    const set = (idx, hz) => hz > 0 && brain.setRates(idx, hz);
    set(G.odor[inp.odor].L, inp.odorL);
    set(G.odor[inp.odor].R, inp.odorR);
    set(G.loom.L, inp.loomL);
    set(G.loom.R, inp.loomR);
    set(G.taste, inp.taste);
  }

  function run({ ms, inputs }) {
    setInputs(inputs);
    counts.fill(0);
    const events = new Int32Array(MAX_EVENTS);
    const t0 = performance.now();
    const nEv = brain.run(ms, counts, events);
    const wallMs = performance.now() - t0;
    const motor = {};
    for (const [g, sides] of Object.entries(meta.groups.motor)) {
      motor[g] = {};
      for (const s of ["L", "R"]) {
        const idx = sides[s];
        let c = 0;
        for (const i of idx) c += counts[i];
        motor[g][s] = idx.length ? c / idx.length / (ms / 1000) : 0;
      }
    }
    let spikes = 0;
    for (let i = 0; i < counts.length; i++) spikes += counts[i];
    const ev = events.slice(0, nEv);
    post({ type: "result", t: brain.timeMs, motor, events: ev, spikes, wallMs, stepping: brain.nActive }, [ev.buffer]);
  }

  return (msg) => {
    if (msg.type === "init") load(msg.base).catch((e) => post({ type: "error", message: String(e) }));
    else if (msg.type === "run") run(msg);
    else if (msg.type === "reset") { brain.reset(); lastInputs = ""; }
  };
}
