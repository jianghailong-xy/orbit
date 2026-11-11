// The Landings window drawn with the session chat's own parts (owner 2026-11-11: make figure 1 read like
// figure 2): each landing is one line in the background-job line's shape (`bgwake`), its steps open as the
// chat's tool rows (`chat-tool-card`), a landing still running is a `Working for` turn, and a merge into
// main is the same line with the merge mark. Data follows the owner's screenshot.
import { icon } from './icons.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LINE = 'project/34vDQ99CM6oxGIO3kLVX9';

const STATUS = {
  ok: icon('check-circle', 'chat-tool-status ok'),
  err: icon('close-circle', 'chat-tool-status err'),
  running: icon('loading', 'chat-tool-status running', { spin: true }),
  pending: icon('minus-circle', 'chat-tool-status pending'),
};
const STEP = {
  Queue: { tone: 'default', icon: 'unordered-list' },
  Claim: { tone: 'read', icon: 'download' },
  Sync: { tone: 'read', icon: 'branches' },
  'Merge check': { tone: 'exec', icon: 'code' },
  Push: { tone: 'write', icon: 'cloud-upload' },
  Merge: { tone: 'write', icon: 'pull-request' },
  Result: { tone: 'default', icon: 'minus-circle' },
};

/** One step of a landing, as the chat draws one tool call: icon, name, what happened, its time, its mark. */
function step({ name, summary, status, time, detail = null, mk = '' }) {
  const s = STEP[name];
  return `<div class="chat-tool-card chat-tone-${s.tone}${detail ? ' is-open' : ''}" ${mk ? `data-mk="${mk}"` : ''}>
    <div class="chat-tool-row">
      <span class="chat-tool-caret">${icon(detail ? 'down' : 'right')}</span>
      <span class="chat-tool-icon">${icon(s.icon)}</span>
      <span class="chat-tool-name">${esc(name)}</span>
      <span class="chat-tool-summary">${summary}</span>
      ${time ? `<span class="chat-tool-meta lw-step-time">${time}</span>` : ''}
      ${STATUS[status]}
    </div>${detail ? `<div class="chat-tool-detail">${detail}</div>` : ''}
  </div>`;
}
const output = (cmd, text, error = false) => `<div class="chat-tool-body"><div class="chat-pre-wrap cmd"><pre class="chat-pre"><span class="chat-cmd-prompt">$ </span>${esc(cmd)}</pre></div></div>
  <div class="chat-result compact${error ? ' is-error' : ''}"><div class="chat-result-label">${error ? 'error' : 'output'}</div>
    <div class="chat-pre-wrap muted"><pre class="chat-pre">${esc(text.trim())}</pre></div></div>`;

/** One landing as the background-job line: its mark, what happened, the task, a short fact, the time, Details ›. */
function line({ kind, title, name, status, time, open = false, body = '', mk = '' }) {
  const mark = kind === 'failed' ? icon('close-circle') : kind === 'running' ? icon('clock-circle')
    : kind === 'merge' ? `<span class="lw-merge-mark">⇢</span>` : kind === 'quiet' ? icon('minus-circle') : icon('check-circle');
  const cls = kind === 'failed' ? 'is-failed' : 'is-ok';
  return `<div class="bgwake ${cls} lw-line lw-${kind}" ${mk ? `data-mk="${mk}"` : ''}>
    <details class="bgwake-fold"${open ? ' open' : ''}>
      <summary class="bgwake-row">
        <span class="bgwake-mark${kind === 'running' ? ' is-pending' : ''}">${mark}</span>
        <span class="bgwake-title">${esc(title)}</span>
        ${name ? `<span class="bgwake-name">${esc(name)}</span>` : ''}
        ${status ? `<span class="bgwake-status">${esc(status)}</span>` : ''}
        <span class="bgwake-time">${esc(time)}</span>
        <span class="bgwake-details-label">Details ${icon('right', 'bgwake-caret')}</span>
      </summary>
      ${open ? `<div class="lw-steps">${body}</div>` : ''}
    </details>
  </div>`;
}
const links = `<div class="lw-links"><button type="button" class="landing-page-link">Open Task ›</button><button type="button" class="landing-page-link">Open Source Session ›</button></div>`;
const chip = (t, now = false) => `<div class="lw-chip${now ? ' is-now' : ''}">${t}</div>`;
const turnHead = (t) => `<div class="chat-turn-head">${t}</div>`;

