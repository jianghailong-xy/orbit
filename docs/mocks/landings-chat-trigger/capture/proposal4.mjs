// Proposal 4 (owner 2026-11-11: "补充开始 land 之前的触发提交" → "按推荐的来，先出设计图"): each landing turn opens
// with what started it, drawn as the chat's own user bubble (chat-user-wrap / chat-user-from / chat-user): who it
// came from on the muted line over it, what was handed over in it (the task, its branch, its commit). The Queue
// step goes — its words were the trigger — so the steps start at Claim. A rerun is its own bubble over the
// generation it started. Data follows the owner's screenshots.
import { icon } from './icons.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LINE = 'project/34uUvixOgW5SbuNGvkAKA';
const STATUS = {
  ok: icon('check-circle', 'chat-tool-status ok'),
  err: icon('close-circle', 'chat-tool-status err'),
  run: icon('loading', 'chat-tool-status running', { spin: true }),
};
const STEP = {
  Claim: ['read', 'download'], Sync: ['read', 'branches'],
  'Task acceptance': ['exec', 'code'], 'Merge check': ['exec', 'code'], Push: ['write', 'cloud-upload'], Merge: ['write', 'cloud-upload'],
};
function step(name, summary, status, detail = null) {
  const [tone, ic] = STEP[name];
  return `<div class="chat-tool-card chat-tone-${tone}${detail ? ' is-open' : ''}">
    <div class="chat-tool-row"><span class="chat-tool-caret">${icon(detail ? 'down' : 'right')}</span>
      <span class="chat-tool-icon">${icon(ic)}</span><span class="chat-tool-name">${esc(name)}</span>
      <span class="chat-tool-summary">${esc(summary)}</span>${STATUS[status]}</div>
    ${detail ? `<div class="chat-tool-detail" style="padding:6px 12px 8px">${detail}</div>` : ''}</div>`;
}
const steps = (label, rows, { open = false, failed = 0, mk = '' } = {}) => `<div class="chat-steps${open ? ' is-open' : ''}" ${mk ? `data-mk="${mk}"` : ''}>
  <div class="chat-steps-line">${esc(label)}${failed ? `<span class="chat-steps-failed"> · ${failed} failed</span>` : ''}<span class="chat-steps-caret">${icon(open ? 'down' : 'right')}</span></div>
  ${open ? `<div class="chat-steps-detail">${rows}</div>` : ''}</div>`;
const reply = (html, mk = '') => `<div class="chat-msg chat-assistant lw-reply" ${mk ? `data-mk="${mk}"` : ''}><div class="md"><p>${html}</p></div></div>`;
const foot = (time) => `<div class="chat-turn-divider chat-turn-foot lw-foot">
  <button type="button" class="chat-copy" title="Landing actions" aria-label="Landing actions">${icon('ellipsis')}</button><span class="chat-time">${time}</span></div>`;
/** The trigger: the chat's user bubble, who it came from over it, and when under it. */
const ask = (from, html, time, mk = '') => `<div class="chat-user-wrap lw-ask" ${mk ? `data-mk="${mk}"` : ''}>
  <div class="chat-user-from">${esc(from)}</div>
  <div class="chat-msg chat-user"><div class="md"><p>${html}</p></div></div>
  <div class="chat-user-meta lw-ask-meta"><span class="chat-time">${time}</span></div></div>`;
const turn = (parts) => `<div class="lw-turn">${parts.join('')}</div>`;
const chip = (t, now = false) => `<div class="lw-chip${now ? ' is-now' : ''}">${t}</div>`;
const code = (t) => `<code>${esc(t)}</code>`;
const links = `<div class="lw-links"><button type="button" class="landing-page-link">Open Task ›</button><button type="button" class="landing-page-link">Open Source Session ›</button></div>`;

const HPC = "Find why HPC's self-update stopped four running turns, and keep the upgrade gate from doing it again";
const DOC = "Record in the design doc that an OOM kill, not the upgrade gate, stopped HPC's turns, and what OOMPolicy=continue changes";
const REL = 'Release runner 0.1.253: bump the version so runners take the OOMPolicy fix and the bounded deferral';

const docGen1 = [
  step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
  step('Sync', `Rebasing onto ${LINE}`, 'ok'),
  step('Task acceptance', 'Task acceptance failed · exit 1', 'err'),
].join('');
const docGen2 = [
  step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
  step('Sync', 'Preparing the combined tree', 'ok'),
  step('Task acceptance', 'Task acceptance passed · 0m 00s', 'ok'),
  step('Push', `Landed on ${LINE} · ed3d3e9`, 'ok'),
].join('');

const delivered = (task, branch, sha) => `Land <strong>${esc(task)}</strong> · ${code(branch)} · ${code(sha)}`;

