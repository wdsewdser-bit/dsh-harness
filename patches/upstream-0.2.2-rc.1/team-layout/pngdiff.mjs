// Minimal dependency-free PNG (8-bit RGB/RGBA, non-interlaced) pixel diff + DOM text diff for A1.
// Usage: node pngdiff.mjs <dirA> <dirB> [diffOutDir]
import fs from 'node:fs';
import zlib from 'node:zlib';
function decode(file) {
  const b = fs.readFileSync(file); let p = 8, w, h, bpp, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[12]) throw Error('unsupported'); bpp = { 2: 3, 6: 4 }[data[9]]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
      line[x] = (line[x] + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
    prev = line;
  }
  return { w, h, px: out };
}
const [, , A, B] = process.argv;
const report = [];
for (const f of fs.readdirSync(A).filter(n => n.endsWith('.png')).sort()) {
  if (!fs.existsSync(`${B}/${f}`)) { report.push({ file: f, missing: true }); continue; }
  const a = decode(`${A}/${f}`), b = decode(`${B}/${f}`);
  let diff = 0;
  if (a.w !== b.w || a.h !== b.h) diff = -1;
  else for (let i = 0; i < a.px.length; i += 4) if (a.px[i] !== b.px[i] || a.px[i + 1] !== b.px[i + 1] || a.px[i + 2] !== b.px[i + 2]) diff++;
  const html = f.replace('.png', '.html');
  const U = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const ha = fs.readFileSync(`${A}/${html}`, 'utf8').replace(U, 'UUID'), hb = fs.readFileSync(`${B}/${html}`, 'utf8').replace(U, 'UUID');
  let firstDomDiff = -1;
  if (ha !== hb) { firstDomDiff = 0; while (ha[firstDomDiff] === hb[firstDomDiff]) firstDomDiff++; }
  report.push({ file: f, size: `${a.w}x${a.h}`, diffPixels: diff, domEqual: ha === hb,
    domDiffAt: firstDomDiff < 0 ? undefined : { a: ha.slice(Math.max(0, firstDomDiff - 80), firstDomDiff + 120), b: hb.slice(Math.max(0, firstDomDiff - 80), firstDomDiff + 120) } });
}
console.log(JSON.stringify(report, null, 1));