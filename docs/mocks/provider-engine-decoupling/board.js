// Builders for the provider/engine decoupling boards. Every board loads glyphs.js, then this file in
// <head>, then calls the builders from its own script. ?theme=dark renders the dark set: the web
// frames flip through index.css's data-theme tokens, the phones through kit.css's .dark.

const THEME = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = THEME;

/* Brand tiles, as ProviderTile / brandForProvider draw them (src/shared providerPresets brand,
   ENGINE_BRAND for Antigravity, NEUTRAL_BRAND's grey "O" for OpenCode). */
const BRAND = {
  anthropic: { g: 'anthropic', from: '#d97757', to: '#c15f3c' },
  openai: { g: 'openai', from: '#4b5158', to: '#1f2226' },
  gemini: { g: 'gemini', from: '#4285f4', to: '#9b72cb' },
  antigravity: { g: 'antigravity', from: '#3186ff', to: '#00b95c', edge: true },
  deepseek: { g: 'deepseek', from: '#5b7cff', to: '#3a57e8' },
  kimi: { g: 'kimi', from: '#3a3a3a', to: '#111111' },
  glm: { g: 'glm', from: '#33b6b0', to: '#1e8e8e' },
  minimax: { g: 'minimax', from: '#ff5b76', to: '#e11d48' },
  qwen: { g: 'qwen', from: '#7a72ff', to: '#4f46e5' },
  opencode: { mono: 'O', from: '#9aa0a8', to: '#6b7178' },
};

/* The six engines (AgentProvider) under ENGINE_CLI_NAMES (src/shared/src/providerEngines.ts, contract
   §10 #1) — option A of the engine-name decision on board 1. "Now" frames pass today's names. */
const ENGINES = {
  claude: { name: 'Claude Code', brand: 'anthropic', bin: 'claude' },
  codex: { name: 'Codex', brand: 'openai', bin: 'codex' },
  kimi: { name: 'Kimi Code', brand: 'kimi', bin: 'kimi' },
  antigravity: { name: 'Antigravity CLI', brand: 'antigravity', bin: 'agy' },
  opencode: { name: 'OpenCode', brand: 'opencode', bin: 'opencode' },
  dsh: { name: 'DeepSeek Harness', brand: 'deepseek', bin: 'dsh' },
};

/* What each key on the boards' account works with — credentialEngines (contract §2.1): the default
   engine first, then ALL_ENGINES order (claude, codex, kimi, antigravity, opencode, dsh). */
const WORKS = {
  deepseek: ['claude', 'opencode', 'dsh'],
  anthropicKey: ['claude', 'opencode'],
  subscription: ['claude'],
  openai: ['codex', 'opencode'],
  moonshot: ['kimi', 'opencode'],
  gemini: ['antigravity', 'opencode'],
};

/* ── web ─────────────────────────────────────────────────────────────── */

function tile(key, size = 32, opts = {}) {
  if (key === 'add') {
    return `<span class="w-tile dash" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;font-size:${Math.round(size * 0.5)}px">+</span>`;
  }
  const b = BRAND[key];
  const r = Math.round(size * 0.26);
  const inner = b.g
    ? `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.56)}" height="${Math.round(size * 0.56)}">${window.GLYPHS[b.g]}</svg>`
    : `<span style="font-size:${Math.round(size * 0.42)}px;line-height:1">${b.mono}</span>`;
  const edge = b.edge ? ';box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)' : '';
  return `<span class="w-tile" style="width:${size}px;height:${size}px;border-radius:${r}px;background:linear-gradient(135deg,${b.from},${b.to})${edge}">${inner}${opts.check ? '<span class="ck">✓</span>' : ''}</span>`;
}

/** An engine named with its mark: the "works with" vocabulary. */
function eng(e, size = 14) {
  return `<span class="w-eng">${tile(ENGINES[e].brand, size)}${ENGINES[e].name}</span>`;
}
function engs(list, size = 14) {
  return `<span class="w-engs">${list.map((e) => eng(e, size)).join('<span class="sep">·</span>')}</span>`;
}

function pill(text, tone = 'ok') { return `<span class="w-pill ${tone}">${text}</span>`; }

