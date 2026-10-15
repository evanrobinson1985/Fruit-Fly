// Closed loop in the browser: world -> sensory neurons -> connectome (Web Worker) ->
// descending neurons -> FlyBody 3D body.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadFly } from "./fly.js";
import { World, Body } from "./world.js";
import { BrainMap, Chart } from "./hud.js";
import { loadPng } from "./pngdata.js";
import { Terrain } from "./terrain.js";

const ASSETS = new URL("../assets/", import.meta.url).href;
const STEP_MS = 20;         // brain/body exchange interval
const SMOOTH_MS = 60;       // motor rate smoothing
const $ = (id) => document.getElementById(id);

// ---------- renderer & scene (Z up, mm) ----------
const canvas = $("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0c0a);
scene.fog = new THREE.Fog(0x0d0c0a, 60, 260);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 1000);
camera.up.set(0, 0, 1);
camera.position.set(-9, -9, 6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 3;
controls.maxDistance = 320;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xfff3e0, 0x302820, 0.7));
const sun = new THREE.DirectionalLight(0xfff0dd, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// Arena floor: filter paper in a petri dish.
function paperTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#cfc6b6";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 180 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v - 8},${v - 20},0.25)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 2, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(30, 30);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const world = new World();
const floor = new THREE.Mesh(new THREE.CircleGeometry(world.radius, 128),
  new THREE.MeshStandardMaterial({ map: paperTexture(), color: 0xb9b0a2, roughness: 0.95 }));
floor.receiveShadow = true;
scene.add(floor);
const WALL = 50; // mm, height of the glass arena wall
const rim = new THREE.Mesh(new THREE.CylinderGeometry(world.radius + 1, world.radius + 1, WALL, 128, 1, true),
  // Plain transparent glass: a transmission material would render the whole scene twice.
  new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
rim.rotation.x = Math.PI / 2;
rim.position.z = WALL / 2;
scene.add(rim);

// Optional outdoor floor: grass and small weeds (off by default; see the floor switch).
const terrain = new Terrain(scene, world.radius);
terrain.visible = false;
function syncExclusions() {
  terrain.setExclusions([
    ...world.food.map((f) => ({ x: f.x, y: f.y, r: f.r + 0.5 })),
    ...world.odors.map((o) => ({ x: o.x, y: o.y, r: 2 })),
  ]);
}
function setFloor(grass) {
  terrain.visible = grass;
  floor.visible = !grass;
  $("floor-grass").setAttribute("aria-pressed", grass);
  $("floor-lab").setAttribute("aria-pressed", !grass);
  try { localStorage.setItem("floor", grass ? "grass" : "lab"); } catch {}
}

// Odor clouds are drawn as glowing discs on the floor; food as glossy drops.
const odorGroup = new THREE.Group(), foodGroup = new THREE.Group(), loomGroup = new THREE.Group();
scene.add(odorGroup, foodGroup, loomGroup);
const ODOR_COLORS = { vinegar: 0xe9b949, co2: 0x7fb6e8, geosmin: 0x9bc48a };
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(255,255,255,0.9)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.35)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
const glow = glowTexture();
function addOdor(x, y, kind) {
  const o = { x, y, strength: 1, sigma: 22, kind };
  world.odors.push(o);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(o.sigma * 5, o.sigma * 5),
    new THREE.MeshBasicMaterial({ map: glow, color: ODOR_COLORS[kind], transparent: true, opacity: 0.5, depthWrite: false }));
  m.position.set(x, y, 0.02);
  odorGroup.add(m);
  syncExclusions();
  const src = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 1.5, 24), new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.4 }));
  src.rotation.x = Math.PI / 2;
  src.position.set(x, y, 0.75);
  src.castShadow = true;
  odorGroup.add(src);
}
function addFood(x, y, r = 4) {
  world.food.push({ x, y, r });
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0xd9c27a, roughness: 0.15, transmission: 0.35, thickness: 2, clearcoat: 1 }));
  m.rotation.x = Math.PI / 2;
  m.scale.set(1, 0.18, 1); // a flat drop of sugary food
  m.position.set(x, y, 0);
  m.receiveShadow = true;
  foodGroup.add(m);
  syncExclusions();
}

