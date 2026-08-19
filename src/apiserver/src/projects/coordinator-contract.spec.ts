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
/** §1–§18: the normative body. §19–§22 are revision logs and are explicitly non-normative (§0 RL1). */
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
  for (const n of ['19', '20', '21', '22']) {
    const body = section(PCC, n);
    assert.match(body.split('\n').slice(0, 4).join('\n'), /本节是非规范的/, `§${n} is not marked non-normative`);
  }

  const ledger = tables(section(PCC, '22.8'))[0];
  const phrases = column(ledger, '被取代的字样').map(bare);
  assert.ok(phrases.length >= 6, '§22.8 no longer registers the superseded sentences');
  for (const phrase of phrases) {
    assert.ok(PCC.includes(phrase), `the ledger registers "${phrase}", which appears nowhere at all — a typo makes the row a no-op`);
    for (const [i, line] of NORMATIVE.split('\n').entries()) {
      if (!line.includes(phrase)) continue;
      assert.match(
        line,
        /v1\.[1-4]|PC-CX-\d\d/,
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
  assert.match(dispatch, /#### D11 · `APPLIED` 动作行终态不可改写/, 'project_action has no mutator protocol');
  assert.match(dispatch, /\*\*D9-e/, 'D9 does not say which of its predicates is commit-time only');
});

test('the turn reasons are a total order, and at most one turn comes out of one input', () => {
  // PC-CX-23, checked the way PC-CX-03 is: the fix is only a fix if the order is stated in the
  // document as an ordered, total column — a prose sentence about priority drifts from the table.
  const rows = turnReasonTable();
  const order = column(rows, '序').map(bare);
  const codes = column(rows, 'reasonCode').map(bare);
  assert.deepEqual(order, ['1', '2', '3', '4', '5'], '§7.2 no longer orders the turn reasons');
  assert.deepEqual(codes, ['MANUAL', 'VERDICT', 'BLOCKER_DECISION', 'ACCEPTANCE', 'REPLAN'], 'the frozen total order changed');
  assert.equal(new Set(codes).size, codes.length, 'two rows share a reasonCode');
  assert.match(section(PCC, '7.2'), /\*\*TU4（唯一裁决：首个为真者胜/, '§7.2 states the order but not the rule that reads it');
  assert.match(section(PCC, '4.3'), /\*\*I15/, 'the "at most one semantic turn" invariant is not stated');

  // PC-CX-24: every reason drawn from a row that has a lifecycle must carry that row's generation,
  // or a cleared-and-recurring episode collides with the turn key of the episode before it.
  const tf4 = tables(section(PCC, '7.2')).find((t) => t[0][0].replace(/[`*]/g, '').trim() === 'reasonCode' && t[0].length === 3);
  assert.ok(tf4, 'TF4 no longer lists which reasons carry a generation');
  assert.deepEqual(column(tf4, 'reasonCode').map(bare).sort(), ['ACCEPTANCE', 'BLOCKER_DECISION', 'VERDICT']);
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
