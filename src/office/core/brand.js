// The supplied LioOps emblem in canvas exports and the 3D lobby; images are served locally, including static demos.
const image = new Image(), wordmark = new Image(), base = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/assets/branding/`;
image.src = `${base}logo-mark.png`; wordmark.src = `${base}logo-wordmark.png`;
export const brandReady = Promise.all([image.decode().catch(() => {}), wordmark.decode().catch(() => {})]);
export function paintBrandMark(g, x, y, size) {
  if (image.complete && image.naturalWidth) g.drawImage(image, x, y, size, size);
}
export function paintBrandWordmark(g, x, y, width, height) {
  if (!wordmark.complete || !wordmark.naturalWidth) return false;
  const scale = Math.min(width / wordmark.naturalWidth, height / wordmark.naturalHeight);
  const w = wordmark.naturalWidth * scale, h = wordmark.naturalHeight * scale;
  g.drawImage(wordmark, x + (width - w) / 2, y + (height - h) / 2, w, h);
  return true;
}
