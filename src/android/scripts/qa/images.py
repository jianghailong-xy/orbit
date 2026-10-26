"""Byte-stable PNG, baseline JPEG and lossless WebP writers for the DS6 pictures (A02c).

Pure Python with no compressor library (zlib only for its CRC-32 and Adler-32 checksums), no Pillow
and no libwebp, so a file's SHA-256 depends only on the pixels: the same bytes on every machine and
Python version. That is what lets datasets.sha256 pin them. The trade is
the picture: a few colours in 8×8 blocks — enough to tell the twenty pictures apart on a screen and
to exercise each decoder, not a photograph.

  png(width, height, rows)     8-bit palette PNG; deflate with fixed codes and runs (distance 1)
  jpeg(width, height, blocks)  baseline 4:4:4 JPEG of uniform 8×8 blocks (DC terms only, Annex K tables)
  webp(width, height, rows)    VP8L with two values per channel (simple prefix codes, no transforms)

`rows` yields one list of palette indexes per scanline; `blocks` answers the RGB of block (bx, by).
"""
import re
import struct
import zlib


class Bits:
    """An LSB-first bit writer (deflate and VP8L read bits from the low end of each byte)."""

    def __init__(self):
        self.out = bytearray()
        self.acc = 0
        self.count = 0

    def put(self, value, bits):
        self.acc |= value << self.count
        self.count += bits
        if self.count >= 8:
            whole = self.count >> 3
            self.out += (self.acc & (1 << 8 * whole) - 1).to_bytes(whole, 'little')
            self.acc >>= 8 * whole
            self.count -= 8 * whole

    def done(self):
        if self.count:
            self.out.append(self.acc & 0xFF)
        self.acc = self.count = 0
        return bytes(self.out)


def _reverse(code, bits):
    out = 0
    for _ in range(bits):
        out = out << 1 | code & 1
        code >>= 1
    return out


def _fixed_literal(symbol):
    """RFC 1951 §3.2.6 fixed literal/length code, bit-reversed for the LSB-first writer."""
    if symbol < 144:
        return _reverse(0x30 + symbol, 8), 8
    if symbol < 256:
        return _reverse(0x190 + symbol - 144, 9), 9
    if symbol < 280:
        return _reverse(symbol - 256, 7), 7
    return _reverse(0xC0 + symbol - 280, 8), 8


LITERAL = [_fixed_literal(s) for s in range(288)]
# Length codes 257..285: (base length, extra bits).
LENGTHS = [(3, 0), (4, 0), (5, 0), (6, 0), (7, 0), (8, 0), (9, 0), (10, 0), (11, 1), (13, 1), (15, 1), (17, 1),
           (19, 2), (23, 2), (27, 2), (31, 2), (35, 3), (43, 3), (51, 3), (59, 3), (67, 4), (83, 4), (99, 4),
           (115, 4), (131, 5), (163, 5), (195, 5), (227, 5), (258, 0)]


def _length(bits, length):
    for index in range(len(LENGTHS) - 1, -1, -1):
        base, extra = LENGTHS[index]
        if length >= base:
            code, size = LITERAL[257 + index]
            bits.put(code, size)
            if extra:
                bits.put(length - base, extra)
            bits.put(0, 5)  # distance code 0 = distance 1 (fixed 5-bit codes, reversed 0 is 0)
            return


RUNS = re.compile(rb'(.)\1{0,258}', re.DOTALL)


def deflate(data):
    """zlib stream of one fixed-Huffman block: literals, and runs as copies at distance 1."""
    bits = Bits()
    bits.put(1, 1)  # BFINAL
    bits.put(1, 2)  # BTYPE 01, fixed codes
    for run in RUNS.finditer(data):
        code, size = LITERAL[data[run.start()]]
        bits.put(code, size)
        # The literal starts the run; the rest of it (at most 258) is one copy from a byte back.
        rest = run.end() - run.start() - 1
        if rest >= 3:
            _length(bits, rest)
        else:
            for _ in range(rest):
                bits.put(code, size)
    end, size = LITERAL[256]
    bits.put(end, size)
    return b'\x78\x01' + bits.done() + struct.pack('>I', zlib.adler32(data))


