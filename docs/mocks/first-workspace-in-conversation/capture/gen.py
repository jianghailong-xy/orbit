# Builds the web boards (01, 02) from shots/*.png + marks.json:
#   python3 -I gen.py <out-dir>
# Frames are cropped from the 2x shots and kept at 2x of their shown size (PIL BOX resample).
import json, sys, html
from pathlib import Path
from PIL import Image

K = Path('/var/tmp/first-ws-mock')
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else K / 'board')
(OUT / 'frames').mkdir(parents=True, exist_ok=True)
MARKS = json.loads((K / 'marks.json').read_text())


def box(scene, key):
    return MARKS[scene]['boxes'][key]


def frame(shot, crop, scale, marks=(), label=None):
    """crop (x, y, w, h) in css px of the shot's viewport; marks [(n, x, y)] in the same css px."""
    im = Image.open(K / 'shots' / f'{shot}.png').convert('RGB')
    x, y, w, h = crop
    b = (x * 2, y * 2, min((x + w) * 2, im.width), min((y + h) * 2, im.height))
    c = im.crop(b)
    cw, ch = (b[2] - b[0]) / 2, (b[3] - b[1]) / 2
    dw, dh = round(cw * scale), round(ch * scale)
    if scale != 1:
        c = c.resize((dw * 2, dh * 2), Image.Resampling.BOX)
    name = f'{shot}-{x}-{y}-{w}x{h}.png'
    c.save(OUT / 'frames' / name, optimize=True)
    ms = ''.join(
        f'<span class="num m" style="left:{round((mx - x) * scale) - 11}px;top:{round((my - y) * scale) - 11}px">{n}</span>'
        for n, mx, my in marks)
    lab = f'<span class="fr-label">{html.escape(label)}</span>' if label else ''
    return (f'<div class="fr" style="width:{dw}px;height:{dh}px"><img src="frames/{name}" '
            f'width="{dw}" height="{dh}">{ms}{lab}</div>')


def notes(items):
    return '<ol class="notes">' + ''.join(
        f'<li><span class="num">{n}</span><span class="t">{t}</span></li>' for n, t in items) + '</ol>'


def tile(tag, title, fr, items, cls=''):
    t = f'<span class="tag {tag}">{"今天" if tag == "now" else "方案"}</span>' if tag else ''
    return f'<figure class="tile {cls}">{t}<div class="tile-title">{title}</div>{fr}{notes(items)}</figure>'


def wide_tile(tag, title, frs, items):
    t = f'<span class="tag {tag}">{"今天" if tag == "now" else "方案"}</span>'
    return (f'<figure class="tile wide">{t}<div class="tile-title">{title}</div>'
            f'<div class="frs">{"".join(frs)}</div>{notes(items)}</figure>')


CSS = (K / 'board.css').read_text()


def page(title, lede, body):
    return f'''<!doctype html><html lang="zh"><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style><body><div class="board"><h1>{title}</h1><div class="lede">{lede}</div>{body}</div></body></html>'''


A = 'orbit@austin'

