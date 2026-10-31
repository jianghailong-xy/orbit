# Builds 02-blur-up from shots/u-*.png + marks2.json:
#   python3 -I gen2.py <out-dir>
import json, sys, html
from pathlib import Path
from PIL import Image

K = Path('/var/tmp/wt-preview-mock')
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else K / 'board')
(OUT / 'frames').mkdir(parents=True, exist_ok=True)
MARKS = json.loads((K / 'marks2.json').read_text())


def bx(scene, key):
    return MARKS[scene]['boxes'][key]


def frame(shot, crop, width, marks=(), name=None):
    im = Image.open(K / 'shots' / f'{shot}.png').convert('RGB')
    x, y, w, h = crop
    b = (x * 2, y * 2, min((x + w) * 2, im.width), min((y + h) * 2, im.height))
    c = im.crop(b)
    cw, ch = (b[2] - b[0]) / 2, (b[3] - b[1]) / 2
    scale = width / cw
    dw, dh = round(cw * scale), round(ch * scale)
    c = c.resize((dw * 2, dh * 2), Image.Resampling.BOX)
    name = name or f'{shot}.png'
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


W2, W3 = 759, 489
PANE = (248, 59, 1192, 620)   # the drawer's right side, from its head down

pill = bx('u-blur-rules', 'pill')
head_meta = bx('u-blur-rules', 'meta')
blur = bx('u-blur-rules', 'blur')
dl_now = bx('u-now', 'dl')
meta_sharp = bx('u-sharp-rules', 'meta')
row_a = '<div class="grid3">' + tile(
    'now', '① 点开：空白，等整张图',
    frame('u-now', PANE, W3, [(1, 844, 330), (2, dl_now['x'] + dl_now['w'] / 2, dl_now['y'] + 40)]),
    [(1, '只有 <i>Loading file…</i>。要等 runner 读完文件（约 1 秒），再加上下载整张图（你的板子每张 1.2–2.2 MB）。'),
     (2, '尺寸、大小都还不知道，<i>Download</i> 是灰的。')],
) + tile(
    'after', '② 点开的瞬间：模糊版',
    frame('u-blur-rules', PANE, W3, [
        (1, blur['x'] + 40, blur['y'] + 120),
        (2, pill['x'] + pill['w'] / 2, pill['y'] + 42),
        (3, head_meta['x'] - 40, head_meta['y'] + 7),
    ]),
    [(1, '按原图的尺寸铺上模糊版：它跟 diff 一起早就到了，不用等 runner。位置和高度一开始就定了，原图到了不跳。'),
     (2, '右上角写 <i>Loading full image…</i>，看得出这还不是原图。'),
     (3, '头部先写出像素尺寸 <i>3440 × 5544</i>。')],
) + tile(
    'after', '③ 原图到了：换成清晰的',
    frame('u-sharp-rules', PANE, W3, [(1, 420, 330), (2, meta_sharp['x'] + meta_sharp['w'] / 2, meta_sharp['y'] + 36)]),
    [(1, '原图画好的那一刻整张换成清晰的（之前一直是模糊版，中间不会空一下）。'),
     (2, '大小 <i>1.6 MB</i> 跟上，<i>Download</i> 可以点了。点图照旧进全屏查看器。')],
) + '</div>'

TALL = (248, 59, 1192, 900)
row_b = '<div class="grid2">' + tile(
    'after', '长图（01-web-flow，3440 × 9130）：先模糊',
    frame('u-blur', TALL, W2),
    [(1, '长图同样先铺满它自己的高度：滚动条一开始就是对的，往下滚看到的也是模糊版。')],
) + tile(
    'after', '……再清晰',
    frame('u-sharp', TALL, W2),
) + '</div>'

ZOOM = (264, 102, 736, 420)
sizes = [(64, '1.5 KB', '大概能看出分块，字是一片雾。'),
         (96, '2.6 KB', '标题条、绿框、表格行都看得出来，<b>推荐</b>。'),
         (128, '3.8 KB', '再清楚一点，但每张多一半字节。')]
row_c = '<div class="grid3">' + ''.join(
    tile('', f'{w} px 宽 · 约 {kb} 一张', frame(f'u-blur-rules-{w}', ZOOM, W3, name=f'u-blur-{w}.png')).replace(
        '</figure>', f'<div class="state-note">{note}</div></figure>')
    for w, kb, note in sizes) + '</div>'

