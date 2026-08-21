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
// This file judges nothing about the design. It only holds the contract to the closure it claims.
const REPO = path.resolve(__dirname, '../../../..');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');

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
