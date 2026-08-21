import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bare, column, headingNumbers, section, tables } from './contract-doc';

// The Project/Agent domain contract (PAC) is frozen in a document, and units 02–06 have not been
// written yet — so, exactly as `coordinator-contract.spec.ts` does for the coordinator contract,
// there is nothing else here to assert against but the document's own internal consistency.
//
// v1 of this contract was reviewed independently and failed on seven blocking self-contradictions
// (01V, comment 34AqK7dEuWvR1Fwj7JawE). Every one of them had the same shape: two clauses of the
// same document giving two different answers to one question, with no test able to tell. Five of
// the seven are properties the document states ABOUT ITSELF, which means they are checkable —
// so they are checked here, and the case numbers below are the ones §13.0 declares.
//
// v1.1 was reviewed again and failed on four more (01V, comment 34ArzVefRCxRrqdDh1cEi, on b810be89).
// Those four are why this file also reads the COORDINATOR contract: two of them were not
// contradictions inside one document but between two, and a check that only ever opens one file
// cannot see that shape. §12 E4 and §16 O7 are the clauses; `00.14` and `00.15` are the checks.
//
// This file judges nothing about the design. It only holds the contract to the closure it claims.
const REPO = path.resolve(__dirname, '../../../..');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
/** The downstream control-loop contract. PAC's dispatch refusals have to land somewhere, and this
 *  is where §7.4 AU-F says they land, so half of PAC's closure is a property of this file. */
const PCC = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
/** The executable model of the two contracts. Clauses `00.18` and `00.19` are about whether a rule
 *  this document states is actually RUN somewhere, and this is the somewhere. */
const MODEL = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');

/** A section body with fenced code blocks removed — SQL and JSON samples are not normative prose. */
function prose(number: string): string {
  return section(PAC, number).replace(/```[\s\S]*?```/g, '');
}

/** Backticked SCREAMING_SNAKE tokens: the shape every §12 refusal code is written in. */
function refusalCodesIn(md: string): Set<string> {
  return new Set(Array.from(md.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g), (m) => m[1]));
}

/** The §12 table, addressed by its header rather than by position. */
function errorCodeTable(): string[][] {
  const found = tables(section(PAC, '12')).find((t) => t[0].some((h) => bare(h) === 'code'));
  assert.ok(found, '§12 no longer states the error-code table');
  return found;
}

/** One table of a section, addressed by a header it must carry. */
function tableHeaded(doc: string, number: string, header: string): string[][] {
  const found = tables(section(doc, number)).find((t) => t[0].some((h) => bare(h) === header));
  assert.ok(found, `§${number} no longer states a table headed \`${header}\``);
  return found;
}

/** Every `- \`<id>\` \`<kind>\` …` case in §13, in document order. */
function cases(): { id: string; kind: string }[] {
  return Array.from(section(PAC, '13').matchAll(/^- `(\d\d[A-Z]?\.\d+)` `([+\-M])`/gm), (m) => ({
    id: m[1],
    kind: m[2],
  }));
}

test('00.1: every refusal code the normative text uses is a row of §12', () => {
  const declared = new Set(column(errorCodeTable(), 'code').map(bare));
  // The sections that decide things. §12 itself is the definition and §13/§14 are the test plan,
  // so neither can be evidence that a code exists.
  for (const number of ['3', '5', '7', '8', '11']) {
    for (const code of refusalCodesIn(prose(number))) {
      assert.ok(declared.has(code), `§${number} refuses with \`${code}\`, which §12 does not define`);
    }
  }
});

test('00.2: every row of §12 is used by the text, so no code exists only in the table', () => {
  const body = PAC.replace(section(PAC, '12'), '');
  for (const code of column(errorCodeTable(), 'code').map(bare)) {
    assert.ok(body.includes(`\`${code}\``), `§12 defines \`${code}\` but nothing outside the table refers to it`);
  }
});

test('00.9: the §12 rows are unique and each carries a status and a predicate', () => {
  const rows = errorCodeTable();
  const codes = column(rows, 'code').map(bare);
  assert.equal(new Set(codes).size, codes.length, 'duplicate refusal code');
  const https = column(rows, 'HTTP').map(bare);
  const whens = column(rows, '何时').map(bare);
  const carries = column(rows, '必须携带的信息').map(bare);
  for (let i = 0; i < codes.length; i++) {
    assert.match(https[i], /^\d{3}$/, `${codes[i]} has no HTTP status`);
    assert.ok(whens[i].length > 0, `${codes[i]} has no predicate`);
    assert.ok(carries[i].length > 0, `${codes[i]} says nothing about what it must carry`);
  }
});

