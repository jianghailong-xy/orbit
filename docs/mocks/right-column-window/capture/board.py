import json, sys
here = sys.argv[1]
m = json.load(open(f'{here}/shots/marks.json'))
W = 820  # frame width on the board

def frame(name, cap, ring=None):
    f = m[name]; s = W / f['w']; h = round(f['h'] * s)
    out = [f'<figure class="fr"><div class="shot" style="width:{W}px;height:{h}px"><img src="shots/{name}.png" width="{W}" height="{h}">']
    b = f['boxes'].get('column') if ring else None
    if b:
        x, y, w, hh = [round(v * s) for v in b]
        out.append(f'<div class="ring {ring}" style="left:{x-4}px;top:{y-4}px;width:{w+8}px;height:{hh+8}px"></div>')
    out.append(f'</div><figcaption>{cap}</figcaption></figure>')
    return ''.join(out)

html = f'''<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Right column as its own window</title>
<style>
body{{margin:0;background:#eef0f3;font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1d1d1f}}
.m-sheet{{display:inline-block;padding:36px 40px 44px;background:#eef0f3}}
h1{{font-size:26px;margin:0 0 6px}} h2{{font-size:19px;margin:34px 0 12px}} .sub{{color:#555;max-width:1680px}}
.row{{display:flex;gap:28px;align-items:flex-start}}
.fr{{margin:0;background:#fff;border-radius:14px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.shot{{position:relative;border:1px solid #d9dbe0;border-radius:6px;overflow:hidden}} .shot img{{display:block}}
figcaption{{margin-top:10px;width:820px;color:#333}}
.ring{{position:absolute;border:3px solid;border-radius:14px;box-sizing:border-box}}
.red{{border-color:#e5484d}} .blue{{border-color:#2f6bff}} .green{{border-color:#1f9d55}}
.tag{{display:inline-block;padding:1px 8px;border-radius:6px;font-size:13px;font-weight:600;margin-right:6px}}
.t{{background:#fde8e8;color:#b42318}} .n{{background:#e3edff;color:#1d4ed8}} .r{{background:#dcfce7;color:#166534}}
table{{border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;width:1680px}}
td,th{{padding:9px 14px;border-bottom:1px solid #eceef2;text-align:left;vertical-align:top}} th{{background:#f6f7f9;font-weight:600}}
code{{font:13px "JetBrains Mono",monospace;background:#f1f2f5;padding:1px 5px;border-radius:4px}}
.ask{{background:#fff7e6;border:1px solid #f5c26b;border-radius:12px;padding:14px 18px;width:1650px}}
</style></head><body><div class="m-sheet">
<h1>右栏像一个独立窗口（Web）</h1>
<div class="sub">2026-11-26 你的反馈：右侧栏的渲染参考微信 Mac 版里文章在右侧打开的样子，看起来像一个独立的窗口。
今天的右栏是贴着窗口右边、只用一条 1px 竖线隔开的一列。以下画面都是今天 main 的真实 Web 控制台（假数据），
提案画面是今天的页面加上提案的 CSS，没有手绘。</div>

<div id="part-1">
<h2>① 今天 → A 卡片</h2>
<div class="row">
{frame('today-wide', '<span class="tag t">今天</span>项目右栏和会话区之间只有一条竖线，顶到窗口上下右三边，像同一张纸的第三列。', 'red')}
{frame('a-wide', '<span class="tag n">A 卡片</span>右栏四边留 8px，12px 圆角、1px 细边、柔和阴影；背后仍是白色。分开了，但白底上的阴影偏淡，像一张浮起的卡片，不太像窗口。')}
</div></div>

<div id="part-2">
<h2>② B 窗口（建议）</h2>
<div class="row">
{frame('b-wide', '<span class="tag r">B 窗口 · 建议</span>同 A，另外卡片周围那一圈是浅灰底（列表和会话区仍是白色），像微信那样：灰色的窗口缝把右栏围成第二个窗口。拖拽分隔线仍在卡片左边缘，只是不再画线。')}
{frame('b-narrow', '<span class="tag r">B 窗口 · 窄窗口 1120</span>右栏盖在会话区上时（按 ⊞），同样是四边留缝、圆角加阴影的浮窗，而不是今天贴边的一块。')}
</div></div>

<div id="part-3">
<h2>规则</h2>
<table>
<tr><th style="width:300px">部分</th><th>今天</th><th>提案 B</th></tr>
<tr><td>右栏外形</td><td>直角，顶满窗口上下右三边，左边 1px 竖线</td><td>上下右各留 8px；圆角 12px；1px <code>--border-subtle</code> 边；阴影 <code>0 1px 3px / 6%</code> + <code>0 8px 28px / 10%</code></td></tr>
<tr><td>右栏周围</td><td>白色</td><td>浅灰（文字色 6% 混入背景色，深色主题下自动变成深灰）；列表和会话区仍是原来的白底</td></tr>
<tr><td>拖拽分隔线</td><td>1px 竖线，悬停变蓝</td><td>不画线，抓取区不变；悬停仍变蓝</td></tr>
<tr><td>窄窗口盖在会话上</td><td>贴边一块，左侧阴影</td><td>同样的浮窗（四边留缝、圆角、阴影）</td></tr>
<tr><td>手机</td><td colspan="2">不变：项目列表是底部弹窗</td></tr>
</table>
<h2>改动的文件</h2>
<table>
<tr><td style="width:300px"><code>src/web/src/index.css</code></td><td>只改样式：<code>.session-project-column</code>、<code>.session-project-column-over</code>、它前面的 <code>.session-resizer</code>、<code>.workspace-split</code> 在有右栏时的底色；会话设置右栏（<code>.ss-column</code>）同样处理</td></tr>
<tr><td>组件 / 测试</td><td>不动 DOM，不动逻辑</td></tr>
<tr><td>macOS / iOS / Android</td><td>不动（macOS 的右侧检查器如果也要，另开任务）</td></tr>
</table>
<h2>待你定</h2>
<div class="ask">1. 选 <b>A 卡片</b> 还是 <b>B 窗口</b>？<b>建议 B</b>：只有加上周围的灰缝，才像你截图里那样读成"另一个窗口"。<br>
2. 范围：项目右栏 + 会话设置右栏（同一种列）。Tasks 页的任务详情面板、Wiki 的条目抽屉要不要一起改？<b>建议先只改会话页的两种右栏</b>，看过效果再推到其他页面。</div>
</div>
</div></body></html>'''
open(f'{here}/01-board.html', 'w').write(html)
