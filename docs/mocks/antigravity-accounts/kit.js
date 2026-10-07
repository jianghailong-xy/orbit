// Builders for the iOS runner pages in these boards. Each returns markup; a board calls them from
// its own script and drops the result into a placeholder. Shapes follow the SwiftUI views they stand
// for (RunnerEngineRow, RunnerWindowRow, RunnerEnginePage's account rows and Add Account card).

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 9 15"><path d="M1.4 1.2 7.4 7.5l-6 6.3" fill="none" stroke="#b9b9bb" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg width="13" height="21" viewBox="0 0 13 21"><path d="M10.5 2 2.5 10.5l8 8.5" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg width="19" height="19" viewBox="0 0 19 19"><path d="M2 2l15 15M17 2 2 17" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 12 14"><rect x="1" y="1" width="3.6" height="12" rx="1"/><rect x="7.4" y="1" width="3.6" height="12" rx="1"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M3 2h5v1.6H3.6v8.8h8.8V8H14v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm6.5 0H14v4.5h-1.6V4.7L7.6 9.5 6.5 8.4l4.8-4.8H9.5z"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M7 2h6l.7 1.5H17V5H3V3.5h3.3zM4.5 6h11l-.8 11.2a1.5 1.5 0 0 1-1.5 1.3H6.8a1.5 1.5 0 0 1-1.5-1.3zm3 2v8h1.4V8zm3.6 0v8h1.4V8z"/></svg>',
  pencil: '<svg viewBox="0 0 20 20"><path d="M13.8 2.6a1.6 1.6 0 0 1 2.3 0l1.3 1.3a1.6 1.6 0 0 1 0 2.3L7.6 16 3 17l1-4.6zM5.3 13.1l-.5 2.1 2.1-.5 8.4-8.4-1.6-1.6z"/></svg>',
  check: '<svg class="chk" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#34c759"/><path d="M5.8 10.3 8.7 13l5.6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spin: '<svg class="spin" viewBox="0 0 20 20">' + Array.from({ length: 8 }, (_, i) =>
    `<rect x="9" y="1.5" width="2" height="5" rx="1" fill="#8a8a8e" opacity="${(0.25 + i * 0.1).toFixed(2)}" transform="rotate(${i * 45} 10 10)"/>`).join('') + '</svg>',
  bell: '<svg width="17" height="17" viewBox="0 0 17 17"><path d="M8.5 1.5a4.5 4.5 0 0 0-4.5 4.5v3.2L2.6 11.6V13h11.8v-1.4L13 9.2V6a4.5 4.5 0 0 0-4.5-4.5zM6.8 14a1.8 1.8 0 0 0 3.4 0z" fill="#000"/><path d="M2 2l13 13" stroke="#000" stroke-width="1.7" stroke-linecap="round"/><path d="M2.9 1.6l13 13" stroke="#c5c5c5" stroke-width="1" stroke-linecap="round"/></svg>',
  signal: '<svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="8" width="3.2" height="4" rx="1"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1"/><rect x="10" y="3" width="3.2" height="9" rx="1"/><rect x="15" y="0" width="3.2" height="12" rx="1"/></svg>',
  wifi: '<svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.4c2.4 0 4.6.9 6.2 2.5l1.3-1.3A10.6 10.6 0 0 0 8.5.6 10.6 10.6 0 0 0 1 3.6l1.3 1.3a8.8 8.8 0 0 1 6.2-2.5zm0 3.6c1.4 0 2.7.5 3.6 1.5l1.3-1.3a7 7 0 0 0-9.8 0l1.3 1.3c.9-1 2.2-1.5 3.6-1.5zm0 3.4L6.6 11.3 8.5 13l1.9-1.7z"/></svg>',
};

function mark(engine, size = 28) {
  const g = { claude: 'anthropic', codex: 'openai', kimi: 'kimi', antigravity: 'antigravity' }[engine];
  const inner = g
    ? `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.6)}" height="${Math.round(size * 0.6)}">${window.GLYPHS[g]}</svg>`
    : `<span style="font-size:${Math.round(size * 0.42)}px">o</span>`;
  return `<span class="mk ${engine}" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.27)}px">${inner}</span>`;
}

