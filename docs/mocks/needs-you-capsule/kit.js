// 2026-10-21 · needs-you 条改版 · 图板部件（自含）。坐标都是 pt（= CSS px），按 owner 的 Pro Max 截图量。

// ── 图形（24×24 描边，近似 SF Symbols）──────────────────
const P = {
  chevr: '<path d="M9 5l7 7-7 7"/>', chevl: '<path d="M15 4.5L7.5 12l7.5 7.5"/>',
  chevd: '<path d="M6 9l6 6 6-6"/>', chevu: '<path d="M6 15l6-6 6 6"/>',
  // arrow.triangle.merge
  merge: '<path d="M8 7l4-4 4 4"/><path d="M12 3v8"/><path d="M12 11c0 3.5-5 4.5-5 9.5"/><path d="M12 11c0 3.5 5 4.5 5 9.5"/>',
  // questionmark.bubble
  qbub: '<path d="M6 4.5h12A2.5 2.5 0 0 1 20.5 7v8a2.5 2.5 0 0 1-2.5 2.5h-6l-4.5 3.5v-3.5H6A2.5 2.5 0 0 1 3.5 15V7A2.5 2.5 0 0 1 6 4.5z"/><path d="M10 9.4a2.1 2.1 0 1 1 3.1 1.8c-.7.4-1.1.8-1.1 1.5v.2"/><circle cx="12" cy="15.2" r=".35"/>',
  // exclamationmark.triangle
  warn: '<path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.3 12.7a2 2 0 0 1-1.7 3H4.7a2 2 0 0 1-1.7-3z"/><path d="M12 9.6v3.9"/><circle cx="12" cy="16.7" r=".35"/>',
  // pause
  pause: '<path d="M9 6.5v11M15 6.5v11"/>',
  // hand.raised（普通的工具审批）
  hand: '<path d="M8 12.6V7.2a1.4 1.4 0 0 1 2.8 0v4.3"/><path d="M10.8 11.2V5.4a1.4 1.4 0 0 1 2.8 0v5.8"/><path d="M13.6 11.2V6.6a1.4 1.4 0 0 1 2.8 0v6"/><path d="M16.4 11.4V9a1.4 1.4 0 0 1 2.8 0v5c0 3.9-2.8 7-6.6 7h-.5c-2.1 0-3.6-.8-4.9-2.4l-2.9-3.7a1.4 1.4 0 0 1 2.1-1.8L8 14.6"/>',
  term: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  ham: '<path d="M4 7h16M4 12h16M4 17h16"/>', filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
  pen: '<path d="M5 19.5h3.5L19 9a2.4 2.4 0 0 0-3.5-3.5L5 16v3.5z"/><path d="M13.5 7.5l3.5 3.5"/>',
};
const ic = (name, size = 16, color = 'currentColor', sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:none">${P[name]}</svg>`;
const dots = (c = 'var(--l1)') => `<svg width="22" height="22" viewBox="0 0 24 24" style="display:block"><circle cx="5" cy="12" r="2" fill="${c}"/><circle cx="12" cy="12" r="2" fill="${c}"/><circle cx="19" cy="12" r="2" fill="${c}"/></svg>`;
const bed = `<svg width="24" height="17" viewBox="0 0 24 17" style="display:block;margin-left:3px"><path fill="currentColor" d="M1.5 15.5V2.5h2.2v7.3h7.6V4.6h7.2a4 4 0 0 1 4 4v6.9h-2.2v-2.3H3.7v2.3z"/><circle cx="7.2" cy="6.8" r="2.3" fill="currentColor"/></svg>`;
const wifi = `<svg width="19" height="14" viewBox="0 0 19 14" style="display:block"><path fill="currentColor" d="M9.5 2.2c2.9 0 5.6 1.1 7.6 3l1.4-1.5A13 13 0 0 0 9.5.2 13 13 0 0 0 .5 3.7l1.4 1.5a11 11 0 0 1 7.6-3zm0 4c1.8 0 3.5.7 4.8 1.9l1.4-1.5A9 9 0 0 0 9.5 4.2a9 9 0 0 0-6.2 2.4l1.4 1.5a7 7 0 0 1 4.8-1.9zm0 4c.8 0 1.5.3 2 .8L9.5 13l-2-2c.5-.5 1.2-.8 2-.8z"/></svg>`;
const bars = `<div class="bars"><i style="height:4px"></i><i style="height:6.5px"></i><i style="height:9px"></i><i class="off" style="height:12px"></i></div>`;

// ── 手机 ─────────────────────────────────────────────────
const statusBar = (time = '4:32') => `<div class="status"><div class="tm">${time}${bed}</div><div class="rt">${bars}${wifi}<div class="batt">48</div></div></div>`;
const navCircles = ({ left = true, right = true } = {}) => `<div class="nav">${left ? `<div class="gc l">${ic('chevl', 22, 'var(--l1)', 2.6)}</div>` : ''}${right ? `<div class="gc r">${dots()}</div>` : ''}</div>`;
// window: { h, off } → 只画手机 y ∈ [off, off+h] 这一段
const phone = (mode, body, { h = 956, off = 0, cls = '' } = {}) =>
  `<div class="ph ${mode} ${cls}" style="height:${h}px"><div style="position:absolute;left:0;right:0;top:${-off}px;height:956px">${body}</div></div>`;

// 转录：仿截图里那段正在流出的回复（17pt，行距 27.2，每段首行缩进）
const TX = [
  "'- branch: ' + h.branch,",
  "'- title: ' + (h.title || '(none)'),",
  "'- location: ' + h.path + (h.line ? ' (line ' + h.line + ')' : ''),",
  "'- owner: ' + (h.owner || '(n/a)'),",
  "'- reported snippet: ' + h.snippet,",
  "'',",
  "'Procedure (one check at a time):',",
  '"1. git fetch origin main, then git merge-tree --write-tree origin/main HEAD. If it prints a conflict, return merged=false with evidence = the conflicting paths.",',
  "'2. Run the web suite: npm test --prefix src/web and record the totals; a red file goes into evidence with its first failing assertion.',",
  "'3. Compare the totals with main's last run.',",
  "'4",
];
const ABOVE = ["'- workspace: ' + h.workspace,", "'- repo: ' + h.repo,"];
const tx = (top, { above = false } = {}) => {
  const lines = (above ? ABOVE.concat(TX) : TX).map((l) => `<p style="text-indent:18px">${l.replace(/</g, '&lt;')}</p>`).join('');
  return `<div class="tx" style="top:${above ? top - 2 * 27.2 : top}px">${lines}</div>`;
};
// iOS 26 的滚动边缘：导航（和胶囊）底下的转录淡出
const edge = (mode, solidTo, fadeTo) => {
  const c = mode === 'dark' ? '0,0,0' : '255,255,255';
  return `<div class="edge" style="height:${fadeTo}px;background:linear-gradient(to bottom, rgba(${c},1) 0, rgba(${c},1) ${solidTo}px, rgba(${c},0) ${fadeTo}px)"></div>`;
};
const bottom = () => `<div class="tray">${ic('term', 15, 'rgba(235,235,245,.7)', 1.8)}<b>Background processes</b><span class="mut">1 total</span><span class="ch">${ic('chevr', 12, 'rgba(235,235,245,.55)', 2.4)}</span></div>
<div class="comp"><div class="ph1">Message…</div><div class="bt">${ic('plus', 20, 'rgba(235,235,245,.6)', 2)}<span class="auto">Auto</span><span class="mdl">Qwen3.8 27B FP8</span><span class="eff">Ultra</span><span class="spin"></span><span class="stopb"><i></i></span></div></div><div class="home"></div>`;

// ── 今天的条（量出来的颜色）────────────────────────────────
const TODAY = {
  dark: { top: '#191919', band: '#402E1D', dot: 'rgb(240,151,72)', text: '#fff', chev: 'rgb(133,103,74)', hl: 'rgb(77,70,65)' },
  light: { top: '#F7F7F7', band: '#FAEDDB', dot: '#FF9500', text: '#000', chev: 'rgba(60,60,67,.3)', hl: 'rgba(0,0,0,.18)' },
};
const todayBar = (mode, text) => {
  const c = TODAY[mode];
  return `<div class="topbar" style="height:116px;background:${c.top}"></div>
<div class="today" style="background:${c.band};color:${c.text}"><span class="d" style="background:${c.dot}"></span><span class="t">${text}</span>${ic('chevr', 13, c.chev, 2.6)}<span class="hl" style="background:${c.hl}"></span></div>`;
};

// ── 方案 A：胶囊 ───────────────────────────────────────────
// o: { glyph, title, sub, age, more, chev: 'd'|'u'（只有会话内那种才有方向）, top, rim, cls, style }
const GLYPH_SIZE = { merge: 18, qbub: 17, warn: 16, pause: 15, hand: 17 };
const tile = (glyph) => `<span class="tile">${ic(glyph, GLYPH_SIZE[glyph] || 16, 'var(--or)', glyph === 'pause' ? 3 : 2.1)}</span>`;
// 两行：第一行「什么事 … +N 2h」，第二行项目全名占满整宽；跨会话的那种不画 chevron（整枚就是按压，和「↑ 你的问题」胶囊一样），
// 会话内的那种留着 ↓ / ↑，因为它说的是卡在哪个方向。
const capInner = (o) => `${tile(o.glyph)}<span class="w${o.sub ? '' : ' one'}"><span class="l1"><b>${o.title}</b>${o.more ? `<span class="more">${o.more}</span>` : ''}${o.age ? `<span class="age">${o.age}</span>` : ''}</span>${o.sub ? `<s>${o.sub}</s>` : ''}</span>${o.chev ? `<span class="chv">${ic({ r: 'chevr', d: 'chevd', u: 'chevu' }[o.chev], 14, 'var(--l2)', 2.6)}</span>` : ''}`;
const capA = (o) => `<div class="cap44${o.rim ? ' rim' : ''} ${o.cls || ''}" style="top:${o.top ?? 112}px;${o.style || ''}">${capInner(o)}</div>`;

// ── 方案 C：整条，只修颜色 ─────────────────────────────────
const bandC = (mode, o) => {
  const top = mode === 'dark' ? '#191919' : '#F7F7F7';
  return `<div class="topbar" style="height:154px;background:${top}"></div>
<div class="band">${ic(o.glyph, 17, 'var(--or)', 2.1)}<span class="t"><b>${o.title}</b><s> · ${o.sub}</s></span><span class="age">${o.age}</span>${ic('chevr', 13, 'var(--l2)', 2.6)}<span style="position:absolute;left:0;right:0;bottom:-.34px;height:.34px;background:${TODAY[mode].hl}"></span></div>`;
};

// ── 标注 ─────────────────────────────────────────────────
const mk = (x, y, w, h, cls = '') => `<div class="mk ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;
const num = (n, x, y) => `<div class="num" style="left:${x}px;top:${y}px">${n}</div>`;

// ── 真实数据（10-21 截图那一刻）──────────────────────────────
const PROJ = '落地会话：每次落地都有自己的会话、实时输出和 owner 门';
const PROJ_WIKI = 'Wiki 服务端执行与 System model';
const PROJ_AND = 'Android 客户端：会话页与项目页';
