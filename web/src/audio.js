// Sound, synthesized with Web Audio from what the simulation is doing (no recordings).
//
// - Flight: the wingbeat tone of a fruit fly (~200-220 Hz fundamental with harmonics), louder
//   the closer the camera, rising a little with wing power (DNg02).
// - Courtship song: D. melanogaster pulse song, short ~220 Hz pulses about every 35 ms
//   (Bennet-Clark & Ewing 1969), whenever pIP10/pMP2 make the fly sing.
// - Grooming: soft rubbing at the legs' rub rate.
// - Weather: rain hiss with plinks of drops landing near the camera, a hushed snowy wind,
//   and a whoosh for gusts and for a looming threat.
// Browsers only allow sound after a click or key press, so it starts on the first one.

const WINGBEAT_HZ = 210;
const PULSE_IPI_S = 0.035;

export class FlyAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.8;
    this.lastDrop = 0;
  }

  // Create the audio graph (call from a user gesture).
  start() {
    if (this.ctx || !this.enabled) { this.ctx?.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    // White noise, shared by rain, wind, grooming and whooshes.
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noise;
    const loopNoise = () => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.start(); return s; };

    // Wingbeat: a sawtooth (rich in harmonics, like the thorax's clicks) with slow jitter.
    this.wing = ctx.createOscillator();
    this.wing.type = "sawtooth";
    this.wing.frequency.value = WINGBEAT_HZ;
    const wobble = ctx.createOscillator(), wobbleGain = ctx.createGain();
    wobble.frequency.value = 3.1;
    wobbleGain.gain.value = 4;
    wobble.connect(wobbleGain).connect(this.wing.frequency);
    const wingLp = ctx.createBiquadFilter();
    wingLp.type = "lowpass";
    wingLp.frequency.value = 2400;
    this.wingGain = ctx.createGain();
    this.wingGain.gain.value = 0;
    this.wing.connect(wingLp).connect(this.wingGain).connect(this.master);
    this.wing.start();
    wobble.start();

    // Pulse song: one pulse (two cycles at 220 Hz in a Gaussian envelope) per 35 ms, looped.
    const n = Math.round(ctx.sampleRate * PULSE_IPI_S);
    const pulse = ctx.createBuffer(1, n, ctx.sampleRate);
    const p = pulse.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate - 0.006;
      p[i] = Math.sin(2 * Math.PI * 220 * t) * Math.exp(-((t / 0.0035) ** 2));
    }
    const song = ctx.createBufferSource();
    song.buffer = pulse;
    song.loop = true;
    this.songGain = ctx.createGain();
    this.songGain.gain.value = 0;
    song.connect(this.songGain).connect(this.master);
    song.start();

    // Grooming: band-passed noise, gated at the rub rate in update().
    const groomBp = ctx.createBiquadFilter();
    groomBp.type = "bandpass";
    groomBp.frequency.value = 3200;
    groomBp.Q.value = 1.2;
    this.groomGain = ctx.createGain();
    this.groomGain.gain.value = 0;
    loopNoise().connect(groomBp).connect(this.groomGain).connect(this.master);

    // Rain hiss and snowy wind.
    const rainHp = ctx.createBiquadFilter(), rainLp = ctx.createBiquadFilter();
    rainHp.type = "highpass"; rainHp.frequency.value = 400;
    rainLp.type = "lowpass"; rainLp.frequency.value = 5000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    loopNoise().connect(rainHp).connect(rainLp).connect(this.rainGain).connect(this.master);
    const windLp = ctx.createBiquadFilter();
    windLp.type = "lowpass"; windLp.frequency.value = 380;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    loopNoise().connect(windLp).connect(this.windGain).connect(this.master);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    if (on) this.ctx.resume(); else this.ctx.suspend();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /**
   * Per frame. s: { wing (0..1), power (Hz of DNg02), song (0..1), groom (0..1), groomPhase,
   * dist (camera to fly, mm), rain (0..4 or -1), snow (0..4 or -1) }
   */
  update(s) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    // A fly's buzz is loud at a few mm and fades with distance (mostly near-field sound).
    const near = Math.min(1, 12 / Math.max(3, s.dist));
    this.wingGain.gain.setTargetAtTime(0.16 * s.wing * near, now, 0.03);
    this.wing.frequency.setTargetAtTime(WINGBEAT_HZ * (1 + Math.min(0.25, 0.005 * (s.power || 0))), now, 0.1);
    this.songGain.gain.setTargetAtTime(0.5 * s.song * near, now, 0.03);
    const rub = 0.5 + 0.5 * Math.sin(s.groomPhase || 0);
    this.groomGain.gain.setTargetAtTime(0.05 * s.groom * rub * near, now, 0.01);
    this.rainGain.gain.setTargetAtTime(s.rain >= 0 ? 0.02 + 0.025 * s.rain : 0, now, 0.4);
    this.windGain.gain.setTargetAtTime(s.snow >= 0 ? 0.05 + 0.03 * s.snow : 0, now, 0.6);
  }

  // A raindrop landing `dist` mm from the camera: a short plink, deeper for bigger drops.
  drop(D, dist) {
    if (!this.ctx || this.ctx.state !== "running" || dist > 60) return;
    const now = this.ctx.currentTime;
    if (now - this.lastDrop < 0.03) return; // at most ~30 a second
    this.lastDrop = now;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    const f = 2600 / Math.max(0.6, D);
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 0.45, now + 0.06);
    const a = Math.min(0.25, (0.05 + 0.06 * D) * Math.min(1, 15 / Math.max(5, dist)));
    g.gain.setValueAtTime(a, now);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.08);
    o.connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.1);
  }

  // A gust or an approaching object: noise swept through a band-pass.
  whoosh(seconds = 1.2, loud = 0.2) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    bp.type = "bandpass"; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(300, now);
    bp.frequency.exponentialRampToValueAtTime(1400, now + seconds * 0.7);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(loud, now + seconds * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    src.connect(bp).connect(g).connect(this.master);
    src.start(now);
    src.stop(now + seconds + 0.05);
  }
}
