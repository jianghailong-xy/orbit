// Usage: node verify-registration.cjs <runs dir> <P5.3 raw originals dir> <out.json>
// Re-checks the P5.3 entries of p0-drift/accepted/registry.json against the runs they were made from, independently
// of register-accepted.cjs and expected-screenshots.mjs (p4.1-accepted/tools/verify-registration.cjs adapted to P5.3).
// <runs dir> holds the same-commit-originals.sh runs before-8f94ddda9 and after-b72da6eda and expected-pre/, the
// expectations the P0 globalSetup assembled at the project tip a167c2ff0 before the registration. <P5.3 raw originals
// dir> holds P5.3's own round-f1 P0 page-matrix screenshots of the same two commits (p0-ref-shots, p0-del-shots),
// copied from /mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1/f1.
// For every P5.3 entry: the decision fields are the cited CONFIRM of P5.3 evidence revision 1; the replaced
// expectation is the main drift reference of that screenshot (file hash = registry hash); before is 8f94ddda9, P5.3's
// same-commit reference (its parent is the delivery b72da6eda and its change is exactly the revert of the business
// switch c868a02c2: patch-id and a rebuilt tree), after is b72da6eda, P5.3's delivery, landed on the project line by
// a167c2ff0 whose code is identical; both runs used the P0.2 environment; the before/after files in accepted/ are
// byte-identical to the runs' screenshots and to the recorded hashes; under the P0 comparator (maxDiffPixels 0) the
// before original matches the replaced expectation and the after original does not match the before original;
// before -> after equals P5.3's own same-commit data (compare/p0-summary.json) and the originals are compared with
// P5.3's raw originals. The registration leaves the other entries as they were at a167c2ff0. Completeness over all
// 252 screenshots: exactly the registered ones have an after original that fails the P0 comparator against the
// pre-registration expectation, and every before original matches it.
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
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const sh = (script, ...args) => execFileSync('bash', ['-c', script, repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
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
const patchId = (range) => sh('git -C "$0" diff "$1" "$2" | git -C "$0" patch-id --stable', ...range).split(' ')[0];

const [runs, p53raw, out] = process.argv.slice(2);
const DECISION = { taskId: '34Za39Ov1yysHZaYL6wgJ', evidenceRevision: 1,
  evidenceDigest: '6f0931ccd70e1d4f7d2b0920a9245931732498837a3cc9780c64b8cd928c01c2', verdict: 'CONFIRM', document: 'p5.3/README.md' };
const BEFORE = '8f94ddda9069bc2301fefc87f276570b04f4c774', AFTER = 'b72da6eda7656645c343e97bc73111c1499fab32';
const SWITCH = 'c868a02c2d27e97c59031623766114dbe9d9ae09', TIP = 'a167c2ff0e5bc728f2766f34c90a799c7e6a74a0';
const SHOTS = (process.env.SHOTS || '').split(/\s+/).filter(Boolean).sort();
const before = join(runs, 'before-8f94ddda9'), after = join(runs, 'after-b72da6eda'), expectedPre = join(runs, 'expected-pre');
const environment = sha(join(evidence, 'p0.2/environment.json'));
const reference = Object.fromEntries(json(join(evidence, 'p0-drift/reference/registry.json')).screenshots.map((e) => [e.screenshot, e]));
const p02 = Object.fromEntries(json(join(evidence, 'p0.2/baseline-run/summary.json')).images
  .map(({ path, sha256 }) => [path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''), sha256]));
const registry = json(join(evidence, 'p0-drift/accepted/registry.json')).screenshots;
const registryAtTip = JSON.parse(git('show', `${TIP}:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json`)).screenshots;
const p53Beyond = Object.fromEntries(json(join(evidence, 'p5.3/compare/p0-summary.json')).beyond.map((b) => [b.shot, b]));
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

// The two commits: before = after + the exact revert of the business switch; after landed on the project line.
const tipParents = git('rev-list', '--parents', '-n', '1', TIP).split(' ').slice(1);
const rebuilt = sh('t=$(mktemp) && GIT_INDEX_FILE=$t git -C "$0" read-tree "$1" && git -C "$0" diff "$2^" "$2" | GIT_INDEX_FILE=$t git -C "$0" apply --cached -R'
  + ' && GIT_INDEX_FILE=$t git -C "$0" write-tree; rm -f $t', AFTER, SWITCH);
const commits = {
  head: git('rev-parse', 'HEAD'),
  beforeParent: git('rev-parse', `${BEFORE}^`),
  beforeTree: git('rev-parse', `${BEFORE}^{tree}`),
  afterWithSwitchRevertedTree: rebuilt,
  switchPatchId: patchId([`${SWITCH}^`, SWITCH]),
  beforeToAfterPatchId: patchId([BEFORE, AFTER]),
  switchOnAfterFirstParent: git('rev-list', '--first-parent', AFTER).split('\n').includes(SWITCH),
  tipParents,
  // The task caught up with origin/main after its start (the project rule): HEAD then reaches the project tip through
  // main's promotion merge of the project line, not through its own first-parent line.
  tipOnProjectFirstParent: git('rev-list', '--first-parent', 'origin/project/34ZZeq0e3IR65GVm2kAs7').split('\n').includes(TIP),
  tipAncestorOfHead: sh('git -C "$0" merge-base --is-ancestor "$1" HEAD && echo yes || echo no', TIP) === 'yes',
  headFirstParentMergesOfTip: git('rev-list', '--first-parent', '--merges', '--parents', 'HEAD', '-n', '40').split('\n').filter((l) => l.split(' ').slice(2).includes(TIP)),
  afterIsFirstParentOfTipSecondParent: git('rev-parse', `${tipParents[1]}^`) === AFTER,
  afterAncestorOfHead: sh('git -C "$0" merge-base --is-ancestor "$1" HEAD && echo yes || echo no', AFTER) === 'yes',
  tipCodeEqualsAfter: git('diff', '--name-only', AFTER, TIP, '--', '.', ':!docs/evidence/base-ui-migration/p5.3') === '',
};
check(commits.beforeParent === AFTER, 'before is not a child of the delivery');
check(commits.beforeTree === commits.afterWithSwitchRevertedTree, 'before is not the delivery with exactly the switch reverted (rebuilt tree differs)');
check(commits.switchPatchId === commits.beforeToAfterPatchId, 'before -> after is not the business switch (patch-id)');
check(commits.switchOnAfterFirstParent, 'the switch is not on the delivery line');
check(commits.tipOnProjectFirstParent && commits.tipAncestorOfHead && commits.afterIsFirstParentOfTipSecondParent && commits.afterAncestorOfHead,
  'after is not the delivery landed on the project line by a167c2ff0, or HEAD does not contain it');
check(commits.tipCodeEqualsAfter, 'the tip differs from the delivery outside p5.3 evidence');

const runMeta = {};
for (const [label, dir, commit] of [['before', before, BEFORE], ['after', after, AFTER]]) {
  const m = json(join(dir, 'meta.json'));
  runMeta[label] = { commit: m.commit, environmentSha256: m.environmentSha256, environmentEqualsP02: m.environmentEqualsP02, screenshots: m.screenshots, exit: m.exit, stats: m.stats };
  check(m.commit === commit, `${label} run commit ${m.commit}`);
  check(m.environmentSha256 === environment && sha(join(dir, 'environment.json')) === environment, `${label} run environment`);
  check(m.screenshots === 252, `${label} run screenshots ${m.screenshots}`);
}

const ours = registry.filter((e) => e.decision?.taskId === DECISION.taskId);
check(JSON.stringify(ours.map((e) => e.screenshot).sort()) === JSON.stringify(SHOTS), `P5.3 entries ${ours.map((e) => e.screenshot)}`);
const others = registry.filter((e) => e.decision?.taskId !== DECISION.taskId);
check(JSON.stringify(others) === JSON.stringify(registryAtTip), 'the other entries differ from the registry at a167c2ff0');
const entries = ours.map((e) => {
  const s = e.screenshot, ref = reference[s];
  const files = { before: join(evidence, 'p0-drift/accepted/before', s), after: join(evidence, 'p0-drift/accepted/screenshots', s),
    reference: join(evidence, 'p0-drift/reference/screenshots', s), runBefore: join(before, 'snapshots', s), runAfter: join(after, 'snapshots', s),
    p53Reference: join(p53raw, 'p0-ref-shots', s), p53Delivery: join(p53raw, 'p0-del-shots', s) };
  const row = { screenshot: s, decision: e.decision, replaces: e.replaces, mainCommits: ref?.mainCommits, sha256: e.sha256, sameCommit: e.sameCommit, difference: e.difference };
  check(JSON.stringify(e.decision) === JSON.stringify(DECISION), `${s}: decision ${JSON.stringify(e.decision)}`);
  check(existsSync(join(evidence, e.decision.document)), `${s}: decision document missing`);
  check(Boolean(e.difference && e.difference.trim()), `${s}: no difference text`);
  check(!e.previous, `${s}: has an earlier accepted entry`);
  check(e.replaces.layer === 'p0-drift' && ref && e.replaces.sha256 === ref.sha256 && sha(files.reference) === ref.sha256, `${s}: replaces is not its main drift reference`);
  check(e.sameCommit.before.commit === BEFORE && e.sameCommit.after.commit === AFTER, `${s}: same-commit commits`);
  check(e.sameCommit.environment === environment, `${s}: environment`);
  row.hashes = { acceptedBefore: sha(files.before), runBefore: sha(files.runBefore), acceptedAfter: sha(files.after), runAfter: sha(files.runAfter),
    expectedPre: sha(join(expectedPre, s)), p53Reference: sha(files.p53Reference), p53Delivery: sha(files.p53Delivery) };
  check(row.hashes.acceptedBefore === e.sameCommit.before.sha256 && row.hashes.runBefore === e.sameCommit.before.sha256, `${s}: before original hash`);
  check(row.hashes.acceptedAfter === e.sha256 && row.hashes.runAfter === e.sha256 && e.sameCommit.after.sha256 === e.sha256, `${s}: after original hash`);
  check(row.hashes.expectedPre === ref.sha256, `${s}: the pre-registration expectation is not its main drift reference`);
  row.beforeMatchesReplaced = check(matches(files.before, files.reference), `${s}: before original does not reproduce the replaced expectation`);
  row.beforeBytesEqualReplaced = row.hashes.acceptedBefore === ref.sha256;
  if (!row.beforeBytesEqualReplaced) row.replacedToBefore = pixels(files.reference, files.before);
  row.afterDiffersFromBefore = check(!matches(files.after, files.before), `${s}: after original matches the before original`);
  row.beforeToAfter = pixels(files.before, files.after);
  const p = p53Beyond[s];
  row.p53SameCommit = p ? { pixels: p.pixels, max: p.max } : null;
  check(p && p.pixels === row.beforeToAfter.differentPixels && p.max === row.beforeToAfter.maxChannelDelta,
    `${s}: before -> after differs from P5.3 compare/p0-summary.json`);
  // P5.3's raw originals of the same two commits (its round f1): byte-identical, or Chromium noise that the comparator passes.
  row.originalsVsP53 = {
    beforeBytesEqualP53Reference: row.hashes.acceptedBefore === row.hashes.p53Reference,
    afterBytesEqualP53Delivery: row.hashes.acceptedAfter === row.hashes.p53Delivery,
  };
  if (!row.originalsVsP53.beforeBytesEqualP53Reference) row.originalsVsP53.before = { ...pixels(files.p53Reference, files.before), comparatorMatch: matches(files.before, files.p53Reference) };
  if (!row.originalsVsP53.afterBytesEqualP53Delivery) row.originalsVsP53.after = { ...pixels(files.p53Delivery, files.after), comparatorMatch: matches(files.after, files.p53Delivery) };
  check(row.originalsVsP53.beforeBytesEqualP53Reference || (s.startsWith('chromium') && row.originalsVsP53.before.comparatorMatch), `${s}: before original differs from P5.3's reference capture`);
  check(row.originalsVsP53.afterBytesEqualP53Delivery || (s.startsWith('chromium') && row.originalsVsP53.after.comparatorMatch), `${s}: after original differs from P5.3's delivery capture`);
  return row;
});

// Completeness over the 252 screenshots, against the expectations assembled before the registration.
const registered = new Set(ours.map((e) => e.screenshot));
const sourcesPre = json(join(expectedPre, 'sources.json'));
check(Object.keys(sourcesPre).length === 252, 'expected-pre/sources.json does not list 252 screenshots');
for (const s of registered) check(sourcesPre[s]?.layer === 'p0-drift', `${s}: the pre-registration expectation is not a main drift reference`);
const completeness = Object.keys(p02).sort().map((s) => {
  const exp = join(expectedPre, s), a = join(after, 'snapshots', s), b = join(before, 'snapshots', s);
  const row = { screenshot: s, expectationLayer: sourcesPre[s].layer, registered: registered.has(s) };
  check(sha(exp) === sourcesPre[s].sha256, `${s}: expected-pre file differs from its sources.json hash`);
  row.afterBytesEqualExpectation = existsSync(a) && sha(a) === sha(exp);
  row.afterFailsComparator = !existsSync(a) || !matches(a, exp);
  row.beforeBytesEqualExpectation = existsSync(b) && sha(b) === sha(exp);
  row.beforeFailsComparator = !existsSync(b) || !matches(b, exp);
  if (!row.afterBytesEqualExpectation && existsSync(a)) row.afterVsExpectation = pixels(exp, a);
  if (!row.beforeBytesEqualExpectation && existsSync(b)) row.beforeVsExpectation = pixels(exp, b);
  if (existsSync(a) && existsSync(b) && sha(a) !== sha(b)) row.beforeToAfter = { ...pixels(b, a), comparatorMatch: matches(a, b) };
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
    beforeToAfterComparatorFails: completeness.filter((r) => r.beforeToAfter && !r.beforeToAfter.comparatorMatch).map((r) => r.screenshot),
    rows: completeness } };
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ entries: entries.length, problems, commits, completeness: { ...result.completeness, rows: undefined },
  registry: entries.map((r) => ({ screenshot: r.screenshot, beforeToAfter: r.beforeToAfter, p53SameCommit: r.p53SameCommit, originalsVsP53: r.originalsVsP53, beforeBytesEqualReplaced: r.beforeBytesEqualReplaced })) }, null, 1));
process.exitCode = problems.length ? 1 : 0;
