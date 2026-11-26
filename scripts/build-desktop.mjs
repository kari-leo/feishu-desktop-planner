import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const dir = 'build/desktop';
await mkdir(dir, { recursive: true });
await Promise.all([
  build({
    entryPoints: { main: 'src/desktop/main.mts', preload: 'src/desktop/preload.mts' },
    outdir: dir, outExtension: { '.js': '.cjs' }, bundle: true, format: 'cjs', platform: 'node',
    target: 'node24', external: ['electron'], legalComments: 'external',
  }),
  build({
    entryPoints: ['src/desktop/ui/index.tsx'], outfile: dir + '/renderer.js', bundle: true,
    jsx: 'automatic', platform: 'browser', target: 'chrome150', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'external',
  }),
  copyFile('src/desktop/ui/index.html', dir + '/index.html'),
  writeIcon(dir),
]);

async function writeIcon(out) {
  const size = 256;
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + x * 4 + 1;
    const border = rounded(x, y, 8, 8, 248, 248, 51);
    if (!border) continue;
    const ink = rounded(x, y, 63, 69, 193, 193, 15) && !rounded(x, y, 73, 80, 183, 183, 9)
      || x >= 68 && x <= 188 && y >= 104 && y <= 113
      || rounded(x, y, 88, 57, 101, 93, 6) || rounded(x, y, 155, 57, 168, 93, 6)
      || line(x, y, 96, 146, 116, 164, 6) || line(x, y, 116, 164, 161, 124, 6);
    const shade = y / size;
    pixels[i] = ink ? 203 : Math.round(20 + shade * 4);
    pixels[i + 1] = ink ? 242 : Math.round(91 + shade * 22);
    pixels[i + 2] = ink ? 227 : Math.round(86 + shade * 6);
    pixels[i + 3] = 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await Promise.all([writeFile(out + '/icon.png', png), writeFile(out + '/icon.ico', Buffer.concat([ico, png]))]);
}

function rounded(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, x - (right - radius), 0);
  const dy = Math.max(top + radius - y, y - (bottom - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}
function line(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= width;
}
function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([size, bytes, checksum]);
}
