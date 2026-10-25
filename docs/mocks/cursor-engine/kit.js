// Cursor engine boards (T0). Loaded after ../provider-engine-decoupling/glyphs.js and board.js, which set the
// theme from ?theme=dark and hold the web/iOS builders; this file adds Cursor to their tables, plus the
// pieces only these boards need: a real web capture with its marks laid over it, and the Cursor rows on
// the iOS runner pages. Not shipped code.

/* Cursor's mark, from LobeHub icons (src/Cursor/components/Mono.tsx, MIT) — the same set
   src/web/src/lib/providerGlyphs.ts takes every other glyph from. Their avatar draws it white on #000. */
window.GLYPHS.cursor = '<path fill-rule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"></path>';
BRAND.cursor = { g: 'cursor', from: '#2b2b2b', to: '#000000', edge: true };
ENGINES.cursor = { name: 'Cursor CLI', brand: 'cursor', bin: 'cursor-agent' };
IOS_MK.cursor = 'linear-gradient(160deg,#2b2b2b,#000)';

/* ── real web captures ───────────────────────────────────────────────────
   Every web frame on these boards is a screenshot of the real web app (this branch's src/web +
   src/shared on vite, fed by src/web/ui-migration's fixtures; the proposal frames are the same page with
   the Cursor parts written into its live DOM). The capture kit wrote shots/<scene>-<theme>.png at 2x and
   shots/marks.js (window.SHOT_MARKS): per scene and theme, the CSS-px size of the shot and the boxes to
   mark, measured off the live page. */

/** A capture, drawn at its CSS size (or `width`), with dashed marks: [{box, n, pad, label}]. */
function shot(scene, { width, marks = [], cls = '' } = {}) {
  const MARKS = window.SHOT_MARKS || {};
  const m = MARKS[`${scene}-${THEME}`];
  if (!m) return `<div class="shot-missing">missing ${scene}-${THEME}</div>`;
  const scale = width ? width / m.w : 1;
  const w = Math.round(m.w * scale);
  const h = Math.round(m.h * scale);
  const rings = marks.map((k) => {
    const b = typeof k.box === 'string' ? m.boxes?.[k.box] : k.box;
    if (!b) return `<span class="shot-miss">no box ${k.box}</span>`;
    const pad = (k.pad ?? 4);
    const [x, y, bw, bh] = b.map((v) => v * scale);
    const now = /^[A-Z]$/.test(String(k.n));
    return `<span class="shot-ring${now ? ' now' : ''}" style="left:${x - pad}px;top:${y - pad}px;width:${bw + 2 * pad}px;height:${bh + 2 * pad}px">${k.n !== undefined && k.n !== '' ? `<span class="m-n${now ? ' now' : ''}">${k.n}</span>` : ''}${k.label ? `<span class="shot-lab">${k.label}</span>` : ''}</span>`;
  }).join('');
  return `<figure class="shot ${cls}" style="width:${w}px;height:${h}px"><img src="shots/${scene}-${THEME}.png" width="${w}" height="${h}" alt="">${rings}</figure>`;
}

/* ── iOS (boards ios-*): built on ../provider-engine-decoupling/board.js (sheetPhone, chatPhone, iSection,
   iRow, iMenu, iComposer, iHero, iMk) and ../antigravity-accounts/kit.js (accountRow, wins), over
   ../antigravity-accounts/kit.css. Shapes follow RunnerEnginePage.swift, RunnerSignInView.swift,
   InfrastructureSections.swift, AgentIdentity.swift (EngineSwitchSheet) and ComposerView.swift. ── */

/** "What your agents can run on" (EngineOverviewRow). */
const ovRow = (key, name, ready, lines, id = '') => `<div class="r"${id ? ` id="${id}"` : ''}><div class="ov">${iMk(key, 28)}<div class="ov-m">
  <div class="ov-n">${name}<span class="ov-chip${ready ? ' ready' : ''}">${ready ? 'Ready' : 'Not set up'}</span></div>${lines.map((l) => `<div class="ov-l">${l}</div>`).join('')}</div></div></div>`;
const ks = (pairs) => pairs.map(([l, m]) => `${l} <span class="mdl">${m}</span>`).join(', ');
/** An API key on Infrastructure (InfrastructureSections.keyRow). */
const keyRow = (o) => `<div class="r"${o.id ? ` id="${o.id}"` : ''}><div class="e"><div class="e-l" style="align-items:center">${iMk(o.brand, 26)}<div class="e-m"><div class="e-n">${o.title}</div>${(o.subs || []).map((x) => `<div class="e-s">${x}</div>`).join('')}</div></div>
  ${o.trailing ? `<span class="e-s" style="flex:none">${o.trailing}</span>` : ''}${o.chevron ? IC.chev : ''}</div></div>`;
