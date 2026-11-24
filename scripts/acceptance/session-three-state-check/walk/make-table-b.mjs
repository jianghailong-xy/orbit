// Round B's table (the merged project tip, console and apiserver both from it): per case, the list row's payload fields
// (phase / released / activity / status / waitingOn), the words the console showed (row line / header word), the list
// group the row sits in, the row glyph, Stop, the card's Approve, what was expected and whether it matched; then the task
// panel's run badges beside the six session facts GET /api/tasks/:id sends for each run, with the held run's JSON quoted.
// usage: node make-table-b.mjs <walk dir> <out.md>   (<walk dir> holds api.json, run/dom.json and task/task.json)
import fs from 'node:fs';
import path from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: make-table-b.mjs <walk dir> <out.md>');
const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));
const api = read('api.json');
const dom = read('run/dom.json');
const task = read('task/task.json').result;

const cell = (v) => (v === null || v === undefined ? 'null' : v === '<absent>' ? '—' : String(v));
const bare = (t) => (t ?? '').replace(/…$/, '');
const fieldsOf = (c) => {
  const row = c.list.open;
  return [row.fields.phase, row.fields.released, row.legacy.activity, row.legacy.status, row.fields.waitingOn].map(cell).join(' / ');
};

// [case key, name, expected words, expected Stop (null: not asked), Approve expected enabled, expected group (null: not asked)]
const CASES = [
  ['running-started', '(1) plain running turn', ['Running'], true, null, null],
  ['approval', '(2) running turn with a pending approval', ['Waiting for approval'], null, true, null],
  ['job-no-turn', '(3) parked, only a background job', ['Background process running'], null, null, 'Working'],
  ['held-idle', '(5) parked plain', ['Waiting for your reply'], false, null, null],
  ['failed-turn', '(6) released by a failed turn', ['Failed'], null, null, null],
  ['ended', '(6) released by End', ['Ended'], null, null, null],
  ['on-hold', 'extra: queued session on hold', ['On hold'], null, null, null],
  ['task-finished', 'extra: task run finished', ['Finished'], null, null, null],
  ['control-running', 'extra: running turn, engine not started yet', ['Starting'], true, null, null],
];

const lines = [
  '# Session three-state, round B: the merged project tip (941551f956), console and apiserver both from it',
  '',
  'Real PostgreSQL 16 (throwaway container) and the real `node build/main.js` of /tmp/p3/tip. The console is /tmp/p3/tip\'s own',
  '`vite build` (bundle index-BVCrbt5_.js), served by `vite preview` with /api proxied to that apiserver, signed in through the',
  'login form with Playwright 1.63 (Chromium). Every payload below is the server\'s own answer; no payload was written or',
  'rewritten by hand (the rows behind them are Prisma writes shaped like the payloads fixture\'s `buildWorld`).',
  '',
  '| case | payload (list row): phase / released / activity / status / waitingOn | word: row / header | list group | row glyph | Stop | Approve | expected | match |',
  '|---|---|---|---|---|---|---|---|---|',
];
for (const [key, name, words, stop, approve, group] of CASES) {
  const c = api.cases[key];
  const d = dom[key];
  const glyph = (d.rowGlyph ?? '').replace(/\banticon\b ?/, '').replace(/anticon-/g, '');
  const ok = words.includes(bare(d.rowLine)) && words.includes(d.headerWord)
    && (stop === null || d.stopVisible === stop)
    && (approve === null || d.approveButtonDisabled === !approve)
    && (group === null || d.rowSection === group)
    && (key !== 'job-no-turn' || (!d.rowSpinner && glyph.includes('code')));
  const expect = [`"${words[0]}"`];
  if (stop !== null) expect.push(stop ? 'Stop shown' : 'no Stop');
  if (approve) expect.push('Approve enabled');
  if (group) expect.push(`under ${group}`);
  if (key === 'job-no-turn') expect.push('terminal glyph, no spinner');
  lines.push(`| ${name} | ${fieldsOf(c)} | ${d.rowLine} / ${d.headerWord} | ${cell(d.rowSection)} | ${glyph}${d.rowSpinner ? ' (spinning)' : ''} | ${d.stopVisible ? 'yes' : 'no'} | ${d.approveButtonDisabled === null ? 'no card' : d.approveButtonDisabled ? 'disabled' : 'enabled'} | ${expect.join(', ')} | ${ok ? 'yes' : 'NO'} |`);
}

const t = api.tasks['two-runs'];
lines.push(
  '',
  `## (4) The task panel (/tasks/${t.publicId}): one IN_PROGRESS task, a finished run and a held queued run`,
  '',
  '| run | GET /api/tasks/:id `sessions[]`: phase / released / lastTurnOutcome / waitingOn / endReason / workFinished (status, runState) | badge in the panel | expected | match |',
  '|---|---|---|---|---|',
);
for (const [runKey, expected] of [['on-hold', 'On hold'], ['finished', 'Finished']]) {
  const raw = t.runs[runKey].taskDetailRaw;
  const six = ['phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished'].map((k) => cell(k in raw ? raw[k] : '<absent>')).join(' / ');
  const badge = task['two-runs'].runs[runKey]?.badge ?? null;
  lines.push(`| ${runKey === 'on-hold' ? 'held queued run' : 'finished run'} | ${six} (${raw.status}, ${raw.runState}) | ${cell(badge)} | ${expected} | ${badge === expected ? 'yes' : 'NO'} |`);
}
lines.push(
  '',
  'The held run in `GET /api/tasks/:id` `sessions[]`, as the server answered it:',
  '',
  '```json',
  JSON.stringify(t.runs['on-hold'].taskDetailRaw, null, 2),
  '```',
);
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
