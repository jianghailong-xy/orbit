import json, sys
here = sys.argv[1]
m = json.load(open(f'{here}/shots/marks.json'))
W = 820

def frame(name, cap):
    f = m[name]; h = round(f['h'] * W / f['w'])
    return (f'<figure class="fr"><div class="shot" style="width:{W}px;height:{h}px"><img src="shots/{name}.png" width="{W}" height="{h}"></div>'
            f'<figcaption>{cap}</figcaption></figure>')

html = f'''<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Right column as its own window: panels on a canvas</title>
<style>
body{{margin:0;background:#eef0f3;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1d1d1f}}
.m-sheet{{display:inline-block;padding:36px 40px 44px;background:#eef0f3}}
h1{{font-size:26px;margin:0 0 6px}} h2{{font-size:19px;margin:34px 0 12px}} .sub{{color:#555;max-width:1680px}}
.row{{display:flex;gap:28px;align-items:flex-start}}
.fr{{margin:0;background:#fff;border-radius:14px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.shot{{position:relative;border:1px solid #d9dbe0;border-radius:6px;overflow:hidden}} .shot img{{display:block}}
figcaption{{margin-top:10px;width:820px;color:#333}}
.tag{{display:inline-block;padding:1px 8px;border-radius:6px;font-size:13px;font-weight:600;margin-right:6px}}
.t{{background:#fde8e8;color:#b42318}} .r{{background:#dcfce7;color:#166534}}
.why{{display:flex;gap:20px;width:1680px}} .why div{{flex:1;background:#fff;border-radius:12px;padding:14px 18px}}
.why div > b:first-child{{display:block;margin-bottom:4px}}
table{{border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;width:1680px}}
td,th{{padding:9px 14px;border-bottom:1px solid #eceef2;text-align:left;vertical-align:top}} th{{background:#f6f7f9;font-weight:600}}
code{{font:13px "JetBrains Mono",monospace;background:#f1f2f5;padding:1px 5px;border-radius:4px}}
.ask{{background:#fff7e6;border:1px solid #f5c26b;border-radius:12px;padding:14px 18px;width:1650px}}
</style></head><body><div class="m-sheet">
<h1>右栏像独立窗口 · 第二稿：面板放在底上（Web）</h1>
<div class="sub">2026-11-26 你看了 B（左右面板同高、左面板右侧圆角）说效果不理想。先说为什么不理想，再给新的方向 C。
画面都是今天 main 的真实 Web 控制台（假数据）加上提案的 CSS，没有手绘。</div>

<div id="part-1">
<h2>为什么 B 不理想</h2>
<div class="why">
<div><b>① 左面板只有一半是"窗口"</b>右边圆角、左边却贴着导航栏，导航又是白的。眼睛找不到左面板的边界，读不出它是一块什么东西。</div>
<div><b>② 灰色太少，只像描边</b>白色的导航、白色的列表、白色的会话、白色的右栏，灰色只有一条 8px 的缝。"窗口"感来自<b>底和面的对比</b>：微信的窗口浮在桌面上，桌面是成片的。网页里没有桌面，要自己画一块成片的底。</div>
<div><b>③ 打开右栏整页会变形</b>B 只在右栏打开时才出现灰缝和圆角，左面板上下各缩 8px。开关一次右栏，整页跳一下。</div>
</div>
<h2>原则：底 + 面</h2>
<div class="why">
<div><b>底（灰）是窗口本身，常驻</b>导航直接放在底上，没有自己的白色面，它是"框"不是"内容"。</div>
<div><b>面（白）是你工作的地方，四角都圆</b>会话列表 + 会话区是一块面（像微信的主窗口）；右栏是第二块面，和它同级。</div>
<div><b>只有一套尺寸</b>圆角都是 12px，间距都是 8px，层级一样（细边 + 很淡的阴影）。打开右栏只是多出一块面，别的什么都不动。</div>
</div>
<div class="row" style="margin-top:20px">
{frame('b-wide', '<span class="tag t">B · 上一稿</span>灰缝只在右栏周围，左面板左边贴着白色导航，没有边界。')}
{frame('c-wide', '<span class="tag r">C · 建议</span>导航在灰底上，左边一块面（列表 + 会话，四角圆），右栏一块面；两块同高、同圆角、同间距。像微信那样，两个窗口并排。')}
</div></div>

<div id="part-2">
<h2>C 在其他状态下</h2>
<div class="row">
{frame('c-closed', '<span class="tag r">右栏收起</span>还是同一块面，只是变宽了。开关右栏时页面不跳。')}
{frame('c-narrow', '<span class="tag r">窄窗口 1120 · 按 ⊞</span>右栏盖在会话上时是一块浮起的面，阴影更重（它在上面一层）。')}
</div>
<div class="row" style="margin-top:20px">
{frame('c-dark', '<span class="tag r">深色</span>底用主题里更深的 <code>--bg-sunken</code>，面比底亮，层次和浅色一样。')}
</div></div>

<div id="part-3">
<h2>规则</h2>
<table>
<tr><th style="width:300px">部分</th><th>今天</th><th>C</th></tr>
<tr><td>底</td><td>没有，导航、列表、会话都直接铺满</td><td>整个窗口一层灰：浅色是文字色 5% 混入背景色，深色是 <code>--bg-sunken</code></td></tr>
<tr><td>导航</td><td>白底，右边 1px 竖线</td><td>透明，放在底上，去掉竖线；粘顶的分组标题用底色</td></tr>
<tr><td>左面板（列表 + 会话）</td><td>白，满屏</td><td>白，上下右留 8px，左边紧挨导航的内边距；四角 12px 圆角；1px 细边；阴影 <code>0 1px 2px / 4%</code>。列表和会话之间的竖线不变（同一块面里的分隔）</td></tr>
<tr><td>右栏（项目栏 / 会话设置）</td><td>白，贴边，左边竖线</td><td>和左面板一样的一块面，相隔 8px；拖这 8px 的缝可以调宽度，悬停显示蓝线</td></tr>
<tr><td>窄窗口里盖上来的右栏</td><td>贴边，左侧阴影</td><td>同一块面，阴影加重 <code>0 16px 40px / 14%</code></td></tr>
<tr><td>手机</td><td colspan="2">不变：没有底，全屏</td></tr>
</table>
<h2>会改到的文件</h2>
<table>
<tr><td style="width:300px"><code>src/web/src/index.css</code></td><td>只改样式：<code>.app-shell</code> 加底色变量，<code>.app-nav</code> 透明，<code>.app-main</code> 留 8px，会话页的两块面，右栏、它前面的拖拽缝、窄窗口浮层</td></tr>
<tr><td>组件 / 测试</td><td>不动 DOM，不动逻辑</td></tr>
</table>
<h2>待你定</h2>
<div class="ask">1. 方向 C 可以吗？<br>
2. <b>范围</b>：底是整个窗口的，所以只改会话页的话，切到 Tasks、Wiki、Drive、Settings 时，内容又会铺满、导航又变白，切页时整个外观会变。<b>建议整个 Web 一起改</b>：每一页的内容都是底上的一块面，Tasks 的任务详情、Wiki 的条目抽屉也做成同样的右侧面板。可以先只做会话页给你看实际效果，再推到其他页。</div>
</div>
</div></body></html>'''
open(f'{here}/02-board.html', 'w').write(html)
