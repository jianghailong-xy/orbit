import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

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
const REPO = path.resolve(__dirname, '../../../..');
const PCC = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');

/** Every `## n.` / `### n.m` heading number in a doc. */
function headingNumbers(doc: string): Set<string> {
  const found = new Set<string>();
  for (const line of doc.split('\n')) {
    const m = /^#{2,3}\s+(\d+(?:\.\d+)?)[.\s]/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

/** The body of one section, from its heading up to the next heading of the same or higher level. */
function section(doc: string, number: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${number.replace('.', '\\.')}[.\\s]`).test(l));
  assert.notEqual(start, -1, `section ${number} not found`);
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** Cells of every `| … |` row in a chunk of markdown, minus the header and the `---` separator. */
function tableRows(md: string): string[][] {
  return md
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c) || c === ''));
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

test('the state machine names the same seven states in §4.1 and §4.2', () => {
  const declared = tableRows(section(PCC, '4.1'))
    .slice(1)
    .map((cells) => cells[0].replace(/`/g, ''));
  assert.equal(declared.length, 7, 'the run state machine is frozen at seven states');
  assert.ok(declared.includes('PLANNING'), 'PLANNING is the state AC3 is stated against');

  const transitions = tableRows(section(PCC, '4.2'))
    .slice(1)
    .map((cells) => [cells[0].replace(/`/g, ''), cells[1].replace(/`/g, '')] as const)
    // Two rows describe a set of sources rather than one state ("任意非终态").
    .filter(([from]) => /^[A-Z_]+$/.test(from));

  for (const [from, to] of transitions) {
    assert.ok(declared.includes(from), `transition source ${from} is not a declared state`);
    assert.ok(declared.includes(to), `transition target ${to} is not a declared state`);
  }
  // Reachability, both directions: a state nothing enters is dead, and a non-terminal state
  // nothing leaves is a trap — either one means the table and the machine have drifted apart.
  for (const state of declared) {
    if (state !== 'PLANNING') {
      assert.ok(transitions.some(([, to]) => to === state), `nothing enters ${state}`);
    }
    assert.ok(transitions.some(([from]) => from === state), `nothing leaves ${state}`);
  }
});

test('blocker kinds are unique, and the ones claiming to come from PAC §12 really do', () => {
  const pacCodes = new Set(
    tableRows(section(PAC, '12'))
      .slice(1)
      .map((cells) => cells[0].replace(/`/g, '')),
  );
  const kinds = tableRows(section(PCC, '11.2'))
    .slice(1)
    .map((cells) => ({ kind: cells[0].replace(/`/g, ''), source: cells[1] }));

  assert.equal(new Set(kinds.map((k) => k.kind)).size, kinds.length, 'duplicate blocker kind');
  const inherited = kinds.filter((k) => k.source === 'PAC §12');
  assert.ok(inherited.length >= 6, 'the refusal codes are supposed to be reused, not renamed');
  for (const { kind } of inherited) {
    assert.ok(pacCodes.has(kind), `${kind} claims to be a PAC §12 refusal code but is not one`);
  }
  // Every blocker must be able to answer §11.1's four questions, so every row needs an owner and
  // a next check — a blocker without either is exactly the silent stall this project exists to end.
  for (const cells of tableRows(section(PCC, '11.2')).slice(1)) {
    assert.match(cells[2], /USER|COORDINATOR|SYSTEM/, `${cells[0]} has no owner`);
    assert.ok(cells[3].length > 0, `${cells[0]} has no next check`);
  }
});

test('every action has a distinct idempotency key template', () => {
  const rows = tableRows(section(PCC, '7.3'))
    .slice(1)
    .map((cells) => ({ type: cells[0].replace(/`/g, ''), key: cells[2].replace(/`/g, '') }))
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
  const infraTables = tableRows(section(PCC, '2.4')).slice(1).length;
  const total = /业务字段 \*\*(\d+) 个\*\*.*新业务实体 \*\*(\d+) 个\*\*.*新基础设施表 \*\*(\d+) 张\*\*/.exec(
    section(PCC, '14'),
  );
  assert.ok(total, 'the mapping table no longer states its totals');
  assert.equal(Number(total[1]), businessFields, '§2.2 and the §14 total disagree on business fields');
  assert.equal(Number(total[2]), 0, 'the contract forbids new business entities (§2.3)');
  assert.equal(Number(total[3]), infraTables, '§2.4 and the §14 total disagree on infrastructure tables');
});

test('no infrastructure table is a business entity in disguise', () => {
  // §2.3's own test: a table carrying a title, a goal or acceptance criteria is a thing a person
  // is trying to achieve, and this project is not allowed to add one.
  for (const cells of tableRows(section(PCC, '2.4')).slice(1)) {
    const [table, , judgement] = cells;
    assert.doesNotMatch(
      judgement + table,
      /`?(title|goal|acceptance_criteria)`?/,
      `${table} looks like a business entity`,
    );
  }
});
