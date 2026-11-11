// Proposal 2 (owner 2026-11-11: "图 1 和 图 2 普通 session 聊天的样式" — make an opened landing read like the chat):
// each attempt of a landing is the chat's folded steps line (`chat-steps`: "Ran 8 shell commands ⌄"), here
// "Generation 2 · 5 steps ⌄", opening into the tool rows; no uppercase heading, no time chip on a row; a failed
// attempt's line says "· 1 failed" in red and stays folded; the last attempt starts open. Data follows the owner's
// screenshot (the doc landing that failed task acceptance once, then landed).
import { icon } from './icons.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LINE = 'project/34uUvixOgW5SbuNGvkAKA';
const STATUS = {
  ok: icon('check-circle', 'chat-tool-status ok'),
  err: icon('close-circle', 'chat-tool-status err'),
};
const STEP = {
  Queue: { tone: 'default', icon: 'unordered-list' },
  Claim: { tone: 'read', icon: 'download' },
  Sync: { tone: 'read', icon: 'branches' },
  'Task acceptance': { tone: 'exec', icon: 'code' },
  'Merge check': { tone: 'exec', icon: 'code' },
  Push: { tone: 'write', icon: 'cloud-upload' },
};
const ev = (t, mark, text, cls = '') => `<div class="landing-timeline-entry"><span class="landing-timeline-time">${t}</span>
  <span class="landing-timeline-glyph is-${cls || 'ok'}">${mark}</span><span class="landing-timeline-body"><span class="landing-timeline-text">${esc(text)}</span></span></div>`;
function step(name, summary, status, detail = null, mk = '') {
  const s = STEP[name];
  return `<div class="chat-tool-card chat-tone-${s.tone}${detail ? ' is-open' : ''}" ${mk ? `data-mk="${mk}"` : ''}>
    <div class="chat-tool-row">
      <span class="chat-tool-caret">${icon(detail ? 'down' : 'right')}</span>
      <span class="chat-tool-icon">${icon(s.icon)}</span>
      <span class="chat-tool-name">${esc(name)}</span>
      <span class="chat-tool-summary">${esc(summary)}</span>
      ${STATUS[status]}
    </div>${detail ? `<div class="chat-tool-detail" style="padding:6px 12px 8px">${detail}</div>` : ''}
  </div>`;
}
/** One attempt as the chat's folded steps line, and its rows when open. */
function attempt({ label, count, failed = 0, open = false, rows = '', mk = '' }) {
  return `<div class="chat-steps${open ? ' is-open' : ''} lw-attempt" ${mk ? `data-mk="${mk}"` : ''}>
    <div class="chat-steps-line">${esc(label)} · ${count} steps${failed ? `<span class="chat-steps-failed"> · ${failed} failed</span>` : ''}
      <span class="chat-steps-caret">${icon(open ? 'down' : 'right')}</span></div>
    ${open ? `<div class="chat-steps-detail">${rows}</div>` : ''}
  </div>`;
}
function line({ kind, title, name, status, time, open = false, body = '', mk = '' }) {
  const mark = kind === 'failed' ? icon('close-circle') : kind === 'merge' ? `<span class="lw-merge-mark">⇢</span>` : icon('check-circle');
  return `<div class="bgwake ${kind === 'failed' ? 'is-failed' : 'is-ok'} lw-line" ${mk ? `data-mk="${mk}"` : ''}>
    <details class="bgwake-fold"${open ? ' open' : ''}>
      <summary class="bgwake-row">
        <span class="bgwake-mark">${mark}</span>
        <span class="bgwake-title">${esc(title)}</span>
        <span class="bgwake-name">${esc(name)}</span>
        ${status ? `<span class="bgwake-status">${esc(status)}</span>` : ''}
        <span class="bgwake-time">${esc(time)}</span>
        <span class="bgwake-details-label">Details ${icon('right', 'bgwake-caret')}</span>
      </summary>
      ${open ? `<div class="lw-body">${body}</div>` : ''}
    </details></div>`;
}
const links = `<div class="lw-links"><button type="button" class="landing-page-link">Open Task ›</button><button type="button" class="landing-page-link">Open Source Session ›</button></div>`;

const gen2Rows = [
  step('Queue', 'Rerun by the coordinator · The red was the coordinator\'s acceptance command, not the delivery', 'ok'),
  step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
  step('Sync', `Preparing the combined tree`, 'ok', null, '3'),
  step('Task acceptance', 'Task acceptance passed · 0m 00s', 'ok', null, '2'),
  step('Push', `Landed on ${LINE} · ed3d3e9`, 'ok'),
].join('');
const gen1Rows = [
  step('Queue', `Task marked done · queued to land on ${LINE}`, 'ok'),
  step('Claim', 'Claimed by runner workstation-gpu · claim 1', 'ok'),
  step('Sync', `Rebasing onto ${LINE}`, 'ok'),
  step('Task acceptance', 'Task acceptance failed · exit 1', 'err',
    ev('07:46', '✗', 'Task acceptance failed · exit 1', 'failed') + ev('07:46', '↻', 'Asked the coordinator to fix it', 'running')
    + `<pre class="landing-live-output">$ git diff --name-only origin/main...HEAD | grep -v '^docs/'\nsrc/runner-go/main.go\nexit 1</pre>`),
].join('');

const history = (opts) => [
  line({ kind: 'ok', title: 'Landed', name: "Find why HPC's self-update stopped four running turns, and keep the upgrade gate from doing it again", status: 'check 2m 05s', time: '02:03' }),
  line({ kind: 'merge', title: 'Merged into main', name: 'f0416c9 · 1 task · automatically', time: '02:05' }),
  line({ kind: 'ok', title: 'Already landed', name: 'Release runner 0.1.253: bump the version so runners take the OOMPolicy fix and the bounded deferral', time: '05:07', mk: opts.chipMk }),
  line({ kind: 'ok', title: 'Landed', name: "Record in the design doc that an OOM kill, not the upgrade gate, stopped HPC's turns, and what OOMPolicy=continue changes",
    time: '07:47', open: true, mk: '1', body: [
      attempt({ label: 'Generation 1', count: 4, failed: 1, open: opts.gen1Open, rows: gen1Rows, mk: '4' }),
      attempt({ label: 'Generation 2', count: 5, open: true, rows: gen2Rows, mk: '5' }),
      links,
    ].join('') }),
].join('');

export const proposal = {
  scenes: {
    'q-open': { html: history({ gen1Open: false, chipMk: '6' }), height: 680 },
    'q-failed': { html: history({ gen1Open: true }), height: 820 },
  },
  css: `
    .lw-line { margin: 0; }
    .lw-merge-mark { color: var(--brand); font-weight: 700; }
    .lw-body { margin: 2px 0 10px 22px; }
    .lw-attempt { padding: 0; margin: 2px 0 6px; }
    .lw-attempt .chat-steps-detail .chat-tool-card { margin: 3px 0; }
    .lw-links { display: flex; gap: 14px; margin: 6px 0 4px; }
    .lw-links .landing-page-link { margin-left: 0; }
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
