// Board frames. "today" turns this worktree's snapshot cap off (= main); "fix" is the worktree as is; "row-*" draw
// proposal A over the same build: the panel folds into one row of the branch bar, in the strip's own row language.
//   FONTCONFIG_FILE=/var/tmp/rpr-mock/fonts.conf unshare -n ./run-ns.sh capture.mjs
import fs from 'node:fs';
import { launch, open, recovery, REPAIR, settle } from '/var/tmp/rpr-mock/lib.mjs';

const OUT = '/var/tmp/rpr-mock/shots';
fs.mkdirSync(OUT, { recursive: true });
const TODAY = '.wt-recovery-snapshot{max-height:none!important;overflow:visible!important}';
const ROW_CSS = `
  .rpr-row { display:flex; align-items:center; gap:8px; min-height:34px; padding:3px 6px 3px 10px; font-size:12px;
    border-top:1px solid var(--border-subtle); cursor:pointer; }
  .rpr-row:hover { background: var(--bg-hover); }
  .rpr-ico { flex:none; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; font-size:14px; color: var(--text-3); }
  .rpr-ico.is-running, .rpr-ico.is-checking { color: var(--brand); }
  .rpr-ico.is-ready { color: var(--success); } .rpr-ico.is-conflict, .rpr-ico.is-reply { color: var(--warning); } .rpr-ico.is-failed { color: var(--error); }
  .rpr-head { color: var(--text-1); font-weight: 500; white-space:nowrap; }
  .rpr-note { color: var(--text-3); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .rpr-note.is-ready { color: var(--success); } .rpr-note.is-conflict, .rpr-note.is-reply { color: var(--warning); }
  .rpr-step { flex:none; padding:3px 10px; border-radius:6px; font:inherit; cursor:pointer; border:1px solid var(--border); background: var(--bg-base); color: var(--text-1); }
  .rpr-step.is-primary { border-color: var(--brand); background: var(--brand); color:#fff; }
  .rpr-open .wt-recovery { margin: 0 10px 10px; }
  .rpr-open .wt-recovery-repair-status, .rpr-open .wt-recovery-actions, .rpr-open .wt-recovery-actions-note { display:none; }`;

const ICON = { running: '◌', checking: '◌', ready: '✓', conflict: '⚠', reply: '…', failed: '✕' };
const STATES = {
  running: { head: 'Repair session running', note: 'Resolve the merge conflict and restore main · Orbit checks again when it stops', step: 'Open ›' },
  checking: { head: 'Repair session finished', note: 'Checking its result…', step: null },
  ready: { head: 'Ready to merge into main', note: 'Checked just now · pushes 10 commits, nothing on origin/main rewritten', step: 'Merge into main', primary: true },
  conflict: { head: 'Repair session finished', note: 'Checked just now — 2 conflicts left', step: 'Continue repair', primary: true },
  reply: { head: 'Repair session needs your reply', note: '“Keep the spec’s new fixture or origin’s? Both pass.” · 2m ago', step: 'Reply in repair session', primary: true },
  failed: { head: 'Repair session failed', note: 'The runner stopped reporting', step: 'Resolve in repair session', primary: true },
};

async function fold(page, kind, openPanel) {
  await page.evaluate(({ s, kind, icon, openPanel }) => {
    const bar = document.querySelector('.wt-bar');
    const panel = bar.querySelector('.wt-recovery');
    const row = document.createElement('div');
    row.className = 'rpr-row';
    const spin = document.querySelector('.wt-recovery-repair-icon')?.innerHTML;
    row.innerHTML = `<span class="rpr-ico is-${kind}">${(kind === 'running' || kind === 'checking') && spin ? spin : icon}</span>
      <span class="rpr-head">${s.head}</span><span class="rpr-note is-${kind}">· ${s.note}</span>
      ${s.step ? `<button type="button" class="rpr-step${s.primary ? ' is-primary' : ''}">${s.step}</button>` : ''}
      <button type="button" class="wt-expand">${openPanel ? '▾' : '▸'}</button>`;
    bar.querySelector('.wt-row').after(row);
    if (openPanel) { bar.classList.add('rpr-open'); row.after(panel); } else panel.style.display = 'none';
  }, { s: STATES[kind], kind, icon: ICON[kind], openPanel });
  await settle(page);
}

const b = await launch();
const shot = async (name, opts, after, clip) => {
  const { page, errors, context } = await open(b, opts);
  if (after) await after(page);
  const c = clip ? await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const comp = document.querySelector('.composer-box').getBoundingClientRect();
    return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: comp.bottom - r.top + 16 }; }, clip) : undefined;
  const comp = await page.evaluate(() => Math.round(document.querySelector('.composer-box').getBoundingClientRect().top));
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: c });
  console.log(name, 'composer top', comp, errors.length ? errors : '');
  await context.close();
};
const repairFor = { running: REPAIR, checking: { ...REPAIR, runState: 'IDLE', status: 'IDLE' } };
try {
  await shot('01-today', { css: TODAY });
  await shot('02-fix', {});
  await shot('03-row', { css: ROW_CSS }, (p) => fold(p, 'running', false));
  await shot('04-row-open', { css: ROW_CSS }, (p) => fold(p, 'running', true));
  for (const k of Object.keys(STATES)) await shot(`05-${k}`, { css: ROW_CSS, over: { mergeRepairSession: repairFor[k] ?? REPAIR } }, (p) => fold(p, k, false), '.wt-bar');
  await shot('06-phone', { css: ROW_CSS, size: 'phone' }, (p) => fold(p, 'running', false));
  await shot('06-phone-today', { css: TODAY, size: 'phone' });
} finally { await b.close(); }
