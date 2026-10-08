"""Side-by-side boards: the design's frames (docs/mocks/kimi-accounts) beside the Android emulator's captures.

Usage: python3 -I compare.py <repo> <captures dir> <out dir>
Writes compare-1-site.png, compare-2-accounts.png, compare-3-next.png and the captures it used, scaled to 540 px wide.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

repo, captures, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
design = Image.open(os.path.join(repo, 'docs/mocks/kimi-accounts/02-ios.png')).convert('RGB')
FONT = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
title_font = ImageFont.truetype(FONT, 34)
label_font = ImageFont.truetype(FONT, 24)
HEIGHT = 1100
PAD = 28

# 02-ios frames, located by their phone bezels (x 106–940, 1000–1834, 1894–2728, 2788–3620).
FRAMES = {
    'one-account': (1000, 420, 1834, 2180),
    'add-account': (1894, 420, 2728, 2180),
    'device-code': (2788, 420, 3620, 2180),
    'two-accounts': (106, 2690, 940, 4600),
    'runner-next': (1000, 2705, 1834, 4470),
    'sign-in-again': (1894, 2705, 2728, 4470),
    'runner-rows': (2788, 2690, 3620, 4470),
}


def frame(name):
    return design.crop(FRAMES[name])


def capture(name):
    image = Image.open(os.path.join(captures, name + '.png')).convert('RGB')
    small = image.resize((540, round(image.height * 540 / image.width)), Image.LANCZOS)
    small.save(os.path.join(out, name + '.png'), optimize=True)
    return image


def wrap(text, width):
    """The label in lines no wider than its picture, broken between characters (the labels mix Chinese and English)."""
    lines, line = [], ''
    for ch in text:
        if line and label_font.getlength(line + ch) > width:
            # Prefer the last space or punctuation in the second half of the line, so a word stays whole.
            cut = max(line.rfind(mark) for mark in ' ：，、）·→')
            if cut > len(line) // 2:
                lines.append(line[:cut + 1].rstrip())
                line = line[cut + 1:].lstrip() + ch
            else:
                lines.append(line)
                line = ch.lstrip()
        else:
            line += ch
    return lines + [line]


def board(path, title, groups):
    """groups: [(heading, [(label, image)])] laid out left to right, each image scaled to HEIGHT (a wide one to 1000 px)."""
    cells = []
    for heading, items in groups:
        for index, (label, image) in enumerate(items):
            scale = min(HEIGHT / image.height, 1000 / image.width)
            scaled = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
            cells.append((heading if index == 0 else None, label, scaled))
    width = PAD + sum(cell[2].width + PAD for cell in cells)
    canvas = Image.new('RGB', (width, HEIGHT + 230), (246, 246, 248))
    draw = ImageDraw.Draw(canvas)
    draw.text((PAD, 18), title, font=title_font, fill=(20, 20, 24))
    x = PAD
    for heading, label, scaled in cells:
        if heading:
            draw.text((x, 76), heading, font=label_font, fill=(196, 92, 0) if heading.startswith('设计') else (30, 90, 200))
        for row, line in enumerate(wrap(label, scaled.width)[:3]):
            draw.text((x, 112 + row * 30), line, font=label_font, fill=(70, 70, 76))
        canvas.paste(scaled, (x, 210))
        x += scaled.width + PAD
    canvas.save(path, optimize=True)


board(os.path.join(out, 'compare-1-site.png'), '① Kimi 先选站点：单账号登录、Sign In Again、加账号（先起名再选站点）、设备码写站点、Use … instead、旧 runner', [
    ('设计图 02-ios', [('点 Add Account：Account 2 + 两个站点', frame('add-account')),
                      ('选了 kimi.com：设备码写站点', frame('device-code')),
                      ('Work → Sign In Again：Current 是它自己的站点', frame('sign-in-again'))]),
    ('Android 模拟器', [('Default → Sign In Again（单账号）：Current kimi.ai', capture('kimi-sign-in-again-default')),
                      ('Add Account：Account 2，先起名再选站点', capture('kimi-add-account')),
                      ('选 kimi.com：设备码写站点（名字用预填的 Account 2）', capture('kimi-add-device-code')),
                      ('Use kimi.ai instead：同名换站点', capture('kimi-add-use-instead')),
                      ('Work → Sign In Again：Current kimi.com', capture('kimi-sign-in-again-work')),
                      ('旧 runner：Sign-In，kimi.ai 被拒并提示升级', capture('kimi-old-runner'))]),
])
board(os.path.join(out, 'compare-2-accounts.png'), '② 两个账号的站点和额度（每个账号三条：5h / Weekly / Monthly，月度只画总额）', [
    ('设计图 02-ios', [('一个账号：站点 · 目录、三条额度、Add Account', frame('one-account')),
                      ('两个账号：Default kimi.ai，Work kimi.com（5h 91% 变橙）', frame('two-accounts')),
                      ('运行器页：2 accounts signed in + Next: Default', frame('runner-next')),
                      ('运行器页 Kimi 行（单账号写站点）', frame('runner-rows'))]),
    ('Android 模拟器', [('一个账号', capture('kimi-engine-one')),
                      ('运行器页：2.1.1 · kimi.ai · Signed in', capture('kimi-runner-one')),
                      ('两个账号：Default kimi.ai，Work kimi.com（5h 91% 变橙）', capture('kimi-engine-two')),
                      ('运行器页：2 accounts signed in + Next: Default', capture('kimi-runner-two'))]),
])
web = Image.open(os.path.join(repo, 'docs/mocks/kimi-accounts/01e-two-open.png')).convert('RGB')
board(os.path.join(out, 'compare-3-next.png'), '③ 引擎页 NEXT 标记：四个引擎同一规则（只在两个及以上账号时出现）', [
    ('设计图 01-web（NEXT 标在账号名旁）', [('web：Default NEXT', web)]),
    ('Android 模拟器', [('Kimi Code：NEXT Default（Work 5h 91%）', capture('kimi-engine-two')),
                      ('Claude Code：NEXT Work', capture('next-claude')),
                      ('Codex：NEXT Second（Default 5h 85%）', capture('next-codex')),
                      ('Antigravity：NEXT Default', capture('next-antigravity')),
                      ('一个账号：没有 NEXT', capture('kimi-engine-one'))]),
])
print('ok')
