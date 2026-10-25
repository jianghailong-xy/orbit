// Independent analysis of a P0 ui-migration run, from the raw Playwright report.json
// written by the run itself (not from any summary a session produced).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const results = process.argv[2]; // e.g. cand/src/web/.ui-migration-results
const report = JSON.parse(readFileSync(join(results, 'report.json'), 'utf8'));

const tests = [];
const visit = (suite) => {
  for (const spec of suite.specs || []) {
    for (const test of spec.tests) {
      tests.push({
        project: test.projectName,
        title: spec.title,
        file: spec.file,
        expectedStatus: test.expectedStatus,
        status: test.status,
        retries: test.results.length - 1,
        resultStatuses: test.results.map((r) => r.status),
        attachments: test.results.flatMap((r) => r.attachments.map((a) => ({ name: a.name, contentType: a.contentType, path: a.path }))),
      });
    }
  }
  for (const child of suite.suites || []) visit(child);
};
report.suites.forEach(visit);

const byStatus = {};
const byProject = {};
const byFile = {};
let retriesAboveZero = 0;
const notExpected = [];
for (const t of tests) {
  byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  byProject[t.project] ??= {};
  byProject[t.project][t.status] = (byProject[t.project][t.status] || 0) + 1;
  const file = t.file.replace(/^.*ui-migration\//, '');
  byFile[`${file} ${t.status}`] = (byFile[`${file} ${t.status}`] || 0) + 1;
  if (t.retries > 0) retriesAboveZero++;
  if (t.status !== 'expected' && t.status !== 'skipped') notExpected.push({ project: t.project, title: t.title, status: t.status });
}

// captures: every evidence.json attachment records one entry per asserted screenshot
const captures = [];
for (const t of tests) {
  for (const a of t.attachments) {
    if (a.contentType !== 'application/json' || a.name !== 'computed-styles-and-timings') continue;
    const data = JSON.parse(readFileSync(a.path, 'utf8'));
    for (const c of data.captures ?? []) captures.push({ project: t.project, name: `${t.project}/${c.name}` });
  }
}

// expected screenshots assembled by globalSetup this run
const sourcesFile = join(results, 'expected-screenshots', 'sources.json');
const sources = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, 'utf8')) : null;
const expected = sources ? Object.keys(sources).map((k) => k.replace(/\.png$/, '')) : [];
const capturedSet = new Set(captures.map((c) => c.name));
const expectedSet = new Set(expected);
const layers = {};
if (sources) for (const v of Object.values(sources)) layers[v.layer] = (layers[v.layer] || 0) + 1;

const out = {
  stats: report.stats,
  statusCounts: byStatus,
  byProject,
  byFileStatus: byFile,
  retriesAboveZero,
  notExpected,
  skipped: tests.filter((t) => t.status === 'skipped').map((t) => ({ project: t.project, title: t.title })),
  expectedLayers: layers,
  screenshotsAsserted: {
    expected: expected.length,
    captured: captures.length,
    unique: capturedSet.size,
    missing: expected.filter((n) => !capturedSet.has(n)),
    extra: [...capturedSet].filter((n) => !expectedSet.has(n)),
  },
  capturesByLayer: sources
    ? Object.entries(
        captures.reduce((acc, c) => {
          const layer = sources[`${c.name}.png`]?.layer ?? 'unknown';
          acc[layer] = (acc[layer] || 0) + 1;
          return acc;
        }, {}),
      )
    : null,
};
console.log(JSON.stringify(out, null, 1));
