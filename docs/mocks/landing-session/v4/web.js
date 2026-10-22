// 2026-10-18 · 落地会话 v4（第 1 段从 v3 抄来）· web 控制台部件（依赖 kit.js 的 ic/IC/mk/badge）。每块都返回 HTML 字符串。
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

// ── 4 · v4 新增（main 1c1c78d72：ProjectLandingCard.tsx、ProjectPanoramaHeader.tsx 的 LandingHead、LandingJobsSheet.tsx、
//    ProjectMergeStrip.tsx、WorkspaceView.tsx 的 SessionProjectLanding）──
const wMark = (tone) => tone === 'warn' ? wGlyph('warn', 15) : tone === 'ok' ? ic('merge', 15, 'currentColor', 2.2) : tone === 'landed' ? ic('check', 14, 'currentColor', 2.6) : tone === 'fail' ? ic('x', 12, 'currentColor', 2.8) : wGlyph('spin', 15);
const wh4 = ({ tone = 'run', mark, title, right = '', rcls = '', detail = '' }) => `<span class="wh4 ${tone === 'landed' ? 'ok' : tone}"><span class="m">${mark || wMark(tone)}</span><span class="b"><span class="l1"><b>${title}</b>${right ? `<span class="rr ${rcls}">${right}</span>` : ''}</span>${detail ? `<span class="l2">${detail}</span>` : ''}</span></span>`;
const wlc4 = (inner, warn = false) => `<div class="wlc4${warn ? ' warn' : ''}">${inner}</div>`;
const wWhat = (t) => `<span class="what">${t}</span>`;
const wJobs = (rows) => `<ul>${rows.map(({ t, st, cls = '', ol = '' }) => `<li><span class="t">${t}</span><span class="st ${cls}">${st}</span>${ol}</li>`).join('')}</ul>`;
const wRef = (b = BR4) => `<span class="ref">onto ${b}</span>`;
const wNote = (t = NOTHING) => `<span class="note">${t}</span>`;
const wDet = (t) => `<span class="det">${t}</span>`;
const wFoot = (l, r = '') => `<div class="foot"><span class="gap">${l}</span><span class="gap">${r}</span></div>`;
const wOpenL = (t = 'Open landing ›') => `<span class="wlk">${t}</span>`;
const wmc4 = (cls, inner) => `<div class="wmc4 ${cls}">${inner}</div>`;
const wmHead = (title, kind = 'merge') => `<div class="mh"><span class="tile">${kind === 'warn' ? wGlyph('warn', 13) : ic('merge', 13, 'currentColor', 2.2)}</span><b>${title}</b></div>`;
const wcolHead4 = (sessions = 76, title = P4) => `<div class="hd"><span style="color:var(--text-2)">${ic('chevl', 16, '#646a73', 2.2)}</span><span class="tt"><b>${title}</b><span>Project · ${sessions} sessions</span></span><span class="gb">${ic('grid', 17, '#646a73', 1.7)}</span></div>`;
const wpc4 = (done = 44, total = 46, run = 0) => `<div class="wpc4"><span class="bar"><i style="width:${done / total * 100}%;background:#2ea121"></i><i style="width:${run / total * 100}%;background:#3370ff"></i></span>${done}/${total} done · ${run} running</div>`;
const WBUB = ic('bubble', 17, '#8f959e', 1.7);
const wrow4 = ({ t, tm, chip, sub, cls = '', sel = false, icon = WBUB }) => `<div class="wrow4${sel ? ' sel' : ''}"><span class="ic">${icon}</span><span class="bd"><span class="a"><span class="t">${t}</span><span class="tm">${tm}</span>${chip ? `<span class="wchip4">${chip}</span>` : ''}</span><div class="s ${cls}">${sub}</div></span></div>`;
const wsec5 = (t) => `<div class="wsec5">${t}</div>`;
const W_COORD = wrow4({ t: P4, tm: '1m ago', chip: 'Coordinator', sub: 'Watching any 1 of 12 tasks…', sel: true });
const W_ROWS = [
  wrow4({ t: `执行任务：${TA}`, tm: '1m ago', sub: 'Recap · 9:05 AM Fixed the wiki daily-limit NULL trap' }),
  wrow4({ t: `执行任务：${TC}`, tm: '20m ago', sub: 'Recap · 8:45 AM 第 101 轮已收尾：生产被他人部署到 756…' }),
  wrow4({ t: `执行任务：${TB}`, tm: '23m ago', sub: 'Recap · 8:43 AM 修复 wiki-maintain 跨页重复读会话' }),
];
const wtr4 = (h) => `<div class="wtr4">${h}</div>`;
const wJobsDlg = ({ title, rows, top = 90, left = 300 }) => `<div class="wdim"></div><div class="wdlg4" style="top:${top}px;left:${left}px"><div class="dh">${title}<span class="x">${ic('x', 16, '#8f959e', 2.2)}</span></div><div class="ljobs4">${rows.join('')}</div></div>`;
const wJr = ({ h, what = '', det = '', chev = true, un = '' }) => `<div class="jr"><div class="op"><div class="bd">${h}${what ? `<div class="what">${what}</div>` : ''}${det ? `<div class="det">${det}</div>` : ''}</div><span class="chev">${chev ? '›' : ''}</span></div>${un}</div>`;
const wConv4 = () => `<div class="mhd"><div class="bc">‹ ${P4}</div><div class="t"><b>${P4}</b><span class="wchip4">Coordinator</span><span class="wbtn sm pill">Follow</span><span class="more">${ic('dots', 18, '#646a73', 1.6)}</span></div><div class="sub">Watching · Open · now</div></div>
<div class="msg">维护每日轮数上限那一项已交付：byJob 现在按 COALESCE 计数，10-10 的 13 轮在新查询下是 8 轮，测试补上了 NULL 的情形。等它落上项目分支，我再看下一项。</div>
<div class="msg u">好，dossier 跨页那一项也一起看一下。</div>
<div class="msg">dossier 那一项也已交付，排在它后面落地。两项都落上去以后，合入检查会自己跑。</div><div class="composer">Message the coordinator…</div>`;
const webFrame4 = ({ w = 1240, h = 760, col, main = wConv4(), overlay = '' }) => `<div class="webf" style="width:${w}px;height:${h}px">${wsb(P4)}<div class="wcol4">${col}</div><div class="wmain4">${main}</div>${overlay}</div>`;