const KEYS_FOOTER = 'On your account and usable from every machine — billed per token. Adding or changing a key happens on the web.';

/** The Engine sheet a new session opens (EngineSwitchSheet). */
const tickMark = '<span class="tick">✓</span>';
const sheetRow = (e, label, r, opts = {}) => `<div class="i-row"${opts.id ? ` id="${opts.id}"` : ''}${opts.dim ? ' style="opacity:.5"' : ''}>${iEng(e)}<span class="lab">${label}${opts.under ? `<small class="fix">${opts.under}</small>` : ''}</span>
  ${r ? `<span class="r${opts.fix ? ' fix' : ''}">${r}</span>` : ''}${opts.on ? tickMark : ''}</div>`;
const engineSheet = (rows, id) => `<div class="i-dimbg heavy"></div><div class="i-sheet" ${id ? `id="${id}"` : ''}><div class="grab"></div>
  <div class="hd">Engine<span class="done">Done</span></div>
  <div class="i-sec">${rows.join('')}</div>
  <div class="i-foot">Pick the provider and account in the composer's model menu.</div>
  <div class="i-cap2">Switching is remembered as orbit's default.</div></div>`;

/** Cursor's two accounts on hpc, as the engine page lists them (RunnerEnginePage.accountRow). */
const CURSOR_DEFAULT_SUB = 'Free plan · ~/.orbit/cursor/default';
const CURSOR_TEAM_SUB = 'Pro plan · ~/.orbit/cursor-accounts/5c2e91a0';
const freeUnavailable = '<div class="a-na"><b>Free plan</b> · Usage unavailable — Cursor doesn’t report how many of the Free plan’s requests are left.</div>';
const teamWindow = [{ label: 'Monthly limit', pct: 34, resets: 'Resets Sun, Oct 3 at 12:00 AM' }];
function cursorAccounts({ team = {}, def = {} } = {}) {
  return [
    accountRow({ id: 'acc-def', name: def.name ?? 'Default', sub: def.sub ?? CURSOR_DEFAULT_SUB, status: def.status ?? { text: 'Signed in', tone: 'ok' },
      body: def.body ?? freeUnavailable, buttons: def.buttons }),
    accountRow({ id: 'acc-team', name: `Team${team.next === false ? '' : '<span class="chip-next">NEXT</span>'}`, sub: team.sub ?? CURSOR_TEAM_SUB,
      status: team.status ?? { text: 'Signed in', tone: 'ok' }, windows: team.windows ?? teamWindow, body: team.body, buttons: team.buttons }),
  ];
}
const cursorHead = (sub = '2026.10.14-941492e · pinned · checked 6 min ago') => `<div class="hd">${iMk('cursor', 30)}<div><div class="n">Cursor CLI</div><div class="s">${sub}</div></div></div>`;
const CURSOR_ENGINE_FOOTER = 'Orbit keeps Cursor CLI on the version it pins, 2026.10.14-941492e. Sign-ins live on this machine — a session spends that account’s Cursor plan.';
const spin = '<svg class="spin" viewBox="0 0 20 20" style="width:15px;height:15px">' + Array.from({ length: 8 }, (_, i) =>
  `<rect x="9" y="1.5" width="2" height="5" rx="1" fill="#8a8a8e" opacity="${(0.25 + i * 0.1).toFixed(2)}" transform="rotate(${i * 45} 10 10)"/>`).join('') + '</svg>';
/** The sign-in card for Cursor's link (RunnerSignInView, proposal). */
const signInCard = {
  starting: `<div class="si"><div class="si-row">${spin} Starting sign-in on the runner…</div><div class="si-h">The runner picks it up on its next check-in, so the link can take up to a minute to show here.</div><div class="si-links">Cancel</div></div>`,
  link: (adding = true) => `<div class="si"><div class="si-h">${adding ? 'Sign in on <b>cursor.com</b> with the account you are adding:' : 'Sign in on <b>cursor.com</b> with this account again:'}</div>
    <div class="bbs"><span class="bb prom" id="si-open">Open cursor.com</span><span class="bb grey">Copy Sign-In Link</span></div>
    <div class="si-row" id="si-wait">${spin} Waiting for you to sign in… · link expires in 26 min</div><div class="si-links">Cancel</div></div>`,
  expired: `<div class="si"><div class="si-warn" id="si-warn">The sign-in link expired before anyone signed in with it.</div><div class="bbs"><span class="bb prom" id="si-new">Get a New Link</span></div><div class="si-links">Cancel</div></div>`,
  done: () => `<div class="si"><div class="si-row">${ICON.check} Signed in — this runner is ready.</div></div>`,
};
