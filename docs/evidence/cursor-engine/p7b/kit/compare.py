"""Side-by-side sheets: each phone of the owner's iOS board (docs/mocks/cursor-engine/ios-*.html, cut out by P7c's
kit/frames.mjs) on the left, the iPhone simulator's capture of the same scene (shots/) on the right, both at one height,
one sheet per board and theme. P7c's compare.py with the iPhone's scenes.
Usage: python3 -I compare.py <board-frames-dir> <shots-dir> <out-dir>"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FRAMES, SHOTS, OUT = sys.argv[1:4]
FONT = '/var/tmp/cursor-engine-mock/fonts/Inter.ttf'
HEIGHT = 1000
# Each capture and the board phone it is drawn after (ios-<n>-<board>-<phone>). The boards' "now" phones (main before
# Cursor CLI) and D6's option B, which the owner did not choose, have no capture. A row of the engine sheet or the
# machine page is photographed on its own too (shots/), but sits here as the whole screen it is on.
GROUPS = {
    'ios-1-new-session': [('ios1-a-engine-sheet', 2), ('ios1-b-hero-cursor', 3),
                          ('ios1-c-row-not-installed-sheet', 4), ('ios1-d-row-signed-out-sheet', 4),
                          ('ios1-e-row-update-runner-sheet', 4), ('ios1-f-row-unsupported-version-sheet', 4)],
    'ios-2-infrastructure': [('ios2-a-infrastructure-cursor-card', 1), ('ios2-b-machine-hpc-cursor-row', 2),
                             ('ios2-c-cursor-engine-page', 3), ('ios2-c2-cursor-engine-page-footer', 3),
                             ('ios2-d-state-not-installed-page', 4), ('ios2-d-state-not-installed-engine-page', 4),
                             ('ios2-e-state-signed-out-page', 4), ('ios2-f-state-update-runner-page', 4),
                             ('ios2-g-state-unsupported-version-page', 4), ('ios2-g-state-unsupported-version-engine-page', 4)],
    'ios-3-add-account': [('ios3-a-add-pending', 1), ('ios3-b-add-link', 2), ('ios3-c-add-expired', 3), ('ios3-d-add-done', 4),
                          ('ios3-e-team-menu', 5), ('ios3-f-sign-in-again-link', 6), ('ios3-g-remove-confirm', 7),
                          ('ios3-h-remove-refused', 8)],
    'ios-4-api-key': [('ios4-a-api-keys', 2), ('ios4-b-cursor-key-valid', 3), ('ios4-c-cursor-key-rejected', 4),
                      ('ios4-d-cursor-key-checked-again', 4)],
    'ios-5-session': [('ios5-a-model-menu-auto', 1), ('ios5-a2-model-menu-auto-three-models', 1), ('ios5-b0-chip-opus', 2),
                      ('ios5-b-model-menu-opus', 2), ('ios5-b1-model-menu-opus-scrolled', 2),
                      ('ios5-b2-model-menu-opus-three-models', 2),
                      ('ios5-c-turn-running-queued', 3),
                      ('ios5-d-context-unavailable', 4), ('ios5-e-usage-limit', 5)],
    'ios-6-modes-and-switch': [('ios6-a-modes', 2), ('ios6-b-provider-blocked', 4), ('ios6-b1-provider-blocked-scrolled', 4),
                               ('ios6-c-provider-draft', 5)],
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
        draw.text((PAD, PAD), f'{board} · {theme} · left: the board · right: iPhone simulator', fill=fg, font=font)
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
