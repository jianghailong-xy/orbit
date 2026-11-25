// The fix walk's table: per case, the list row's payload fields (phase / released / activity / status / waitingOn),
// the word the console showed (row line / header word), whether Stop was offered, whether the card's Approve was
// enabled, what was expected, and whether it matched; then the task panel's run badges and the Approve presses.
// usage: node make-table-fix.mjs <walk run dir> <out.md>
//   <walk run dir> holds api-before-press.json, run2/dom.json, task/task.json, ab/ab.json and approve2/approve-*.json.
import fs from 'node:fs';
import path from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: make-table-fix.mjs <walk run dir> <out.md>');
const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));
const api = read('api-before-press.json');
const dom = read('run2/dom.json');
const task = read('task/task.json').result;
const ab = read('ab/ab.json');
const presses = Object.fromEntries(['approval', 'running-started'].map((k) => [k, read(`approve2/approve-${k}.json`)]));

const cell = (v) => (v === null || v === undefined ? 'null' : v === '<absent>' ? '—' : String(v));
const fieldsOf = (c) => {
  const row = c.list.open;
  return [row.fields.phase, row.fields.released, row.legacy.activity, row.legacy.status, row.fields.waitingOn].map(cell).join(' / ');
};
const bare = (t) => (t ?? '').replace(/…$/, '');

// [case key, name, expected word(s), expected Stop (true/false/null for not asked), approval expected enabled]
const CASES = [
  ['running-started', '(1) plain running turn, engine started', ['Running'], true, null],
  ['control-running', '(1b) plain running turn, engine not started yet (the F7 control)', ['Starting'], true, null],
  ['approval', '(2) running turn with a pending approval card', ['Waiting for approval'], true, true],
  ['job-no-turn', '(3) background job only, no turn', ['Background process running'], null, null],
  ['on-hold', '(4) queued, on hold (paused account)', ['On hold'], null, null],
  ['held-idle', '(5) parked plain', ['Waiting for your reply'], false, null],
  ['failed-turn', 'F7: released by a failed turn', ['Failed'], null, null],
  ['ended', 'F7: released by End', ['Ended'], null, null],
  ['task-finished', 'F7: task run finished', ['Finished'], null, null],
];

const lines = [
  '# Session three-state: real-stack web walk of the fix (e95ff30f32) against the tip apiserver (4f99cb45ff)',
  '',
  'The console was built from /tmp/p3/fix (`vite build`, bundle index-DxmZ38gC.js) and served by `vite preview` with /api proxied to',
  'the unchanged tip `node build/main.js` on a throwaway postgres:16. The owner was made through the real bootstrap and signed in',
  'through the console\'s login form (Playwright 1.63, Chromium). Payload fields are from the list row (`GET /api/sessions`); the',
  'six three-state fields were the same on `GET /api/sessions/:id` for every case, which carries no `activity`.',
  '',
  '| case | payload: phase / released / activity / status / waitingOn | word shown: row / header | row glyph | Stop visible | Approve enabled | expected | match |',
  '|---|---|---|---|---|---|---|---|',
];
for (const [key, name, words, stop, approve] of CASES) {
  const c = api.cases[key];
  const d = dom[key];
  const glyph = (d.rowGlyph ?? '').replace(/\banticon\b ?/, '').replace(/anticon-/g, '');
  const wordOk = words.includes(bare(d.rowLine)) && words.includes(d.headerWord);
  const stopOk = stop === null || d.stopVisible === stop;
  const approveOk = approve === null || d.approveButtonDisabled === !approve;
  const expectParts = [`"${words.join('" or "')}"`];
  if (stop !== null) expectParts.push(stop ? 'Stop shown' : 'no Stop');
  if (approve) expectParts.push('Approve enabled');
  if (key === 'job-no-turn') expectParts.push('terminal glyph, no spinner');
  const glyphOk = key !== 'job-no-turn' || (!d.rowSpinner && glyph.includes('code'));
  lines.push(`| ${name} | ${fieldsOf(c)} | ${d.rowLine} / ${d.headerWord} | ${glyph}${d.rowSpinner ? ' (spinning)' : ''} | ${d.stopVisible ? 'yes' : 'no'} | ${d.approveButtonDisabled === null ? 'no card' : d.approveButtonDisabled ? 'NO (disabled)' : 'yes'} | ${expectParts.join(', ')} | ${wordOk && stopOk && approveOk && glyphOk ? 'yes' : 'NO'} |`);
}

