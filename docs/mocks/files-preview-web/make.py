# Builds board.html: the Files details pane (real classes, the app's own CSS) for text/code, HTML and PDF, today vs proposal.
import html, pathlib
HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parents[2] / 'src/web/src'
css = ''.join(f'<link rel="stylesheet" href="file://{SRC / p}">' for p in ['index.css', 'components/ui/foundation.css', 'components/ui/Button.css', 'pages/FilesPage.css'])

DL = '<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor"><path d="M505.7 661a8 8 0 0012.6 0l112-141.7c4.1-5.2.4-12.9-6.3-12.9h-74.1V168c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v338.3H400c-6.7 0-10.4 7.7-6.3 12.9l112 141.8zM878 626h-60c-4.4 0-8 3.6-8 8v154H214V634c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v198c0 17.7 14.3 32 32 32h684c17.7 0 32-14.3 32-32V634c0-4.4-3.6-8-8-8z"/></svg>'
LINK = '<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor"><path d="M574 665.4a8.03 8.03 0 00-11.3 0L446.5 781.6c-53.8 53.8-144.6 59.5-204 0-59.5-59.5-53.8-150.2 0-204l116.2-116.2c3.1-3.1 3.1-8.2 0-11.3l-39.8-39.8a8.03 8.03 0 00-11.3 0L191.4 526.5c-84.6 84.6-84.6 221.5 0 306s221.5 84.6 306 0l116.2-116.2c3.1-3.1 3.1-8.2 0-11.3L574 665.4zm258.6-474c-84.6-84.6-221.5-84.6-306 0L410.3 307.6a8.03 8.03 0 000 11.3l39.7 39.7c3.1 3.1 8.2 3.1 11.3 0l116.2-116.2c53.8-53.8 144.6-59.5 204 0 59.5 59.5 53.8 150.2 0 204L665.3 562.6a8.03 8.03 0 000 11.3l39.8 39.8c3.1 3.1 8.2 3.1 11.3 0l116.2-116.2c84.5-84.6 84.5-221.5 0-306.1z"/></svg>'
OPEN = '<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor"><path d="M888 868H136V156h336V92H104c-17.7 0-32 14.3-32 32v776c0 17.7 14.3 32 32 32h816c17.7 0 32-14.3 32-32V552h-64zM588 92v64h233L489 488l45 45 332-332v233h64V92z"/></svg>'

def pane(name, size, preview='', mark=''):
    return f'''<div class="frame">{mark}<aside class="files-pane">{preview}
<h2 class="files-pane-name">{name}</h2><div class="files-pane-kind">{size}</div>
<dl class="files-pane-facts"><dt>Last written</dt><dd>Today 14:32</dd><dt>By</dt><dd>Claude · Feishu bot session</dd>
<dt>Path</dt><dd class="files-pane-path">/Files/reports/{name}</dd><dt>Earlier versions</dt><dd>2</dd></dl>
<div class="files-pane-actions"><button class="orbit-button orbit-button-default orbit-button-middle"><span class="orbit-button-icon">{DL}</span>Download</button>
<button class="orbit-button orbit-button-primary orbit-button-middle"><span class="orbit-button-icon">{LINK}</span>Share link…</button></div></aside></div>'''

CODE = '''{
  "run": "landing-check",
  "commit": "5c1aa9c266",
  "durationMs": 1832400,
  "steps": [
    { "name": "overlay", "ok": true, "ms": 41200 },
    { "name": "npm run build", "ok": true, "ms": 1791200 }
  ],
  "warnings": [
    "src/web: chunk index-3f9a.js is larger than 500 kB after minification"
  ],
  "result": "PASS"
}'''
text = f'<pre class="files-preview-text">{html.escape(CODE)}</pre>'
text_cut = f'<pre class="files-preview-text">{html.escape(chr(10).join(f"2026-11-24T09:{i//60:02d}:{i%60:02d}Z runner  heartbeat ok slot=2 load=0.{i%9}" for i in range(14)))}</pre><div class="files-preview-note">Showing the first 1 MB of 6.4 MB.</div>'

PAGE = '''<html><body style="font:13px -apple-system,Inter,sans-serif;margin:16px;color:#1f2328">
<h1 style="font-size:18px;margin:0 0 6px">Weekly landing report</h1><p style="color:#59636e;margin:0 0 12px">Week 47 · 38 landings, 2 reds</p>
<table style="border-collapse:collapse;width:100%"><tr style="background:#f6f8fa"><th align=left style="padding:4px;border:1px solid #d1d9e0">Project</th><th style="padding:4px;border:1px solid #d1d9e0">Landed</th><th style="padding:4px;border:1px solid #d1d9e0">Red</th></tr>
<tr><td style="padding:4px;border:1px solid #d1d9e0">Landings window</td><td align=center style="border:1px solid #d1d9e0">14</td><td align=center style="border:1px solid #d1d9e0">1</td></tr>
<tr><td style="padding:4px;border:1px solid #d1d9e0">Session three-state</td><td align=center style="border:1px solid #d1d9e0">17</td><td align=center style="border:1px solid #d1d9e0">0</td></tr>
<tr><td style="padding:4px;border:1px solid #d1d9e0">Help center</td><td align=center style="border:1px solid #d1d9e0">7</td><td align=center style="border:1px solid #d1d9e0">1</td></tr></table>
<p style="margin-top:12px">Both reds were DNS flaps on github.com; each landed on retry.</p></body></html>'''
htmlp = f'<iframe class="files-preview-page" sandbox="" srcdoc="{html.escape(PAGE, quote=True)}" title="weekly-report.html"></iframe>'

