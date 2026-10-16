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
      name: "Dot", named: false, satiety: 70, energy: 80, mood: 60, bornAt: now, updatedAt: now,
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

// ---------- naming ----------
const SUGGESTIONS = ["Dot", "Buzz", "Pip", "Zippy", "Fig", "Mango", "Pepper", "Bean", "Nibs", "Skeeter",
  "Kiwi", "Plum", "Sprout", "Speck", "Banana", "Juniper", "Hopper", "Pickle", "Comet", "Maple"];
export const suggestName = (not) => {
  const pool = SUGGESTIONS.filter((n) => n !== not);
  return pool[Math.floor(Math.random() * pool.length)];
};
export const MAX_NAME = 16;

const NAME_CSS = `
  #name-card, #name-card * { box-sizing: border-box; }
  #name-card { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: rgba(8, 7, 6, 0.8); font-family: var(--body); }
  #name-card form { width: 100%; max-width: 380px; background: #1b1713; border: 1px solid var(--line); border-radius: 18px;
    padding: 24px 20px 20px; display: flex; flex-direction: column; gap: 14px; color: var(--ink); }
  #name-card h2 { margin: 0; font: italic 500 30px var(--display); }
  #name-card p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.45; }
  #name-card .row { display: flex; gap: 8px; }
  #name-card #name-dice { flex: none; width: 54px; padding: 0; font-size: 22px; }
  #name-card input { flex: 1; min-width: 0; font: 600 20px var(--body); color: var(--ink); background: rgba(255, 240, 220, 0.06);
    border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  #name-card input:focus { outline: 2px solid var(--cuticle); outline-offset: 1px; }
  #name-card button { font: 600 16px var(--body); border-radius: 12px; padding: 0 14px; height: 50px; color: var(--ink);
    background: rgba(255, 240, 220, 0.06); border: 1px solid var(--line); cursor: pointer; text-align: center; }
  #name-card button[type=submit] { background: var(--cuticle); color: #2a1c0a; border: 0; }
`;

/**
 * Ask for the fly's name (first start, or renaming). Resolves with the name, saves it with
 * the pet and announces it as a "fly-named" event for the running game.
 */
export function askName({ current = "", first = true } = {}) {
  return new Promise((resolve) => {
    if (!document.getElementById("name-css")) {
      const style = document.createElement("style");
      style.id = "name-css";
      style.textContent = NAME_CSS;
      document.head.append(style);
    }
    const card = document.createElement("div");
    card.id = "name-card";
    card.innerHTML = `
      <form autocomplete="off">
        <h2></h2>
        <p></p>
        <div class="row"><input id="name-input" maxlength="${MAX_NAME}" enterkeyhint="done" aria-label="Your fly's name">
          <button type="button" id="name-dice" aria-label="Suggest a name">🎲</button></div>
        <button type="submit"></button>
      </form>`;
    const $ = (sel) => card.querySelector(sel);
    $("h2").textContent = first ? "Meet your fly" : "Rename your fly";
    $("p").textContent = first
      ? "A fruit fly has just hatched, with a brain wired like a real one. It's yours to look after: what will you call it?"
      : "A new name for your fly:";
    $("button[type=submit]").textContent = first ? "Hello, fly!" : "Save";
    const input = $("input");
    input.value = current;
    input.placeholder = suggestName();
    $("#name-dice").onclick = () => { input.value = suggestName(input.value); input.focus(); };
    card.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      const name = (input.value.trim() || input.placeholder).slice(0, MAX_NAME);
      const pet = Pet.load();
      Object.assign(pet, { name, named: true });
      pet.save();
      card.remove();
      dispatchEvent(new CustomEvent("fly-named", { detail: name }));
      resolve(name);
    };
    document.body.append(card);
    setTimeout(() => input.focus(), 50);
  });
}

/** On a pet's first start, ask for its name (right away, while the fly and brain load). */
export function nameOnFirstStart() {
  const pet = Pet.load();
  if (!pet.named) { pet.save(); askName(); } // save fixes its birth time now
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
