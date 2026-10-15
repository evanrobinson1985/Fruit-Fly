// Render the FlyBody animation frames used by the watch game.
//   npm install three@0.169.0 playwright   (in watch/tools)
//   node watch/tools/render_sprites.mjs     (writes watch/app/src/main/assets/sprites/*.png)
// Then: python watch/tools/sprites_to_webp.py
// Needs web/assets/fly.json + fly.png (see web/tools/export_body.py) and a Chromium for Playwright.
import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const three = dirname(dirname(createRequire(import.meta.url).resolve("three")));
const out = join(repo, "watch/app/src/main/assets/sprites");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  let f = null;
  if (u.host === "app") f = u.pathname === "/sprites.html" ? join(here, "sprites.html") : join(repo, "web", u.pathname);
  else if (u.host === "cdn.jsdelivr.net") { const m = u.pathname.match(/\/npm\/three@[^/]+\/(.*)/); if (m) f = join(three, m[1]); }
  if (f && existsSync(f)) return route.fulfill({ body: readFileSync(f), contentType: types[extname(f)] || "application/octet-stream" });
  return route.fulfill({ status: 404, body: "" });
});
await page.goto("http://app/sprites.html");
await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
const frames = await page.evaluate(() => window.render());
mkdirSync(out, { recursive: true });
for (const [kind, list] of Object.entries(frames)) {
  list.forEach((d, i) => writeFileSync(join(out, `${kind}_${String(i).padStart(2, "0")}.png`), Buffer.from(d.split(",")[1], "base64")));
}
console.log(Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, v.length])));
await browser.close();
