// Prepended to every frame script by shot.mjs. Helpers for drawing the proposal into the live
// console with its own classes and CSS variables, plus the red annotation marks the boards use.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const css = (t) => { const s = document.createElement('style'); s.textContent = t; document.head.appendChild(s); };
// Swap every top-level node for an inert copy so nothing React polls can repaint over the mock.
const freeze = () => { for (const c of [...document.body.children]) { if (c.tagName === 'SCRIPT') { c.remove(); continue; } c.replaceWith(c.cloneNode(true)); } };
const box = (node) => node.getBoundingClientRect();
const mark = (node, n, { pad = 3, side = 'right', color = '#f5222d', dy = 0 } = {}) => {
  const r = box(node);
  const m = el(`<div class="mk-mark" style="left:${r.left - pad}px;top:${r.top - pad + dy}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;border-color:${color}">${
    n ? `<span class="mk-badge ${side}" style="background:${color}">${n}</span>` : ''}</div>`);
  document.body.appendChild(m);
  return m;
};
const col = () => $('.session-col-list');
const transcript = () => $('.workspace-view .workspace-sessions');
const msgs = () => [...transcript().children];

const G = {
  // A branch that will not join: the landing card's tile.
  conflict: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 4-6 4-11 8"/><path d="M14.5 15.5l5 5M19.5 15.5l-5 5"/></svg>`,
  land: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 4-6 4-11 8"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 2.5 1.5 21h21L12 2.5Zm-1 7h2v6h-2v-6Zm0 8h2v2h-2v-2Z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  dot: `<svg viewBox="0 0 24 24" width="12" height="12"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>`,
  close: `<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor"><path d="M563.8 512l262.5-312.9c4.4-5.2.7-13.1-6.1-13.1h-79.8c-4.7 0-9.2 2.1-12.3 5.7L511.6 449.8 295.1 191.7c-3-3.6-7.5-5.7-12.3-5.7H203c-6.8 0-10.5 7.9-6.1 13.1L459.4 512 196.9 824.9A7.96 7.96 0 0 0 203 838h79.8c4.7 0 9.2-2.1 12.3-5.7l216.5-258.1 216.5 258.1c3 3.6 7.5 5.7 12.3 5.7h79.8c6.8 0 10.5-7.9 6.1-13.1L563.8 512z"/></svg>`,
  more: `<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor"><path d="M176 511a56 56 0 10112 0 56 56 0 10-112 0zm280 0a56 56 0 10112 0 56 56 0 10-112 0zm280 0a56 56 0 10112 0 56 56 0 10-112 0z"/></svg>`,
};
const spin = `<span class="promotion-spin lc-spin" aria-hidden="true"></span>`;