# ───────────────────────── 01 · web: today vs the flow ─────────────────────────
S = 0.6
t1 = tile('now', '新用户落地：直接进了机器页', frame('t-landing', (0, 0, 1280, 900), S, [
    (1, 120, 200), (2, box('t-landing', 'engines')['x'] + 40, box('t-landing', 'engines')['y']), (3, 640, 880)]), [
    (1, '侧边栏里看不到这台机器：Workspaces 组只在至少有一个 workspace 时出现。'),
    (2, '首屏全是引擎：Claude Code 和 Codex 都 <b>Signed out</b>，但页面没有 Needs attention，Settings 还写着 <code>1 of 1 online</code>。'),
    (3, '唯一的创建入口 <b>Add workspace</b> 在折叠线下面（y≈930），要往下滚才看得到。'),
])
fx = box('t-form', 'form')
t2 = tile('now', '创建表单：名字必填，路径反而可选', frame('t-form', (fx['x'] - 14, fx['y'] - 50, fx['w'] + 28, fx['h'] + 64), 0.92, [
    (1, box('t-form', 'name')['x'] + 40, box('t-form', 'name')['y']),
    (2, box('t-form', 'dir')['x'] + 120, box('t-form', 'dir')['y']),
    (3, box('t-form', 'create')['x'] + 70, box('t-form', 'create')['y'] + 11)]), [
    (1, '<b>Name</b> 是唯一的必填项。'),
    (2, '<b>Working directory</b> 选填、纯文本，创建时不检查（检查只在编辑时跑）。不填的话，会话会悄悄落到 <code>orbit register</code> 时的目录，安装脚本让它通常就是 <code>~</code>。'),
    (3, '点 Create 后停在原页，不进会话；也没说 Claude Code 在这台机器上没登录。'),
])
t3 = tile('now', '其实已经有一个「机器草稿页」，只是没人能走到', frame('t-draft-hidden', (0, 0, 1280, 900), S, [
    (1, 770, box('t-draft-hidden', 'fix')['y'] + 9),
    (2, box('t-draft-hidden', 'composer')['x'] + 30, box('t-draft-hidden', 'composer')['y'])]), [
    (1, '<code>/workspaces/&lt;机器 id&gt;</code> 能画出这台机器的新会话页（为老链接留的兼容），还会提示 <i>Not signed in on this runner · Fix it</i>。没有任何入口链到这里。'),
    (2, '输入框能打字能发送，但服务端会拒绝：这个 id 不是 workspace（<code>workspace not found</code>）。<b>方案就把这一页变成正式入口。</b>'),
])
c = box('p-landing', 'card')
fo, en_, ft = box('p-landing', 'folder'), box('p-landing', 'engine'), box('p-landing', 'foot')
p1 = wide_tile('after', '① 落地：这台机器的新会话页，主角是设置卡', [
    frame('p-landing', (0, 0, 1280, 900), 0.55, [
        (1, 4, box('p-landing', 'row')['y'] + 18),
        (6, box('p-landing', 'composer')['x'] + 8, box('p-landing', 'composer')['y'] + 14)]),
    frame('p-landing', (c['x'] - 14, c['y'] - 14, c['w'] + 28, c['h'] + 28), 1.0, [
        (2, c['x'] + 6, c['y'] + 8), (3, fo['x'] - 12, fo['y'] + 10), (4, en_['x'] - 12, en_['y'] + 10),
        (5, ft['x'] + ft['w'] - 6, ft['y'] + 8)]),
], [
    (1, '侧边栏：在线、还没有 workspace 的机器多一行 <b>Set up orbit@austin</b>。新用户进 Orbit 就落在这一页（今天落在机器页）。'),
    (2, '设置卡占住引擎 hero 的位置，只问两件只有你能定的事：<i>Pick where it works and sign in a coding CLI.</i>'),
    (3, '<b>文件夹</b>是 agent 能读写的范围，所以要你点头。可选：<code>orbit register</code> 的目录（只在它是项目、不是 <code>~</code> 时给）、新文件夹、别的文件夹。路径当场在机器上检查。'),
    (4, '<b>登录</b>：直接嵌入现有的 <code>RunnerSignIn</code>，和机器页、会话里的登录卡是同一个组件。另给 <i>Use Codex instead</i> 和 API key 两个选择。'),
    (5, '发送前什么都不建。名字、隔离、合并目标都有默认值，以后能改。'),
    (6, '输入框照常可用：<i>Send orbit@austin a task…</i>，也可以先写要做的事。'),
])
pc = box('p-landing', 'card')
fd, si, he = box('p-progress', 'folderDone'), box('p-progress', 'signin'), box('p-progress', 'held')
p2 = wide_tile('after', '② 先发了消息：消息等着，两步在卡里完成', [
    frame('p-progress', (0, 0, 1280, 900), 0.55),
    frame('p-progress', (pc['x'] - 14, 70, pc['w'] + 28, he['y'] + he['h'] - 70 + 14), 1.0, [
        (1, fd['x'] - 12, fd['y'] + 8), (2, si['x'] - 26, si['y'] + 8), (3, he['x'] + 70, he['y'] + 14)]),
], [
    (1, '文件夹选好就收成一行 ✓，带 <i>Change</i>。'),
    (2, '登录做到一半（贴码这一步），和今天机器页上一模一样。'),
    (3, '先发出的消息留在卡下面：<i>Waiting for orbit@austin — sends once both steps are done</i>，可以撤回。两步都打勾后自动发出，不用再点一次。'),
])
r = box('p-ready', 'card')
p3 = tile('after', '③ 两步都好了（还没写消息时）', frame('p-ready', (r['x'] - 16, r['y'] - 16, r['w'] + 32, r['h'] + 32), 0.92, [
    (1, box('p-ready', 'foot')['x'] - 10, box('p-ready', 'foot')['y'] + 9)]), [
    (1, '底部变绿：<i>Ready. Send a task — Orbit adds the workspace “app” for ~/code/app as it starts.</i> 发送这一下同时建 workspace 和会话。'),
])
p4 = tile('after', '④ 开始了：workspace 已建好，会话在跑', frame('p-started', (0, 0, 1280, 900), S, [
    (1, 770, box('p-started', 'created')['y'] + 10),
    (2, 4, box('p-started', 'row')['y'] + 18), (3, box('p-started', 'bubble')['x'] - 14, box('p-started', 'bubble')['y'] + 30)]), [
    (1, '对话第一行写明建了什么：<i>Created workspace <b>app</b> on orbit@austin · ~/code/app · Rename · Settings</i>。'),
    (2, '侧边栏里 <i>Set up orbit@austin</i> 换成真正的 workspace 行 <b>app · orbit@austin</b>。'),
    (3, '等着的那条消息正常送达，会话照常开始。之后这台机器上的其他 workspace 也可以在对话里建（见 04）。'),
])