def _chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def png(width, height, palette, rows, pad_to=None):
    """A palette PNG. Each scanline is filtered Up, so a row that repeats the one above is all zeros.

    `pad_to` grows the file to exactly that many bytes with a private ancillary chunk (`orBt`), which
    every decoder skips: how DS6 gets valid pictures at the upload limits.
    """
    raw = bytearray()
    previous = bytes(width)
    for row in rows:
        row = bytes(row)
        raw.append(2)
        raw += bytes(width) if row == previous else bytes((a - b) & 0xFF for a, b in zip(row, previous))
        previous = row
    head = b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', struct.pack('>2I5B', width, height, 8, 3, 0, 0, 0))
    head += _chunk(b'PLTE', b''.join(bytes(rgb) for rgb in palette))
    body = _chunk(b'IDAT', deflate(bytes(raw))) + _chunk(b'IEND', b'')
    if pad_to is None:
        return head + body
    filler = pad_to - len(head) - len(body) - 12
    if filler < 0:
        raise ValueError(f'picture is already {len(head) + len(body)} bytes, over {pad_to}')
    return head + _chunk(b'orBt', bytes(filler)) + body


# ITU T.81 Annex K: (code lengths 1..16, values) of the four example tables.
DC_LUMA = ([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], list(range(12)))
DC_CHROMA = ([0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], list(range(12)))
AC_LUMA = ([0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D], [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71,
    0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83,
    0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3,
    0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3,
    0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA])
AC_CHROMA = ([0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22,
    0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0, 0x15, 0x62, 0x72, 0xD1,
    0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x35, 0x36,
    0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A,
    0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A,
    0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA,
    0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
    0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA])


def _codes(table):
    """Canonical Huffman codes {value: (code, length)} of a DHT table (T.81 Annex C)."""
    counts, values = table
    codes, code, k = {}, 0, 0
    for length, count in enumerate(counts, 1):
        for _ in range(count):
            codes[values[k]] = (code, length)
            code += 1
            k += 1
        code <<= 1
    return codes


class MsbBits:
    """JPEG's bit order: most significant bit first, a 0x00 stuffed after every 0xFF."""

    def __init__(self):
        self.out = bytearray()
        self.acc = 0
        self.count = 0

    def put(self, value, bits):
        self.acc = self.acc << bits | value & (1 << bits) - 1
        self.count += bits
        while self.count >= 8:
            self.count -= 8
            byte = self.acc >> self.count & 0xFF
            self.out.append(byte)
            if byte == 0xFF:
                self.out.append(0)
        self.acc &= (1 << self.count) - 1

    def done(self):
        if self.count:
            self.put((1 << 8 - self.count) - 1, 8 - self.count)  # pad with ones
        return bytes(self.out)


def _segment(marker, data):
    return struct.pack('>BBH', 0xFF, marker, len(data) + 2) + data


def _dht(kind, ident, table):
    counts, values = table
    return bytes([kind << 4 | ident]) + bytes(counts) + bytes(values)