css(`
.mk-mark { position: fixed; border: 2px dashed; border-radius: 10px; pointer-events: none; z-index: 5000; }
.mk-badge { position: absolute; top: -10px; width: 20px; height: 20px; border-radius: 50%; color: #fff;
  font: 700 12px/20px Inter, -apple-system, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff; }
.mk-badge.right { right: -10px; } .mk-badge.left { left: -10px; }

/* ── The landing card: one task's landing that stopped, on the project sessions page ───────── */
.lc { display: flex; flex-direction: column; gap: 6px; margin: 0 0 10px; padding: 10px 12px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg-subtle); color: var(--text-2); font-size: 12px; line-height: 1.45; }
.lc.is-fixing { border-color: var(--warning-border); }
.lc.is-yours { border-color: var(--warning-border); background: var(--warning-bg); }
.lc-head { display: flex; align-items: center; gap: 6px; }
.lc-tile { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px;
  background: color-mix(in srgb, var(--warning-solid) 16%, transparent); color: var(--warning-solid); }
.lc-title { color: var(--text-1); font-size: 13px; font-weight: 600; }
.lc.is-fixing .lc-title { color: var(--warning); }
.lc-badge { margin-left: auto; padding: 0 7px; border-radius: 999px; background: var(--warning-solid); color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; }
.lc-cause { color: var(--text-1); }
.lc-cause code, .lc-mono { font: 11.5px/1.4 ui-monospace, "SF Mono", "DejaVu Sans Mono", monospace; }
.lc-cause code { padding: 0 4px; border-radius: 4px; background: var(--bg-hover); }
.lc-other { color: var(--text-3); }
.lc-rule { height: 1px; margin: 2px 0; background: var(--border); }
.lc-status { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 0; border-radius: 8px; background: var(--bg-hover);
  color: var(--text-1); font: inherit; font-weight: 600; text-align: left; cursor: pointer; }
.lc-status .lc-status-text { flex: 1; min-width: 0; }
.lc-status .lc-status-sub { display: block; color: var(--text-3); font-weight: 400; }
.lc-status .lc-chev { color: var(--text-4); }
.lc-spin { flex: none; }
.lc-note { color: var(--text-3); }
.lc-note b { color: var(--text-2); font-weight: 600; }
.lc-ask { color: var(--text-1); font-size: 12.5px; }
.lc-hold { color: var(--text-3); }
.lc-actions { display: flex; gap: 8px; margin-top: 2px; }
.lc-actions button { height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-base);
  color: var(--text-1); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
.lc-actions .lc-primary { flex: 1; border-color: var(--brand); background: var(--brand); color: #fff; }
.lc-foot { display: flex; align-items: center; gap: 12px; color: var(--text-3); }
.lc-foot .lc-when { flex: 1; min-width: 0; }
.lc-link { padding: 0; border: 0; background: transparent; color: var(--brand); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
.lc-more { display: inline-flex; align-items: center; padding: 0; border: 0; background: transparent; color: var(--text-3); font-size: 14px; cursor: pointer; }

/* The landing line in the progress card, a second try. */
.lc-again { color: var(--text-3); font-size: 12px; margin-top: 1px; }

/* A landing already made, as a row on the page's timeline. */
.lc-row-mark { position: relative; display: flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px;
  border-radius: 50%; background: var(--success-bg); color: var(--success); }

/* ── The conversation's one line per moment ─────────────────────────────────────────────── */
.lc-line-wrap { display: flex; justify-content: center; }
.lc-line { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; margin: 6px auto; padding: 5px 12px; border-radius: 999px;
  background: var(--bg-hover); color: var(--text-2); font-size: 13px; white-space: nowrap; }
.lc-line.is-blocked { background: var(--warning-bg); color: var(--warning); }
.lc-line.is-yours { background: var(--warning-bg); color: var(--warning); font-weight: 600; }
.lc-line.is-landed { background: var(--success-bg); color: var(--success); }
.lc-line.is-working { background: var(--brand-tint); color: var(--brand); }
.lc-line-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lc-line-time { color: var(--text-4); font-weight: 400; }
.lc-line-action { flex: none; color: var(--brand); font-weight: 600; }

/* ── Dialog bodies (the Orbit Dialog shell carries the chrome) ──────────────────────────── */
.lc-dlg .orbit-overlay-body { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.lc-sum { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--warning-border); border-radius: 10px; background: var(--bg-subtle); }
.lc-sum.is-yours { background: var(--warning-bg); }
.lc-sum-text { flex: 1; color: var(--text-1); }
.lc-sum-text b { font-weight: 600; }
.lc-sum-sub { color: var(--text-3); margin-top: 2px; }
.lc-h { margin: 0 0 6px; color: var(--text-3); font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; }
.lc-steps { margin: 0; padding: 0; list-style: none; }
.lc-step { position: relative; display: grid; grid-template-columns: 44px 20px 1fr; gap: 0 8px; padding: 0 0 12px; }
.lc-step::before { content: ''; position: absolute; left: 61px; top: 18px; bottom: -2px; width: 1px; background: var(--border); }
.lc-step:last-child::before { display: none; }
.lc-step-time { color: var(--text-3); font-size: 12px; line-height: 20px; text-align: right; font-variant-numeric: tabular-nums; }
.lc-step-ico { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--bg-hover); color: var(--text-3); z-index: 1; }
.lc-step-ico.ok { background: var(--success-bg); color: var(--success); }
.lc-step-ico.bad { background: var(--error-bg, #fff1f0); color: var(--error); }
.lc-step-ico.back { background: var(--warning-bg); color: var(--warning); }
.lc-step-ico.now { background: var(--brand-tint); color: var(--brand); }
.lc-step-body { color: var(--text-1); line-height: 20px; }
.lc-step-body .lc-step-sub { display: block; color: var(--text-3); font-size: 12px; line-height: 18px; }
.lc-step.is-next .lc-step-body { color: var(--text-3); }
.lc-kv { display: grid; grid-template-columns: 92px 1fr; gap: 6px 12px; margin: 0; }
.lc-kv dt { color: var(--text-3); }
.lc-kv dd { margin: 0; color: var(--text-1); min-width: 0; overflow-wrap: anywhere; }
.lc-quiet { color: var(--text-3); }
.lc-dlg-foot { display: flex; align-items: center; gap: 14px; width: 100%; }
.lc-dlg-foot .lc-grow { flex: 1; }
.lc-btn { height: 32px; padding: 0 15px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-base); color: var(--text-1);
  font: inherit; font-size: 14px; cursor: pointer; white-space: nowrap; }
.lc-btn.is-primary { border-color: var(--brand); background: var(--brand); color: #fff; font-weight: 500; }
.lc-qlink { padding: 0; border: 0; background: transparent; color: var(--text-3); font: inherit; font-size: 13px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.lc-qlink.is-danger { color: var(--error); }
.lc-raw summary { color: var(--text-3); font-size: 12.5px; cursor: pointer; }
.lc-textarea { width: 100%; min-height: 128px; box-sizing: border-box; padding: 8px 11px; border: 1px solid var(--brand); border-radius: 6px;
  box-shadow: 0 0 0 2px var(--brand-tint); background: var(--bg-base); color: var(--text-1); font: inherit; font-size: 13.5px; line-height: 1.55; resize: none; }
.lc-field-label { color: var(--text-2); font-weight: 600; margin-bottom: -6px; }
.lc-after { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 8px; background: var(--fill-muted); color: var(--text-2); font-size: 12.5px; }
.lc-after b { color: var(--text-1); }
`);

