// Render the grass-arena scenery strip used by the watch game (see scenery.html).
//   npm install three@0.169.0 playwright   (in watch/tools)
//   node watch/tools/render_scenery.mjs     (writes watch/app/src/main/assets/scenery/*.png + scenery.json)
// Then: python watch/tools/scenery_to_webp.py
import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const three = dirname(dirname(createRequire(import.meta.url).resolve("three")));
const out = process.argv[2] || join(repo, "watch/app/src/main/assets/scenery");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  let f = null;
  if (u.host === "app") f = u.pathname === "/scenery.html" ? join(here, "scenery.html") : join(repo, "web", u.pathname);
  else if (u.host === "cdn.jsdelivr.net") { const m = u.pathname.match(/\/npm\/three@[^/]+\/(.*)/); if (m) f = join(three, m[1]); }
  if (f && existsSync(f)) return route.fulfill({ body: readFileSync(f), contentType: types[extname(f)] || "application/octet-stream" });
  return route.fulfill({ status: 404, body: "" });
});
await page.goto("http://app/scenery.html");
await page.waitForFunction(() => window.ready, null, { timeout: 300000 });
mkdirSync(out, { recursive: true });
for (const layer of ["near", "front", "far"]) {
  const { tiles, W, H, TILE } = await page.evaluate((l) => window.render(l), layer);
  for (const t of tiles) writeFileSync(join(out, `${layer}_${t.ty}_${t.tx}.png`), Buffer.from(t.png.split(",")[1], "base64"));
  console.log(layer, tiles.length, "tiles of", TILE, "for", W, "x", H);
}
writeFileSync(join(out, "scenery.json"), JSON.stringify(await page.evaluate(() => window.meta())));
await browser.close();