// ---------- fly ----------
const body = new Body();
let fly, flyRoot;
const prev = { x: 0, y: 0, z: 0, heading: 90, phase: 0 }, curr = { ...prev };
let tPrev = 0, tCurr = 0;

// ---------- HUD ----------
const MOTOR = [
  { key: "legs", label: "Leg MNs", color: "#f2d29b" },
  { key: "flight", label: "Flight MNs", color: "#f28f6b" },
  { key: "forward", label: "P9 forward", color: "#e0a160" },
  { key: "backward", label: "MDN backward", color: "#b48ef0" },
  { key: "turnL", label: "DNa L", color: "#7fc4e8" },
  { key: "turnR", label: "DNa R", color: "#4f8fc0" },
  { key: "escape", label: "Giant Fiber", color: "#e5533d" },
  { key: "feed", label: "MN9", color: "#8fc77a" },
];
const SENSE_SERIES = [
  { key: "odorL", label: "ORN L", color: "#e9b949" },
  { key: "odorR", label: "ORN R", color: "#b3862a" },
  { key: "loom", label: "LC4/LPLC2", color: "#e5533d" },
  { key: "taste", label: "Taste", color: "#8fc77a" },
  { key: "touch", label: "Touch", color: "#c9a7e8" },
  { key: "wind", label: "Wind", color: "#7fc4e8" },
  { key: "opto", label: "Light", color: "#ff6f8f" },
];
const motorChart = new Chart($("chart-motor"), MOTOR, { max: 60 });
const senseChart = new Chart($("chart-sense"), SENSE_SERIES, { max: 80 });
for (const [el, series] of [["legend-motor", MOTOR], ["legend-sense", SENSE_SERIES]]) {
  $(el).innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
}
let brainMap = null;

// ---------- brain host ----------
let send, brainReady = false, pending = false, paused = false;
const smooth = {}; // motor group -> {L, R} rates, filled from the first brain result
let lastSense = null, wallStart = 0, simAtStart = 0, spikesRate = 0, stepping = 0, brainWall = 0;

function onBrain(msg) {
  if (msg.type === "progress") {
    $("load-stage").textContent = msg.stage;
    $("load-bar").style.width = `${(100 * msg.loaded) / msg.total}%`;
    $("load-note").textContent = `${(msg.loaded / 1e6).toFixed(1)} of ${(msg.total / 1e6).toFixed(1)} MB, downloaded once per visit`;
  } else if (msg.type === "ready") {
    brainReady = true;
    $("loading").hidden = true;
    $("st-state").textContent = "walking";
    wallStart = performance.now();
    simAtStart = 0;
    step();
  } else if (msg.type === "error") {
    $("load-stage").textContent = "Could not load the connectome";
    $("load-note").textContent = msg.message;
  } else if (msg.type === "result") {
    pending = false;
    brainWall = brainWall * 0.9 + msg.wallMs * 0.1;
    spikesRate = msg.spikes / (STEP_MS / 1000);
    stepping = msg.stepping;
    if (brainMap) brainMap.spikes(msg.events);
    const a = Math.min(1, STEP_MS / SMOOTH_MS);
    for (const [g, v] of Object.entries(msg.motor)) {
      smooth[g] ??= { L: 0, R: 0 };
      for (const s of ["L", "R"]) smooth[g][s] += a * (v[s] - smooth[g][s]);
    }
    advanceBody(msg.t / 1000);
  }
}

