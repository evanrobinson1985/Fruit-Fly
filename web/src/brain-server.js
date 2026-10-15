// Loads the connectome and runs the spiking brain. Used inside a Web Worker
// (brain-worker.js) or, if workers are unavailable, on the main thread.
import { Brain, decodeConnectome } from "./brain-engine.js";
import { streamPngInto } from "./pngdata.js";

const MAX_EVENTS = 60000;

export function createBrainServer(post) {
  let brain = null, meta = null, counts = null, lastInputs = "";

  async function load(base) {
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