RULES = [
    ('哪些图有模糊版', '改动（A / M）的 png、jpg / jpeg、gif：runner 用 Go 标准库就能解码的格式。webp、avif、bmp、ico 和删除的文件没有，照旧 <i>Loading file…</i>。'),
    ('什么时候做', 'runner 报告 diff 的时候（turn 结束、会话结束、diff 刷新）。turn 进行中刚画的图，要等这一轮结束才有模糊版。'),
    ('多大', '96 px 宽（最长边不超过 256 px）的 JPEG，约 1.5–4 KB 一张；你这几张板子平均 2.6 KB。'),
    ('runner 的开销', '第一次要解码原图，最大那张板子约 0.2 秒。按文件（路径 + 大小 + 修改时间）缓存，没变的图不再解码。每次报告最多花 1.5 秒、最多带 128 KB 模糊图，超出的那几张照旧。'),
    ('翻页预取（附带）', '看一张图时，‹ › 前后两张图在后台先读好，翻过去直接是清晰的。只预取图片，不预取删除的文件。'),
    ('服务端即时回复（附带）', 'runner 一交回文件就回给浏览器，不再每秒查一次。每张图省 0.2–1 秒。'),
    ('旧 runner、原生客户端', '没有新字段的 diff 照旧显示 <i>Loading file…</i>。iOS / macOS / Android 不受影响，以后可以跟进。'),
]
rules = '<table class="cmp"><tr><th></th><th>规则</th></tr>' + ''.join(
    f'<tr><td>{a}</td><td>{b}</td></tr>' for a, b in RULES) + '</table>'

FILES = [
    ('src/runner-go/worktree_image_preview.go', '新：解码、缩小、JPEG、缓存、时间和字节预算，加 go 测试'),
    ('src/runner-go/worktree.go · types.go', 'diff 报告里给图片带上 preview / width / height'),
    ('src/shared/src/dto.ts · src/web/src/api.ts', 'FilePatch 加三个可选字段'),
    ('src/web/src/components/WorktreeFilePreview.tsx · SessionOutputs.tsx · index.css', '模糊版、换成清晰的、翻页预取'),
    ('src/apiserver/src/sessions/sessions.service.ts · runner-api.controller.ts', 'runner 交回文件就回复（waitForInbox / notifyInbox）'),
    ('package.json', '版本号 +1：runner 发版，部署后约 10 分钟内自己更新'),
    ('测试', 'runner go test、web vitest、apiserver spec'),
]
files = '<ul class="files">' + ''.join(f'<li><code>{a}</code><span>{b}</span></li>' for a, b in FILES) + '</ul>'

TODO = [
    '模糊版用 96 px（约 2.6 KB 一张，推荐），还是 64 px / 128 px？',
    '两个附带改动（翻页预取、服务端即时回复）一起做？我建议一起做。',
    '要发 runner 新版（版本号 +1）。合并后照上次的方式部署，runner 约 10 分钟内自己更新；更新前的会话没有模糊版，照旧。可以吗？',
]
todo = '<ol class="todo">' + ''.join(f'<li>{t}</li>' for t in TODO) + '</ol>'
row_d = ('<div class="grid2">'
         f'<figure class="tile"><div class="tile-title">规则</div>{rules}</figure>'
         f'<figure class="tile"><div class="tile-title">改哪些文件</div>{files}'
         f'<div class="tile-title todo-title">待你定</div>{todo}</figure>'
         '</div>')

EXTRA_CSS = '''
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; align-items: start; margin-bottom: 8px; }
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
    section('now', '① 今天 → ② 方案', '同一张 04-rules.png，三个时刻（真页面 + 原型）。')
    + row_a
    + section('after', '② 长图', '')
    + row_b
    + section('after', '模糊版用多大', '同一张图的左上角，放大看。')
    + row_c
    + section('after', '规则 · 改动 · 待你定', '')
    + row_d
)
title = 'Diff 抽屉：图片由模糊到清晰 · Web'
lede = ('今天点开一张图，右侧先空着写 <i>Loading file…</i>，要等 runner 读完文件（约 1 秒）再加上下载整张图（每张板子 1.2–2.2 MB）才出图。'
        '方案 A：runner 报告 diff 时顺手给每张改动的图做一张约 2.6 KB 的小图，跟 diff 一起到。<b>点开文件的瞬间</b>就按原图尺寸铺上模糊版，原图到了直接换成清晰的。'
        '附带两件：翻页时前后两张图先读好；runner 一交回文件服务端就回复。')
page = f'''<!doctype html><html lang="zh"><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style><body><div class="board"><h1>{title}</h1><div class="lede">{lede}</div>{body}</div></body></html>'''
(OUT / '02-blur-up.html').write_text(page)
print('wrote', OUT / '02-blur-up.html')
