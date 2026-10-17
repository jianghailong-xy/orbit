// Usage: node verify-registration.cjs <runs dir> <out.json>
// Re-checks the P4.1 entries of p0-drift/accepted/registry.json against the runs they were made from,
// independently of register-accepted.cjs and expected-screenshots.mjs (p3.2-accepted/tools/verify-registration.cjs
// adapted to this batch). <runs dir> holds the same-commit-originals.sh runs before-a84bc61e7 and after-3aa26fb97
// and expected-pre/, the expectations the P0 globalSetup assembled at 3aa26fb97 before the registration.
// For every P4.1 entry: the decision fields are the cited CONFIRM of P4.1 evidence revision 1; the replaced
// expectation is the main drift reference of that screenshot (file hash = registry hash); before is a84bc61e7,
// the parent of P4.1's first delivered commit, and after is 3aa26fb97, the landed P4.1 delivery whose four
// commits are patch-identical to the four delivered ones, both on HEAD's first-parent line; both runs used
// the P0.2 environment; the before/after files in accepted/ are byte-identical to the runs' screenshots and to
// the recorded hashes; under the P0 comparator (maxDiffPixels 0) the before original matches the replaced
// expectation and the after original does not match the before original; before -> after equals P4.1's own
// same-commit data (compare/f-p0-compare.json, AntD reference b5a39dd48 against delivery b0b59fa39) and the
// originals are byte-identical to P4.1's reference/delivery screenshots (shots/p0-beyond). The registration
// leaves the other entries as they were at 3aa26fb97. Completeness over all 252 screenshots: exactly the
// registered ones have an after original that fails the P0 comparator against the pre-registration
// expectation, and every before original matches it.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repo = process.env.REPO || resolve(__dirname, '../../../../..');
const evidence = join(repo, 'docs/evidence/base-ui-migration');
const W = join(repo, 'node_modules') + '/';
const comparator = require(W + 'playwright-core/lib/coreBundle').utils.getComparator('image/png');
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path) => JSON.parse(readFileSync(path));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const matches = (actual, expected) => !comparator(readFileSync(actual), readFileSync(expected), { maxDiffPixels: 0 });
const pixels = (a, b) => {
  const x = PNG.sync.read(readFileSync(a)), y = PNG.sync.read(readFileSync(b));
  if (x.width !== y.width || x.height !== y.height) return { differentPixels: Infinity, maxChannelDelta: 255 };
  let n = 0, max = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]));
    if (d) { n++; max = Math.max(max, d); }
  }
  return { differentPixels: n, maxChannelDelta: max };
};
const patchId = (commit) => execFileSync('bash', ['-c', 'git -C "$0" show --format= "$1" | git -C "$0" patch-id --stable', repo, commit], { encoding: 'utf8', maxBuffer: 1 << 30 }).split(' ')[0];

const [runs, out] = process.argv.slice(2);
const DECISION = { taskId: '34Za39Do3N6tkmIMP0GBP', evidenceRevision: 1,
  evidenceDigest: '9477611a4499f613621b9dcc7e7c99a7dce050f1caca7ffa22fd95ca60467d57', verdict: 'CONFIRM', document: 'p4.1/README.md' };
const BEFORE = 'a84bc61e7913b1ecae26c0a5a74d4c4887454e99', AFTER = '3aa26fb97644f24551dc9c70149021f7f7f9453f';
// P4.1 as delivered on a84bc61e7 (the CONFIRMed evidence names these) and as landed on the project line.
const DELIVERED = ['0bb647a81', '7d81822b1', 'b0b59fa39', '62641903e'];
const LANDED = ['3c1d969db', 'b9d154547', 'c4a280571', '3aa26fb97'];
const SHOTS = ['webkit-dark-phone/profile-validation.png', 'webkit-light-phone/profile-validation.png'];
const before = join(runs, 'before-a84bc61e7'), after = join(runs, 'after-3aa26fb97'), expectedPre = join(runs, 'expected-pre');
const p41 = join(evidence, 'p4.1');
const environment = sha(join(evidence, 'p0.2/environment.json'));
const reference = Object.fromEntries(json(join(evidence, 'p0-drift/reference/registry.json')).screenshots.map((e) => [e.screenshot, e]));
const p02 = Object.fromEntries(json(join(evidence, 'p0.2/baseline-run/summary.json')).images
  .map(({ path, sha256 }) => [path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''), sha256]));
const registry = json(join(evidence, 'p0-drift/accepted/registry.json')).screenshots;
const registryAtAfter = JSON.parse(git('show', `${AFTER}:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json`)).screenshots;
const p41Compare = json(join(p41, 'compare/f-p0-compare.json')).screenshots;
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

