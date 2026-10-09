"""Side-by-side boards for T6's evidence: the owner-confirmed T0 design (left) next to the real web
console (right), one PNG per screen and theme, at 1x, palette-quantized like T0's own render.

usage: python3 -I compare.py <shots-dir> <out-dir> <commit>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SHOTS, OUT, COMMIT = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
FONT = '/mnt/data/pe-mock/fonts/NotoSansSC.ttf'
OUT.mkdir(parents=True, exist_ok=True)

# (file stem, title, design shots, implementation shots) — several shots on a side are stacked.
SCREENS = [
    ('01-overview', '引擎概览：六个 engine，一把 key 列在它能跑的每个 engine 下', ['board-infra-overview'], ['infra-overview']),
    ('02-machines', 'Machines：每台机器的卡片最后一行是 DeepSeek Harness', ['board-infra-machines'], ['infra-machines']),
    ('03-keys', 'API keys：按厂商分组，每把 key 写可用 engine，余额行保留', ['board-infra-keys'], ['infra-keys']),
    ('04-gallery', '画廊：只放厂商，没有 DeepSeek Harness 一格', ['board-infra-gallery'], ['infra-gallery']),
    ('05-dsh-states', 'DeepSeek Harness 在各台机器上的四种状态；没有 DeepSeek key、没有 OpenCode 时的概览卡片',
     ['board-dsh-states'],
     ['dsh-hpc', 'dsh-old-mac', 'dsh-build-box', 'dsh-mac-studio', 'notsetup-dsh', 'notsetup-opencode']),
    ('06-connect', 'Connect DeepSeek（经旧地址 /providers/new/deepseek-harness 进入，已有一把 DeepSeek key，展开 Advanced）',
     ['board-connect'], ['connect']),
    ('07-edit', 'DeepSeek key 的页面：Works with 每行带用量（待定项 ② 选 A），左下角 Delete key', ['board-edit'], ['edit']),
    ('08-dialogs', '停用、删除前的影响确认（待定项 ② 选 A）', ['board-dialogs'], ['dialog-turnoff', 'dialog-delete']),
    ('09-refused', '改 endpoint 被服务端拒绝（PROVIDER_DIALECT_IN_USE），原文显示在按钮上方', ['board-refused'], ['refused']),
    ('00-page', '整页 /infrastructure（缩小一半）', ['board-infra'], ['infra']),
]


def stack(stems, theme, gap=24):
    ims = [Image.open(SHOTS / f'{stem}-{theme}.png').convert('RGB') for stem in stems]
    width = max(im.width for im in ims)
    out = Image.new('RGB', (width, sum(im.height for im in ims) + gap * (len(ims) - 1)), (255, 255, 255) if theme == 'light' else (24, 26, 31))
    y = 0
    for im in ims:
        out.paste(im, (0, y))
        y += im.height + gap
    return out


def scaled(im, factor):
    return im.resize((max(1, round(im.width * factor)), max(1, round(im.height * factor))), Image.LANCZOS)


for stem, title, design, real in SCREENS:
    for theme in ('light', 'dark'):
        # Captures are 2x: the full page is drawn at half of 1x, everything else at 1x.
        factor = 0.25 if stem == '00-page' else 0.5
        left = scaled(stack(design, theme), factor)
        right = scaled(stack(real, theme), factor)
        pad, head, gutter = 24, 76, 32
        bg = (255, 255, 255) if theme == 'light' else (18, 19, 23)
        fg = (20, 22, 28) if theme == 'light' else (232, 234, 238)
        sub = (110, 116, 128) if theme == 'light' else (150, 156, 168)
        width = pad * 2 + left.width + gutter + right.width
        height = head + max(left.height, right.height) + pad
        board = Image.new('RGB', (width, height), bg)
        draw = ImageDraw.Draw(board)
        draw.text((pad, 14), title, font=ImageFont.truetype(FONT, 20), fill=fg)
        small = ImageFont.truetype(FONT, 14)
        draw.text((pad, 46), f'设计图（T0，docs/mocks/provider-engine-decoupling，7a1908198，{theme}）', font=small, fill=sub)
        draw.text((pad + left.width + gutter, 46), f'实现（T6，{COMMIT}，vite 构建 + 假 /api，Chromium，{theme}）', font=small, fill=sub)
        board.paste(left, (pad, head))
        board.paste(right, (pad + left.width + gutter, head))
        draw.line([(pad + left.width + gutter // 2, head), (pad + left.width + gutter // 2, height - pad)], fill=sub, width=1)
        board.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(OUT / f'{stem}-{theme}.png', optimize=True)
        print(f'{stem}-{theme}.png {board.width}x{board.height}')