/** A status after the version: `{text, tone}` with tone ok | warn | muted. */
function statusLine(version, status) {
  const parts = [];
  if (version) parts.push(version);
  if (status) parts.push(status.tone === 'muted' ? status.text : `<span class="${status.tone}">${status.text}</span>`);
  return parts.join(' · ');
}

/** One quota window: {group, label, pct, remaining, resets, warn}. */
function win(w) {
  const full = w.warn;
  return `<div class="w">
    ${w.group ? `<div class="w-g">${w.group}</div>` : ''}
    <div class="w-h"><b>${w.label}</b><span>${w.pct}%${w.remaining ? ' remaining' : ''}</span></div>
    <div class="w-bar${full ? ' full' : ''}"><i style="width:${w.pct}%"></i></div>
    ${w.resets ? `<div class="w-r${full ? ' warn' : ''}">${w.resets}</div>` : ''}
  </div>`;
}

function wins(list, cls = '') {
  return list && list.length ? `<div class="ws ${cls}">${list.map(win).join('')}</div>` : '';
}

/** RunnerEngineRow: {engine, name, version, status, capsule, extra, windows, chevron}. */
function engineRow(e) {
  return `<div class="r eng" ${e.id ? `id="${e.id}"` : ''}><div class="e">
    <div class="e-l">${mark(e.engine)}
      <div class="e-m">
        <div class="e-n">${e.name}</div>
        <div class="e-s">${statusLine(e.version, e.status)}</div>
        ${e.capsule ? `<span class="cap">${e.capsule}</span>` : ''}
        ${e.extra || ''}
        ${wins(e.windows)}
      </div>
    </div>
    ${e.chevron === false ? '' : ICON.chev}
  </div></div>`;
}

/** An account on the engine page: {name, sub, status, windows, none, buttons, body, id}. */
function accountRow(a) {
  return `<div class="r" ${a.id ? `id="${a.id}"` : ''}><div class="a">
    <div class="a-t"><div class="a-id"><div class="a-n">${a.name}</div>${a.sub ? `<div class="a-sub">${a.sub}</div>` : ''}</div>
      ${a.status ? `<div class="a-st ${a.status.tone}">${a.status.text}</div>` : ''}</div>
    ${a.windows ? wins(a.windows, 'np') : ''}
    ${a.none ? `<div class="a-none">${a.none}</div>` : ''}
    ${a.body || ''}
    ${a.buttons ? `<div class="bbs">${a.buttons.join('')}</div>` : ''}
  </div></div>`;
}

const BTN = {
  again: '<span class="bb">Sign In Again</span>',
  pause: `<span class="bb grey">${ICON.pause}Pause…</span>`,
  signIn: '<span class="bb">Sign In</span>',
  google: '<span class="bb prom">Sign in with Google</span>',
};

function section({ header, trailing, rows, footer, clear, id }) {
  return `${header ? `<div class="s-h">${header}${trailing ? `<span class="tr">${trailing}</span>` : ''}</div>` : '<div class="s-gap"></div>'}
    <div class="s-card${clear ? ' clear' : ''}" ${id ? `id="${id}"` : ''}>${rows.join('')}</div>
    ${footer ? `<div class="s-f">${footer}</div>` : ''}`;
}

function btnRow(text, dis) { return `<div class="r btn${dis ? ' dis' : ''}">${text}</div>`; }

