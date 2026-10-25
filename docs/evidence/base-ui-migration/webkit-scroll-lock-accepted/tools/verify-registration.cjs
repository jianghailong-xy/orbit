// Usage: node verify-registration.cjs <runs dir> <out.json>
// Re-checks the scroll-lock entries of p0-drift/accepted/registry.json against the runs they were made from,
// independently of register-accepted.cjs and expected-screenshots.mjs (p4.1-accepted/tools/verify-registration.cjs
// adapted to this batch). <runs dir> holds the same-commit-originals.sh runs before-15b7b5609 and after-b2568f28d
// and expected-pre/, the expectations the P0 globalSetup assembled at b2568f28d before the registration.
// For every entry of the batch: the decision fields are the cited CONFIRM of evidence revision 1 of
// 34cBi0yt6bFcSmbJFgDPj; the replaced expectation is the layer below the accepted one (main drift reference or
// P0.2 original, file hash = registry hash); before is 15b7b5609, the parent of the batch's first commit
// 78cae80d9, and after is b2568f28d, the merge that landed the batch (second parent b3e33e31d, the CONFIRMed
// evidence commit on branch head d49a8749b) on the project line, both on HEAD's first-parent line, and the batch's
// three files are the same in the landed tree as in the delivered one; both runs used the P0.2 environment; the
// before/after files in accepted/ are byte-identical to the runs' screenshots and to the recorded hashes; under the
// P0 comparator (maxDiffPixels 0) the before original matches the current expectation (for
// webkit-dark-phone/profile-validation the P4.1 accepted image) and the after original does not match the before
// original; the originals are byte-identical to the batch's own same-commit copies (webkit-scroll-lock/shots/p0,
// compare/p0-changed-webkit.json), and before -> after has the batch's pixel count and the same split into
// scrollbar / shift-4 / shift-8 / other pixels (shots/p0/classes.json). The earlier P4.1 entry of
// webkit-dark-phone/profile-validation is kept, unchanged, as `previous`; every other entry is as it was at
// b2568f28d. Completeness over all 252 screenshots: exactly the registered ones have an after original that fails
// the P0 comparator against the pre-registration expectation, and every before original matches it.
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
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
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
// The split of webkit-scroll-lock/tools/p0-shots.py: every differing pixel is the document scrollbar (the right
// 8px column or the corner pixel at (0,0)), equal to the before image shifted 4px or 8px right, or other.
// The `other` pixels are listed with their largest channel difference from the before image shifted 4px and 8px.
const classes = (beforePath, afterPath) => {
  const b = PNG.sync.read(readFileSync(beforePath)), a = PNG.sync.read(readFileSync(afterPath));
  const w = b.width, at = (img, x, y) => img.data.readUInt32BE((y * w + x) * 4);
  const delta = (x, y, dx) => {
    if (x < dx) return null;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[(y * w + x) * 4 + c] - b.data[(y * w + x - dx) * 4 + c]));
    return d;
  };
  const c = { scrollbar: 0, shift4: 0, shift8: 0, other: 0 }, other = [];
  for (let y = 0; y < b.height; y++) for (let x = 0; x < w; x++) {
    const v = at(a, x, y);
    if (v === at(b, x, y)) continue;
    if (x >= w - 8 || (x === 0 && y === 0)) c.scrollbar++;
    else if (x >= 4 && v === at(b, x - 4, y)) c.shift4++;
    else if (x >= 8 && v === at(b, x - 8, y)) c.shift8++;
    else { c.other++; other.push({ x, y, deltaVsShift4: delta(x, y, 4), deltaVsShift8: delta(x, y, 8) }); }
  }
  const box = other.length ? { x: Math.min(...other.map((p) => p.x)), y: Math.min(...other.map((p) => p.y)),
    width: Math.max(...other.map((p) => p.x)) - Math.min(...other.map((p) => p.x)) + 1, height: Math.max(...other.map((p) => p.y)) - Math.min(...other.map((p) => p.y)) + 1 } : null;
  return { counts: c, other: { box, maxDeltaVsShift4: Math.max(0, ...other.map((p) => p.deltaVsShift4 ?? 255)), pixels: other.length <= 12 ? other : undefined } };
};

