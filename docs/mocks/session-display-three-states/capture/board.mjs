// Writes <client>.html for the board and renders it to ../<client>.png:
//   node capture/board.mjs web|mac|iphone|android|all
// Before: capture/web-rows.json (web, from the web's own functions) or capture/native-before.json (Apple, Android,
// read from source). After: capture/rules.mjs, the same two functions for every client.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon } from './icons.mjs';
import { sessionState, sessionMarks, MARKS, STATES, BOARD_CASES } from './rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..');
const fixture = JSON.parse(readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
const byRow = new Map(fixture.map((r) => [r.row, r]));

// Titles a reader can picture, one per fixture case (the case name stays beside it).
const TITLES = {
  1: 'Translate the help pages', 3: 'Fix the login redirect', 5: 'Tidy the settings page', 7: 'Sketch the onboarding flow',
  9: 'Task: Add the export button', 11: 'Upgrade the date library', 13: 'Draft the release notes', 15: 'Run the full test suite',
  17: 'Clean up old branches', 19: 'Index the wiki', 21: 'Profile the slow query', 23: 'Rename the CLI flags',
  25: 'Review the API errors', 27: 'Nightly build report', 29: 'Split the settings module', 31: 'Watch the nightly build',
  33: 'Old runner session', 35: 'Old runner session (released)',
};
const LINES = {
  1: 'Queued', 3: 'Running Bash…', 5: 'Done: the three toggles now share one…', 7: 'You: Add a step for the invite.',
  9: 'The export button is in, with its test.', 11: 'You: Upgrade it and run the tests.', 13: 'The notes are in docs/releases.',
  15: 'Background process running…', 17: 'Waiting for approval', 19: 'On hold', 21: 'The slow part is the join on tags.',
  23: 'Renamed, and the old names still work.', 25: 'You: Check the 4xx mapping.', 27: 'Running Read…', 29: 'Running Agent…',
  31: 'Resumes when the build finishes', 33: 'The cache is warm now.', 35: 'The cache is warm now.',
};
const TIMES = ['now', '1m', '2m', '4m', '6m', '9m', '15m', '22m', '30m', '36m', '45m', '50m', '1h', '2h', '3h', '5h', '1d', '2d'];

// Per-client look: palette, font, and the words of its surfaces.
const CLIENTS = {
  web: {
    name: 'Web', font: '"Liberation Sans", "DejaVu Sans", sans-serif', layout: 'desktop',
    tone: { blue: '#2563eb', grey: '#98a2b3', amber: '#d97706', red: '#dc2626', green: '#16a34a', queued: '#b6bcc6' },
    surfaces: [
      ['header', 'Session header (statusLabel)'],
      ['run', 'Task panel run badge (sessionStatusMeta)'],
      ['link', 'Link card (orbitLinkStateWord)'],
      ['share', 'Shared / guest page header (sessionStateWord)'],
      ['md', 'Task Markdown, Runs line'],
    ],
    taskStrip: true,
  },
  mac: {
    name: 'Mac', font: '"Liberation Sans", "Nimbus Sans", sans-serif', layout: 'desktop',
    tone: { blue: '#007aff', grey: '#8e8e93', amber: '#ff9500', red: '#ff3b30', green: '#34c759', queued: '#aeaeb2' },
  },
  iphone: {
    name: 'iPhone', font: '"Liberation Sans", "Nimbus Sans", sans-serif', layout: 'phone',
    tone: { blue: '#007aff', grey: '#8e8e93', amber: '#ff9500', red: '#ff3b30', green: '#34c759', queued: '#aeaeb2' },
  },
  android: {
    name: 'Android', font: '"Liberation Sans", "DejaVu Sans", sans-serif', layout: 'phone',
    tone: { blue: '#3367d6', grey: '#80868b', amber: '#e37400', red: '#d93025', green: '#188038', queued: '#9aa0a6' },
  },
};

// ---- before data ----------------------------------------------------------------------------------------------
const WEB_TONE = { brand: 'blue', 'text-3': 'grey', 'scrollbar-hover': 'queued', 'warning-solid': 'amber', error: 'red', 'success-solid': 'green' };
const WEB_BADGE_TONE = { muted: 'grey', blue: 'blue', green: 'green', red: 'red', amber: 'amber' };
function webGlyph(g) {
  const m = /^([a-z-]+)( spin| breathing)? \(([a-z0-9-]+)\)$/.exec(g);
  const [, name, motion, tok] = m;
  const tone = WEB_TONE[tok] ?? 'grey';
  const map = {
    'clock-circle': 'clock', loading: 'spinner', message: 'message', 'minus-circle': 'minus-circle', eye: 'eye', code: 'terminal',
    'pause-circle': 'pause-circle', 'close-circle': 'close-circle-filled', disconnect: 'unplug',
    'check-circle': tok === 'success-solid' ? 'check-circle-filled' : 'check-circle',
  };
  return { icon: map[name] ?? 'circle', tone, motion: motion?.trim() ?? null };
}
const parseTagged = (s) => {
  const m = /^(.*) \[([a-z]+)\]$/.exec(s);
  return m ? { word: m[1], tone: m[2] } : { word: s, tone: 'preview' };
};
function webBefore() {
  const rows = JSON.parse(readFileSync(path.join(here, 'web-rows.json'), 'utf8'));
  const out = new Map();
  for (const r of rows) {
    const b = r.before;
    const g = webGlyph(b.rowGlyph);
    const line = parseTagged(b.rowLine);
    const badge = parseTagged(b.runBadge);
    out.set(r.row, {
      list: { ...g, line: line.word, lineTone: line.tone },
      header: { ...g, word: b.header },
      run: { word: badge.word, tone: WEB_BADGE_TONE[badge.tone] ?? 'grey' },
      link: { ...g, word: b.linkCard },
      share: { word: b.sharedHeader },
      md: { word: badge.word },
      pill: { word: b.tasksPill },
      group: b.group,
      groupAfter: typeof r.after === 'object' ? r.after.group : b.group,
    });
  }
  return out;
}
function nativeBefore(client) {
  const all = JSON.parse(readFileSync(path.join(here, 'native-before.json'), 'utf8'));
  const c = all[client];
  CLIENTS[client].surfaces = c.surfaces;
  CLIENTS[client].listNote = c.listNote;
  CLIENTS[client].taskStrip = !!c.taskStrip;
  return new Map(c.rows.map((r) => [r.row, r]));
}

// ---- drawing --------------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function drawIcon(c, g, size = 16) {
  if (!g || !g.icon || g.icon === 'none') return '<span class="ic-none"></span>';
  const color = c.tone[g.tone] ?? c.tone.grey;
  const cls = g.motion === 'spin' ? 'spin' : g.motion === 'breathing' ? 'breathe' : '';
  return `<span class="g ${cls}">${icon(g.icon, color, size)}</span>`;
}
// Phones draw the spinner in the muted tone, as today (iOS SessionLiveIndicator, Android RowSpinner); web and Mac in blue.
function stateGlyph(c, p) {
  const s = sessionState(p);
  const running = c.layout === 'phone' ? 'grey' : 'blue';
  return { icon: s.icon, tone: s.phase === 'RUNNING' ? running : s.phase === 'PENDING' ? 'queued' : 'grey', motion: s.phase === 'RUNNING' ? 'spin' : null };
}
function chip(c, key, { compact = false } = {}) {
  const m = MARKS[key];
  const color = c.tone[m.tone];
  return `<span class="chip tone-${m.tone}${compact ? ' compact' : ''}" style="--c:${color}">${icon(m.icon, color, 12)}<span>${m.word}</span></span>`;
}
const chips = (c, marks, max) => {
  const shown = max ? marks.slice(0, max) : marks;
  const more = max && marks.length > max ? `<span class="chip more">+${marks.length - max}</span>` : '';
  return shown.map((k) => chip(c, k, { compact: !!max })).join('') + more;
};

