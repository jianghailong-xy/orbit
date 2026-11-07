import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIKI_RECHECK, type WikiHistoryAnswerEntry } from '@orbit/shared';
import {
  WIKI_RECHECK_SYSTEM_PROMPT,
  wikiClaimPaths,
  wikiDecideRecheck,
  wikiEarliestSourceTime,
  wikiParseRecheckAnswer,
  wikiRecheckChallengeReason,
  wikiRecheckListed,
  wikiRecheckPrompt,
  wikiRecheckTerms,
  wikiRecheckWantsSecond,
  wikiScreenRank,
  wikiWrongWhenRecorded,
  type WikiRecheckEntry,
} from './wiki-recheck';

/**
 * The pure half of the claim recheck (contract `maintenance.job.server.recheck`, docs/wiki-claim-recheck-design.md):
 * the paths and terms of an entry, how far back its first screen looks, what a screen ranks it, the question, the
 * answer and the two asks. The fixtures are the entries the 2026-11-06 search review found wrong, as production
 * holds them: the sum_cache_read pitfall written after its fix, and the claims decision reversed the next morning.
 */

const SUM_CACHE_READ: WikiRecheckEntry = {
  id: '34ZfFGATAFiBBi9qmqPF7',
  kind: 'pitfall',
  title: 'session.sum_cache_read 是 int4，大会话会溢出卡死 turn-complete',
  summary: 'turn-complete 结算时累加 sum_cache_read，超过 2^31-1 时 Postgres 报 integer out of range，事务回滚导致 turn 永远 IN_FLIGHT，后续消息全部 queued。',
  fields: {
    cause: 'sum_cache_read 是 integer(int4) 上限 2147483647，长会话累积超限后整个 turn-complete 事务回滚',
    fix: '代码侧：删除 4 个 session.sum_* 列（迁移 0347），token 明细在 usage 表用 sum() 现算；紧急解堵：UPDATE session SET sum_cache_read=0 WHERE 原值锁定',
    symptom: '会话消息持续 queued，turn 卡 IN_FLIGHT，引擎已完成但服务端不 ack，runner 无限重试 5xx',
    trigger: {
      commands: [],
      errorSignature: 'integer out of range',
      paths: ['src/apiserver/src/runner-api/runner-api.controller.ts', './src/apiserver/prisma/schema.prisma/'],
    },
  },
  anchors: [
    { type: 'path', path: 'src/apiserver/src/runner-api/runner-api.controller.ts' },
    { type: 'path', path: 'src/apiserver/prisma/schema.prisma' },
    { type: 'commit', path: undefined },
  ],
  recordedAt: new Date('2026-10-03T19:17:38.808Z'),
};

const CLAIMS_DECISION: WikiRecheckEntry = {
  id: '34s2IFZlpqkEDdbKZwcj3',
  kind: 'decision',
  title: 'Claims feature deferred to wiki-claims-replay branch',
  summary: 'The wiki-memory claims feature failed its replay gates (G1, G2, G3) and was not merged to main; only the design doc landed, with code preserved on a feature branch.',
  fields: {
    alternatives: [{ option: 'Merge the claims code to main', whyRejected: 'Evidence gates G1, G2 and G3 all failed the fixed thresholds.' }],
    consequences: 'The claims feature remains off by default and inactive in production until the gates are re-evaluated.',
    context: 'The feature to surface memory-written claims in the wiki dossier was replayed on 100 production sessions and all primary evidence gates failed.',
    decidedAt: '2026-11-04',
    decision: "Land only the design document results in section 6.2 and keep the code on the feature branch wiki-claims-replay; do not start the 'claims live' rollout.",
  },
  anchors: [
    { type: 'path', path: 'docs/wiki-memory-claims-design.md' },
    { type: 'path', path: 'src/apiserver/src/wiki/wiki-dossier.ts' },
  ],
  recordedAt: new Date('2026-11-05T00:51:44.801Z'),
};

test('an entry is about its path and symbol anchors and a pitfall\'s trigger paths, cleaned and once each', () => {
  assert.deepEqual(wikiClaimPaths(SUM_CACHE_READ), [
    'src/apiserver/src/runner-api/runner-api.controller.ts',
    'src/apiserver/prisma/schema.prisma',
  ]);
  assert.deepEqual(wikiClaimPaths(CLAIMS_DECISION), ['docs/wiki-memory-claims-design.md', 'src/apiserver/src/wiki/wiki-dossier.ts']);
  // A decision's fields hold no trigger; a pitfall's paths that clean to nothing, or climb out, name nothing.
  assert.deepEqual(wikiClaimPaths({ kind: 'pitfall', anchors: [{ type: 'symbol', path: 'a/b.ts' }], fields: { trigger: { paths: ['../x', '/', 'a/b.ts', 'c/'] } } }), ['a/b.ts', 'c']);
  assert.deepEqual(wikiClaimPaths({ kind: 'convention', anchors: [{ type: 'commit' }], fields: {} }), []);
});

