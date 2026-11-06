// Image attachments for AI prompts: clipboard extraction and a bounded, cancellable preparation queue.
export const MAX_PROMPT_IMAGES = 4;

export function clipboardImages(event) {
  const data = event.clipboardData;
  if (!data) return [];
  const items = [...(data.items || [])].filter((x) => x.kind === 'file' && x.type.startsWith('image/'));
  const files = items.map((x) => x.getAsFile()).filter(Boolean);
  // Some browsers only expose FileList. Do not collect both lists: they refer to the same images.
  return files.length ? files : [...(data.files || [])].filter((x) => x.type.startsWith('image/'));
}

export function pastePromptImages(event, add, enabled = true) {
  const field = event.currentTarget;
  if (!enabled || event.defaultPrevented || field?.disabled || field?.readOnly) return false;
  const files = clipboardImages(event);
  if (!files.length) return false; // Ordinary text keeps the browser's paste behavior.
  event.preventDefault();
  // Preserve plain text in a mixed clipboard, including the selection and textarea's length limit.
  const text = event.clipboardData.getData('text/plain');
  if (text && field?.setRangeText) {
    const start = field.selectionStart, end = field.selectionEnd;
    const room = field.maxLength < 0 ? text.length : Math.max(0, field.maxLength - field.value.length + end - start);
    field.setRangeText(text.slice(0, room), start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  add(files);
  return true;
}

export async function shrink(file) {
  const img = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height)), canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let url = canvas.toDataURL('image/jpeg', 0.82);
    if (url.length > 480_000) url = canvas.toDataURL('image/jpeg', 0.6);
    return url;
  } finally { img.close?.(); }
}

export function createImageQueue({ images, prepare = shrink, current = () => true, changed = () => {}, busy = () => {},
  limit = () => {}, error = () => {}, max = MAX_PROMPT_IMAGES }) {
  let queue = Promise.resolve(), pending = 0, generation = 0;
  return {
    get pending() { return pending; },
    invalidate() { generation++; },
    add(files) {
      if (!files.length || !current()) return Promise.resolve();
      const stamp = generation, active = () => stamp === generation && current(), batch = [...files].slice(0, max + 1);
      pending++; busy();
      const job = queue.then(async () => {
        for (const file of batch) {
          if (!active()) return;
          if (images().length >= max) { limit(max); return; }
          try {
            const url = await prepare(file);
            if (!active()) return;
            images().push(url); changed();
          } catch { if (active()) error(); }
        }
      }).finally(() => { pending--; busy(); });
      // A failed callback must not poison later clipboard/file-picker batches.
      queue = job.catch(() => {});
      return queue;
    },
  };
}
