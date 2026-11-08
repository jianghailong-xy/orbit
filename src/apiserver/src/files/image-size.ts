/**
 * How much of a file is read to find its size. PNG, GIF and WebP state it in their first 30 bytes; a JPEG states it after
 * its metadata, which a camera can make long, and one that needs more than this goes without.
 */
export const IMAGE_HEADER_BYTES = 256 * 1024;

export interface ImageSize {
  width: number;
  height: number;
}

function pngSize(head: Buffer): ImageSize | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length < 24 || !head.subarray(0, 8).equals(signature) || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function gifSize(head: Buffer): ImageSize | null {
  if (head.length < 10 || !['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6))) return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

function webpSize(head: Buffer): ImageSize | null {
  if (head.length < 30 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') return null;
  switch (head.toString('latin1', 12, 16)) {
    case 'VP8 ':
      if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return null;
      return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    case 'VP8L': {
      if (head[20] !== 0x2f) return null;
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/** Every start-of-frame marker: 0xC0 to 0xCF, less the three that share the range and are something else. */
function isJpegFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function jpegSize(head: Buffer): ImageSize | null {
  if (head[0] !== 0xff || head[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 <= head.length) {
    if (head[at] !== 0xff) return null;
    const marker = head[at + 1];
    if (marker === 0xff) {
      at += 1; // A fill byte before the marker.
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // A marker with no segment behind it.
    } else if (marker === 0xd9 || marker === 0xda) {
      return null; // The image ended, or its scan began, with no frame stated.
    } else if (isJpegFrame(marker)) {
      return { height: head.readUInt16BE(at + 5), width: head.readUInt16BE(at + 7) };
    } else {
      at += 2 + head.readUInt16BE(at + 2);
    }
  }
  return null;
}

/**
 * An image's size in pixels as its own first bytes state it, or null when they are no PNG, GIF, WebP or JPEG, or stop
 * first. The bytes decide and never the type a client declared. Nothing here decodes an image, so the size is what the
 * file says and need not be what a decoder would draw.
 */
export function imageSizeOf(head: Buffer): ImageSize | null {
  const size = pngSize(head) ?? gifSize(head) ?? webpSize(head) ?? jpegSize(head);
  return size && size.width > 0 && size.height > 0 ? size : null;
}