async function startBrain() {
  try {
    const w = new Worker(new URL("./brain-worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => onBrain(e.data);
    w.onerror = (e) => onBrain({ type: "error", message: e.message || "worker failed" });
    send = (m) => w.postMessage(m);
  } catch (e) {
    // Fallback: run the brain on the page's own thread.
    const { createBrainServer } = await import("./brain-server.js");
    const handle = createBrainServer((m) => setTimeout(() => onBrain(m)));
    send = (m) => setTimeout(() => handle(m));
  }
  send({ type: "init", base: ASSETS });
}

// Short-lived stimuli from the user: touch, wind, light.
const stim = { touch: null, touchUntil: 0, windL: 0, windR: 0, windUntil: 0, opto: null };

function sensoryInputs(t) {
  lastSense = body.sense(world, t, $("odor-kind").value);
  const inputs = { odor: $("odor-kind").value, spontaneous: $("spont").checked, ...lastSense.rates };
  if (t < stim.touchUntil) inputs.touch = stim.touch;
  if (t < stim.windUntil) { inputs.windL = stim.windL; inputs.windR = stim.windR; }
  if (stim.opto) inputs.opto = stim.opto;
  lastSense.extra = { touch: inputs.touch?.hz || 0, wind: Math.max(inputs.windL || 0, inputs.windR || 0), opto: stim.opto?.hz || 0 };
  return inputs;
}

function step() {
  if (!brainReady || pending || paused) return;
  // Pace to real time; if the brain is slower than real time, run as fast as it can.
  const simNow = curr.t || 0;
  const target = simAtStart + (performance.now() - wallStart) / 1000;
  if (simNow > target + 0.03) return;
  pending = true;
  send({ type: "run", ms: STEP_MS, inputs: sensoryInputs(simNow) });
}

const rng = Math.random;
function advanceBody(t) {
  const dt = STEP_MS / 1000;
  for (const lo of world.looms) if (lo.t0 <= t && body.threatDir === null) body.threatDir = lo.worldAz;
  body.act(smooth, dt, world, rng, $("spont").checked);
  Object.assign(prev, curr);
  Object.assign(curr, { x: body.x, y: body.y, z: body.z, heading: body.heading, phase: body.phase, t });
  tPrev = tCurr;
  tCurr = performance.now();
  const m = smooth;
  motorChart.push(t, {
    legs: (m.legs.L + m.legs.R) / 2, flight: (m.flight.L + m.flight.R) / 2,
    forward: (m.forward.L + m.forward.R) / 2, backward: (m.backward.L + m.backward.R) / 2,
    turnL: m.turn.L, turnR: m.turn.R, escape: Math.max(m.escape.L, m.escape.R), feed: Math.max(m.feed.L, m.feed.R),
  });
  if (lastSense) {
    const r = lastSense.rates;
    senseChart.push(t, { odorL: r.odorL, odorR: r.odorR, loom: Math.max(r.loomL, r.loomR), taste: r.taste, ...lastSense.extra });
  }
  // Retire looms that have arrived.
  world.looms = world.looms.filter((lo) => world.loomState(lo, t) || t < lo.t0);
  if (!world.looms.length) body.threatDir = null;
  step();
}

// ---------- interaction ----------
let tool = "food";
const TOOLS = ["food", "odor", "poke", "wind"];
const TOOL_HINT = {
  food: "Click the floor to drop sugar.",
  odor: "Click the floor to place an odor source.",
  poke: "Click part of the fly: its touch neurons there fire.",
  wind: "Click the floor: a gust blows from there toward the fly.",
};
for (const k of TOOLS) {
  $(`tool-${k}`).onclick = () => {
    tool = k;
    for (const t of TOOLS) $(`tool-${t}`).setAttribute("aria-pressed", t === k);
    $("hint").textContent = TOOL_HINT[k];
  };
}

// Which mechanosensory group a poke on a FlyBody segment reaches.
function touchZone(bodyName) {
  if (/head|antenna|rostrum|haustellum|labrum|eye/.test(bodyName)) return "head";
  if (/abdomen/.test(bodyName)) return "abdomen";
  if (/^[lr][fmh]_/.test(bodyName)) return "legs";
  return "thorax"; // thorax, wings, halteres
}

function poke(e) {
  if (!fly) return false;
  const hit = ray.intersectObject(fly.root, true)[0];
  if (!hit) return false;
  const k = fly.nodes.indexOf(hit.object.parent);
  const name = k >= 0 ? fly.bodies[k].name : "c_thorax";
  const zone = touchZone(name);
  const local = fly.root.worldToLocal(hit.point.clone());
  const side = /^[lr]/.test(name) && !name.startsWith("c_") ? name[0].toUpperCase() : local.y >= 0 ? "L" : "R";
  stim.touch = { zone, side, hz: 120 };
  stim.touchUntil = (curr.t || 0) + 0.3;
  $("hint").textContent = `Touched the ${side === "L" ? "left" : "right"} ${zone}: ${zone} touch neurons fire for 0.3 s.`;
  return true;
}

function blow(point) {
  // A 2.5 s gust from `point` toward the fly. Johnston's organ on the windward side fires more.
  const az = ((Math.atan2(point.y - body.y, point.x - body.x) * 180) / Math.PI - body.heading + 540) % 360 - 180;
  const near = 60, far = 25, s = Math.sin((az * Math.PI) / 180);
  stim.windL = far + (near - far) * Math.max(0, s) + (near - far) * 0.5 * (1 - Math.abs(s));
  stim.windR = far + (near - far) * Math.max(0, -s) + (near - far) * 0.5 * (1 - Math.abs(s));
  stim.windUntil = (curr.t || 0) + 2.5;
  showGust(point);
  $("hint").textContent = `Wind from the ${Math.abs(az) < 45 ? "front" : Math.abs(az) > 135 ? "back" : az > 0 ? "left" : "right"}: antennal wind neurons fire for 2.5 s.`;
}

const gustGroup = new THREE.Group();
scene.add(gustGroup);
function showGust(from) {
  gustGroup.clear();
  const to = new THREE.Vector3(body.x, body.y, 1.5), start = new THREE.Vector3(from.x, from.y, 1.5);
  const dir = to.clone().sub(start);
  const len = dir.length();
  for (let i = 0; i < 7; i++) {
    const off = new THREE.Vector3(-dir.y, dir.x, 0).normalize().multiplyScalar((i - 3) * 1.6);
    const arrow = new THREE.ArrowHelper(dir.clone().normalize(), start.clone().add(off).setZ(1 + (i % 3)), len * 0.85, 0x9fd3ea, 2, 1);
    arrow.line.material.transparent = arrow.cone.material.transparent = true;
    gustGroup.add(arrow);
  }
  gustGroup.userData.until = performance.now() + 2500;
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (tool === "poke") {
    if (!poke(e)) $("hint").textContent = "Missed. Zoom in and click on the fly itself.";
    return;
  }
  const hit = ray.intersectObject(terrain.visible ? terrain.floor : floor)[0];
  if (!hit) return;
  if (tool === "wind") return blow(hit.point);
  if (tool === "food") addFood(hit.point.x, hit.point.y);
  else addOdor(hit.point.x, hit.point.y, $("odor-kind").value);
  $("hint").textContent = tool === "food" ? "Food placed. The fly tastes it when it walks onto it." : "Odor placed. Its receptor neurons fire with concentration at each antenna.";
});
const loomMesh = () => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(5, 32, 16), new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.6 }));
  m.castShadow = true;
  return m;
};
$("loom").onclick = () => {
  if (!brainReady) return;
  const az = (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 80);
  const t0 = (curr.t || 0) + 0.05;
  const lo = { t0, azimuth: az, worldAz: body.heading + az, radius: 5, speed: 500, d0: 300, x0: body.x, y0: body.y, mesh: loomMesh() };
  loomGroup.add(lo.mesh);
  world.looms.push(lo);
  $("hint").textContent = `A dark disc approaches from ${az > 0 ? "the left" : "the right"} at 0.5 m/s.`;
};
$("pause").onclick = () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
  $("pause").setAttribute("aria-pressed", paused);
  if (!paused) { wallStart = performance.now(); simAtStart = curr.t || 0; step(); }
};
$("clear").onclick = () => {
  world.odors = []; world.food = [];
  odorGroup.clear(); foodGroup.clear();
  syncExclusions();
};
$("floor-lab").onclick = () => setFloor(false);
$("floor-grass").onclick = () => setFloor(true);
let closeUp = true;
$("cam").onclick = () => {
  closeUp = !closeUp;
  $("cam").textContent = closeUp ? "Close-up" : "Arena view";
  const d = closeUp ? 14 : 160;
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, d);
};