const CHECK_LOG = `> orbit@0.1.260 test:landing
> node scripts/run-landing-check.mjs --changed

✓ apiserver  project-done-request.pg.spec.ts (12 tests)  4.1s
✓ apiserver  project-done-push.pg.spec.ts (7 tests)  2.8s
✓ web        ProjectDone.test.tsx (9 tests)  1.2s
All 28 tests passed in 0m 16s`;
const FAILED_LOG = `✗ apiserver  owner-requests.pg.spec.ts > answers a request the coordinator withdrew
  Expected status 409, received 200
    at owner-requests.pg.spec.ts:214:18
1 failed, 41 passed`;

const steps = (open) => [
  step({ name: 'Queue', summary: `Task marked done · queued to land on <code>${LINE}</code>`, status: 'ok', time: '23:22' }),
  step({ name: 'Claim', summary: 'workstation-gpu · claim 1 · waited for the repository lock', status: 'ok', time: '23:23' }),
  step({ name: 'Sync', summary: `Round 1 of 3 · fetched · main synced into the project line · rebased`, status: 'ok', time: '23:24' }),
  step({ name: 'Merge check', summary: 'passed on the combined tree · 0m 16s', status: 'ok', time: '23:24',
    detail: open ? output('npm run test:landing', CHECK_LOG) : null, mk: open ? '3' : '' }),
  step({ name: 'Push', summary: `<code>${LINE}</code> · 9afb7d1 · tree verified`, status: 'ok', time: '23:26' }),
].join('') + links;

const failedSteps = [
  step({ name: 'Queue', summary: `Task marked done · queued to land on <code>${LINE}</code>`, status: 'ok', time: '00:31' }),
  step({ name: 'Claim', summary: 'workstation-gpu · claim 1', status: 'ok', time: '00:31' }),
  step({ name: 'Sync', summary: 'Round 1 of 3 · fetched · main synced into the project line · rebased', status: 'ok', time: '00:32' }),
  step({ name: 'Merge check', summary: 'failed · exit 1 after 3m 52s · nothing was pushed', status: 'err', time: '00:36',
    detail: output('npm run test:landing', FAILED_LOG, true) }),
].join('') + `<div class="lw-wait">
    <div class="lw-wait-line">${icon('user')}<span><b>The coordinator</b> decides · waiting 18m</span></div>
    <div class="lw-wait-doors">
      <button type="button" class="orbit-button orbit-button-primary orbit-button-middle"><span>Open Coordinator</span></button>
      <button type="button" class="orbit-button orbit-button-default orbit-button-middle"><span>Open Task</span></button>
    </div></div>`;

const liveTurn = `<div class="lw-turn" data-mk="5">${turnHead('Working for 6m 12s')}
  <div class="lw-turn-title">Landing <b>Server: drop the owner's push when the device token is revoked</b></div>
  ${step({ name: 'Queue', summary: `Task marked done · queued to land on <code>${LINE}</code>`, status: 'ok', time: '00:40' })}
  ${step({ name: 'Claim', summary: 'workstation-gpu · claim 1', status: 'ok', time: '00:40' })}
  ${step({ name: 'Sync', summary: 'Round 1 of 3 · fetched · main synced into the project line · rebased', status: 'ok', time: '00:41' })}
  ${step({ name: 'Merge check', summary: 'running · 6m 12s of 30m · usually ~9m', status: 'running', time: '00:41',
    detail: `<div class="lw-budget"><div class="landing-card-meter" aria-hidden="true"><i style="width:21%"></i><b class="landing-card-meter-tick" style="left:30%"></b></div>
      <div class="landing-card-live"><span class="landing-live-dot" aria-hidden="true"></span>Output 2s ago · Updated just now</div></div>
      ${output('npm run test:landing', `✓ apiserver  push-tokens.pg.spec.ts (14 tests)  6.0s
… web        PushSettings.test.tsx`)}` })}
</div>`;

const foot = `<div class="landing-page-foot lw-foot">
  <span class="landing-page-foot-line">${icon('lock')}<span>Orbit runs these landings</span></span>
  <button type="button" class="orbit-button orbit-button-default orbit-button-middle landing-page-foot-open">${icon('user')}<span>Open coordinator</span></button>
</div>`;

