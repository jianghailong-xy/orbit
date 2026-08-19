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
const COUNTEREXAMPLES = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');

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

  const trigger = tableRows(section(PCC, '7.2')).find((cells) => bare(cells[0]) === 'BLOCKER_DECISION');
  assert.ok(trigger, '§7.2 no longer names the blocker-driven turn trigger');
  const listed = (/\{([^}]+)\}/.exec(trigger[1])?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean).sort();
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
  const columns = /以及(.)列：/.exec(section(PCC, '2.4'));
  assert.ok(columns, '§2.4 no longer states how many columns it adds');
  assert.equal('一二三四五六七八九'.indexOf(columns[1]) + 1, Number(total[4]), '§2.4 and §14 disagree on new columns');
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

test('the reviews are read, never edited: both are still the documents that were signed off', () => {
  // The hard constraint on both revision units was "do not edit the review to make the failure go
  // away". Nothing here can prove a file was not edited, but it can pin the two things a revision
  // would be tempted to soften: the verdicts, and the count of findings behind them.
  assert.match(REVIEW, /FAIL/, 'the first review found the contract wanting; that is a fact, not a draft');
  assert.match(REVIEW_V11, /FAIL/, 'so did the second');
  assert.equal(new Set(Array.from(REVIEW.matchAll(/PC-CX-(\d\d)/g), (m) => m[1])).size, 8);
  assert.equal(
    [...new Set(Array.from(REVIEW_V11.matchAll(/PC-CX-(\d\d)/g), (m) => m[1]))].filter((n) => Number(n) > 8).length,
    6,
  );
});

test('the P0 findings are answered by a database constraint, not by application code', () => {
  // PC-CX-01 and PC-CX-02 are both "two entry points, one of which this binary does not control".
  // A fix that lives in a service is not a fix for either, so §2.4 has to keep listing the two
  // objects the database itself enforces, and §12.1 has to keep creating them.
  const objects = tables(section(PCC, '2.4'))[1];
  const names = column(objects, '对象').map(bare);
  assert.deepEqual(names, ['session_task_execution_claim_idx', 'session_dispatch_authority_guard']);
  assert.deepEqual(column(objects, '类型').map(bare), ['partial unique index', 'BEFORE INSERT trigger']);

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
