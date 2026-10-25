# mkpinch.py CX CY D0 D1 FRAMES OUTDIR: evdev frames (multi-touch protocol B) for two fingers on a horizontal line through
# (CX, CY) display px, moving apart from D0 to D1 px from the centre (D1 < D0 pinches in); f000 puts both down, the
# last frame lifts both. Written to /dev/input/event2 (virtio_input_multi_touch_1, display 0, 0..32767) as root.
import os, struct, sys
cx, cy, d0, d1, n, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
os.makedirs(out, exist_ok=True)
ev = lambda t, c, v: struct.pack('<qqHHi', 0, 0, t, c, v)
X = lambda x: x * 32767 // 1080
Y = lambda y: y * 32767 // 2400
SYN = ev(0, 0, 0)
def frame(d, first=False):
    b = b''
    for slot, sign in ((0, -1), (1, 1)):
        b += ev(3, 47, slot)
        if first: b += ev(3, 57, 500 + slot)
        b += ev(3, 53, X(cx + sign * d)) + ev(3, 54, Y(cy))
        if first: b += ev(3, 58, 512) + ev(3, 48, 5)
    return b + SYN
open(f'{out}/f000', 'wb').write(frame(d0, True))
for i in range(1, n + 1):
    open(f'{out}/f{i:03d}', 'wb').write(frame(round(d0 + (d1 - d0) * i / n)))
open(f'{out}/f{n + 1:03d}', 'wb').write(ev(3, 47, 0) + ev(3, 58, 0) + ev(3, 57, -1) + ev(3, 47, 1) + ev(3, 58, 0) + ev(3, 57, -1) + SYN)