/** A phone holding the runner sheet: {title, body, scroll, height, back, overlay, cls}. */
function phone({ title, body, scroll = 0, height = 852, back = true, overlay = '', cls = '', status = null }) {
  // `status` draws another phone's status bar: { time, net, batt } (the evening screenshot: 6:07, 5G, 15).
  const bar = status
    ? `<span class="t">${status.time}</span><span class="r">${ICON.signal}<span class="ph-net">${status.net}</span><span class="ph-batt low">${status.batt}</span></span>`
    : `<span class="t">5:30 ${ICON.bell}</span><span class="r">${ICON.signal}${ICON.wifi}<span class="ph-batt">48</span></span>`;
  return `<div class="ph ${cls}" style="height:${height}px">
    <div class="ph-sb">${bar}</div>
    <div class="ph-sheet">
      <div class="ph-nav"><span class="ph-gb${back ? '' : ' hide'}">${ICON.back}</span><span class="tt">${title}</span><span class="ph-gb">${ICON.close}</span></div>
      <div class="ph-scroll" style="transform:translateY(${-scroll}px)">${body}</div>
    </div>
    ${overlay}
  </div>`;
}

const GOOGLE_TERMS = '<p>Google terms restrict personal account sign-in through third-party tools; your account may be suspended.</p><p>Google terms</p>';

/** The engines as the HPC runner reports them, Antigravity's row left to the caller. */
function otherEngines() {
  return [
    engineRow({ engine: 'claude', name: 'Claude Code', version: '2.1.291', status: { text: '3 accounts signed in', tone: 'ok' } }),
    engineRow({ engine: 'codex', name: 'Codex', version: '0.160.1', status: { text: 'Signed in', tone: 'ok' },
      windows: [{ label: 'Weekly limit', pct: 100, resets: 'Resets Sun, Oct 11 at 9:11 PM', warn: true }] }),
    engineRow({ engine: 'kimi', name: 'Kimi Code', status: { text: 'Not installed', tone: 'muted' }, chevron: false }),
    engineRow({ engine: 'opencode', name: 'OpenCode', status: { text: 'Not installed', tone: 'muted' }, chevron: false }),
  ];
}

/** Antigravity's four buckets as agy reports them for one Google account. */
function agWindows(v = {}) {
  return [
    { group: 'gemini-weekly', label: 'Weekly', pct: v.gw ?? 100, remaining: true, resets: 'Resets Sun, Oct 11 at 1:31 AM' },
    { group: 'gemini-5h', label: '5-hour', pct: v.g5 ?? 100, remaining: true, resets: 'Resets 10:28 PM' },
    { group: '3p-weekly', label: 'Weekly', pct: v.tw ?? 98, remaining: true, resets: 'Resets Sun, Oct 11 at 1:31 AM' },
    { group: '3p-5h', label: '5-hour', pct: v.t5 ?? 100, remaining: true, resets: 'Resets 10:28 PM' },
  ];
}

/** Number marks and rings placed over a phone: [{n, x, y}] and [{x, y, w, h, cls}]. */
function marks(list) {
  return list.map((m) => m.w
    ? `<span class="ring ${m.cls || ''}" style="left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px"></span>`
    : `<span class="mk-n" style="left:${m.x}px;top:${m.y}px">${m.n}</span>`).join('');
}

/** Scroll a drawn phone so the element `sel` starts `top` pt below the sheet's top (after layout). */
function scrollTo(ph, sel, top) {
  const scroller = ph.querySelector('.ph-scroll');
  const el = ph.querySelector(sel);
  scroller.style.transform = 'none';
  const y = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.style.transform = `translateY(${-(y + 70 - top)}px)`;
}

/** Where `sel` sits inside phone `ph`, in the phone's own coordinates. */
function at(ph, sel) {
  const a = ph.getBoundingClientRect();
  const b = (typeof sel === 'string' ? ph.querySelector(sel) : sel).getBoundingClientRect();
  return { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height };
}

/** A dashed ring around `sel` with mark `n` on its top-right corner. */
function ringMark(ph, sel, n, pad = 4, dx = 0, dy = 0) {
  const r = at(ph, sel);
  ph.insertAdjacentHTML('beforeend', marks([{ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad },
    ...(n ? [{ n, x: r.x + r.w + pad - 12 + dx, y: r.y - pad - 12 + dy }] : [])]));
}