test('its terms are what it names in code, the strongest kinds first, at most eight', () => {
  const paths = wikiClaimPaths(SUM_CACHE_READ);
  assert.deepEqual(wikiRecheckTerms(SUM_CACHE_READ, paths), ['sum_cache_read', 'IN_FLIGHT', 'session.sum_cache_read', 'integer out of range']);
  // Prose with one hyphen is not a term; a name with two is.
  assert.deepEqual(wikiRecheckTerms(CLAIMS_DECISION, wikiClaimPaths(CLAIMS_DECISION)), ['wiki-claims-replay']);
  // SQL keywords, file names of its own paths and backticked phrases.
  const terms = wikiRecheckTerms({
    kind: 'convention',
    title: 'UPDATE wiki_entry SET claimState in wiki-dossier.ts',
    summary: 'Run `npm run build` first; OWNER_INTERACTIVE_ROUTES must list it',
    fields: { rule: 'see foo-bar-baz-qux and applyOp' },
  }, ['src/apiserver/src/wiki/wiki-dossier.ts']);
  assert.deepEqual(terms, ['wiki_entry', 'claimState', 'OWNER_INTERACTIVE_ROUTES', 'applyOp', 'foo-bar-baz-qux', 'npm run build']);
  const many = wikiRecheckTerms({ kind: 'pitfall', title: Array.from({ length: 12 }, (_, i) => `term_${i}`).join(' '), summary: '', fields: {} }, []);
  assert.equal(many.length, WIKI_RECHECK.termsMax);
});

test('a first screen looks back to the earliest UUIDv7 source before the recording, or to the recording', () => {
  const recorded = SUM_CACHE_READ.recordedAt;
  const sources = [
    { ref: 'fdeea9d5163d1e09b208cfbc60eaaf15933870cc' },
    { ref: '01a0fa83-ec99-7129-86ec-433fd81f319b' },
    { ref: '01a0fa0e-ecf2-76c8-b800-3efbd423ee08' },
  ];
  assert.equal(wikiEarliestSourceTime(sources, recorded).toISOString(), '2026-10-02T00:41:17.298Z');
  assert.equal(wikiEarliestSourceTime([], recorded).toISOString(), recorded.toISOString());
  // A source made after the recording (a later reinforce's) does not move the look-back forward.
  assert.equal(wikiEarliestSourceTime([{ ref: '01a1a81c-a52d-763d-89c5-2b81d04b1f76' }], recorded).toISOString(), recorded.toISOString());
});

test('the screen ranks a vanished term or a moved path 1, a changed count 2, a touched file 3, and a fresh entry 0', () => {
  const answer = (over: Partial<WikiHistoryAnswerEntry>): WikiHistoryAnswerEntry => ({ id: 'e', base: 'a'.repeat(40), census: [], moved: [], changed: false, ...over });
  assert.equal(wikiScreenRank(answer({ census: [{ term: 'sum_cache_read', base: 1, head: 0 }], changed: true }), false), 1);
  assert.equal(wikiScreenRank(answer({ moved: ['a.ts'], changed: true }), false), 1);
  assert.equal(wikiScreenRank(answer({ census: [{ term: 'IN_FLIGHT', base: 20, head: 29 }], changed: true }), false), 2);
  assert.equal(wikiScreenRank(answer({ census: [{ term: 'IN_FLIGHT', base: 20, head: 20 }], changed: true }), false), 3);
  assert.equal(wikiScreenRank(answer({ census: [{ term: 'IN_FLIGHT', base: 20, head: 20 }], changed: false }), false), null);
  assert.equal(wikiScreenRank(answer({ census: [{ term: 'x_y', base: 0, head: 2 }], changed: true }), true), 0);
  assert.equal(wikiScreenRank(answer({ changed: false }), true), null);
  assert.equal(wikiScreenRank({ id: 'e', error: 'no path' }, false), null);
});

