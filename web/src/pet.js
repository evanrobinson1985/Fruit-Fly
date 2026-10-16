// The pet's long-term state for game mode (a port of watch/brain/.../game/Pet.kt).
// Values are 0..100. Time passes while the app is closed: advance() applies the elapsed
// wall-clock time on every start. Saved in localStorage.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SATIETY_PER_HOUR = 8;       // full to empty in ~12 h awake
const ENERGY_AWAKE_PER_HOUR = 5;
const ENERGY_SLEEP_PER_HOUR = 12;
const KEY = "fly-pet";
const clamp = (v) => Math.max(0, Math.min(100, v));

export class Pet {
  constructor(o = {}) {
    const now = Date.now();
    Object.assign(this, {
      name: "Dot", satiety: 70, energy: 80, mood: 60, bornAt: now, updatedAt: now,
      feedings: 0, escapes: 0, cleans: 0,
      gut: 0,          // food still in the gut, in seconds of drinking (world.js BODY.depositUnit per droplet)
      droppings: [],   // [x, y, z] left in the arena
    }, o);
  }

  get hunger() { return 1 - this.satiety / 100; }
  get weak() { return this.satiety <= 0.5; }
  ageDays(now = Date.now()) { return Math.floor((now - this.bornAt) / DAY_MS) + 1; }

  /** Apply elapsed time; asleepFraction is the share of it spent asleep (at night). */
  advance(now, asleepFraction) {
    const h = Math.max(0, now - this.updatedAt) / HOUR_MS;
    this.updatedAt = now;
    if (h <= 0) return;
    this.satiety = clamp(this.satiety - h * SATIETY_PER_HOUR * (1 - 0.5 * asleepFraction)); // metabolism slows in sleep
    this.energy = clamp(this.energy - h * (1 - asleepFraction) * ENERGY_AWAKE_PER_HOUR + h * asleepFraction * ENERGY_SLEEP_PER_HOUR);
    const target = 60 - (this.satiety < 25 ? 30 : 0) - (this.energy < 20 ? 15 : 0);
    this.mood = clamp(this.mood + (target - this.mood) * Math.min(1, h / 6));
  }

  ate(amount) {
    this.satiety = clamp(this.satiety + amount);
    this.mood = clamp(this.mood + amount * 0.4);
  }

  /** An escape flight: exercise if occasional, stress if the fly keeps getting chased. */
  escaped(recent) {
    this.escapes++;
    this.energy = clamp(this.energy - 2);
    this.mood = clamp(this.mood + (recent <= 2 ? 2 : -6));
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this)); } catch {}
  }

  static load() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || "null");
      if (o) return new Pet(o);
    } catch {}
    return new Pet();
  }
}

/** Flies sleep mostly at night: 22:00 to 07:00 local time. */
export function isNight(d = new Date()) {
  const h = d.getHours();
  return h >= 22 || h < 7;
}

/** Share of [from, to] that fell at night, sampled every 15 minutes. */
export function nightFraction(from, to) {
  if (to <= from) return 0;
  let night = 0, total = 0;
  for (let t = from; t < to; t += 15 * 60_000) { if (isNight(new Date(t))) night++; total++; }
  return night / total;
}