function afterHeader(c, p) {
  const s = sessionState(p);
  const filed = p.lifecycleState === 'COMPLETED' ? '<span class="filed">Completed</span>' : '';
  return `<span class="hdr">${drawIcon(c, stateGlyph(c, p))}<b>${s.word}</b>${chips(c, sessionMarks(p))}${filed}</span>`;
}
const afterText = (p) => [sessionState(p).word, ...sessionMarks(p).map((k) => MARKS[k].word)].join(' · ');
function afterBadge(c, p) {
  const s = sessionState(p);
  const tone = s.phase === 'RUNNING' ? 'blue' : 'grey';
  return `<span class="badge" style="--c:${c.tone[tone]}">${s.word}</span>${chips(c, sessionMarks(p))}`;
}
function beforeCell(c, b, kind) {
  if (!b) return '<span class="na">not drawn</span>';
  if (kind === 'run' && b.tone) return `<span class="badge" style="--c:${c.tone[b.tone] ?? c.tone.grey}">${esc(b.word)}</span>`;
  if (b.icon) return `<span class="hdr">${drawIcon(c, b)}<span>${esc(b.word)}</span></span>`;
  return `<span class="txt">${esc(b.word)}</span>`;
}
function afterCell(c, p, kind) {
  if (kind === 'run' || kind === 'pill') return afterBadge(c, p);
  if (kind === 'value') return `<span class="txt">${esc(afterText(p).replace(/ · /g, ', '))}</span>`;
  if (kind === 'md' || kind === 'share-md') return `<code>- ${esc(afterText(p))} · Nov 24 · orbit-ws01</code>`;
  return afterHeader(c, p);
}

