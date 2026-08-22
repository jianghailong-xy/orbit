import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bare, column, headingNumbers, section, tableRows, tables } from './contract-doc';

// The Project Coordinator control loop is frozen in a document, not in code — units 03–23 have not
// been written yet, so there is nothing else here to assert against. A frozen document that
// nothing checks drifts silently: a renumbered section leaves twenty dangling cross-references, a
// state gets added to the state table and never to the transition table, a blocker kind quietly
// stops matching the error code it claims to inherit. None of that produces a compile error, and
// by the time unit 13 reads the wrong section the contract has already stopped being one.
//
// So this walks the two documents the way `public-id-coverage.spec.ts` walks schema.prisma: it
// does not judge the design, it only holds the document to the internal consistency the document
// itself claims. Everything asserted here is a property the contract states about itself.
//
// Since v1.1 it also holds the contract to unit 02's review: §19 has to answer every finding that
// review raised, and the answers have to be wired to tests that exist. The counter-examples
// themselves live in `coordinator-counterexample.spec.ts`; what is checked here is that the
// document and those tests still refer to the same rules. v1.2 does the same for the second review
// and §20 — deliberately as a second, separate assertion rather than a loop over both, because the
// two rounds must stay independently checkable: a revision that closes round two by quietly
// dropping a round-one finding is exactly what these two tests exist to refuse.
const REPO = path.resolve(__dirname, '../../../..');
const PCC = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
const REVIEW = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02.md'), 'utf8');
const REVIEW_V11 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.1.md'), 'utf8');
const REVIEW_V12 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.2.md'), 'utf8');
const COUNTEREXAMPLES = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');

const REVIEW_V13 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.3.md'), 'utf8');
const REVIEW_V14 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.4.md'), 'utf8');
const REVIEW_V15 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.5.md'), 'utf8');
const REVIEW_V16 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.6.md'), 'utf8');
const REVIEW_V17 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.7.md'), 'utf8');
const REVIEW_V18 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.8.md'), 'utf8');
const REVIEW_V19 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.9.md'), 'utf8');
const REVIEW_V110 = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.10.md'), 'utf8');
/** §1–§18: the normative body. §19–§26 are revision logs and are explicitly non-normative (§0 RL1). */
const NORMATIVE = PCC.slice(0, PCC.indexOf('\n## 19. '));
/**
 * The §7.2 turn-reason table. §7.2 holds three tables (the mechanical/semantic split, the reasons,
 * and TF4's generation map), so address it by its headers: `tableRows` would concatenate all three
 * and TF4's first column is also `reasonCode`, which makes a positional read silently wrong.
 */
function turnReasonTable(): string[][] {
  const found = tables(section(PCC, '7.2')).find((t) => t[0].some((h) => bare(h) === '触发条件'));
  assert.ok(found, '§7.2 no longer states the turn-reason table');
  return found;
}

/**
 * 一 … 九十九, as the contract writes them. The count outgrew a single digit at v1.15 (eight columns
 * became ten), and a one-character lookup would have read 十 as "not found" — i.e. as zero — which
 * is the failure mode where a consistency check quietly stops checking.
 */
function chineseNumeral(word: string): number {
  const digits = '零一二三四五六七八九';
  const ten = word.indexOf('十');
  if (ten === -1) return digits.indexOf(word);
  const tens = ten === 0 ? 1 : digits.indexOf(word.slice(0, ten));
  const ones = ten === word.length - 1 ? 0 : digits.indexOf(word.slice(ten + 1));
  return tens * 10 + ones;
}

test('every cross-reference into the frozen Project/Agent contract resolves', () => {
  const pacHeadings = headingNumbers(PAC);
  const refs = new Set(Array.from(PCC.matchAll(/PAC §(\d+(?:\.\d+)?)/g), (m) => m[1]));
  assert.ok(refs.size > 10, 'expected the coordinator contract to build on PAC');
  for (const ref of refs) {
    assert.ok(pacHeadings.has(ref), `PAC §${ref} is referenced but project-agent-contract.md has no such section`);
  }
});

test('every internal section reference resolves', () => {
  const own = headingNumbers(PCC);
  // `§n` not preceded by `PAC ` — the same glyph is used for both, and only the prefix tells them
  // apart, so the lookbehind is the whole check.
  const refs = new Set(Array.from(PCC.matchAll(/(?<!PAC )§(\d+(?:\.\d+)?)/g), (m) => m[1]));
  for (const ref of refs) {
    assert.ok(own.has(ref), `§${ref} is referenced but this document has no such section`);
  }
});

test('the run state is decided by an ordered, total guard function over the seven states', () => {
  const declared = tableRows(section(PCC, '4.1'))
    .slice(1)
    .map((cells) => bare(cells[0]));
  assert.equal(declared.length, 7, 'the run state machine is frozen at seven states');
  assert.ok(declared.includes('PLANNING'), 'PLANNING is the state AC3 is stated against');

  // v1 stated legality as a hand-written transition table, and unit 02 showed that table is both
  // incomplete and self-contradictory on a mixed blocker set (PC-CX-03). v1.1 replaces it with a
  // guard function, so what has to hold now is that the guards are ordered, total, and cover every
  // declared state exactly once — order-independence then follows by construction.
  const guards = tables(section(PCC, '4.2'))[0];
  const targets = column(guards, 'run_state').map(bare);
  assert.equal(targets.length, 7, 'one guard per state');
  assert.deepEqual([...targets].sort(), [...declared].sort(), 'the guards and the state table have drifted apart');
  assert.equal(new Set(targets).size, 7, 'two guards yield the same state, so the first hides the second');
  assert.equal(targets[targets.length - 1], 'PLANNING', 'the fallback guard must be the state defined as "none of the above"');
  assert.match(column(guards, '守卫（只读 §6.1 的快照）').at(-1)!, /恒真/, 'the last guard must be total, or some snapshot has no state');
});

test('blocker kinds are unique, and the ones claiming to come from PAC §12 really do', () => {
  const pacCodes = new Set(
    tableRows(section(PAC, '12'))
      .slice(1)
      .map((cells) => bare(cells[0])),
  );
  const rows = tableRows(section(PCC, '11.2'));
  const kinds = column(rows, 'kind').map(bare);
  const sources = column(rows, '来源');
  const owners = column(rows, '默认 owner').map(bare);
  const recoveries = column(rows, 'recovery').map(bare);
  const nextChecks = column(rows, '默认 next_check_at');

  assert.equal(new Set(kinds).size, kinds.length, 'duplicate blocker kind');
  const inherited = kinds.filter((_, i) => sources[i] === 'PAC §12');
  assert.ok(inherited.length >= 6, 'the refusal codes are supposed to be reused, not renamed');
  for (const kind of inherited) {
    assert.ok(pacCodes.has(kind), `${kind} claims to be a PAC §12 refusal code but is not one`);
  }
  // Every blocker must be able to answer §11.1's five questions, so every row needs an owner, a
  // recovery and a next check — a blocker without any of them is exactly the silent stall this
  // project exists to end, and one without a recovery is the clock conflict of PC-CX-05.
  for (let i = 0; i < kinds.length; i++) {
    assert.match(owners[i], /^(USER|COORDINATOR|SYSTEM)$/, `${kinds[i]} has no owner`);
    assert.match(recoveries[i], /^(TIME|EVENT|HUMAN)$/, `${kinds[i]} has no recovery class`);
    assert.ok(nextChecks[i].length > 0, `${kinds[i]} has no next check`);
  }
});

test('BL4 holds: the blockers that open a coordinator turn are exactly the ones it owns', () => {
  // PC-CX-06 was two rules reading two different columns and disagreeing. The fix is only a fix if
  // the two columns cannot drift, so this compares all three places the same fact is written.
  const rows = tableRows(section(PCC, '11.2'));
  const kinds = column(rows, 'kind').map(bare);
  const owners = column(rows, '默认 owner').map(bare);
  const opens = column(rows, 'opensTurn').map(bare);

  const ownedByCoordinator = kinds.filter((_, i) => owners[i] === 'COORDINATOR').sort();
  const opensTurn = kinds.filter((_, i) => opens[i] === '✔').sort();
  assert.deepEqual(opensTurn, ownedByCoordinator, 'BL4: opensTurn = ✔ must be exactly owner = COORDINATOR');

  // v1.4 gave the turn-reason table an order column and added a second table (TF4), so address it
  // by header rather than by position: `tableRows` concatenates every table in the section, and the
  // TF4 table also has a `reasonCode` first column — reading the wrong one silently yields [].
  const reasons = turnReasonTable();
  const conditions = column(reasons, '触发条件');
  const at = column(reasons, 'reasonCode').map(bare).indexOf('BLOCKER_DECISION');
  assert.ok(at >= 0, '§7.2 no longer names the blocker-driven turn trigger');
  const listed = (/\{([^}]+)\}/.exec(conditions[at])?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean).sort();
  assert.deepEqual(listed, ownedByCoordinator, '§7.2 and §11.2 disagree about which blockers open a turn');
  assert.ok(!listed.includes('TEST_FAILED'), 'a task failure must never be on the turn-opening list (TU2)');
});

test('every action has a distinct idempotency key template', () => {
  const rows = tableRows(section(PCC, '7.3'))
    .slice(1)
    .map((cells) => ({ type: bare(cells[0]), key: bare(cells[2]) }))
    .filter((r) => /^[A-Z_]+$/.test(r.type));
  assert.ok(rows.length >= 10, 'the action set is frozen and closed');
  const keys = rows.map((r) => r.key).filter((k) => k.startsWith('pc:v1:'));
  assert.equal(new Set(keys).size, keys.length, 'two actions share an idempotency key template');
  for (const key of keys) {
    assert.match(key, /^pc:v1:<projectId>:[a-z-]+:/, `${key} does not follow the frozen key format`);
  }
});

test('all twelve project acceptance criteria are mapped, each classified and each assigned', () => {
  const rows = tableRows(section(PCC, '14'))
    .slice(1)
    .filter((cells) => /^\*\*AC\d+\*\*$/.test(cells[0]));
  assert.equal(rows.length, 12, 'the project states twelve acceptance criteria');
  assert.deepEqual(
    rows.map((cells) => cells[0]),
    Array.from({ length: 12 }, (_, i) => `**AC${i + 1}**`),
    'the mapping table skips or reorders an acceptance criterion',
  );
  for (const cells of rows) {
    const [ac, , clause, classification, units, tests] = cells;
    assert.ok(clause.includes('§'), `${ac} maps to no clause of this contract`);
    assert.match(classification, /业务|基础设施|复用/, `${ac} is not classified`);
    assert.match(units, /\d+/, `${ac} names no unit`);
    assert.ok(tests.length > 20, `${ac} names no test that would prove it`);
  }
});