$("credits-open").onclick = $("credits-open-2").onclick = () => $("credits").showModal();
$("credits-close").onclick = () => $("credits").close();

// ---------- optogenetics ----------
// Drive every neuron of a chosen cell type with Poisson input while the light is on,
// as in experiments with light-gated channels (e.g. CsChrimson).
const OPTO_PRESETS = [
  ["Walk backward", "MDN"], ["Walk forward", "DNp09"], ["Escape", "DNp01"],
  ["Proboscis", "MN9"], ["Steering", "DNa02"], ["Flight muscles", "DLMn c-f"], ["Looming detectors", "LC4"],
];
let optoTypes = null, optoChoice = null, optoSel = -1;
fetch(ASSETS + "brain-types.json").then((r) => r.json()).then((t) => {
  optoTypes = t;
  $("opto-chips").innerHTML = OPTO_PRESETS.map(([label, ty]) => `<button data-type="${ty}" title="${ty}">${label}</button>`).join("");
  for (const b of $("opto-chips").children) b.onclick = () => chooseOpto(b.dataset.type);
});
function chooseOpto(type) {
  const k = optoTypes.types.indexOf(type);
  if (k < 0) return;
  optoChoice = { type: k + 1, name: type, n: optoTypes.counts[k] };
  $("opto-type").value = type;
  $("opto-list").hidden = true;
  $("opto-go").disabled = false;
  $("opto-note").textContent = `${type}: ${optoChoice.n} neuron${optoChoice.n === 1 ? "" : "s"}. Press Light on to activate them.`;
  if (stim.opto) stim.opto = { type: optoChoice.type, hz: +$("opto-hz").value };
}
function renderOptoList() {
  const q = $("opto-type").value.trim().toLowerCase();
  const list = $("opto-list");
  if (!optoTypes || !q) { list.hidden = true; return; }
  const starts = [], has = [];
  optoTypes.types.forEach((t, i) => {
    const l = t.toLowerCase();
    if (l.startsWith(q)) starts.push(i); else if (l.includes(q)) has.push(i);
  });
  const hits = starts.concat(has).slice(0, 12);
  optoSel = hits.length ? 0 : -1;
  list.innerHTML = hits.map((i, k) => `<li role="option" data-i="${i}" aria-selected="${k === 0}">${optoTypes.types[i]}<span>${optoTypes.counts[i]}</span></li>`).join("");
  list.hidden = !hits.length;
  for (const li of list.children) li.onpointerdown = (e) => { e.preventDefault(); chooseOpto(optoTypes.types[+li.dataset.i]); };
}
$("opto-type").addEventListener("input", renderOptoList);
$("opto-type").addEventListener("keydown", (e) => {
  const items = [...$("opto-list").children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    optoSel = Math.max(0, Math.min(items.length - 1, optoSel + (e.key === "ArrowDown" ? 1 : -1)));
    items.forEach((li, k) => li.setAttribute("aria-selected", k === optoSel));
  } else if (e.key === "Enter" && items[optoSel]) {
    chooseOpto(optoTypes.types[+items[optoSel].dataset.i]);
  } else if (e.key === "Escape") $("opto-list").hidden = true;
});
$("opto-type").addEventListener("blur", () => setTimeout(() => ($("opto-list").hidden = true), 150));
$("opto-hz").addEventListener("input", () => {
  $("opto-hz-val").textContent = `${$("opto-hz").value} Hz`;
  if (stim.opto) stim.opto.hz = +$("opto-hz").value;
});
$("opto-go").onclick = () => {
  if (!optoChoice) return;
  const on = !stim.opto;
  stim.opto = on ? { type: optoChoice.type, hz: +$("opto-hz").value } : null;
  $("opto-go").setAttribute("aria-pressed", on);
  $("opto-go").textContent = on ? "Light off" : "Light on";
  $("hint").textContent = on ? `Light on: ${optoChoice.n} ${optoChoice.name} neuron${optoChoice.n === 1 ? "" : "s"} driven at ${stim.opto.hz} Hz.` : "Light off.";
};

