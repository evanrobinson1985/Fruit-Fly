// Live charts of motor-neuron rates and a dorsal map of all 165k neurons that flashes on spikes.

const CLASS_COLORS = {
  ol_intrinsic: [70, 110, 160], ol_sensory: [70, 140, 170], visual_projection: [90, 150, 200],
  visual_centrifugal: [90, 130, 190], cb_intrinsic: [150, 110, 170], cb_sensory: [80, 170, 120],
  cb_motor: [210, 120, 90], descending_neuron: [230, 150, 80], ascending_neuron: [200, 170, 90],
  vnc_intrinsic: [130, 120, 160], vnc_sensory: [80, 160, 120], vnc_motor: [210, 110, 90],
};

export class BrainMap {
  constructor(canvas, pos, cls, classes, range) {
    this.canvas = canvas;
    const W = (canvas.width = 260), H = (canvas.height = 340);
    this.ctx = canvas.getContext("2d");
    this.n = cls.length;
    this.pix = new Int32Array(this.n);
    this.heat = new Float32Array(W * H);
    this.base = new Uint8ClampedArray(W * H * 4);
    // Dorsal view: lateral x across, anterior-posterior z down (brain on top, VNC below).
    const [lo, hi] = range;
    const sx = hi[0] - lo[0], sz = hi[2] - lo[2];
    const s = Math.min((W - 10) / sx, (H - 10) / sz);
    const ox = (W - sx * s) / 2, oz = (H - sz * s) / 2;
    const density = new Float32Array(W * H);
    const col = new Float32Array(W * H * 3);
    for (let i = 0; i < this.n; i++) {
      const x = lo[0] + (pos[3 * i] / 65535) * sx, z = lo[2] + (pos[3 * i + 2] / 65535) * sz;
      const px = Math.min(W - 1, Math.max(0, Math.round(ox + (x - lo[0]) * s)));
      const py = Math.min(H - 1, Math.max(0, Math.round(oz + (z - lo[2]) * s)));
      const p = py * W + px;
      this.pix[i] = p;
      density[p]++;
      const c = CLASS_COLORS[classes[cls[i]]] || [120, 120, 120];
      col[3 * p] += c[0]; col[3 * p + 1] += c[1]; col[3 * p + 2] += c[2];
    }
    for (let p = 0; p < W * H; p++) {
      const d = density[p];
      if (!d) continue;
      const a = Math.min(1, 0.25 + Math.log1p(d) / 5);
      for (let k = 0; k < 3; k++) this.base[4 * p + k] = (col[3 * p + k] / d) * a * 0.55;
      this.base[4 * p + 3] = 255;
    }
    this.img = this.ctx.createImageData(W, H);
  }

  spikes(events) {
    for (let k = 0; k < events.length; k++) this.heat[this.pix[events[k]]] += 1;
  }

  draw() {
    const d = this.img.data, b = this.base, h = this.heat;
    for (let p = 0; p < h.length; p++) {
      const v = Math.min(1, h[p] * 0.25);
      h[p] *= 0.75;
      d[4 * p] = b[4 * p] + v * 255;
      d[4 * p + 1] = b[4 * p + 1] + v * 230;
      d[4 * p + 2] = b[4 * p + 2] + v * 120;
      d[4 * p + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}

export class Chart {
  constructor(canvas, series, { max = 100, seconds = 8 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.series = series; // [{key, label, color}]
    this.data = series.map(() => []);
    this.max = max;
    this.seconds = seconds;
  }
  push(t, values) {
    this.series.forEach((s, k) => {
      this.data[k].push([t, values[s.key]]);
      while (this.data[k].length && this.data[k][0][0] < t - this.seconds) this.data[k].shift();
    });
    this.t = t;
  }
  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const top = Math.max(this.max, ...this.data.flat().map((d) => d[1] || 0));
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    for (let k = 1; k < 4; k++) { ctx.moveTo(0, (H * k) / 4); ctx.lineTo(W, (H * k) / 4); }
    ctx.stroke();
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(`${Math.round(top)} Hz`, 4, 11);
    this.series.forEach((s, k) => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.data[k].forEach(([t, v], i) => {
        const x = W - ((this.t - t) / this.seconds) * W, y = H - (v / top) * (H - 14);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
  }
}
