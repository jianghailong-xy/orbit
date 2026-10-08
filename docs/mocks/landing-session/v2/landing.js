// 2026-10-07 · 落地会话 v2 · 在 kit.js 之上加的图标与部件
Object.assign(IC, {
  term: '<path d="M4 6l6 6-6 6M12 18h8"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bubble: '<path d="M4 5h16v11H9l-5 4z"/>', grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/>', person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>', arrowr: '<path d="M5 12h14M13 6l6 6-6 6"/>', dashc: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  task: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>', play: '<path d="M7 5l12 7-12 7z"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.4 2.4-2.6-.6-.6-2.6z"/>',
});
const kchip = (t = 'Landing') => `<span class="kchip">${ic('ring', 10, '#5b4bd6', 2.6)}${t}</span>`;
const navLanding = (title, sub) => `<div class="nav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><div class="tl" style="display:flex;align-items:center;justify-content:center;gap:6px"><b style="max-width:200px">${title}</b>${kchip()}</div><span>${sub}</span></div><div class="circ">${ic('dots', 25, '#000', 1.7)}</div></div>`;
const ev = (tm, gl, tx, cls = '') => `<div class="ev ${cls}"><span class="tm2">${tm}</span><span class="gl">${gl}</span><span class="tx2">${tx}</span></div>`;
const OK = ic('check', 15, 'var(--green-ink)', 2.6), X = ic('x', 15, 'var(--red-ink)', 2.6), UP = ic('up', 15, '#8e8e93', 2),
      RING = ic('ring', 15, 'var(--tint)', 2.2), STOP = ic('stop', 14, 'var(--amber-ink)', 2), ARR = ic('arrowr', 15, '#7a5af5', 2);
const rnd = (t, ink) => `<div class="rnd"${ink ? ' style="color:var(--tint)"' : ''}>${t}</div>`;
const lfoot = (h) => `<div class="lfoot">${h}</div>`;
const FOOT = lfoot('Orbit runs this landing — <b>nothing to type here.</b><br>Decisions: coordinator (Automatic on) · <a>Open ›</a>');
const tlw = (top, inner, bottom = 84) => `<div class="tlw" style="top:${top}px;bottom:${bottom}px"><div class="tl">${inner}</div></div>`;
const toolBlock = (title, state, clock, term, color = 'var(--tint)') => `<div class="tool"><div class="th">${ic('term', 14, color, 2)}<b>${title}</b><span class="mut">· ${state}</span><span class="r3">${clock}</span></div>${term}</div>`;
// 进度卡（带落地行）
const progWithLanding = (done, total, run, line) => `<div class="pcard"><div class="prog"><span class="meter"><i style="width:${done / total * 100}%;background:var(--green)"></i><i style="width:${run / total * 100}%;background:var(--tint)"></i></span><span class="pmeta">${done}/${total} done · ${run} running</span><span class="proj">Project ${ic('chevr', 12, 'var(--tint)', 2.8)}</span></div>${line}</div>`;
const landingLine = ({ word = 'Landing', state = 'checking', what, step, usual, bar = 0, tick = 0, live, grey, extra = '' }) => `<div class="lline ${grey ? 'grey' : ''}">
<div class="a">${grey ? ic('dashc', 14, '#8e8e93', 2) : ic('ring', 14, 'var(--tint)', 2.3)}<b class="${grey ? '' : 'ink'}">${word}</b><span class="s ${grey ? '' : 'ink'}">${state}</span>${chev()}</div>
${what ? `<div class="w">${what}</div>` : ''}
${step ? `<div class="ln">${step}${usual ? `<span class="u">${usual}</span>` : ''}</div><div class="bud ${grey ? 'grey' : ''}"><i style="width:${bar}%"></i>${tick ? `<u style="left:${tick}%"></u>` : ''}</div>` : ''}
<div class="ln"><span class="live ${grey ? 'off' : ''}"></span>${live}</div>${extra}</div>`;
const lrow = ({ t, tm, sub, cls = 'mut', icon }) => `<div class="lrow"><div class="a"><span class="t">${t}</span>${icon || ''}<span class="tm">${tm}</span></div><div class="b">${kchip()}<span class="sub ${cls}">${sub}</span></div></div>`;