summary = '''<table class="cmp"><tr><th></th><th>今天（web）</th><th>方案</th></tr>
<tr><td>从批准机器到第一条消息</td><td>批准页 → 机器页 → 登录 → 往下滚 → Add workspace → 填表 → Create → 点开 workspace → 写消息：<b>2 个页面、9 步</b></td><td>批准页 → 新会话页（设置卡）→ 选文件夹 → 登录 → 写消息：<b>1 个页面、4 步</b>，顺序随意</td></tr>
<tr><td>路径</td><td>可选，创建时不检查</td><td>必选，选的时候就在机器上检查</td></tr>
<tr><td>iPhone / iPad / Mac / Android</td><td>都建不了，只说 “on the web”</td><td>同一张卡（见 03）</td></tr></table>'''

body1 = f'''
<div class="section"><span class="sec now">① 今天</span><span class="sec-sub">新账号只有 orbit@austin 一台机器：在线、两个引擎都没登录、0 个 workspace（runner_list 2026-10-31 的真实状态）。都是真页面截图。</span></div>
<div class="grid2">{t1}{t3}</div>
<div class="grid2">{t2}<div class="tile sumtile"><div class="tile-title">走完要几步</div>{summary}</div></div>
<div class="section"><span class="sec after">② 方案</span><span class="sec-sub">在这台机器的新会话页里，用一张设置卡问两件事，然后直接开始。截图来自真页面 + 原型补丁（<code>capture/prototype.patch</code>）。</span></div>
{p1}{p2}
<div class="grid2">{p3}{p4}</div>
'''
(OUT / '01-web-flow.html').write_text(page(
    '没有 workspace 的机器：在对话里建第一个 workspace · Web',
    f'用户接上一台机器之后想的是「让 agent 在这台机器上干活」，不是「去配一个 workspace」。今天的路要绕到设置页填表，而且 iPhone、Mac、Android 根本建不了。'
    f'方案：<b>新会话页就是入口</b>。在这台机器上直接开新会话，卡片只问两件只有你能定的事（<b>文件夹</b>和<b>登录</b>），你发出的第一条消息会把 workspace 一起建出来。',
    body1))

# ───────────────────────── 02 · web: entry points, reminders, card states ─────────────────────────
def pair(title, now_fr, after_fr, now_items, after_items):
    return f'''<div class="pair"><div class="pair-title">{title}</div><div class="pair-row">
<figure class="tile"><span class="tag now">今天</span>{now_fr}{notes(now_items)}</figure>
<figure class="tile"><span class="tag after">方案</span>{after_fr}{notes(after_items)}</figure></div></div>'''


en = pair('批准页（/enroll）的下一步',
          frame('t-enroll', (400, 130, 480, 560), 0.8, [(1, 428, box('t-enroll', 'next')['y'] + 12)]),
          frame('p-enroll', (400, 130, 480, 560), 0.8, [(1, 428, box('p-enroll', 'next')['y'] + 12), (2, 852, box('p-enroll', 'go')['y'] + 25)]),
          [(1, '只说 <i>Next: sign in its coding CLIs</i>，按钮去机器页，不提 workspace；而 /runners/register 说的下一步是建 workspace，两处不一致。')],
          [(1, '统一成一个下一步：<i>Next: start your first session</i>，两件事在下一屏一起做。'),
           (2, '主按钮 <b>Start a session</b> 打开这台机器的新会话页；机器页退成次要链接。')])