// ---------- render loop ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // On narrow screens the panels sit in the lower half, so frame the fly higher up.
  if (w <= 760) camera.setViewOffset(w, h, 0, h * 0.25, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const UP = new THREE.Vector3(0, 0, 1), tmpQ = new THREE.Quaternion();
const perch = { z: 0, n: new THREE.Vector3(0, 0, 1), hop: null, hold: 0 };
// A fly doesn't glide up a stem: when the surface ahead is much higher or lower (stepping onto a
// leaf, or off one), it makes a short wing-assisted hop. Small turf bumps are walked over.
const HOP = { step: 0.6, look: 1.3, holdS: 0.5 };
const smoothstep = (f) => f * f * (3 - 2 * f);
function startHop(p, z1, n1, now) {
  const dz = Math.abs(z1 - p.z);
  p.hop = { z0: p.z, z1, n0: p.n.clone(), n1: n1.clone(), t0: now, dur: 1000 * Math.min(0.6, 0.28 + 0.04 * dz), arc: 0.6 + 0.25 * dz };
  p.hold = 0;
}
/** Moves the perch height/tilt for this frame; returns how far the wings open for a hop (0..1). */
function updatePerch(p, surf, x, y, hDeg, now, dt) {
  if (body.airborne > 0) {
    // In flight: hold altitude over plants; settle onto whatever is below during the landing.
    p.hop = null; p.hold = 0;
    if (body.airborne < 0.3) {
      const k = Math.min(1, dt / Math.max(body.airborne, dt));
      p.z += (surf.z - p.z) * k;
      p.n.lerp(surf.normal, k).normalize();
    }
    return 0;
  }
  if (p.hop) {
    const hp = p.hop, f = Math.min(1, (now - hp.t0) / hp.dur);
    p.z = hp.z0 + (hp.z1 - hp.z0) * smoothstep(f) + hp.arc * Math.sin(Math.PI * f);
    p.n.copy(hp.n0).lerp(hp.n1, smoothstep(f)).normalize();
    if (f >= 1) { p.z = hp.z1; p.hop = null; }
    return Math.min(1, 2.5 * Math.sin(Math.PI * f));
  }
  // Look a little way along the direction of travel so the hop starts at the edge, not inside the leaf.
  const moving = Math.abs(body.speed) > 1;
  let ahead = surf;
  if (moving) {
    const a = (hDeg * Math.PI) / 180, d = Math.sign(body.speed) * HOP.look;
    ahead = terrain.surfaceAt(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  const offHere = Math.abs(surf.z - p.z) > HOP.step, offAhead = Math.abs(ahead.z - p.z) > HOP.step;
  if (!offHere && !offAhead) {
    const k = Math.min(1, dt / 0.08);
    p.z += (surf.z - p.z) * k;
    p.n.lerp(surf.normal, k).normalize();
    p.hold = 0;
  } else if (!offHere && moving) {
    startHop(p, ahead.z, ahead.normal, now); // the edge is just ahead: hop up/down onto it
  } else if (offHere && !offAhead && moving && p.hold < HOP.holdS) {
    p.hold += dt; // just hopped to the surface ahead; the body is still over the edge
  } else if (offHere) {
    startHop(p, surf.z, surf.normal, now);
  } else p.hold = 0;
  return 0;
}
const lerpAngle = (a, b, f) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;
let lastFrame = performance.now(), lastStats = 0;
function frame(now) {
  requestAnimationFrame(frame);
  step();
  if (fly) {
    const f = tCurr > tPrev ? Math.min(1, (now - tCurr) / (tCurr - tPrev)) : 1;
    const x = prev.x + (curr.x - prev.x) * f, y = prev.y + (curr.y - prev.y) * f, z = prev.z + (curr.z - prev.z) * f;
    const h = lerpAngle(prev.heading, curr.heading, f);
    const delta = new THREE.Vector3(x - flyRoot.position.x, y - flyRoot.position.y, 0);
    // Stand on whatever is underneath (a leaf, the turf, the floor), tilted to its slope.
    const surf = terrain.surfaceAt(x, y);
    const dtf = Math.min(0.1, (now - lastFrame) / 1000);
    const hopWing = updatePerch(perch, surf, x, y, h, now, dtf);
    body.perch = perch.z;
    flyRoot.position.set(x, y, perch.z + z - fly.groundOffset);
    flyRoot.quaternion.setFromUnitVectors(UP, perch.n)
      .multiply(tmpQ.setFromAxisAngle(UP, (h * Math.PI) / 180));
    camera.position.add(delta);
    controls.target.set(x, y, 0.8 + z + perch.z);
    terrain.update(x, y, now / 1000, z);
    sun.position.set(x + 8, y - 6, 20);
    sun.target.position.set(x, y, 0);
    // Pose.
    const phase = prev.phase + (curr.phase - prev.phase) * f;
    const wings = Math.max(body.wingOpen, hopWing);
    fly.setWalk(phase, wings > 0.02 ? 0 : body.ampL, wings > 0.02 ? 0 : body.ampR);
    fly.setFlightLegs(wings);
    fly.setWings(wings, (now / 1000) * 2 * Math.PI * 25); // shown at 25 Hz (real: ~200 Hz)
    fly.setProboscis(body.proboscis);
    const sniff = lastSense ? Math.min(0.4, (lastSense.odor.L + lastSense.odor.R) * 2) : 0;
    for (const s of ["l", "r"]) fly.set(`c_head-${s}_antenna-pitch`, sniff * Math.sin(now / 90 + (s === "l" ? 0 : 1.3)) * 0.5);
    fly.update();
  }
  // Looming discs fly in along their bearing.
  for (const lo of world.looms) {
    const st = world.loomState(lo, curr.t || 0);
    if (!st) { lo.mesh.visible = false; continue; }
    const a = (lo.worldAz * Math.PI) / 180;
    lo.mesh.position.set(lo.x0 + st.d * Math.cos(a) * 0.97, lo.y0 + st.d * Math.sin(a) * 0.97, 2 + st.d * 0.25);
    lo.mesh.visible = true;
  }
  for (const c of loomGroup.children.slice()) if (!world.looms.some((lo) => lo.mesh === c)) loomGroup.remove(c);
  if (gustGroup.children.length && now > gustGroup.userData.until) gustGroup.clear();
  controls.update();
  renderer.render(scene, camera);
  if (now - lastStats > 100) {
    lastStats = now;
    motorChart.draw();
    senseChart.draw();
    brainMap?.draw();
    $("st-state").textContent = brainReady ? body.state : "loading brain";
    $("st-state").dataset.s = body.state;
    $("st-time").textContent = `${(curr.t || 0).toFixed(2)} s`;
    $("st-speed").textContent = brainReady ? `${Math.min(1, STEP_MS / Math.max(1, brainWall)).toFixed(2)}×` : "–";
    $("st-spikes").textContent = brainReady ? Math.round(spikesRate).toLocaleString() : "–";
    $("st-stepping").textContent = brainReady ? stepping.toLocaleString() : "–";
    $("st-walk").textContent = `${Math.abs(body.speed).toFixed(1)} mm/s`;
    $("st-fed").textContent = `${body.foodEaten.toFixed(1)} s`;
  }
  lastFrame = now;
}

// ---------- boot ----------
async function boot() {
  let saved = "lab";
  try { saved = localStorage.getItem("floor") || "lab"; } catch {}
  setFloor(saved === "grass");
  addOdor(35, 40, "vinegar");
  addFood(35, 40, 5);
  addFood(-25, 18, 4);
  body.reset(0, 0, 60);
  Object.assign(curr, { x: 0, y: 0, z: 0, heading: 60, phase: 0, t: 0 });
  Object.assign(prev, curr);
  controls.target.set(0, 0, 0.8);
  if (window.innerWidth <= 760) camera.position.multiplyScalar(1.6);
  requestAnimationFrame(frame);
  $("load-stage").textContent = "Loading the FlyBody model (272k triangles)";
  fly = await loadFly(ASSETS);
  flyRoot = fly.root;
  flyRoot.traverse((o) => { if (o.isMesh) o.castShadow = o.castShadow !== false; });
  scene.add(flyRoot);
  $("load-stage").textContent = "Downloading connectome";
  startBrain();
  const meta = await fetch(ASSETS + "brain.json").then((r) => r.json());
  const [pos, cls] = await Promise.all([loadPng(ASSETS + "brain-pos.png", meta.n * 6), loadPng(ASSETS + "brain-class.png", meta.n)]);
  brainMap = new BrainMap($("brainmap"), new Uint16Array(pos.buffer), cls, meta.classes, meta.pos_range_um);
  brainMap.draw();
}
boot();
window.flyApp = { world, body, smooth, stim, addFood, addOdor, terrain, perch, updatePerch, chooseOpto }; // for debugging from the console
