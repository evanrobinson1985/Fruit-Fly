// Feed the Fly, game mode of the website (index.html?game; the phone app opens this). The
// same 3D fly, grass arena and 165,122-neuron brain, with the fly kept as a pet: it gets
// hungry and tired over hours (pet.js, also while the app is closed), sleeps at night, eats
// the sugar you give it when its taste neurons drive MN9, flees and grooms on its own, and
// leaves droppings that you clean up. Science panels stay one tap away ("Lab").
import { Pet, isNight, nightFraction, askName } from "./pet.js";

const BITE_PER_S = 6;        // satiety points per second of drinking (as in the watch game)
const DROP_AMOUNT = 30;      // satiety points in one sugar drop
const MAX_DROPS = 3;
const DIGEST_AWAY_MAX = 6;   // droppings that can pile up while the app was closed

const CSS = `
  #game { position: fixed; inset: 0; pointer-events: none; z-index: 5; font-family: var(--body); }
  #game > * { pointer-events: auto; }
  #game .g-top { position: absolute; left: 0; right: 0; top: 0; padding: max(10px, env(safe-area-inset-top)) 14px 10px;
    background: linear-gradient(rgba(10, 9, 8, 0.78), rgba(10, 9, 8, 0)); display: flex; flex-direction: column; gap: 8px; }
  #game .g-title { display: flex; align-items: baseline; gap: 10px; }
  #game .g-title b { font-family: var(--display); font-style: italic; font-weight: 500; font-size: 26px; }
  #game .g-title span { color: var(--muted); font-size: 13px; }
  #game .g-bars { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  #game .g-bar { font-size: 12px; color: var(--ink); }
  #game .g-bar i { display: block; height: 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.15); margin-top: 4px; overflow: hidden; }
  #game .g-bar i::after { content: ""; display: block; height: 100%; width: var(--v); background: var(--c); transition: width 0.4s; }
  #game .g-bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 14px max(14px, env(safe-area-inset-bottom));
    display: grid; grid-template-columns: 1.3fr 1fr 1fr 0.8fr; gap: 10px;
    background: linear-gradient(rgba(10, 9, 8, 0), rgba(10, 9, 8, 0.78)); }
  #game button { font: 600 16px var(--body); height: 54px; border-radius: 16px; border: 1px solid var(--line);
    background: rgba(40, 34, 28, 0.85); color: var(--ink); }
  #game button.feed { background: var(--cuticle); color: #2a1c0a; border: 0; }
  #game button:active { transform: scale(0.97); }
  #game .g-toast { position: absolute; left: 50%; top: 120px; transform: translateX(-50%); padding: 6px 14px; border-radius: 14px;
    background: rgba(32, 26, 20, 0.85); font-size: 15px; transition: opacity 0.3s; pointer-events: none; }
  #game .g-sleep { position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); color: var(--muted); font-size: 14px; pointer-events: none; }
  #game .g-title b { cursor: pointer; }
`;