function listRow(c, p, b, i, after) {
  const title = TITLES[p.__row];
  const time = TIMES[i];
  if (!after) {
    const lineCls = b.list.lineTone && b.list.lineTone !== 'preview' ? ` lt-${b.list.lineTone}` : '';
    const line = !b.list.lineTone || b.list.lineTone === 'preview' ? LINES[p.__row] : b.list.line;
    if (c.layout === 'phone') {
      // Phone rows: today's cue sits on the first line, before the time; settled states draw nothing there.
      return `<div class="row"><div class="lead"></div><div class="main"><div class="t1"><span class="title">${esc(title)}</span>${drawIcon(c, b.list, 15)}<span class="time">${time}</span></div><div class="t2"><span class="line${lineCls}">${esc(line)}</span></div></div></div>`;
    }
    return `<div class="row"><div class="lead">${drawIcon(c, b.list)}</div><div class="main"><div class="t1"><span class="title">${esc(title)}</span><span class="time">${time}</span></div><div class="t2"><span class="line${lineCls}">${esc(line)}</span></div></div></div>`;
  }
  const marks = sessionMarks(p);
  const line = !b.list.lineTone || b.list.lineTone === 'preview' ? LINES[p.__row] : b.list.line;
  const lineCls = b.list.lineTone && b.list.lineTone !== 'preview' && b.list.lineTone !== 'background' && b.list.lineTone !== 'watching' ? ` lt-${b.list.lineTone}` : '';
  if (c.layout === 'phone')
    // Phone rows keep today's slot for the state icon (first line, before the time); marks go to the right end of the second line.
    return `<div class="row"><div class="lead"></div><div class="main"><div class="t1"><span class="title">${esc(title)}</span>${drawIcon(c, stateGlyph(c, p), 15)}<span class="time">${time}</span></div><div class="t2"><span class="line${lineCls}">${esc(line)}</span><span class="marks">${chips(c, marks, 2)}</span></div></div></div>`;
  return `<div class="row"><div class="lead">${drawIcon(c, stateGlyph(c, p))}</div><div class="main"><div class="t1"><span class="title">${esc(title)}</span><span class="time">${time}</span></div><div class="t2"><span class="line${lineCls}">${esc(line)}</span><span class="marks">${chips(c, marks, 0)}</span></div></div></div>`;
}

function groupOf(rows, which) {
  const g = { 'Needs you': [], Working: [], '-': [] };
  for (const [p, b, i] of rows) g[(which === 'after' ? b.groupAfter : b.group) ?? '-'].push([p, b, i]);
  return g;
}
function listPanel(c, rows, after) {
  const g = groupOf(rows, after ? 'after' : 'before');
  const sec = (title, items) =>
    items.length ? `<div class="sec">${title}</div>` + items.map(([p, b, i]) => listRow(c, p, b, i, after)).join('') : '';
  return `<div class="list ${c.layout}">${sec('Needs you', g['Needs you'])}${sec('Working', g.Working)}${sec('Today', g['-'])}</div>`;
}

