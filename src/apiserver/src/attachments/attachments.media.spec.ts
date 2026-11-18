import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPOSER_IMAGE_TYPES, MAX_UPLOAD_BYTES, assertValidUpload, imageBytesMatch } from './attachments.media';

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

test('an image type matches only its own first bytes', () => {
  const heads: Record<string, Uint8Array> = {
    'image/png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    'image/jpeg': Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
    'image/gif': new TextEncoder().encode('GIF89a\0\0\0\0\0\0'),
    'image/webp': new TextEncoder().encode('RIFF\0\0\0\0WEBP'),
  };
  for (const type of COMPOSER_IMAGE_TYPES) {
    for (const [other, head] of Object.entries(heads)) {
      assert.equal(imageBytesMatch(type, head), type === other, `${type} against the head of ${other}`);
    }
  }
  assert.equal(imageBytesMatch('image/png', new TextEncoder().encode('%PDF-1.7\n')), false, 'a PDF is no image');
  assert.equal(imageBytesMatch('image/svg+xml', new TextEncoder().encode('<svg ')), false, 'nor is a type off the list');
});
