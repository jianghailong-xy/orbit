// 2026-10-18 · 落地会话 v4（第 1 段从 v3 抄来）· Android 部件（依赖 kit.js 的 ic/IC/mk/badge）。结构照 src/android：ProjectsScreen.kt（页头、Open items、
// Work overview 与 LandingRow）、MainActivity.kt 的 TopAppBar、SessionReader.kt、BusinessCard.kt、TaskDetail.kt / TaskViews.kt、WikiChrome.kt 的 ModalBottomSheet。

// 状态栏与 TopAppBar（返回、标题、右侧动作）
const aStatus = (t) => `<div class="sbar"><span>${t}</span><span class="ic">
<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.5 15.5 3A11 11 0 0 0 .5 3z" fill="#1C1C1E"/></svg>
<svg width="14" height="12" viewBox="0 0 14 12"><path d="M13.5 .5v11h-13z" fill="#1C1C1E"/></svg>
<svg width="9" height="14" viewBox="0 0 9 14"><rect x=".5" y="1.5" width="8" height="12" rx="1.5" fill="#1C1C1E"/><rect x="2.5" y=".2" width="4" height="1.6" rx=".6" fill="#1C1C1E"/></svg></span></div>`;
Object.assign(IC, {
  aback: '<path d="M20 12H5"/><path d="M11 6l-6 6 6 6"/>',
  amenu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  arefresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  ashare: '<circle cx="17" cy="5.5" r="2.3"/><circle cx="6.5" cy="12" r="2.3"/><circle cx="17" cy="18.5" r="2.3"/><path d="M8.6 10.8l6.3-3.9M8.6 13.2l6.3 3.9"/>',
  aclose: '<path d="M6 6l12 12M18 6L6 18"/>',
});
const aTab = (title, actions = ['amenu', 'arefresh']) => `<div class="tab"><span class="ib">${ic('aback', 24, '#1C1C1E', 1.8)}</span><span class="tt">${title}</span>${actions.map((a) => `<span class="ib">${ic(a, 24, '#1C1C1E', 1.8)}</span>`).join('')}</div>`;
const aPhone = (inner, cls = '') => `<div class="and ${cls}">${inner}<div class="gbar"></div></div>`;
// M3 的不定进度圈（16dp，描边 2dp）
const aSpin = (c = '#0066BE', s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" style="flex:none"><circle cx="8" cy="8" r="6.6" fill="none" stroke="${c}" stroke-opacity=".18" stroke-width="2"/><path d="M8 1.4a6.6 6.6 0 0 1 6.6 6.6" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`;
const aTri = (c = '#985900', s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="flex:none"><path d="M12 3 22 20.5H2z" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 9.5v5" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.2" fill="${c}"/></svg>`;

// 项目页
const aHeader = ({ title = PROJECT, tasks = 20, facts }) => `<div class="hdr"><div class="r1"><span class="hs">${title}</span><span class="tbtn" style="font-size:20px;padding:0 8px">⋯</span></div>
<div style="display:flex;align-items:center;gap:8px"><span class="chipa brand">Open</span><span class="lm">${tasks} tasks</span></div>
${facts ? `<div class="lm">${facts}</div>` : ''}</div>`;
const aShd = (title, detail = '') => `<div class="shd"><b>${title}</b><span class="lm">${detail}</span></div>`;
const aItem = ({ title, detail, meta, own = false, action, actionCls }) => `<div class="irow"><span class="dt${own ? ' own' : ''}"></span><div class="cl"><span class="t">${title}</span>${detail ? `<span class="lm">${detail}</span>` : ''}<span class="ls">${meta}</span></div>${action ? `<span class="abtn ${actionCls || (own ? 'fill' : 'tonal')} max150">${action}</span>` : ''}</div>`;
// LandingRow：左边进度圈 / ◌ / ▲，中间两行，右边时钟；改后在右边加 ›，可以点
const aLand = ({ tone = 'run', l1, l2, l3 = '', cl, clk, chevron = false, bar = null }) => `<div class="alr ${tone}">${tone === 'run' ? aSpin() : tone === 'warn' ? aTri() : '<span class="ring">◌</span>'}
<div class="mid"><div class="l1">${l1}</div><div class="l2">${l2}</div>${bar != null ? `<div class="lbar"><i style="width:${bar}%"></i></div>` : ''}${l3 ? `<div class="l3">${l3}</div>` : ''}</div>
<div class="rt"><div class="cl">${cl}</div><div class="clk">${clk}</div></div>${chevron ? '<span class="chev">›</span>' : ''}</div>`;
const aCells = (cells) => `<div class="cells">${cells.map(([g, gc, label, v, foot]) => `<div class="cell"><div class="lm" style="color:#1C1C1E"><span style="color:${gc}">${g}</span> ${label}</div><div class="v">${v}</div><div class="ls">${foot}</div></div>`).join('')}</div>`;
const CELLS_1120 = [['●', '#0066BE', 'Running', 1, 'task work in progress'], ['◌', '#555861', 'Ready', 0, 'can start now'], ['▲', '#985900', 'Waiting', 2, 'waiting on dependencies'],
  ['⧗', '#555861', 'Pending landing', 3, 'no landing receipt yet'], ['⎇', '#247344', 'On project branch', 12, 'not on main yet'], ['✓', '#247344', 'On main', 0, 'landed on main']];
const aMeter = (parts) => `<div class="meter8">${parts.map(([w, c]) => `<i style="width:${w}%;background:${c}"></i>`).join('')}</div>`;
const METER_1120 = aMeter([[5, '#0066BE'], [10, '#985900'], [15, '#757881'], [60, '#247344']]);

// sheet（ModalBottomSheet）与其中的一行
const aSheet = ({ title, rows, top }) => `<div class="scrim"></div><div class="msheet" style="top:${top}px"><div class="hdl"></div>
<div class="shh"><span style="width:40px;height:40px;display:flex;align-items:center;justify-content:center">${ic('aclose', 22, '#1C1C1E', 1.8)}</span><span class="tm">${title}</span></div>${rows.join('')}</div>`;
const aJob = ({ tone = 'idle', l1, what = '', l2, cl, clk, chevron = true, det = '', acts = '' }) => `<div class="jrow ${tone}"><div class="top">${tone === 'run' ? aSpin() : tone === 'warn' ? aTri() : '<span style="font-size:17px;color:#555861;width:16px;text-align:center">◌</span>'}
<div class="mid"><div class="l1">${l1}</div>${what ? `<div class="w">${what}</div>` : ''}<div class="l2">${l2}</div></div>
<div class="rt" style="text-align:right;flex:none"><div class="ls">${cl}</div><div class="clk" style="font-size:17px;font-weight:500;white-space:nowrap">${clk}</div></div>${chevron ? '<span style="font-size:20px;color:#555861">›</span>' : '<span style="width:9px"></span>'}</div>
${det ? `<div class="det">${det}</div>` : ''}${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
const aOpen = (t = 'Open landing ›') => `<span class="tbtn" style="padding:0 8px">${t}</span>`;

// 会话阅读页
const aReaderTop = (title, status) => `<div class="rbtns"><span class="tbtn">${title}</span><span class="tbtn">Session options</span></div><div class="rstat">${status}</div>`;
const aEv = (t, glyph, body) => `<div class="tev"><span class="tt2">${t}</span><span class="gl">${glyph}</span><span class="bx">${body}</span></div>`;

// ── 4 · v4 新增（main 1c1c78d72）──────────────────────────────────────────────
Object.assign(IC, { agrid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  amore: '<circle cx="12" cy="5.5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="18.5" r="1.5" fill="currentColor"/>' });
// 页头（MainActivity 的 TopAppBar + PageBar）：返回、标题与副标题、页自己的按钮、≡、↻
const aBar = (title, sub, acts = ['agrid', 'amenu', 'arefresh']) => `<div class="pbar"><span class="ib">${ic('aback', 24, '#1C1C1E', 1.8)}</span><span class="t2"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span>${acts.map((a) => `<span class="ib">${ic(a, 22, '#1C1C1E', 1.8)}</span>`).join('')}</div>`;
const aPc = (done = 44, total = 46, run = 0) => `<div class="apc"><span class="bar"><i style="width:${done / total * 100}%;background:#247344"></i><i style="width:${run / total * 100}%;background:#0066BE"></i></span><span>${done}/${total} done · ${run} running</span></div>`;
const aRing = (c) => `<svg width="15" height="15" viewBox="0 0 24 24" style="flex:none"><g fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${IC.ring}</g></svg>`;
const aMark = (tone) => tone === 'warn' ? aTri('#985900', 16) : tone === 'ok' ? ic('merge', 15, '#247344', 2.2) : tone === 'landed' ? ic('check', 15, '#247344', 2.6) : tone === 'fail' ? ic('x', 13, '#B3261E', 2.8) : aRing(tone === 'run' ? '#0066BE' : '#555861');
const aHd = ({ tone = 'run', title, right = '', detail = '' }) => `<div class="ah ${tone === 'landed' ? 'ok' : tone}"><span class="c">${aMark(tone)}</span><span class="b"><span class="t1"><b>${title}</b>${right ? `<span class="r9">${right}</span>` : ''}</span>${detail ? `<span class="t2">${detail}</span>` : ''}</span></div>`;
const aLc = (inner, warn = false) => `<div class="alc${warn ? ' warn' : ''}">${inner}</div>`;
const aWhat = (t) => `<div class="what">${t}</div>`;
const aJobs = (rows) => `<div class="jobs">${rows.map(({ t, s, cls = '', ol = '' }) => `<div class="job"><span class="t">${t}</span><span class="s ${cls}">${s}</span>${ol}</div>`).join('')}</div>`;
const aMeta = (t) => `<div class="meta">${t}</div>`;
const aFoot = (inner) => `<div class="foot">${inner}</div>`;
const aOL = (t = 'Open landing ›', cls = '') => `<span class="tb2 ${cls}">${t}</span>`;
const aSec = (t) => `<div class="sec">${t}</div>`;
const aLi = ({ hl, st = 'Awaiting input', sp = '', lab = '' }) => `<div class="li"><span class="bd"><div class="hl">${hl}</div><div class="st">${st}</div>${sp ? `<div class="sp2">${lab ? `<span class="lab">${lab} </span>` : ''}${sp}</div>` : ''}</span><span class="mo">${ic('amore', 22, '#555861', 1.8)}</span></div>`;
const A_COORD = aLi({ hl: P4, st: 'Awaiting input', sp: 'Watching any 1 of 12 tasks…' });
const A_ROWS = [
  aLi({ hl: `执行任务：${TA}`, st: 'Completed', lab: 'Recap · 9:05 AM', sp: 'Fixed the wiki daily-limit NULL trap; byJob counts again.' }),
  aLi({ hl: `执行任务：${TC}`, st: 'Completed', lab: 'Recap · 8:45 AM', sp: '第 101 轮已收尾：生产被他人部署到 756…' }),
  aLi({ hl: `执行任务：${TB}`, st: 'Completed', lab: 'Recap · 8:43 AM', sp: '修复 wiki-maintain 跨页重复读会话' }),
];
const aPage4 = ({ at, cards = '', mid = '', rows = A_ROWS, today = 'Today', extra = '', cls = '' }) =>
  aPhone(`${aStatus(at)}${aBar(P4, 'Project · 76 sessions')}<div class="lz">${aPc()}${cards}${aSec('Coordinator')}${A_COORD}${mid}${today ? aSec(today) : ''}${rows.join('')}</div>${extra}`, cls);
const aMc = (cls, inner) => `<div class="amc ${cls}">${inner}</div>`;
const aMh = (title, kind = 'merge') => `<div class="mh"><span class="tile">${kind === 'warn' ? aTri('#985900', 15) : ic('merge', 15, kind === 'run' ? '#0066BE' : '#985900', 2.2)}</span><b>${title}</b></div>`;
const aJs = ({ title, rows, top }) => `<div class="scrim"></div><div class="ajs" style="top:${top}px"><div class="hdl"></div><div class="hh">${title}<span class="x">${ic('aclose', 22, '#555861', 1.8)}</span></div><div class="rows">${rows.join('<div class="dv"></div>')}</div></div>`;
const aJr = ({ h, what = '', det = '', chev = true, un = '' }) => `<div class="ajr"><div class="rb"><div class="col">${h}${what ? `<div class="what">${what}</div>` : ''}${det ? `<div class="det">${det}</div>` : ''}</div><span class="chv">${chev ? '›' : ''}</span></div>${un ? `<div class="un">${un}</div>` : ''}</div>`;
const aLrow = (h) => `<div class="lrow4">${h}</div>`;