test('the question shows the entry, the commits, the census, the lines and the diff, and states the four answers', () => {
  // A runner older than the changes answers none: the question has no CHANGES section and reads a vanished term as before.
  const answer: WikiHistoryAnswerEntry = {
    id: SUM_CACHE_READ.id,
    base: '1bfa9848b6' + '0'.repeat(30),
    baseDate: '2026-10-02T00:38:00+02:00',
    census: [{ term: 'sum_cache_read', base: 1, head: 0 }],
    moved: [],
    changed: true,
    commits: [{ sha: 'fdeea9d5163d1e09b208cfbc60eaaf15933870cc', date: '2026-10-02T06:15:47+02:00', subject: 'fix: drop overflowing lifetime token sums from session', matched: true }],
    commitsTotal: 41,
    lines: [],
    linesTotal: 0,
    diff: '--- a/src/apiserver/prisma/schema.prisma\n+++ b/src/apiserver/prisma/schema.prisma\n@@ -1,2 +1,1 @@\n-  sumCacheRead Int @map("sum_cache_read")\n',
    diffTruncated: false,
  };
  const prompt = wikiRecheckPrompt(SUM_CACHE_READ, {
    paths: wikiClaimPaths(SUM_CACHE_READ), baseIs: 'sources', head: { sha: '29739d60aa515f82732f6e64c701b2dce118594c', date: '2026-11-06T17:00:00+08:00' }, answer,
  });
  assert.match(prompt, /^ENTRY \(a pitfall, recorded 2026-10-03\)\nTitle: session\.sum_cache_read/u);
  assert.match(prompt, /COMMITS THAT CHANGED THESE FILES SINCE THE BASE \(1 of 41, newest first;/u);
  assert.match(prompt, /^\* fdeea9d5163d 2026-10-02 fix: drop overflowing lifetime token sums from session$/mu);
  // The entry's recording splits the commits: what came before is the history it was written from, its own fix among it.
  assert.match(prompt, /^--- the entry was recorded here, on 2026-10-03: the commits below came before it ---\n\* fdeea9d5163d /mu);
  assert.match(prompt, /occurs in none of its files now \(see the counts\), the entry describes code that is gone: answer fixed or obsolete/u);
  assert.match(prompt, /a pitfall that records its own fix \(its fix field\) holds while the code does what that fix says/u);
  assert.match(prompt, /If nothing in the material changes what the entry describes, it holds\./u);
  assert.match(prompt, /^- "sum_cache_read": 1 -> 0$/mu);
  assert.match(prompt, /Base: 1bfa9848b600 \(2026-10-02\), main as it was before the records this entry was written from\./u);
  assert.match(prompt, /Head: 29739d60aa51 \(2026-11-06\), main now\./u);
  assert.match(prompt, /LINES THAT HOLD A TERM NOW \(0 of 0\)\n\(none\)/u);
  assert.match(prompt, /-  sumCacheRead Int @map\("sum_cache_read"\)/u);
  assert.match(prompt, /"verdict": "holds" \| "fixed" \| "obsolete" \| "unsure"/u);
  const later = wikiRecheckPrompt(SUM_CACHE_READ, {
    paths: wikiClaimPaths(SUM_CACHE_READ), baseIs: 'check', head: { sha: '29739d60aa515f82732f6e64c701b2dce118594c', date: '2026-11-06T17:00:00+08:00' },
    answer: { ...answer, commits: [{ sha: 'b4619320b294f164c7cf7af9ebfd0225f4d25c6f', date: '2026-11-05T16:55:46Z', subject: 'fix(runner-api): a report can no longer hold a turn', matched: false }] },
  });
  assert.doesNotMatch(later, /the entry was recorded here/u);
  assert.match(later, /main as it was when this entry was last checked/u);
  assert.match(WIKI_RECHECK_SYSTEM_PROMPT, /Judge only from the material given/u);
  assert.doesNotMatch(prompt, /CHANGES/u);
  // The same entry and material ask the same bytes: the queue's identity is the request's.
  assert.equal(prompt, wikiRecheckPrompt(SUM_CACHE_READ, {
    paths: wikiClaimPaths(SUM_CACHE_READ), baseIs: 'sources', head: { sha: '29739d60aa515f82732f6e64c701b2dce118594c', date: '2026-11-06T17:00:00+08:00' }, answer,
  }));
});

test('with the changes, the question shows each one whole and reads a vanished term through the change that removed it', () => {
  const fix = 'fdeea9d5163d1e09b208cfbc60eaaf15933870cc';
  const later = 'b4619320b294f164c7cf7af9ebfd0225f4d25c6f';
  const answer: WikiHistoryAnswerEntry = {
    id: SUM_CACHE_READ.id,
    base: '1bfa9848b6' + '0'.repeat(30),
    baseDate: '2026-10-02T00:38:00+02:00',
    census: [{ term: 'sum_cache_read', base: 1, head: 0 }, { term: 'integer out of range', base: 0, head: 0 }],
    moved: [],
    changed: true,
    commits: [{ sha: later, date: '2026-11-05T16:55:46Z', subject: 'fix(runner-api): a report can no longer hold a turn', matched: false }],
    commitsTotal: 41,
    lines: [],
    linesTotal: 0,
    diff: '',
    diffTruncated: false,
    changes: [
      { sha: fix, date: '2026-10-02T06:15:47+02:00', subject: 'fix: drop overflowing lifetime token sums from session', terms: ['sum_cache_read'],
        body: 'The four lifetime sums overflowed int4; usage rows are summed instead.', diff: '--- a/src/apiserver/prisma/schema.prisma\n+++ b/src/apiserver/prisma/schema.prisma\n@@ -1,3 +1,2 @@\n model Session {\n-  sumCacheRead Int @map("sum_cache_read")\n }\n', diffTruncated: true },
    ],
    changesTotal: 3,
  };
  const entry = { ...SUM_CACHE_READ, fields: { ...SUM_CACHE_READ.fields, trigger: { paths: ['src/apiserver/src/runner-api/*.ts'] } } };
  const prompt = wikiRecheckPrompt(entry, {
    paths: wikiClaimPaths(entry), baseIs: 'sources', head: { sha: '29739d60aa515f82732f6e64c701b2dce118594c', date: '2026-11-06T17:00:00+08:00' }, answer,
  });
  assert.match(prompt, /^- src\/apiserver\/src\/runner-api\/\*\.ts \(a pattern: every file it matches\)$/mu);
  assert.match(prompt, /^- src\/apiserver\/prisma\/schema\.prisma$/mu);
  assert.match(prompt, new RegExp(`CHANGES: THE COMMITS THAT CHANGED HOW OFTEN A TERM OCCURS \\(1 of 3, newest first; each with its message and its own patch, ${WIKI_RECHECK.changeContext} lines of context`, 'u'));
  // The recording splits the changes as it splits the commits, and a change reads whole: terms, message, patch.
  assert.match(prompt, new RegExp('--- the entry was recorded here, on 2026-10-03: the commits below came before it ---\\n'
    + '=== fdeea9d5163d 2026-10-02 fix: drop overflowing lifetime token sums from session\\n'
    + 'Changed how often it holds: "sum_cache_read"\\n'
    + 'Message: The four lifetime sums overflowed int4; usage rows are summed instead\\.\\n'
    + '--- a/src/apiserver/prisma/schema\\.prisma\\n', 'u'));
  assert.match(prompt, /-  sumCacheRead Int @map\("sum_cache_read"\)\n \}\n\(patch cut\)\n/u);
  assert.match(prompt, /THE DIFF OF THESE FILES FROM THE BASE TO NOW \(hunks that mention a term first\)\n\(no difference\)/u);
  assert.match(prompt, /Answer fixed or obsolete only from a change the material shows, and name it: a commit of COMMITS or CHANGES\./u);
  assert.match(prompt, /read the change in CHANGES that removed it\. If it removed the code the entry describes, answer fixed or obsolete/u);
  assert.match(prompt, /If it only renamed, moved or deleted a test, a file or a name while the behaviour the entry describes is still in the LINES or the DIFF, the entry holds\./u);
  assert.doesNotMatch(prompt, /the entry describes code that is gone: answer fixed or obsolete/u);
  // No change, said so; a change without a parent shows no patch.
  const none = wikiRecheckPrompt(entry, {
    paths: wikiClaimPaths(entry), baseIs: 'check', head: { sha: '29739d60aa515f82732f6e64c701b2dce118594c', date: '2026-11-06T17:00:00+08:00' },
    answer: { ...answer, changes: [{ ...answer.changes![0]!, body: '', diff: '', diffTruncated: false }], changesTotal: 1 },
  });
  assert.match(none, /Message: \(no more than the subject\)\n\(no patch\)/u);
  assert.match(wikiRecheckPrompt(entry, { paths: [], baseIs: 'check', head: { sha: 'a'.repeat(40), date: '2026-11-06' }, answer: { ...answer, changes: [], changesTotal: 0 } }),
    /OCCURS \(0 of 0, newest first;[^\n]*\n\(none\)/u);
  // A fixed may name the commit of a change the commit list left out.
  assert.deepEqual(wikiRecheckListed(answer).map((commit) => commit.sha), [later, fix]);
  assert.equal(wikiParseRecheckAnswer('{"verdict": "fixed", "commit": "fdeea9d5163d", "reason": "0347 dropped it."}', wikiRecheckListed(answer)).commit?.sha, fix);
  assert.equal(wikiParseRecheckAnswer('{"verdict": "fixed", "commit": "fdeea9d5163d", "reason": "x"}', answer.commits).verdict, 'unsure');
});

test('an answer is read strictly: a fixed names a listed commit, anything unreadable is unsure', () => {
  const commits = [{ sha: 'fdeea9d5163d1e09b208cfbc60eaaf15933870cc', date: '2026-10-02T06:15:47+02:00', subject: 'fix: drop sums', matched: true }];
  const fixed = wikiParseRecheckAnswer('Looking at it.\n{"verdict": "fixed", "commit": "FDEEA9D5163D", "reason": "0347 dropped the column."}', commits);
  assert.deepEqual(fixed, { verdict: 'fixed', commit: { sha: commits[0]!.sha, date: commits[0]!.date, subject: 'fix: drop sums' }, reason: '0347 dropped the column.' });
  assert.equal(wikiParseRecheckAnswer('{"verdict": "fixed", "commit": "0123456789ab", "reason": "x"}', commits).verdict, 'unsure');
  assert.equal(wikiParseRecheckAnswer('{"verdict": "fixed", "commit": null, "reason": "x"}', commits).verdict, 'unsure');
  assert.deepEqual(wikiParseRecheckAnswer('{"verdict": "obsolete", "commit": "nothing", "reason": "gone"}', commits), { verdict: 'obsolete', commit: null, reason: 'gone' });
  assert.deepEqual(wikiParseRecheckAnswer('{"verdict": "holds", "commit": "fdeea9d5163d", "reason": "still there"}', commits), { verdict: 'holds', commit: null, reason: 'still there' });
  assert.equal(wikiParseRecheckAnswer('no json here', commits).verdict, 'unsure');
  assert.equal(wikiParseRecheckAnswer('{"verdict": "maybe"}', commits).verdict, 'unsure');
});

test('two answers make a verdict: a fixed or obsolete stands only when the second ask agrees', () => {
  const holds = { verdict: 'holds' as const, commit: null, reason: 'r' };
  const fixed = { verdict: 'fixed' as const, commit: { sha: 'f'.repeat(40), date: '2026-10-02T04:15:47Z', subject: 's' }, reason: 'fixed it' };
  const obsolete = { verdict: 'obsolete' as const, commit: null, reason: 'gone' };
  assert.equal(wikiRecheckWantsSecond(holds), false);
  assert.equal(wikiRecheckWantsSecond(fixed), true);
  assert.deepEqual(wikiDecideRecheck(holds, null), { ...holds, answers: ['holds'] });
  assert.deepEqual(wikiDecideRecheck(fixed, obsolete), { ...fixed, answers: ['fixed', 'obsolete'] });
  assert.deepEqual(wikiDecideRecheck(fixed, holds), { verdict: 'unsure', commit: null, reason: 'The first answer said fixed, the second holds.', answers: ['fixed', 'holds'] });
  assert.equal(wikiDecideRecheck(obsolete, null).verdict, 'unsure');
});

test('the challenge names the commit, says when the entry was wrong as it was written, and proposes Retire', () => {
  const commit = { sha: 'fdeea9d5163d1e09b208cfbc60eaaf15933870cc', date: '2026-10-02T06:15:47+02:00', subject: 'fix: drop overflowing lifetime token sums from session' };
  assert.equal(wikiWrongWhenRecorded(commit, SUM_CACHE_READ.recordedAt), true);
  assert.equal(wikiWrongWhenRecorded(commit, new Date('2026-10-01T00:00:00Z')), false);
  assert.equal(wikiWrongWhenRecorded(null, SUM_CACHE_READ.recordedAt), false);
  assert.equal(
    wikiRecheckChallengeReason({ verdict: 'fixed', head: '29739d60aa515f82732f6e64c701b2dce118594c', commit, reason: 'Migration 0347 dropped the column', wrongWhenRecorded: true, recordedAt: SUM_CACHE_READ.recordedAt }),
    'Claim recheck on origin/main at 29739d60aa51: fixed by fdeea9d5163d (2026-10-02, "fix: drop overflowing lifetime token sums from session"). '
      + 'Migration 0347 dropped the column. It was already so before this entry was recorded on 2026-10-03. '
      + 'Agents stop finding this entry in search until it is retired, re-confirmed or amended. Proposed answer: Retire.',
  );
  assert.match(wikiRecheckChallengeReason({ verdict: 'obsolete', head: 'a'.repeat(40), commit: null, reason: '', wrongWhenRecorded: false, recordedAt: new Date() }),
    /^Claim recheck on origin\/main at aaaaaaaaaaaa: obsolete\. Agents stop/u);
});
