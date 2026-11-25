// The walk's table: per case, the six fields from the real API (list row and detail), the words the console showed
// (list row line and header word, read from the DOM), the approved word, and whether they match.
// usage: node make-table.mjs <api.json> <dom.json> <ab.json> <out.md>
import fs from 'node:fs';

const [apiFile, domFile, abFile, out] = process.argv.slice(2);
if (!apiFile || !domFile || !abFile || !out) throw new Error('usage: make-table.mjs <api.json> <dom.json> <ab.json> <out.md>');
const api = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
const dom = JSON.parse(fs.readFileSync(domFile, 'utf8'));
const ab = JSON.parse(fs.readFileSync(abFile, 'utf8'));
const FIELDS = ['phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished'];

// The approved board's words, and the case names the brief gives.
const CASES = [
  ['held-idle', 'held idle', 'Waiting for your reply'],
  ['job-no-turn', 'running a job with no turn', 'Background process running'],
  ['approval', 'waiting on an approval', 'Waiting for approval'],
  ['on-hold', 'on hold (queued, account paused)', 'On hold'],
  ['failed-turn', 'released by a failed turn', 'Failed'],
  ['ended', 'released by End (endReason ended)', 'Ended'],
  ['task-finished', 'task run finished (task_done, SUCCEEDED, task DONE)', 'Finished'],
  ['control-running', 'CONTROL, not one of the seven: a plain RUNNING turn, no approval', 'Running (statusLabel; "Starting" until the first event)'],
];
// The list row's line ends in an ellipsis where the row says the work goes on ("Background process running…").
const bare = (text) => (text ?? '').replace(/…$/, '');
const cell = (v) => (v === null ? 'null' : String(v));

const lines = [
  '# Session three-state: real-stack web walk',
  '',
  `Project tip 4f99cb45ff; real \`node build/main.js\` on a throwaway postgres:16, built console (\`vite build\`) served by \`vite preview\``,
  `with /api proxied to it, signed in through the real login form with Playwright 1.63 (Chromium). API read at ${api.at}.`,
  '',
  '| case | phase | released | lastTurnOutcome | waitingOn | endReason | workFinished | list = detail | list word (DOM) | header word (DOM) | glyph tooltip (DOM) | expected | match |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const [key, name, expected] of CASES) {
  const c = api.cases[key];
  const d = dom[key];
  const list = c.list.open?.fields ?? null;
  const detail = c.detail.fields;
  const same = list !== null && FIELDS.every((f) => list[f] === detail[f]);
  const listWord = d.rowLine;
  const headerWord = d.headerWord;
  const want = expected.split(' (')[0];
  const match = key === 'control-running'
    ? (bare(listWord) === 'Running' && headerWord === 'Running' ? 'yes' : 'NO')
    : (bare(listWord) === want && headerWord === want ? 'yes' : 'NO');
  lines.push(`| ${name} | ${FIELDS.map((f) => cell(detail[f])).join(' | ')} | ${list === null ? 'not listed' : same ? 'yes' : 'NO'} | ${listWord} | ${headerWord} | ${cell(d.glyphTooltip)} | ${expected} | ${match} |`);
}
lines.push(
  '',
  'Header word = the first part of the header line `.workspace-sub` (the full lines are in dom.json, e.g. `Failed · Open · 1h ago`).',
  'List word = the row line `.session-preview`. The failed row glyph tooltip shows the error text (`engine exited`) by design (WorkspaceView `failedTitle`).',
  '',
  '## The list row also sends `activity`',
  '',
  '| case | stored status | list row `activity` | detail `activity` | list `pendingApprovals` |',
  '|---|---|---|---|---|',
);
for (const [key, name] of CASES) {
  const c = api.cases[key];
  lines.push(`| ${name} | ${c.list.open?.legacy.status} | ${cell(c.list.open?.legacy.activity)} | ${cell(c.detail.legacy.activity)} | ${cell(c.list.open?.legacy.pendingApprovals)} |`);
}
lines.push(
  '',
  '## A/B: the same console and server, `activity` nulled on rows stored RUNNING (browser-side rewrite of `/api/sessions` and `/api/sessions/<id>` JSON only)',
  '',
  `Rows rewritten: ${ab.rewritten}.`,
  '',
  '| case | as served: list / header | approval card as served | activity nulled: list / header | approval card, activity nulled |',
  '|---|---|---|---|---|',
);
for (const key of ['control-running', 'approval']) {
  const d = dom[key];
  const r = ab.result[key];
  const card = (disabled, stale) => (disabled === null ? 'no card' : disabled ? `dead: Approve disabled, "${stale}"` : 'answerable: Approve enabled');
  lines.push(`| ${key} | ${d.rowLine} / ${d.headerSub.split(' · ')[0]} | ${card(d.approveButtonDisabled, d.approvalStaleNote)} | ${r.rowLine} / ${r.headerSub.split(' · ')[0]} | ${card(r.approveButtonDisabled, r.approvalStaleNote)} |`);
}
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