export function startGame(api) {
  const { body, world } = api;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement("div");
  root.id = "game";
  root.innerHTML = `
    <div class="g-top">
      <div class="g-title"><b id="g-name" role="button" title="Rename"></b><span id="g-info"></span></div>
      <div class="g-bars">
        <div class="g-bar" style="--c:var(--cuticle)">Food <span id="g-food"></span><i id="g-food-bar"></i></div>
        <div class="g-bar" style="--c:#7fb6e8">Energy <span id="g-energy"></span><i id="g-energy-bar"></i></div>
        <div class="g-bar" style="--c:#e88fa8">Mood <span id="g-mood"></span><i id="g-mood-bar"></i></div>
      </div>
    </div>
    <div class="g-toast" id="g-toast" style="opacity:0"></div>
    <div class="g-sleep" id="g-sleep" hidden></div>
    <div class="g-bottom">
      <button class="feed" id="g-feed">Feed</button>
      <button id="g-tickle">Tickle</button>
      <button id="g-clean">Clean</button>
      <button id="g-lab">Lab</button>
    </div>`;
  document.body.append(root);
  document.body.classList.add("game-lab-hidden");
  const $ = (id) => document.getElementById(id);
  const showName = () => {
    $("g-name").textContent = pet.name;
    $("g-sleep").textContent = `Night: ${pet.name} is asleep until 7:00`;
  };

  let toastTimer = 0;
  const toast = (text, s = 2) => {
    $("g-toast").textContent = text;
    $("g-toast").style.opacity = 1;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("g-toast").style.opacity = 0), s * 1000);
  };

  // ---------- the pet, brought up to date ----------
  const pet = Pet.load();
  const now = Date.now();
  const away = now - pet.updatedAt;
  pet.advance(now, nightFraction(pet.updatedAt, now));
  for (const [x, y, z] of pet.droppings) api.addDeposit(x, y, z, false);
  // Food eaten before the app closed has since passed through: droppings wait in the arena.
  if (away > 120_000) {
    let n = Math.min(DIGEST_AWAY_MAX, Math.floor(pet.gut / 1.5));
    pet.gut -= n * 1.5;
    while (n-- > 0) {
      const a = Math.random() * 2 * Math.PI, r = 3 + Math.random() * 12;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      api.addDeposit(x, y, api.groundZ(x, y));
    }
  }
  body.gut = pet.gut;
  showName();
  // Named on the welcome card (pet.js), maybe while this was loading, or renamed later.
  addEventListener("fly-named", (e) => {
    Object.assign(pet, { name: e.detail, named: true });
    showName();
    save();
    toast(`Hello, ${pet.name}!`, 2.5);
  });
  $("g-name").onclick = () => askName({ current: pet.name, first: false });
  if (away > 3_600_000 && pet.named) toast(pet.satiety < 30 ? `${pet.name} is hungry!` : "Welcome back", 3);

  const save = () => {
    pet.gut = (body.gut || 0) + (body.rectum || 0);
    pet.droppings = world.deposits.map((d) => [+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(3)]);
    pet.updatedAt = Date.now();
    pet.save();
  };
  setInterval(save, 5000);
  addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => document.hidden && save());

  // ---------- buttons ----------
  function dropAt(x, y) {
    wake();
    const drops = world.food.filter((f) => f.game);
    if (drops.length >= MAX_DROPS) api.removeFood(drops[0]);
    const f = api.addFood(x, y, 1.3);
    Object.assign(f, { game: true, amount: DROP_AMOUNT });
  }
  // Feed: a sugar drop a few mm ahead of the fly, where it can find it.
  $("g-feed").onclick = () => {
    const h = (body.heading * Math.PI) / 180, d = 3 + Math.random() * 3, side = (Math.random() - 0.5) * 3;
    dropAt(body.x + d * Math.cos(h) - side * Math.sin(h), body.y + d * Math.sin(h) + side * Math.cos(h));
  };
  $("g-tickle").onclick = () => { wake(); api.touchHead(); toast("Tickle!", 1.2); };
  $("g-clean").onclick = () => {
    wake();
    const n = world.deposits.length;
    if (!n) return toast("Nothing to clean");
    api.clearDeposits();
    pet.cleans++;
    pet.mood = Math.min(100, pet.mood + Math.min(15, 2 * n));
    toast(n === 1 ? "Cleaned up 1 dropping" : `Cleaned up ${n} droppings`);
    save();
  };
  $("g-lab").onclick = () => {
    const hidden = document.body.classList.toggle("game-lab-hidden");
    $("g-lab").textContent = hidden ? "Lab" : "Pet";
  };

  // ---------- each brain step ----------
  // At night it sleeps; feeding, tickling or cleaning wakes it for a couple of minutes.
  let wokeUntil = 0;
  function wake() {
    if (isNight() && Date.now() > wokeUntil) toast(`${pet.name} wakes up`);
    wokeUntil = Date.now() + 120_000;
  }
  const asleep = () => isNight() && !pet.weak && Date.now() > wokeUntil;
  let wasFeeding = false, wasEscape = false, tasting = 0, refused = null;
  const escapes = [];
  function step(dt) {
    // A hungry pet heads for the nearest sugar drop (see world.js: lure).
    const near = world.food.filter((f) => f.game && f.amount > 0 && f !== refused)
      .sort((a, b) => Math.hypot(a.x - body.x, a.y - body.y) - Math.hypot(b.x - body.x, b.y - body.y))[0];
    const dist = near ? Math.hypot(near.x - body.x, near.y - body.y) : 0;
    const onIt = near && dist < near.r * 0.8;
    body.lure = !near || pet.satiety >= 95 ? null
      : onIt ? (tasting < 3 ? { hold: true } : null)    // taste for a moment; a full fly then wanders off
      : { x: near.x, y: near.y, speed: pet.weak ? 2 : 4 + pet.energy / 25 };
    // Drinking from a sugar drop empties it and fills the pet.
    const under = world.food.find((f) => f.game && (body.x - f.x) ** 2 + (body.y - f.y) ** 2 < f.r * f.r);
    if (body.feeding && under) {
      const bite = Math.min(under.amount, BITE_PER_S * dt);
      under.amount -= bite;
      pet.ate(bite);
      under.mesh.scale.setScalar(0.4 + 0.6 * under.amount / DROP_AMOUNT);
      under.mesh.scale.y *= 0.18;
      if (under.amount <= 0) { api.removeFood(under); toast("Yum!"); }
    }
    if (body.feeding && !wasFeeding) pet.feedings++;
    wasFeeding = body.feeding;
    // Standing on sugar without its taste neurons driving MN9: a full fly walks away.
    if (under && !body.feeding) {
      tasting += dt;
      if (tasting > 2.5 && refused !== under) { refused = under; toast("Not hungry"); }
    } else tasting = 0;
    // Escapes: occasional ones are exercise, constant chasing is stress.
    const esc = body.state === "escape";
    if (esc && !wasEscape) {
      const t = Date.now();
      escapes.push(t);
      while (escapes.length && escapes[0] < t - 60_000) escapes.shift();
      pet.escaped(escapes.length);
      toast(escapes.length > 2 ? "Leave me alone!" : "Whoosh!", 1.5);
    }
    wasEscape = esc;
    // Droppings left lying around sour its mood.
    pet.mood = Math.max(0, pet.mood - 0.0005 * world.deposits.length * dt);
  }

  // Wall-clock upkeep and the panel, once a second.
  function tick() {
    pet.advance(Date.now(), asleep() ? 1 : 0);
    const s = (k, v) => { $(`g-${k}`).textContent = Math.round(v); $(`g-${k}-bar`).style.setProperty("--v", `${v}%`); };
    s("food", pet.satiety); s("energy", pet.energy); s("mood", pet.mood);
    $("g-info").textContent = `day ${pet.ageDays()} · ${pet.feedings} meals · ${pet.escapes} escapes`;
    const n = world.deposits.length;
    $("g-clean").textContent = n ? `Clean (${n})` : "Clean";
    const night = asleep();
    $("g-sleep").hidden = !night;
    api.canvas.style.filter = night ? "brightness(0.45) saturate(0.75)" : "";
  }
  setInterval(tick, 1000);
  tick();

  return {
    step,
    dropAt,
    asleep,
    /** Taste-neuron drive scales with hunger: starved flies' sugar neurons respond more. */
    tasteGain: () => Math.min(1, 0.12 + 1.1 * pet.hunger ** 1.2),
    onDeposit: () => { toast("Plop!", 1.2); save(); },
    pet,
  };
}
