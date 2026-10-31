# Builds the board from shots/*.png + marks.json:
#   python3 -I gen.py <out-dir>
# Frames are cropped from the 2x shots and kept at 2x of their shown size (PIL BOX resample).
import json, sys, html
from pathlib import Path
from PIL import Image

K = Path('/var/tmp/wt-preview-mock')
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else K / 'board')
(OUT / 'frames').mkdir(parents=True, exist_ok=True)
MARKS = json.loads((K / 'marks.json').read_text())


def bx(scene, key):
    return MARKS[scene]['boxes'][key]


def frame(shot, crop, width, marks=()):
    """crop (x, y, w, h) in css px of the shot's viewport, shown `width` css px wide; marks [(n, x, y)] in css px."""
    im = Image.open(K / 'shots' / f'{shot}.png').convert('RGB')
    x, y, w, h = crop
    b = (x * 2, y * 2, min((x + w) * 2, im.width), min((y + h) * 2, im.height))
    c = im.crop(b)
    cw, ch = (b[2] - b[0]) / 2, (b[3] - b[1]) / 2
    scale = width / cw
    dw, dh = round(cw * scale), round(ch * scale)
    c = c.resize((dw * 2, dh * 2), Image.Resampling.BOX)
    name = f'{shot}.png'
    c.save(OUT / 'frames' / name, optimize=True)
    ms = ''.join(
        f'<span class="num m" style="left:{round((mx - x) * scale) - 11}px;top:{round((my - y) * scale) - 11}px">{n}</span>'
        for n, mx, my in marks)
    return (f'<div class="fr" style="width:{dw}px;height:{dh}px"><img src="frames/{name}" '
            f'width="{dw}" height="{dh}">{ms}</div>')


def notes(items):
    return '<ol class="notes">' + ''.join(
        f'<li><span class="num">{n}</span><span class="t">{t}</span></li>' for n, t in items) + '</ol>'


def tile(tag, title, fr, items=(), cls=''):
    t = f'<span class="tag {tag}">{"今天" if tag == "now" else "方案"}</span>' if tag else ''
    return f'<figure class="tile {cls}">{t}<div class="tile-title">{title}</div>{fr}{notes(items) if items else ""}</figure>'


def section(cls, label, sub):
    return f'<div class="section"><span class="sec {cls}">{label}</span><span class="sec-sub">{sub}</span></div>'


W2 = 759   # inner width of a grid2 tile
W3 = 489   # inner width of a grid3 tile

# ① today vs ② proposal, the owner's own file.
t = bx('t-png', 'empty')
p_nav, p_meta, p_dl, p_img = (bx('p-png', k) for k in ('nav', 'meta', 'dl', 'img'))
row_a = '<div class="grid2">' + tile(
    'now', 'Binary file — no preview：PNG 只有一句话',
    frame('t-png', (0, 0, 1440, 600), W2, [
        (1, t['x'] + t['w'] / 2 - 125, t['y'] + t['h'] / 2 - 120),
        (2, 306, 70),
    ]),
    [(1, '二进制文件（numstat 记成 <code>-1</code>）没有 patch，右侧只写 <i>Binary file — no preview</i>。'
         '你看 mock 板子时只能去别处打开 PNG。'),
     (2, '‹ › 翻页跳过二进制文件，停在图片上时位置空着、两个箭头都灰。')],
) + tile(
    'after', '方案：直接画出来（和 iOS / macOS / Android 一样）',
    frame('p-png', (0, 0, 1440, 600), W2, [
        (1, p_nav['x'] + p_nav['w'] / 2, p_nav['y'] + 34),
        (2, p_meta['x'] + p_meta['w'] / 2, p_meta['y'] + 36),
        (3, p_dl['x'] + p_dl['w'] / 2, p_dl['y'] + 42),
        (4, p_img['x'] + 24, p_img['y'] + 70),
    ]),
    [(1, '‹ › 把二进制文件也算进去：这里是 <i>37/48</i>，可以一张张翻 mock。'),
     (2, '头部写类型 · 像素尺寸 · 大小：<i>PNG 3440 × 9130 · 2.2 MB</i>（尺寸读完图才有）。'),
     (3, '<i>Download</i>：存下刚读到的这份字节，不再读第二次。'),
     (4, '图按右侧宽度缩放，<b>不放大</b>小图；长图在右侧里竖着滚。点图进全屏查看器。')],
) + '</div>'