lines.push(
  '',
  '## (6) The task panel\'s run badges (`/tasks/<id>`, TaskDetailPanel `a.tdp-session .tdp-badge`)',
  '',
  'One task (IN_PROGRESS, reopened) with two runs. The badge reads the task detail\'s `sessions`, so both payloads are shown.',
  '',
  '| run | task detail `sessions[]`: status / runState / endReason / phase / waitingOn / activity / queuedReason | the run\'s own list row: phase / released / activity / status / waitingOn | badge shown | expected | match |',
  '|---|---|---|---|---|---|',
);
for (const [runKey, expected] of [['finished', 'Finished'], ['on-hold', 'On hold']]) {
  const t = api.tasks['two-runs'];
  const run = t.runs[runKey];
  const td = run.taskDetail;
  const badge = task['two-runs'].runs[runKey]?.badge ?? null;
  lines.push(`| ${runKey} run | ${[td.status, td.runState, td.endReason, td.phase, td.waitingOn, td.activity, td.queuedReason].map(cell).join(' / ')} | ${fieldsOf(run)} | ${cell(badge)} | ${expected} | ${badge === expected ? 'yes' : 'NO'} |`);
}
lines.push('', '`—` = the key is absent from the payload.');

lines.push(
  '',
  '## (2) Pressing Approve in the console',
  '',
  'No engine runs in this rig, so nothing consumes the decision: "the run continues" is the session staying a running turn,',
  'with Stop offered, once the card is answered.',
  '',
  '| session | before: word / Stop / Approve | decision request | approval after (API) | session after (API): phase / status / waitingOn / pendingApprovals | word changed after | after: word (row / header) / Stop |',
  '|---|---|---|---|---|---|---|',
);
for (const [k, p] of Object.entries(presses)) {
  const b = p.before;
  const a = p.after;
  const decision = p.requests.map((r) => `POST …/approvals/…/decision → ${r.status}`).join(', ');
  const approvalsAfter = p.apiAfter.approvals.map((x) => x.status).join(', ');
  const s = p.apiAfter.detail;
  lines.push(`| ${k} | ${b.headerSub.split(' · ')[0]} / ${b.stopVisible ? 'Stop' : 'no Stop'} / ${b.approveButton?.disabled === false ? 'enabled' : 'NOT enabled'} | ${decision} | ${approvalsAfter} | ${s.phase} / ${s.status} / ${cell(s.waitingOn)} / ${p.apiAfter.listRow.pendingApprovals} | ${p.wordChangedAfterMs === null ? 'NOT within 30 s' : `${p.wordChangedAfterMs} ms`} | ${a.rowLine} / ${a.headerSub.split(' · ')[0]} / ${a.stopVisible ? 'Stop' : 'no Stop'} |`);
}

lines.push(
  '',
  '## A/B: `activity` nulled on rows stored RUNNING (browser-side rewrite of the list and detail JSON), same fix console',
  '',
  `Rows rewritten: ${ab.rewritten}.`,
  '',
  '| case | as served: row / header, Approve | activity nulled: row / header, Approve |',
  '|---|---|---|',
);
for (const key of ['control-running', 'approval']) {
  const d = dom[key];
  const r = ab.result[key];
  const ap = (v) => (v === null ? 'no card' : v ? 'disabled' : 'enabled');
  lines.push(`| ${key} | ${d.rowLine} / ${d.headerWord}, ${ap(d.approveButtonDisabled)} | ${r.rowLine} / ${r.headerSub.split(' · ')[0]}, ${ap(r.approveButtonDisabled)} |`);
}
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