const [runs, out] = process.argv.slice(2);
const TASK = '34cBi0yt6bFcSmbJFgDPj';
const DECISION = { taskId: TASK, evidenceRevision: 1,
  evidenceDigest: 'fdb19816d1e31af2dc3463fe3e359c68b7ba86084f284f24009f8b92dc468e7c', verdict: 'CONFIRM', document: 'webkit-scroll-lock/README.md' };
const BEFORE = '15b7b56093139c7b502e6618e9700ef78c9cccba', AFTER = 'b2568f28d8bb87d12eec762d1f810562503ed2d9';
// The batch as delivered on 15b7b5609 (the CONFIRMed evidence names these) and the merge that landed it.
const BATCH = { test: '78cae80d9', fix: '9f2f7e9a0', branchHead: 'd49a8749b', evidence: 'b3e33e31d' };
const BATCH_FILES = ['src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx', 'src/web/src/lib/toast.tsx', 'src/web/ui-migration/overlays-app-frame.browser.mjs'];
const SHOTS = ['webkit-dark-desktop/notification-error.png', 'webkit-dark-desktop/profile-validation.png', 'webkit-dark-desktop/settings-saved.png',
  'webkit-dark-phone/notification-error.png', 'webkit-dark-phone/profile-validation.png', 'webkit-dark-phone/settings-saved.png',
  'webkit-light-desktop/notification-error.png', 'webkit-light-desktop/profile-validation.png', 'webkit-light-desktop/settings-saved.png'];
const before = join(runs, 'before-15b7b5609'), after = join(runs, 'after-b2568f28d'), expectedPre = join(runs, 'expected-pre');
const batchEvidence = join(evidence, 'webkit-scroll-lock');
const environment = sha(join(evidence, 'p0.2/environment.json'));
const reference = Object.fromEntries(json(join(evidence, 'p0-drift/reference/registry.json')).screenshots.map((e) => [e.screenshot, e]));
const p02 = Object.fromEntries(json(join(evidence, 'p0.2/baseline-run/summary.json')).images
  .map(({ path, sha256 }) => [path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''), sha256]));
const registry = json(join(evidence, 'p0-drift/accepted/registry.json')).screenshots;
const registryAtAfter = JSON.parse(git('show', `${AFTER}:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json`)).screenshots;
const batchChanged = Object.fromEntries(json(join(batchEvidence, 'compare/p0-changed-webkit.json')).screenshots.map((r) => [r.screenshot, r]));
const batchClasses = json(join(batchEvidence, 'shots/p0/classes.json'));
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

const firstParent = git('rev-list', '--first-parent', 'HEAD').split('\n');
const parents = (c) => git('rev-list', '--parents', '-n', '1', c).split(' ').slice(1);
const full = Object.fromEntries(Object.entries(BATCH).map(([k, c]) => [k, git('rev-parse', c)]));
const commits = {
  head: git('rev-parse', 'HEAD'), batch: full,
  testParents: parents(full.test), fixParents: parents(full.fix), branchHeadParents: parents(full.branchHead), evidenceParents: parents(full.evidence),
  afterParents: parents(AFTER), afterSubject: git('log', '-1', '--format=%s', AFTER),
  batchFiles: git('diff', '--name-only', BEFORE, full.branchHead, '--', 'src/web', 'src/shared').split('\n'),
  batchFilesLandedAsDelivered: git('diff', '--name-only', full.branchHead, AFTER, '--', ...BATCH_FILES) === '',
  otherWebChangesBeforeToAfter: git('diff', '--name-only', BEFORE, AFTER, '--', 'src/web', 'src/shared').split('\n').filter((f) => !BATCH_FILES.includes(f)),
  projectLineBeforeToAfter: git('log', '--first-parent', '--format=%h %s', `${BEFORE}..${AFTER}`).split('\n'),
};
check(commits.testParents.join() === BEFORE, 'before is not the parent of the batch\'s first commit 78cae80d9');
check(commits.fixParents.join() === full.test, '9f2f7e9a0 does not follow 78cae80d9');
check(commits.branchHeadParents[0] === full.fix, 'the branch head d49a8749b does not follow 9f2f7e9a0');
check(commits.evidenceParents.join() === full.branchHead, 'the evidence commit b3e33e31d does not follow the branch head');
check(commits.afterParents[1] === full.evidence, 'after is not the merge that landed the batch\'s evidence commit');
check(commits.afterSubject === 'Merge refs/heads/orbit/webkit-1px-f604a9 into refs/heads/project/34ZZeq0e3IR65GVm2kAs7', `after subject ${commits.afterSubject}`);
check(JSON.stringify(commits.batchFiles) === JSON.stringify(BATCH_FILES), `batch files ${commits.batchFiles}`);
check(commits.batchFilesLandedAsDelivered, 'the batch files differ between the branch head and the landed tree');
check(firstParent.includes(BEFORE), 'before is not on the first-parent line of HEAD');
check(firstParent.includes(AFTER), 'after is not on the first-parent line of HEAD');