n_nav, n_act = bx('p-next', 'nav'), bx('p-next', 'active')
row_b = '<div class="grid2">' + tile(
    'after', '‹ › 翻进收起的文件夹：自动展开',
    frame('p-next', (0, 0, 1440, 900), W2, [
        (1, n_nav['x'] + n_nav['w'] / 2, n_nav['y'] + 34),
        (2, n_act['x'] + 8, n_act['y'] - 4),
    ]),
    [(1, '从 <code>capture/vite.mjs</code> 按 ›，到下一个文件 <code>frames/e-home-…png</code>（11/48）。'),
     (2, '<code>frames/</code> 全是二进制，今天默认收起；翻到它里面的文件时自动展开，列表上能看到你在哪。'
         '手动收起照旧有效。')],
) + tile(
    'after', '点图：现有的全屏查看器',
    frame('p-viewer', (0, 0, 1440, 900), W2, [
        (1, bx('p-viewer', 'vbar')['x'] - 16, bx('p-viewer', 'vbar')['y'] + bx('p-viewer', 'vbar')['h'] / 2),
        (2, bx('p-viewer', 'vclose')['x'] - 16, bx('p-viewer', 'vclose')['y'] + bx('p-viewer', 'vclose')['h'] / 2),
    ]),
    [(1, '就是对话里图片用的那个查看器（<code>ui/ImagePreview</code>）：滚轮 / 按钮缩放、拖动、旋转、翻转。'),
     (2, 'Esc、✕ 或点暗处关掉，回到抽屉。')],
) + '</div>'

STATES = [
    ('s-loading', '读取中', '打开就让 runner 现读。走 runner link 的 runner 几秒就回来；只走 HTTPS 的要等它下一次心跳，最多约 30 秒（见待你定 ③）。没读到前 <i>Download</i> 是灰的。'),
    ('s-small', '小图、改动过的图（M）', '按原尺寸居中，不放大。<b>只显示现在的版本</b>，没有改前 / 改后对比（见待你定 ①）。'),
    ('s-other', '不是图片（woff2、zip、pdf…）', '不自动读；按 <i>Download</i> 才让 runner 读，读完直接下载。'),
    ('s-deleted', '已删除（D）', '现在的 worktree 里没有这个文件，不发请求，只说明一句。'),
    ('s-offline', 'Runner 离线（503）', '和原生同一句文案，带 <i>Retry</i>。超时（504，服务端最多等 40 秒）、找不到（404）同样可以重试。'),
    ('s-large', '超过 25 MB（413）', '上传上限是 runner 那边定的 25 MB；不给重试，读了也一样。'),
]
cells = []
for shot, title, note in STATES:
    pane = bx(shot, 'pane')
    cells.append(tile('', title, frame(shot, (pane['x'], pane['y'], pane['w'], pane['h']), W3), cls='state')
                 .replace('</figure>', f'<div class="state-note">{note}</div></figure>'))
row_c = '<div class="grid3">' + ''.join(cells) + '</div>'

RULES = [
    ('哪些文件', '右侧文件列表里标 <i>binary</i> 的文件（git numstat 是 <code>-</code>）。文本文件、SVG（git 当文本）不变。'),
    ('怎么拿字节', '复用现成的 <code>GET /sessions/:id/worktree-file?path=…</code>：服务端让这个会话的 runner 从 worktree 读文件上传，'
               'iOS / macOS / Android 早就在用。<b>只改 Web</b>；服务端要不要加一行，见待你定 ③。'),
    ('画哪些格式', 'png、jpg/jpeg、gif、webp、avif、bmp、ico（所有浏览器都能画的）。其他二进制给 <i>Download</i>。'),
    ('读的是哪一版', 'worktree 里<b>现在</b>的文件。会话还在跑时，turn 结束会重读正在看的图（和 diff 一起刷新）。'),
    ('翻回看过的图', '先显示上次读到的那份，同时后台重读；离开一分钟后释放内存，翻几十张大图不会一直占着。'),
    ('已结束的会话', '同一条路：checkout 还在就能看；checkout 被回收后显示 <i>File not found</i>。'),
    ('点工作区条打开抽屉', '照旧先打开第一个文本文件（秒开）；想看图点图，或用 ‹ › 翻过去。'),
]
rules = '<table class="cmp"><tr><th></th><th>规则</th></tr>' + ''.join(
    f'<tr><td>{a}</td><td>{b}</td></tr>' for a, b in RULES) + '</table>'

