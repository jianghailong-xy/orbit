import json
WEB='/root/.orbit/worktrees/01a215df-3f94-74d0-9903-24ba0498ec7e/src/web/src/index.css'
d=json.load(open('rows.json'))
def hov(h): return h.replace('tp-item mock-hover','tp-item menu-open mock-hover')
def nav(rows, theme='light', title='', head=True):
    body=(d['head'] if head else '')+''.join(hov(r) for r in rows)
    return f'''<div class="frame"><div class="ftitle">{title}</div>
<div class="theme" data-theme-box="{theme}"><div class="app-shell"><nav class="app-nav mock-nav"><div class="tp-lists"><div class="tp-group tp-group-workspaces">{body}</div></div></nav></div></div></div>'''
def frame(v, t, theme='light'): return nav(d[v], theme, t)
html=f'''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://{WEB}">
<style>
.anticon svg{{width:1em;height:1em;fill:currentColor}} .anticon{{display:inline-flex;align-items:center}}
body{{margin:0;background:#eef0f3;font-family:-apple-system,Inter,'Noto Sans SC',sans-serif}}
.board{{width:1560px;padding:40px;background:#f6f7f9;color:#1f2329}}
h1{{font-size:26px;margin:0 0 6px}} .sub{{color:#646a73;font-size:15px;margin-bottom:26px;line-height:1.6}}
.row{{display:flex;gap:22px;margin-bottom:26px;align-items:flex-start}}
.frame{{background:#fff;border:1px solid #dee0e3;border-radius:12px;padding:14px;}}
.ftitle{{font-size:15px;font-weight:600;margin:2px 2px 10px}}
.mock-nav{{height:auto!important;width:264px;border-right:0;padding:6px 0;border-radius:8px}}
.mock-nav .tp-group{{padding:0 8px}}
.mock-hover{{background:var(--bg-hover)}}
.app-shell{{height:auto!important}} .tp-item:not(.mock-hover) .tp-workspace-separator,.tp-item:not(.mock-hover) .tp-workspace-runner{{display:none!important}} .tp-workspace-runner{{flex:none;max-width:60%}}
.theme[data-theme-box=dark] .mock-nav{{background:#1b1d21}}
.mock-badged{{position:relative;display:inline-flex}} .mock-badge{{position:absolute;right:-5px;bottom:-3px;font-size:9px;background:var(--bg-raised);border-radius:50%;color:var(--brand)}}
.notes{{background:#fff;border:1px solid #dee0e3;border-radius:12px;padding:18px 22px;font-size:14.5px;line-height:1.7;flex:1}}
.notes h3{{margin:0 0 8px;font-size:16px}} .notes ul{{margin:0;padding-left:20px}} .rec{{color:#1f7a3d;font-weight:600}} .bad{{color:#b54708}}
table{{border-collapse:collapse;font-size:14px;width:100%}} td,th{{border:1px solid #e5e6eb;padding:7px 10px;text-align:left;vertical-align:top}} th{{background:#f5f6f7}}
.tag{{display:inline-block;background:#e8f3ff;color:#1d4ed8;border-radius:4px;padding:0 6px;font-size:12px;margin-left:6px}}
</style></head><body><div class="board">
<h1>Workspace sidebar icon: where does this workspace run?</h1>
<div class="sub">Basis: "Your agents run on <b>your</b> machines: your internal CLIs, your VPN, your SSH keys; engine logins never leave those machines" (docs/product-intro.md:107) · personality "calm, precise, capable, and honest about boundaries" (docs/project-maturity.md:65).<br>
So the row needs one distinction that changes what the agent can reach: <b>Orbit Cloud (hosted; sleeps; none of your access)</b> vs <b>your machine (your tools and keys)</b>. Which OS a machine runs is not a boundary the person picks a workspace by. The exact machine name is already shown when you hover a row ("· hpc-01").</div>
<div class="row">
{frame('today','① Today: every row a folder')}
{frame('A','A · OS icon on every row (now on this branch)')}
{frame('B','B · Cloud only on Orbit Cloud rows <span class="tag">recommended</span>')}
{frame('C','C · Folder + cloud badge')}
</div>
<div class="row">
{nav(d['statesB'],'light','B · states: running · asleep · needs you · offline · running',head=False)}
{nav(d['statesC'],'light','C · same states: the badge and the status dot share one corner',head=False)}
<div class="frame"><div class="ftitle">B · dark</div><img src="dark.png" style="width:282px;display:block;border-radius:8px"></div>
</div>
<div class="row"><div class="notes">
<h3>Comparison</h3>
<table><tr><th></th><th>A · OS icon on every row</th><th>B · Cloud only on Orbit Cloud rows</th><th>C · Folder + badge</th></tr>
<tr><td>Does it answer "can it reach my VPN/keys?"</td><td>Indirectly: Apple/Linux is one more fact to translate</td><td class="rec">Directly: a cloud row is hosted, every other row is yours</td><td>Yes, but the mark is 9 px</td></tr>
<tr><td>Calm</td><td class="bad">Every row gets a vendor logo; 9 workspaces on Macs = 9 Apples</td><td class="rec">Your machines are the default and look unchanged; only the exception is marked</td><td>Quiet</td></tr>
<tr><td>Tells machines apart</td><td class="bad">No: MacBook and Mac mini look the same</td><td>No (nor does it try); the name shows on hover</td><td>No</td></tr>
<tr><td>Conflict with status marks</td><td>None</td><td>None: dots sit on the cloud's corner as on the folder</td><td class="bad">Yes: running, asleep and offline already occupy the bottom-right corner</td></tr>
<tr><td>Consistent with</td><td>Machines menu (lists machines, not workspaces)</td><td>Machines menu's Orbit Cloud row, same cloud; folder stays the workspace's grammar, as in "Set up …" rows</td><td>-</td></tr>
</table></div>
<div class="notes" style="max-width:440px"><h3>Open for you to decide</h3><ul>
<li><b>Pick: A / B / C</b> (recommended: B).</li>
<li>Collapsed rail (56 px) shows a letter avatar per workspace: under B, should an Orbit Cloud workspace's avatar also carry a cloud? Recommendation: <b>leave it alone</b>; its tooltip already says "cbai · Orbit Cloud".</li>
<li>Android drawer / iOS / macOS: same rule once web is settled.</li></ul>
<h3 style="margin-top:14px">Files</h3><ul><li><code>src/web/src/components/TasksSidePanel.tsx</code>: <code>WorkspaceRow</code> gets an optional <code>machineIcon</code></li><li>For B, the list passes the cloud only when the runner is Orbit Cloud; it no longer uses <code>MachineOsIcon</code> here</li></ul></div></div>
</div>
</body></html>'''
open('board.html','w').write(html)

darkhtml=html.split('<div class="board">')[0].replace('<html>','<html data-theme="dark">')+'<div class="board" style="width:264px;padding:8px;background:#111">'+nav(d['B'],'dark','').replace('<div class="frame"><div class="ftitle"></div>','<div>')+'</div></body></html>'
open('dark.html','w').write(darkhtml)
