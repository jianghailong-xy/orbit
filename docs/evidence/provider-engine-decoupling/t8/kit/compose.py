"""Side-by-side boards for T8's evidence: each owner-confirmed T0 iPhone frame (left of a pair) next to the
iPhone app on the simulator (right), at 1x, one PNG per board and theme, palette-quantized like T7's.

usage: python3 -I compose.py <board-frames-dir> <shots-dir> <out-dir> <commit>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOARDS, SHOTS, OUT, COMMIT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
FONT = '/mnt/data/pe-mock/fonts/NotoSansSC.ttf'
OUT.mkdir(parents=True, exist_ok=True)

# (file stem, title, pairs); a pair is (caption, board frame, simulator shot).
SCREENS = [
    ('ios1-infrastructure', 'Board iOS 1 · Infrastructure: a key under every engine it runs on; the API keys say where they run', [
        ('① ② The overview: six engines, OpenCode and DeepSeek Harness included',
         'board-ios1-overview', 'ios1-b-infrastructure-overview'),
        ('③ ④ API keys by vendor, each with the engines it runs on', 'board-ios1-keys', 'ios1-d-infrastructure-keys'),
        ("⑤ hpc's engines: DeepSeek Harness in its own mark", 'board-ios1-machine', 'ios1-e-machine-hpc-engines'),
        ("⑥ ⑦ DeepSeek Harness's page: no sign-in, a DeepSeek key per session", 'board-ios1-dsh-engine',
         'ios1-f-deepseek-harness-engine-page'),
    ]),
    ('ios2-deepseek-key', "Board iOS 2 · A DeepSeek key's page: Works with its engines, then the key itself", [
        ('The balance, unchanged', 'board-ios2-key-top', 'ios2-a-deepseek-key-top'),
        ('Works with · Key (protocol, default model, endpoint) · what turning it off stops',
         'board-ios2-key-works-with', 'ios2-b-deepseek-key-works-with'),
    ]),
    ('ios4-new-session', 'Board iOS 4 · A new session: the engine, then a provider it runs', [
        ('① The Engine sheet, by CLI names (DeepSeek Harness picked)', 'board-ios4-engine-sheet', 'ios4-a-engine-sheet'),
        ('② No DeepSeek key: "Connect a DeepSeek key"', 'board-ios4-engine-sheet-no-key',
         'ios4-b-engine-sheet-no-deepseek-key'),
        ('③ DeepSeek Harness: its DeepSeek keys', 'board-ios4-provider-dsh', 'ios4-c-provider-deepseek-harness'),
        ('④ Claude Code: signed in on hpc, account pools, API keys', 'board-ios4-provider-claude-code',
         'ios4-d-provider-claude-code'),
        ("⑤ OpenCode: its own sign-in, the keys it runs, why Claude Max isn't there", 'board-ios4-provider-opencode',
         'ios4-e-provider-opencode'),
    ]),
    ('ios5-session-provider', "Board iOS 5 · Switching provider in a session: only its engine's credentials", [
        ('① A DeepSeek Harness session: the two DeepSeek keys', 'board-ios5-session-dsh',
         'ios5-a-session-provider-deepseek-harness'),
        ('② ③ Its key deleted: still DeepSeek Harness, "Key deleted", the keys that fix it',
         'board-ios5-session-key-deleted', 'ios5-b-session-key-deleted'),
    ]),
]

# (file stem, title, shots): screens no board frame draws, each alone.
EXTRA = [
    ('ios-more', 'What the boards leave out of a frame', [
        ('iOS 1 · The page\'s top: Needs you, then the first engines', 'ios1-a-infrastructure-top'),
        ('iOS 1 · Machines, under the overview', 'ios1-c-infrastructure-machines'),
        ('iOS 4 · The Engine sheet pulled up: its footer and its note', 'ios4-a2-engine-sheet-large'),
    ]),
]

HEIGHT = 874  # an iPhone 17 Pro's screen in points: both sides of a pair at 1x


def palette(theme):
    if theme == 'light':
        return (255, 255, 255), (20, 22, 28), (110, 116, 128)
    return (18, 19, 23), (232, 234, 238), (150, 156, 168)


def phone(path):
    im = Image.open(path).convert('RGB')
    return im.resize((max(1, round(im.width * HEIGHT / im.height)), HEIGHT), Image.LANCZOS)


missing = []
for stem, title, pairs in SCREENS:
    for theme in ('light', 'dark'):
        bg, fg, sub = palette(theme)
        cells = []
        for caption, board, shot in pairs:
            b, s = BOARDS / f'{board}-{theme}.png', SHOTS / f'{shot}-{theme}.png'
            if not b.exists() or not s.exists():
                missing += [str(p) for p in (b, s) if not p.exists()]
                continue
            cells.append((caption, phone(b), phone(s)))
        if not cells:
            continue
        pad, head, cap, inner, gutter, per_row = 28, 84, 34, 16, 48, 2
        pair_w = max(left.width + inner + right.width for _, left, right in cells)
        rows = [cells[i:i + per_row] for i in range(0, len(cells), per_row)]
        width = pad * 2 + pair_w * min(per_row, len(cells)) + gutter * (min(per_row, len(cells)) - 1)
        height = pad + head + len(rows) * (cap + 22 + HEIGHT) + (len(rows) - 1) * gutter + pad
        out = Image.new('RGB', (width, height), bg)
        draw = ImageDraw.Draw(out)
        big, small = ImageFont.truetype(FONT, 26), ImageFont.truetype(FONT, 17)
        draw.text((pad, pad), title, font=big, fill=fg)
        draw.text((pad, pad + 40), f'Left of each pair: the T0 board (7a1908198). Right: the iPhone app on the simulator, '
                                   f'built from {COMMIT}. {theme.capitalize()}.', font=small, fill=sub)
        y = pad + head
        for row in rows:
            x = pad
            for caption, left, right in row:
                draw.text((x, y), caption, font=small, fill=fg)
                out.paste(left, (x, y + cap + 22))
                out.paste(right, (x + left.width + inner, y + cap + 22))
                x += pair_w + gutter
            y += cap + 22 + HEIGHT + gutter
        out.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(OUT / f'{stem}-{theme}.png', optimize=True)
        print(f'{stem}-{theme}.png', out.size)
for stem, title, shots in EXTRA:
    for theme in ('light', 'dark'):
        bg, fg, sub = palette(theme)
        cells = []
        for caption, shot in shots:
            path = SHOTS / f'{shot}-{theme}.png'
            if not path.exists():
                missing.append(str(path))
                continue
            cells.append((caption, phone(path)))
        if not cells:
            continue
        pad, head, cap, gutter, per_row = 28, 84, 34, 40, 3
        cell_w = max(max(im.width for _, im in cells), 520)
        rows = [cells[i:i + per_row] for i in range(0, len(cells), per_row)]
        width = pad * 2 + cell_w * min(per_row, len(cells)) + gutter * (min(per_row, len(cells)) - 1)
        height = pad + head + len(rows) * (cap + 22 + HEIGHT) + (len(rows) - 1) * gutter + pad
        out = Image.new('RGB', (width, height), bg)
        draw = ImageDraw.Draw(out)
        big, small = ImageFont.truetype(FONT, 26), ImageFont.truetype(FONT, 17)
        draw.text((pad, pad), title, font=big, fill=fg)
        draw.text((pad, pad + 40), f'The iPhone app on the simulator, built from {COMMIT}. {theme.capitalize()}.',
                  font=small, fill=sub)
        y = pad + head
        for row in rows:
            x = pad
            for caption, im in row:
                draw.text((x, y), caption, font=small, fill=fg)
                out.paste(im, (x, y + cap + 22))
                x += cell_w + gutter
            y += cap + 22 + HEIGHT + gutter
        out.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(OUT / f'{stem}-{theme}.png', optimize=True)
        print(f'{stem}-{theme}.png', out.size)
if missing:
    print('missing:', *missing, sep='\n  ')
    sys.exit(1)
