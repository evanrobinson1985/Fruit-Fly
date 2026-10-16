// Read bytes stored in a grayscale PNG by web/tools/pngpack.py: concatenate the
// IDAT chunks, inflate them, and drop each row's filter byte (always 0).

// The browser keeps downloaded connectome files in Cache Storage, so they are downloaded
// once rather than on every visit. Each file is stored under its URL plus a version (its
// size from brain.json), so a new export is fetched again. Without Cache Storage (old
// browsers, some private windows) everything still works, downloading each visit.
const STORE = "fly-connectome";

/** The cache, or null where the browser has none or refuses it. */
export async function openStore() {
  try {
    return typeof caches === "undefined" ? null : await caches.open(STORE);
  } catch {
    return null;
  }
}

/** Remove stored files whose keys are not in `keep` (older exports). */
export async function pruneStore(store, keep) {
  if (!store) return;
  try {
    for (const req of await store.keys()) if (!keep.includes(req.url)) await store.delete(req);
  } catch {}
}

/** Absolute cache key for `url` at `version`. */
export const storeKey = (url, version) => new URL(`${url}${url.includes("?") ? "&" : "?"}v=${version}`, self.location.href).href;

async function storedResponse(store, key) {
  if (!store) return null;
  try { return (await store.match(key)) || null; } catch { return null; }
}

/** `opts.store`, `opts.version`: read from / save to the cache (see openStore). */
export async function fetchBytes(url, onProgress, opts = {}) {
  const key = opts.store ? storeKey(url, opts.version) : null;
  let r = await storedResponse(opts.store, key);
  if (!r) {
    r = await fetch(url, opts.store ? { cache: "no-store" } : undefined);
    if (r.ok && opts.store) {
      const copy = r.clone();
      opts.store.put(key, copy).catch(() => {}); // full storage: just download next time
    }
  }
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  if (!onProgress || !r.body) return new Uint8Array(await r.arrayBuffer());
  const parts = [];
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    onProgress(value.length);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function decodePng(png, length) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8, width = 0;
  const idat = [];
  while (pos < png.length) {
    const n = dv.getUint32(pos);
    const kind = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    if (kind === "IHDR") width = dv.getUint32(pos + 8);
    else if (kind === "IDAT") idat.push(png.subarray(pos + 8, pos + 8 + n));
    pos += 12 + n;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const stride = width + 1, rows = raw.length / stride;
  const out = new Uint8Array(length ?? rows * width);
  for (let r = 0, o = 0; r < rows && o < out.length; r++, o += width) {
    out.set(raw.subarray(r * stride + 1, r * stride + 1 + Math.min(width, out.length - o)), o);
  }
  return out;
}

export async function loadPng(url, length, onProgress, opts) {
  return decodePng(await fetchBytes(url, onProgress, opts), length);
}

/**
 * Stream a PNG from `url` straight into `dest` at `offset` (exactly `length` bytes),
 * without holding the compressed file or a second copy in memory. Calls
 * `onProgress(nBytes)` as compressed bytes arrive. Aborts if no bytes arrive for
 * `stallMs`, so a stuck download can be retried. With `opts.store` it reads the file from the
 * cache when stored there (returning true), and otherwise stores it as it downloads.
 */
export async function streamPngInto(url, dest, offset, length, onProgress, stallMs = 15000, opts = {}) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), stallMs);
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), stallMs); };
  const key = opts.store ? storeKey(url, opts.version) : null;
  let saving = null;
  try {
    let r = await storedResponse(opts.store, key);
    const cached = !!r;
    if (!r) r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`${url.split("/").pop()}: HTTP ${r.status}`);
    let body = r.body;
    if (!cached && opts.store) {
      // Save a copy as it streams in; it is only kept if the whole file arrives intact.
      const [a, b] = body.tee();
      body = a;
      saving = opts.store.put(key, new Response(b, { headers: { "content-type": "image/png" } })).then(() => true, () => false);
    }
    const inflate = new DecompressionStream("deflate");
    const writer = inflate.writable.getWriter();
    let width = 0;

    // Read the inflated scanlines concurrently, dropping each row's filter byte.
    const drain = (async () => {
      const reader = inflate.readable.getReader();
      let col = -1, o = offset;
      const end = offset + length;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.length; ) {
          if (col < 0) { col = 0; i++; continue; }            // filter byte (always 0)
          const n = Math.min(width - col, value.length - i);
          const take = Math.min(n, end - o);
          if (take > 0) { dest.set(value.subarray(i, i + take), o); o += take; }
          col += n; i += n;
          if (col >= width) col = -1;
        }
      }
      if (o !== end) throw new Error(`${url.split("/").pop()}: got ${o - offset} of ${length} bytes`);
    })();

    // Parse PNG chunks from the network stream with a small state machine
    // (signature -> chunk header -> chunk data -> CRC), feeding IDAT data to the inflater.
    const reader = body.getReader();
    let state = "sig", need = 8, kind = "", hdr = new Uint8Array(8), hdrN = 0, ihdr = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      alive();
      onProgress?.(value.length);
      let i = 0;
      while (i < value.length) {
        if (state === "hdr") {
          const take = Math.min(8 - hdrN, value.length - i);
          hdr.set(value.subarray(i, i + take), hdrN);
          hdrN += take; i += take;
          if (hdrN === 8) {
            need = new DataView(hdr.buffer).getUint32(0);
            kind = String.fromCharCode(...hdr.subarray(4, 8));
            state = need ? "data" : "crc";
            if (!need) need = 4;
            hdrN = 0;
          }
          continue;
        }
        const take = Math.min(need, value.length - i);
        if (state === "data") {
          const part = value.subarray(i, i + take);
          if (kind === "IDAT") await writer.write(part.slice());
          else if (kind === "IHDR") ihdr.push(...part);
          if (kind === "IHDR" && ihdr.length >= 4 && !width) width = ((ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3]) >>> 0;
        }
        need -= take; i += take;
        if (need === 0) {
          if (state === "sig" || state === "crc") { state = "hdr"; }
          else { state = "crc"; need = 4; }
        }
      }
    }
    await writer.close();
    await drain;
    if (saving) await saving;
    return cached;
  } catch (e) {
    if (saving) saving.then(() => opts.store.delete(key).catch(() => {}));
    if (ctl.signal.aborted) throw new Error(`${url.split("/").pop()}: download stalled`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
