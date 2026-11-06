// Generate web/PWA/share assets from the original LioOps logo. The source file is kept byte-for-byte intact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url)), folder = path.join(root, 'public', 'assets', 'branding');
const source = path.join(folder, 'Logo.png');
const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let left = info.width, top = info.height, right = -1, bottom = -1;
const columns = new Uint32Array(info.width);
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  if (data[(y * info.width + x) * 4 + 3] <= 8) continue;
  columns[x]++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
}
if (right < left) throw new Error('The logo has no visible pixels');
// The original has an emblem on the left, separated from the wordmark by transparent columns.
let gapStart = -1, split = -1;
for (let x = left; x < left + (right - left) / 2; x++) {
  if (!columns[x] && gapStart < 0) gapStart = x;
  if (columns[x] && gapStart >= 0) { if (x - gapStart >= 16) { split = gapStart; break; } gapStart = -1; }
}
if (split < 0) throw new Error('Cannot locate the emblem/wordmark gap in the supplied logo');
const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 };
const mark = await sharp(source).extract({ ...bounds, width: split - left }).png().toBuffer();
const wordmark = await sharp(source).extract(bounds).resize({ width: 960, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(path.join(folder, 'logo-wordmark.png'), wordmark);
// The supplied wordmark uses dark lettering. An alpha mask lights only the Lio letter bodies;
// the emblem, orange dot, orange Ops and transparent background keep their original pixels.
const { width, height } = await sharp(wordmark).metadata();
const png = `data:image/png;base64,${wordmark.toString('base64')}`;
const lightLetters = `M${width * 0.334} ${height * 0.23}H${width * 0.442}V${height * 0.354}H${width * 0.618}V${height * 0.78}H${width * 0.334}Z`;
fs.writeFileSync(path.join(folder, 'logo-wordmark-dark.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>LioOps</title><defs><image id="original" width="${width}" height="${height}" href="${png}"/><mask id="letters" style="mask-type:alpha"><use href="#original"/></mask></defs><use href="#original"/><path d="${lightLetters}" fill="#f2f5fa" mask="url(#letters)"/></svg>\n`);
await sharp(mark).resize(192, 192, { fit: 'contain', background: '#00000000' }).png({ compressionLevel: 9 }).toFile(path.join(folder, 'logo-mark.png'));
async function icon(size) {
  const content = Math.round(size * 0.86), before = Math.floor((size - content) / 2), after = size - content - before;
  return sharp(mark).resize(content, content, { fit: 'contain', background: '#00000000' })
    .extend({ top: before, bottom: after, left: before, right: after, background: '#00000000' }).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
}
const icon512 = await icon(512);
fs.writeFileSync(path.join(root, 'public', 'icon-512.png'), icon512);
fs.writeFileSync(path.join(root, 'app', 'apple-icon.png'), await icon(180));
fs.writeFileSync(path.join(root, 'app', 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>LioOps</title><defs><clipPath id="round"><rect width="512" height="512" rx="80"/></clipPath></defs><image width="512" height="512" clip-path="url(#round)" href="data:image/png;base64,${icon512.toString('base64')}"/></svg>\n`);
// PNG-backed ICO entries are supported by browsers and Windows, including the full-resolution 256 px entry.
const sizes = [16, 32, 48, 256], frames = await Promise.all(sizes.map(icon)), header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
frames.forEach((frame, i) => {
  const at = 6 + i * 16; header[at] = header[at + 1] = sizes[i] === 256 ? 0 : sizes[i];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(frame.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += frame.length;
});
fs.writeFileSync(path.join(root, 'app', 'favicon.ico'), Buffer.concat([header, ...frames]));
const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#0e131b"/><rect x="80" y="64" width="1040" height="370" rx="36" fill="#f8fafc"/><image x="160" y="110" width="880" height="250" href="data:image/png;base64,${wordmark.toString('base64')}"/><text x="600" y="528" text-anchor="middle" font-family="Arial,sans-serif" font-size="42" fill="#d3dce8">Codex · Claude Code</text></svg>`;
const share = await sharp(Buffer.from(card)).jpeg({ quality: 92 }).toBuffer();
for (const name of ['opengraph-image', 'twitter-image']) {
  fs.writeFileSync(path.join(root, 'app', `${name}.jpg`), share);
  fs.writeFileSync(path.join(root, 'app', `${name}.alt.txt`), 'LioOps: Codex and Claude Code workspace\n');
}
console.log('LioOps branding assets generated from public/assets/branding/Logo.png');
