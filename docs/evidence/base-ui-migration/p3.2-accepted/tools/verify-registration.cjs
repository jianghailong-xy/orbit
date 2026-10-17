// Usage: node verify-registration.cjs <runs dir> <out.json>
// Re-checks the P3.2 entries of p0-drift/accepted/registry.json against the runs they were made from,
// independently of register-accepted.cjs and expected-screenshots.mjs. <runs dir> holds the
// same-commit-originals.sh runs before-fffcdb532 and after-2925958ae (and, if present, the control
// capture tip-fc58e5713). For every entry: the decision fields are the cited P3.2 CONFIRM; the
// replaced expectation is the main drift reference of that screenshot (file hash = registry hash); the
// before/after commits are the P3.2 landing's first parent and the project tip the originals were
// captured on, both on the project's first-parent line; both runs used the P0.2 environment; the
// before/after files in accepted/ are byte-identical to the run's screenshots and to the recorded
// hashes; under the P0 comparator (maxDiffPixels 0) the before original matches the replaced
// expectation and the after original does not match the before original. Completeness: of the 40
// task-scenario screenshots, exactly the registered ones have an after original that fails the P0
// comparator against the expectation they had before the registration. Control: each registered
// expectation matches the tip-fc58e5713 capture under the P0 comparator, and that capture is
// compared byte for byte with the after originals for all 252 screenshots.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repo = resolve(__dirname, '../../../../..');
const evidence = join(repo, 'docs/evidence/base-ui-migration');
const W = join(repo, 'node_modules') + '/';
const comparator = require(W + 'playwright-core/lib/coreBundle').utils.getComparator('image/png');
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path) => JSON.parse(readFileSync(path));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };
const matches = (actual, expected) => !comparator(readFileSync(actual), readFileSync(expected), { maxDiffPixels: 0 });
const pixels = (a, b) => {
  const x = PNG.sync.read(readFileSync(a)), y = PNG.sync.read(readFileSync(b));
  let n = 0, max = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]));
    if (d) { n++; max = Math.max(max, d); }
  }
  return { differentPixels: n, maxChannelDelta: max };
};

const [runs, out] = process.argv.slice(2);
const DECISION = { taskId: '34Za39ACSBoCkYKc80Md8', evidenceRevision: 2,
  evidenceDigest: '302ca1f5051c1f3fd04abf89c1dff51c86cfbdcb9326fc3f7abf70e9ee9809bc', verdict: 'CONFIRM', document: 'p3.2/README.md' };
const P32_MERGE = '066d3dd30ef2ca137f3084345503396239c929c1';
const BEFORE = 'fffcdb532ef380d7b43ee87cbbd4e3316c5c24b8', AFTER = '2925958aed739d386ac4c79d3bd766ac7e221999';
const before = join(runs, 'before-fffcdb532'), after = join(runs, 'after-2925958ae'), tip = join(runs, 'tip-fc58e5713');
const environment = sha(join(evidence, 'p0.2/environment.json'));
const reference = Object.fromEntries(json(join(evidence, 'p0-drift/reference/registry.json')).screenshots.map((e) => [e.screenshot, e]));
const p02 = Object.fromEntries(json(join(evidence, 'p0.2/baseline-run/summary.json')).images
  .map(({ path, sha256 }) => [path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''), sha256]));
const registry = json(join(evidence, 'p0-drift/accepted/registry.json')).screenshots;
const r2c = json(join(evidence, 'p3.2/r2c-p0-task-compare.json')).screenshots;
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

const commits = {
  p32MergeFirstParent: git('rev-parse', `${P32_MERGE}^1`),
  p32MergeSecondParent: git('rev-parse', `${P32_MERGE}^2`),
  projectFirstParentLine: git('rev-list', '--first-parent', 'HEAD'),
};
check(commits.p32MergeFirstParent === BEFORE, 'before is not the first parent of the P3.2 landing 066d3dd30');
check(isAncestor(P32_MERGE, AFTER), 'after does not contain the P3.2 landing');
check(commits.projectFirstParentLine.split('\n').includes(AFTER), 'after is not on the first-parent line of HEAD');
check(commits.projectFirstParentLine.split('\n').includes(BEFORE), 'before is not on the first-parent line of HEAD');
const runMeta = {};
for (const [label, dir, commit] of [['before', before, BEFORE], ['after', after, AFTER]]) {
  const m = json(join(dir, 'meta.json'));
  runMeta[label] = { commit: m.commit, environmentSha256: m.environmentSha256, screenshots: m.screenshots, exit: m.exit, stats: m.stats };
  check(m.commit === commit, `${label} run commit ${m.commit}`);
  check(m.environmentSha256 === environment && sha(join(dir, 'environment.json')) === environment, `${label} run environment`);
}