test('the business/infrastructure split matches the totals the contract states', () => {
  const businessFields = tableRows(section(PCC, '2.2')).slice(1).length;
  const infraTables = tables(section(PCC, '2.4'))[0].length - 1;
  const total = /业务字段 \*\*(\d+) 个\*\*.*新业务实体 \*\*(\d+) 个\*\*.*新基础设施表 \*\*(\d+) 张\*\* \+ 新列 \*\*(\d+) 个\*\*/.exec(
    section(PCC, '14'),
  );
  assert.ok(total, 'the mapping table no longer states its totals');
  assert.equal(Number(total[1]), businessFields, '§2.2 and the §14 total disagree on business fields');
  assert.equal(Number(total[2]), 0, 'the contract forbids new business entities (§2.3)');
  assert.equal(Number(total[3]), infraTables, '§2.4 and the §14 total disagree on infrastructure tables');
  // The column count is the one that moved in v1.1 (session.dispatch_origin), and it is the number
  // a reviewer checks the migration against, so it has to be stated in one place only.
  const columns = /以及([一二三四五六七八九十]+)列：/.exec(section(PCC, '2.4'));
  assert.ok(columns, '§2.4 no longer states how many columns it adds');
  assert.equal(chineseNumeral(columns[1]), Number(total[4]), '§2.4 and §14 disagree on new columns');
});

test('no infrastructure table is a business entity in disguise', () => {
  // §2.3's own test: a table carrying a title, a goal or acceptance criteria is a thing a person
  // is trying to achieve, and this project is not allowed to add one.
  for (const cells of tables(section(PCC, '2.4'))[0].slice(1)) {
    const [table, , judgement] = cells;
    assert.doesNotMatch(
      judgement + table,
      /`?(title|goal|acceptance_criteria)`?/,
      `${table} looks like a business entity`,
    );
  }
});