def jpeg(width, height, blocks):
    """Baseline JPEG, three components at 1×1 sampling, every 8×8 block one colour.

    A uniform block has no AC terms, and with quantiser 1 its DC term is 8·(Y−128) exactly, so a
    decoder reproduces the block colour losslessly (up to its YCbCr→RGB rounding).
    """
    if width % 8 or height % 8:
        raise ValueError('JPEG blocks need sides that are multiples of 8')
    dc = [_codes(DC_LUMA), _codes(DC_CHROMA), _codes(DC_CHROMA)]
    eob = [_codes(AC_LUMA)[0], _codes(AC_CHROMA)[0], _codes(AC_CHROMA)[0]]
    previous = [0, 0, 0]
    bits = MsbBits()
    for by in range(height // 8):
        for bx in range(width // 8):
            r, g, b = blocks(bx, by)
            # JFIF YCbCr in 16-bit fixed point, rounded.
            y = 19595 * r + 38470 * g + 7471 * b + 32768 >> 16
            cb = -11059 * r - 21709 * g + 32768 * b + (128 << 16) + 32768 >> 16
            cr = 32768 * r - 27439 * g - 5329 * b + (128 << 16) + 32768 >> 16
            for component, value in enumerate((y, cb, cr)):
                term = 8 * (min(255, max(0, value)) - 128)
                diff = term - previous[component]
                previous[component] = term
                size = abs(diff).bit_length()
                code, length = dc[component][size]
                bits.put(code, length)
                if size:
                    bits.put(diff if diff > 0 else diff + (1 << size) - 1, size)
                code, length = eob[component]
                bits.put(code, length)
    head = b'\xFF\xD8' + _segment(0xE0, b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00')
    head += _segment(0xDB, b'\x00' + bytes([1] * 64))
    head += _segment(0xC0, struct.pack('>BHHB', 8, height, width, 3) + bytes([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]))
    head += _segment(0xC4, _dht(0, 0, DC_LUMA) + _dht(1, 0, AC_LUMA) + _dht(0, 1, DC_CHROMA) + _dht(1, 1, AC_CHROMA))
    head += _segment(0xDA, bytes([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]))
    return head + bits.done() + b'\xFF\xD9'


def webp(width, height, levels, rows):
    """Lossless WebP (VP8L) whose red, green and blue each take one of two `levels` (alpha 255).

    With two symbols a channel is a simple prefix code of one bit, so a pixel is three bits and no
    transform, colour cache or backward reference is needed. `rows` yields scanlines of 3-bit indexes:
    bit 2 red, bit 1 green, bit 0 blue, each choosing levels[channel][bit].
    """
    bits = Bits()
    bits.put(0x2F, 8)
    bits.put(width - 1, 14)
    bits.put(height - 1, 14)
    bits.put(0, 1)  # alpha_is_used
    bits.put(0, 3)  # version
    bits.put(0, 1)  # no transform
    bits.put(0, 1)  # no colour cache
    bits.put(0, 1)  # no meta prefix codes
    order = [1, 0, 2]  # VP8L codes green, red, blue, alpha, distance; levels are (red, green, blue)
    for channel in order:
        low, high = sorted(levels[channel])
        bits.put(1, 1)  # simple code
        bits.put(1, 1)  # two symbols
        bits.put(1, 1)  # first symbol in 8 bits
        bits.put(low, 8)
        bits.put(high, 8)
    for _ in range(2):  # alpha: the one symbol 255; distance: the one symbol 0 (both zero-length codes)
        bits.put(1, 1)
        bits.put(0, 1)
        bits.put(1, 1)
        bits.put(255 if _ == 0 else 0, 8)
    # A canonical code gives 0 to the smaller symbol, so a level's bit is whether it is the larger one.
    larger = [levels[c][1] > levels[c][0] for c in range(3)]
    flip = (not larger[1]) << 0 | (not larger[0]) << 1 | (not larger[2]) << 2
    packed = {}
    for row in rows:
        row = bytes(row)
        value = packed.get(row)
        if value is None:
            # A pixel is green, red, blue, one bit each from the low end; a row is one integer.
            value = 0
            for index in reversed(row):
                value = value << 3 | ((index >> 1 & 1) | (index >> 2 & 1) << 1 | (index & 1) << 2) ^ flip
            packed[row] = value
        bits.put(value, 3 * width)
    data = bits.done()
    chunk = b'VP8L' + struct.pack('<I', len(data)) + data + (b'\x00' if len(data) % 2 else b'')
    return b'RIFF' + struct.pack('<I', 4 + len(chunk)) + b'WEBP' + chunk
