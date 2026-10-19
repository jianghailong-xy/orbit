import os
OUT='/root/.orbit/worktrees/01a10cb3-3b39-7587-aea5-2dd20d4d115a/docs/mocks/infrastructure-page'
css=open(OUT+'/ios.css').read()
CHEV='<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>'
def logo(kind,size=26):
    g={'claude':('#d97757','#c15f3c','✳'),'codex':('#4b5158','#1f2226','◎'),'kimi':('#2a2a2a','#000','K'),'agy':('#3fb4f0','#16c18a','A'),
       'deepseek':('#5a7cff','#3b5bdb','D'),'mac':('#8e8e93','#636366','⌘'),'linux':('#8e8e93','#636366','▣')}[kind]
    return f'<span class="mark" style="width:{size}px;height:{size}px;border-radius:7px;background:linear-gradient(135deg,{g[0]},{g[1]});color:#fff;font-weight:700;font-size:{int(size*.55)}px">{g[2]}</span>'
def status(): return '<div class="status"><span>10:04</span><span class="r"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:10px"></i></span><span>5G</span><span class="batt">80</span></span></div>'
def nav(t,back=True,right=''):
    b='<span class="platter circle"><svg class="ico" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></span>' if back else '<span class="platter circle"><svg class="ico" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></span>'
    return f'<div class="nav">{b}<span class="ttl">{t}</span>{right or "<span></span>"}</div>'
def phone(title,body,back=True,right='',top=103):
    return f'<div class="phone">{status()}{nav(title,back,right)}<div class="scroll" style="top:{top}px">{body}</div></div>'
def row(l,v='',icon='',chev=True,sub='',cls='',vcls=''):
    lt=f'<span class="lt2"><span class="lt">{l}</span><span class="lsub">{sub}</span></span>' if sub else f'<span class="lt">{l}</span>'
    return f'<div class="lrow{" two" if sub else ""} {cls}">{icon}{lt}<span class="lv {vcls}">{v}</span>{CHEV if chev else ""}</div>'
def sym(ch,bg): return f'<span class="mark" style="width:29px;height:29px;border-radius:7px;background:{bg};color:#fff;font-size:15px">{ch}</span>'
EXTRA='''
.board{display:flex;flex-direction:column;gap:14px}
.cap{width:393px;font:14px/1.45 "Noto Sans SC",sans-serif;color:#3a3a40}
.cap b{display:block;font-size:16px;color:#000;margin-bottom:3px}
.lv.warn{color:var(--amber-ink)} .lv.ok{color:var(--green-ink)}
.lsub.warn{color:var(--amber-ink)}
.attn{background:#fff;margin:0 16px;border-radius:26px;position:relative}
.attn .lrow .dot{width:9px;height:9px;border-radius:50%;background:var(--amber);flex:none;margin:0 4px 0 2px}
.attn .lrow .dot.off{background:var(--label-3)}
.pill{font-size:14px;font-weight:600;color:#fff;background:var(--tint);border-radius:999px;padding:5px 13px;flex:none}
.pill.ghost{background:var(--fill);color:var(--tint)}
.eng .lsub{white-space:normal;line-height:1.3}
.tagok{font-size:12px;font-weight:600;color:var(--green-ink);background:rgba(52,199,89,.14);border-radius:6px;padding:1px 6px;margin-left:6px;vertical-align:2px}
.tagno{font-size:12px;font-weight:600;color:var(--label-2);background:var(--fill);border-radius:6px;padding:1px 6px;margin-left:6px;vertical-align:2px}
.plus{color:var(--tint);font-size:26px;font-weight:300;line-height:1}
.acct{padding-left:54px}
.mini{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;width:70px}
.mini .gauge{width:60px}
'''
# 1 before
p1=phone('Settings',
 '<div class="sh">Sessions</div><div class="card">'+row('Agents','',sym('✦','#AF52DE'))+row('Session orchestration','',sym('⇄','#5856D6'))+'</div>'
 '<div class="sh">Machines &amp; models</div><div class="card mk" data-n="1">'+row('Runners','2 of 3 online',sym('▭','#007AFF'))+row('Providers','',sym('⏻','#34C759'))+'</div>'
 '<div class="sf">两个入口：登录在 Runner → 引擎页做；Providers 页又把同样的 runner 列一遍，外加 key 和池。</div>'
 '<div class="sh">Account</div><div class="card">'+row('Profile','Wikova',sym('●','#8E8E93'))+row('Preferences','',sym('⚙','#8E8E93'))+'</div>',back=False)
# 2 after settings
p2=phone('Settings',
 '<div class="sh">Sessions</div><div class="card">'+row('Agents','',sym('✦','#AF52DE'))+row('Session orchestration','',sym('⇄','#5856D6'))+'</div>'
 '<div class="sh">Machines &amp; models</div><div class="card mk" data-n="2">'+row('Infrastructure','1 needs you',sym('▭','#007AFF'),vcls='warn')+'</div>'
 '<div class="sf">Your machines, the subscriptions signed in on them, and your API keys.</div>'
 '<div class="sh">Account</div><div class="card">'+row('Profile','Wikova',sym('●','#8E8E93'))+row('Preferences','',sym('⚙','#8E8E93'))+'</div>',back=False)
