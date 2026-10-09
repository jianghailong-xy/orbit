"""Side-by-side boards for T7's evidence: the owner-confirmed T0 design (left) next to the real web
console (right), one row per scene, one PNG per board and theme, at 1x, palette-quantized like T0's
own render.

usage: python3 -I compare.py <shots-dir> <out-dir> <commit>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SHOTS, OUT, COMMIT = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
FONT = '/mnt/data/pe-mock/fonts/NotoSansSC.ttf'
OUT.mkdir(parents=True, exist_ok=True)

# (file stem, title, rows); a row is (caption, design shots, implementation shots), shots on a side stacked.
SCREENS = [
    ('4a-new-session-engines', 'Board 4 · New session, step 1: the engine', [
        ('Mark 1 · One row per engine, by its CLI name, in ALL_ENGINES order (DeepSeek Harness picked)',
         ['board-new-hero'], ['new-hero']),
        ('Mark 6 · No DeepSeek key: the DeepSeek Harness row reads "Connect a DeepSeek key" and links /providers/new/deepseek',
         ['board-new-nokey'], ['new-nokey']),
    ]),
    ('4b-new-session-providers', 'Board 4 · New session, step 2: the Provider menu lists what the engine runs', [
        ('Mark 3 · DeepSeek Harness: every enabled DeepSeek key', ['board-new-dsh-provider'], ['new-dsh-provider']),
        ('Mark 4 · Claude Code: signed in on hpc, account pools, API keys', ['board-new-claude-provider'], ['new-claude-provider']),
        ("Mark 5 · OpenCode: its own sign-in, then the keys it runs; the subscription token's absence said",
         ['board-new-opencode-provider'], ['new-opencode-provider']),
    ]),
    ('5-composer-switch', "Board 5 · Switching provider in a session: only the session engine's credentials", [
        ('Mark 1 · A DeepSeek Harness session switches between the DeepSeek keys', ['board-switch-dsh-provider'], ['switch-dsh-provider']),
        ('Mark 2 · The note names the keys and says "uses" (a newer run of the task is going)', ['board-switch-note'], ['switch-note']),
        ("Mark 3 · The title is the session's engine: no arrow", ['board-switch-title'], ['switch-title']),
        ('Mark 4 · Its key deleted: still DeepSeek Harness, "Key deleted", the same-engine keys below', ['board-switch-deleted'], ['switch-deleted']),
    ]),
    ('6-task-pin', 'Board 6 · Task pin: an engine, then a credential it runs', [
        ("Mark 1 · Engine: the assignee's, or one of six", ['board-pin-engine'], ['pin-engine']),
        ('Mark 2 · Engine DeepSeek Harness: Engine default, then the DeepSeek keys', ['board-pin-dsh-provider'], ['pin-dsh-provider']),
        ('Mark 3 · Pinned: DeepSeek Harness, DeepSeek 2, DeepSeek V4 Pro', ['board-pin-collapsed'], ['pin-collapsed']),
        ('Mark 4 · Engine Claude Code: Engine default, account pools, the keys it runs', ['board-pin-claude-provider'], ['pin-claude-provider']),
        ('Mark 5 · A pin T4 migrated off deepseek-harness', ['board-pin-migrated'], ['pin-migrated']),
    ]),
    ('7-workspace-engines', 'Board 7 · Workspace settings: "Engines it may use" lists engines only', [
        ('orbit · last on Claude Code with the DeepSeek key', ['board-ws-orbit'], ['ws-orbit']),
        ('builds · last on DeepSeek Harness with DeepSeek 2', ['board-ws-builds'], ['ws-builds']),
    ]),
    ('8-repair-cards', 'Board 8 · Repair cards say "DeepSeek key" and name it', [
        ('Mark 1 · DeepSeek Harness with no DeepSeek key (in the transcript; below it, the run-never-started card)',
         ['board-card-dsh-nokey'], ['card-dsh-nokey', 'card-never-started']),
        ('Mark 2 · DeepSeek rejected the key "DeepSeek 2"', ['board-card-dsh-invalid'], ['card-dsh-invalid']),
        ('Mark 3 · Claude Code on the DeepSeek key "DeepSeek", rejected', ['board-card-claude-rejected'], ['card-claude-rejected']),
    ]),
]


def palette(theme):
    if theme == 'light':
        return (255, 255, 255), (20, 22, 28), (110, 116, 128)
    return (18, 19, 23), (232, 234, 238), (150, 156, 168)


def stack(stems, theme, gap=24):
    ims = [Image.open(SHOTS / f'{stem}-{theme}.png').convert('RGB') for stem in stems]
    ims = [im.resize((max(1, round(im.width / 2)), max(1, round(im.height / 2))), Image.LANCZOS) for im in ims]
    width = max(im.width for im in ims)
    out = Image.new('RGB', (width, sum(im.height for im in ims) + gap * (len(ims) - 1)), palette(theme)[0])
    y = 0
    for im in ims:
        out.paste(im, (0, y))
        y += im.height + gap
    return out


for stem, title, rows in SCREENS:
    for theme in ('light', 'dark'):
        bg, fg, sub = palette(theme)
        pairs = [(caption, stack(design, theme), stack(real, theme)) for caption, design, real in rows]
        pad, head, gutter, cap, gap = 24, 78, 32, 30, 28
        left_w = max(left.width for _, left, _ in pairs)
        right_w = max(right.width for _, _, right in pairs)
        width = pad * 2 + left_w + gutter + right_w
        height = head + sum(cap + max(left.height, right.height) + gap for _, left, right in pairs) + pad - gap
        board = Image.new('RGB', (width, height), bg)
        draw = ImageDraw.Draw(board)
        draw.text((pad, 14), title, font=ImageFont.truetype(FONT, 20), fill=fg)
        small = ImageFont.truetype(FONT, 14)
        draw.text((pad, 46), f'Design (T0 boards, docs/mocks/provider-engine-decoupling, {theme})', font=small, fill=sub)
        draw.text((pad + left_w + gutter, 46), f'Implementation (T7, {COMMIT}, vite build + fake /api, Chromium, {theme})', font=small, fill=sub)
        y = head
        for caption, left, right in pairs:
            draw.text((pad, y + 4), caption, font=small, fill=fg)
            y += cap
            board.paste(left, (pad, y))
            board.paste(right, (pad + left_w + gutter, y))
            row_h = max(left.height, right.height)
            draw.line([(pad + left_w + gutter // 2, y), (pad + left_w + gutter // 2, y + row_h)], fill=sub, width=1)
            y += row_h + gap
        board.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(OUT / f'{stem}-{theme}.png', optimize=True)
        print(f'{stem}-{theme}.png {board.width}x{board.height}')
