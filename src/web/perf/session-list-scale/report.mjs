// The before/after table of a results.json measure.mjs wrote (seed.json beside it): node report.mjs <results.json>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sorted = (values) => values.filter((v) => v != null).sort((a, b) => a - b);
const median = (values) => {
  const s = sorted(values);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null;
};
const fmt = (n) => (n == null ? '–' : n >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));
const spread = (values) => {
  const s = sorted(values);
  return s.length ? `${fmt(median(s))} (${fmt(s[0])}–${fmt(s.at(-1))})` : '–';
};

export function report(results, facts) {
  const { before, after } = results.builds;
  const lines = [
    `Seed: ${results.seed.openSessions} Open sessions, ${results.seed.folders} folders, ${results.seed.projects} projects of ${results.seed.sessionsPerProject}.`,
    `before = ${before.rev}`,
    `after  = ${after.rev}`,
    `Chromium ${results.chromium}, Node ${results.node}, measured ${results.measuredAt}. Times are medians (min–max).`,
    '',
    '| Metric | Before | After | Before ÷ after | ≥ 10× |',
    '| --- | --- | --- | --- | --- |',
  ];
  const row = (name, read, { gate = true } = {}) => {
    const [b, a] = [before, after].map(read);
    const ratio = median(b) != null && median(a) ? median(b) / median(a) : null;
    lines.push(`| ${name} | ${spread(b)} | ${spread(a)} | ${ratio == null ? '–' : `${fmt(ratio)}×`} | ${gate ? (ratio >= 10 ? 'yes' : '**no**') : ''} |`);
  };
  const loads = (key) => (build) => build.loads.map(key);
  const frames = (kind, key) => (build) => build.frames[kind].frames.map(key);
  row('**First list response: body bytes (JSON)**', loads((l) => l.firstList.decoded));
  row('**First list response: bytes on the wire (gzip)**', loads((l) => l.firstList.wire));
  row('Every list read of the load: bytes on the wire', loads((l) => l.listBytes.wire), { gate: false });
  row('All /api reads of the page load: body bytes', loads((l) => l.apiBytes.decoded), { gate: false });
  row('All /api reads of the page load: bytes on the wire', loads((l) => l.apiBytes.wire), { gate: false });
  row('**Navigation → interactive session list, ms**', loads((l) => l.interactiveMs));
  row('Navigation → first contentful paint, ms', loads((l) => l.fcpMs), { gate: false });
  row('Navigation → app scripts downloaded, ms', loads((l) => l.scriptsEndMs), { gate: false });
  row('Navigation → list response arrived, ms', loads((l) => l.listArrivedMs), { gate: false });
  row('List response arrived → interactive, ms', loads((l) => l.interactiveMs - l.listArrivedMs), { gate: false });
  row('Long tasks during the load, total ms', loads((l) => l.longTaskMs), { gate: false });
  row('**One watch frame: React render time of the commits that draw it, ms**', frames('profiling', (f) => f.renderMs));
  row('One watch frame: every commit in the 1.2 s after it, render ms', frames('profiling', (f) => f.windowRenderMs), { gate: false });
  row('One watch frame, shipped build: /watches arrived → row changed in the DOM, ms', frames('web', (f) => f.responseToDomMs), { gate: false });
  row('One watch frame, shipped build: /watches arrived → frame painted, ms', frames('web', (f) => f.responseToPaintedMs), { gate: false });
  row('Session rows redrawn by one watch frame', (b) => b.frames.profiling.rowProbe.map((p) => p.rowRenders), { gate: false });
  row('Session rows redrawn by the first commit that draws the watch', (b) => b.frames.profiling.rowProbe.map((p) => p.perCommit.find((c) => c.rows)?.rows), { gate: false });
  row('**Mounted session rows after load**', loads((l) => l.mounted.rows));
  row('**Mounted session rows after scrolling to the end**', (b) => b.loads.filter((l) => l.atEnd).map((l) => l.atEnd.rows));
  row('DOM elements in the page after load', loads((l) => l.mounted.allElements), { gate: false });
  row('DOM elements in the page after scrolling to the end', (b) => b.loads.filter((l) => l.atEnd).map((l) => l.atEnd.allElements), { gate: false });
  lines.push('');
  for (const [label, build] of Object.entries(results.builds)) {
    const load = build.loads[0];
    const end = build.loads.find((l) => l.atEnd)?.atEnd;
    lines.push(`${label}: list read(s) at load: ${load.listReads.map((r) => `\`GET ${r.path}${r.query.replace(/(runnerId|workspaceId)=[^&]+/g, '$1=…')}\` (${r.items} items, ${r.encoding ?? 'identity'})`).join(', ')}; `
      + (end ? `to the end: ${end.listReads} list read(s), ${end.listItems} items, ${fmt(end.listBytes.decoded)} B, ${end.titles.length} distinct row titles seen, last row "${end.last}", ${end.folderRows} folder rows mounted at the end. ` : '')
      + `Sessions in the database afterwards: ${JSON.stringify(build.sessionsAfterwards)}.`);
  }
  const [wasEnd, isEnd] = [before, after].map((b) => b.loads.find((l) => l.atEnd)?.atEnd);
  const missing = (a, b) => a.filter((t) => !b.includes(t));
  const passed = missing(wasEnd.titles, isEnd.titles);
  lines.push(`Rows (by title) seen scrolling down while the pages arrive: ${passed.length} only before, ${missing(isEnd.titles, wasEnd.titles).length} only after; `
    + `${passed.filter((t) => facts.workingTitles.includes(t)).length} of those ${passed.length} are seeded running or background-job sessions (the list's "Working" section). `
    + `Scrolling down again once every page is read: ${missing(wasEnd.titlesOnceLoaded, isEnd.titlesOnceLoaded).length} only before, ${missing(isEnd.titlesOnceLoaded, wasEnd.titlesOnceLoaded).length} only after.`);
  const loadavg = Object.values(results.builds).flatMap((b) => b.loads.map((l) => l.loadavg));
  lines.push('', `Runs per build: ${before.loads.length} loads (alternating builds), ${before.frames.web.frames.length} watch frames on each of the shipped and profiling builds. Host 1-minute load average during the loads: ${fmt(Math.min(...loadavg))}–${fmt(Math.max(...loadavg))}.`);
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(report(read(process.argv[2]), read(join(dirname(process.argv[2]), 'seed.json'))));
}