const history = (openSecond) => [
  chip('Yesterday'),
  line({ kind: 'merge', title: 'Merged into main', name: '1fec9fb · 2 tasks', status: 'automatically', time: '23:06', mk: openSecond ? '' : '2' }),
  line({ kind: 'ok', title: 'Landed', name: 'Server: refuse a done request unchanged since the owner said Not yet', status: 'check 0m 16s', time: '23:20', mk: openSecond ? '' : '1' }),
  line({ kind: 'ok', title: 'Landed', name: 'Server: push the owner when the projection records a project DONE', status: 'check 0m 16s', time: '23:26',
    open: openSecond, body: openSecond ? steps(true) : '', mk: openSecond ? '1' : '' }),
  line({ kind: 'merge', title: 'Merged into main', name: '8958893 · 2 tasks', status: 'automatically', time: '23:43' }),
  line({ kind: 'quiet', title: 'Nothing to land', name: 'Docs: note the done-request digest rule', status: 'no commits', time: '23:51', mk: openSecond ? '' : '4' }),
].join('');

const bottom = [
  chip('Yesterday'),
  line({ kind: 'merge', title: 'Merged into main', name: '8958893 · 2 tasks', status: 'automatically', time: '23:43' }),
  line({ kind: 'quiet', title: 'Nothing to land', name: 'Docs: note the done-request digest rule', status: 'no commits', time: '23:51' }),
  chip('Now', true),
  line({ kind: 'failed', title: 'Not landed', name: 'Server: answer a withdrawn owner request with 409', status: 'exit 1', time: '00:36', open: true, body: failedSteps, mk: '4' }),
  liveTurn,
].join('');

export const proposal = {
  scenes: {
    'p-history': { html: history(false), height: 640 },
    'p-open': { html: history(true), height: 1150 },
    'p-bottom': { html: bottom, height: 1400 },
  },
  css: `
    .lw-chip { width: fit-content; margin: 14px auto 10px; padding: 2px 10px; border-radius: 999px; background: var(--fill-muted); color: var(--text-2); font-size: 12px; font-weight: 600; line-height: 18px; }
    .lw-chip.is-now { background: var(--brand-tint); color: var(--brand); }
    .lw-line { margin: 2px 0; }
    .lw-merge-mark { color: var(--brand); font-weight: 700; }
    .lw-line.lw-quiet .bgwake-mark { color: var(--text-3); }
    .lw-steps { margin: 6px 0 4px 26px; display: flex; flex-direction: column; gap: 2px; }
    .lw-steps code, .lw-turn code { font-size: 0.92em; }
    .lw-step-time { font-variant-numeric: tabular-nums; }
    .lw-links { display: flex; gap: 14px; margin: 8px 0 4px 2px; }
    .lw-links .landing-page-link { margin-left: 0; }
    .lw-wait { margin: 8px 0 4px; padding: 10px 12px; border-radius: 10px; background: var(--bg-sunken); }
    .lw-wait-line { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 13px; }
    .lw-wait-line b { color: var(--text-1); }
    .lw-wait-doors { display: flex; gap: 8px; margin-top: 10px; }
    .lw-turn { margin-top: 10px; display: flex; flex-direction: column; gap: 2px; }
    .lw-turn-title { margin: 2px 0 6px; color: var(--text-2); font-size: 14px; }
    .lw-turn-title b { color: var(--text-1); font-weight: 600; }
    .lw-budget { padding: 10px 14px 4px; }
    .lw-budget .landing-card-live { margin-top: 6px; }
    .lw-foot { padding: 6px 12px; }
  `,
  /** In the page: the session page becomes the Landings window. */
  inject({ html, foot, sub }) {
    document.querySelector('.workspace-view .workspace-name').textContent = 'Landings';
    document.querySelector('.workspace-view .watch-badges')?.remove();
    const s = document.querySelector('.workspace-view .workspace-sub');
    if (s) s.textContent = sub;
    const list = document.querySelector('.workspace-view .workspace-sessions');
    list.innerHTML = `<div class="lw-list">${html}</div>`;
    const composer = document.querySelector('.workspace-view .workspace-composer');
    if (composer) composer.innerHTML = foot;
    document.querySelector('.workspace-view .scroll-to-bottom')?.remove();
  },
  foot,
  sub: 'Project DONE: owner confirmation review',
};