test('§19 answers every finding unit 02 raised, and names a test that exists for each', () => {
  // The review is evidence, not a to-do list that can be edited down: it is read here, never
  // written. If a future revision drops a finding from §19, or points at a test nobody wrote, this
  // is the assertion that says so.
  const raised = new Set(Array.from(REVIEW.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  assert.equal(raised.size, 8, 'unit 02 raised eight findings');

  // §19's own subsections carry tables too, so take only the summary table at the top.
  const rows = tables(section(PCC, '19'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, [...raised].sort().map((n) => `PC-CX-${n}`), '§19 does not answer exactly the findings raised');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    // Every finding must land on a clause of this contract, not merely on prose in §19.
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);
    // …and on a test that can actually be run.
    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    // Each finding gets its own worked-through subsection: interleaving, state, key, recovery.
    const detail = section(PCC, `19.${i + 1}`);
    for (const heading of ['最小交错序列', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§19.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('§20 answers every finding unit 02 raised against v1.1, and names a test that exists', () => {
  // The second review is read the same way the first one is: as evidence. Its findings are
  // numbered from 09, and it also refers back to `PC-CX-01..08`, so the new ones are the ones
  // above 08 — and the old ones must still be answered where they always were, in §19.
  const cited = new Set(Array.from(REVIEW_V11.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 8).sort();
  assert.deepEqual(raised, ['09', '10', '11', '12', '13', '14'], 'unit 02 raised six findings against v1.1');

  const rows = tables(section(PCC, '20'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§20 does not answer exactly the findings raised');
  const answeredIn19 = column(tables(section(PCC, '19'))[0], 'ID').map(bare);
  assert.equal(ids.some((id) => answeredIn19.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    // Every finding gets the same six answers worked through. The Postgres heading is the one v1.2
    // adds: five of these six findings turned on what the database actually guarantees, and a
    // revision that does not say which guarantee it is leaning on has not answered them.
    const detail = section(PCC, `20.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§20.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('§21 answers every finding unit 02 raised against v1.2, and names a test that exists', () => {
  // Round three, read the same way as the first two. Its findings are numbered from 15, and the
  // report refers back to the earlier ones, so the new ones are the ones above 14.
  const cited = new Set(Array.from(REVIEW_V12.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 14).sort();
  assert.deepEqual(raised, ['15', '16', '17', '18', '19', '20'], 'unit 02 raised six findings against v1.2');

  const rows = tables(section(PCC, '21'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§21 does not answer exactly the findings raised');
  const answeredEarlier = [...column(tables(section(PCC, '19'))[0], 'ID'), ...column(tables(section(PCC, '20'))[0], 'ID')].map(bare);
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `21.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§21.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('every permanent action key names a generation the contract can point at', () => {
  // §8.2 GE1 is the generalisation of PC-CX-16/17: three keys were broken in the same way, so the
  // rule has to hold for the whole action set rather than for the three that were found. What can
  // be checked from the document is the correspondence — every keyed action appears in GE1's
  // table, and the key template ends in the epoch GE1 says it does.
  const keyed = tableRows(section(PCC, '7.3'))
    .slice(1)
    .map((cells) => ({ type: bare(cells[0]), key: bare(cells[2]) }))
    .filter((r) => /^[A-Z_]+$/.test(r.type) && r.key.startsWith('pc:v1:'));
  const ge1 = tables(section(PCC, '8.2'))[0];
  const actions = column(ge1, '动作').map(bare);
  assert.ok(actions.length >= keyed.length, 'GE1 must cover at least every action that has a key');
  for (const action of keyed) {
    assert.ok(actions.includes(action.type), `${action.type} has a permanent key but GE1 does not give it a generation`);
  }
  // …and the two actions GE1 exempts have to be exactly the two it says it exempts.
  const noKey = tableRows(section(PCC, '7.3'))
    .slice(1)
    .map((cells) => ({ type: bare(cells[0]), key: bare(cells[2]) }))
    .filter((r) => /^[A-Z_]+$/.test(r.type) && !r.key.startsWith('pc:v1:'));
  assert.deepEqual(noKey.map((r) => r.type).sort(), ['AGGREGATE_PARENT', 'NOOP', 'SCHEDULE_WAKE'], 'the set of unkeyed actions changed');
});

test('one action, one key template — everywhere the normative text states one', () => {
  // Unit 02's third review closed with a follow-up item this implements: a static check that a rule
  // marked "closed" or "unique" has no surviving sentence from the version it replaced. §9.4 kept a
  // deleted escalation ladder for two rounds and contradicted §11.5 the whole time; the same shape
  // is available to any action key, since the key appears in a dozen places and only one of them is
  // the table. So: outside the revision logs (§19–§21, which record what was true then), every
  // `pc:v1:` template must be the one §7.3 freezes for that action.
  const canonical = new Map<string, string>();
  for (const cells of tableRows(section(PCC, '7.3')).slice(1)) {
    const key = bare(cells[2]);
    const m = /^pc:v1:<projectId>:([a-z-]+):(.*)$/.exec(key);
    if (m) canonical.set(m[1], key);
  }
  assert.ok(canonical.size >= 6, '§7.3 no longer states key templates');

  let body = PCC;
  for (const log of ['19', '20', '21']) body = body.replace(section(PCC, log), '');
  for (const [line, template] of body
    .split('\n')
    .flatMap((l) => Array.from(l.matchAll(/pc:v1:<p(?:rojectId)?>:[a-z-]+:[^`\s]+/g), (m) => [l, m[0]] as [string, string]))) {
    const scope = /^pc:v1:<p(?:rojectId)?>:([a-z-]+):/.exec(template)![1];
    const expected = canonical.get(scope);
    assert.ok(expected, `${template} names an action scope §7.3 does not have`);
    assert.equal(
      template.replace('<p>', '<projectId>'),
      expected,
      `a superseded key template survives outside the revision logs:\n${line}`,
    );
  }
});

test('the reviews are read, never edited: all three are still the documents that were signed off', () => {
  // The hard constraint on both revision units was "do not edit the review to make the failure go
  // away". Nothing here can prove a file was not edited, but it can pin the two things a revision
  // would be tempted to soften: the verdicts, and the count of findings behind them.
  assert.match(REVIEW, /FAIL/, 'the first review found the contract wanting; that is a fact, not a draft');
  assert.match(REVIEW_V11, /FAIL/, 'so did the second');
  assert.match(REVIEW_V12, /FAIL/, 'and the third');
  assert.equal(new Set(Array.from(REVIEW.matchAll(/PC-CX-(\d\d)/g), (m) => m[1])).size, 8);
  assert.equal(
    [...new Set(Array.from(REVIEW_V11.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 8).length,
    6,
  );
  assert.equal(
    [...new Set(Array.from(REVIEW_V12.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 14).length,
    6,
  );
});

test('the P0 findings are answered by a database constraint, not by application code', () => {
  // PC-CX-01 and PC-CX-02 are both "two entry points, one of which this binary does not control".
  // A fix that lives in a service is not a fix for either, so §2.4 has to keep listing the two
  // objects the database itself enforces, and §12.1 has to keep creating them.
  const objects = tables(section(PCC, '2.4'))[1];
  const names = column(objects, '对象').map(bare);
  // The two the P0s turn on are pinned by position, because a revision that reorders or replaces
  // them is a revision that has changed what answers PC-CX-01/02. Later rounds append.
  assert.deepEqual(names.slice(0, 2), ['session_task_execution_claim_idx', 'session_dispatch_authority_guard']);
  assert.deepEqual(column(objects, '类型').map(bare).slice(0, 2), ['partial unique index', 'BEFORE INSERT trigger']);
  assert.equal(new Set(names).size, names.length, 'two rows name the same database object');

  const migration = section(PCC, '12.1');
  for (const object of names) {
    assert.ok(migration.includes(object), `${object} is frozen in §2.4 but never created by the migration`);
  }
  // D5-c: the index cannot be created over rows that already violate it.
  assert.match(migration, /3b/, 'the migration must converge existing duplicate claims before adding the index');

  // PC-CX-09 is the same trigger read one round later: it was there, it just read a snapshot. The
  // two words that fix it are invisible in `pg_trigger`, in `migrate diff` and in any type check,
  // so the only place they can be held is here and in the migration's own verification.
  assert.match(section(PCC, '7.7'), /FOR SHARE/, 'the authority guard must take a lock that conflicts with the flip');
  assert.match(migration, /FOR SHARE/, 'and the migration must be verified for it, not just for the trigger existing');
});

// ---------------------------------------------------------------------------------------------
// v1.4 — `PC-CX-21..27`
// ---------------------------------------------------------------------------------------------

test('§22 answers every finding unit 02 raised against v1.3, and names a test that exists', () => {
  // Round four, read exactly the way the first three are: as evidence. Its findings are numbered
  // from 21, and the report refers back to the earlier ones, so the new ones are the ones above 20.
  const cited = new Set(Array.from(REVIEW_V13.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 20).sort();
  assert.deepEqual(raised, ['21', '22', '23', '24', '25', '26', '27'], 'unit 02 raised seven findings against v1.3');

  const rows = tables(section(PCC, '22'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§22 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21'].flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `22.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§22.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the four reviews are read, never edited', () => {
  // Same pin as the three-review version above, extended to round four. Nothing here can prove a
  // file was not edited; what it pins is the two things a revision would be tempted to soften.
  assert.match(REVIEW_V13, /FAIL/, 'the fourth review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V13.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 20).length,
    7,
  );
});

test('the revision logs are marked non-normative, and only they may quote a superseded rule', () => {
  // PC-CX-27: §9.4 carried a deleted escalation ladder for two rounds, and v1.3 answered it with a
  // static check that scanned §9.4 and §11.5 — the two places it already knew about. A 2000-line
  // contract states each rule in five or six places, so "look harder next time" is not a mechanism.
  // §0 RL1 plus §22.8's ledger is: every superseded sentence is registered, and a line quoting one
  // must carry its provenance (a version number or the finding id). A line that quotes one without
  // provenance is a rule that is still alive.
  for (const n of ['19', '20', '21', '22', '23']) {
    const body = section(PCC, n);
    assert.match(body.split('\n').slice(0, 4).join('\n'), /本节是非规范的/, `§${n} is not marked non-normative`);
  }

  const ledger = tables(section(PCC, '22.8'))[0];
  const phrases = column(ledger, '被取代的字样').map(bare);
  assert.ok(phrases.length >= 12, '§22.8 no longer registers every superseded sentence (v1.5 added six)');
  for (const phrase of phrases) {
    assert.ok(PCC.includes(phrase), `the ledger registers "${phrase}", which appears nowhere at all — a typo makes the row a no-op`);
    for (const [i, line] of NORMATIVE.split('\n').entries()) {
      if (!line.includes(phrase)) continue;
      assert.match(
        line,
        /v1\.[1-5]|PC-CX-\d\d/,
        `a superseded rule is alive in the normative body (§22.8 registers "${phrase}"):\n  line ${i + 1}: ${line.trim()}`,
      );
    }
  }
  // …and the two the fourth review actually caught have to be gone, not merely provenance-tagged.
  assert.doesNotMatch(section(PCC, '13.1'), /幂等键的 epoch 取子状态摘要，§8\.2/, 'AG1 still prescribes the removed aggregate key');
  assert.doesNotMatch(section(PCC, '13.4'), /持有 AE6 那把 `FOR SHARE`/, 'AE8 still prescribes the deadlocking v1.2 lock');
});

test('I11 is stated with a tense: one standing half, one commit-time half', () => {
  // PC-CX-21 has no ledger row on purpose (§22.8 says why): nothing was mis-worded, an invariant
  // was stated in a tense that the system's own normal operation falsifies. What can be held is
  // the shape of the replacement — and that every clause reading it reads the standing half.
  const invariants = section(PCC, '4.3');
  assert.match(invariants, /\*\*I11-A（归属，恒成立）\*\*/, '§4.3 does not state the standing half of I11');
  assert.match(invariants, /\*\*I11-B（提交时授权，点态）\*\*/, '§4.3 does not state the commit-time half of I11');
  assert.match(invariants, /action\.fencing_token <= project_runtime\.fencing_token/, 'the standing half must be the monotone relation, not the equality');
  assert.match(section(PCC, '10.3'), /I11-A/, '§10.3 (a) must lean on the standing half; the equality is false after the next lease');
  assert.match(section(PCC, '8.1'), /\*\*F0/, '§8.1 must say what the fencing token answers, next to the lease itself');

  // The rows D9 reads must each have a closed mutator protocol, or "proved at commit" decays back
  // into "proved at insert" — the lesson PC-CX-09 and PC-CX-20 already charged twice for.
  const dispatch = section(PCC, '7.7');
  assert.match(dispatch, /#### D10 · 占位期间 Task 不得跨 Project 移动/, 'task.project_id has no mutator protocol');
  assert.match(dispatch, /#### D11 · 动作行的状态转移与终态不可改写/, 'project_action has no mutator protocol');
  assert.match(dispatch, /\*\*D9-e/, 'D9 does not say which of its predicates is commit-time only');
});

test('the turn reasons are a total order, and at most one turn comes out of one input', () => {
  // PC-CX-23, checked the way PC-CX-03 is: the fix is only a fix if the order is stated in the
  // document as an ordered, total column — a prose sentence about priority drifts from the table.
  const rows = turnReasonTable();
  const order = column(rows, '序').map(bare);
  const codes = column(rows, 'reasonCode').map(bare);
  assert.deepEqual(order, ['1', '2', '3', '4', '5', '6'], '§7.2 no longer orders the turn reasons');
  assert.deepEqual(
    codes,
    ['MANUAL', 'VERDICT', 'TASK_FAILURE', 'BLOCKER_DECISION', 'ACCEPTANCE', 'REPLAN'],
    'the frozen total order changed',
  );
  assert.equal(new Set(codes).size, codes.length, 'two rows share a reasonCode');
  assert.match(section(PCC, '7.2'), /\*\*TU4（唯一裁决：首个为真者胜/, '§7.2 states the order but not the rule that reads it');
  assert.match(section(PCC, '4.3'), /\*\*I15/, 'the "at most one semantic turn" invariant is not stated');

  // PC-CX-24: every reason drawn from a row that has a lifecycle must carry that row's generation,
  // or a cleared-and-recurring episode collides with the turn key of the episode before it.
  const tf4 = tables(section(PCC, '7.2')).find((t) => t[0][0].replace(/[`*]/g, '').trim() === 'reasonCode' && t[0].length === 3);
  assert.ok(tf4, 'TF4 no longer lists which reasons carry a generation');
  assert.deepEqual(
    column(tf4, 'reasonCode').map(bare).sort(),
    ['ACCEPTANCE', 'BLOCKER_DECISION', 'TASK_FAILURE', 'VERDICT'],
  );
  const facts = column(rows, 'turnFacts（进入 reasonDigest 的输入投影，§7.3）');
  for (const [i, generation] of column(tf4, '代次项').map(bare).entries()) {
    const code = bare(column(tf4, 'reasonCode')[i]);
    const camel = generation.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.match(facts[codes.indexOf(code)], new RegExp(camel), `${code}'s turnFacts does not carry ${generation}`);
  }
});

test('the authority projection is derived by the database, and its freshness is a query', () => {
  // PC-CX-25 is a P0, and P0s in this contract are answered by database objects, never by a
  // service — the same judgement §2.4 already applies to D5/D6. What is checked here is that the
  // objects are frozen, that the migration creates them, that the service write points are gone,
  // and that the freshness claim is stated as something anyone can run against production.
  const objects = column(tables(section(PCC, '2.4'))[1], '对象').map(bare);
  for (const object of ['task_dispatch_authority_projection', 'task_claimed_project_move_guard', 'project_action_applied_immutable_guard']) {
    assert.ok(objects.includes(object), `${object} is not frozen in §2.4`);
    assert.ok(section(PCC, '12.1').includes(object), `${object} is frozen in §2.4 but never created by the migration`);
  }
  assert.match(section(PCC, '7.7'), /#### D13 · 授权投影的漂移查询/, 'I12-A claims to be queryable but no query is given');
  assert.match(section(PCC, '4.3'), /\*\*I12-A（投影新鲜，恒成立，由 D12 保证）\*\*/, '§4.3 does not state the freshness invariant');
  assert.match(section(PCC, '4.3'), /\*\*I12-B（无越权新派发，恒成立，由 D6 保证）\*\*/, '§4.3 does not state what replaces the old I12');
  // The trigger's `FOR SHARE` is invisible in pg_trigger and in `migrate diff`, exactly like D6's —
  // and it is what makes a concurrent flip and a task write mutually exclusive. §12.1 G5 has to
  // keep asking for it by name, or a two-word regression ships with no signal at all.
  assert.match(section(PCC, '7.7'), /SELECT p\.coordinator_enabled INTO enabled FROM project p WHERE p\.id = NEW\.project_id FOR SHARE/, 'the projection trigger no longer locks the project row');
  assert.match(section(PCC, '12.1'), /task_dispatch_authority_projection` 存在\*\*且函数体里含 `FOR SHARE`/, 'the migration is not verified for the two words that carry the P0');
});

test('policy revocation, the project cap and dispatch share one gate', () => {
  // PC-CX-26. The gate is a row lock that already existed (LO1's first level, AE6-a's first
  // statement); what was missing is that dispatch never took it. So what is asserted here is that
  // §9.6 exists, that it is the same lock, and that the closed set of "authority" fields is stated
  // rather than left to whoever writes the policy evaluator.
  const gate = section(PCC, '9.6');
  assert.match(gate, /\*\*AU1（授权复核门，冻结）\*\*/, '§9.6 states no re-check gate');
  assert.match(gate, /FROM project WHERE id = :p FOR NO KEY UPDATE/, 'the gate must be the same project row lock LO1 already freezes');
  assert.match(gate, /\*\*CAP1（并发上限是所有入口共享的硬门，冻结）\*\*/, '§9.6 does not freeze whether a human may cross the cap');
  assert.match(gate, /\*\*CAP1-b/, 'CAP1 must argue why it is not a database constraint, not simply omit one');
  const fields = ['coordinator_enabled', 'automation_policy', 'max_concurrent_tasks', 'session_budget_per_day'];
  for (const field of fields) assert.ok(gate.includes(field), `${field} is not in the closed authority set (AU3)`);
  assert.match(section(PCC, '4.3'), /\*\*I16/, 'the commit-time authorisation invariant is not stated');
  assert.match(section(PCC, '8.5'), /AUTHORITY_REVOKED/, 'a revoked action must have the same non-rollback shape as a key conflict (C2/C6)');
  assert.match(section(PCC, '9.2'), /\*\*P4/, 'the policy matrix does not say it is evaluated twice');
});

test('the decision input is complete: every column a rule reads is a field the input carries', () => {
  // PC-CX-22 / §6.1 S8. This is the one assertion that has to be derived rather than listed,
  // because the failure mode is "someone added a rule and forgot the field". The columns are
  // harvested from the tables that name them — the action table's key templates, GE1's generation
  // column, and the acceptance digest's projections — and every one has to appear in §6.1.
  const input = section(PCC, '6.1');
  const generations = column(tables(section(PCC, '8.2'))[0], '落库位置').join(' ');
  const harvested = new Set<string>();
  for (const key of column(tableRows(section(PCC, '7.3')), '幂等键（§8.2）').map(bare)) {
    for (const m of key.matchAll(/<([a-zA-Z]+)>/g)) if (m[1] !== 'projectId') harvested.add(m[1]);
  }
  for (const m of generations.matchAll(/`([a-z_]+\.[a-z_]+)`/g)) harvested.add(m[1].split('.')[1]);
  // AE1's four digest projections: three are computed from fields the input already carries, one
  // (`mergeEvidence`) is a projection of rows that live nowhere else, so only it has to appear
  // verbatim. The mapping is written out because it is the one place where "the rule reads X" is
  // not the same string as "the input carries X".
  const digestSources: Record<string, string[]> = {
    criteriaRevision: ['acceptanceCriteria'],
    taskSet: ['status', 'completionPolicy'],
    verdicts: ['verdict', 'verifiesTaskId'],
    mergeEvidence: ['mergeEvidence'],
  };
  const projections = Array.from(section(PCC, '13.4').matchAll(/^\s{2}(criteriaRevision|taskSet|verdicts|mergeEvidence)\s*:/gm), (m) => m[1]);
  assert.deepEqual([...new Set(projections)].sort(), ['criteriaRevision', 'mergeEvidence', 'taskSet', 'verdicts'], 'AE1 no longer states four projections');
  for (const projection of projections) for (const source of digestSources[projection]) harvested.add(source);
  assert.ok(harvested.size >= 8, 'nothing was harvested; the tables this reads have moved');

  const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const missing = [...harvested].filter((column_) => {
    const name = camel(column_);
    return !new RegExp(`\\b${name}\\b`).test(input) && !/^(taskId|verifierTaskId|blockerId|targetIdempotencyKey|kind|subjectId|generation|reasonDigest)$/.test(name);
  });
  assert.deepEqual(missing, [], 'a rule reads a column the decision input does not carry (§6.1 S8)');

  // §11.1's five questions are answered from the blocker projection, so every one of them has to
  // be a field the input carries — `run_state` (owner), the clock (recovery, nextCheckAt) and the
  // turn digest (kind, subject) are all decided from it.
  const blockers = /"blockers":\s*\[([\s\S]*?)\]/.exec(input)?.[1] ?? '';
  for (const field of ['kind', 'owner', 'recovery', 'nextCheckAt', 'subject']) {
    assert.ok(blockers.includes(field), `§11.1 asks "${field}" of every blocker, but the input does not carry it`);
  }

  for (const rule of ['**S5', '**S6', '**S7', '**S8']) {
    assert.ok(input.includes(rule), `§6.1 does not state ${rule}`);
  }
  assert.match(input, /decisionInputHash/, 'the hash was not renamed to cover the whole input');
  assert.match(section(PCC, '6.2'), /decisionInputHash/, 'the outcome does not record which input it decided on');
});

test('§23 answers every finding unit 02 raised against v1.4, and names a test that exists', () => {
  // Round five, read exactly the way the first four are: as evidence. Its findings are numbered
  // from 28, and the report refers back to the earlier ones, so the new ones are the ones above 27.
  const cited = new Set(Array.from(REVIEW_V14.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 27).sort();
  assert.deepEqual(raised, ['28', '29', '30', '31'], 'unit 02 raised four findings against v1.4');

  const rows = tables(section(PCC, '23'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§23 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22'].flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `23.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§23.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the five reviews are read, never edited', () => {
  // Same pin as the four-review version above, extended to round five. Two P0s and two P1s, and a
  // FAIL verdict: those are the two things a revision would be tempted to soften.
  assert.match(REVIEW_V14, /FAIL/, 'the fifth review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V14.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 27).length,
    4,
  );
});

test('the cap is stated with a tense: an admission limit, not a current-state ceiling', () => {
  // PC-CX-28 is the second instance of the PC-CX-21 shape, one round later and in a clause the
  // same revision had just written: a property that only holds at one moment, frozen as if it held
  // at every moment. What is pinned here is the shape of the replacement, and the fact that the
  // over-cap state it admits is described rather than left undefined.
  const invariants = section(PCC, '4.3');
  assert.match(invariants, /\*\*I16-A（准入，恒成立）\*\*/, '§4.3 does not state the standing half of I16');
  assert.match(invariants, /\*\*I16-B（提交时授权，点态）\*\*/, '§4.3 does not state the commit-time half of I16');

  const gate = section(PCC, '9.6');
  assert.match(gate, /\*\*CAP0（`maxConcurrentTasks` 是准入上限/, '§9.6 does not freeze which of the two readings applies');
  for (const rule of ['**CAP0-a', '**CAP0-b', '**CAP0-c', '**CAP4']) {
    assert.ok(gate.includes(rule), `§9.6 does not state ${rule}`);
  }
  // The choice between "refuse the decrease" and "redefine the limit" is a product decision, so it
  // has to be argued in the document rather than left as whichever the implementer prefers.
  const options = tables(gate).find((t) => bare(t[0][0]) === '选项');
  assert.ok(options, 'CAP0 must argue the two options the review offered, not silently pick one');
  assert.equal(options.length - 1, 2, 'the review offered exactly two');
  assert.match(section(PCC, '6.1'), /overCapBy/, 'an over-cap project has to be visible in the decision input');
  assert.match(section(PCC, '15'), /\*\*F34\*\*/, '§15 has no fault row for a cap lowered under load');
});

test('the execution context is frozen, re-resolved at commit, and proved by the database', () => {
  // PC-CX-29, checked the way PC-CX-25 is: a P0 is answered by a database object, and the two words
  // that carry it (`FOR SHARE`) are invisible in `pg_trigger` and in `migrate diff`, so §12.1 G5 has
  // to keep asking for them by name.
  const dispatch = section(PCC, '7.4');
  for (const rule of ['**A6', '**EC1', '**EC2', '**EC3', '**EC4', '**EC5']) {
    assert.ok(dispatch.includes(rule), `§7.4 does not state ${rule}`);
  }
  const ec1 = tables(dispatch).find((t) => bare(t[0][t[0].length - 1]) === 'revokedInput');
  assert.ok(ec1, 'EC1 no longer lists the closed read set');
  assert.equal(ec1.length - 1, 8, 'EC1 froze eight inputs');
  const ec5 = tables(dispatch).find((t) => bare(t[0][0]) === 'revokedInput');
  assert.ok(ec5, 'EC5 no longer maps each revoked input to a consequence');
  const declared = column(ec1, 'revokedInput').map(bare);
  const mapped = column(ec5, 'revokedInput').map(bare).flatMap((c) => c.split(' · '));
  assert.deepEqual([...mapped].sort(), [...declared].sort(), 'EC5 must be a total function over EC1\'s closed enum');

  const objects = column(tables(section(PCC, '2.4'))[1], '对象').map(bare);
  assert.ok(objects.includes('session_execution_context_guard'), 'D14 is not frozen in §2.4');
  assert.ok(section(PCC, '12.1').includes('session_execution_context_guard'), 'D14 is frozen but never created by the migration');
  assert.match(section(PCC, '12.1'), /`resolve_execution_context_locked` 存在\*\*且函数体里含 `FOR SHARE`/,
    'the migration is not verified for the two words that carry this P0');
  assert.match(section(PCC, '4.3'), /\*\*I17（执行上下文在提交点复核/, 'the standing invariant is not stated');
  assert.match(section(PCC, '15'), /\*\*F35\*\*/, '§15 has no fault row for a revoked execution context');
  // EC3 and D14 do different jobs, and the difference is a real Postgres behaviour rather than a
  // preference — a deferred constraint trigger takes its locks at COMMIT, not at INSERT.
  assert.match(section(PCC, '7.7'), /\*\*D14-e（EC3 与 D14 的分工/, 'the division of labour between EC3 and D14 is not stated');
});

test('the decision input declares the action history, and a rate-limited request has a clock', () => {
  // PC-CX-30 and PC-CX-31 are both completeness failures of a closed list: one in the harvest
  // surface behind S8, one in §10.4's list of what may set `nextWakeAt`. Both are pinned as lists.
  const input = section(PCC, '6.1');
  assert.match(input, /"actions":/, 'the world projection does not carry the action history its rules read');
  assert.match(input, /"coordinatorSession"/, '§7.3\'s turn preconditions read a row the input does not carry');
  assert.match(input, /"turnWindows"/, 'TR2\'s window has no due-fact in evaluation (S5)');
  assert.ok(input.includes('**S9'), '§6.1 does not state S9');
  const s9 = tables(input).find((t) => bare(t[0][0]) === '字段');
  assert.ok(s9, 'S9 no longer states the minimal projection');
  assert.equal(s9.length - 1, 3, 'the minimal action projection is three fields');
  for (const rule of column(s9, '唯一读它的规则').map(bare)) {
    const m = /§(\d+(?:\.\d+)?)/.exec(rule);
    assert.ok(m && headingNumbers(PCC).has(m[1]), `S9 says ${rule} reads a field, but that section does not exist`);
  }

  const turns = section(PCC, '7.6');
  for (const rule of ['**TR2-a', '**TR2-b', '**TR2-c', '**TR2-d', '**TR2-e']) {
    assert.ok(turns.includes(rule), `§7.6 does not state ${rule}`);
  }
  const timing = section(PCC, '10.4');
  const wakeList = timing.slice(timing.indexOf('取所有**适用项的最小值**'), timing.indexOf('**N-null'));
  assert.match(wakeList, /^7\. /m, '§10.4\'s closed list has no seventh item');
  assert.match(timing, /上面 1–7 条/, 'N-null still counts six, so a pending request can stop the clock');
  assert.match(section(PCC, '4.3'), /\*\*I18（显式请求不丢失/, 'nothing states that an explicit request cannot be lost');
  assert.match(section(PCC, '7.2'), /\*\*TF5/, 'the MANUAL turnFacts cell has no rule behind it');
  assert.match(section(PCC, '15'), /\*\*F36\*\*/, '§15 has no fault row for a rate-limited manual trigger');
});

test('§24 answers every finding unit 02 raised against v1.5, and names a test that exists', () => {
  // Round six, read exactly the way the first five are: as evidence. Its findings are numbered from
  // 32, and the report refers back to the earlier ones, so the new ones are the ones above 31.
  const cited = new Set(Array.from(REVIEW_V15.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 31).sort();
  assert.deepEqual(raised, ['32', '33', '34', '35', '36'], 'unit 02 raised five findings against v1.5');

  const rows = tables(section(PCC, '24'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§24 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22', '23'].flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `24.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§24.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the six reviews are read, never edited', () => {
  // Same pin as the five-review version above, extended to round six. One P0 and four P1s, and a
  // FAIL verdict: those are the two things a revision would be tempted to soften.
  assert.match(REVIEW_V15, /FAIL/, 'the sixth review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V15.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 31).length,
    5,
  );
  // The review's own §6 evidence has to still be there: a revision that deleted the reproduction
  // would leave §24's negative controls pointing at nothing.
  for (const evidence of ['0A000', 'provolatile', 'false|1|1', 'consumed=NULL,nextAttempt=NULL']) {
    assert.ok(REVIEW_V15.includes(evidence), `the sixth review no longer contains its ${evidence} evidence`);
  }
});

test('the locking resolver is VOLATILE everywhere the contract creates it', () => {
  // PC-CX-32: the one P0 of round six, and the only one whose whole claim is a database rule —
  // `SELECT … FOR SHARE` is a write, so PostgreSQL refuses it inside a non-volatile function. The
  // document has to say VOLATILE in all three places it describes the object, and the migration
  // check has to be over `pg_proc.provolatile`, because that column is the only difference between
  // a correct object and one that raises 0A000 on every call.
  const d14 = section(PCC, '7.7');
  assert.ok(d14.includes('**D14-f（`VOLATILE` 不是默认值'), '§7.7 does not state D14-f');
  assert.match(d14, /它是一个 \*\*`VOLATILE`\*\* 的 plpgsql 函数/, 'D14-a still specifies a resolver that cannot take its locks');
  assert.match(d14, /LANGUAGE plpgsql VOLATILE;/, 'the D14 SQL block still leaves the guard function\'s volatility to the default');
  assert.match(d14, /0A000/, 'D14-f does not record what the specified object actually does');
  assert.match(d14, /pg_proc\.provolatile/, 'D14-f does not say how the volatility is observed');

  // The two options the review offered are argued, not silently picked — same discipline as CAP0.
  const options = tables(d14).find((t) => bare(t[0][0]) === '选项');
  assert.ok(options, 'D14-f must argue lock-and-compute versus split, not just assert one');
  assert.equal(options.length - 1, 2, 'the review offered exactly two');

  const migration = section(PCC, '12.1');
  assert.match(migration, /\*\*`VOLATILE`\*\*、只读、按 §8\.6 LO1 的顺序 `FOR SHARE`/, 'step 6e still creates a STABLE resolver');
  assert.match(migration, /`pg_proc\.provolatile = 'v'`/, 'G5 does not assert the volatility the migration must produce');
  assert.match(migration, /真的插一条 `dispatch_origin = 'COORDINATOR'` 的 Session 并 `COMMIT`/,
    'G5 still verifies that the objects exist rather than that they run');
  // No live sentence may still promise a STABLE resolver. Read the body the way §22.8's ledger is
  // read — with the markup stripped — so a phrase that straddles a code span cannot hide.
  const stale = NORMATIVE.split('\n').map((l) => bare(l))
    .filter((l) => l.includes('STABLE 的 SQL 函数') && !/v1\.[1-6]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative line still specifies a STABLE locking function');
});

test('the execution context is stated with a tense, and the wake with an arbitration', () => {
  // PC-CX-34 and PC-CX-35: the third instance of the tense mistake, and the first arithmetic one.
  const invariants = section(PCC, '4.3');
  assert.ok(invariants.includes('**I17-A（create 冻结列与占位一致，恒成立'), '§4.3 does not state the standing half of I17');
  assert.ok(invariants.includes('**I17-B（授权在提交那一刻成立，点态'), '§4.3 does not state the commit-time half of I17');
  assert.ok(invariants.includes('**I17-c（那条被删掉的当前态查询是什么'), '§4.3 does not say what the deleted query described');
  assert.match(section(PCC, '15'), /I17-A 仍恒成立/, 'F35 was not restated for the split');

  const timing = section(PCC, '10.4');
  assert.ok(timing.includes('**W5（一个候选表、一个确定的选择'), '§10.4 does not freeze the wake arbitration');
  for (const part of ['候选表', 'source', 'wakeCandidates', 'flooredBy']) {
    assert.ok(timing.includes(part), `W5 does not state ${part}`);
  }
  assert.match(timing, /W3 是硬下限/, 'W5 does not say which of the floor and the deadline wins');
  assert.match(section(PCC, '7.6'), /\*\*TR2-d（唤醒与幂等，v1\.6 按 W5 改述/, 'TR2-d was not restated for W5');
  assert.match(section(PCC, '7.6'), /\*\*TR2-e（用户可见状态，v1\.6 按 W5 改述/, 'TR2-e was not restated for W5');
});

test('a committed event has a shape before reconcile has seen it, and something owns it', () => {
  // PC-CX-36: the invariant that never looked at the first state of the row it is about. The three
  // shapes have to be closed, the choice not to lock the producer has to be argued, and the promise
  // that a queued row is picked up has to be a predicate rather than a hope about the consumer.
  const invariants = section(PCC, '4.3');
  for (const rule of ['**I18-A（已回答', '**I18-B（待首次消费', '**I18-C（已看过、被限频', '**I19（待消费事件的责任域']) {
    assert.ok(invariants.includes(rule), `§4.3 does not state ${rule}）`);
  }
  assert.match(invariants, /没有第四种形状/, 'the three shapes are not stated as a closed set');
  const options = tables(invariants).find((t) => bare(t[0][0]) === '选项');
  assert.ok(options && options.length - 1 === 2, 'I18-note must argue both options the review offered');

  const backstop = section(PCC, '10.2');
  assert.match(backstop, /\(iv\) 队列里躺着一条没人看的事件/, 'W4 has no branch for an event no consumer took');
  assert.match(backstop, /COALESCE\(e\.next_attempt_at, e\.occurred_at\) < now\(\) - interval '5 minutes'/,
    'the fourth branch does not use the "late" predicate the other three use');
  assert.match(backstop, /四支的含义各自独立/, 'W4 still describes itself as three branches');
  assert.match(section(PCC, '10.4'), /\*\*N-null 的时态/, 'N-null was not given the tense the gap requires');
  assert.match(section(PCC, '15'), /\*\*F37\*\*/, '§15 has no fault row for the asynchronous gap');
  assert.match(section(PCC, '15'), /\*\*F38\*\*/, '§15 has no fault row for the last five seconds of a window');
});

test('§25 answers every finding unit 02 raised against v1.6, and names a test that exists', () => {
  // Round seven, read exactly the way the first six are: as evidence. Its findings are numbered
  // from 37, and the report refers back to the earlier ones, so the new ones are the ones above 36.
  const cited = new Set(Array.from(REVIEW_V16.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 36).sort();
  assert.deepEqual(raised, ['37', '38', '39', '40', '41', '42'], 'unit 02 raised six findings against v1.6');

  const rows = tables(section(PCC, '25'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§25 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22', '23', '24'].flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `25.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§25.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the seven reviews are read, never edited', () => {
  // Same pin as the six-review version above, extended to round seven. One P0 and five P1s, and a
  // FAIL verdict: those are the two things a revision would be tempted to soften.
  assert.match(REVIEW_V16, /FAIL/, 'the seventh review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V16.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 36).length,
    6,
  );
  // The review's own §6 evidence has to still be there: a revision that deleted the reproduction
  // would leave §25's reverse controls pointing at nothing.
  for (const evidence of ['reason_code=REPLAN', 'I17-A mismatch count=1', 'model-v2', '63s/64s']) {
    assert.ok(REVIEW_V16.includes(evidence), `the seventh review no longer contains its ${evidence} evidence`);
  }
});

test('the applied action row is frozen by construction, not by a list', () => {
  // PC-CX-37, the P0 of round seven. v1.4 wrote D11 as a per-column denylist; v1.5 added three
  // columns to the same table and nobody went back, so I17-A's frozen context and TR2-a's window
  // anchor were both rewritable by a plain UPDATE. The fix has to be a shape, not three more lines.
  const seven = section(PCC, '7.7');
  const d11 = seven.slice(seven.indexOf('#### D11 '), seven.indexOf('#### D12 '));
  assert.match(d11, /to_jsonb\(NEW\) - writable\) IS DISTINCT FROM \(to_jsonb\(OLD\) - writable\)/,
    'D11 must compare the whole row minus a writable allowlist');
  assert.match(d11, /writable text\[\] := ARRAY\['result_session_id', 'detail'\]/, 'the allowlist has to be in the function');
  for (const column of ['execution_context', 'execution_context_digest', 'execution_result_digest', 'reason_code']) {
    assert.ok(d11.includes(column), `D11 no longer explains that ${column} is one of the columns it freezes`);
  }
  // The v1.4 shape may not survive anywhere in the normative body, in any of its enumerated forms.
  const stale = NORMATIVE.split('\n').map((l) => bare(l))
    .filter((l) => /NEW\.(type|subject_type|subject_id|project_id|fencing_token|idempotency_key) IS DISTINCT FROM OLD\./.test(l)
      && !/v1\.[1-7]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative line still enumerates D11 column by column');
  // And the migration check has to be schema-driven for the same reason the trigger is.
  assert.match(section(PCC, '12.1'), /information_schema\.columns/, 'G5 does not drive the mutation from the schema');
  assert.match(d11, /information_schema\.columns/, 'D11-e does not drive the mutation from the schema');
});

test('the frozen snapshot is compared per PAC freeze point, with a phase and a generation', () => {
  // PC-CX-38: I17-A quoted PAC §6's table heading rather than its "frozen at" column, so the two
  // rows that freeze at first claim made a standing statement false on the normal path — twice.
  const invariants = section(PCC, '4.3');
  assert.ok(invariants.includes('**I17-A2（claim 冻结列的阶段与代次'), '§4.3 does not state the phase-indexed half of I17');
  assert.ok(invariants.includes('**I17-d（'), '§4.3 does not record why v1.6 wrote model into I17-A');
  const i17 = invariants.slice(invariants.indexOf('**I17（'), invariants.indexOf('- **I18（'));
  const standing = i17.slice(i17.indexOf('**I17-A（'), i17.indexOf('**I17-A2（'));
  // PAC freezes model/effort at first claim, so the standing equality may not name them.
  for (const claimFrozen of ['`model`', '`effort`']) {
    assert.ok(!standing.includes(claimFrozen), `I17-A still compares ${claimFrozen}, which PAC §6 freezes at first claim`);
  }
  for (const createFrozen of ['agent_id', 'workspace_id', 'assigned_runner_id', 'provider', 'required_capabilities']) {
    assert.ok(standing.includes(createFrozen), `I17-A does not compare the create-frozen column ${createFrozen}`);
  }
  assert.match(PAC, /`model` \| \*\*首次 claim\*\*/, 'PAC still freezes model at first claim');
  assert.match(PAC, /模型被 runtime 彻底下架（`retiredPin`）时改写一次/, 'PAC still permits the one post-claim rewrite');
  // The generation is a persistent column with a closed mutator protocol, not a convention.
  assert.match(section(PCC, '2.4'), /session\.executionPinGeneration/, '§2.4 does not add the generation column');
  assert.ok(section(PCC, '7.7').includes('#### D15 '), '§7.7 does not state the snapshot mutator protocol');
  assert.match(section(PCC, '7.7'), /EXECUTION_PIN_GENERATION/, 'D15 does not refuse a rewrite that skips the generation');
});

test('the wake is a total order over persistent keys, read from the frozen clock', () => {
  // PC-CX-39 and PC-CX-40: an ordering that stopped at its second key, and the last free-running
  // clock, hidden inside a sentence that said it did not participate in decisions.
  const timing = section(PCC, '10.4');
  assert.match(timing, /\(at, source, subjectType, subjectId\)/, 'W5 does not state a four-key order');
  assert.ok(timing.includes('**W5-2a（'), 'W5 does not prove its order is total');
  assert.ok(timing.includes('**W5-2b（'), 'W5 does not say why the extra keys must be persistent');
  assert.match(timing, /COLLATE "C"/, 'W5 does not pin the comparison to bytes rather than a collation');
  assert.match(timing, /nextWakeAt = max\(chosen\.at, evaluation\.epoch \+ 5s\)/, 'W5 still floors against the wall clock');
  assert.match(timing, /永远不小于 `evaluation\.epoch \+ 5s`/, 'W3 still floors against the wall clock');
  // The candidate identity table has to cover every source, or "one subject, one candidate" is not
  // a property anything can check.
  const identity = tables(timing).find((t) => t[0].some((h) => bare(h) === 'subjectId'));
  assert.ok(identity, 'W5 does not state the candidate identity table');
  assert.equal(identity.length - 1, 7, 'the candidate identity table must cover all seven sources');
  // No normative rule outside W5's two named exceptions may compute a wake from now().
  const stale = NORMATIVE.split('\n').map((l) => bare(l))
    .filter((l) => /nextWakeAt = now \+|next_wake_at = now\(\) \+/.test(l) && !/R2|v1\.[1-7]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative rule still computes a wake from the wall clock');
  assert.match(section(PCC, '6.1'), /`nextWakeAt` \*\*是\*\*决策的一部分/, 'S5 still exempts nextWakeAt from the one-clock rule');
});

test('an out-of-loop event has an owner, and the two digests answer two questions', () => {
  // PC-CX-41 and PC-CX-42: an invariant quantified wider than its own responsibility, and one
  // digest asked to answer both "is this still authorized" and "is this still the same result".
  const invariants = section(PCC, '4.3');
  for (const branch of ['**I19-a（在环', '**I19-b（迟到', '**I19-c（出环']) {
    assert.ok(invariants.includes(branch), `§4.3 I19 does not state ${branch}）`);
  }
  assert.match(invariants, /没有第四支/, 'I19 is not stated as a closed partition');
  const disposition = section(PCC, '5.5');
  for (const rule of ['**EV1（', '**EV2（', '**EV3（', '**EV4（', '**EV5（', '**EV6（']) {
    assert.ok(disposition.includes(rule), `§5.5 does not state ${rule}）`);
  }
  assert.match(disposition, /DISCARDED_OUT_OF_LOOP/, '§5.5 does not name the terminal disposition');
  assert.match(disposition, /consumed_at IS NULL/, 'the discard is not idempotent by construction');
  assert.match(section(PCC, '10.2'), /\*\*W4-b（/, 'W4 does not say where the out-of-loop rows went');

  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('**EC2-a（'), '§7.4 does not state the authorization digest');
  assert.ok(dispatch.includes('**EC2-b（'), '§7.4 does not state the result digest');
  assert.ok(dispatch.includes('**EC6（'), '§7.4 does not say where the placeholder\'s frozen columns come from');
  const options = tables(dispatch).find((t) => bare(t[0][0]) === '选项');
  assert.ok(options && options.length - 1 === 2, 'EC2-c must argue both options, not just assert one');
  assert.match(dispatch, /EXECUTION_RESULT_CHANGED/, 'EC4 has no code for a result that changed without a revocation');
  assert.ok(section(PCC, '7.7').includes('**D14-g（'), 'D14 does not say which digest it proves');
  assert.match(section(PCC, '15'), /\*\*F41\*\*/, '§15 has no fault row for an out-of-loop event');
  assert.match(section(PCC, '15'), /\*\*F42\*\*/, '§15 has no fault row for a result that drifted');
});

test('§26 answers every finding unit 02 raised against v1.7, and names a test that exists', () => {
  // Round eight, read exactly the way the first seven are: as evidence. Its findings are numbered
  // from 43, and the report refers back to the earlier ones, so the new ones are the ones above 42.
  const cited = new Set(Array.from(REVIEW_V17.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 42).sort();
  assert.deepEqual(raised, ['43', '44', '45', '46'], 'unit 02 raised four findings against v1.7');

  const rows = tables(section(PCC, '26'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§26 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22', '23', '24', '25']
    .flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `26.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§26.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the eight reviews are read, never edited', () => {
  // Same pin as the seven-review version above, extended to round eight. Three P0s and one P1, and
  // a FAIL verdict: those are the two things a revision would be tempted to soften.
  assert.match(REVIEW_V17, /FAIL/, 'the eighth review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V17.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 42).length,
    4,
  );
  // The review's own §6 evidence has to still be there: a revision that deleted the reproduction
  // would leave §26's reverse controls pointing at nothing.
  for (const evidence of ['forged-after-session-insert', 'danger-full-access', 'live_rows:2', 'retired_count']) {
    assert.ok(REVIEW_V17.includes(evidence), `the eighth review no longer contains its ${evidence} evidence`);
  }
});

test('the publishing statement is inside the freeze, and the lineage cannot be rewritten', () => {
  // PC-CX-43 and PC-CX-45, the two P0s that are the same question in two places: what write is
  // still left after this gate, and who decides whether the gate applies at all.
  const seven = section(PCC, '7.7');
  const d11 = seven.slice(seven.indexOf('#### D11 '), seven.indexOf('#### D12 '));
  assert.match(d11, /writable := writable \|\| ARRAY\['status', 'refusal_code'\]/,
    'D11 does not give the publishing statement its own closed allowlist');
  assert.match(d11, /ACTION_TRANSITION_ILLEGAL/, 'D11 does not close the set of transition targets');
  for (const clause of ['**D11-f（', '**D11-g（']) {
    assert.ok(d11.includes(clause), `D11 does not state ${clause}）`);
  }
  // v1.7's blanket early return may not survive anywhere in the normative body without provenance.
  const stale = NORMATIVE.split('\n').map((l) => bare(l))
    .filter((l) => /IF OLD\.status <> 'APPLIED' THEN RETURN NEW/.test(l) && !/v1\.[1-7]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative line still waves the publishing statement through');

  // Every session-side gate reads OLD as well as NEW, and the lineage is frozen.
  const OLD_NEW = /\(OLD\.task_id IS NULL OR OLD\.dispatch_origin <> 'COORDINATOR'\)/;
  for (const [name, from, to] of [['D9', '#### D9 ', '#### D10 '], ['D14', '#### D14 ', '#### D15 '],
    ['D15', '#### D15 ', '#### D16 ']] as const) {
    assert.match(seven.slice(seven.indexOf(from), seven.indexOf(to)), OLD_NEW,
      `${name} still decides its scope from NEW alone`);
  }
  const d15 = seven.slice(seven.indexOf('#### D15 '), seven.indexOf('#### D16 '));
  for (const col of ['task_id', 'dispatch_origin', 'project_action_id']) {
    assert.match(d15, new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`),
      `D15 does not freeze the lineage column ${col}`);
  }
  assert.ok(d15.includes('**D15-f（'), 'D15 does not argue why the lineage must be frozen');
  assert.match(section(PCC, '4.3'), /\*\*I17-A3（lineage 恒成立/, '§4.3 has no standing invariant for the lineage');
  assert.match(section(PCC, '15'), /\*\*F43\*\*/, '§15 has no fault row for a forged publish');
  assert.match(section(PCC, '15'), /\*\*F45\*\*/, '§15 has no fault row for a released claim');
});

test('the create-frozen set is PAC §6’s whole table, and the pin ledger has an object on each side', () => {
  // PC-CX-44 and PC-CX-46. The first is the fifth instance of "a closed set copied by hand"; the
  // second is a two-way proposition that had been written only as a query.
  const createFrozen = PAC.slice(PAC.indexOf('## 6. Execution Snapshot 冻结契约'), PAC.indexOf('**S1**'))
    .split('\n').filter((line) => line.startsWith('|') && line.includes('Session **create**'))
    .flatMap((line) => Array.from(line.split('|')[1].matchAll(/`([A-Za-z]+)`/g), (m) => m[1]));
  assert.ok(createFrozen.length >= 9, 'PAC §6 no longer freezes nine columns at Session create');
  const snake = (name: string): string => name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
  const seven = section(PCC, '7.7');
  const d15 = seven.slice(seven.indexOf('#### D15 '), seven.indexOf('#### D16 '));
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  for (const component of createFrozen) {
    assert.ok(d15.includes(`NEW.${snake(component)}`), `D15 does not compare or freeze ${component}`);
    // v1.10 (PC-CX-51): D16 re-reads its own row by the stable key at the commit point, so the
    // comparison is against `s.<column>` — the final version — not the queued NEW tuple.
    assert.ok(d16.includes(`s.${snake(component)}`), `D16 does not re-prove ${component} at the commit point`);
  }
  assert.match(section(PCC, '7.4'), /\*\*EC6-d（`snapshotFrozenAt` 的唯一来源/, 'snapshotFrozenAt has no single source');
  assert.ok(d15.includes('**D15-g（'), 'D15 does not say why a BEFORE trigger is not the whole answer');

  // Both directions of the ledger, both deferred, both with a typed refusal.
  assert.match(d16, /CREATE CONSTRAINT TRIGGER session_execution_result_check/, 'the session side has no object');
  assert.match(d16, /CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check/, 'the action side has no object');
  const d16Sql = d16.slice(d16.indexOf('```sql'), d16.lastIndexOf('```'));
  assert.equal((d16Sql.match(/^\s+DEFERRABLE INITIALLY DEFERRED$/gm) ?? []).length, 2,
    'both directions must be deferred, or the statement order inside the transaction starts to matter');
  assert.match(d16, /EXECUTION_PIN_LEDGER/, 'the ledger disagreement has no typed refusal');
  assert.match(d16, /EXECUTION_RESULT_MISMATCH/, 'the drifted result has no typed refusal');
  for (const clause of ['**D16-a（', '**D16-b（', '**D16-c（', '**D16-d（', '**D16-e（']) {
    assert.ok(d16.includes(clause), `D16 does not state ${clause}）`);
  }
  assert.match(section(PCC, '4.3'), /数据库可执行的形式/, 'I17-A2 is still only a query');
  assert.match(section(PCC, '15'), /\*\*F44\*\*/, '§15 has no fault row for a drifted create-frozen column');
  assert.match(section(PCC, '15'), /\*\*F46\*\*/, '§15 has no fault row for a disagreeing ledger');
  // The migration verification has to grow with the objects it verifies (§12.1 G5).
  assert.match(section(PCC, '12.1'), /session_execution_result_check/, 'G5 does not verify the new commit-point objects');
});

// ---------------------------------------------------------------------------------------------
// v1.9 — `PC-CX-47..49`
// ---------------------------------------------------------------------------------------------

test('§27 answers every finding unit 02 raised against v1.8, and names a test that exists', () => {
  // Round nine, read exactly the way the first eight are: as evidence. Its findings are numbered
  // from 47, and the report refers back to the earlier ones, so the new ones are the ones above 46.
  const cited = new Set(Array.from(REVIEW_V18.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 46).sort();
  assert.deepEqual(raised, ['47', '48', '49'], 'unit 02 raised three findings against v1.8');

  const rows = tables(section(PCC, '27'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§27 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22', '23', '24', '25', '26']
    .flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `27.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§27.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the nine reviews are read, never edited', () => {
  // Same pin as the eight-review version above, extended to round nine. Three P1s and a FAIL
  // verdict: those are the two things a revision would be tempted to soften.
  assert.match(REVIEW_V18, /FAIL/, 'the ninth review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V18.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 46).length,
    3,
  );
  // The review's own §6 evidence has to still be there: a revision that deleted the reproduction
  // would leave §27's reverse controls pointing at nothing.
  for (const evidence of ['model-evil', 'claimResolution={}', 'retiredPins=[{}]', 'forged']) {
    assert.ok(REVIEW_V18.includes(evidence), `the ninth review no longer contains its ${evidence} evidence`);
  }
});

test('the first claim is bound to the frozen conclusion, and the ledger folds back to the session', () => {
  // PC-CX-47 and PC-CX-49, one shape read twice: a gate that checks presence and is read as if it
  // had checked correctness. The fix has to be a closed shape plus a chain, not one more count.
  const dispatch = section(PCC, '7.4');
  const ec6c = dispatch.slice(dispatch.indexOf('- **EC6-c（'), dispatch.indexOf('- **EC6-d（'));
  for (const field of ['frozen', 'value', 'source', 'generation', 'component', 'from', 'to', 'at', 'reason']) {
    assert.ok(ec6c.includes(`\`${field}\``), `EC6-c does not name the ${field} field of the two records`);
  }
  assert.match(ec6c, /DEFERRED_TO_CLAIM/, 'EC6-c no longer states the deferred conclusion as a literal');
  assert.match(ec6c, /RUNTIME_RETIRED/, 'EC6-c does not close the set of retiredPin reasons');
  assert.ok(dispatch.includes('- **EC6-e（'), '§7.4 does not require the ledger to fold back to the session pin');

  const seven = section(PCC, '7.7');
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.match(d16, /CREATE OR REPLACE FUNCTION coordinator_pin_ledger_fold/, 'D16 has no shared judgement');
  assert.equal((d16.match(/coordinator_pin_ledger_fold\(/g) ?? []).length, 3,
    'the two directions must judge by one function defined once and called from each side');
  assert.match(d16, /session % runs %\/% while action % records/, 'D16 does not compare the session pin with the ledger');
  assert.ok(d16.includes('**D16-f（'), 'D16 does not argue why the judgement is one function');
  const d16Sql = d16.slice(d16.indexOf('```sql'), d16.lastIndexOf('```'));
  assert.equal((d16Sql.match(/^\s+DEFERRABLE INITIALLY DEFERRED$/gm) ?? []).length, 2,
    'both directions must still be deferred, or the statement order inside the transaction starts to matter');

  // v1.8's cardinality-only reading may not survive in the normative body without provenance.
  const stale = NORMATIVE.split('\n').map((l) => bare(l))
    .filter((l) => l.includes('代次 1 ⇒ 有 claimResolution、retiredPins 恰好 0 条') && !/v1\.[1-8]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative line still reads the ledger as a row count');
  assert.match(section(PCC, '4.3'), /逐字等于 `session\.model` \/ `session\.effort`/, 'I17-A2 is still only about cardinality');
  assert.match(section(PCC, '15'), /\*\*F47\*\*/, '§15 has no fault row for a pin that contradicts the frozen conclusion');
  assert.match(section(PCC, '15'), /\*\*F49\*\*/, '§15 has no fault row for a ledger that says nothing');
  assert.match(section(PCC, '12.1'), /coordinator_pin_ledger_fold/, 'G5 does not verify the new commit-point judgement');
});

test('both digests are recomputed from an authoritative input the database can read', () => {
  // PC-CX-48. I17-A claimed both digests equalled a recomputation and attributed the claim to
  // D15+D16, while §26.5 admitted in the same document that a forged one commits. The fix is a
  // canonicalisation the database can execute — not a second copy of PAC's resolution chain.
  const dispatch = section(PCC, '7.4');
  assert.match(dispatch, /sha256\(canonical\(executionContext\.authorization\)\)/, 'EC2-a has no executable canonical form');
  assert.match(dispatch, /canonical\(executionContext - 'authorization'\)/, 'EC2-b still digests the whole column');
  assert.ok(dispatch.includes('- **EC2-d（'), '§7.4 does not say where each digest\'s authoritative input lives');

  const seven = section(PCC, '7.7');
  const d17 = seven.slice(seven.indexOf('#### D17 '), seven.indexOf('#### D7 '));
  assert.ok(d17.length > 0, '§7.7 has no D17');
  assert.match(d17, /CREATE OR REPLACE FUNCTION coordinator_canonical_json/, 'the canonicalisation has no object');
  assert.match(d17, /LANGUAGE plpgsql IMMUTABLE/, 'the canonicalisation is not declared immutable');
  assert.match(d17, /CREATE CONSTRAINT TRIGGER project_action_execution_digest_check/, 'D17 has no commit-point object');
  assert.match(d17, /DEFERRABLE INITIALLY DEFERRED/, 'D17 does not run at the commit point');
  assert.match(d17, /EXECUTION_DIGEST_MISMATCH/, 'a forged digest has no typed refusal');
  for (const clause of ['**D17-a（', '**D17-b（', '**D17-c（', '**D17-d（', '**D17-e（']) {
    assert.ok(d17.includes(clause), `D17 does not state ${clause}）`);
  }
  assert.ok(seven.includes('**D14-h（'), 'D14 does not say what it proves that D17 does not');
  assert.match(seven.slice(seven.indexOf('#### D14 '), seven.indexOf('#### D15 ')), /coordinator_execution_digest/,
    'the resolver and the recomputation must use one digest function, or two gates disagree about one column');

  // §26.5's admission may not stand as the current answer: it is registered and marked superseded.
  const superseded = tables(section(PCC, '22.8'))[0];
  const phrases = column(superseded, '被取代的字样').map(bare);
  assert.ok(phrases.includes('仍然只由 I17-A 的审计查询发现，而不是被拒绝'),
    '§22.8 does not register the sentence that admitted a forged digest');
  assert.match(section(PCC, '26.5'), /v1\.9 已取代/, '§26.5 does not say which revision replaced it');
  assert.match(section(PCC, '15'), /\*\*F48\*\*/, '§15 has no fault row for a forged digest');
  assert.match(section(PCC, '12.1'), /project_action_execution_digest_check/, 'G5 does not verify the digest gate');
});

// ---------------------------------------------------------------------------------------------
// v1.10 — `PC-CX-50..52`
// ---------------------------------------------------------------------------------------------

test('§28 answers every finding unit 02 raised against v1.9, and names a test that exists', () => {
  // Round ten, read exactly the way the first nine are: as evidence. Its findings are numbered
  // from 50, and the report refers back to the earlier ones, so the new ones are the ones above 49.
  const cited = new Set(Array.from(REVIEW_V19.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 49).sort();
  assert.deepEqual(raised, ['50', '51', '52'], 'unit 02 raised three findings against v1.9');

  const rows = tables(section(PCC, '28'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§28 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22', '23', '24', '25', '26', '27']
    .flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `28.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§28.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the ten reviews are read, never edited', () => {
  // Same pin as the nine-review version above, extended to round ten. Three P1s and a FAIL verdict:
  // those are the two things a revision would be tempted to soften.
  assert.match(REVIEW_V19, /FAIL/, 'the tenth review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V19.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 49).length,
    3,
  );
  // The review's own §6 evidence has to still be there: a revision that deleted the reproduction
  // would leave §28's reverse controls pointing at nothing.
  for (const evidence of ['result_session_id', 'claimResolution', 'EXECUTION_PIN_LEDGER', 'DEFERRABLE']) {
    assert.ok(REVIEW_V19.includes(evidence), `the tenth review no longer contains its ${evidence} evidence`);
  }
});

test('the two writable columns have a mutator, and the applied link is judged from both sides', () => {
  // PC-CX-50. D11 answered "which columns are still writable"; nothing answered "how they may
  // move" — and D16's action side read one of them to decide whether it applied at all.
  const seven = section(PCC, '7.7');
  const d11 = seven.slice(seven.indexOf('#### D11 '), seven.indexOf('#### D12 '));
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  const d18 = seven.slice(seven.indexOf('#### D18 '), seven.indexOf('#### D7 '));
  assert.ok(d18.length > 0, '§7.7 has no D18');
  assert.match(d18, /CREATE OR REPLACE FUNCTION project_action_result_ledger_mutator/, 'D18 has no object');
  // v1.11 (PC-CX-55): still statement-level, and the event surface now covers the insert that
  // writes the ledger in the first place — a rule that only watches UPDATE cannot own how the
  // value it protects came to exist.
  assert.match(d18, /BEFORE INSERT OR UPDATE ON project_action/, 'D18 is not statement-level on both write verbs');
  assert.match(d18, /ACTION_RESULT_LINK_FROZEN/, 'a detached result link has no typed refusal');
  for (const clause of ['**D18-a（', '**D18-b（', '**D18-c（', '**D18-d（', '**D18-e（', '**D18-f（']) {
    assert.ok(d18.includes(clause), `D18 does not state ${clause}）`);
  }
  // D11-b may no longer promise that the two writable columns enter no predicate.
  const alive = d11.split('\n').filter((line) => !/v1\.\d|PC-CX-\d\d/.test(line));
  assert.equal(alive.some((line) => line.includes('两者都不进任何硬门的谓词')), false,
    'D11-b still promises, without provenance, that the writable columns enter no hard gate');
  assert.ok(d16.includes('**D16-g（'), 'D16 does not argue why the link itself is the judgement');
  assert.doesNotMatch(d16.slice(d16.indexOf('```sql'), d16.lastIndexOf('```')),
    /NEW\.result_session_id IS NULL THEN RETURN NULL/, 'the action side still self-disables on a null link');
  assert.match(section(PCC, '4.3'), /result_session_id` \*\*为 NULL\*\*/, 'I17-A3 still states only the symmetric half');
  assert.match(section(PCC, '15'), /\*\*F50\*\*/, '§15 has no fault row for a one-sided result link');
  assert.match(section(PCC, '12.1'), /project_action_result_ledger_mutator/, 'G5 does not verify the new mutator');
});

test('every deferred row constraint re-reads its own row before judging it', () => {
  // PC-CX-51. DEFERRABLE defers *when* the check runs, not *which* tuple it holds; the rule has to
  // be stated once for all five, or the next one added will get it wrong again.
  const seven = section(PCC, '7.7');
  const deferred: [string, string, string, string][] = [
    ['D9', '#### D9 ', '#### D10 ', 'FROM session WHERE id = NEW.id'],
    ['D10', '#### D10 ', '#### D11 ', 'FROM task WHERE id = NEW.id'],
    ['D14', '#### D14 ', '#### D15 ', 'FROM session WHERE id = NEW.id'],
    ['D16', '#### D16 ', '#### D8 ', 'FROM session WHERE id = NEW.id'],
    ['D17', '#### D17 ', '#### D18 ', 'FROM project_action WHERE id = NEW.id'],
  ];
  for (const [name, from, to, reread] of deferred) {
    const body = seven.slice(seven.indexOf(from), seven.indexOf(to));
    assert.ok(body.includes(reread), `${name} still judges the tuple its statement queued with`);
  }
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.ok(d16.includes('FROM project_action WHERE id = NEW.id'), 'D16 action side does not re-read its row');
  assert.ok(seven.includes('**D9-f（'), '§7.7 never states the re-read as one rule for all five');
  assert.ok(seven.includes('**D10-d（'), 'D10 does not say why its transition predicate is different');
  // The promise D16-a made must still be there — it is what the fix is measured against.
  assert.match(d16, /判据都落在 `COMMIT` 那一刻的最终状态上/, 'D16-a no longer promises order independence');
  assert.match(section(PCC, '15'), /\*\*F51\*\*/, '§15 has no fault row for a legal order that must commit');
});

test("EC2-b's result half is closed by a key-and-type table, not by prose", () => {
  // PC-CX-52. "恰好三部分，封闭" had been a sentence since v1.7 with no object counting the keys,
  // while D17 tested the two conclusions for SQL NULL only.
  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('- **EC2-b2（'), '§7.4 does not close the result half');
  const ec2b2 = dispatch.slice(dispatch.indexOf('- **EC2-b2（'), dispatch.indexOf('- **EC2-c（'));
  for (const key of ['agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'providerBuiltin',
    'requiredCapabilities', 'permissionMode', 'snapshotFrozenAt', 'resolution', 'model', 'effort']) {
    assert.ok(ec2b2.includes(`\`${key}\``), `EC2-b2 does not name ${key}`);
  }
  // …and EC2-b's own part ① must now list snapshotFrozenAt, which it had dropped since v1.7.
  const ec2b = dispatch.slice(dispatch.indexOf('- **EC2-b（'), dispatch.indexOf('- **EC2-b2（'));
  assert.match(ec2b, /snapshotFrozenAt/, "EC2-b's create-frozen list is still missing a PAC §6 row");

  const seven = section(PCC, '7.7');
  const d17 = seven.slice(seven.indexOf('#### D17 '), seven.indexOf('#### D18 '));
  assert.match(d17, /CREATE OR REPLACE FUNCTION coordinator_execution_result_shape/, 'the shape has no object');
  assert.match(d17, /LANGUAGE plpgsql IMMUTABLE/, 'the shape function is not declared immutable');
  assert.match(d17, /EXECUTION_RESULT_SHAPE/, 'an incomplete result half has no typed refusal');
  assert.doesNotMatch(d17.split('\n').filter((line) => !/v1\.\d|PC-CX-\d\d/.test(line)).join('\n'),
    /IF ctx->>'model' IS NULL OR ctx->>'effort' IS NULL THEN/, 'D17 still tests only for SQL NULL');
  for (const clause of ['**D17-f（', '**D17-g（']) {
    assert.ok(d17.includes(clause), `D17 does not state ${clause}）`);
  }
  assert.ok(seven.includes('**D15-h（'), 'D15 does not say why it proves the shape before the equalities');
  assert.ok(seven.includes('**D16-h（'), 'D16 does not say why it proves the shape from both sides');
  assert.match(section(PCC, '7.4'), /空字符串/, 'EC6-c does not name the empty string as a non-conclusion');
  assert.match(section(PCC, '15'), /\*\*F52\*\*/, '§15 has no fault row for an incomplete result half');
  assert.match(section(PCC, '12.1'), /coordinator_execution_result_shape/, 'G5 does not verify the shape function');
});

// ---------------------------------------------------------------------------------------------
// v1.11 — `PC-CX-53..55`
// ---------------------------------------------------------------------------------------------

test('§29 answers every finding unit 02 raised against v1.10, and names a test that exists', () => {
  const cited = new Set(Array.from(REVIEW_V110.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]));
  const raised = [...cited].filter((n) => Number(n) > 52).sort();
  assert.deepEqual(raised, ['53', '54', '55'], 'unit 02 raised three findings against v1.10');

  const rows = tables(section(PCC, '29'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, raised.map((n) => `PC-CX-${n}`), '§29 does not answer exactly the findings raised');
  const answeredEarlier = ['19', '20', '21', '22', '23', '24', '25', '26', '27', '28']
    .flatMap((n) => column(tables(section(PCC, n))[0], 'ID').map(bare));
  assert.equal(ids.some((id) => answeredEarlier.includes(id)), false, 'a finding must be answered in one place only');

  const own = headingNumbers(PCC);
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i + 1];
    for (let c = 0; c < row.length; c++) {
      assert.ok(row[c].trim().length > 0, `${ids[i]} leaves column ${rows[0][c]} empty`);
    }
    const clauses = Array.from(column(rows, '规范条款')[i].matchAll(/§(\d+(?:\.\d+)?)/g), (m) => m[1]);
    assert.ok(clauses.length > 0, `${ids[i]} names no clause`);
    for (const clause of clauses) assert.ok(own.has(clause), `${ids[i]} points at §${clause}, which does not exist`);

    // The name carries an apostrophe in one row, so accept either quote style.
    const testName = bare(column(rows, '可执行断言')[i]);
    assert.ok(
      COUNTEREXAMPLES.includes(`test('${testName}'`) || COUNTEREXAMPLES.includes(`test("${testName}"`),
      `${ids[i]} names "${testName}", which is not a test in coordinator-counterexample.spec.ts`,
    );
    const detail = section(PCC, `29.${i + 1}`);
    for (const heading of ['最小交错序列', 'Postgres MVCC 与锁语义', '权威状态', '动作键', '恢复路径', '可执行断言']) {
      assert.ok(detail.includes(`**${heading}**`), `§29.${i + 1} (${ids[i]}) does not state its ${heading}`);
    }
  }
});

test('the eleven reviews are read, never edited', () => {
  // Same pin as the ten-review version above, extended to round eleven. One P0, two P1s and a FAIL
  // verdict: those are the things a revision would be tempted to soften.
  assert.match(REVIEW_V110, /FAIL/, 'the eleventh review found the contract wanting; that is a fact, not a draft');
  assert.equal(
    [...new Set(Array.from(REVIEW_V110.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 52).length,
    3,
  );
  assert.match(REVIEW_V110, /\*\*P0\*\*/, 'the eleventh review no longer records that one finding was a P0');
  // Its §6 evidence has to still be there: a revision that deleted the reproduction would leave
  // §29's reverse controls pointing at nothing.
  for (const evidence of ["ARRAY['where','who','with']", 'session_exists', '22023', 'retiredPins']) {
    assert.ok(REVIEW_V110.includes(evidence), `the eleventh review no longer contains its ${evidence} evidence`);
  }
});

test("the frozen resolution is closed by PAC 7.5's own top-level structure, version key included", () => {
  // PC-CX-53. EC2-b said "the whole of PAC §7.5's resolution" and the executable form compared the
  // key set against three of its four keys — so the conforming input was the refused one.
  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('- **EC2-b3（'), '§7.4 does not close the resolution row');
  const ec2b3 = dispatch.slice(dispatch.indexOf('- **EC2-b3（'), dispatch.indexOf('- **EC2-c（'));
  for (const key of ['v', 'who', 'with', 'where']) {
    assert.ok(ec2b3.includes(`\`${key}\``), `EC2-b3 does not name ${key}`);
  }
  const seven = section(PCC, '7.7');
  const d17 = seven.slice(seven.indexOf('#### D17 '), seven.indexOf('#### D18 '));
  assert.match(d17, /'v','number', 'who','object', 'with','object', 'where','object'/,
    'the shape function does not carry PAC 7.5 four top-level keys as a key-and-type table');
  assert.match(d17, /not a positive integer/, 'the version key has no value constraint');
  // The v1.10 predicate may only survive with provenance — it is a history, not a rule.
  const alive = d17.split('\n').filter((line) => !/v1\.\d|PC-CX-\d\d/.test(line));
  assert.equal(alive.some((line) => line.includes("ARRAY['where','who','with']")), false,
    'the exact-key predicate is still alive in D17 without provenance');
  assert.ok(d17.includes('**D17-g（'), 'D17 does not write down how deep the shape goes');
  assert.match(d17, /四个顶层 key/, 'D17-g still draws the boundary one key short of PAC 7.5');
  // PAC itself is untouched: closing this by softening the referenced contract is the wrong fix.
  assert.match(PAC, /`v` 必须写/, 'PAC §7.5 no longer requires the version discriminator');
  assert.match(section(PCC, '15'), /\*\*F53\*\*/, '§15 has no fault row for the ordinary PAC-conforming dispatch');
  assert.match(section(PCC, '12.1'), /含 PAC §7\.5 完整 `resolution`/, 'G5 does not run the positive dispatch');
});

test('the third verb has a gate, and the Session rotation it must not break still stands', () => {
  // PC-CX-54. Three objects, two verbs, and the sentence had three.
  const seven = section(PCC, '7.7');
  assert.ok(seven.includes('#### D19 '), '§7.7 has no D19');
  const d19 = seven.slice(seven.indexOf('#### D19 '), seven.indexOf('#### D7 '));
  assert.match(d19, /FOREIGN KEY \(result_session_id\) REFERENCES session\(id\) ON DELETE RESTRICT/,
    'the result link is still not a real foreign key');
  assert.match(d19, /BEFORE DELETE ON session/, 'nothing observes DELETE on session');
  assert.match(d19, /SESSION_RESULT_LINK_REFERENCED/, 'a refused purge has no typed code');
  for (const clause of ['**D19-a（', '**D19-b（', '**D19-c（', '**D19-d（', '**D19-e（', '**D19-f（']) {
    assert.ok(d19.includes(clause), `D19 does not state ${clause}）`);
  }
  const infra = section(PCC, '2.4');
  assert.match(infra, /project_action_result_session_fk/, '§2.4 does not freeze the action → Session foreign key');
  assert.match(infra, /RESTRICT/, '§2.4 does not state the on-delete behaviour the review found absent');
  const invariants = section(PCC, '4.3');
  const i17a3 = invariants.slice(invariants.indexOf('- **I17-A3（'), invariants.indexOf('- **I17-d（'));
  assert.match(i17a3, /D19/, 'I17-A3 does not name the object that carries its third verb');
  // …and the lifecycle the fix had to stay compatible with is unchanged, word for word.
  assert.match(section(PCC, '7.5'), /被用户删除（`coordinatorSessionId` 被 SetNull）/,
    'the rotation trigger the fix had to stay compatible with is gone');
  assert.match(section(PCC, '15'), /\*\*F54\*\*/, '§15 has no fault row for a purged result session');
  assert.match(section(PCC, '12.1'), /session_result_link_delete_guard/, 'G5 does not verify the delete guard');
});

test('the pin ledger proves its type before any array function, on both write verbs', () => {
  // PC-CX-55. A type test written after the call that raises is a type test that never runs.
  const seven = section(PCC, '7.7');
  const d18 = seven.slice(seven.indexOf('#### D18 '), seven.indexOf('#### D19 '));
  assert.ok(d18.indexOf("IF jsonb_typeof(new_ledger) <> 'array'") < d18.indexOf('FROM jsonb_array_elements(new_ledger)'),
    'D18 still expands the ledger before it proves the ledger is one');
  assert.match(d18, /BEFORE INSERT OR UPDATE ON project_action/, 'D18 is not statement-level on both write verbs');
  assert.ok(d18.includes('**D18-g（'), 'D18 does not argue why the order and the event surface are the rule');
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.ok(d16.indexOf("IF jsonb_typeof(ledger) <> 'array'") < d16.indexOf('jsonb_array_length(ledger)'),
    'the commit-point fold still measures the ledger before it proves it is one');
  // Existing data: an audit, an isolation and a repair, with the undecidable half handed to a person.
  assert.match(d18, /必须对存量跑\*\*四条\*\*查询/, 'D18-e still promises three existing-data queries');
  assert.match(d18, /malformedRetiredPins/, 'D18-e has no isolation step for the existing malformed rows');
  assert.match(d18, /USER \/ HUMAN/, 'D18-e ④-b does not hand the undecidable rows to a person');
  assert.match(section(PCC, '15'), /\*\*F55\*\*/, '§15 has no fault row for a malformed initial ledger');
  assert.match(section(PCC, '12.1'), /pg_get_triggerdef/, 'G5 does not verify the widened trigger event surface');
});