const history = (openDoc) => [
  chip('Today'),
  turn([ask('From the task · Done', delivered(HPC, 'orbit/task-hpc-self-update-6c1f0a', 'fe5db82'), '2:01 AM', openDoc ? '' : '1'),
    reply(`Landed <strong>${esc(HPC)}</strong> on ${code(LINE)} · ${code('fe5db82')}.`), steps('3 steps', ''), foot('2:03 AM')]),
  turn([ask('From Automatic', `Merge <strong>1 task</strong> into main · ${code(LINE)} · ${code('fe5db82')}`, '2:04 AM', openDoc ? '' : '2'),
    reply(`Merged <strong>1 task</strong> into main · ${code('f0416c9')} · automatically.`), steps('3 steps', ''), foot('2:05 AM')]),
  turn([ask('From the task · Done', delivered(REL, 'orbit/task-release-0-1-253-91ab2e', '77c03d1'), '5:06 AM'),
    reply(`Already landed: <strong>${esc(REL)}</strong> was on the project line before this landing.`), steps('3 steps', ''), foot('5:07 AM')]),
  openDoc
    ? turn([ask('From the task · Done', delivered(DOC, 'orbit/task-oom-design-doc-3e81c2', 'c4a90b7'), '7:44 AM', '1'),
      reply(`Landed <strong>${esc(DOC)}</strong> on ${code(LINE)} · ${code('ed3d3e9')}, on the second try.`),
      steps('Generation 1 · 3 steps', '', { failed: 1 }),
      ask('From the coordinator · Rerun', "The red was the coordinator's acceptance command, not the delivery", '7:46 AM', '2'),
      steps('Generation 2 · 4 steps', docGen2, { open: true, mk: '3' }), links, foot('7:47 AM')])
    : turn([ask('From the task · Done', delivered(DOC, 'orbit/task-oom-design-doc-3e81c2', 'c4a90b7'), '7:44 AM', '3'),
      reply(`Landed <strong>${esc(DOC)}</strong> on ${code(LINE)} · ${code('ed3d3e9')}, on the second try.`),
      steps('Generation 1 · 3 steps', '', { failed: 1 }),
      ask('From the coordinator · Rerun', "The red was the coordinator's acceptance command, not the delivery", '7:46 AM', '4'),
      steps('Generation 2 · 4 steps', ''), foot('7:47 AM')]),
].join('');

const waitCard = `<div class="chat-status-card lw-wait" role="status">
  <div class="chat-status-head"><span class="chat-status-icon lw-wait-icon">${icon('close')}</span>Not landed · waiting for a decision<span class="lw-age">18m</span></div>
  <div class="lw-body"><div class="lw-dim">checks failed · exit 1 after 3m 52s</div><div class="lw-who">${icon('user')} Decisions: the coordinator</div>
  <div class="lw-doors"><button class="orbit-button orbit-button-primary orbit-button-middle"><span>Open Coordinator</span></button><button class="orbit-button orbit-button-default orbit-button-middle"><span>Open Task</span></button></div></div></div>`;
const live = `<div class="lw-budget"><div class="landing-card-budget"><span>Merge check <b>6m 12s</b> of 30m · usually ~9m</span></div>
  <div class="landing-card-meter" aria-hidden="true"><i style="width:21%"></i><b class="landing-card-meter-tick" style="left:30%"></b></div>
  <div class="landing-card-live"><span class="landing-live-dot" aria-hidden="true"></span>Output 2s ago · Updated just now</div></div>`;
const bottom = [
  chip('Now', true),
  turn([ask('From the task · Done', delivered('Server: answer a withdrawn owner request with 409', 'orbit/task-withdrawn-409-a07d55', '5b2e9f0'), '8:31 AM', '1'),
    reply(`Did not land <strong>Server: answer a withdrawn owner request with 409</strong>: merge check exited 1 (expected 0) on the combined tree · nothing was pushed.`),
    steps('3 steps', '', { failed: 1 }), waitCard, foot('8:36 AM')]),
  turn([ask('From the owner · Rerun', delivered("Server: drop the owner's push when the device token is revoked", 'orbit/task-revoked-push-d3c118', '9e41a2c'), '8:40 AM', '2'),
    `<div class="chat-turn-head">Working for 7m 47s</div>`,
    reply(`Landing <strong>Server: drop the owner's push when the device token is revoked</strong> on ${code(LINE)}…`),
    live,
    steps('3 steps', [
      step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
      step('Sync', `Rebasing onto ${LINE}`, 'ok'), step('Merge check', 'Merge check started · claim 1 · workstation-gpu', 'run')].join(''), { open: true, mk: '3' })]),
].join('');

export const proposal = {
  scenes: {
    't-history': { html: history(false), height: 900 },
    't-open': { html: history(true), height: 1000 },
    't-bottom': { html: bottom, height: 900 },
  },
  css: `
    .chat-sticky, .chat-sticky-question { display: none !important; }
    .lw-chip { width: fit-content; margin: 12px auto 8px; padding: 2px 10px; border-radius: 999px; background: var(--fill-muted); color: var(--text-2); font-size: 12px; font-weight: 600; line-height: 18px; }
    .lw-chip.is-now { background: var(--brand-tint); color: var(--brand); }
    .lw-turn { margin: 0 0 6px; }
    .lw-turn .chat-steps { margin: 2px 0; }
    .lw-turn .chat-assistant { margin: 2px 0 0; }
    .lw-turn .chat-assistant .md p, .lw-ask .md p { margin: 0; }
    .lw-turn code { font-size: 0.9em; }
    .lw-ask { margin: 10px 12px 4px auto; }
    .lw-ask .chat-user-meta > .chat-time { opacity: 1; visibility: visible; }
    .lw-foot { margin-top: 0; }
    .lw-links { display: flex; gap: 14px; margin: 6px 12px 0; }
    .lw-links .landing-page-link { margin-left: 0; }
    .lw-wait { margin: 8px 12px 4px; width: min(620px, calc(100% - 24px)); border-left-color: var(--error); }
    .lw-wait-icon { background: var(--error); font-size: 10px; }
    .lw-age { margin-left: auto; color: var(--text-3); font-weight: 500; font-size: 12.5px; }
    .lw-body { padding: 4px 12px 12px; display: grid; gap: 8px; font-size: 13px; }
    .lw-dim { color: var(--text-3); } .lw-who { display: flex; gap: 6px; align-items: center; }
    .lw-doors { display: flex; gap: 8px; }
    .lw-budget { padding: 4px 12px 6px; } .lw-budget .landing-card-live { margin-top: 6px; }
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
