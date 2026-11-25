// Renders display-table.md (the criterion's table) and surfaces.md (every other payload kind and surface) from the three
// client drivers' outputs, holds them to the approved board and the recorded groups, and exits non-zero on a difference
// that the lists of known differences below do not explain.
//   node make-display-table.mjs <tip checkout> <drivers out dir> <walk out dir> <out dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tip, drv, walkOut, outDir] = process.argv.slice(2).map((p) => resolve(p));
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const rules = await import(pathToFileURL(`${tip}/docs/mocks/session-display-three-states/capture/rules.mjs`));
const rows = read(`${drv}/rows.json`);
const CLIENTS = ['web', 'apple', 'android'];
const out = Object.fromEntries(CLIENTS.map((c) => [c, new Map(read(`${drv}/${c}.json`).map((r) => [r.id, r]))]));
const groups = {};
for (const side of ['tip', 'base']) {
  groups[side] = Object.fromEntries(CLIENTS.map((c) => [c, new Map(read(`${drv}/groups-${side}-${c}.json`).map((r) => [r.id, r]))]));
}
const baseline = Object.fromEntries(CLIENTS.map((c) => [c, read(new URL(`../legacy-baseline.${c}.json`, import.meta.url)).rows]));
const walk = read(`${walkOut}/walk.json`);

