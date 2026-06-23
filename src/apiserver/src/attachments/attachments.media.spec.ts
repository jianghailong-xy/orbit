import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_UPLOAD_BYTES, assertValidUpload } from './attachments.media';

test('rejects a missing file', () => {
  assert.throws(() => assertValidUpload(undefined), /file is required/);
});

test('rejects an empty file', () => {
  assert.throws(() => assertValidUpload({ size: 0 }), /empty file/);
});

test('rejects a file over the size cap', () => {
  assert.throws(() => assertValidUpload({ size: MAX_UPLOAD_BYTES + 1 }), /exceeds/);
});

test('accepts any type within the cap', () => {
  // Type is no longer gated — image, PDF, archive, anything goes (the runner dispatches
  // on the MIME type), so the only checks are non-empty and within the size cap.
  assert.doesNotThrow(() => assertValidUpload({ size: 512 }));
});

test('accepts a file exactly at the cap', () => {
  assert.doesNotThrow(() => assertValidUpload({ size: MAX_UPLOAD_BYTES }));
});