const entries = registry.map((e) => {
  const s = e.screenshot, ref = reference[s];
  const files = { before: join(evidence, 'p0-drift/accepted/before', s), after: join(evidence, 'p0-drift/accepted/screenshots', s),
    reference: join(evidence, 'p0-drift/reference/screenshots', s), runBefore: join(before, 'snapshots', s), runAfter: join(after, 'snapshots', s) };
  const row = { screenshot: s, decision: e.decision, replaces: e.replaces, mainCommits: ref?.mainCommits, sha256: e.sha256, sameCommit: e.sameCommit };
  check(/\/task-(share-dialog|action-menu)\.png$/.test(s), `${s}: not a task-scenario screenshot of P3.2`);
  check(JSON.stringify(e.decision) === JSON.stringify(DECISION), `${s}: decision ${JSON.stringify(e.decision)}`);
  check(existsSync(join(evidence, e.decision.document)), `${s}: decision document missing`);
  check(Boolean(e.difference && e.difference.trim()), `${s}: no difference text`);
  check(e.replaces.layer === 'p0-drift' && ref && e.replaces.sha256 === ref.sha256 && sha(files.reference) === ref.sha256, `${s}: replaces is not its main drift reference`);
  check(e.sameCommit.before.commit === BEFORE && e.sameCommit.after.commit === AFTER, `${s}: same-commit commits`);
  check(e.sameCommit.environment === environment, `${s}: environment`);
  row.hashes = { acceptedBefore: sha(files.before), runBefore: sha(files.runBefore), acceptedAfter: sha(files.after), runAfter: sha(files.runAfter) };
  check(row.hashes.acceptedBefore === e.sameCommit.before.sha256 && row.hashes.runBefore === e.sameCommit.before.sha256, `${s}: before original hash`);
  check(row.hashes.acceptedAfter === e.sha256 && row.hashes.runAfter === e.sha256 && e.sameCommit.after.sha256 === e.sha256, `${s}: after original hash`);
  row.beforeMatchesReplaced = check(matches(files.before, files.reference), `${s}: before original does not reproduce the replaced expectation`);
  row.afterDiffersFromBefore = check(!matches(files.after, files.before), `${s}: after original matches the before original`);
  row.beforeToAfter = pixels(files.before, files.after);
  const p = r2c[s];
  row.p32Revision2 = p ? { pixels: p.pixels, maxChannelDiff: p.maxChannelDiff } : null;
  check(p && p.pixels === row.beforeToAfter.differentPixels && p.maxChannelDiff === row.beforeToAfter.maxChannelDelta,
    `${s}: before -> after differs from P3.2 revision 2 r2c-p0-task-compare.json`);
  if (existsSync(join(tip, 'snapshots', s))) row.tipCaptureMatchesRegistered = check(matches(join(tip, 'snapshots', s), files.after), `${s}: tip capture does not match the registered expectation`);
  return row;
});

// Completeness over the task scenario: which after originals fail against the pre-registration expectation.
const registered = new Set(registry.map((e) => e.screenshot));
const projects = ['chromium', 'webkit'].flatMap((b) => ['light', 'dark'].flatMap((c) => ['desktop', 'phone'].map((v) => `${b}-${c}-${v}`)));
const task = projects.flatMap((p) => ['task-detail', 'task-action-hover', 'task-action-focus', 'task-action-menu', 'task-share-dialog'].map((n) => `${p}/${n}.png`));
const completeness = task.map((s) => {
  const exp = reference[s] ? join(evidence, 'p0-drift/reference/screenshots', s) : join(evidence, 'p0.2/screenshots', s);
  const failsNow = !matches(join(after, 'snapshots', s), exp);
  check(failsNow === registered.has(s), `${s}: fails ${failsNow}, registered ${registered.has(s)}`);
  return { screenshot: s, expectationLayer: reference[s] ? 'p0-drift' : 'p0.2', afterFailsComparator: failsNow, registered: registered.has(s),
    beforeToAfter: pixels(join(before, 'snapshots', s), join(after, 'snapshots', s)) };
});

// Control: the tip-fc58e5713 capture against the after originals, all 252 screenshots.
let control = null;
if (existsSync(join(tip, 'meta.json'))) {
  const m = json(join(tip, 'meta.json'));
  check(m.environmentSha256 === environment, 'tip capture environment');
  const names = Object.keys(p02).sort();
  const rows = names.map((s) => {
    const a = join(after, 'snapshots', s), t = join(tip, 'snapshots', s);
    if (!existsSync(t) || !existsSync(a)) return { screenshot: s, missing: true };
    const same = sha(a) === sha(t);
    return { screenshot: s, bytesEqual: same, comparatorMatch: same || matches(t, a), ...(same ? {} : pixels(a, t)) };
  });
  control = { commit: m.commit, environmentSha256: m.environmentSha256, exit: m.exit, stats: m.stats, screenshots: m.screenshots,
    bytesEqual: rows.filter((r) => r.bytesEqual).length, comparatorFails: rows.filter((r) => !r.missing && !r.comparatorMatch).map((r) => r.screenshot),
    missing: rows.filter((r) => r.missing).map((r) => r.screenshot), different: rows.filter((r) => !r.missing && !r.bytesEqual) };
}

const result = { decision: DECISION, environment, commits: { before: BEFORE, after: AFTER, p32Merge: P32_MERGE,
  p32MergeFirstParent: commits.p32MergeFirstParent, p32MergeSecondParent: commits.p32MergeSecondParent, head: git('rev-parse', 'HEAD') },
  runs: runMeta, entries: entries.length, problems, registry: entries, completeness, control };
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ entries: entries.length, problems, taskScreenshots: completeness.length,
  failingAndRegistered: completeness.filter((r) => r.afterFailsComparator && r.registered).length,
  control: control && { commit: control.commit, bytesEqual: control.bytesEqual, comparatorFails: control.comparatorFails, missing: control.missing.length,
    different: control.different.map((r) => `${r.screenshot} ${r.differentPixels}px/Δ${r.maxChannelDelta}${r.comparatorMatch ? '' : ' FAILS'}`) } }, null, 1));
process.exitCode = problems.length ? 1 : 0;