/** One engine row in a runner card: {e, meta, pill, quota, act}. */
function engineRow(r) {
  const e = ENGINES[r.e];
  return `<div class="w-er">
    <div class="w-er-id">${tile(e.brand, 28)}<div style="min-width:0"><div class="w-er-n">${r.name || e.name}</div>${r.meta ? `<div class="w-er-m">${r.meta}</div>` : ''}</div></div>
    <div>${r.pill || ''}</div>
    <div class="w-er-q">${r.quota || '—'}</div>
    <div class="w-er-a">${r.act || ''}</div>
  </div>`;
}

function quota(label, pct, resets) {
  return `<div style="display:flex;justify-content:space-between"><b>${label}</b><span>${pct}%</span></div>
    <div class="w-bar"><i style="width:${pct}%"></i></div>${resets ? `<div>${resets}</div>` : ''}`;
}

/** A runner card: {name, meta, sum, open, rows, offline}. */
function runnerCard(c) {
  return `<div class="w-rc${c.open ? ' open' : ''}">
    <div class="w-rc-h"><span class="w-rc-chev">${c.open ? '▼' : '▶'}</span><span class="w-dot${c.offline ? ' off' : ''}"></span>
      <span class="w-rc-n">${c.name}</span><span class="w-rc-m">${c.meta}</span>
      <span class="w-rc-sum">${c.sum || ''}</span><span class="w-link" style="font-size:12.5px;margin-left:12px">Manage →</span></div>
    ${c.open ? c.rows.join('') : ''}
  </div>`;
}

function secHead(title, sub, count, right = '') {
  return `<div class="w-sec-h"><span class="w-sec-t">${title}</span>${count ? `<span class="w-sec-c">${count}</span>` : ''}${right}</div>
    ${sub ? `<div class="w-sec-s">${sub}</div>` : ''}`;
}

/** The keys table. rows: {grp: brandKey, name, count, add} | {brand?, name, lines[], models, endpoint, enabled, indent}. */
function keyTable(rows, opts = {}) {
  const head = `<tr><th>${opts.first || 'Provider'}</th><th style="width:62px">Models</th><th style="width:172px">Endpoint</th><th style="width:80px">Enabled</th><th style="width:118px"></th></tr>`;
  const body = rows.map((r) => {
    if (r.grp) {
      return `<tr class="grp"><td colspan="5"><div class="g">${tile(r.grp, 22)}${r.name}${r.count ? `<small>${r.count}</small>` : ''}
        ${r.add ? `<span class="w-btn sm link" style="margin-left:auto">+ Add key</span>` : ''}</div></td></tr>`;
    }
    const lines = (r.lines || []).map((l) => `<div class="k-l${l.cls ? ' ' + l.cls : ''}">${l.html}</div>`).join('');
    return `<tr class="${r.indent ? 'key' : ''}"><td><div class="k-id">${r.brand ? tile(r.brand, 32) : ''}<div><div class="k-n">${r.name}</div>${lines}</div></div></td>
      <td>${r.models ?? '—'}</td><td><span class="w-mono">${r.endpoint}</span></td>
      <td><span class="w-badge${r.enabled === false ? ' off' : ''}">${r.enabled === false ? 'Disabled' : 'Enabled'}</span></td>
      <td class="k-act"><span class="w-btn sm">Edit</span><span class="w-btn sm danger">Delete</span></td></tr>`;
  }).join('');
  return `<table class="w-tbl">${head}${body}</table>`;
}

function balanceLine(amount, ago = '2 min ago') {
  return { cls: 'bal', html: `Account balance <b>${amount}</b> · updated ${ago} <span class="w-link">⟳</span>` };
}

/** The vendor gallery: cards {brand, name, sub, tone, connected, custom, gone}. */
function gallery(cards) {
  return `<div class="w-gal">${cards.map((c) => {
    if (c.custom) {
      return `<div class="w-card custom">${tile('add', 40)}<div><div class="g-n">Custom</div><div class="g-s">Manual endpoint</div></div></div>`;
    }
    const cls = c.tone === 'on' ? 'on' : c.tone === 'local' ? 'local' : '';
    return `<div class="w-card${c.connected ? ' connected' : ''}${c.gone ? ' gone' : ''}"${c.id ? ` id="${c.id}"` : ''}>${tile(c.brand, 40, { check: c.connected })}
      <div style="min-width:0"><div class="g-n">${c.name}</div><div class="g-s ${cls}">${c.sub}</div></div></div>`;
  }).join('')}</div>`;
}

