#!/usr/bin/env python3
"""emu-sheets.py RUN_DIR OUT_DIR: the emulator pass's screenshots side by side, reference | delivery, at half size
(540x1200 each, the device's 1080x2400), 256 colours: one sheet per step named in STEPS. Only reads RUN_DIR."""
import os
import sys
from PIL import Image

run, out = sys.argv[1:3]
STEPS = ['02-keyboard', '03-typed', '04-sent', '05-header-menu', '06-mode-list', '07-find', '08-plus-menu', '09-attached',
         '10-preview', '11-pinched', '12-press-menu', '14-not-found', '15-selection']
os.makedirs(out, exist_ok=True)
for step in STEPS:
    ref = Image.open(f'{run}/ref/{step}.png').convert('RGB').resize((540, 1200), Image.LANCZOS)
    dele = Image.open(f'{run}/del/{step}.png').convert('RGB').resize((540, 1200), Image.LANCZOS)
    sheet = Image.new('RGB', (1090, 1200), (255, 255, 255))
    sheet.paste(ref, (0, 0))
    sheet.paste(dele, (550, 0))
    sheet.quantize(256, dither=Image.Dither.NONE).save(f'{out}/{step}.png', optimize=True)
print(len(STEPS), 'sheets', sum(os.path.getsize(f'{out}/{s}.png') for s in STEPS) // 1024, 'KB')
