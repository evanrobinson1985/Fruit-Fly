// Closed loop in the browser: world -> sensory neurons -> connectome (Web Worker) ->
// descending neurons -> FlyBody 3D body.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadFly } from "./fly.js";
import { World, Body } from "./world.js";
import { BrainMap, Chart } from "./hud.js";
import { loadPng } from "./pngdata.js";

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
const rim = new THREE.Mesh(new THREE.CylinderGeometry(world.radius + 1, world.radius + 1, 10, 128, 1, true),
  new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 0.9, roughness: 0.05, thickness: 1, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
rim.rotation.x = Math.PI / 2;
rim.position.z = 5;
scene.add(rim);

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
}

// ---------- fly ----------
const body = new Body();
let fly, flyRoot;
const prev = { x: 0, y: 0, z: 0, heading: 90, phase: 0 }, curr = { ...prev };
let tPrev = 0, tCurr = 0;

// ---------- HUD ----------
const MOTOR = [
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
];
const motorChart = new Chart($("chart-motor"), MOTOR, { max: 60 });
const senseChart = new Chart($("chart-sense"), SENSE_SERIES, { max: 80 });
for (const [el, series] of [["legend-motor", MOTOR], ["legend-sense", SENSE_SERIES]]) {
  $(el).innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
}
let brainMap = null;

// ---------- brain host ----------
let send, brainReady = false, pending = false, paused = false;
const smooth = { forward: { L: 0, R: 0 }, backward: { L: 0, R: 0 }, turn: { L: 0, R: 0 }, escape: { L: 0, R: 0 }, feed: { L: 0, R: 0 } };
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
    for (const g of Object.keys(smooth)) for (const s of ["L", "R"]) smooth[g][s] += a * (msg.motor[g][s] - smooth[g][s]);
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

function sensoryInputs(t) {
  lastSense = body.sense(world, t, $("odor-kind").value);
  return { odor: $("odor-kind").value, ...lastSense.rates };
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
  body.act(smooth, dt, world, rng);
  Object.assign(prev, curr);
  Object.assign(curr, { x: body.x, y: body.y, z: body.z, heading: body.heading, phase: body.phase, t });
  tPrev = tCurr;
  tCurr = performance.now();
  const m = smooth;
  motorChart.push(t, {
    forward: (m.forward.L + m.forward.R) / 2, backward: (m.backward.L + m.backward.R) / 2,
    turnL: m.turn.L, turnR: m.turn.R, escape: Math.max(m.escape.L, m.escape.R), feed: Math.max(m.feed.L, m.feed.R),
  });
  if (lastSense) {
    const r = lastSense.rates;
    senseChart.push(t, { odorL: r.odorL, odorR: r.odorR, loom: Math.max(r.loomL, r.loomR), taste: r.taste });
  }
  // Retire looms that have arrived.
  world.looms = world.looms.filter((lo) => world.loomState(lo, t) || t < lo.t0);
  if (!world.looms.length) body.threatDir = null;
  step();
}

// ---------- interaction ----------
let tool = "food";
for (const k of ["food", "odor"]) {
  $(`tool-${k}`).onclick = () => {
    tool = k;
    $("tool-food").setAttribute("aria-pressed", k === "food");
    $("tool-odor").setAttribute("aria-pressed", k === "odor");
  };
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(floor)[0];
  if (!hit) return;
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
};
let closeUp = true;
$("cam").onclick = () => {
  closeUp = !closeUp;
  $("cam").textContent = closeUp ? "Close-up" : "Arena view";
  const d = closeUp ? 14 : 160;
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, d);
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
    flyRoot.position.set(x, y, z - fly.groundOffset);
    flyRoot.rotation.z = (h * Math.PI) / 180;
    camera.position.add(delta);
    controls.target.set(x, y, 0.8 + z);
    sun.position.set(x + 8, y - 6, 20);
    sun.target.position.set(x, y, 0);
    // Pose.
    const phase = prev.phase + (curr.phase - prev.phase) * f;
    const flying = body.wingOpen > 0.02;
    fly.setWalk(phase, flying ? 0 : body.ampL, flying ? 0 : body.ampR);
    fly.setFlightLegs(body.wingOpen);
    fly.setWings(body.wingOpen, (now / 1000) * 2 * Math.PI * 25); // shown at 25 Hz (real: ~200 Hz)
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
window.flyApp = { world, body, smooth, addFood, addOdor }; // for debugging from the console