/** A dropdown menu: items are {title, brand, arrow} | {group} | {sep} | {foot} | {tile, label, det, q, r, rCls, ck, on, hl, dim, link, sub, ind}.
 *  A menu with a tick anywhere keeps a tick slot on every row, as checkSlot does. */
function menu(items, cls = '') {
  const ticks = items.some((it) => it.ck);
  return `<div class="w-menu ${cls}">${items.map((it) => {
    if (it.sep) return '<div class="w-ms"></div>';
    if (it.group) return `<div class="w-mg">${it.group}</div>`;
    if (it.foot) return `<div class="w-mfoot">${it.foot}</div>`;
    if (it.title) {
      return `<div class="w-mi title">${it.brand ? tile(it.brand, 16) : ''}${it.title}${it.arrow ? `<span class="arrow">→</span>${it.arrow}` : ''}</div>`;
    }
    const k = ['w-mi', it.on && 'on', it.hl && 'hl', it.dim && 'dim', it.link && 'link', it.ind && 'ind'].filter(Boolean).join(' ');
    const slot = ticks && !it.link ? `<span class="ck"${it.ck ? '' : ' style="visibility:hidden"'}>✓</span>` : '';
    return `<div class="${k}"${it.id ? ` id="${it.id}"` : ''}>${it.tile ? tile(it.tile, it.tileSize || 20) : ''}<span class="lab">${it.label}</span>${it.det ? `<span class="det">${it.det}</span>` : ''}
      <span class="rt">${it.sub ? `<span class="sub">${it.sub} ›</span>` : ''}${it.q ? `<span class="q">${it.q}</span>` : ''}${it.r ? `<span class="r ${it.rCls || ''}">${it.r}</span>` : ''}${slot}</span></div>`;
  }).join('')}</div>`;
}

function composer({ ph = 'Send this workspace a task…', mode = 'Auto', chip, open } = {}) {
  return `<div class="w-composer"><div class="ph">${ph}</div><div class="tb"><span class="plus">+</span><span>${mode}</span><span class="sp"></span>
    <span class="chip${open ? ' open' : ''}">${chip}</span><span class="w-muted">○ —</span><span class="send">↑</span></div></div>`;
}

/** A numbered mark around a piece of a frame: orange numbers for a change, grey letters for today's problem. */
function mk(n, html, inline, style = '') {
  const tag = inline ? 'span' : 'div';
  const now = /^[A-Z]$/.test(String(n));
  return `<${tag} class="m-mark${inline ? ' in' : ''}${now ? ' now' : ''}"${style ? ` style="${style}"` : ''}>${html}<span class="m-n">${n}</span></${tag}>`;
}

function notes(list) {
  return `<ul class="m-notes">${list.map(([n, html]) => `<li><span class="m-n${/^[A-Z]$/.test(String(n)) ? ' now' : ''}"${n === '·' ? ' style="background:var(--text-4)"' : ''}>${n}</span><span>${html}</span></li>`).join('')}</ul>`;
}

/* ── iOS ─────────────────────────────────────────────────────────────── */

const IC = {
  chev: '<svg class="chev" viewBox="0 0 9 15"><path d="M1.4 1.2 7.4 7.5l-6 6.3" fill="none" stroke="#b9b9bb" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg width="13" height="21" viewBox="0 0 13 21"><path d="M10.5 2 2.5 10.5l8 8.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg width="19" height="19" viewBox="0 0 19 19"><path d="M2 2l15 15M17 2 2 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  down: '<svg viewBox="0 0 15 15"><path d="M2.5 5.2 7.5 10l5-4.8" fill="none" stroke="#8a8a8e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  signal: '<svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3.2" height="4" rx="1"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1"/><rect x="10" y="3" width="3.2" height="9" rx="1"/><rect x="15" y="0" width="3.2" height="12" rx="1"/></svg>',
  wifi: '<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.4c2.4 0 4.6.9 6.2 2.5l1.3-1.3A10.6 10.6 0 0 0 8.5.6 10.6 10.6 0 0 0 1 3.6l1.3 1.3a8.8 8.8 0 0 1 6.2-2.5zm0 3.6c1.4 0 2.7.5 3.6 1.5l1.3-1.3a7 7 0 0 0-9.8 0l1.3 1.3c.9-1 2.2-1.5 3.6-1.5zm0 3.4L6.6 11.3 8.5 13l1.9-1.7z"/></svg>',
};

