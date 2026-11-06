import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardImages, pastePromptImages, createImageQueue } from '../../src/office/ui/prompt-images.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const event = (files = [], text = '', field = null) => ({
  currentTarget: field, defaultPrevented: false,
  clipboardData: { items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })), files, getData: () => text },
  preventDefault() { this.defaultPrevented = true; },
});

test('clipboard images use one representation and fall back to FileList', () => {
  const png = { type: 'image/png' }, text = { type: 'text/plain' }, e = event([png, text]);
  assert.deepEqual(clipboardImages(e), [png]); // The FileList copy must not duplicate the same image.
  e.clipboardData.items = []; assert.deepEqual(clipboardImages(e), [png]);
  assert.deepEqual(clipboardImages({}), []);
});

test('ordinary text and inactive or read-only inputs keep normal paste behavior', () => {
  const e = event([], 'keep this text');
  assert.equal(pastePromptImages(e, () => assert.fail('text must not attach')), false);
  assert.equal(e.defaultPrevented, false);
  for (const field of [{ readOnly: true }, { disabled: true }]) {
    const e = event([{ type: 'image/png' }], '', field);
    assert.equal(pastePromptImages(e, () => assert.fail('input is locked')), false);
    assert.equal(e.defaultPrevented, false);
  }
  assert.equal(pastePromptImages(event([{ type: 'image/png' }]), () => assert.fail('no recipient'), false), false);
});

test('mixed image and text preserves selection, enforces maxLength and notifies the input', () => {
  const field = { value: 'old prompt', selectionStart: 0, selectionEnd: 3, maxLength: 12, events: [],
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); },
    dispatchEvent(e) { this.events.push(e.type); } };
  const png = { type: 'image/png' }, e = event([png], 'long text', field), added = [];
  assert.equal(pastePromptImages(e, (files) => added.push(...files)), true);
  assert.equal(e.defaultPrevented, true);
  assert.equal(field.value, 'long  prompt');
  assert.deepEqual(field.events, ['input']); assert.deepEqual(added, [png]);
});

test('rapid picker and paste batches share the cap and preserve image order', async () => {
  const images = [], limits = [], busy = [], gate = deferred();
  const q = createImageQueue({ images: () => images, prepare: async (file) => { await gate.promise; return file; },
    limit: (n) => limits.push(n), busy: () => busy.push(q.pending) });
  const first = q.add(['a', 'b', 'c']), second = q.add(['d', 'e', 'f']);
  assert.equal(q.pending, 2); gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(images, ['a', 'b', 'c', 'd']); assert.deepEqual(limits, [4]);
  assert.equal(q.pending, 0); assert.equal(busy.at(-1), 0);
  images.splice(1, 1); await q.add(['new']); assert.deepEqual(images, ['a', 'c', 'd', 'new']);
});

test('recipient changes cancel in-flight and queued images, without blocking the next recipient', async () => {
  const images = [], gate = deferred(); let decoding = 0;
  const q = createImageQueue({ images: () => images, prepare: async (file) => { decoding++; await gate.promise; return file; } });
  const first = q.add(['old']), queued = q.add(['old-queued']);
  await Promise.resolve(); assert.equal(decoding, 1);
  q.invalidate(); const next = q.add(['new']); gate.resolve(); await Promise.all([first, queued, next]);
  assert.deepEqual(images, ['new']); assert.equal(decoding, 2); assert.equal(q.pending, 0);
});

test('closed forms drop prepared images, and unreadable images do not poison later batches', async () => {
  const images = [], gate = deferred(); let open = true, errors = 0;
  const q = createImageQueue({ images: () => images, current: () => open, error: () => errors++,
    prepare: async (file) => { if (file === 'bad') throw new Error('decode failed'); await gate.promise; return file; } });
  const work = q.add(['closed']); await Promise.resolve(); open = false; gate.resolve(); await work;
  assert.deepEqual(images, []); open = true; await q.add(['bad', 'good']);
  assert.deepEqual(images, ['good']); assert.equal(errors, 1); assert.equal(q.pending, 0);
});
