// Read bytes stored in a grayscale PNG by web/tools/pngpack.py: concatenate the
// IDAT chunks, inflate them, and drop each row's filter byte (always 0).

export async function fetchBytes(url, onProgress) {
  const r = await fetch(url);
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

export async function loadPng(url, length, onProgress) {
  return decodePng(await fetchBytes(url, onProgress), length);
}