FILES = [
    ('src/web/src/components/WorktreeFilePreview.tsx', '新：预览组件（头部类型 · 尺寸 · 大小、Download，图 / 各种状态）'),
    ('src/web/src/lib/worktreeFile.ts', '新：可画的格式、失败文案（照抄原生 WorktreeFileFailure）、大小格式'),
    ('src/web/src/components/SessionOutputs.tsx', 'DiffPane 把二进制交给预览；‹ › 包括二进制；文件树展开当前文件所在的文件夹'),
    ('src/web/src/api.ts · lib/queries.ts', '<code>getWorktreeFile</code> / <code>worktreeFileQuery</code>'),
    ('src/web/src/index.css', '<code>.wt-preview-*</code>（类名先 grep 过，没有撞）'),
    ('测试', 'vitest：图 / 非图 / 删除 / 各状态码 / ‹ › 顺序 / 自动展开'),
]
files = '<ul class="files">' + ''.join(f'<li><code>{a}</code><span>{b}</span></li>' for a, b in FILES) + '</ul>'

TODO = [
    '改动过的图（M）只看现在的版本，和四端今天一样。要不要做改前 / 改后对比？那得让 runner 再读 base 版本（服务端 + runner 都要加），建议另开任务。',
    '‹ › 包括二进制文件，翻到收起的文件夹里会自动展开。如果你更想要 ‹ › 只翻文本、图片只能点开，告诉我。',
    '只走 HTTPS 的 runner 要等下一次心跳（最多约 30 秒）才去读文件：这个请求只提醒走 runner link 的 runner，不像 Merge / Commit 那样直接叫醒 runner。'
    '服务端在 <code>getWorktreeFileForOwner</code> 里加一行 <code>notifyRunnerWake</code> 就能马上读，四个客户端的文件预览都会快。<b>我建议一起做。</b>',
]
todo = '<ol class="todo">' + ''.join(f'<li>{t}</li>' for t in TODO) + '</ol>'

row_d = ('<div class="grid2">'
         f'<figure class="tile"><div class="tile-title">规则</div>{rules}</figure>'
         f'<figure class="tile"><div class="tile-title">改哪些文件</div>{files}'
         f'<div class="tile-title todo-title">待你定</div>{todo}</figure>'
         '</div>')

EXTRA_CSS = '''
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; align-items: start; }
.state .tile-title { font-size: 15px; margin-bottom: 8px; }
.state-note { font-size: 13.5px; line-height: 1.6; color: #34343c; margin-top: 2px; }
.state-note i, .notes i, .cmp i { font-style: normal; font-family: Inter, sans-serif; background: #eef0f4; border-radius: 4px; padding: 0 4px; }
.cmp td:nth-child(2) { background: #f3f7ff; }
.cmp td:first-child { width: 150px; }
.files { list-style: none; margin: 0 0 18px; padding: 0; font-size: 14px; }
.files li { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-top: 1px solid #ececf1; }
.files li:first-child { border-top: 0; }
.files li span { color: #4a4a54; }
.todo-title { margin-top: 6px; padding-top: 14px; border-top: 1px solid #dcdce3; }
.todo { margin: 0; padding-left: 22px; font-size: 14.5px; line-height: 1.65; }
.todo li { margin: 6px 0; }
'''
CSS = (K / 'board.css').read_text() + EXTRA_CSS

body = (
    section('now', '① 今天 → ② 方案', '左：你截的那一屏（真页面）。右：同一个文件，方案里的样子（真页面 + 原型，不是手画）。')
    + row_a
    + section('after', '② 方案 · 翻页和放大', '')
    + row_b
    + section('after', '② 方案 · 各种状态', '同一个右侧区域，在一个小窗口里截的。文案照抄原生客户端，四端说法一致。')
    + row_c
    + section('after', '规则 · 改动 · 待你定', '')
    + row_d
)
title = 'Diff 抽屉：二进制文件直接预览 · Web'
lede = ('今天 Web 的 diff 抽屉碰到二进制文件只写 <i>Binary file — no preview</i>。'
        'iOS / macOS / Android 早就在同一个位置显示图片：它们调 <code>GET /sessions/:id/worktree-file</code>，'
        '服务端让会话的 runner 从 worktree 现读这个文件。方案：<b>Web 走同一条路</b>，图片直接画在右侧，其他二进制给 <i>Download</i>。'
        '只改 Web；服务端要不要顺手加一行让它更快，见待你定 ③。')
page = f'''<!doctype html><html lang="zh"><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style><body><div class="board"><h1>{title}</h1><div class="lede">{lede}</div>{body}</div></body></html>'''
(OUT / '01-binary-preview.html').write_text(page)
print('wrote', OUT / '01-binary-preview.html')
