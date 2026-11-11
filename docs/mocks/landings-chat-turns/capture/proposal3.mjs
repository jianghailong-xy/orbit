// Proposal 3 (owner 2026-11-11: "Landed 是否应该对应 session 里的 plain text" → yes): each landing is one chat TURN —
// its steps folded on the chat's steps line, then one plain-text sentence that says how it ended (the reply), then the
// turn foot (⋯ and the time). A failed generation folds to its own steps line with "· 1 failed" in red; the last one
// opens when the landing is opened. A landing that waits is its turn plus the chat's status card; one that runs is the
// chat's Working for turn with its steps open and no sentence yet. Data follows the owner's screenshots.
import { icon } from './icons.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LINE = 'project/34uUvixOgW5SbuNGvkAKA';
const STATUS = {
  ok: icon('check-circle', 'chat-tool-status ok'),
  err: icon('close-circle', 'chat-tool-status err'),
  run: icon('loading', 'chat-tool-status running', { spin: true }),
};
const STEP = {
  Queue: ['default', 'unordered-list'], Claim: ['read', 'download'], Sync: ['read', 'branches'],
  'Task acceptance': ['exec', 'code'], 'Merge check': ['exec', 'code'], Push: ['write', 'cloud-upload'], Merge: ['write', 'pull-request'],
};
function step(name, summary, status, detail = null) {
  const [tone, ic] = STEP[name];
  return `<div class="chat-tool-card chat-tone-${tone}${detail ? ' is-open' : ''}">
    <div class="chat-tool-row"><span class="chat-tool-caret">${icon(detail ? 'down' : 'right')}</span>
      <span class="chat-tool-icon">${icon(ic)}</span><span class="chat-tool-name">${esc(name)}</span>
      <span class="chat-tool-summary">${esc(summary)}</span>${STATUS[status]}</div>
    ${detail ? `<div class="chat-tool-detail" style="padding:6px 12px 8px">${detail}</div>` : ''}</div>`;
}
const steps = (label, rows, { open = false, failed = 0, mk = '' } = {}) => `<div class="chat-steps${open ? ' is-open' : ''} lw-steps" ${mk ? `data-mk="${mk}"` : ''}>
  <div class="chat-steps-line">${esc(label)}${failed ? `<span class="chat-steps-failed"> · ${failed} failed</span>` : ''}<span class="chat-steps-caret">${icon(open ? 'down' : 'right')}</span></div>
  ${open ? `<div class="chat-steps-detail">${rows}</div>` : ''}</div>`;
const reply = (html, mk = '') => `<div class="chat-msg chat-assistant lw-reply" ${mk ? `data-mk="${mk}"` : ''}><div class="md"><p>${html}</p></div></div>`;
const foot = (time, mk = '') => `<div class="chat-turn-divider chat-turn-foot lw-foot" ${mk ? `data-mk="${mk}"` : ''}>
  <button type="button" class="chat-copy" title="Landing actions" aria-label="Landing actions">${icon('ellipsis')}</button><span class="chat-time">${time}</span></div>`;
const turn = (parts, mk = '') => `<div class="lw-turn" ${mk ? `data-mk="${mk}"` : ''}>${parts.join('')}</div>`;
const chip = (t, now = false) => `<div class="lw-chip${now ? ' is-now' : ''}">${t}</div>`;
const code = (t) => `<code>${esc(t)}</code>`;
const links = `<div class="lw-links"><button type="button" class="landing-page-link">Open Task ›</button><button type="button" class="landing-page-link">Open Source Session ›</button></div>`;

const docGen1 = [
  step('Queue', `Task marked done · queued to land on ${LINE}`, 'ok'),
  step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
  step('Sync', `Rebasing onto ${LINE}`, 'ok'),
  step('Task acceptance', 'Task acceptance failed · exit 1', 'err'),
].join('');
const docGen2 = [
  step('Queue', "Rerun by the coordinator · The red was the coordinator's acceptance command, not the delivery", 'ok'),
  step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
  step('Sync', 'Preparing the combined tree', 'ok'),
  step('Task acceptance', 'Task acceptance passed · 0m 00s', 'ok'),
  step('Push', `Landed on ${LINE} · ed3d3e9`, 'ok'),
].join('');

const history = (openDoc) => [
  chip('Today'),
  turn([steps('5 steps', ''), reply(`Landed <strong>Find why HPC's self-update stopped four running turns, and keep the upgrade gate from doing it again</strong> on ${code(LINE)} · ${code('a91c2e0')}.`, openDoc ? '' : '1'), foot('2:03 AM', openDoc ? '' : '2')]),
  turn([steps('2 steps', ''), reply(`Merged <strong>1 task</strong> into main · ${code('f0416c9')} · automatically.`, openDoc ? '' : '3'), foot('2:05 AM')]),
  turn([steps('4 steps', ''), reply(`Already landed: <strong>Release runner 0.1.253: bump the version so runners take the OOMPolicy fix and the bounded deferral</strong> was on the project line before this landing.`, openDoc ? '' : '4'), foot('5:07 AM')]),
  openDoc
    ? turn([steps('Generation 1 · 4 steps', docGen1, { failed: 1, mk: '1' }), steps('Generation 2 · 5 steps', docGen2, { open: true, mk: '2' }),
      reply(`Landed <strong>Record in the design doc that an OOM kill, not the upgrade gate, stopped HPC's turns, and what OOMPolicy=continue changes</strong> on ${code(LINE)} · ${code('ed3d3e9')}, on the second try.`, '3'), links, foot('7:47 AM')])
    : turn([steps('Generation 1 · 4 steps', docGen1, { failed: 1, mk: '5' }), steps('Generation 2 · 5 steps', ''),
      reply(`Landed <strong>Record in the design doc that an OOM kill, not the upgrade gate, stopped HPC's turns, and what OOMPolicy=continue changes</strong> on ${code(LINE)} · ${code('ed3d3e9')}, on the second try.`), foot('7:47 AM')]),
].join('');