# 3 compute
p3=phone('Infrastructure',
 '<div class="sh">Needs you</div><div class="attn mk" data-n="3">'
   '<div class="lrow two"><span class="dot"></span><span class="lt2"><span class="lt" style="font-size:16px"><b>Codex</b> signed out</span><span class="lsub">on Mac Studio</span></span><span class="pill">Sign In</span></div>'
   '<div class="lrow two"><span class="dot off"></span><span class="lt2"><span class="lt" style="font-size:16px"><b>ThinkPad</b> is offline</span><span class="lsub">Last seen yesterday</span></span>'+CHEV+'</div></div>'
 '<div class="sh">What agents can run on</div><div class="card eng mk" data-n="4">'
   +row('Claude Code<span class="tagok">Ready</span>','',logo('claude'),sub='2 machines · 3 keys · 1 pool')
   +row('Codex<span class="tagok">Ready</span>','',logo('codex'),sub='HPC ×2')
   +row('Kimi Code<span class="tagok">Ready</span>','',logo('kimi'),sub='HPC')
   +row('Antigravity<span class="tagno">Not set up</span>','',logo('agy'),sub='Install on a machine')+'</div>'
 '<div class="sh">Machines<span class="shr">7 / 12 busy</span></div><div class="card">'
   +row('Mac Studio','',logo('mac'),sub='<span class="warn">2 / 4 running · 1 engine signed out</span>')
   +row('HPC','',logo('linux'),sub='5 / 8 running · All signed in')
   +row('ThinkPad','Offline',logo('linux'),sub='1 of 3 signed in')
   +row('<span class="tintrow">Add Machine</span>','',chev=False)+'</div>'
 '<div class="sh">Account pools</div><div class="card">'+row('Claude keys','1 of 2 available',logo('claude'))+'</div>'
 '<div class="sh">API keys</div><div class="card">'+row('Anthropic (Claude)','',logo('claude'))+row('DeepSeek','',logo('deepseek'))+'</div>',back=False,
 right='<span class="platter circle"><span class="plus">+</span></span>')
# 4 machine detail
p4=phone('Mac Studio',
 '<div class="sh">Capacity</div><div class="card"><div class="lrow"><span class="lt">Running</span><span class="lv">2 of 4</span></div></div>'
 '<div class="sh">Engines</div><div class="card mk" data-n="5">'
   +row('Claude Code','',logo('claude'),chev=False,sub='2.1.4 · 2 of 2 accounts available')
   +'<div class="lrow two acct"><span class="lt2"><span class="lt" style="font-size:16px">Personal Max <span class="chipx brand">NEXT</span></span><span class="lsub">5-hour 38% · resets 02:01</span></span><span class="mini"><span class="pct">38%</span><span class="gauge"><i style="width:38%;background:var(--tint)"></i></span></span></div>'
   +'<div class="lrow two acct"><span class="lt2"><span class="lt" style="font-size:16px">Work</span><span class="lsub">Signed in · no quota reported</span></span></div>'
   +'<div class="lrow acct"><span class="lt tintrow" style="font-size:16px">Add Account</span></div>'
   +'<div class="lrow two">'+logo('codex')+'<span class="lt2"><span class="lt">Codex</span><span class="lsub warn">Signed out</span></span><span class="pill">Sign In</span></div>'
   +'<div class="lrow two">'+logo('kimi')+'<span class="lt2"><span class="lt">Kimi Code</span><span class="lsub">Not installed</span></span><span class="pill ghost">Install</span></div>'
   +'</div><div class="sf">Signed in on this machine — only sessions here spend it.</div>'
 '<div class="sh">Workspaces</div><div class="card">'+row('orbit','Claude Code')+'</div>'
 '<div class="sh">About this machine</div><div class="card">'+row('Version','v0.1.240',chev=False)+row('Host','mac-studio.local',chev=False)+'</div>')
caps=[
 ('现在 · 设置','Runners 和 Providers 两行。Providers 页的「On your runners」就是 runner 列表的重复，用户要分清两页各管什么。'),
 ('之后 · 设置','合成一行「Infrastructure」，右侧直接显示有没有要处理的事。'),
 ('之后 · Infrastructure','③ 需要处理：退出登录、离线，能就地修。④ 每个引擎现在能用什么付费。下面依次是机器、账号池、API key；右上 + 统一新增机器 / API key / 池。'),
 ('之后 · 机器详情','引擎和账号直接挂在机器下，登录、加账号、安装都在这里完成，不再跳去别的页面。'),
]
cells=''.join(f'<div class="board">{p}<div class="cap"><b>{t}</b>{d}</div></div>' for p,(t,d) in zip([p1,p2,p3,p4],caps))
html=f'<!doctype html><html><head><meta charset="utf-8"><style>{css}{EXTRA}</style></head><body><div class="row">{cells}</div></body></html>'
open(OUT+'/03-ios.html','w').write(html)
print('ok')
