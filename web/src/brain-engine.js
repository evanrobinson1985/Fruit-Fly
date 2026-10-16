// Leaky integrate-and-fire network over the connectome: a port of flysim/model.py
// (Shiu et al. 2024 neuron model + short-term depression + spike-frequency
// adaptation, "realistic" preset).
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
//
// The optional "detailed" model (setDetailed; flysim.model.make_detailed) adds:
// octopamine as a slow, capped depolarizing drive m on its targets (dv gets + m),
// dopamine-gated depression of the mushroom body's KC -> MBON synapses, and the
// Giant Fiber's electrical synapses onto TTMn and PSI (a voltage step 0.8 ms later).

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
    // Adaptation: each spike adds `adapt` mV of hyperpolarizing drive a, decaying with tau_adapt.
    this.bAd = p.adapt || 0;
    this.tauA = p.tau_adapt || 200;
    this.decayA = Math.exp(-p.dt / this.tauA);
    this.cFac = this.tauA / (this.tauA - p.tau_m);
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
    this.expA = Float64Array.from({ length: K }, (_, k) => Math.exp((-k * p.dt) / this.tauA));
    this.rate = new Float64Array(this.n);
    this.seed = seed >>> 0 || 1;
    this.det = null;     // detailed-model wiring, once loaded
    this.detOn = false;
    this.reset();
  }

  /**
   * Turn the detailed model on (passing its wiring the first time: int32 arrays from
   * web/tools/export_detailed.py plus its parameters) or off (null / false).
   */
  setDetailed(on, arrays, params) {
    if (on && !this.det) this._buildDetailed(arrays, params);
    if (!on && this.detOn) {
      // Bring dormant neurons up to date before their slow drive disappears.
      for (let i = 0; i < this.n; i++) if (!this.isActive[i]) { this._catchUp(i, this.step + 1); this.tLast[i] = this.step; }
      this.det.mod.fill(0);
      this.det.vbuf.fill(0);
    }
    this.detOn = !!on && !!this.det;
  }

  _buildDetailed(A, P) {
    const n = this.n, p = this.p;
    const d = { P };
    // Octopamine outputs as a CSR over all neurons.
    d.mIndptr = new Int32Array(n + 1);
    for (let k = 0; k < A.oa.length; k++) d.mIndptr[A.oa[k] + 1] = A.oaDeg[k];
    for (let i = 0; i < n; i++) d.mIndptr[i + 1] += d.mIndptr[i];
    d.mPost = A.oaPost;
    d.mW = Float32Array.from(A.oaCount, (c) => c * P.oa_w);
    d.modMax = P.mod_max;
    d.decayM = Math.exp(-p.dt / P.tau_mod);
    d.mFac = P.tau_mod / (P.tau_mod - p.tau_m);
    const K = this.expM.length;
    d.expD = Float64Array.from({ length: K }, (_, k) => Math.exp((-k * p.dt) / P.tau_mod));
    d.mod = new Float32Array(n);
    // Mushroom body. Each MBON's dopamine: the DANs that synapse onto it, normalized.
    d.mbonOf = new Int32Array(n).fill(-1);
    A.mbon.forEach((i, k) => (d.mbonOf[i] = k));
    d.nMbon = A.mbon.length;
    const tot = new Float64Array(d.nMbon);
    for (let k = 0; k < A.da.length; k++) tot[d.mbonOf[A.daMbon[k]]] += A.daCount[k];
    d.dIndptr = new Int32Array(n + 1);
    for (const j of A.da) d.dIndptr[j + 1]++;
    for (let i = 0; i < n; i++) d.dIndptr[i + 1] += d.dIndptr[i];
    d.dPost = new Int32Array(A.da.length);
    d.dW = new Float32Array(A.da.length);
    const fill = d.dIndptr.slice(0, n);
    for (let k = 0; k < A.da.length; k++) {
      const e = fill[A.da[k]]++, m = d.mbonOf[A.daMbon[k]];
      d.dPost[e] = m;
      d.dW[e] = A.daCount[k] / tot[m];
    }
    d.dm = new Float32Array(d.nMbon);
    d.dmStep = new Int32Array(d.nMbon);
    // Each KC's KC -> MBON synapses, in row order, index into f.
    d.kcStart = new Int32Array(n).fill(-1);
    let P_ = 0;
    for (const j of A.kc) {
      let c = 0;
      for (let e = this.indptr[j]; e < this.indptr[j + 1]; e++) if (d.mbonOf[this.post[e]] >= 0) c++;
      if (c) { d.kcStart[j] = P_; P_ += c; }
    }
    d.f = new Float32Array(P_).fill(1);
    d.fStep = new Int32Array(P_);
    d.eta = P.mb_eta;
    d.dtDan = p.dt / P.tau_dan;
    d.dtMem = p.dt / (P.tau_mem * 1000);
    // Giant Fiber electrical synapses.
    d.gapT = [...new Set(A.gapPost)];
    d.gapLocal = new Int32Array(n).fill(-1);
    d.gapT.forEach((i, k) => (d.gapLocal[i] = k));
    d.gIndptr = new Int32Array(n + 1);
    for (const j of A.gapPre) d.gIndptr[j + 1]++;
    for (let i = 0; i < n; i++) d.gIndptr[i + 1] += d.gIndptr[i];
    d.gPost = new Int32Array(A.gapPost.length);
    const gfill = d.gIndptr.slice(0, n);
    for (let k = 0; k < A.gapPre.length; k++) d.gPost[gfill[A.gapPre[k]]++] = A.gapPost[k];
    d.gapV = P.gap_v;
    d.DG = Math.max(1, Math.round(P.gap_delay / p.dt));
    d.vbuf = new Float32Array(d.DG * d.gapT.length);
    this.det = d;
  }

  /** KC -> MBON synapses now weakened by more than 10%, out of how many. */
  memory() {
    const d = this.det;
    if (!d) return null;
    let weak = 0;
    for (let k = 0; k < d.f.length; k++) if ((1 - d.f[k]) * Math.exp(-(this.step - d.fStep[k]) * d.dtMem) > 0.1) weak++;
    return { weak, of: d.f.length };
  }

  reset() {
    const n = this.n;
    this.v = new Float32Array(n).fill(this.p.v0);
    this.g = new Float32Array(n);
    this.a = new Float32Array(n);
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
    this.driveCum = new Float64Array(0);
    this.driveLambda = 0;
    this.driveExpNeg = 1;
    const d = this.det;
    if (d) { d.mod.fill(0); d.vbuf.fill(0); d.f.fill(1); d.fStep.fill(0); d.dm.fill(0); d.dmStep.fill(0); }
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

  // Number of input spikes this step ~ Poisson(driveLambda).
  _poisson() {
    const lam = this.driveLambda;
    if (lam < 30) {
      let k = 0, prod = this.random();
      while (prod > this.driveExpNeg) { k++; prod *= this.random(); }
      return k;
    }
    const z = Math.sqrt(-2 * Math.log(1 - this.random())) * Math.cos(2 * Math.PI * this.random());
    return Math.max(0, Math.round(lam + Math.sqrt(lam) * z));
  }

  setRates(idx, hz) {
    for (const i of idx) this.rate[i] = hz;
    this._dirty = true;
  }

  clearRates() {
    this.rate.fill(0);
    this._dirty = true;
  }

  // Advance dormant neuron i exactly to the end of step t-1. Without input,
  // u = v - v0 follows u(t) = A e^{-t/tm} + B e^{-t/ts} + C e^{-t/ta}, with
  // B = g0 ts/(ts - tm) and C = -a0 ta/(ta - tm).
  // With the detailed model, a slow drive m adds E = m0 tmod/(tmod - tm) e^{-t/tmod}.
  _catchUp(i, t) {
    const steps = t - 1 - this.tLast[i];
    if (steps <= 0) return;
    const d = this.detOn ? this.det : null;
    const g0 = this.g[i], u0 = this.v[i] - this.p.v0, a0 = this.a[i], m0 = d ? d.mod[i] : 0;
    if (g0 === 0 && u0 === 0 && a0 === 0 && m0 === 0) return;
    if (steps >= this.expM.length) {
      this.g[i] = 0;
      this.a[i] = 0;
      if (d) d.mod[i] = 0;
      this.v[i] = this.p.v0;
      return;
    }
    const B = g0 * this.bFac, C = -a0 * this.cFac, es = this.expS[steps], ea = this.expA[steps];
    this.g[i] = g0 * es;
    this.a[i] = a0 * ea;
    if (m0 !== 0) {
      const E = m0 * d.mFac, ed = d.expD[steps];
      d.mod[i] = m0 * ed;
      this.v[i] = this.p.v0 + (u0 - B - C - E) * this.expM[steps] + B * es + C * ea + E * ed;
    } else {
      this.v[i] = this.p.v0 + (u0 - B - C) * this.expM[steps] + B * es + C * ea;
    }
  }

  _activate(i, t) {
    if (this.isActive[i]) return;
    this._catchUp(i, t);
    this.isActive[i] = 1;
    this.active[this.nActive++] = i;
  }

  // Can a neuron with these u = v - v0 and g ever reach threshold without more input?
  // (Adaptation only pulls v down, so ignoring it keeps this an upper bound.)
  _canFire(u0, g0, m0 = 0) {
    if (u0 >= this.uTh) return true;
    if (m0 > 0) {
      // A slow drive adds at most mFac * m0: rule out firing with the bound, else stay awake.
      return (u0 > 0 ? u0 : 0) + this.kPeak * (g0 > 0 ? g0 : 0) + this.det.mFac * m0 >= this.uTh;
    }
    if (g0 <= 0) return false; // then u <= max(u0, 0)
    if ((u0 > 0 ? u0 : 0) + this.kPeak * g0 < this.uTh) return false;
    const B = g0 * this.bFac, A = u0 - B, p = this.p;
    if (A <= 0) return false;
    const r = (-B * p.tau_m) / (A * p.tau_syn);
    if (r <= 1) return false; // peak at t = 0, i.e. u0
    const ts = Math.log(r) / (1 / p.tau_syn - 1 / p.tau_m);
    return A * Math.exp(-ts / p.tau_m) + B * Math.exp(-ts / p.tau_syn) >= this.uTh;
  }

  // Slow and electrical outputs of neuron j, spiking at step t.
  _deliverDetailed(j, t) {
    const d = this.det;
    // Octopamine: raise the slow drive of each target (state brought up to step t first).
    for (let e = d.mIndptr[j], end = d.mIndptr[j + 1]; e < end; e++) {
      const i = d.mPost[e];
      if (!this.isActive[i]) { this._catchUp(i, t + 1); this.tLast[i] = t; }
      const m = d.mod[i] + d.mW[e];
      d.mod[i] = m < d.modMax ? m : d.modMax;
      if (!this.isActive[i] && this.ref[i] === 0 && this._canFire(this.v[i] - this.p.v0, this.g[i], d.mod[i])) this._activate(i, t + 1);
    }
    // Dopamine traces at the MBONs this neuron reaches.
    for (let e = d.dIndptr[j], end = d.dIndptr[j + 1]; e < end; e++) {
      const mb = d.dPost[e];
      d.dm[mb] = d.dm[mb] * Math.exp(-(t - d.dmStep[mb]) * d.dtDan) + d.dW[e];
      d.dmStep[mb] = t;
    }
    // Electrical synapses: a voltage step DG steps from now.
    if (d.gIndptr[j + 1] > d.gIndptr[j]) {
      const nT = d.gapT.length, base = (t % d.DG) * nT;
      for (let e = d.gIndptr[j], end = d.gIndptr[j + 1]; e < end; e++) d.vbuf[base + d.gapLocal[d.gPost[e]]] += d.gapV;
    }
  }

  // Advance `ms`; add spike counts into `counts` (Uint16Array) and append spiking
  // neuron indices to `events` (Int32Array) while there is room. Returns #events.
  run(ms, counts, events) {
    if (this._dirty) {
      // Poisson input: each step draws how many input spikes arrive in total, then
      // picks which neurons get them (cumulative-rate search). Same statistics as a
      // per-neuron coin flip, but cheap with thousands of background-driven neurons.
      const idx = [];
      for (let i = 0; i < this.n; i++) if (this.rate[i] > 0) idx.push(i);
      this.driveIdx = Int32Array.from(idx);
      this.driveCum = new Float64Array(idx.length);
      let acc = 0;
      idx.forEach((i, k) => { acc += this.rate[i] * this.p.dt * 1e-3; this.driveCum[k] = acc; });
      this.driveLambda = acc;
      this.driveExpNeg = Math.exp(-acc);
      this._dirty = false;
    }
    const { v, g, a: ad, ref, x, xStep, isActive, active, indptr, post, w, D } = this;
    const decayA = this.decayA, bAd = this.bAd;
    const { v0, v_reset, v_th, w_syn, stp_u } = this.p;
    const decay = this.decay, dtTau = this.dtTau, refSteps = this.refSteps, recKeep = this.recKeep;
    const kPeak = this.kPeak, uTh = this.uTh;
    const det = this.detOn ? this.det : null;
    const mod = det ? det.mod : null, decayM = det ? det.decayM : 1, mFac = det ? det.mFac : 0;
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
          const an = ad[i] * decayA;
          const mn = mod ? mod[i] * decayM : 0;
          const un = v[i] - v0 + dtTau * (gn - (v[i] - v0) - an + mn);
          if ((un > 0 ? un : 0) + kPeak * (gn > 0 ? gn : 0) + (mn > 0 ? mFac * mn : 0) < uTh) {
            g[i] = gn;
            ad[i] = an;
            if (mod) mod[i] = mn;
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
      if (this.driveIdx.length) {
        for (let m = this._poisson(); m > 0; m--) {
          const u = this.random() * this.driveLambda;
          let lo = 0, hi = this.driveCum.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (this.driveCum[mid] < u) lo = mid + 1; else hi = mid; }
          const i = this.driveIdx[lo];
          this._activate(i, t);
          g[i] += this.kick;
        }
      }
      // Electrical synapses arriving this step.
      if (det) {
        const nT = det.gapT.length, base = (t % det.DG) * nT;
        for (let k = 0; k < nT; k++) {
          const dv = det.vbuf[base + k];
          if (dv === 0) continue;
          det.vbuf[base + k] = 0;
          const i = det.gapT[k];
          this._activate(i, t);
          if (ref[i] === 0) v[i] += dv;
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
        let ai = ad[i] * decayA;
        if (ai < 1e-6) ai = 0;
        let mi = 0;
        if (mod) {
          mi = mod[i] * decayM;
          if (mi < 1e-6 && mi > -1e-6) mi = 0;
          mod[i] = mi;
        }
        if (ref[i] > 0) {
          ref[i]--;
        } else {
          let vi = v[i] + dtTau * (gi - (v[i] - v0) - ai + mi);
          if (vi > v_th) {
            vi = v_reset;
            ai += bAd;
            ref[i] = refSteps;
            this.spk[ns++] = i;
          }
          v[i] = vi;
        }
        ad[i] = ai;
        if (ref[i] === 0 && !this._canFire(v[i] - v0, gi, mi)) {
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
        if (det && det.kcStart[j] >= 0) {
          // A KC: its synapses onto MBONs recover, then depress by the local dopamine.
          let k = det.kcStart[j];
          const mbonOf = det.mbonOf, f = det.f, fStep = det.fStep, dm = det.dm, dmStep = det.dmStep;
          for (let e = indptr[j], end = indptr[j + 1]; e < end; e++) {
            const i = post[e];
            if (row[i] === 0 && nT < cap) tl[nT++] = i;
            const mb = mbonOf[i];
            if (mb >= 0) {
              let fk = 1 - (1 - f[k]) * Math.exp(-(t - fStep[k]) * det.dtMem);
              fk -= det.eta * dm[mb] * Math.exp(-(t - dmStep[mb]) * det.dtDan) * fk;
              f[k] = fk;
              fStep[k] = t;
              k++;
              row[i] += w[e] * scale * fk;
            } else {
              row[i] += w[e] * scale;
            }
          }
        } else {
          for (let e = indptr[j], end = indptr[j + 1]; e < end; e++) {
            const i = post[e];
            // First input to i in this slot: remember to wake it. (If inputs cancel to
            // exactly 0 it may be listed twice, which is harmless.)
            if (row[i] === 0 && nT < cap) tl[nT++] = i;
            row[i] += w[e] * scale;
          }
        }
        this.nTouched[slot] = nT;
        if (det) this._deliverDetailed(j, t);
      }
    }
    return nEv;
  }
}
