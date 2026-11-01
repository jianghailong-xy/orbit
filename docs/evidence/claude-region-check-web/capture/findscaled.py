"""findscaled.py: the scaled crop web-session-first was cut from s-A: for each candidate crop width, scale the capture
so that width becomes the shot's, then search as findcrop.py does. Prints the best crop in CSS px."""
import json
import numpy as np
from PIL import Image
S = Image.open('/root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f/docs/mocks/claude-region-check/shots/web-session-first.png')
C = Image.open('/var/tmp/region-gate-mock/shots/s-A.png')
sw, sh = S.size; cw, ch = C.size
g = lambda im: np.asarray(im.convert('L'), dtype=np.float32)
s4 = g(S.resize((sw // 4, sh // 4), Image.BOX))
best = None
for crop_w in range(1100, 1420, 8):
    k = sw / crop_w
    Ck = C.resize((round(cw * k), round(ch * k)), Image.BOX)
    c4 = g(Ck.resize((Ck.size[0] // 4, Ck.size[1] // 4), Image.BOX))
    if c4.shape[0] < s4.shape[0] or c4.shape[1] < s4.shape[1]: continue
    for y in range(0, c4.shape[0] - s4.shape[0] + 1):
        for x in range(0, c4.shape[1] - s4.shape[1] + 1):
            d = np.abs(c4[y:y + s4.shape[0], x:x + s4.shape[1]] - s4).mean()
            if best is None or d < best[0]: best = (d, crop_w, x * 4 / k, y * 4 / k)
d, crop_w, x, y = best
print('best', round(float(d), 3), 'crop_w px', crop_w, 'x,y px', round(x), round(y), '=> css', [x / 2, y / 2, (x + crop_w) / 2, (y + crop_w * sh / sw) / 2])
crops = json.load(open('/mnt/data/tmp/34pVMqv27RB2CakEffAzt/compare/crops.json'))
crops['web-session-first'] = {'capture': 's-A', 'scale': sw / crop_w, 'crop': [round(x / 2), round(y / 2), round((x + crop_w) / 2), round((y + crop_w * sh / sw) / 2)], 'meanAbsDiff4': round(float(d), 3)}
json.dump(crops, open('/mnt/data/tmp/34pVMqv27RB2CakEffAzt/compare/crops.json', 'w'), indent=1)