def sheet(lines):
    rows = ''.join(f'<div style="height:4px;margin:0 0 7px;background:#c9ced6;border-radius:2px;width:{w}%"></div>' for w in lines)
    return f'<div style="background:#fff;margin:0 auto 10px;width:82%;padding:16px 14px;box-shadow:0 1px 3px rgba(0,0,0,.25)"><div style="height:7px;width:55%;background:#59636e;border-radius:2px;margin-bottom:12px"></div>{rows}</div>'
pdf_inline = ('<div class="files-preview-pdf"><div class="pdfbar"><span>1 / 12</span><span>— 100% +</span><span>⤓ ⎙ ⋮</span></div>'
              f'<div class="pdfbody">{sheet([96,88,92,70,95,84,60,90,93,40])}{sheet([90,94,80])}</div></div>')
pdf_tile = (f'<div class="files-preview-pdf-tile"><div class="pdf-badge">PDF</div><div><div style="font-weight:600">Open preview</div>'
            f'<div style="color:var(--text-3);font-size:12px">Opens in a new tab, in the browser\'s PDF viewer</div></div><span class="ext">{OPEN}</span></div>')
toobig = '<div class="files-preview-none">Too large to preview (48 MB). Download it to open.</div>'

def m(n, x, y): return f'<b class="mk" style="left:{x}px;top:{y}px">{n}</b>'

