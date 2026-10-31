"""findcrop.py: where each board 02 shot was cut from the board kit's own full capture (same 2x pixels, no scaling),
found by a coarse SAD search at 1/4 scale refined at full scale. Prints the crop in CSS px."""
import sys, json
import numpy as np
from PIL import Image
pairs = {
    'web-session-first': 's-A', 'web-picker-closed': 'hero-new', 'web-provider-menu': 'prov-new',
    'web-session-held': 's-B', 'web-machine-today': 'mm-today', 'web-machine-new': 'mm-new',
}
shots = '/root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f/docs/mocks/claude-region-check/shots'
caps = '/var/tmp/region-gate-mock/shots'
out = {}
def gray(im): return np.asarray(im.convert('L'), dtype=np.float32)
for shot, cap in pairs.items():
    S = Image.open(f'{shots}/{shot}.png'); C = Image.open(f'{caps}/{cap}.png')
    sw, sh = S.size; cw, ch = C.size
    if (sw, sh) == (cw, ch) or sw > cw or sh > ch:
        # The same size or larger: a scaled copy of the whole capture.
        out[shot] = {'capture': cap, 'scale': sw / cw, 'crop': [0, 0, cw // 2, ch // 2]}
        print(shot, 'whole capture, scale', round(sw / cw, 4)); continue
    s4 = gray(S.resize((sw // 4, sh // 4), Image.BOX)); c4 = gray(C.resize((cw // 4, ch // 4), Image.BOX))
    best = None
    for y in range(0, c4.shape[0] - s4.shape[0] + 1):
        for x in range(0, c4.shape[1] - s4.shape[1] + 1, 1):
            d = np.abs(c4[y:y + s4.shape[0], x:x + s4.shape[1]] - s4).mean()
            if best is None or d < best[0]: best = (d, x, y)
    _, bx, by = best
    sf = gray(S); cf = gray(C); fine = None
    for y in range(max(0, by * 4 - 6), min(ch - sh, by * 4 + 6) + 1):
        for x in range(max(0, bx * 4 - 6), min(cw - sw, bx * 4 + 6) + 1):
            d = np.abs(cf[y:y + sh, x:x + sw] - sf).mean()
            if fine is None or d < fine[0]: fine = (d, x, y)
    d, x, y = fine
    out[shot] = {'capture': cap, 'scale': 1.0, 'crop': [x / 2, y / 2, (x + sw) / 2, (y + sh) / 2], 'meanAbsDiff': round(float(d), 3)}
    print(shot, out[shot])
json.dump(out, open('/mnt/data/tmp/34pVMqv27RB2CakEffAzt/compare/crops.json', 'w'), indent=1)