// ── Builders ──────────────────────────────────────────────────────────────────────────────
const conflictLines = () => `
  <div class="lc-cause">Conflicts with main in <code>AccountSelect.tsx</code></div>
  <div class="lc-other">main changed it too, in 712d324a8</div>`;

const landingCard = (state) => {
  if (state === 'fixing') return el(`<div class="lc is-fixing" data-lc="fixing">
    <div class="lc-head"><span class="lc-tile">${G.conflict}</span><span class="lc-title">P3.2 can’t land yet</span></div>
    ${conflictLines()}
    <button class="lc-status" type="button">${spin}<span class="lc-status-text">Round 2 is fixing it · step 3 of 5<span class="lc-status-sub">sent back 2h ago · active 1m ago</span></span><span class="lc-chev">›</span></button>
    <div class="lc-note">Lands again by itself once round 2 is accepted. <b>Nothing for you to do.</b></div>
    <div class="lc-foot"><span class="lc-when">stopped 2h 10m ago</span><button class="lc-link" type="button">Details ›</button></div>
  </div>`);
  if (state === 'triage') return el(`<div class="lc is-fixing" data-lc="triage">
    <div class="lc-head"><span class="lc-tile">${G.conflict}</span><span class="lc-title">P3.2 can’t land yet</span></div>
    ${conflictLines()}
    <button class="lc-status" type="button">${spin}<span class="lc-status-text">Coordinator is looking at it · 3m<span class="lc-status-sub">Comes to you in 1h 57m if no fix starts</span></span><span class="lc-chev">›</span></button>
    <div class="lc-foot"><span class="lc-when">stopped 3m ago</span><button class="lc-link" type="button">Details ›</button></div>
  </div>`);
  return el(`<div class="lc is-yours" data-lc="yours">
    <div class="lc-head"><span class="lc-tile">${G.conflict}</span><span class="lc-title">P3.2 can’t land yet</span><span class="lc-badge">Needs you</span></div>
    ${conflictLines()}
    <div class="lc-rule"></div>
    <div class="lc-ask">No fix has started in 2h. Send P3.2 back to merge main and resolve it — its delivered work is kept.</div>
    <div class="lc-hold">Holding up P3.3 检查试点保真度与迁移收益 and 1 more</div>
    <div class="lc-actions"><button class="lc-primary" type="button">Send back…</button><button type="button">Ask coordinator</button></div>
    <div class="lc-foot"><span class="lc-when">came to you 2m ago</span><button class="lc-more" type="button" aria-label="More">${G.more}</button><button class="lc-link" type="button">Details ›</button></div>
  </div>`);
};

const line = (cls, icon, text, { action = '', time = '' } = {}) => el(`<div class="lc-line-wrap"><span class="lc-line ${cls}">${icon}<span class="lc-line-text">${text}</span>${time ? `<span class="lc-line-time">${time}</span>` : ''}${action ? `<span class="lc-line-action">${action} ›</span>` : ''}</span></div>`);

const dialog = ({ title, body, foot, width = 640, top = 64 }) => {
  const d = el(`<div class="lc-dlg-root">
    <div class="orbit-overlay-backdrop" style="z-index:1000"></div>
    <div class="orbit-overlay-viewport orbit-dialog-viewport" style="z-index:1000;padding-top:${top}px">
      <div class="orbit-overlay orbit-dialog lc-dlg" style="width:${width}px">
        <div class="orbit-overlay-header"><button class="orbit-overlay-close" aria-label="Close">${G.close}</button><h2 class="orbit-overlay-title">${title}</h2></div>
        <div class="orbit-overlay-body">${body}</div>
        ${foot ? `<div class="orbit-overlay-footer">${foot}</div>` : ''}
      </div>
    </div></div>`);
  document.body.appendChild(d);
  return d;
};

// The session column, header to the bottom of what a frame is about, as a clip.
const colClip = (bottomNode, extra = 18) => {
  const list = col().getBoundingClientRect();
  const b = bottomNode ? bottomNode.getBoundingClientRect().bottom + extra : list.top + 620;
  return { x: Math.max(0, list.left - 14), y: 0, width: list.width + 28, height: Math.round(b) };
};
const landedRow = () => el(`<button type="button" class="session-row session-project-merge-row">
  <span class="lc-row-mark" aria-hidden="true">${G.land}</span>
  <span class="session-project-merge-row-body"><span class="session-project-merge-row-head"><span class="session-project-merge-row-title">P3.2 landed</span><span class="session-time">20m ago</span></span>
  <span class="session-project-merge-row-detail">on the project branch · after 1 conflict · 3c1b24f</span></span></button>`);
const patchRelanding = () => {
  const landing = $('.session-project-page-landing');
  
  $('.project-landing-what', landing).after(el(`<div class="lc-again">2nd try · the conflict was fixed in round 2</div>`));
  return landing;
};