/* iOS marks (BrandMarks.swift): engines as kit.css paints them, vendors on their preset gradient. */
const IOS_MK = {
  anthropic: 'linear-gradient(160deg,#cb7c5d,#b8684a)', openai: 'linear-gradient(160deg,#4b4f56,#34373c)', kimi: '#2f2f2f',
  antigravity: 'linear-gradient(135deg,#649ff0 0%,#57b1c3 48%,#55ba82 100%)', opencode: 'linear-gradient(160deg,#9ea2a9,#868a91)',
  deepseek: 'linear-gradient(160deg,#5b7cff,#3a57e8)', gemini: 'linear-gradient(160deg,#4285f4,#9b72cb)', glm: 'linear-gradient(160deg,#33b6b0,#1e8e8e)',
};
function iMk(key, size = 28) {
  const b = BRAND[key];
  const inner = b.g
    ? `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.6)}" height="${Math.round(size * 0.6)}">${window.GLYPHS[b.g]}</svg>`
    : `<span style="font-size:${Math.round(size * 0.45)}px;line-height:1">${b.mono}</span>`;
  return `<span class="i-mk" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.24)}px;background:${IOS_MK[key] || `linear-gradient(160deg,${b.from},${b.to})`}">${inner}</span>`;
}
const iEng = (e, size) => iMk(ENGINES[e].brand, size);

function statusBar(time = '9:41') {
  return `<div class="ph-sb"><span class="t">${time}</span><span class="r">${IC.signal}${IC.wifi}<span class="ph-batt">82</span></span></div>`;
}

/** A phone holding the Settings sheet (kit.css): {title, body, back, scroll, height, overlay}. */
function sheetPhone({ title, body, back = true, scroll = 0, height = 852, overlay = '', id = '' }) {
  return `<div class="ph" ${id ? `id="${id}"` : ''} style="height:${height}px">${statusBar()}
    <div class="ph-sheet">
      <div class="ph-nav"><span class="ph-gb${back ? '' : ' hide'}">${IC.back}</span><span class="tt">${title}</span><span class="ph-gb">${IC.close}</span></div>
      <div class="ph-scroll" style="transform:translateY(${-scroll}px)">${body}</div>
    </div>${overlay}</div>`;
}

function iSection({ header, trailing, rows, footer, id }) {
  return `${header ? `<div class="s-h">${header}${trailing ? `<span class="tr">${trailing}</span>` : ''}</div>` : '<div class="s-gap"></div>'}
    <div class="s-card" ${id ? `id="${id}"` : ''}>${rows.join('')}</div>${footer ? `<div class="s-f">${footer}</div>` : ''}`;
}

/** A list row: {mark, title, sub, trailing, chevron, id, cls}. */
function iRow(r) {
  return `<div class="r${r.mark ? ' eng' : ''} ${r.cls || ''}" ${r.id ? `id="${r.id}"` : ''}><div class="e">
    <div class="e-l" style="align-items:center">${r.mark || ''}<div class="e-m"><div class="e-n">${r.title}</div>${r.sub ? `<div class="e-s">${r.sub}</div>` : ''}</div></div>
    ${r.trailing ? `<span class="e-s" style="flex:none">${r.trailing}</span>` : ''}${r.chevron === false ? '' : IC.chev}</div></div>`;
}

/** A key/value row (the key page's lower sections). */
function iKV(k, v, id) {
  return `<div class="r txt" ${id ? `id="${id}"` : ''} style="display:flex"><span>${k}</span><span style="margin-left:auto;color:#8a8a8e" class="kv-v">${v}</span></div>`;
}

/** A phone on a session screen: {title, sub, body, overlay}. */
function chatPhone({ title = 'orbit', sub = '', body = '', overlay = '', id = '' }) {
  return `<div class="ph chat" ${id ? `id="${id}"` : ''}><div class="ph-scrn"></div>${statusBar()}
    <div class="i-nav"><span class="ph-gb">${IC.back}</span><span class="tt">${title}${sub ? `<span>${sub}</span>` : ''}</span></div>
    ${body}${overlay}<div class="i-home"></div></div>`;
}

