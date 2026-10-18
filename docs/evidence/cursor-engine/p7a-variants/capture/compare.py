"""Side-by-side sheets: each board frame (docs/mocks/cursor-engine/shots, the owner's confirmed board) on
the left, the implementation's real-page capture of the same scene (shots/) on the right, one sheet per
board and theme. Usage: python3 -I compare.py <board-shots-dir> <impl-shots-dir> <out-dir>"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

BOARD_DIR, IMPL_DIR, OUT = sys.argv[1:4]
FONT = '/var/tmp/cursor-engine-mock/fonts/Inter.ttf'
GROUPS = {
    'web-1-new-session': ['w1-engines-new', 'w1-row-not-installed', 'w1-row-signed-out', 'w1-row-update-runner', 'w1-row-version'],
    'web-2-infrastructure': ['w2-overview-new', 'w2-machine-folded', 'w2-machine-open', 'w2-state-not-installed', 'w2-state-update-runner',
                             'w2-state-signed-out', 'w2-state-wrong-version', 'w2-attention'],
    'web-3-add-account': ['w3-add-pending', 'w3-add-link', 'w3-add-expired', 'w3-add-done', 'w3-resign-menu', 'w3-resign-link',
                          'w3-remove-confirm', 'w3-remove-refused'],
    'web-4-api-key': ['w4-gallery-new', 'w4-connect', 'w4-connect-invalid', 'w4-connect-unreachable', 'w4-keys-new'],
    'web-5-session': ['w5-model-menu', 'w5-model-variant', 'w5-running', 'w5-running-pane', 'w5-context', 'w5-quota'],
    'web-6-modes-and-switch': ['w6-modes-a', 'w7-switch-blocked', 'w7-switch-draft', 'w7-switch-open'],
}
PAD, GAP, HEAD = 32, 48, 64
os.makedirs(OUT, exist_ok=True)
font = ImageFont.truetype(FONT, 30)
small = ImageFont.truetype(FONT, 24)
index = {}

for group, scenes in GROUPS.items():
    for theme in ('light', 'dark'):
        bg, fg, sub = ((246, 247, 249), (31, 35, 41), (100, 106, 115)) if theme == 'light' else ((24, 25, 27), (225, 228, 232), (150, 155, 162))
        rows = []
        for name in scenes:
            board = os.path.join(BOARD_DIR, f'{name}-{theme}.png')
            impl = os.path.join(IMPL_DIR, f'{name}-{theme}.png')
            if not os.path.exists(impl):
                print('missing capture', name, theme)
                continue
            left = Image.open(board).convert('RGB') if os.path.exists(board) else None
            right = Image.open(impl).convert('RGB')
            rows.append((name, left, right))
        if not rows:
            continue
        col = max(max((l.width if l else 0) for _, l, _ in rows), max(r.width for _, _, r in rows))
        width = PAD * 2 + col * 2 + GAP
        height = PAD + HEAD + sum(HEAD + max(l.height if l else 0, r.height) + GAP for _, l, r in rows)
        sheet = Image.new('RGB', (width, height), bg)
        draw = ImageDraw.Draw(sheet)
        draw.text((PAD, PAD), f'{group} · {theme} · left: the board frame (docs/mocks/cursor-engine/shots) · right: the implementation', fill=fg, font=font)
        y = PAD + HEAD
        for name, left, right in rows:
            draw.text((PAD, y), f'{name} — board', fill=sub, font=small)
            draw.text((PAD + col + GAP, y), f'{name} — implementation', fill=sub, font=small)
            y += HEAD // 2 + 8
            if left:
                sheet.paste(left, (PAD, y))
            else:
                draw.text((PAD, y), '(no board frame of its own)', fill=sub, font=small)
            sheet.paste(right, (PAD + col + GAP, y))
            y += max(left.height if left else 0, right.height) + GAP + HEAD // 2 - 8
        out = os.path.join(OUT, f'compare-{group}-{theme}.png')
        sheet = sheet.crop((0, 0, width, y))
        sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(out, optimize=True)
        index[f'{group}-{theme}'] = [name for name, _, _ in rows]
        print(out, sheet.size)

with open(os.path.join(OUT, 'compare-index.json'), 'w') as f:
    json.dump(index, f, indent=1)
