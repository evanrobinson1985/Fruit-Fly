// Arena, senses and body kinematics: a port of flysim/body.py and flysim/interface.py.
// Units: mm, s, degrees. +x east, +y north, heading counter-clockwise from +x.

export const SENSE = {
  ornMaxHz: 80, ornHalf: 0.3,      // ORN rate = max * c / (c + half)
  grnHz: 80,                        // taste neurons while standing on food
  loomMaxHz: 150, loomRef: 1000,    // LC4/LPLC2 rate = max * (1 - exp(-expansion / ref))
};

export const BODY = {
  maxSpeed: 30,                     // mm/s
  // Walking from the leg motor-neuron pools (ventral nerve cord), smoothed over 200 ms.
  legRestHz: 1.5,                   // leg pool rate below which the fly stands still
  legGain: 6,                       // mm/s per Hz of leg pool rate above rest
  fwdGain: 0.25,                    // mm/s per Hz of P9 (DNp09)
  backHz: 30, backGain: 0.4,        // MDN above 30 Hz walks the fly backward
  turnGain: 25,                     // deg/s per Hz of DNa01/02 left-right difference
  legTurnGain: 150,                 // deg/s per Hz of leg pool left-right difference
  exploreTurnSd: 40,                // deg/s of unexplained turning noise
  // Without spontaneous activity the brain is silent at rest, so a stand-in walk is used.
  baseSpeed: 5, quietTurnSd: 120,
  // Escape: the Giant Fiber. Its real synapse onto the jump motor neuron is electrical
  // and absent from the connectome, so takeoff reads the Giant Fiber itself: above
  // 250 Hz at once (looming drives it past 320 Hz), or above 80 Hz for 160 ms (as when
  // it is driven by light). In a minute of spontaneous activity neither happened.
  escapeHz: 250, escapeSustainHz: 80, escapeSustainS: 0.16,
  // Voluntary flight: indirect flight-muscle motor neurons (DLMn, DVMn) above 15 Hz for
  // 160 ms take off; below 6 Hz the fly lands. About 5 times a minute at rest in tests.
  flightOnHz: 15, flightOnS: 0.16, flightOffHz: 6, flightMinS: 0.6, flightMaxS: 5,
  wingSteerGain: 8,                 // deg/s per Hz of left-right wing motor-neuron difference
  feedHz: 20,                       // MN9 -> proboscis extension
  feedBout: 1.0,                    // s of feeding started by one proboscis extension
  escapeTime: 0.45, flightSpeed: 120, // escape flight (s, mm/s)
  stride: 1.6,                      // mm per step cycle at full amplitude
};

export class World {
  constructor() {
    this.radius = 100; // circular arena
    this.odors = [];   // {x, y, strength, sigma, kind}
    this.food = [];    // {x, y, r}
    this.looms = [];   // {t0, azimuth, radius, speed, d0, onsetHeading, x0, y0}
  }
  conc(x, y, kind) {
    let c = 0;
    for (const o of this.odors) {
      if (o.kind !== kind) continue;
      const d2 = (x - o.x) ** 2 + (y - o.y) ** 2;
      c += o.strength * Math.exp(-d2 / (2 * o.sigma * o.sigma));
    }
    return c;
  }
  onFood(x, y) {
    return this.food.some((f) => (x - f.x) ** 2 + (y - f.y) ** 2 < f.r * f.r);
  }
  // Angular size (deg) and expansion rate (deg/s) of a looming disc at time t, or null.
  loomState(lo, t) {
    if (t < lo.t0) return null;
    const d = lo.d0 - lo.speed * (t - lo.t0);
    if (d <= lo.radius) return null;
    return {
      d,
      theta: 2 * Math.atan(lo.radius / d) * 180 / Math.PI,
      dtheta: 2 * (lo.radius * lo.speed / (d * d + lo.radius * lo.radius)) * 180 / Math.PI,
    };
  }
}