const firstParent = git('rev-list', '--first-parent', 'HEAD').split('\n');
const commits = {
  head: git('rev-parse', 'HEAD'),
  deliveredFirstParent: git('rev-parse', `${DELIVERED[0]}^`),
  landedBase: git('rev-parse', `${LANDED[0]}^`),
  delivered: DELIVERED.map((c) => git('rev-parse', c)),
  landed: LANDED.map((c) => git('rev-parse', c)),
  patchIds: DELIVERED.map((c, i) => ({ delivered: c, landed: LANDED[i], deliveredPatchId: patchId(c), landedPatchId: patchId(LANDED[i]) })),
};
check(commits.deliveredFirstParent === BEFORE, 'before is not the parent of the first delivered P4.1 commit');
check(commits.landed[3] === AFTER, 'after is not the last landed P4.1 commit');
commits.patchIds.forEach((p) => check(p.deliveredPatchId === p.landedPatchId, `landed ${p.landed} is not patch-identical to delivered ${p.delivered}`));
check(git('rev-list', '--first-parent', `${commits.landedBase}..${AFTER}`).split('\n').reverse().join(' ') === commits.landed.join(' '),
  'the landed P4.1 commits are not a linear run on the project line');
check(firstParent.includes(BEFORE), 'before is not on the first-parent line of HEAD');
check(firstParent.includes(AFTER), 'after is not on the first-parent line of HEAD');

const runMeta = {};
for (const [label, dir, commit] of [['before', before, BEFORE], ['after', after, AFTER]]) {
  const m = json(join(dir, 'meta.json'));
  runMeta[label] = { commit: m.commit, environmentSha256: m.environmentSha256, environmentEqualsP02: m.environmentEqualsP02, screenshots: m.screenshots, exit: m.exit, stats: m.stats };
  check(m.commit === commit, `${label} run commit ${m.commit}`);
  check(m.environmentSha256 === environment && sha(join(dir, 'environment.json')) === environment, `${label} run environment`);
}

const ours = registry.filter((e) => e.decision?.taskId === DECISION.taskId);
check(JSON.stringify(ours.map((e) => e.screenshot).sort()) === JSON.stringify(SHOTS), `P4.1 entries ${ours.map((e) => e.screenshot)}`);
const others = registry.filter((e) => e.decision?.taskId !== DECISION.taskId);
check(JSON.stringify(others) === JSON.stringify(registryAtAfter), 'the other entries differ from the registry at 3aa26fb97');
const entries = ours.map((e) => {
  const s = e.screenshot, ref = reference[s];
  const files = { before: join(evidence, 'p0-drift/accepted/before', s), after: join(evidence, 'p0-drift/accepted/screenshots', s),
    reference: join(evidence, 'p0-drift/reference/screenshots', s), runBefore: join(before, 'snapshots', s), runAfter: join(after, 'snapshots', s),
    p41Reference: join(p41, 'shots/p0-beyond', s.replace('.png', '.reference.png')), p41Delivery: join(p41, 'shots/p0-beyond', s.replace('.png', '.delivery.png')),
    p41StandardExpected: join(p41, 'shots/p0-standard', s.replace('.png', '-expected.png')), p41StandardActual: join(p41, 'shots/p0-standard', s.replace('.png', '-actual.png')) };
  const row = { screenshot: s, decision: e.decision, replaces: e.replaces, mainCommits: ref?.mainCommits, sha256: e.sha256, sameCommit: e.sameCommit, difference: e.difference };
  check(JSON.stringify(e.decision) === JSON.stringify(DECISION), `${s}: decision ${JSON.stringify(e.decision)}`);
  check(existsSync(join(evidence, e.decision.document)), `${s}: decision document missing`);
  check(Boolean(e.difference && e.difference.trim()), `${s}: no difference text`);
  check(!e.previous, `${s}: has an earlier accepted entry`);
  check(e.replaces.layer === 'p0-drift' && ref && e.replaces.sha256 === ref.sha256 && sha(files.reference) === ref.sha256, `${s}: replaces is not its main drift reference`);
  check(e.sameCommit.before.commit === BEFORE && e.sameCommit.after.commit === AFTER, `${s}: same-commit commits`);
  check(e.sameCommit.environment === environment, `${s}: environment`);
  row.hashes = { acceptedBefore: sha(files.before), runBefore: sha(files.runBefore), acceptedAfter: sha(files.after), runAfter: sha(files.runAfter),
    expectedPre: sha(join(expectedPre, s)), p41Reference: sha(files.p41Reference), p41Delivery: sha(files.p41Delivery),
    p41StandardExpected: sha(files.p41StandardExpected), p41StandardActual: sha(files.p41StandardActual) };
  check(row.hashes.acceptedBefore === e.sameCommit.before.sha256 && row.hashes.runBefore === e.sameCommit.before.sha256, `${s}: before original hash`);
  check(row.hashes.acceptedAfter === e.sha256 && row.hashes.runAfter === e.sha256 && e.sameCommit.after.sha256 === e.sha256, `${s}: after original hash`);
  check(row.hashes.expectedPre === ref.sha256, `${s}: the pre-registration expectation is not its main drift reference`);
  row.beforeMatchesReplaced = check(matches(files.before, files.reference), `${s}: before original does not reproduce the replaced expectation`);
  row.beforeBytesEqualReplaced = row.hashes.acceptedBefore === ref.sha256;
  row.afterDiffersFromBefore = check(!matches(files.after, files.before), `${s}: after original matches the before original`);
  row.beforeToAfter = pixels(files.before, files.after);
  const p = p41Compare[s];
  row.p41SameCommit = p ? { pixels: p.pixels, maxChannelDiff: p.maxChannelDiff, sha256Ref: p.sha256Ref, sha256Del: p.sha256Del } : null;
  check(p && p.pixels === row.beforeToAfter.differentPixels && p.maxChannelDiff === row.beforeToAfter.maxChannelDelta,
    `${s}: before -> after differs from P4.1 compare/f-p0-compare.json`);
  check(p && p.sha256Ref === row.hashes.acceptedBefore && p.sha256Del === row.hashes.acceptedAfter,
    `${s}: the originals differ from the screenshots P4.1's same-commit comparison recorded`);
  row.originalsEqualP41 = {
    beforeEqualsP41Reference: check(row.hashes.acceptedBefore === row.hashes.p41Reference, `${s}: before original differs from P4.1's reference capture`),
    afterEqualsP41Delivery: check(row.hashes.acceptedAfter === row.hashes.p41Delivery, `${s}: after original differs from P4.1's delivery capture`),
    afterEqualsP41StandardActual: row.hashes.acceptedAfter === row.hashes.p41StandardActual,
    replacedEqualsP41StandardExpected: ref.sha256 === row.hashes.p41StandardExpected,
  };
  return row;
});