test('00.3: §6 freezes in two disjoint phases whose union is the whole table', () => {
  // The v1 defect: the last row said "every column above becomes read-only once snapshotFrozenAt is
  // set", while two rows of the same table freeze at first claim. A Session created with a null
  // model then had to break one clause or the other, and both readings could cite the contract.
  const six = section(PAC, '6');
  const freeze = tables(six).find((t) => t[0].some((h) => bare(h) === '冻结时刻'));
  assert.ok(freeze, '§6 no longer states the freeze table');
  const names = (cell: string): string[] => Array.from(cell.matchAll(/`([A-Za-z]+)`/g), (m) => m[1]);

  const declaredCreate: string[] = [];
  const declaredClaim: string[] = [];
  for (const row of freeze.slice(1)) {
    const target = row[1].includes('Session **create**') ? declaredCreate : declaredClaim;
    assert.ok(
      row[1].includes('Session **create**') || row[1].includes('首次 claim'),
      `§6 row ${row[0]} freezes at neither Session create nor first claim`,
    );
    target.push(...names(row[0]));
  }
  assert.equal(declaredCreate.length, 9, '§6 no longer freezes exactly nine columns at Session create');
  assert.deepEqual(declaredClaim, ['model', 'effort'], '§6 no longer claim-freezes exactly model and effort');

  // S4 restates the same split as a table. It has to agree with the one above column for column,
  // or the two halves of §6 are back to disagreeing.
  const s4 = tables(six).find((t) => t[0].some((h) => bare(h) === '集合'));
  assert.ok(s4, 'S4 no longer states the two-phase table');
  const members = column(s4, '成员');
  const seal = column(s4, '封条');
  assert.equal(members.length, 2, 'S4 must state exactly two freeze sets');
  assert.deepEqual(names(members[0]).sort(), [...declaredCreate].sort(), 'S4 create-frozen set has drifted from §6');
  assert.deepEqual(names(members[1]), declaredClaim, 'S4 claim-frozen set has drifted from §6');
  assert.match(seal[0], /snapshotFrozenAt/, 'the create-frozen set has no seal');
  assert.match(seal[1], /claim/, 'the claim-frozen set has no seal');

  // Disjoint, and together the whole table: "can this column still be written" has one answer.
  const overlap = declaredCreate.filter((c) => declaredClaim.includes(c));
  assert.deepEqual(overlap, [], 'a column is in both freeze sets, so it has two seals');

  // And the row that caused the defect must no longer claim the whole table.
  const snapshotRow = freeze.find((row) => bare(row[0]) === 'snapshotFrozenAt');
  assert.ok(snapshotRow, '§6 no longer states when snapshotFrozenAt itself is written');
  assert.ok(!/上表全部列/.test(snapshotRow[2]), 'snapshotFrozenAt still claims to seal model and effort');
  // S1 and the one legal post-claim rewrite are what the downstream coordinator contract reads.
  assert.match(six, /`model` \| \*\*首次 claim\*\*/, '§6 no longer freezes model at first claim');
  assert.match(six, /模型被 runtime 彻底下架（`retiredPin`）时改写一次/, '§6 no longer permits the one post-claim rewrite');
});

