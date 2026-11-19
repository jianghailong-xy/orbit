import json, sys
W = sys.argv[1]
s = json.load(open('/mnt/tmp/routing-mode-mock/scenes.json'))
def frame(title, sub, html, mark=None, w=620):
    m = f'<div class="mk">{mark}</div>' if mark else ''
    return f'''<div class="fr" style="width:{w}px"><div class="ft">{title}</div><div class="fs">{sub}</div>
<div class="app settings-page" style="width:{w-40}px">{html}</div>{m}</div>'''
html = f'''<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/root.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/reset.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/index.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/foundation.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/settings/Settings.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/Segmented.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/TextControls.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/NumberInput.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/Button.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/ChoiceControls.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/Floating.css"><link rel="stylesheet" href="file:///root/.orbit/worktrees/01a1f22d-b749-749d-9149-8b367b183cf8/src/web/src/components/ui/Select.css">
<style>
body{{margin:0;background:#eceef2;font-family:Inter,-apple-system,'Noto Sans SC',sans-serif}}
.board{{padding:40px;display:inline-block;background:#eceef2}}
h1{{font-size:30px;margin:0 0 6px}} .lead{{color:#555;margin:0 0 28px;font-size:16px;max-width:1500px}}
.row{{display:flex;gap:28px;align-items:flex-start;margin-bottom:28px}}
.col{{display:flex;flex-direction:column;gap:20px}}
.colh{{font-size:20px;font-weight:700;margin-bottom:4px}}
.fr{{background:#fff;border-radius:14px;padding:18px 20px 22px;box-shadow:0 2px 10px rgba(0,0,0,.08);position:relative}}
.ft{{font-weight:700;font-size:15px}} .fs{{color:#777;font-size:13px;margin:2px 0 12px}}
.app{{background:var(--bg, #fff)}}
.anticon svg{{width:1em;height:1em;fill:currentColor}}
.mk{{position:absolute;right:14px;top:14px;background:#e5484d;color:#fff;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:700}}
.mk.add{{background:#30a46c}}
.notes{{background:#fff;border-radius:14px;padding:20px 24px;width:560px;box-shadow:0 2px 10px rgba(0,0,0,.08);font-size:14px;line-height:1.55}}
.notes h3{{margin:14px 0 6px;font-size:16px}} .notes h3:first-child{{margin-top:0}}
.notes table{{border-collapse:collapse;width:100%}} .notes td,.notes th{{border-top:1px solid #eee;padding:5px 6px;text-align:left;vertical-align:top}}
.notes code{{font-family:'JetBrains Mono',monospace;font-size:12px;background:#f3f4f6;padding:0 4px;border-radius:4px}}
.todo{{background:#fff7e6;border:1px solid #f5c36b;border-radius:10px;padding:10px 14px}}
</style></head><body><div class="board">
<h1>Optimize For 改成账号级</h1>
<p class="lead">今天每个 Agent 各存一份（SubAgents 区和「Smart model selection for tasks」下各一个控件，写同一个字段）。改成：设置 → General → New sessions 里一行，所有 Agent、所有 SubAgent（含跨 workspace）和智能选模型的任务都照它。Agent 页上的两个控件去掉。</p>
<div class="row">
 <div class="col"><div class="colh">① 今天</div>
  {frame('Settings → General', 'New sessions（账号级）', s['generalToday'])}
  {frame('Settings → Agent → SubAgents', '每个 Agent 一份', s['subToday'], '去掉')}
  {frame('Settings → Agent（开了 Smart model selection 才显示）', '同一个字段的第二个控件', s['tasksToday'], '去掉')}
 </div>
 <div class="col"><div class="colh">② 提议</div>
  {frame('Settings → General', '新增一行，紧跟 Smart model selection，改了立即保存', s['generalNew'], '新增')}
  {frame('Settings → Agent → SubAgents', 'Optimize For 行去掉，其余不动', s['subNew'])}
  {frame('Settings → Agent', 'Optimize for 行去掉', s['tasksNew'])}
 </div>
 <div class="notes">
  <h3>规则</h3>
  <table>
   <tr><th>谁读</th><th>今天</th><th>改后</th></tr>
   <tr><td>SubAgent 路由</td><td>父会话 Agent 的 <code>modelRoutingOptimizeFor</code></td><td>账号的 <code>preferences.optimizeFor</code></td></tr>
   <tr><td>跨 workspace 的 SubAgent</td><td>目标 workspace 的</td><td>同一账号的，同一个值</td></tr>
   <tr><td>任务的智能选模型</td><td>任务所在 Agent 的</td><td>账号的</td></tr>
   <tr><td>没设过</td><td>Cost</td><td>Cost</td></tr>
  </table>
  <h3>旧数据</h3>
  <p>生产 50 个 Agent 全是 Cost，没有要搬的值。<code>workspace.model_routing_optimize_for</code> 列留着不读（不删列，不写破坏性迁移）；Agent 的 PATCH 仍收这个字段但忽略，老客户端不报错。</p>
  <h3>Agent 工具</h3>
  <p>智能体照旧能改：<code>agent_update</code> 不再收 Optimize For，改成账号偏好的写法（同 Smart model selection）。</p>
  <h3>要改的文件</h3>
  <p>服务端：<code>subagent-route.ts</code>、<code>task-route-decision.ts</code>、偏好 DTO（<code>dto.ts</code> <code>UserPreferences</code>）、<code>workspaces/dto.ts</code>。<br>
  Web：<code>pages/settings/GeneralPage.tsx</code>、<code>settingsIndex</code>（设置搜索）、<code>SubagentSettings.tsx</code>、<code>WorkspaceSettingsPage.tsx</code>。<br>
  Apple：<code>SubagentSettings.swift</code>、<code>SubagentViews.swift</code>、<code>AgentsView.swift</code>、General 设置页。<br>
  Android：<code>Subagents.kt</code>、<code>WorkspaceSettings.kt</code>、General 设置页。</p>
  <h3>待你定</h3>
  <div class="todo">
   ① 位置：General → New sessions、紧跟 Smart model selection（图里这样），还是单开一个 “Routing” 小节？<br>
   ② 控件：分段按钮（同今天 SubAgents 区，图里这样）还是下拉？<br>
   ③ Agent 页上要不要留一行灰字 “Optimize For is account-wide: Settings → General”，还是直接去掉（图里直接去掉）？
  </div>
 </div>
</div></div></body></html>'''
open('/mnt/tmp/routing-mode-mock/board.html','w').write(html)