board = f'''<!doctype html><html><head><meta charset="utf-8">{css}<style>
body{{margin:0;background:#eceef2}}
.board{{width:2290px;padding:28px 32px 36px;font-family:-apple-system,Inter,'Noto Sans SC',sans-serif;color:#1f2328}}
h1{{font-size:26px;margin:0 0 4px}} .sub{{color:#59636e;font-size:14px;margin:0 0 22px}}
.row{{display:flex;gap:22px;align-items:flex-start;margin-bottom:26px}}
.col h3{{font-size:15px;margin:0 0 8px}} .col p{{font-size:12.5px;color:#59636e;margin:0 0 10px;width:338px;line-height:1.5}}
.frame{{position:relative;background:var(--bg,#fff);border:1px solid #d1d9e0;border-radius:10px;overflow:visible;width:338px}}
.frame .files-pane{{border-left:0}}
.tag{{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:10px;margin-right:6px}}
.today{{background:#ffebe9;color:#cf222e}} .new{{background:#dafbe1;color:#1a7f37}} .alt{{background:#fff8c5;color:#9a6700}}
.mk{{position:absolute;width:22px;height:22px;border-radius:11px;background:#cf222e;color:#fff;font:700 12px/22px Inter;text-align:center;z-index:3}}
.notes{{display:flex;gap:22px}} .card{{background:#fff;border:1px solid #d1d9e0;border-radius:10px;padding:14px 18px;font-size:13px;line-height:1.55}}
.card h3{{margin:0 0 8px;font-size:15px}} .card table{{border-collapse:collapse}} .card td,.card th{{border:1px solid #d1d9e0;padding:4px 8px;vertical-align:top;text-align:left}}
code{{font-family:'JetBrains Mono',monospace;font-size:12px;background:#f0f2f5;padding:0 3px;border-radius:3px}}
.ask{{border:2px solid #bf8700;background:#fffbea}}
/* proposal styles (would go in FilesPage.css) */
.files-preview-text{{max-height:360px;overflow:auto;margin:0 0 12px;padding:10px 12px;border:1px solid var(--border-subtle);border-radius:8px;
  background:var(--bg-sunken);font:12px/1.5 'JetBrains Mono',ui-monospace,monospace;white-space:pre;tab-size:2}}
.files-preview-note{{margin:-6px 0 12px;font-size:12px;color:var(--text-3)}}
.files-preview-page{{display:block;width:100%;height:360px;margin:0 0 12px;border:1px solid var(--border-subtle);border-radius:8px;background:#fff}}
.files-preview-pdf{{height:360px;margin:0 0 12px;border:1px solid var(--border-subtle);border-radius:8px;overflow:hidden;background:#525659}}
.pdfbar{{display:flex;justify-content:space-between;padding:6px 10px;background:#323639;color:#f1f1f1;font-size:11px}} .pdfbody{{padding:12px 0}}
.files-preview-pdf-tile{{display:flex;gap:12px;align-items:center;padding:14px;margin:0 0 12px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-sunken);font-size:13px}}
.pdf-badge{{width:40px;height:48px;border-radius:4px;background:#cf222e;color:#fff;font:700 11px/48px Inter;text-align:center}} .ext{{margin-left:auto;color:var(--text-3)}}
</style></head><body><div class="board">
<h1>Files 预览：文本 / 代码、HTML、PDF</h1>
<div class="sub">Web · Files 详情面板（宽 336 px）· 今天只有图片和 Markdown 有预览（<code>FilesPage.tsx:250</code>），其他文件什么也不画。下面的框都是真实的 class + 应用自己的 CSS。</div>

<div class="row">
 <div class="col"><h3><span class="tag today">① 今天</span>landing-check.json</h3><p>没有预览：面板直接从文件名开始，只能下载。.html 和 .pdf 也一样。</p>{pane('landing-check.json','2 KB')}</div>
 <div class="col"><h3><span class="tag new">② 文本 / 代码</span>landing-check.json</h3><p>等宽原文，不换行、横向滚动，最高 360 px（同 Markdown 框）。不做语法高亮。</p>{pane('landing-check.json','2 KB',text)}</div>
 <div class="col"><h3><span class="tag new">② 大文本只读前 1 MB</span>runner.log</h3><p>用现有 Range 读取（<code>MARKDOWN_PREVIEW_BYTES</code>），超过时下方一行灰字说明。</p>{pane('runner.log','6.4 MB',text_cut)}</div>
 <div class="col"><h3><span class="tag new">② HTML</span>weekly-report.html</h3><p>渲染页面：<code>&lt;iframe sandbox="" srcdoc&gt;</code>——不跑脚本、无同源、不能提交表单或跳走。本框就是这样渲染的。</p>{pane('weekly-report.html','3 KB',htmlp)}</div>
</div>

<div class="row">
 <div class="col"><h3><span class="tag new">② PDF · 方案 A 内嵌</span>design-review.pdf</h3><p>浏览器自带 PDF 阅读器嵌在面板里（示意图），可翻页、缩放。需要放宽 CSP：<code>frame-src 'self' blob:</code>。</p>{pane('design-review.pdf','1.8 MB',pdf_inline)}</div>
 <div class="col"><h3><span class="tag alt">② PDF · 方案 B 新标签页</span>design-review.pdf</h3><p>面板里一块“Open preview”，点开在新标签页里用浏览器看。不改 CSP，复用 <code>openUserFile</code>（PDF 已在允许列表）。</p>{pane('design-review.pdf','1.8 MB',pdf_tile)}</div>
 <div class="col"><h3><span class="tag new">② 太大</span>scan.pdf</h3><p>PDF 和 HTML 要整读：超过 30 MB（同图片上限）不读，只写一行。HTML 上限 1 MB 截断后照样渲染。</p>{pane('scan.pdf','48 MB',toobig)}</div>
 <div class="notes" style="flex-direction:column;width:600px">
  <div class="card"><h3>规则</h3><table>
   <tr><th>类型</th><th>按扩展名认</th><th>读多少</th><th>怎么画</th></tr>
   <tr><td>文本 / 代码</td><td>txt log csv tsv json jsonl yaml yml toml ini xml sql sh py go rs ts tsx js mjs css swift kt java c h cpp diff patch …</td><td>前 1 MB</td><td><code>&lt;pre&gt;</code> 等宽</td></tr>
   <tr><td>HTML</td><td>html htm</td><td>前 1 MB</td><td>sandbox iframe（srcdoc）</td></tr>
   <tr><td>PDF</td><td>pdf</td><td>整份，≤ 30 MB</td><td>见方案 A / B</td></tr>
   <tr><td>其他</td><td>—</td><td>—</td><td>同今天：无预览</td></tr></table>
   <p style="margin:8px 0 0">读失败沿用 “Couldn't load the preview.”；读取中 “Loading preview…”。文件图标：文本 / HTML / PDF 换成对应的 antd 图标。</p></div>
  <div class="card"><h3>要改的文件</h3><code>src/web/src/pages/FilesPage.tsx</code>（Preview 分支 + 三个组件）· <code>lib/drive.ts</code>（isText / isHtml / isPdf）· <code>pages/FilesPage.css</code> · 测试 <code>FilesPage.test.tsx</code>；方案 A 另加 <code>src/web/nginx.conf</code> 两处 CSP。</div>
  <div class="card ask"><h3>待你定</h3>
   ① PDF 用 <b>方案 A 内嵌</b>（我推荐：面板里就能看；代价是 CSP 放宽 <code>frame-src blob:</code>，只放行本页自己生成的 blob，HTML 等类型的 blob 已被标成下载）还是 <b>方案 B 新标签页</b>（零安全改动，但不算“面板里预览”）？<br>
   ② HTML 只渲染页面就行，还是要加一个 Page / Source 切换？（我倾向不加，源码可下载看。）</div>
 </div>
</div>
</div></body></html>'''
(HERE / 'board.html').write_text(board)