function gauss(rng) {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Body {
  constructor() {
    this.reset();
  }
  reset(x = 0, y = 0, heading = 90) {
    Object.assign(this, {
      x, y, heading, z: 0, speed: 0, turn: 0, airborne: 0, feeding: false, boutLeft: 0,
      foodEaten: 0, phase: 0, ampL: 0, ampR: 0, wingOpen: 0, proboscis: 0,
      state: "walking", threatDir: null,
    });
  }

  antennae() {
    const h = this.heading * Math.PI / 180;
    const fx = this.x + 1.2 * Math.cos(h), fy = this.y + 1.2 * Math.sin(h);
    const lx = -Math.sin(h), ly = Math.cos(h), s = 0.2;
    return { L: [fx + s * lx, fy + s * ly], R: [fx - s * lx, fy - s * ly] };
  }

  // World -> sensory firing rates (Hz).
  sense(world, t, odorKind) {
    const a = this.antennae();
    const odor = { L: world.conc(...a.L, odorKind), R: world.conc(...a.R, odorKind) };
    const loom = { L: 0, R: 0 };
    for (const lo of world.looms) {
      const st = world.loomState(lo, t);
      if (!st) continue;
      let az = (lo.worldAz - this.heading) % 360;
      az = ((az + 540) % 360) - 180;
      if (az > -20) loom.L += st.dtheta; // each eye sees its side plus ~20 deg frontal overlap
      if (az < 20) loom.R += st.dtheta;
    }
    // Tarsi touch the food only when the fly is on the ground, not up on a leaf.
    const taste = this.z === 0 && (this.perch || 0) < 0.8 && world.onFood(this.x, this.y);
    const orn = (c) => SENSE.ornMaxHz * c / (c + SENSE.ornHalf);
    const lc = (e) => SENSE.loomMaxHz * (1 - Math.exp(-e / SENSE.loomRef));
    return {
      odor, loom, taste,
      rates: { odorL: orn(odor.L), odorR: orn(odor.R), loomL: lc(loom.L), loomR: lc(loom.R), taste: taste ? SENSE.grnHz : 0 },
    };
  }

  // Advance dt seconds with motor-group rates m[group][side] (Hz, 60 ms smoothing).
  // `spontaneous` says whether the brain has background activity to act on.
  act(m, dt, world, rng, spontaneous = true) {
    const mean = (g) => (m[g] ? (m[g].L + m[g].R) / 2 : 0);
    const k200 = Math.min(1, dt / 0.2);
    const sm = (this.slow ??= { legsL: 0, legsR: 0, flight: 0, wingL: 0, wingR: 0 });
    sm.legsL += k200 * ((m.legs?.L || 0) - sm.legsL);
    sm.legsR += k200 * ((m.legs?.R || 0) - sm.legsR);
    sm.flight += k200 * (mean("flight") - sm.flight);
    sm.wingL += k200 * ((m.wing?.L || 0) - sm.wingL);
    sm.wingR += k200 * ((m.wing?.R || 0) - sm.wingR);
    const gf = Math.max(m.escape.L, m.escape.R);

    if (this.airborne > 0) return this._fly(m, dt, world, sm);
    this.wingOpen = Math.max(0, this.wingOpen - dt * 6);
    this.gfOn = gf > BODY.escapeSustainHz ? (this.gfOn || 0) + dt : 0;
    if (gf > BODY.escapeHz || this.gfOn >= BODY.escapeSustainS) {
      this.gfOn = 0;
      // Escape takeoff directed away from the threat (Card & Dickinson 2008).
      this.heading = this.threatDir !== null ? this.threatDir + 180 : this.heading + 180 * (rng() - 0.5);
      return this._takeoff("escape", BODY.escapeTime);
    }
    // Voluntary takeoff when the flight-muscle motor neurons stay active.
    this.flightOn = sm.flight > BODY.flightOnHz ? (this.flightOn || 0) + dt : 0;
    if (this.flightOn >= BODY.flightOnS) {
      this.heading += 120 * (rng() - 0.5);
      return this._takeoff("voluntary", BODY.flightMaxS);
    }
    const onFood = world.onFood(this.x, this.y) && (this.perch || 0) < 0.8;
    if (onFood && Math.max(m.feed.L, m.feed.R) > BODY.feedHz) this.boutLeft = BODY.feedBout;
    this.boutLeft = onFood ? Math.max(0, this.boutLeft - dt) : 0;
    this.feeding = this.boutLeft > 0;
    const pTarget = this.feeding ? 1 : Math.min(1, Math.max(m.feed.L, m.feed.R) / BODY.feedHz);
    this.proboscis += (pTarget - this.proboscis) * Math.min(1, dt / 0.08);
    if (this.feeding) {
      this.speed = 0;
      this.foodEaten += dt;
      this._gait(dt, 0);
      return (this.state = "feeding");
    }
    // Walking: leg motor-neuron pools set vigor and turning; P9 adds, MDN reverses.
    const legs = (sm.legsL + sm.legsR) / 2;
    const back = Math.max(0, mean("backward") - BODY.backHz);
    const walk = spontaneous ? BODY.legGain * Math.max(0, legs - BODY.legRestHz) : BODY.baseSpeed;
    const target = Math.min(BODY.maxSpeed, Math.max(-10, walk + BODY.fwdGain * mean("forward") - BODY.backGain * back));
    this.speed += (target - this.speed) * Math.min(1, dt / 0.1);
    const noise = spontaneous ? BODY.exploreTurnSd : BODY.quietTurnSd;
    const cmd = BODY.turnGain * (m.turn.L - m.turn.R) + BODY.legTurnGain * (sm.legsL - sm.legsR);
    this.turn = (Math.abs(this.speed) > 0.3 ? cmd : cmd * 0.3) + noise * gauss(rng);
    this.heading = (this.heading + this.turn * dt + 360) % 360;
    const h = this.heading * Math.PI / 180;
    this.x += this.speed * Math.cos(h) * dt;
    this.y += this.speed * Math.sin(h) * dt;
    this._clip(world);
    this._gait(dt, this.turn);
    return (this.state = target < -0.3 ? "backing" : Math.abs(this.speed) > 0.3 ? "walking" : "standing");
  }

  _takeoff(kind, duration) {
    this.flightKind = kind;
    this.airborne = duration;
    this.airTime = 0;
    this.flightOn = 0;
    this.feeding = false;
    this.boutLeft = 0;
    return (this.state = kind === "escape" ? "escape" : "takeoff");
  }

  _fly(m, dt, world, sm) {
    this.airborne -= dt;
    this.airTime += dt;
    this.wingOpen = Math.min(1, this.wingOpen + dt * 20);
    if (this.flightKind === "voluntary") {
      // Stay up while the flight-muscle motor neurons keep firing; steer with the wing pools.
      if (this.airTime > BODY.flightMinS && sm.flight < BODY.flightOffHz) this.airborne = Math.min(this.airborne, 0.35);
      this.heading = (this.heading + BODY.wingSteerGain * (sm.wingL - sm.wingR) * dt + 360) % 360;
    }
    const h = this.heading * Math.PI / 180;
    this.x += Math.cos(h) * BODY.flightSpeed * dt;
    this.y += Math.sin(h) * BODY.flightSpeed * dt;
    const up = Math.min(1, this.airTime / 0.25), down = Math.min(1, Math.max(0, this.airborne) / 0.3);
    this.z = (this.flightKind === "escape" ? 7 : 12) * Math.min(up, down);
    if (this.airborne <= 0) { this.z = 0; this.airborne = 0; }
    this._clip(world);
    return (this.state = "flying");
  }

  // Tripod gait: stepping frequency from speed, per-side stride from turning.
  _gait(dt, turn) {
    const v = this.speed;
    const amp = Math.min(1.2, Math.max(0, Math.abs(v) / 12 + Math.min(0.5, Math.abs(turn) / 400)));
    const bias = Math.max(-0.8, Math.min(0.8, turn / 300)); // left turn -> shorter left strides
    const targetL = amp * (1 - bias), targetR = amp * (1 + bias);
    const k = Math.min(1, dt / 0.15);
    this.ampL += (targetL - this.ampL) * k;
    this.ampR += (targetR - this.ampR) * k;
    const freq = amp > 0.05 ? Math.min(16, Math.max(3, Math.abs(v) / (BODY.stride * Math.max(0.3, amp)) + Math.abs(turn) / 120)) : 0;
    this.phase += Math.sign(v || 1) * 2 * Math.PI * freq * dt;
  }

  _clip(world) {
    const r = Math.hypot(this.x, this.y);
    if (r > world.radius - 2) {
      this.x *= (world.radius - 2) / r;
      this.y *= (world.radius - 2) / r;
      this.heading = (Math.atan2(-this.y, -this.x) * 180 / Math.PI + 360) % 360; // turn back inward
    }
  }
}
