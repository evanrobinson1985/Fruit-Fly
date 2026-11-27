// Render the frog sprite frames used by the watch game (see frogs.html).
//   npm install three@0.169.0 playwright   (in watch/tools), or set THREE_DIR to a copy of three
//   node watch/tools/render_frogs.mjs        (writes watch/app/src/main/assets/frogs/*.webp + frogs.json)
// Needs Pillow (python3) for the WebP conversion.
import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const three = process.env.THREE_DIR || dirname(dirname(createRequire(import.meta.url).resolve("three")));
const out = process.argv[2] || join(repo, "watch/app/src/main/assets/frogs");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary" };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  let f = null;
  if (u.host === "app") f = u.pathname === "/frogs.html" ? join(here, "frogs.html") : join(repo, "web", decodeURIComponent(u.pathname));
  else if (u.host === "cdn.jsdelivr.net") { const m = u.pathname.match(/\/npm\/three@[^/]+\/(.*)/); if (m) f = join(three, m[1]); }
  if (f && existsSync(f)) return route.fulfill({ body: readFileSync(f), contentType: types[extname(f)] || "application/octet-stream" });
  return route.fulfill({ status: 404, body: "" });
});
await page.goto("http://app/frogs.html");
await page.waitForFunction(() => window.ready, null, { timeout: 600000 });
mkdirSync(out, { recursive: true });
const metas = [];
for (const id of ["small", "big"]) {
  const { frames, meta } = await page.evaluate((i) => window.render(i), id);
  const pngs = [];
  for (const [anim, list] of Object.entries(frames)) list.forEach((png, k) => {
    const f = join(out, `${id}_${anim}_${String(k).padStart(2, "0")}.png`);
    writeFileSync(f, Buffer.from(png.split(",")[1], "base64"));
    pngs.push(f);
  });
  meta.counts = Object.fromEntries(Object.entries(frames).map(([a, l]) => [a, l.length]));
  // Cropped to the frog (a watch has little memory) and saved as WebP (lossy with alpha);
  // each frame's offset in the full frame goes in the metadata.
  const crops = JSON.parse(execFileSync("python3", ["-c", `
import sys, json
from PIL import Image
out = {}
for p in sys.argv[1:]:
    im = Image.open(p).convert("RGBA")
    box = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox() or (0, 0, 1, 1)
    im.crop(box).save(p[:-4] + ".webp", "WEBP", quality=88, method=6)
    out[p.split("/")[-1][:-4]] = list(box)
print(json.dumps(out))
`, ...pngs]).toString());
  meta.crops = crops;
  metas.push(meta);
  console.log(id, meta.counts, meta.width, "x", meta.height);
  for (const p of pngs) unlinkSync(p);
}
writeFileSync(join(out, "frogs.json"), JSON.stringify(metas));
await browser.close();
