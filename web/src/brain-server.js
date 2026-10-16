// Loads the connectome and runs the spiking brain. Used inside a Web Worker
// (brain-worker.js) or, if workers are unavailable, on the main thread.
import { Brain, decodeConnectome } from "./brain-engine.js";
import { loadPng, streamPngInto } from "./pngdata.js";

const MAX_EVENTS = 60000;

export function createBrainServer(post) {
  let brain = null, meta = null, counts = null, lastInputs = "", base = "";

  async function load(b) {
    base = b;
    meta = await (await fetch(base + "brain.json")).json();
    const total = meta.png_bytes;
    const size = meta.sections.reduce((a, b) => a + b, 0);
    let bytes = new Uint8Array(size);
    // One part at a time (small local servers stall on parallel large files), each
    // streamed straight into place, retried if it stalls.
    let done = 0, offset = 0;
    for (const [k, c] of meta.chunks.entries()) {
      for (let attempt = 1; ; attempt++) {
        let got = 0;
        const stage = `Downloading connectome (part ${k + 1} of ${meta.chunks.length}${attempt > 1 ? `, retry ${attempt - 1}` : ""})`;
        post({ type: "progress", stage, loaded: done, total });
        try {
          await streamPngInto(base + c.file, bytes, offset, c.bytes, (n) => {
            got += n;
            post({ type: "progress", stage, loaded: done + got, total });
          });
          done += c.png_bytes;
          break;
        } catch (e) {
          if (attempt >= 4) throw new Error(`${e.message} after ${attempt} tries. Check that web/assets/${c.file} is on the server.`);
        }
      }
      offset += c.bytes;
    }
    post({ type: "progress", stage: "Decoding 23 million connections", loaded: total, total });
    const net = decodeConnectome(bytes, meta.n, meta.edges);
    bytes = null;
    brain = new Brain(net, meta.params, (Math.random() * 2 ** 31) | 0);
    counts = new Uint16Array(meta.n);
    typeIds = new Uint16Array((await loadPng(base + "brain-type.png", meta.n * 2)).buffer);
    post({ type: "ready", n: meta.n, edges: meta.edges });
  }

  let typeIds = null;
  const typeIdx = new Map();
  function neuronsOfType(id) {
    if (!typeIdx.has(id)) {
      const idx = [];
      for (let i = 0; i < typeIds.length; i++) if (typeIds[i] === id) idx.push(i);
      typeIdx.set(id, idx);
    }
    return typeIdx.get(id);
  }

  // Firing rates = spontaneous background (if on) + every active stimulus.
  function setInputs(inp) {
    const key = JSON.stringify(inp);
    if (key === lastInputs) return;
    lastInputs = key;
    const G = meta.groups, r = brain.rate;
    r.fill(0);
    if (inp.spontaneous) {
      const { idx, hz } = G.background;
      for (let k = 0; k < idx.length; k++) r[idx[k]] = hz[k];
    }
    const add = (idx, hz) => { if (hz > 0) for (const i of idx) r[i] += hz; };
    add(G.odor[inp.odor].L, inp.odorL);
    add(G.odor[inp.odor].R, inp.odorR);
    add(G.loom.L, inp.loomL);
    add(G.loom.R, inp.loomR);
    add(G.taste, inp.taste);
    add(G.wind.L, inp.windL || 0);
    add(G.wind.R, inp.windR || 0);
    if (inp.touch) add(G.touch[inp.touch.zone][inp.touch.side], inp.touch.hz);
    if (inp.opto && typeIds) for (const ty of inp.opto.types || [inp.opto.type]) add(neuronsOfType(ty), inp.opto.hz);
    if (typeIds) for (const e of inp.extra || []) add(neuronsOfType(e.type), e.hz); // weather on the antennae
    brain._dirty = true;
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
    const memory = brain.detOn ? brain.memory() : null;
    post({ type: "result", t: brain.timeMs, motor, events: ev, spikes, wallMs, stepping: brain.nActive, memory }, [ev.buffer]);
  }

  // Detailed model: load its wiring the first time, then switch.
  let detailLoad = null;
  async function setDetailed(on) {
    if (on && !brain.det) {
      const D = meta.detailed;
      if (!D) throw new Error("brain.json has no detailed model (run web/tools/export_detailed.py)");
      detailLoad ??= loadPng(base + D.file, D.ints * 4).then((bytes) => {
        const all = new Int32Array(bytes.buffer, bytes.byteOffset, D.ints);
        const arrays = Object.fromEntries(Object.entries(D.layout).map(([k, [o, n]]) => [k, all.subarray(o, o + n)]));
        brain.setDetailed(true, arrays, D.params);
      });
      await detailLoad;
    }
    brain.setDetailed(on);
    post({ type: "model", detailed: brain.detOn });
  }

  return (msg) => {
    if (msg.type === "init") load(msg.base).catch((e) => post({ type: "error", message: String(e) }));
    else if (msg.type === "run") run(msg);
    else if (msg.type === "reset") { brain.reset(); lastInputs = ""; }
    else if (msg.type === "detailed") setDetailed(msg.on).catch((e) => post({ type: "error", message: String(e) }));
  };
}