function legend(c) {
  const st = Object.entries(STATES)
    .map(([ph, s]) => `<span class="lg">${drawIcon(c, { icon: s.icon, tone: ph === 'RUNNING' ? 'blue' : ph === 'PENDING' ? 'queued' : 'grey', motion: ph === 'RUNNING' ? 'spin' : null })}<b>${s.word}</b><code>${ph}</code></span>`)
    .join('');
  const mk = Object.keys(MARKS).map((k) => `<span class="lg">${chip(c, k)}<small>${esc(MARKS[k].fact)}</small></span>`).join('');
  return `<div class="legend"><div><h3>The three states: <code>phase</code> alone</h3><div class="lgs">${st}</div></div><div><h3>Marks: one per fact, drawn after the state, never instead of it</h3><div class="lgs marks">${mk}</div></div></div>`;
}

const ANSWERS = `
<div class="answers">
 <div><h3>1 · An ended session's icon</h3><p>The <b>Idle</b> circle. Released is not an activity: a released session is always <code>phase</code> IDLE. The grey <b>Ended</b> mark beside it says it ended (green <b>Finished</b> if its work finished, red <b>Failed</b> if the release was a failure). Today's grey check, which reads as success, goes.</p></div>
 <div><h3>2 · A failure stays noticeable</h3><p>By the red <b>Failed</b> mark, the only red left on a row, and by its place: a failure nobody is retrying sits in <b>Needs you</b> at the top, as today. The red moves from the icon to the mark; the icon is Idle. A failure being retried wears grey <b>Retrying</b> and stays in <b>Working</b>.</p></div>
 <div><h3>3 · Needs you and Working keep their members</h3><p>The group rules are not touched and read the same facts: the Group column is before = after on every row. <b>Needs you</b> = a Needs you mark or a red Failed mark, on every client. <b>Working</b> on web = Queued or Running, or Retrying. Mac, iPhone and Android read Working from the legacy status, so rows 15, 27 and 29 draw Running but stay out of Working, exactly as today.</p></div>
 <div><h3>4 · What colour means</h3><p><span class="sw" style="--c:var(--blue)"></span><b>blue</b> running (the spinner on web and Mac; phones keep it muted, as today) · <span class="sw" style="--c:var(--amber)"></span><b>amber</b> you have to act · <span class="sw" style="--c:var(--red)"></span><b>red</b> a failure nobody is retrying · <span class="sw" style="--c:var(--green)"></span><b>green</b> the work finished. Everything else is grey: a grey row needs nobody.</p></div>
</div>`;

function table(c, rows) {
  const surf = c.surfaces;
  const head = `<tr><th class="case">Fixture row · facts</th><th class="grp">Group<br><small>before → after</small></th>${surf.map(([, t]) => `<th colspan="2">${esc(t)}</th>`).join('')}</tr><tr><th></th><th></th>${surf.map(() => '<th class="ba">Before</th><th class="ba after">After</th>').join('')}</tr>`;
  const body = rows
    .map(([p, b]) => {
      const facts = [`phase ${p.phase}`, p.released ? 'released' : 'held', p.lastTurnOutcome && `last turn ${p.lastTurnOutcome}`, p.waitingOn && `waitingOn ${p.waitingOn}`, p.endReason && `endReason ${p.endReason}`, p.workFinished && 'workFinished', p.activity && p.activity !== 'TURN' && `activity ${p.activity}`].filter(Boolean).join(' · ');
      const same = b.group === b.groupAfter;
      return `<tr><td class="case"><b>${p.__row}</b> ${esc(byRow.get(p.__row).name)}<div class="facts">${esc(facts)}</div></td><td class="grp${same ? '' : ' diff'}">${esc(b.group === '-' ? '—' : b.group)} → ${esc(b.groupAfter === '-' ? '—' : b.groupAfter)}</td>${surf
        .map(([k]) => `<td class="b">${beforeCell(c, b[k], k)}</td><td class="a">${b[k] === null ? '<span class="na">not drawn</span>' : afterCell(c, p, k)}</td>`)
        .join('')}</tr>`;
    })
    .join('');
  return `<table class="grid">${head}${body}</table>`;
}