rg = pair('Add a runner 页（/runners/register）机器上线后',
          frame('t-register', (440, 500, 680, 180), 0.75, [(1, 470, box('t-register', 'status')['y'] + 10)]),
          frame('p-register', (440, 500, 680, 180), 0.75, [(1, 470, box('p-register', 'status')['y'] + 10)]),
          [(1, '<i>Create a workspace</i> 按钮其实只是跳到机器页，表单还得自己再点开。')],
          [(1, '同一句下一步，按钮 <b>Start a session</b>。')])
mt = pair('机器页：提醒和空状态',
          frame('t-landing-tall', (250, 20, 700, 210), 0.75) + frame('t-landing-tall', (300, 915, 650, 140), 0.75, [(1, 330, 990)]),
          frame('p-machine', (250, 20, 700, 210), 0.75, [(1, 280, 160)]) + frame('p-machine', (300, 1035, 650, 200), 0.75, [(2, 330, 1110)]),
          [(1, '两个引擎都没登录，可这台机器一个 Needs attention 都没有：规则要求「有 workspace 用这个引擎」才算（web、Apple、Android 三端同一条规则）。空状态只有一句话。')],
          [(1, '一台机器上一个编程 CLI 都没登录时，算一条 <b>No coding CLI is signed in</b>，带 Sign In。只要有一个登录了，其他没用到的引擎照旧不吵。'),
           (2, '空状态给 <b>Start a session</b>；表单还在，<i>Add workspace</i> 降成次要按钮。')])
st = pair('Settings → Machines &amp; models',
          frame('t-settings', (500, 850, 700, 110), 0.75, [(1, 512, 916)]),
          frame('p-settings', (500, 850, 700, 110), 0.75, [(1, 512, 916)]),
          [(1, '<code>1 of 1 online</code>：看起来一切正常。')],
          [(1, '<code>1 needs you</code>（琥珀色）：在线但一个 CLI 都没登录的机器也算。手机 Settings 行跟着改。')])
sd = pair('已有 workspace 的账号（就是你这个账号的情况）',
          frame('t-side-existing', (0, 150, 290, 190), 0.9, [(1, 268, 300)]),
          frame('p-side-existing', (0, 150, 290, 190), 0.9, [(1, 268, box('p-side-existing', 'row')['y'] + 18)]),
          [(1, '新接的 orbit@austin 在侧边栏里不存在，只有 HPC 上的两个 workspace。')],
          [(1, '在线、没有 workspace 的机器排在 workspace 后面：<b>Set up orbit@austin</b>，点开就是它的新会话页。离线的不列（Machines &amp; models 已经把它算作 needs you）。')])


def card_state(shot, title, items):
    c = box(shot, 'card')
    return tile('', title, frame(shot, (c['x'] - 12, c['y'] - 12, c['w'] + 24, c['h'] + 24), 0.56), items, cls='state')


states = '<div class="grid4">' + ''.join([
    card_state('e-home', '注册目录就是 ~', [(1, '不推荐 <code>~</code>：整个家目录不是默认值。默认选「新文件夹」，放在机器的 Repos Folder（<code>~/orbit-repos/</code>）下。')]),
    card_state('e-missing', '路径不存在', [(1, '<i>No such directory on orbit@austin.</i> 按钮不可点。')]),
    card_state('e-nogit', '不是 git 仓库', [(1, '能用，但如实说：<i>sessions will share it instead of isolating.</i>')]),
    card_state('e-offline', '机器离线', [(1, '<i>orbit@austin is offline…</i> 两步都不能做；输入框显示 Runner offline。')]),
]) + '</div>'

body2 = f'''
<div class="section"><span class="sec now">入口</span><span class="sec-sub">所有「接下来做什么」都指到同一个地方：这台机器的新会话页。</span></div>
{en}{rg}
<div class="section"><span class="sec now">不再沉默</span><span class="sec-sub">一台什么都跑不了的机器，要在能看到的地方被说出来。</span></div>
{mt}{st}{sd}
<div class="section"><span class="sec after">卡片的边界状态</span><span class="sec-sub">真页面截图，原型补丁画出。</span></div>
{states}
'''
(OUT / '02-web-entries.html').write_text(page(
    '没有 workspace 的机器 · Web 入口、提醒和卡片状态',
    '01 是主流程；这里是通向它的入口、让人知道「这台机器还不能用」的提醒，以及设置卡在各种情况下的样子。左边今天、右边方案，都是真页面截图。',
    body2))
print('ok', sorted(p.name for p in (OUT / 'frames').iterdir())[:3], len(list((OUT / 'frames').iterdir())))