function iHero({ e, top = 250, s1 = 'Send a task to get started.', s2 = '' }) {
  const b = ENGINES[e];
  const glow = { deepseek: 'rgba(58,87,232,.35)', anthropic: 'rgba(184,104,74,.35)', opencode: 'rgba(110,114,120,.3)' }[b.brand] || 'rgba(0,0,0,.2)';
  return `<div class="i-hero" style="top:${top}px"><span style="display:inline-flex;border-radius:16px;box-shadow:0 8px 24px ${glow}">${iMk(b.brand, 68)}</span>
    <div class="nm">${b.name}${IC.down}</div><div class="s1">${s1}</div>${s2 ? `<div class="s2">${s2}</div>` : ''}</div>`;
}

function iComposer({ chip, on, ph = 'Message…', mode = 'Auto' }) {
  return `<div class="i-band"><div class="i-comp"><div class="f">${ph}</div><div class="tb"><span class="plus">+</span><span class="mode">${mode}</span><span class="sp"></span>
    <span class="chip${on ? ' on' : ''}">${chip}</span><span class="send">↑</span></div></div></div>`;
}

/** An iOS 26 menu: items {title} | {head} | {sep} | {foot} | {t, sub, subCls, chev}. */
function iMenu(items, style, cls = '') {
  return `<div class="i-menu ${cls}" style="${style}">${items.map((it) => {
    if (it.sep) return '<div class="i-ms"></div>';
    if (it.title) return `<div class="i-mt">${it.mark || ''}${it.title}</div>`;
    if (it.head) return `<div class="i-mh">${it.head}</div>`;
    if (it.foot) return `<div class="i-mfoot">${it.foot}</div>`;
    return `<div class="i-mi${it.bold ? ' head' : ''}"${it.id ? ` id="${it.id}"` : ''}>${it.mark || ''}<div class="t">${it.t}${it.sub ? `<small class="${it.subCls || ''}">${it.sub}</small>` : ''}</div>${it.chev ? `<span class="chv">${it.chev}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

/* Marks over a phone, measured after layout (kit.js's ringMark, renamed). */
function at(ph, sel) {
  const a = ph.getBoundingClientRect();
  const b = (typeof sel === 'string' ? ph.querySelector(sel) : sel).getBoundingClientRect();
  return { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height };
}
function ring(ph, sel, n, pad = 4, dx = 0, dy = 0) {
  const r = at(ph, sel);
  ph.insertAdjacentHTML('beforeend', `<span class="ring" style="left:${r.x - pad}px;top:${r.y - pad}px;width:${r.w + 2 * pad}px;height:${r.h + 2 * pad}px"></span>`
    + (n ? `<span class="mk-n" style="left:${r.x + r.w + pad - 12 + dx}px;top:${r.y - pad - 12 + dy}px">${n}</span>` : ''));
}

/** Last call of every board: dark phones in the dark set. */
function finish() {
  if (THEME === 'dark') document.querySelectorAll('.ph').forEach((p) => p.classList.add('dark'));
}

/** Scroll a Settings-sheet phone so `sel` starts `top` pt below the sheet's top (kit.js's scrollTo). */
function scrollPhone(ph, sel, top) {
  const scroller = ph.querySelector('.ph-scroll');
  const el = ph.querySelector(sel);
  scroller.style.transform = 'none';
  const y = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.style.transform = `translateY(${-(y + 70 - top)}px)`;
}

/** A submenu in front: lift its parent menu so the parent's title row shows above it, as iOS stacks them. */
function peek(ph, rise = 58) {
  const back = ph.querySelector('.i-menu.back');
  const front = [...ph.querySelectorAll('.i-menu')].find((m) => !m.classList.contains('back'));
  if (!back || !front) return;
  const p = ph.getBoundingClientRect();
  const f = front.getBoundingClientRect();
  back.style.bottom = 'auto';
  back.style.top = `${f.top - p.top - rise}px`;
  back.style.transform = 'scale(.94)';
  back.style.transformOrigin = '50% 0';
}

/* ── the shipped Infrastructure page's own markup (InfrastructurePage, InfrastructureOverview,
   RunnerEngines, ui/Badge, ui/Button): these builders emit the real class names, so the frames are
   drawn by src/web/src/index.css and components/ui/*.css themselves. ── */

/** ProviderTile: the brand gradient with the white glyph, or a monogram. */
function ptile(key, size = 28) {
  const b = BRAND[key];
  const inner = b.g
    ? `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.56)}" height="${Math.round(size * 0.56)}" fill="currentColor" style="color:#fff">${window.GLYPHS[b.g]}</svg>`
    : `<span style="font-size:${Math.round(size * 0.42)}px">${b.mono}</span>`;
  const edge = b.edge ? ';border:1px solid rgba(255,255,255,0.16)' : '';
  return `<div class="provider-tile" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;background:linear-gradient(135deg, ${b.from}, ${b.to})${edge}">${inner}</div>`;
}
const badge = (text, tone = 'default') => `<span class="orbit-badge orbit-badge-${tone}">${text}</span>`;
const obtn = (text, { variant = 'default', size = 'small', icon = '', cls = '' } = {}) =>
  `<button class="orbit-button orbit-button-${variant} orbit-button-${size}${cls ? ' ' + cls : ''}" type="button">${icon ? `<span class="orbit-button-icon">${icon}</span>` : ''}<span>${text}</span></button>`;
