import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  assertValidImageUpload,
} from './attachments.media';

test('rejects a missing file', () => {
  assert.throws(() => assertValidImageUpload(undefined), /file is required/);
});

test('rejects a disallowed MIME type', () => {
  assert.throws(
    () => assertValidImageUpload({ mimetype: 'application/pdf', size: 1024 }),
    /unsupported image type/,
  );
});

test('rejects an empty file', () => {
  assert.throws(() => assertValidImageUpload({ mimetype: 'image/png', size: 0 }), /empty file/);
});

test('rejects a file over the size cap', () => {
  assert.throws(
    () => assertValidImageUpload({ mimetype: 'image/png', size: MAX_UPLOAD_BYTES + 1 }),
    /exceeds/,
  );
});

test('accepts every allowed type within the cap', () => {
  for (const mimetype of ALLOWED_IMAGE_TYPES) {
    assert.doesNotThrow(() => assertValidImageUpload({ mimetype, size: 512 }));
  }
});

test('accepts a file exactly at the cap', () => {
  assert.doesNotThrow(() =>
    assertValidImageUpload({ mimetype: 'image/png', size: MAX_UPLOAD_BYTES }),
  );
});
