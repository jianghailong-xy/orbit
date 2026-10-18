"""Side-by-side sheets: each phone of the owner's iOS board (docs/mocks/cursor-engine/ios-*.html, cut out by frames.mjs) on the left,
the emulator's capture of the same scene (shots/) on the right, both at one height, one sheet per board and theme.
Usage: python3 -I compare.py <board-frames-dir> <shots-dir> <out-dir>"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FRAMES, SHOTS, OUT = sys.argv[1:4]
FONT = '/var/tmp/cursor-engine-mock/fonts/Inter.ttf'
HEIGHT = 1000
# Each capture and the board phone it is drawn after (ios-<n>-<board>-<phone>). The boards' "now" phones (main before Cursor CLI) and
# D6's option B, which the owner did not choose, have no capture.
GROUPS = {
    'ios-1-new-session': [('ios1-engines', 2), ('ios1-new-session', 3), ('ios1-row-not-installed', 4), ('ios1-row-signed-out', 4),
                          ('ios1-row-update-runner', 4), ('ios1-row-wrong-version', 4)],
    'ios-2-infrastructure': [('ios2-infrastructure', 1), ('ios2-machine', 2), ('ios2-engine-page', 3), ('ios2-state-not-installed', 4),
                             ('ios2-state-not-installed-page', 4), ('ios2-state-signed-out', 4), ('ios2-state-update-runner', 4),
                             ('ios2-state-wrong-version', 4), ('ios2-state-wrong-version-page', 4)],
    'ios-3-add-account': [('ios3-add-pending', 1), ('ios3-add-link', 2), ('ios3-add-expired', 3), ('ios3-add-done', 4),
                          ('ios3-account-menu', 5), ('ios3-resign-link', 6), ('ios3-remove-confirm', 7), ('ios3-remove-refused', 8)],
    'ios-4-api-key': [('ios4-keys', 2), ('ios4-key-valid', 3), ('ios4-key-rejected', 4)],
    'ios-5-session': [('ios5-model-auto', 1), ('ios5-model-variant', 2), ('ios5-chip', 2), ('ios5-running', 3), ('ios5-context', 4),
                      ('ios5-quota', 5)],
    'ios-6-modes-and-switch': [('ios6-modes', 2), ('ios6-switch-blocked', 4), ('ios6-switch-open', 5)],
}
PAD, GAP, HEAD = 32, 48, 56
os.makedirs(OUT, exist_ok=True)
font = ImageFont.truetype(FONT, 28)
small = ImageFont.truetype(FONT, 22)


def scaled(path):
    img = Image.open(path).convert('RGB')
    return img.resize((round(img.width * HEIGHT / img.height), HEIGHT), Image.Resampling.LANCZOS)


index = {}
for board, scenes in GROUPS.items():
    for theme in ('light', 'dark'):
        bg, fg, sub = ((246, 247, 249), (31, 35, 41), (100, 106, 115)) if theme == 'light' else ((24, 25, 27), (225, 228, 232), (150, 155, 162))
        rows = []
        for name, phone in scenes:
            shot = os.path.join(SHOTS, f'{name}-{theme}.png')
            if not os.path.exists(shot):
                print('missing capture', name, theme)
                continue
            rows.append((name, phone, scaled(os.path.join(FRAMES, f'{board}-{phone}-{theme}.png')), scaled(shot)))
        if not rows:
            continue
        col = max(max(left.width, right.width) for _, _, left, right in rows)
        width = PAD * 2 + col * 2 + GAP
        sheet = Image.new('RGB', (width, PAD + HEAD + len(rows) * (HEAD + HEIGHT + GAP)), bg)
        draw = ImageDraw.Draw(sheet)
        draw.text((PAD, PAD), f'{board} · {theme} · left: the board · right: Android on the emulator', fill=fg, font=font)
        y = PAD + HEAD
        for name, phone, left, right in rows:
            draw.text((PAD, y), f'{board} phone {phone}', fill=sub, font=small)
            draw.text((PAD + col + GAP, y), name, fill=sub, font=small)
            y += HEAD
            sheet.paste(left, (PAD, y))
            sheet.paste(right, (PAD + col + GAP, y))
            y += HEIGHT + GAP
        out = os.path.join(OUT, f'compare-{board}-{theme}.png')
        sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(out, optimize=True)
        index[f'{board}-{theme}'] = [f'{name} ← phone {phone}' for name, phone, _, _ in rows]
        print(out, sheet.size)

with open(os.path.join(OUT, 'compare-index.json'), 'w') as f:
    json.dump(index, f, indent=1, ensure_ascii=False)