const runMeta = {};
for (const [label, dir, commit] of [['before', before, BEFORE], ['after', after, AFTER]]) {
  const m = json(join(dir, 'meta.json'));
  runMeta[label] = { commit: m.commit, environmentSha256: m.environmentSha256, environmentEqualsP02: m.environmentEqualsP02, screenshots: m.screenshots, exit: m.exit, stats: m.stats };
  check(m.commit === commit, `${label} run commit ${m.commit}`);
  check(m.environmentSha256 === environment && sha(join(dir, 'environment.json')) === environment, `${label} run environment`);
}

const ours = registry.filter((e) => e.decision?.taskId === TASK);
check(JSON.stringify(ours.map((e) => e.screenshot).sort()) === JSON.stringify(SHOTS), `batch entries ${ours.map((e) => e.screenshot)}`);
const atAfter = Object.fromEntries(registryAtAfter.map((e) => [e.screenshot, e]));
const others = registry.filter((e) => e.decision?.taskId !== TASK);
check(JSON.stringify(others) === JSON.stringify(registryAtAfter.filter((e) => !SHOTS.includes(e.screenshot))), 'the other entries differ from the registry at b2568f28d');
const entries = ours.map((e) => {
  const s = e.screenshot, ref = reference[s], earlier = atAfter[s];
  const below = ref ? { layer: 'p0-drift', sha256: ref.sha256, file: join(evidence, 'p0-drift/reference/screenshots', s) }
    : { layer: 'p0.2', sha256: p02[s], file: join(evidence, 'p0.2/screenshots', s) };
  const [project, name] = s.split('/');
  const files = { before: join(evidence, 'p0-drift/accepted/before', s), after: join(evidence, 'p0-drift/accepted/screenshots', s),
    runBefore: join(before, 'snapshots', s), runAfter: join(after, 'snapshots', s), expectedPre: join(expectedPre, s),
    batchBefore: join(batchEvidence, 'shots/p0', project, name.replace('.png', '-before.png')),
    batchAfter: join(batchEvidence, 'shots/p0', project, name.replace('.png', '-after.png')) };
  const row = { screenshot: s, decision: e.decision, replaces: e.replaces, mainCommits: ref?.mainCommits, sha256: e.sha256, sameCommit: e.sameCommit,
    previous: e.previous ?? null };
  check(JSON.stringify(e.decision) === JSON.stringify(DECISION), `${s}: decision ${JSON.stringify(e.decision)}`);
  check(existsSync(join(evidence, e.decision.document)), `${s}: decision document missing`);
  check(Boolean(e.difference && e.difference.trim()), `${s}: no difference text`);
  check(e.replaces.layer === below.layer && e.replaces.sha256 === below.sha256 && sha(below.file) === below.sha256, `${s}: replaces is not the layer below`);
  check(e.sameCommit.before.commit === BEFORE && e.sameCommit.after.commit === AFTER, `${s}: same-commit commits`);
  check(e.sameCommit.environment === environment, `${s}: environment`);
  // An earlier accepted entry moves, unchanged, into `previous`; no other screenshot had one.
  if (earlier) {
    row.earlierEntry = { taskId: earlier.decision.taskId, sha256: earlier.sha256 };
    check(JSON.stringify(e.previous) === JSON.stringify([...(earlier.previous ?? []),
      { sha256: earlier.sha256, decision: earlier.decision, difference: earlier.difference, sameCommit: earlier.sameCommit }]), `${s}: previous is not the earlier entry`);
    check(JSON.stringify(earlier.replaces) === JSON.stringify(e.replaces), `${s}: the earlier entry replaced a different expectation`);
  } else check(!e.previous, `${s}: has a previous entry but had none at b2568f28d`);
  const current = earlier ? earlier.sha256 : below.sha256;
  row.currentExpectation = { layer: earlier ? 'accepted' : below.layer, sha256: current };
  row.hashes = { acceptedBefore: sha(files.before), runBefore: sha(files.runBefore), acceptedAfter: sha(files.after), runAfter: sha(files.runAfter),
    expectedPre: sha(files.expectedPre), batchBefore: sha(files.batchBefore), batchAfter: sha(files.batchAfter) };
  check(row.hashes.acceptedBefore === e.sameCommit.before.sha256 && row.hashes.runBefore === e.sameCommit.before.sha256, `${s}: before original hash`);
  check(row.hashes.acceptedAfter === e.sha256 && row.hashes.runAfter === e.sha256 && e.sameCommit.after.sha256 === e.sha256, `${s}: after original hash`);
  check(row.hashes.expectedPre === current, `${s}: the pre-registration expectation is not the current expectation`);
  row.beforeMatchesCurrent = check(matches(files.before, files.expectedPre), `${s}: before original does not reproduce the current expectation`);
  row.beforeBytesEqualCurrent = row.hashes.acceptedBefore === current;
  row.afterDiffersFromBefore = check(!matches(files.after, files.before), `${s}: after original matches the before original`);
  row.beforeToAfter = pixels(files.before, files.after);
  const split = classes(files.before, files.after);
  row.classes = split.counts;
  row.otherPixels = split.other;
  const b = batchChanged[s];
  row.batchSameCommit = b ? { before: b.before, after: b.after, expected: b.expected, layer: b.layer, differentPixels: b.differentPixels, classes: batchClasses[s] } : null;
  check(b && b.differentPixels === row.beforeToAfter.differentPixels, `${s}: before -> after pixel count differs from the batch's compare/p0-changed-webkit.json`);
  check(JSON.stringify(batchClasses[s]) === JSON.stringify(row.classes), `${s}: the pixel classes differ from the batch's shots/p0/classes.json`);
  row.originalsEqualBatch = {
    beforeEqualsBatchBefore: check(row.hashes.acceptedBefore === row.hashes.batchBefore && b?.before === row.hashes.acceptedBefore, `${s}: before original differs from the batch's before capture`),
    afterEqualsBatchAfter: check(row.hashes.acceptedAfter === row.hashes.batchAfter && b?.after === row.hashes.acceptedAfter, `${s}: after original differs from the batch's after capture (d49a8749b)`),
    batchExpectedEqualsCurrent: check(b?.expected === current, `${s}: the expectation the batch compared with is not the current one`),
  };
  return row;
});

