// Leaky integrate-and-fire network over the connectome: a port of flysim/model.py
// (Shiu et al. 2024 neuron model + short-term depression, "realistic" preset).
//
// Event-driven: a neuron is stepped only while it could reach threshold. When
// the closed-form peak of v (given its current v and g and no further input)
// stays below threshold, it goes dormant and its state is advanced exactly the
// next time input arrives. Usually only a few thousand of the 165k neurons are
// stepped. The math for stepped neurons is the same as the Python engine:
//   g <- g * exp(-dt/tau_syn) + input arriving this step
//   v <- v + dt/tau_m * (g - (v - v0))        (unless refractory)
//   spike when v > v_th; targets receive w * w_syn * x after `delay`,
//   where x is the presynaptic depression factor (x -= U*x per spike).

export function decodeVarints(bytes, count, out, start = 0) {
  let p = start;
  for (let i = 0; i < count; i++) {
    let v = 0, shift = 0, b;
    do {
      b = bytes[p++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    out[i] = v;
  }
  return p;
}

// Decode the stream written by web/tools/export_brain.py.
export function decodeConnectome(bytes, n, nEdges) {
  const deg = new Int32Array(n);
  let p = decodeVarints(bytes, n, deg);
  const post = new Int32Array(nEdges);
  p = decodeVarints(bytes, nEdges, post, p);
  const indptr = new Int32Array(n + 1);
  for (let i = 0, e = 0; i < n; i++) {
    indptr[i + 1] = indptr[i] + deg[i];
    for (let k = 1; k < deg[i]; k++) post[e + k] += post[e + k - 1];
    e += deg[i];
  }
  // Zigzag weights, decoded straight into int16 (no temporary array: phones are tight on memory).
  const w = new Int16Array(nEdges);
  for (let e = 0; e < nEdges; e++) {
    let v = 0, shift = 0, b;
    do { b = bytes[p++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    w[e] = (v >>> 1) ^ -(v & 1);
  }
  return { indptr, post, w };
}

export class Brain {
  constructor({ indptr, post, w }, params, seed = 1) {
    const p = (this.p = params);
    this.n = indptr.length - 1;
    this.indptr = indptr;
    this.post = post;
    this.w = w;
    this.D = Math.max(1, Math.round(p.delay / p.dt));
    this.refSteps = Math.round(p.t_ref / p.dt);
    this.decay = Math.exp(-p.dt / p.tau_syn);
    this.dtTau = p.dt / p.tau_m;
    this.recKeep = 1 - p.dt / p.tau_rec; // per-step fraction of depression remaining
    this.kick = p.f_poi * p.w_syn;
    // Closed-form solution for u = v - v0 without input: u(t) = A e^{-t/tm} + B e^{-t/ts},
    // B = g0 ts / (ts - tm). Dormant neurons must stay `margin` mV below threshold.
    this.bFac = p.tau_syn / (p.tau_syn - p.tau_m);
    this.uTh = p.v_th - p.v0 - 0.5;
    // Peak of u for u0 = 0, g0 = 1: since u's own decay is monotonic,
    // max(u0, 0) + kPeak * max(g0, 0) bounds u for all later times.
    const tPk = Math.log(p.tau_m / p.tau_syn) / (1 / p.tau_syn - 1 / p.tau_m);
    this.kPeak = -this.bFac * (Math.exp(-tPk / p.tau_m) - Math.exp(-tPk / p.tau_syn));
    // exp(-k dt / tau) for k steps, up to 3 s (beyond that the state is ~0).
    const K = Math.round(3000 / p.dt);
    this.expM = Float64Array.from({ length: K }, (_, k) => Math.exp((-k * p.dt) / p.tau_m));
    this.expS = Float64Array.from({ length: K }, (_, k) => Math.exp((-k * p.dt) / p.tau_syn));
    this.rate = new Float64Array(this.n);
    this.seed = seed >>> 0 || 1;
    this.reset();
  }

  reset() {
    const n = this.n;
    this.v = new Float32Array(n).fill(this.p.v0);
    this.g = new Float32Array(n);
    this.ref = new Uint8Array(n);
    this.x = new Float32Array(n).fill(1);
    this.xStep = new Int32Array(n);
    this.tLast = new Int32Array(n); // step at which a dormant neuron's v, g were last valid
    this.isActive = new Uint8Array(n);
    this.active = new Int32Array(n);
    this.nActive = 0;
    this.buf = Array.from({ length: this.D }, () => new Float32Array(n));
    this.touched = Array.from({ length: this.D }, () => new Int32Array(2 * n));
    this.nTouched = new Int32Array(this.D);
    this.spk = new Int32Array(n);
    this.step = 0;
    this.rng = this.seed;
    this.driveIdx = new Int32Array(0);
    this.driveP = new Float64Array(0);
  }

  get timeMs() {
    return this.step * this.p.dt;
  }

  random() {
    // xorshift32
    let s = this.rng;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.rng = s >>> 0;
    return this.rng / 4294967296;
  }

  setRates(idx, hz) {
    for (const i of idx) this.rate[i] = hz;
    this._dirty = true;
  }

  clearRates() {
    this.rate.fill(0);
    this._dirty = true;
  }

  // Advance dormant neuron i exactly to the end of step t-1.
  _catchUp(i, t) {
    const steps = t - 1 - this.tLast[i];
    if (steps <= 0) return;
    const g0 = this.g[i], u0 = this.v[i] - this.p.v0;
    if (g0 === 0 && u0 === 0) return;
    if (steps >= this.expM.length) {
      this.g[i] = 0;
      this.v[i] = this.p.v0;
      return;
    }
    const B = g0 * this.bFac, es = this.expS[steps];
    this.g[i] = g0 * es;
    this.v[i] = this.p.v0 + (u0 - B) * this.expM[steps] + B * es;
  }

  _activate(i, t) {
    if (this.isActive[i]) return;
    this._catchUp(i, t);
    this.isActive[i] = 1;
    this.active[this.nActive++] = i;
  }

  // Can a neuron with these u = v - v0 and g ever reach threshold without more input?
  _canFire(u0, g0) {
    if (u0 >= this.uTh) return true;
    if (g0 <= 0) return false; // then u <= max(u0, 0)
    if ((u0 > 0 ? u0 : 0) + this.kPeak * g0 < this.uTh) return false;
    const B = g0 * this.bFac, A = u0 - B, p = this.p;
    if (A <= 0) return false;
    const r = (-B * p.tau_m) / (A * p.tau_syn);
    if (r <= 1) return false; // peak at t = 0, i.e. u0
    const ts = Math.log(r) / (1 / p.tau_syn - 1 / p.tau_m);
    return A * Math.exp(-ts / p.tau_m) + B * Math.exp(-ts / p.tau_syn) >= this.uTh;
  }

  // Advance `ms`; add spike counts into `counts` (Uint16Array) and append spiking
  // neuron indices to `events` (Int32Array) while there is room. Returns #events.
  run(ms, counts, events) {
    if (this._dirty) {
      const idx = [];
      for (let i = 0; i < this.n; i++) if (this.rate[i] > 0) idx.push(i);
      this.driveIdx = Int32Array.from(idx);
      this.driveP = Float64Array.from(idx, (i) => this.rate[i] * this.p.dt * 1e-3);
      this._dirty = false;
    }
    const { v, g, ref, x, xStep, isActive, active, indptr, post, w, D } = this;
    const { v0, v_reset, v_th, w_syn, stp_u } = this.p;
    const decay = this.decay, dtTau = this.dtTau, refSteps = this.refSteps, recKeep = this.recKeep;
    const kPeak = this.kPeak, uTh = this.uTh;
    const steps = Math.round(ms / this.p.dt);
    let nEv = 0;
    for (let s = 0; s < steps; s++) {
      const t = this.step++;
      const slot = t % D;
      const row = this.buf[slot], tl = this.touched[slot], cap = tl.length;
      // Neurons receiving input this step. Most inputs are too small to matter:
      // apply this step's update in place and leave the neuron dormant.
      for (let k = 0, m = this.nTouched[slot]; k < m; k++) {
        const i = tl[k];
        if (isActive[i] || row[i] === 0) continue;
        this._catchUp(i, t);
        if (ref[i] === 0) {
          const gn = g[i] * decay + row[i];
          const un = v[i] - v0 + dtTau * (gn - (v[i] - v0));
          if ((un > 0 ? un : 0) + kPeak * (gn > 0 ? gn : 0) < uTh) {
            g[i] = gn;
            v[i] = v0 + un;
            row[i] = 0;
            this.tLast[i] = t;
            continue;
          }
        }
        this.tLast[i] = t - 1;
        this._activate(i, t);
      }
      this.nTouched[slot] = 0;
      for (let k = 0; k < this.driveIdx.length; k++) {
        if (this.random() < this.driveP[k]) {
          const i = this.driveIdx[k];
          this._activate(i, t);
          g[i] += this.kick;
        }
      }
      // Update active neurons; compact the list as neurons return to rest.
      let ns = 0, keep = 0;
      for (let k = 0, m = this.nActive; k < m; k++) {
        const i = active[k];
        let gi = g[i] * decay + row[i];
        row[i] = 0;
        if (gi < 1e-6 && gi > -1e-6) gi = 0;
        g[i] = gi;
        if (ref[i] > 0) {
          ref[i]--;
        } else {
          let vi = v[i] + dtTau * (gi - (v[i] - v0));
          if (vi > v_th) {
            vi = v_reset;
            ref[i] = refSteps;
            this.spk[ns++] = i;
          }
          v[i] = vi;
        }
        if (ref[i] === 0 && !this._canFire(v[i] - v0, gi)) {
          isActive[i] = 0;
          this.tLast[i] = t;
        } else {
          active[keep++] = i;
        }
      }
      this.nActive = keep;
      // Deliver spikes into the slot just consumed; it is read again D steps later.
      for (let a = 0; a < ns; a++) {
        const j = this.spk[a];
        if (counts) counts[j]++;
        if (events && nEv < events.length) events[nEv++] = j;
        let xj = x[j];
        if (xj < 1) xj = 1 - (1 - xj) * recKeep ** (t - xStep[j]);
        const scale = w_syn * xj;
        let nT = this.nTouched[slot];
        x[j] = xj - stp_u * xj;
        xStep[j] = t;
        for (let e = indptr[j], end = indptr[j + 1]; e < end; e++) {
          const i = post[e];
          // First input to i in this slot: remember to wake it. (If inputs cancel to
          // exactly 0 it may be listed twice, which is harmless.)
          if (row[i] === 0 && nT < cap) tl[nT++] = i;
          row[i] += w[e] * scale;
        }
        this.nTouched[slot] = nT;
      }
    }
    return nEv;
  }
}