function olderStrip(c, before) {
  const rows = fixture.filter((r) => !r.newFields);
  const cells = rows
    .map((r) => {
      const b = before.get(r.row);
      const w = b?.header?.word ?? b?.value?.word ?? b?.list?.line ?? '';
      return `<span class="old"><b>${r.row}</b> ${esc(r.name)}: ${b?.header?.icon ? drawIcon(c, b.header, 13) : b?.list?.icon && b.list.icon !== 'none' ? drawIcon(c, b.list, 13) : ''}${esc(w)}</span>`;
    })
    .join('');
  return `<div class="older"><h3>Older server (the six facts absent, fixture rows 2, 4 … 36): drawn exactly as today on every surface</h3><div class="olds">${cells}</div></div>`;
}

function taskStrip(c, before) {
  if (!c.taskStrip) return '';
  const pick = [1, 3, 17, 19, 9, 11];
  const cell = (row) => {
    const p = { ...byRow.get(row).payload, __row: row };
    const b = before.get(row);
    const nowBefore = b.now?.word ?? (['Running', 'Queued', 'On hold'].includes(b.run?.word) ? (b.run.word === 'Running' ? 'orbit-ws01 is working' : b.run.word) : null);
    const s = sessionState(p);
    const nowAfter = s.phase === 'IDLE' ? null : `${s.phase === 'RUNNING' ? 'orbit-ws01 is working' : 'Queued'}`;
    return `<div class="tcard"><div class="tc-h">Row ${row} · ${esc(byRow.get(row).name)}</div>
      <div class="tc-r"><span class="lbl">Before</span><span class="pill">${esc(b.pill?.word ?? '')}</span>${nowBefore ? `<span class="now">Now: ${esc(nowBefore)}</span>` : '<span class="now na">no Now card (run is over)</span>'}</div>
      <div class="tc-r"><span class="lbl after">After</span>${s.phase === 'IDLE' ? `<span class="pill">${esc(b.pill?.word ?? '')}</span>` : afterBadge(c, p)}${nowAfter ? `<span class="now">Now: ${nowAfter} ${chips(c, sessionMarks(p))}</span>` : '<span class="now na">no Now card (run is over)</span>'}</div></div>`;
  };
  return `<div class="tasks"><h3>${c.name === 'Web' ? 'Tasks list pill and task panel Now card' : 'Task run label in the task list'}: the runs of a task</h3><div class="tcards">${pick.map(cell).join('')}</div></div>`;
}

function page(clientKey) {
  const c = CLIENTS[clientKey];
  const before = clientKey === 'web' ? webBefore() : nativeBefore(clientKey);
  const rows = BOARD_CASES.map((row, i) => [{ ...byRow.get(row).payload, __row: row }, before.get(row), i]);
  const css = readFileSync(path.join(here, 'board.css'), 'utf8');
  const vars = Object.entries(c.tone).map(([k, v]) => `--${k}:${v}`).join(';');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="${c.layout}" style="font-family:${c.font.replace(/"/g, "'")};${vars}">
<header><h1>${c.name}: a session shows three states, and every other fact as its own mark</h1>
<p>Before is today's ${clientKey === 'web' ? 'web, computed by running its own functions on each fixture row' : `${c.name} app, read from its source at main 9f94177875`}; after is <code>capture/rules.mjs</code>, the same two functions on every client. Rows are the comparison rig's fixture (36 rows: 18 cases with the six facts, drawn below, and the same 18 without them).</p></header>
${legend(c)}
${ANSWERS}
<h2>Session list${c.listNote ? ` <small>${esc(c.listNote)}</small>` : ''}</h2>
<div class="lists"><div><div class="cap">Before</div>${listPanel(c, rows, false)}</div><div><div class="cap after">After</div>${listPanel(c, rows, true)}</div></div>
<h2>Every other surface that draws a session's state</h2>
${table(c, rows)}
${taskStrip(c, before)}
${olderStrip(c, before)}
</body></html>`;
}

const which = process.argv[2] ?? 'all';
const list = which === 'all' ? Object.keys(CLIENTS) : [which];
const { chromium } = await import('../../../../node_modules/playwright/index.mjs');
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
for (const k of list) {
  const html = page(k);
  writeFileSync(path.join(here, `${k}.html`), html);
  const pg = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1.25 });
  await pg.setContent(html);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(dir, `${k}.png`), fullPage: true, animations: 'disabled' });
  await pg.close();
  console.log('wrote', `${k}.png`);
}
await browser.close();
