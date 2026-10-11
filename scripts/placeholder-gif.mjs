// Generates docs/demo.gif — a tiny animated placeholder so the README's demo
// slot renders until the real recording replaces it. Solid colors scale
// perfectly, so 160x90 fills a 720px slot without blur.
// Run: node scripts/placeholder-gif.mjs
import { writeFileSync, statSync } from "node:fs";

const W = 160;
const H = 90;

function packCodes(codes) {
  const bytes = [];
  let cur = 0;
  let n = 0;
  for (const { code, bits } of codes) {
    for (let i = 0; i < bits; i++) {
      cur |= ((code >> i) & 1) << n;
      n++;
      if (n === 8) {
        bytes.push(cur);
        cur = 0;
        n = 0;
      }
    }
  }
  if (n > 0) bytes.push(cur);
  return bytes;
}

// LZW with a clear code before every literal keeps the code size pinned at
// 3 bits — a valid stream for a single-color frame.
function lzwSolid(count, idx) {
  const codes = [];
  for (let i = 0; i < count; i++) codes.push({ code: 4, bits: 3 }, { code: idx, bits: 3 });
  codes.push({ code: 5, bits: 3 });
  return packCodes(codes);
}

function subBlocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

const buf = [];
buf.push(...Buffer.from("GIF89a"));
buf.push(W & 0xff, W >> 8, H & 0xff, H >> 8, 0xf0, 0, 0);
buf.push(0x23, 0x23, 0x2b, 0x2a, 0x2a, 0x33); // palette: two near-blacks
buf.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00);
for (const [idx, delay] of [
  [0, 100],
  [1, 100],
]) {
  buf.push(0x21, 0xf9, 0x04, 0x00, delay & 0xff, delay >> 8, 0x00, 0x00);
  buf.push(0x2c, 0, 0, 0, 0, W & 0xff, W >> 8, H & 0xff, H >> 8, 0x00);
  buf.push(2);
  buf.push(...subBlocks(lzwSolid(W * H, idx)));
}
buf.push(0x3b);
writeFileSync("docs/demo.gif", Buffer.from(buf));
console.log(`wrote docs/demo.gif — ${statSync("docs/demo.gif").size} bytes`);