// Completeness over the 252 screenshots, against the expectations assembled before the registration.
const registered = new Set(ours.map((e) => e.screenshot));
const layerOf = (s) => atAfter[s] && atAfter[s].replaces.sha256 === (reference[s] ? reference[s].sha256 : p02[s]) ? 'accepted' : reference[s] ? 'p0-drift' : 'p0.2';
const completeness = Object.keys(p02).sort().map((s) => {
  const exp = join(expectedPre, s), a = join(after, 'snapshots', s), b = join(before, 'snapshots', s);
  const row = { screenshot: s, expectationLayer: layerOf(s), registered: registered.has(s) };
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
    beforeToAfterDifferent: completeness.filter((r) => r.beforeToAfter).map((r) => r.screenshot),
    rows: completeness } };
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ entries: entries.length, problems, commits: { ...commits, projectLineBeforeToAfter: commits.projectLineBeforeToAfter.length },
  completeness: { ...result.completeness, rows: undefined },
  registry: entries.map((r) => ({ screenshot: r.screenshot, current: r.currentExpectation.layer, beforeToAfter: r.beforeToAfter, classes: r.classes,
    otherBox: r.otherPixels.box, otherMaxDeltaVsShift4: r.otherPixels.maxDeltaVsShift4,
    originalsEqualBatch: r.originalsEqualBatch, beforeBytesEqualCurrent: r.beforeBytesEqualCurrent, previous: r.previous?.length ?? 0 })) }, null, 1));
process.exitCode = problems.length ? 1 : 0;