// Completeness over the 252 screenshots, against the expectations assembled before the registration.
const registered = new Set(ours.map((e) => e.screenshot));
const completeness = Object.keys(p02).sort().map((s) => {
  const exp = join(expectedPre, s), a = join(after, 'snapshots', s), b = join(before, 'snapshots', s);
  const row = { screenshot: s, expectationLayer: reference[s] ? 'p0-drift' : 'p0.2', registered: registered.has(s) };
  row.afterBytesEqualExpectation = existsSync(a) && sha(a) === sha(exp);
  row.afterFailsComparator = !existsSync(a) || !matches(a, exp);
  row.beforeBytesEqualExpectation = existsSync(b) && sha(b) === sha(exp);
  row.beforeFailsComparator = !existsSync(b) || !matches(b, exp);
  if (!row.afterBytesEqualExpectation && existsSync(a)) row.afterVsExpectation = pixels(exp, a);
  if (!row.beforeBytesEqualExpectation && existsSync(b)) row.beforeVsExpectation = pixels(exp, b);
  if (existsSync(a) && existsSync(b) && sha(a) !== sha(b)) row.beforeToAfter = pixels(b, a);
  check(row.afterFailsComparator === row.registered, `${s}: after fails ${row.afterFailsComparator}, registered ${row.registered}`);
  check(!row.beforeFailsComparator, `${s}: the before original fails the comparator against the pre-registration expectation`);
  return row;
});

const result = { decision: DECISION, environment, commits, runs: runMeta, entries: entries.length, problems, registry: entries,
  completeness: { screenshots: completeness.length,
    afterBytesEqual: completeness.filter((r) => r.afterBytesEqualExpectation).length,
    afterFails: completeness.filter((r) => r.afterFailsComparator).map((r) => r.screenshot),
    beforeBytesEqual: completeness.filter((r) => r.beforeBytesEqualExpectation).length,
    beforeFails: completeness.filter((r) => r.beforeFailsComparator).map((r) => r.screenshot),
    beforeToAfterDifferent: completeness.filter((r) => r.beforeToAfter).length,
    rows: completeness } };
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ entries: entries.length, problems, completeness: { ...result.completeness, rows: undefined },
  registry: entries.map((r) => ({ screenshot: r.screenshot, beforeToAfter: r.beforeToAfter, p41SameCommit: r.p41SameCommit, originalsEqualP41: r.originalsEqualP41, beforeBytesEqualReplaced: r.beforeBytesEqualReplaced })) }, null, 1));
process.exitCode = problems.length ? 1 : 0;
