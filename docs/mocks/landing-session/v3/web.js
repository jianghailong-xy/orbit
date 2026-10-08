// 2026-10-08 · 落地会话 v3 · web 控制台部件（依赖 kit.js 的 ic/IC/mk/badge）。每块都返回 HTML 字符串。
// 词与结构照 main 2ba6765d9：ProjectPanoramaHeader.tsx 的 LandingRow、LandingJobsSheet.tsx、WorkspaceView.tsx 的项目会话栏、
// ProjectMergeStrip.tsx、OpenItemDeliveryCard.tsx、ProjectProgressStatus.tsx 的 ItemCard、LandTaskStatus.tsx。

// web 的 Glyph：spinner（带箭头的开口环）与 exclamation（静止的警告三角）
const wGlyph = (shape, size = 13) => shape === 'warn'
  ? `<svg width="${size}" height="${size}" viewBox="0 0 12 12" style="flex:none"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.2 L10.9 10.6 H1.1 Z"/><path d="M6 5 V6.9"/><circle cx="6" cy="8.75" r=".75" fill="currentColor" stroke="none"/></g></svg>`
  : `<svg width="${size}" height="${size}" viewBox="0 0 12 12" style="flex:none"><path d="M10.5 6 A4.5 4.5 0 1 1 6 1.5 M6 1.5 L4 3.4 M6 1.5 L8 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const wChev = '<span class="chev">›</span>';

// 左栏
const wsb = (project = PROJECT) => `<div class="wsb"><div class="logo"><i></i>Orbit</div>
<div class="it">${ic('grid', 16, '#646a73', 1.7)}Projects<span class="k">Ctrl P</span></div>
<div class="it">${ic('task', 16, '#646a73', 1.7)}Tasks</div>
<div class="it">${ic('doc', 16, '#646a73', 1.7)}Wiki</div>
<div class="it">${ic('term', 16, '#646a73', 1.7)}Runners</div>
<div class="it">${ic('card', 16, '#646a73', 1.7)}Providers</div>
<div class="hd">Workspaces 1</div><div class="it">${ic('card', 16, '#646a73', 1.7)}orbit-develop<span class="k">Ctrl 1</span></div>
<div class="hd">Projects 1</div><div class="it on"><span class="dot"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${project}</span></div>
<div class="me"><i></i>Owner</div></div>`;

// web 的 LandingRow（.project-landing）；v6 = 改后的读法
const pl = ({ tone = 'idle', word, state, what, label, clock, right = '', v6 = null }) => {
  let meta = '';
  if (v6) {
    meta = `<div class="mt"><span>${v6.step} <b>${v6.clock}</b>${v6.budget ? ` / ${v6.budget}` : ''}</span><span>${v6.usual || ''}</span></div>`
      + (v6.bar != null ? `<div class="bud2"><i style="width:${v6.bar}%"></i>${v6.tick ? `<u style="left:${v6.tick}%"></u>` : ''}</div>` : '')
      + (v6.live ? `<div class="lv"><span class="dt"></span>${v6.live}</div>` : '');
  } else if (label != null) {
    meta = `<div class="mt"><span>${label} <b>${clock}</b></span><span>${right}</span></div>`;
  }
  return `<div class="pl ${tone}"><div class="h"><span class="ring">${wGlyph(tone === 'warn' ? 'warn' : 'spin')}</span><span class="wd">${word}</span><span class="st">${state}</span></div>
${what ? `<div class="wh">${what}</div>` : ''}${meta}</div>`;
};
// 项目会话栏里的落地行：一个按钮，行加箭头
const wland = (plHtml) => `<div class="wland">${plHtml}${wChev}</div>`;
const wcard = ({ done, total, run, landing = '' }) => `<div class="wcard"><div class="pg"><span class="bar"><i style="width:${done / total * 100}%;background:#2ea121"></i><i style="width:${run / total * 100}%;background:#3370ff"></i></span>${done}/${total} done · ${run} running</div>${landing}</div>`;
const wcolHead = (sessions, title = PROJECT) => `<div class="hd"><span class="bk">${ic('chevl', 16, '#646a73', 2.2)}</span><span class="tt"><b>${title}</b><span>Project · ${sessions} sessions</span></span><span class="gb">${ic('grid', 17, '#646a73', 1.7)}</span></div>`;
const wrow = ({ t, tm, chip, sub, cls = '', sel = false, lead = '' }) => `<div class="wrow${sel ? ' sel' : ''}"><div class="a">${lead}<span class="t">${t}</span><span class="tm">${tm}</span>${chip === 'co' ? '<span class="wchip co">Coordinator</span>' : ''}</div>
<div class="b">${chip === 'ld' ? '<span class="wchip ld">Landing</span>' : ''}<span class="s ${cls}">${sub}</span></div></div>`;
const wsec = (t) => `<div class="wsec">${t}</div>`;
const wfold = (t) => `<div class="wfold">${ic('check', 13, '#1a7f37', 2.4)}${t}<span class="r">›</span></div>`;

// 作业清单（LandingJobsSheet：宽屏是对话框）。一行：落地行（任务的行带箭头）、detail、Retry、v3 的 Open landing ›
const wjr = ({ plHtml, chevron = true, detail = '', retry = false, open = '' }) => `<div class="jr2"><div class="op"><div style="flex:1;min-width:0">${plHtml}${detail ? `<div class="det">${detail}</div>` : ''}</div>${chevron ? '<span class="chev">›</span>' : '<span class="chev"></span>'}</div>
${retry ? '<span class="wbtn pri pill full">Retry</span>' : ''}${open ? `<div class="ol">${open}</div>` : ''}</div>`;
const wOpen = (t = 'Open landing ›') => `<span class="lk">${t}</span>`;
const wdlg = ({ title, rows, top = 90, left = 260 }) => `<div class="wdim"></div><div class="wdlg" style="top:${top}px;left:${left}px"><div class="dh">${title}<span class="x">${ic('x', 15, '#8f959e', 2.4)}</span></div><div class="ljobs">${rows.join('')}</div></div>`;

// 整个窗口：左栏 + 项目会话栏 + 主区（+ 浮层）
const webFrame = ({ w = 1180, h = 720, col, main, overlay = '', sidebar = true }) => `<div class="webf" style="width:${w}px;height:${h}px">${sidebar ? wsb() : ''}<div class="wcol">${col}</div><div class="wmain">${main}</div>${overlay}</div>`;
const wConvHead = (title, sub, chip = 'Coordinator') => `<div class="mhd"><div class="bc">‹ ${PROJECT}</div><div class="t"><b>${title}</b>${chip ? `<span class="wchip co">${chip}</span>` : ''}<span class="wbtn sm pill">Follow</span><span class="more">${ic('dots', 18, '#646a73', 1.6)}</span></div><div class="sub">${sub}</div></div>`;
