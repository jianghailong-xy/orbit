import assert from 'node:assert/strict';
import { test } from 'node:test';

import { imageSizeOf } from './image-size';

const bytes = (...parts: (string | number[] | Buffer)[]) => Buffer.concat(parts.map((part) => (
  typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)
)));
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const padded = (head: Buffer, length = 40) => Buffer.concat([head, Buffer.alloc(Math.max(0, length - head.length))]);

const png = (width: number, height: number) =>
  bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(width), u32be(height));
const riff = (body: Buffer) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', body);
const jpegFrame = (marker: number, width: number, height: number) =>
  bytes([0xff, marker], u16be(17), [8], u16be(height), u16be(width), Buffer.alloc(13));

test('a PNG, a GIF and each WebP state their size in their first bytes', () => {
  assert.deepEqual(imageSizeOf(png(1280, 800)), { width: 1280, height: 800 });
  assert.deepEqual(imageSizeOf(bytes('GIF89a', u16le(320), u16le(200))), { width: 320, height: 200 });
  assert.deepEqual(imageSizeOf(bytes('GIF87a', u16le(1), u16le(2))), { width: 1, height: 2 });
  const lossy = riff(padded(bytes('VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], u16le(640 | 0x4000), u16le(480 | 0x8000)), 22));
  assert.deepEqual(imageSizeOf(lossy), { width: 640, height: 480 }, 'the scale bits are not the size');
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE((640 - 1) | ((480 - 1) << 14));
  assert.deepEqual(imageSizeOf(riff(padded(bytes('VP8L', [0, 0, 0, 0], [0x2f], bits), 22))), { width: 640, height: 480 });
  const extended = bytes('VP8X', [0, 0, 0, 0], [0, 0, 0, 0], [0x7f, 0x02, 0x00], [0xdf, 0x01, 0x00]);
  assert.deepEqual(imageSizeOf(riff(padded(extended, 22))), { width: 640, height: 480 });
});

test('a JPEG states its size after whatever metadata comes first', () => {
  const app1 = bytes([0xff, 0xe1], u16be(5002), Buffer.alloc(5000));
  const quantisation = bytes([0xff, 0xdb], u16be(67), Buffer.alloc(65));
  const huffman = bytes([0xff, 0xc4], u16be(31), Buffer.alloc(29));
  for (const frame of [0xc0, 0xc1, 0xc2]) {
    assert.deepEqual(
      imageSizeOf(bytes([0xff, 0xd8], app1, quantisation, huffman, jpegFrame(frame, 4032, 3024))),
      { width: 4032, height: 3024 },
      `frame marker ${frame.toString(16)}`,
    );
  }
  assert.deepEqual(imageSizeOf(bytes([0xff, 0xd8, 0xff], jpegFrame(0xc0, 8, 9))), { width: 8, height: 9 }, 'a fill byte before a marker');
});

test('anything else, cut short or stating no size, has none', () => {
  for (const [what, head] of Object.entries({
    'nothing': Buffer.alloc(0),
    'noise': Buffer.from('not an image at all, and long enough to be read as one'),
    'a PNG cut short': png(10, 10).subarray(0, 20),
    'a PNG of no width': png(0, 10),
    'a PNG whose first chunk is not its header': bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'tEXt', u32be(10), u32be(10)),
    'a GIF cut short': bytes('GIF89a', [1]),
    'a RIFF that is no WebP': bytes('RIFF', [0, 0, 0, 0], 'WAVE', Buffer.alloc(30)),
    'a WebP of an unknown chunk': riff(padded(bytes('ALPH'), 22)),
    'a lossy WebP without its start code': riff(padded(bytes('VP8 ', [0, 0, 0, 0]), 22)),
    'a lossless WebP without its signature': riff(padded(bytes('VP8L'), 22)),
    'a JPEG whose metadata runs past the head': bytes([0xff, 0xd8], [0xff, 0xe1], u16be(60_000), Buffer.alloc(100)),
    'a JPEG that scans before any frame': bytes([0xff, 0xd8], [0xff, 0xda], u16be(8), Buffer.alloc(20)),
    'a JPEG that ends before any frame': bytes([0xff, 0xd8], [0xff, 0xd9], Buffer.alloc(20)),
    'a JPEG that loses its place': bytes([0xff, 0xd8], Buffer.alloc(20, 0x41)),
  })) {
    assert.equal(imageSizeOf(head), null, what);
  }
});