const ICO = {
  plus: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  down: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  drag: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="4.5" cy="3" r="1.1"/><circle cx="9.5" cy="3" r="1.1"/><circle cx="4.5" cy="7" r="1.1"/><circle cx="9.5" cy="7" r="1.1"/><circle cx="4.5" cy="11" r="1.1"/><circle cx="9.5" cy="11" r="1.1"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="2.5" cy="7" r="1.25"/><circle cx="7" cy="7" r="1.25"/><circle cx="11.5" cy="7" r="1.25"/></svg>',
  caret: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** One engine row on a machine card: {engine, brand, name, meta, status, quota, act, extra}. */
function reRow(r) {
  return `<div class="re-row" data-engine="${r.engine || ''}">
    <div class="re-id">${ptile(r.brand || ENGINES[r.engine].brand, 28)}<div class="re-id-main" style="min-width:0"><div class="re-name">${r.name || ENGINES[r.engine].name}</div>${r.meta ? `<div class="re-meta">${r.meta}</div>` : ''}</div></div>
    <div class="re-status">${r.status || ''}</div>
    ${r.quota === null ? '' : `<div class="re-quota">${r.quota || '<span class="re-quota-none">—</span>'}</div>`}
    ${r.act === null ? '' : `<div class="re-act">${r.act || ''}</div>`}
    ${r.extra || ''}
  </div>`;
}

/** A machine card: {name, meta, open, rows, summary, offline, busy (0..1)}. */
function machineCard(c) {
  return `<div class="re-card re-runner-card${c.offline ? ' offline' : ''}${c.open ? '' : ' collapsed'}">
    <div class="re-head">
      <button class="re-toggle" type="button"><span class="re-chev${c.open ? ' open' : ''}">${ICO.chev}</span><span class="re-dot${c.offline ? '' : ' on'}"></span>
        <span class="re-runner-copy"><span class="re-runner">${c.name}</span>${c.meta ? `<span class="re-runner-meta">${c.meta}</span>` : ''}
        ${c.busy !== undefined ? `<span class="runner-util"><span class="runner-util-fill" style="width:${Math.round(c.busy * 100)}%"></span></span>` : ''}</span></button>
      ${(c.offline || !c.open) ? `<div class="re-runner-status">${c.offline ? badge('Offline') : ''}${!c.open ? `<span class="re-summary">${c.summary || ''}</span>` : ''}</div>` : ''}
      <a class="re-manage">Details →</a>
      <button class="orbit-button orbit-button-text orbit-button-small orbit-button-icon-only re-machine-menu" type="button"><span class="orbit-button-icon">${ICO.more}</span></button>
    </div>
    ${c.open ? c.rows.join('') : ''}
  </div>`;
}

/** A section head as RunnerEngines / InfrastructurePage draw it. */
const reSecHead = (title, sub, count = '') => `<div class="re-sec-head"><h3>${title}</h3>${sub ? `<span class="re-sec-sub">${sub}</span>` : ''}${count ? `<span class="re-sec-count">${count}</span>` : ''}</div>`;

/** An engine card of "What your agents can run on": {engine, brand, name, ready, lines | none}. */
function engineCard(c) {
  const name = c.name || ENGINES[c.engine].name;
  return `<div class="infra-engine${c.ready ? '' : ' none'}"${c.id ? ` id="${c.id}"` : ''}>${ptile(c.brand || ENGINES[c.engine].brand, 30)}
    <div class="infra-engine-main"><div class="infra-engine-name">${name}<span class="infra-engine-state${c.ready ? ' ready' : ''}">${c.ready ? 'Ready' : 'Not set up'}</span></div>
    ${c.ready ? `<div class="infra-engine-src">${c.lines.map((l) => `<div>${l}</div>`).join('')}</div>` : `<div class="infra-engine-src none">${c.none}</div>`}</div></div>`;
}
/** "Label <model chip>" pairs for an API key line. */
const keyList = (pairs) => pairs.map(([label, model]) => `${label}${model ? ` <span class="infra-model">${model}</span>` : ''}`).join(', ');

/** The API keys table (InfrastructurePage keysTable): rows {brand, name, lines[], models, endpoint, enabled}
 *  or vendor group rows {grp: brandKey, name, count} (proposal). */
function keysTableReal(rows, { first = 'Provider' } = {}) {
  const head = `<colgroup><col><col style="width:84px"><col style="width:190px"><col style="width:96px"><col style="width:150px"></colgroup>
    <thead><tr><th scope="col">${first}</th><th scope="col">Models</th><th scope="col">Endpoint</th><th scope="col">Enabled</th><th scope="col" style="text-align:right"></th></tr></thead>`;
  const body = rows.map((r) => {
    if (r.grp) {
      return `<tr class="kgrp"><td colspan="5"><div class="kgrp-in">${ptile(r.grp, 22)}<b>${r.name}</b>${r.count ? `<span>${r.count}</span>` : ''}<span class="kgrp-add">+ Add key</span></div></td></tr>`;
    }
    return `<tr${r.indent ? ' class="kin"' : ''}><td><div style="display:flex;align-items:center;gap:10px;min-width:0">${r.indent ? '' : ptile(r.brand, 32)}<div style="min-width:0">
      <div class="prov-cell-name">${r.name}</div>${(r.lines || []).join('')}</div></div></td>
      <td>${r.models ?? '—'}</td><td><code class="prov-endpoint">${r.endpoint}</code></td>
      <td>${badge(r.enabled === false ? 'Disabled' : 'Enabled', r.enabled === false ? 'default' : 'green')}</td>
      <td style="text-align:right"><span class="prov-actions" style="gap:8px">${obtn('Edit')}${obtn('Delete', { cls: 'orbit-button-danger' })}</span></td></tr>`;
  }).join('');
  return `<div class="orbit-table-frame provider-keys" style="margin-top:12px"><div class="orbit-table-frame-body"><table class="orbit-table" style="table-layout:fixed">${head}<tbody>${body}</tbody></table></div></div>`;
}
const runtimeLines = (...lines) => `<div class="prov-runtime">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
const balanceReal = (amount) => `<div class="prov-runtime">Account balance <b style="color:var(--text-1)">${amount}</b> · updated 2 min ago <span class="re-link">⟳</span></div>`;
/** The engines a key works with, in the compatibility table's order (default first). */
const engineLine = (list, tail = '') => `<div class="prov-runtime ek">${list.map((e) => `<span class="ek-e">${ptile(ENGINES[e].brand, 12)}${ENGINES[e].name}</span>`).join('<span class="ek-sep">·</span>')}${tail}</div>`;

/** The vendor gallery (ProviderGallery): cards {brand, name, sub, connected, local, custom, id}. */
function galleryReal(cards) {
  return `<div class="provider-gallery">${cards.map((c) => c.custom
    ? `<a class="provider-card custom"><div class="provider-tile" style="width:40px;height:40px;border-radius:10px;background:var(--fill-muted);color:var(--text-3);border:1px dashed var(--border);font-size:20px">+</div><div style="min-width:0"><div class="pc-name">Custom</div><div class="pc-sub">Manual endpoint</div></div></a>`
    : `<a class="provider-card${c.connected ? ' connected' : ''}"${c.id ? ` id="${c.id}"` : ''}><span class="pc-logo">${ptile(c.brand, 40)}${c.connected ? '<span class="pc-check">✓</span>' : ''}</span>
      <div style="min-width:0"><div class="pc-name">${c.name}</div><div class="pc-sub${c.local ? ' pc-local' : ''}">${c.sub}</div></div></a>`).join('')}</div>`;
}