const waitCard = (mk) => `<div class="chat-status-card lw-wait" role="status" data-mk="${mk}">
  <div class="chat-status-head"><span class="chat-status-icon lw-wait-icon">${icon('close')}</span>Not landed · waiting for a decision<span class="lw-age">18m</span></div>
  <div class="chat-status-grid"><div class="chat-status-row"><span class="chat-status-label">Decides</span><span class="chat-status-value">The coordinator</span></div>
    <div class="chat-status-row"><span class="chat-status-label">Pushed</span><span class="chat-status-value">Nothing · the project branch did not move</span></div></div>
  <div class="lw-doors"><button class="orbit-button orbit-button-primary orbit-button-middle"><span>Open Coordinator</span></button><button class="orbit-button orbit-button-default orbit-button-middle"><span>Open Task</span></button></div></div>`;
const live = `<div class="lw-budget"><div class="landing-card-budget"><span>Merge check <b>6m 12s</b> of 30m · usually ~9m</span></div>
  <div class="landing-card-meter" aria-hidden="true"><i style="width:21%"></i><b class="landing-card-meter-tick" style="left:30%"></b></div>
  <div class="landing-card-live"><span class="landing-live-dot" aria-hidden="true"></span>Output 2s ago · Updated just now</div></div>
  <pre class="landing-live-output">✓ apiserver  push-tokens.pg.spec.ts (14 tests)  6.0s
… web        PushSettings.test.tsx</pre>`;
const bottom = [
  turn([steps('5 steps', ''), reply(`Landed <strong>Release runner 0.1.254: ship the realtime row fix</strong> on ${code(LINE)} · ${code('3b7e112')}.`), foot('8:02 AM')]),
  chip('Now', true),
  turn([steps('4 steps', [
      step('Queue', `Task marked done · queued to land on ${LINE}`, 'ok'), step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
      step('Sync', `Rebasing onto ${LINE}`, 'ok'), step('Merge check', 'Check failed · nothing was pushed', 'err')].join(''), { failed: 1 }),
    reply(`Did not land <strong>Server: answer a withdrawn owner request with 409</strong>: the merge check exited 1 (expected 0) on the combined tree, and nothing was pushed.`, '1'),
    waitCard('2'), foot('8:36 AM')]),
  turn([`<div class="chat-turn-head" data-mk="3">Working for 7m 47s</div>`,
    reply(`Landing <strong>Server: drop the owner's push when the device token is revoked</strong> on ${code(LINE)}…`),
    steps('4 steps', [
      step('Queue', `Task marked done · queued to land on ${LINE}`, 'ok'), step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
      step('Sync', `Rebasing onto ${LINE}`, 'ok'), step('Merge check', 'Merge check started · claim 1 · workstation-gpu', 'run', live)].join(''), { open: true, mk: '4' })]),
].join('');

export const proposal = {
  scenes: {
    'r-history': { html: history(false), height: 720 },
    'r-open': { html: history(true), height: 900 },
    'r-bottom': { html: bottom, height: 980 },
  },
  css: `
    .lw-chip { width: fit-content; margin: 12px auto 8px; padding: 2px 10px; border-radius: 999px; background: var(--fill-muted); color: var(--text-2); font-size: 12px; font-weight: 600; line-height: 18px; }
    .lw-chip.is-now { background: var(--brand-tint); color: var(--brand); }
    .lw-turn { margin: 0 0 6px; }
    .lw-turn .chat-steps { margin: 2px 0 2px; }
    .lw-turn .chat-assistant { margin: 2px 0 0; }
    .lw-turn .chat-assistant .md p { margin: 0; }
    .lw-turn .chat-assistant code { font-size: 0.9em; }
    .lw-foot { margin-top: 0; }
    .lw-links { display: flex; gap: 14px; margin: 6px 12px 0; }
    .lw-links .landing-page-link { margin-left: 0; }
    .lw-wait { margin: 8px 12px 4px; width: min(620px, calc(100% - 24px)); border-left-color: var(--error); }
    .lw-wait-icon { background: var(--error); font-size: 10px; }
    .lw-age { margin-left: auto; color: var(--text-3); font-weight: 500; font-size: 12.5px; }
    .lw-doors { display: flex; gap: 8px; padding: 2px 12px 12px; }
    .lw-budget { padding: 4px 0 6px; } .lw-budget .landing-card-live { margin-top: 6px; }
  `,
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
  foot: `<div class="landing-page-foot" style="padding:6px 12px"><span class="landing-page-foot-line">${icon('lock')}<span>Orbit runs these landings</span></span>
    <button type="button" class="orbit-button orbit-button-default orbit-button-middle landing-page-foot-open">${icon('user')}<span>Open coordinator</span></button></div>`,
  sub: 'Runner self-update and the upgrade gate',
};