test('00.4: the WITH chain reads the Agent, never a task-level pin', () => {
  // AC2 says a plain Task no longer configures a Provider. v1 kept `task.provider` as priority 1
  // and let it beat the Agent, which is that criterion's exact opposite.
  const priorities = tables(section(PAC, '7.2'))[0];
  assert.ok(priorities?.[0]?.some((h) => bare(h) === '优先级'), '§7.2 no longer states the priority table');
  for (const row of priorities.slice(1)) {
    const line = row.join(' ');
    for (const pin of ['task.provider', 'task.model', 'task.defaultEffort']) {
      assert.ok(!line.includes(pin), `§7.2 priority table still reads ${pin}`);
    }
  }
  assert.match(section(PAC, '7.2'), /\*\*P1（v1\.1 改写）\*\*/, '§7.2 has no clause retiring the task pin');
  // And the pin has to be unwritable rather than merely unread, or AC2 is a convention.
  assert.match(section(PAC, '3.4'), /CHECK \("execution_contract" = 'LEGACY' OR/, '§3.4 K1 has no database constraint');
});

test('00.5: every id in the frozen resolution is covered by §10 B3', () => {
  // v1 named only `resolution.who.agentId`, so a serializer that encoded that one field and passed
  // the other two through as raw UUIDs satisfied the contract and broke AC1.
  const shape = section(PAC, '7.5');
  const block = shape.slice(shape.indexOf('```jsonc'), shape.indexOf('```', shape.indexOf('```jsonc') + 3));
  const ids = new Set(Array.from(block.matchAll(/"([a-zA-Z]+Id)"\s*:/g), (m) => m[1]));
  assert.ok(ids.size >= 3, '§7.5 no longer carries the three resolved ids');
  const b3 = tables(section(PAC, '10')).find((t) => t[0].some((h) => bare(h) === 'JSON 路径'));
  assert.ok(b3, 'B3 no longer states the id table');
  const covered = column(b3, 'JSON 路径').map(bare);
  for (const id of ids) {
    assert.ok(covered.some((p) => p.endsWith(`.${id}`)), `§7.5 carries ${id} but B3 does not require it to be base62`);
  }
  assert.equal(covered.length, ids.size, 'B3 covers a different number of ids than §7.5 declares');
  // The assertion §13 asks for must be the traversal, not three hand-written field checks — that
  // is the only form that survives a fourth id being added to §7.5.
  assert.match(section(PAC, '10'), /遍历 `resolution` 的整棵 JSON 树/, 'B3 still asks for per-field assertions');
});

test('00.6: §13 case numbers are unique and every one is classified', () => {
  const all = cases();
  assert.ok(all.length > 80, `§13 states only ${all.length} cases; the plan covers 17 modules`);
  const ids = all.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate case id: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  // Every module heading in §13 must actually carry cases, or a module is listed and untested.
  const modules = new Set(ids.map((id) => id.split('.')[0]));
  for (const heading of Array.from(section(PAC, '13').matchAll(/^### 13\.\d+ (\d\d[A-Z]?)\b/gm), (m) => m[1])) {
    assert.ok(modules.has(heading), `§13 has a heading for ${heading} but no cases under it`);
  }
  // §13.0's cases are the ones this file is: each has to be a test here, or the contract claims a
  // self-check it does not run.
  const self = readFileSync(__filename.replace(/build\/(.*)\.js$/, 'src/$1.ts'), 'utf8');
  for (const { id } of all.filter((c) => c.id.startsWith('00.'))) {
    assert.ok(self.includes(`test('${id}:`), `§13.0 declares ${id} but no test in this file carries that number`);
  }
});

test('00.7: all eight project acceptance criteria map onto cases that exist, positive and negative', () => {
  const byId = new Map(cases().map((c) => [c.id, c.kind]));
  const rows = tables(section(PAC, '14')).find((t) => t[0].some((h) => bare(h) === '项目验收标准'));
  assert.ok(rows, '§14 no longer states the mapping table');
  const criteria = rows.slice(1);
  assert.equal(criteria.length, 8, 'the project states eight acceptance criteria');

  for (const row of criteria) {
    const ac = bare(row[0]);
    const cited = Array.from(row[3].matchAll(/`([+\-M])`\s*`(\d\d[A-Z]?\.\d+)`/g), (m) => ({ kind: m[1], id: m[2] }));
    assert.ok(cited.length > 0, `AC${ac} cites no case`);
    for (const { kind, id } of cited) {
      const declared = byId.get(id);
      assert.ok(declared, `AC${ac} cites ${id}, which §13 does not state`);
      assert.equal(kind, declared, `AC${ac} cites ${id} as \`${kind}\` but §13 classifies it \`${declared}\``);
    }
    // A criterion proved only by positive cases cannot show that the thing it forbids stops
    // happening — and half of this project's value is in what must no longer happen.
    assert.ok(cited.some((c) => c.kind === '+'), `AC${ac} has no positive case`);
    assert.ok(cited.some((c) => c.kind === '-' || c.kind === 'M'), `AC${ac} has no refusal or migration case`);
    assert.ok(bare(row[2]).length > 0, `AC${ac} names no clause it lands in`);
  }
});

test('00.8: every internal section reference resolves', () => {
  const own = headingNumbers(PAC);
  // `§n` not preceded by `PCC ` — the coordinator contract is cited by the same glyph, and only
  // the prefix tells them apart.
  const refs = new Set(Array.from(PAC.matchAll(/(?<!PCC )§(\d+(?:\.\d+)?)/g), (m) => m[1]));
  assert.ok(refs.size > 20, 'the contract no longer cross-references itself');
  for (const ref of refs) {
    assert.ok(own.has(ref), `§${ref} is referenced but this document has no such section`);
  }
});

test('00.10: the WHERE chain refuses with exactly the three codes C7 closes it on', () => {
  // v1 returned `NO_PROJECT_WORKSPACE` both for "the project has no candidate workspace at all" and
  // for "the pin names a workspace outside the candidate set", while §12 defined the code only as
  // the first. Two implementations could disagree and both cite the contract.
  const used = refusalCodesIn(prose('7.3'));
  assert.deepEqual(
    [...used].sort(),
    ['NO_PROJECT_WORKSPACE', 'RUNTIME_REQUIREMENT_UNMET', 'WORKSPACE_PIN_NOT_A_CANDIDATE'],
    '\u00a7 7.3 refuses with a code set C7 does not close',
  );
  const rows = errorCodeTable();
  const codes = column(rows, 'code').map(bare);
  const whens = column(rows, '\u4f55\u65f6').map(bare);
  const when = new Map(codes.map((c, i) => [c, whens[i]]));
  assert.match(when.get('NO_PROJECT_WORKSPACE') ?? '', /\u5019\u9009\u96c6\u4e3a\u7a7a/,
    'NO_PROJECT_WORKSPACE is no longer restricted to the empty candidate set');
  assert.match(when.get('WORKSPACE_PIN_NOT_A_CANDIDATE') ?? '', /\u4e0d/,
    'the pin-out-of-candidates refusal has no predicate of its own');
});

test('00.11: the seven blocking contradictions of v1 each have a single answer', () => {
  // §0 is the index of the revision. It is checked because a summary that drifts from the clauses
  // it summarises is how a closed finding quietly reopens.
  const zero = tables(section(PAC, '0')).find((t) => t[0].some((h) => bare(h) === 'v1.1 的唯一结论'));
  assert.ok(zero, '§0 no longer indexes the revision');
  assert.equal(zero.length - 1, 7, 'the review raised seven blocking contradictions');
  const own = headingNumbers(PAC);
  for (const row of zero.slice(1)) {
    for (const ref of row[3].matchAll(/§(\d+(?:\.\d+)?)/g)) {
      assert.ok(own.has(ref[1]), `§0 says finding ${bare(row[0])} lands in §${ref[1]}, which does not exist`);
    }
    assert.ok(bare(row[2]).length > 0, `finding ${bare(row[0])} has no conclusion`);
  }

  // The four conclusions that are single sentences somewhere else in the document.
  assert.match(section(PAC, '11'), /`0127_project_acceptance_run`/, '§11 no longer states the real migration baseline');
  assert.match(section(PAC, '3.2'), /由迁移 `0111_project_coordinator_identity` 建立/,
    '§3.2 still treats project_member as a table this project creates');
  assert.match(section(PAC, '8.1'), /\*\*PR1（Coordinator principal 唯一化，v1\.1）\*\*/, '§8.1 has no single coordinator principal');
  assert.match(section(PAC, '7.4'), /\*\*AU-F1\*\*/, '§7.4 does not forbid a run_event without a session');
  assert.match(section(PAC, '7.3'), /WORKSPACE_PIN_NOT_A_CANDIDATE/, '§7.3 still overloads NO_PROJECT_WORKSPACE');
  assert.match(section(PAC, '11.1'), /\*\*L2（v1\.1 替换 v1 的 L2）\*\*/, '§11.1 has no rule for an existing Project Task');
});

test('00.12: the redirect drops the old foreign key before it updates the column', () => {
  // The v1.1 defect, and the one that only a real database shows: 0111's `project_member_agent_id_fkey`
  // points at `workspace(id)` and is NOT deferrable, so the UPDATE that rewrites `agent_id` to an
  // `agent.id` is refused AT THE STATEMENT — `23503`, "is not present in table workspace". v1.1
  // ordered the three statements UPDATE → DROP → ADD, which passes on an empty table (no rows to
  // check) and cannot pass on a single row of real data. A migration that is green on an empty
  // database and red on the production snapshot is the shape M3 exists to catch.
  const steps = tableHeaded(PAC, '11.2', '步骤');
  const four = steps.find((row) => bare(row[0]) === '4');
  assert.ok(four, '§11.2 no longer states step 4');
  const body = four[1];
  const drop = body.indexOf('DROP CONSTRAINT');
  const update = body.indexOf('UPDATE project_member');
  const add = body.indexOf('ADD CONSTRAINT');
  assert.ok(drop >= 0 && update >= 0 && add >= 0, 'step 4 no longer states all three statements');
  assert.ok(drop < update, 'step 4 updates project_member.agent_id BEFORE dropping the old workspace FK');
  assert.ok(update < add, 'step 4 re-adds the foreign key before the rows it must validate exist');
  assert.match(body, /同一事务/, 'step 4 no longer runs the three statements in one transaction');

  // Order alone is not the clause: M7 has to say what happens when it fails, and what is asserted
  // on either side — otherwise "it now works" is untestable on anything but an empty table.
  const m7 = section(PAC, '11.2').slice(section(PAC, '11.2').indexOf('- **M7'));
  assert.ok(m7.length > 0, '§11.2 has no M7 explaining why the order is executable');
  assert.match(m7, /23503|not present in table/, 'M7 does not name the error the old order produces');
  assert.match(m7, /回滚/, 'M7 does not say what a failure leaves behind');
  assert.match(m7, /legacy_workspace_id/, 'M7 does not state the bijection the assertions check');
  assert.match(m7, /真实 0111 外键形状/, 'M7 does not require the case to run against the real FK shape');
  for (const id of ['02B.7', '06B.3']) {
    assert.ok(m7.includes(id), `M7 does not name ${id}, so nothing runs its assertions`);
  }
});

test('00.13: each pair of refusal predicates that can both hold has one winner', () => {
  // v1.1 closed the WHERE overload by minting a second code, and `00.10` compared the two SETS —
  // which stayed equal while the two PREDICATES kept overlapping. Both chains had an input that two
  // rules answered differently, and a set comparison cannot see an intersection.
  const codesIn = (md: string): string[] => Array.from(md.matchAll(/`(WHO_[A-Z_]+|WORKSPACE_PIN_NOT_A_CANDIDATE|NO_PROJECT_WORKSPACE)`/g), (m) => m[1]);
  const when = new Map(column(errorCodeTable(), 'code').map(bare)
    .map((code, i) => [code, column(errorCodeTable(), '何时').map(bare)[i]]));

  // WHO — an agent can be off the team AND disabled at once. H4 orders the two checks, and the
  // order is readable as the sequence the clause states.
  const who = section(PAC, '7.1');
  const h4 = who.slice(who.indexOf('- **H4'));
  assert.ok(h4.length > 0, '§7.1 states no rule for an agent that is both off-team and disabled');
  assert.deepEqual([...new Set(codesIn(h4))], ['WHO_NOT_IN_TEAM', 'WHO_DISABLED'],
    'H4 does not order exactly the two refusals whose predicates can both hold');
  assert.match(when.get('WHO_NOT_IN_TEAM') ?? '', /同时为真时本行胜/, '§12 does not record which of the two wins');
  assert.match(when.get('WHO_DISABLED') ?? '', /在 Team 内/, '§12 lets WHO_DISABLED fire on an agent that is off the team');

  // WHERE — a project with no candidates at all can also carry a pin. The winner is decided by the
  // PRIORITY TABLE's own order, so this reads the table rather than a sentence about it.
  const priorities = tables(section(PAC, '7.3')).find((t) => t[0].some((h) => bare(h) === '优先级'));
  assert.ok(priorities, '§7.3 no longer states the priority table');
  const rows = priorities.slice(1).map((row) => row.join(' '));
  const empty = rows.findIndex((row) => /候选集为空/.test(row));
  const pinned = rows.findIndex((row) => /task\.workspaceId` 非空/.test(row));
  assert.ok(empty >= 0 && pinned >= 0, '§7.3 no longer decides both the empty candidate set and the pin');
  assert.ok(empty < pinned, '§7.3 decides the pin before the empty candidate set, so both rules answer that input');
  assert.match(when.get('NO_PROJECT_WORKSPACE') ?? '', /有没有 pin/, '§12 does not say the empty set wins with a pin present');
  assert.match(when.get('WORKSPACE_PIN_NOT_A_CANDIDATE') ?? '', /非空/,
    'the pin refusal does not require a non-empty candidate set, so E2’s exclusivity is only a claim');

  // And each intersection needs a case, or the ordering is a sentence nothing runs.
  const ids = new Set(cases().map((c) => c.id));
  for (const id of ['04A.19', '04C.12']) {
    assert.ok(ids.has(id), `§13 has no case ${id}, so one of the two intersections is untested`);
  }
});

test('00.14: PAC’s dispatch refusals and PCC’s blocker kinds close in both directions', () => {
  // §12 E4. PCC's own spec has checked "a kind claiming PAC as its source really is one" since its
  // v1.1 — PCC ⊆ PAC. Nothing checked the other way, so PAC could mint a dispatch refusal and every
  // test on both sides stayed green while the database answered `23514` to it. That is what happened
  // to `WORKSPACE_PIN_NOT_A_CANDIDATE` for a whole review round.
  const errors = errorCodeTable();
  const codes = column(errors, 'code').map(bare);
  const paths = column(errors, '路径').map(bare);
  for (const path_ of paths) assert.match(path_, /^(派发|写入)$/, `§12 has a refusal on neither path: ${path_}`);
  const dispatch = codes.filter((_, i) => paths[i] === '派发');
  assert.ok(dispatch.length >= 7, '§12 no longer marks the resolution chain’s refusals as dispatch-path');

  const kindTable = tableHeaded(PCC, '11.2', 'kind');
  const kinds = column(kindTable, 'kind').map(bare);
  const sources = column(kindTable, '来源').map(bare);
  const landed = column(kindTable, '落地').map(bare);

  // 1. PAC dispatch ⊆ PCC kinds — the direction that was missing.
  for (const code of dispatch) {
    assert.ok(kinds.includes(code),
      `§12 refuses a dispatch with \`${code}\`, which PCC §11.2 has no kind for — §7.4 AU-F cannot land it`);
  }
  // 2. …and back: a kind that claims to be one of ours has to be one of ours.
  for (const [i, kind] of kinds.entries()) {
    if (sources[i] !== 'PAC §12') continue;
    assert.ok(codes.includes(kind), `PCC §11.2 calls \`${kind}\` a PAC §12 refusal code, and §12 has no such row`);
  }
  // 3. Whatever PCC has not landed yet must have exactly one declared step that lands it, and that
  //    step must not name anything else. "Declared future work" is only honest if it is singular:
  //    without this, `落地` becomes a way to hold a kind in the contract and never ship it, and
  //    without the reverse half a step could quietly name a kind the table calls landed.
  //    A step DECLARES a kind with the `【落地 kind：\`X\`】` marker, not by mentioning it: 6j also
  //    rewrites PROVIDER_UNAVAILABLE's required action, and reading "appears in the cell" as
  //    "lands here" would call a kind that shipped long ago unlanded.
  const pending = kinds.filter((_, i) => landed[i] !== '已落地');
  const steps = tableHeaded(PCC, '12.1', '步骤');
  const named = (kind: string): string[] => steps.slice(1)
    .filter((row) => Array.from(row.join(' ').matchAll(/【落地 kind：([^】]*)】/g), (m) => m[1])
      .some((mark) => mark.includes(`\`${kind}\``)))
    .map((row) => bare(row[0]));
  for (const kind of pending) {
    const at = named(kind);
    assert.equal(at.length, 1,
      `PCC §11.2 leaves \`${kind}\` unlanded, and §12.1 declares it in ${at.length} steps — it needs exactly one`);
    assert.match(landed[kinds.indexOf(kind)], new RegExp(`步骤 ${at[0]}`),
      `PCC §11.2 points \`${kind}\` at a different step than the one §12.1 actually declares`);
  }
  for (const [i, kind] of kinds.entries()) {
    if (landed[i] !== '已落地') continue;
    assert.deepEqual(named(kind), [],
      `PCC §11.2 calls \`${kind}\` landed while §12.1 still declares a step that lands it`);
  }
  assert.match(section(PAC, '12'), /- \*\*E4（派发路径的码必须落得下去/, '§12 states no closure rule to check');
});

test('00.15: the control loop’s projection branches on the contract, and V1 reads no task pin', () => {
  // §16 O7, and the repo-level half of AC2. PAC v1.1 froze "a V1 task carries no provider/model pin"
  // and PCC went on reading `task.provider` in the very read set §7.4 clause 8 re-resolves from.
  // Both documents called themselves frozen, so an implementation could cite either one.
  const input = section(PCC, '6.1');
  const world = input.slice(input.indexOf('"world": {'), input.indexOf('"evaluation": {'));
  assert.match(world, /"executionContract"/,
    'PCC’s decision input cannot tell a V1 task from a legacy one, so PAC §5 step 2 is undecidable on it');

  const ec1 = tables(section(PCC, '7.4')).find((t) => bare(t[0][t[0].length - 1]) === 'revokedInput');
  assert.ok(ec1, 'PCC §7.4 EC1 no longer lists the closed read set');
  for (const row of ec1.slice(1)) {
    const read = row[2];
    for (const pin of ['task.provider', 'task.model']) {
      if (!read.includes(pin)) continue;
      assert.match(read, /LEGACY/,
        `PCC EC1 reads \`${pin}\` without saying it is the legacy branch — PAC §3.4 K1 makes it NULL on every V1 row`);
    }
  }
  assert.match(section(PCC, '7.4'), /\*\*EC1-b（V1 不读 Task 上的引擎 pin/, 'PCC states no boundary between the two branches');

  // S10 is the other half: EC1 says what is re-read at commit, S10 says what entered the hash. The
  // branch selector has to be in both, or one declared input has two legal resolutions.
  const s10 = tableHeaded(PCC, '6.1', 'EC1 #');
  const rows = s10.slice(1).map((row) => row.join(' '));
  assert.ok(rows.some((row) => row.includes('task.execution_contract') && row.includes('tasks[].executionContract')),
    'PCC S10 does not map the execution contract column into the world projection');
  assert.match(section(PAC, '16'), /- \*\*O7\*\*：~~/, 'PAC §16 still carries O7 as an open divergence');
});

test('00.16: the four blocking findings of v1.1 each have a single answer', () => {
  // Same shape as 00.11, for the second review round. §0.1 is the index; an index that drifts from
  // the clauses it indexes is how a closed finding quietly reopens, and this project has now had
  // two rounds of exactly that.
  const zero = tables(section(PAC, '0')).find((t) => t[0].some((h) => bare(h) === 'v1.2 的唯一结论'));
  assert.ok(zero, '§0.1 no longer indexes the second revision');
  assert.equal(zero.length - 1, 4, 'the second review raised four blocking findings');
  const own = headingNumbers(PAC);
  for (const row of zero.slice(1)) {
    for (const ref of row[3].matchAll(/(?<!PCC )§(\d+(?:\.\d+)?)/g)) {
      assert.ok(own.has(ref[1]), `§0.1 says finding ${bare(row[0])} lands in §${ref[1]}, which does not exist`);
    }
    assert.ok(bare(row[2]).length > 0, `finding ${bare(row[0])} has no conclusion`);
  }

  // The four conclusions, each as one sentence somewhere else in the document.
  assert.match(section(PAC, '11.2'), /\*\*M7（步骤 4 的顺序是可执行性本身/, '§11.2 has no rule fixing the statement order');
  assert.match(section(PAC, '7.1'), /\*\*H4（两条拒绝的唯一优先级，v1\.2）\*\*/, '§7.1 has no order for the WHO intersection');
  assert.match(section(PAC, '7.3'), /\*\*C8（交集的唯一优先级，v1\.2）\*\*/, '§7.3 has no order for the WHERE intersection');
  assert.match(section(PAC, '11.1'), /\*\*L5（新建 Project Task 的分流由请求形状决定/, '§11.1 has no rule for an old client’s create');
});

test('00.17: one create request has one execution contract, and the old client’s has exactly one', () => {
  // The third review round's first blocker. §11.1 L5 already said "V1 only when the request carries
  // `assigneeAgentId`", and four other places still said "a Task with a `projectId` is written V1" —
  // so one recorded old-client payload had two legal answers, each citing the frozen contract.
  // `00.16` only asserted that L5's TITLE exists, which is why the four survived a whole round.
  const l5 = section(PAC, '11.1');
  const shapes = tables(l5).find((t) => t[0].some((h) => bare(h) === '创建请求的形状'));
  assert.ok(shapes, '§11.1 L5 no longer states the request-shape table, which is the only write rule');
  assert.equal(shapes.length - 1, 3, 'a create either has no projectId, or carries the agent, or omits it — three shapes');

  // The table, read as the function it is. Two recorded old-client payloads and one new-client one
  // go through it; each has to come out with exactly one answer.
  const rule = new Map(shapes.slice(1).map((row) => [bare(row[0]), bare(row[1])]));
  const contractFor = (body: Record<string, unknown>): string[] => {
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);
    return [...rule.entries()]
      .filter(([shape]) => (/没有 projectId/.test(shape) ? !has('projectId')
        : /显式带 assigneeAgentId/.test(shape) ? has('projectId') && has('assigneeAgentId')
        : /省略 assigneeAgentId/.test(shape) ? has('projectId') && !has('assigneeAgentId')
        : false))
      .map(([, contract]) => contract);
  };

  // Recorded from what the clients on 0.1.129 actually send: neither knows the field exists.
  const recordedOldPost = { title: 'ship it', projectId: 'P', assigneeId: 'W' };
  const recordedOldBatch = { tasks: [{ title: 'a', projectId: 'P' }, { title: 'b', projectId: 'P' }] };
  assert.deepEqual(contractFor(recordedOldPost), ['LEGACY'], 'the recorded POST /tasks payload has one answer, and it is LEGACY');
  for (const item of recordedOldBatch.tasks) {
    assert.deepEqual(contractFor(item), ['LEGACY'], 'each recorded batch-create item has one answer, and it is LEGACY');
  }
  assert.deepEqual(contractFor({ title: 'ship it', projectId: 'P', assigneeAgentId: 'A' }), ['V1'], 'the new client’s create is V1');
  assert.deepEqual(contractFor({ title: 'a chore' }), ['LEGACY'], 'no project, no V1 (K3)');

  // And nothing else in the document may answer the same question. A line that decides what a
  // create writes has to name `assigneeAgentId` or defer to L5; §0 (the revision index) and §17
  // (the revision log) are excluded because they quote superseded rules on purpose, and `00.11` /
  // `00.16` already police them.
  const historical = [section(PAC, '0'), section(PAC, '17')];
  const residual = PAC.split('\n')
    .map((line) => bare(line))
    .filter((line) => /V1/.test(line) && /(新建|创建)/.test(line))
    .filter((line) => !/assigneeAgentId/.test(line) && !/L5/.test(line))
    .filter((line) => !historical.some((h) => h.includes(line)));
  assert.deepEqual(residual, [], 'a line still decides the execution contract from `projectId` alone');

  // The two clauses that used to be the other answer now point at L5 by name.
  assert.match(section(PAC, '3.4'), /唯一规则在 §11\.1 L5/, '§3.4’s field table no longer defers to the single rule');
  assert.match(l5, /本条是 `execution_contract` 写入规则的唯一规范来源/, 'L5 does not claim to be the only source');
  assert.ok(cases().some((c) => c.id === '06B.8'), '§13 lost the recorded-payload case this rule is proved by');
});

test('00.18: H4’s order is executed against the resolver, not just written down', () => {
  // `00.13` compares the clause's word order and checks that case ids exist. Both stayed green for a
  // full round while the executable WHO chain judged availability before membership and answered
  // `WHO_DISABLED` to an off-team, disabled Agent. A rule is proved where it runs.
  const named = 'PC-CX-33 H4 on the executable WHO chain: off-team beats disabled, and beats soft-deleted';
  assert.ok(MODEL.includes(`test('${named}'`), `${named} is not a test in coordinator-counterexample.spec.ts`);
  for (const intersection of ['offTeamAndDisabled', 'offTeamAndDeleted']) {
    assert.ok(MODEL.includes(intersection), `the model runs no ${intersection} counterexample`);
  }
  // Both intersections must assert the SAME single code, or "one winner" is only a claim.
  const body = MODEL.slice(MODEL.indexOf(`test('${named}'`));
  const asserted = body.slice(0, body.indexOf('\n});'));
  assert.equal((asserted.match(/refuse: 'WHO_NOT_IN_TEAM'/g) ?? []).length >= 3, true,
    'the two intersections and the off-team-only case must each land on WHO_NOT_IN_TEAM');
  assert.ok(asserted.includes("refuse: 'WHO_DISABLED'"),
    'reordering must not swallow WHO_DISABLED — it still fires on an in-team, disabled Agent');
});

test('00.19: the executable model carries the contract selector, and its V1 branch reads no pin', () => {
  // The repo-level other half of `00.15`. The documents agreed; the model had no `executionContract`
  // anywhere — not in its row type, its fixture, its resolver, its `world` projection or its S10
  // field list — so it was self-consistently green against a projection that could not tell a V1
  // task from a legacy one.
  for (const site of [
    "executionContract: 'V1' | 'LEGACY'",           // Db33: the column exists
    "executionContract: 'V1'",                       // the fixture states which branch it is on
    "read('task.execution_contract'",                // the resolver branches on it, first
    "has('tasks[].executionContract')",              // the world projection carries it
    "'tasks[].executionContract'",                   // …and S10_FIELDS declares it
  ]) {
    assert.ok(MODEL.includes(site), `the executable model is missing: ${site}`);
  }
  const named = 'PC-CX-33 the execution contract picks the read set: V1 reads the Agent, LEGACY reads the task pin';
  assert.ok(MODEL.includes(`test('${named}'`), `${named} is not a test in coordinator-counterexample.spec.ts`);

  // S10-c on this field: the pair must be one column apart, so the deletion mutation really is a
  // deletion and not a second difference doing the work.
  assert.match(MODEL, /field: 'tasks\[\]\.executionContract',/, 'S10_MUTATIONS has no pair for the selector');

  // §16 O7 stays closed on the document side; this case is the executable half of the same clause.
  assert.match(section(PAC, '16'), /- \*\*O7\*\*：~~/, '§16 reopened O7');
});