// The board's rule, with the owner's one change (2026-11-25): no Disconnected mark; that failure is Failed.
const MARKS = Object.keys(rules.MARKS).filter((m) => m !== 'DISCONNECTED').map((m) => rules.MARKS[m].word);
const expectOf = (p) => {
  const state = rules.sessionState(p);
  if (!state) return null;
  return { state: state.word, marks: rules.sessionMarks(p).map((m) => rules.MARKS[m === 'DISCONNECTED' ? 'FAILED' : m].word) };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failures = [];
// Differences the report explains, matched as narrowly as their cause: a failure above otherwise.
const explained = [];

// iPhone and Android list rows draw two marks at most, then "+N" (the board); Mac and web rows draw all of them.
const phoneOf = (marks) => (marks.length > 2 ? [...marks.slice(0, 2), `+${marks.length - 2}`] : marks);
const columns = (row) => {
  const w = out.web.get(row.id), a = out.apple.get(row.id), d = out.android.get(row.id);
  return {
    web: { state: w.state, drawn: w.marks },
    mac: { state: a.state, drawn: a.marks },
    iphone: { state: a.state, drawn: a.phoneMarks ?? null },
    android: { state: d.state, drawn: d.phoneMarks ?? null, all: d.marks },
  };
};

// ---- table 1: one row per case, the list row's payload ----
const cases = [
  ...rows.filter((r) => r.kind === 'fixture' && r.newFields).map((r) => ({ ...r, label: `F${r.id.split(' ')[1]} ${r.name}` })),
  ...rows.filter((r) => r.kind === 'listRow').map((r) => ({ ...r, label: `S ${r.name}` })),
];
const t1 = [];
const COLS = ['web', 'mac', 'iphone', 'android'];
const NAME = { web: 'web', mac: 'Mac', iphone: 'iPhone', android: 'Android' };
const head = ['case', 'board: state', 'board: marks', ...COLS.map((c) => `state ${NAME[c]}`),
  ...MARKS.flatMap((m) => COLS.map((c) => `${m} ${NAME[c]}`)), 'agree'];
t1.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
for (const row of cases) {
  const e = expectOf(row.payload);
  const c = columns(row);
  const cell = (col, mark) => {
    const x = c[col];
    if (x.drawn?.includes(mark)) return 'yes';
    // A phone row's third mark is counted in "+N" and drawn on the header and the task panel.
    if ((col === 'iphone' || col === 'android') && e.marks.includes(mark) && x.drawn?.some((v) => /^\+\d+$/.test(v))) return '+N';
    return '-';
  };
  const ok = e && COLS.every((col) => c[col].state === e.state) && same(c.web.drawn, e.marks) && same(c.mac.drawn, e.marks)
    && same(c.iphone.drawn, phoneOf(e.marks)) && same(c.android.drawn, phoneOf(e.marks)) && same(c.android.all, e.marks);
  if (!ok) failures.push(`table 1: ${row.label}: board ${JSON.stringify(e)}, drawn ${JSON.stringify(c)}`);
  t1.push(`| ${[row.label, e.state, e.marks.join(', ') || '-', ...COLS.map((col) => c[col].state ?? '(legacy)'),
    ...MARKS.flatMap((m) => COLS.map((col) => cell(col, m))), ok ? 'yes' : '**NO**'].join(' | ')} |`);
}

// ---- older server: facts absent, every client draws what it drew before (existing differences stay) ----
const t2 = ['| case (facts absent) | state word: web / Apple / Android | task-run label: web / Apple / Android | marks (all three) | equals legacy baseline: web / Apple / Android |',
  '|---|---|---|---|---|'];
rows.filter((r) => r.kind === 'fixture' && !r.newFields).forEach((r, i) => {
  const got = CLIENTS.map((c) => out[c].get(r.id));
  const marks = got.every((g) => g.marks === null && g.state === null) ? 'none (both functions answer null)' : JSON.stringify(got.map((g) => g.marks));
  const words = [got[0].surfaces.header, got[1].surfaces.header, got[2].surfaces.header];
  const runs = [got[0].surfaces.runBadge, got[1].surfaces.runBadge, got[2].surfaces.runBadge];
  const eq = CLIENTS.map((c, k) => {
    const b = baseline[c][i];
    return b.name === r.name && words[k] === b.word && runs[k] === b.runBadge;
  });
  if (!eq.every(Boolean) || !marks.startsWith('none')) failures.push(`older server: ${r.name}: ${JSON.stringify({ words, runs, eq, marks })}`);
  t2.push(`| ${r.name} | ${words.join(' / ')} | ${runs.join(' / ')} | ${marks} | ${eq.map((x) => (x ? 'yes' : '**NO**')).join(' / ')} |`);
});

// ---- groups ----
const yn = (g) => `${g.needsYou ? 'Needs you' : ''}${g.needsYou && g.working ? '+' : ''}${g.working ? 'Working' : ''}` || '-';
const gk = (g) => ({ needsYou: g.needsYou, working: g.working });
const t3 = ['| row | web: tip / before | Apple: tip / before | Android: tip / before | unchanged |', '|---|---|---|---|---|'];
for (const r of rows.filter((x) => x.kind === 'fixture' || x.kind === 'listRow')) {
  const cells = CLIENTS.map((c) => [groups.tip[c].get(r.id), groups.base[c].get(r.id)]);
  const eq = cells.every(([a, b]) => same(gk(a), gk(b)));
  if (!eq) failures.push(`groups: ${r.id}: ${JSON.stringify(cells)}`);
  const label = r.kind === 'fixture' ? `F${r.id.split(' ')[1]} ${r.name} (${r.newFields ? 'facts' : 'no facts'})` : `S ${r.name}`;
  t3.push(`| ${label} | ${cells.map(([a, b]) => `${yn(a)} / ${yn(b)}`).join(' | ')} | ${eq ? 'yes' : '**NO**'} |`);
}
// The recorded groups (legacy-baseline.*.json), row by row, on the rows they were recorded on.
const absent = rows.filter((r) => r.kind === 'fixture' && !r.newFields);
const recorded = CLIENTS.map((c) => absent.filter((r, i) => !same(gk(groups.tip[c].get(r.id)), { needsYou: baseline[c][i].needsYouGroup, working: baseline[c][i].workingGroup })));
recorded.forEach((bad, k) => bad.forEach((r) => failures.push(`recorded group differs: ${CLIENTS[k]} ${r.name}`)));
// Where a row with facts sits in another group than the same case recorded without them (pre-existing: `before` equals it).
const moved = [];
for (const r of rows.filter((x) => x.kind === 'fixture' && x.newFields)) {
  const i = Number(r.id.split(' ')[1]);
  CLIENTS.forEach((c) => {
    const rec = baseline[c][(i + 1) / 2 - 1];
    const now = groups.tip[c].get(r.id);
    const was = groups.base[c].get(r.id);
    if (!same(gk(now), { needsYou: rec.needsYouGroup, working: rec.workingGroup })) {
      moved.push(`| F${i} ${r.name} | ${c} | ${yn(now)} | ${yn(was)} | ${yn({ needsYou: rec.needsYouGroup, working: rec.workingGroup })} |`);
    }
  });
}

// ---- table 4: the two functions on every payload kind the server sends, and each surface's words ----
const KINDS = ['listRow', 'detail', 'sessionSummary', 'sessionEnded', 'linkPreview', 'guestRow', 'sharedHead', 'taskRun', 'searchHit'];
const t4 = ['| case | payload kind | state: web / Apple / Android | marks: web / Apple / Android | same as the list row | clients agree |', '|---|---|---|---|---|---|'];
const kindGaps = new Map();
const kindApple = new Map();
for (const r of rows.filter((x) => KINDS.includes(x.kind))) {
  const got = CLIENTS.map((c) => out[c].get(r.id));
  got.forEach((g, k) => { if (g.error) failures.push(`driver error: ${CLIENTS[k]} ${r.id}: ${g.error}`); });
  const list = out.web.get(`${r.name}|listRow`);
  const listE = list ? { state: list.state, marks: list.marks } : null;
  // The functions each client applies to this payload (null: legacy reading, or a surface that does not call them).
  const read = got.map((g) => (g.marks === undefined ? undefined : { state: g.state, marks: g.marks }));
  const present = read.filter((x) => x !== undefined);
  const agree = present.every((x) => same(x, present[0]));
  // Apple only, Background only: three Apple types do not hand their two functions `runningBgCount`
  // (`SessionSearchHit`, `SessionRef`, `ControlSessionSummary`), so a mark that rests on it is missing there.
  const appleBackground = !agree && ['searchHit', 'taskRun', 'sessionSummary'].includes(r.kind) && read[0] && read[1]
    && (read[2] === undefined || same(read[2], read[0]))
    && read[1].state === read[0].state && same(read[1].marks, read[0].marks.filter((m) => m !== 'Background'));
  if (appleBackground) explained.push(`${r.id}: Apple omits Background`);
  else if (!agree) failures.push(`clients disagree on ${r.id}: ${JSON.stringify(read)}`);
  const w = read[0];
  const equalsList = !w || !listE ? '-' : same(w, listE) ? 'yes' : '**no**';
  if (equalsList === '**no**') {
    const missing = listE.marks?.filter((m) => !w.marks?.includes(m)) ?? [];
    const extra = w.marks?.filter((m) => !listE.marks?.includes(m)) ?? [];
    const key = `${r.kind}|${w.state === null ? 'no facts on the payload' : `missing ${missing.join(', ') || '-'}; extra ${extra.join(', ') || '-'}`}`;
    kindGaps.set(key, [...(kindGaps.get(key) ?? []), r.name]);
  }
  if (appleBackground) kindApple.set(r.kind, [...(kindApple.get(r.kind) ?? []), r.name]);
  const show = (f) => read.map((x, k) => (x === undefined ? (got[k].notRead ? `n/a (${got[k].notRead})` : 'n/a') : f(x))).join(' / ');
  t4.push(`| ${r.name} | ${r.kind} | ${show((x) => x.state ?? '(legacy)')} | ${show((x) => (x.marks ? x.marks.join(', ') || 'none' : '(legacy)'))} | ${equalsList} | ${agree ? 'yes' : '**NO**'} |`);
}
const t5 = ['| case | payload kind | surface | web | Apple | Android |', '|---|---|---|---|---|---|'];
for (const r of rows.filter((x) => KINDS.includes(x.kind))) {
  const got = CLIENTS.map((c) => out[c].get(r.id));
  const names = [...new Set(got.flatMap((g) => Object.keys(g.surfaces ?? {})))];
  for (const s of names) t5.push(`| ${r.name} | ${r.kind} | ${s} | ${got.map((g) => g.surfaces?.[s] ?? 'n/a').join(' | ')} |`);
}

// ---- table 1b: search, Shared with me and the shared / guest head, as each client draws them ----
// Web is what the console drew in the real-stack walk; Apple and Android are what their view code is handed
// (AppleDisplayTests, AndroidDisplayTest). The expected state and marks are the list row's: one case, one answer.
const SURFACES = { search: 'searchHit', sharedWithMe: 'guestRow', sharedHead: 'sharedHead' };
const webDrawn = (name, surface) => {
  const c = walk.cases[name];
  if (!c || c.missing) return null;
  if (surface === 'search') return c.search ? { state: c.search.word, marks: c.search.marks } : null;
  if (surface === 'sharedWithMe') {
    if (!c.guestRowText) return null;
    const parts = c.guestRowText.split(' · ').slice(1);
    return { state: parts[0], marks: parts.slice(1).filter((m) => m !== 'Completed') };
  }
  const a = c.sharedPage, b = c.guestPage;
  if (!a || !b) return null;
  // The public page and the signed-in guest page draw one component: both must say the same.
  if (!same(a, b)) failures.push(`web shared page and guest page differ on ${name}: ${JSON.stringify([a, b])}`);
  return { state: a.word, marks: a.marks };
};
const head1b = ['case', 'surface', 'board: state', 'board: marks', ...COLS.map((c) => `state ${NAME[c]}`),
  ...MARKS.flatMap((m) => COLS.map((c) => `${m} ${NAME[c]}`)), 'agree'];
const t1b = [`| ${head1b.join(' | ')} |`, `|${head1b.map(() => '---').join('|')}|`];
const surfaceDiffs = new Map();
let surfaceRows = 0;
for (const r of rows.filter((x) => x.kind === 'listRow')) {
  const e = expectOf(r.payload);
  for (const [surface, kind] of Object.entries(SURFACES)) {
    const id = `${r.name}|${kind}`;
    if (!out.apple.get(id)) continue; // search never answers the settled landing
    surfaceRows += 1;
    const apple = out.apple.get(id).drawn?.[surface] ?? null;
    const android = out.android.get(id).drawn?.[surface] ?? null;
    const drawn = { web: webDrawn(r.name, surface), mac: apple, iphone: apple, android };
    const bad = COLS.filter((c) => drawn[c] && !(drawn[c].state === e.state && same(drawn[c].marks, e.marks)));
    for (const c of bad) {
      const missing = e.marks.filter((m) => !drawn[c].marks.includes(m));
      const what = drawn[c].state !== e.state ? 'another state word' : `marks missing: ${missing.join(', ') || '-'}`;
      const key = `${surface}|${c}|${what}`;
      surfaceDiffs.set(key, [...(surfaceDiffs.get(key) ?? []), `${r.name} (${drawn[c].state}${drawn[c].marks.length ? ` · ${drawn[c].marks.join(' · ')}` : ''})`]);
    }
    for (const c of COLS) if (!drawn[c] && !(c === 'web' && walk.cases[r.name]?.missing)) failures.push(`surface table: nothing read for ${c} ${surface} ${r.name}`);
    t1b.push(`| ${[r.name, surface, e.state, e.marks.join(', ') || '-', ...COLS.map((c) => drawn[c]?.state ?? 'n/a'),
      ...MARKS.flatMap((m) => COLS.map((c) => (!drawn[c] ? 'n/a' : drawn[c].marks.includes(m) ? 'yes' : '-'))),
      bad.length ? '**NO**' : 'yes'].join(' | ')} |`);
  }
}
const t1bSummary = ['| surface | client | difference | cases (what it drew) |', '|---|---|---|---|',
  ...[...surfaceDiffs].map(([k, v]) => { const [s, c, w] = k.split('|'); return `| ${s} | ${NAME[c]} | ${w} | ${v.length}: ${v.join('; ')} |`; })];
if (!surfaceDiffs.size) t1bSummary.push('| none | | | |');

writeFileSync(`${outDir}/display-table.md`, [
  '# Cross-client display: web, Mac, iPhone, Android', '',
  'Generated by `make-display-table.mjs`; do not edit. F = a row of `../fixture.json` (facts present); S = a payload the tip’s',
  'server built from a seeded row on a real PostgreSQL (`server-payloads.cjs`). The board is',
  '`docs/mocks/session-display-three-states/capture/rules.mjs` with the owner’s change (no Disconnected mark). `yes` = the client',
  'shows that mark; `+N` = counted in a phone row’s “+N”; `-` = not shown. Columns are what each client’s list row draws:',
  'web and Mac all marks, iPhone and Android two and “+N” (Mac and iPhone share OrbitKit; see the report).', '',
  '## 1. State and each mark, per client', '', ...t1, '',
  '## 1b. Search, Shared with me and the shared / guest head', '',
  `${surfaceRows} rows (23 server cases × 3 surfaces; search never answers the settled landing, and the session list has no web row for it:`,
  '`n/a`). Web is the walk’s DOM; Apple and Android are what their views are handed. Expected is the case’s list-row answer.', '',
  ...t1bSummary, '', ...t1b, '',
  '## 2. Older server (facts absent): drawn as before', '', ...t2, '',
  '## 3. Needs you / Working membership: tip against the commit before the display change (cf06a12e75)', '', ...t3, '',
  `Recorded groups (legacy-baseline.*.json, rows without facts): ${CLIENTS.map((c, k) => `${c} ${absent.length - recorded[k].length}/${absent.length} equal`).join(', ')}.`, '',
  'Rows with the facts whose group differs from the same case’s recorded (facts-absent) group. Each equals the “before” column, so',
  'the difference is how that client already read the facts, not something this project changed:', '',
  '| row | client | tip | before the change | recorded without facts |', '|---|---|---|---|---|', ...(moved.length ? moved : ['| none | | | | |']), '',
].join('\n'));
writeFileSync(`${outDir}/surfaces.md`, [
  '# Every payload kind and surface', '', 'Generated by `make-display-table.mjs`; do not edit.', '',
  '## The two functions on each payload kind (server-built)', '', ...t4, '',
  '## Payload kinds that draw differently from the list row', '',
  '| payload kind | difference | cases |', '|---|---|---|',
  ...[...kindGaps].map(([k, v]) => `| ${k.split('|')[0]} | ${k.split('|')[1]} | ${v.join('; ')} |`), '',
  '## Apple differs from web: Background missing', '', '| payload kind | cases |', '|---|---|',
  ...(kindApple.size ? [...kindApple].map(([k, v]) => `| ${k} | ${v.join('; ')} |`) : ['| none | |']), '',
  '## Words each surface writes', '', ...t5, '',
].join('\n'));
console.log(`table 1: ${cases.length} cases; groups: ${rows.filter((x) => x.kind === 'fixture' || x.kind === 'listRow').length} rows; walk surfaces ${JSON.stringify(walk.checked)}`);
console.log(`moved (pre-existing) groups: ${moved.length}`);
for (const [k, v] of kindGaps) console.log(`kind gap ${k}: ${v.length} cases`);
for (const [k, v] of surfaceDiffs) console.log(`surface difference ${k}: ${v.length} cases`);
console.log(`surface table: ${surfaceRows} rows, ${surfaceDiffs.size} kinds of difference; explained per-kind readings: ${explained.length}`);
for (const [k, v] of kindApple) console.log(`Apple omits Background on ${k}: ${v.join('; ')}`);
console.log(failures.length ? `FAILURES ${failures.length}:\n${failures.join('\n')}` : 'no unexplained disagreement in tables 1-3 and the per-kind function readings (table 1b differences are listed above)');
process.exit(failures.length ? 1 : 0);
