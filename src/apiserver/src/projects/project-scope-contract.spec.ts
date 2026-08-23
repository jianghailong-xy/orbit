import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bare, column, headingNumbers, section, tableRows, tables } from './contract-doc';
import { PROJECT_BLOCKER_KINDS } from './project-blocker';
import {
  AUTHORITATIVE_OWNERSHIP_FIELD,
  SCOPE_ACCEPTANCE_MAP,
  SCOPE_NEW_REFUSAL_CODES,
  SCOPE_OPERATIONS,
  SCOPE_PROVENANCE_FIELDS,
  SCOPE_REFUSAL_CODES,
  SCOPE_REFUSAL_POLICY,
  SCOPE_REQUIRED_ACTIONS,
  SCOPE_REUSED_REFUSAL_CODES,
  SCOPE_RULES,
  SCOPE_WORK_EVENTS,
  SCOPE_WORK_STATES,
  SCOPE_WORK_TRANSITIONS,
  projectScopeToken,
} from './project-scope-contract';

// The scope contract is frozen in a document AND in this module, and the two are only worth having
// if they cannot drift apart. `coordinator-contract.spec.ts` does this for the control-loop
// contract by walking its tables; this does the same for the scope contract, with one difference
// that matters: there the document was the only artefact, here the tables exist twice. So every
// test below reads a table out of the markdown and compares it, cell for cell, against the constant
// the decision function actually executes. A row that exists in only one of the two is the failure
// this file is for — a rule nobody implements, or a rule nobody wrote down.
const REPO = path.resolve(__dirname, '../../../..');
const SCOPE = readFileSync(path.join(REPO, 'docs/project-coordinator-scope-contract.md'), 'utf8');
const PCC = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const AUTHORIZATION = readFileSync(
  path.join(REPO, 'src/apiserver/src/projects/project-authorization.service.ts'),
  'utf8',
);
const TURN_SERVICE = readFileSync(
  path.join(REPO, 'src/apiserver/src/projects/project-coordinator-turn.service.ts'),
  'utf8',
);
const CONTRACT_SRC = readFileSync(
  path.join(REPO, 'src/apiserver/src/projects/project-scope-contract.ts'),
  'utf8',
);
const DECISION_SRC = readFileSync(
  path.join(REPO, 'src/apiserver/src/projects/project-scope-decision.ts'),
  'utf8',
);

test('the document has every section it cross-references, and no gaps in the numbering', () => {
  const numbers = headingNumbers(SCOPE);
  for (let n = 0; n <= 10; n++) {
    assert.ok(numbers.has(String(n)), `§${n} is referenced but missing`);
  }
  assert.ok(numbers.has('6.1') && numbers.has('6.2'), '§6 lost one of its two tables');
});

test('§4: the document\'s rule table IS the ordered rule list the decision executes', () => {
  const rows = tableRows(section(SCOPE, '4'));
  const ids = column(rows, '序号').map(bare);
  assert.deepEqual(ids, SCOPE_RULES.map((r) => r.id),
    'the document and the code disagree about which rules exist, or about their order');

  const codes = column(rows, 'code').map(bare);
  const actions = column(rows, 'requiredAction').map(bare);
  const decisions = column(rows, 'decision').map(bare);
  SCOPE_RULES.forEach((rule, at) => {
    assert.equal(codes[at], rule.code ?? '—', `§4 ${rule.id}: wrong code`);
    assert.equal(actions[at], rule.requiredAction ?? '—', `§4 ${rule.id}: wrong requiredAction`);
    // The decision column is derived, not declared: a rule's decision is its code's decision. This
    // is the one place the two tables touch, so it is the one place they can contradict.
    const expected = rule.code ? SCOPE_REFUSAL_POLICY[rule.code].decision : 'ALLOW';
    assert.equal(decisions[at], expected, `§4 ${rule.id}: decision disagrees with §5`);
  });
});

test('§4: order is load bearing — the settled-project rule sits above every approval rule', () => {
  const at = (id: string) => SCOPE_RULES.findIndex((r) => r.id === id);
  const settled = at('R8_SETTLED_PROJECT');
  assert.ok(settled > -1, 'the settled-project rule is gone');
  for (const approval of ['R9_APPROVAL_TARGET_MISMATCH', 'R10_NO_APPROVAL', 'R11_APPROVAL_PENDING',
    'R12_APPROVAL_DENIED', 'R13_APPROVAL_EXPIRED', 'R14_HANDOFF_APPROVED']) {
    assert.ok(settled < at(approval),
      `${approval} would be reached before R8: an approval could buy a way into a settled project`);
  }
  // The user's row is unconditionally first: any rule above it would be a rule that refuses the
  // owner, and §7 RB2 / PAC §8.2 both say there is no such rule.
  assert.equal(SCOPE_RULES[0].id, 'R1_USER_AUTHORITY');
  // And the total function's last rule has no predicate.
  assert.equal(SCOPE_RULES[SCOPE_RULES.length - 1].id, 'R15_IN_SCOPE');
});

test('§5: the document\'s code table IS the frozen policy, and it classifies every code exactly once', () => {
  const rows = tableRows(section(SCOPE, '5'));
  const codes = column(rows, 'code').map(bare);
  assert.deepEqual(codes, [...SCOPE_REFUSAL_CODES], '§5 and the code list disagree');
  const decisions = column(rows, '决策').map(bare);
  const responsible = column(rows, '责任人').map(bare);
  const kinds = column(rows, 'blocker kind').map(bare);
  const origin = column(rows, '来源').map(bare);
  codes.forEach((code, at) => {
    const policy = SCOPE_REFUSAL_POLICY[code as keyof typeof SCOPE_REFUSAL_POLICY];
    assert.ok(policy, `§5 names ${code}, which the module does not declare`);
    assert.equal(decisions[at], policy.decision, `§5 ${code}: wrong decision`);
    assert.equal(responsible[at], policy.responsible, `§5 ${code}: wrong responsible party`);
    assert.equal(kinds[at], policy.blockerKind ?? '—', `§5 ${code}: wrong blocker kind`);
    const isNew = (SCOPE_NEW_REFUSAL_CODES as readonly string[]).includes(code);
    assert.equal(origin[at].startsWith('新增'), isNew, `§5 ${code}: wrong 新增/复用 classification`);
  });
  assert.equal(
    new Set([...SCOPE_NEW_REFUSAL_CODES, ...SCOPE_REUSED_REFUSAL_CODES]).size,
    SCOPE_REFUSAL_CODES.length,
    'a code is listed as both new and reused',
  );
});

test('EC4: every blocker kind this contract lands on is a member of the existing closed set', () => {
  for (const code of SCOPE_REFUSAL_CODES) {
    const kind = SCOPE_REFUSAL_POLICY[code].blockerKind;
    if (kind === null) continue;
    assert.ok((PROJECT_BLOCKER_KINDS as readonly string[]).includes(kind),
      `${code} lands on ${kind}, which project_blocker_kind_chk would refuse to store`);
  }
});

test('EC1: the reused codes are really reused, and the new ones are really new', () => {
  const union = /export type ProjectAuthorizationReasonCode =([\s\S]*?);\n/.exec(AUTHORIZATION);
  assert.ok(union, 'the reason-code union no longer parses');
  const reasonCodes = new Set([...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
  for (const code of SCOPE_REUSED_REFUSAL_CODES) {
    const known = reasonCodes.has(code) || TURN_SERVICE.includes(`'${code}'`);
    assert.ok(known, `${code} is declared as reused but nothing else in the tree declares it`);
  }
  for (const code of SCOPE_NEW_REFUSAL_CODES) {
    assert.ok(!reasonCodes.has(code),
      `${code} is declared as new but already exists — it would be a synonym (PAC §12 E2)`);
  }
});

test('§6: the document\'s transition table IS the transition function, cell for cell', () => {
  const rows = tableRows(section(SCOPE, '6.2'));
  const header = rows[0].map(bare);
  assert.deepEqual(header.slice(1), [...SCOPE_WORK_EVENTS], '§6.2 and the event list disagree');
  const states = rows.slice(1).map((cells) => bare(cells[0]));
  assert.deepEqual(states, [...SCOPE_WORK_STATES], '§6.2 and the state list disagree');
  rows.slice(1).forEach((cells, row) => {
    const state = SCOPE_WORK_STATES[row];
    SCOPE_WORK_EVENTS.forEach((event, at) => {
      const expected = SCOPE_WORK_TRANSITIONS[state][event] ?? '—';
      assert.equal(bare(cells[at + 1]), expected, `§6.2 (${state}, ${event}) disagrees with the code`);
    });
  });
});

test('§9: every clause maps onto a criterion the project actually states', () => {
  const rows = tableRows(section(SCOPE, '9'));
  const clauses = column(rows, '条款').map(bare);
  const criteria = column(rows, '验收标准').map(bare);
  assert.deepEqual(clauses, Object.keys(SCOPE_ACCEPTANCE_MAP), '§9 and the acceptance map disagree');

  // The twelve are not copied here: PCC §14 is their table, and a copy is a thing that drifts.
  const stated = tableRows(section(PCC, '14'))
    .map((cells) => bare(cells[0]))
    .filter((cell) => /^AC\d+$/.test(cell));
  assert.equal(stated.length, 12, 'the project no longer states twelve acceptance criteria');

  clauses.forEach((clause, at) => {
    const ordinals = SCOPE_ACCEPTANCE_MAP[clause];
    assert.ok(ordinals.length > 0, `${clause} maps onto nothing — it is a prompt, not a contract`);
    assert.deepEqual(criteria[at].split('·').map((c) => c.trim()), ordinals.map((n) => `AC${n}`),
      `§9 ${clause}: the document and the map name different criteria`);
    for (const ordinal of ordinals) {
      assert.ok(stated.includes(`AC${ordinal}`),
        `${clause} maps onto AC${ordinal}, which PCC §14 does not state`);
    }
  });
  // Every SC the invariants section declares has to be mapped. An invariant nobody's acceptance
  // criterion covers is one the project can be declared DONE without.
  const declared = tableRows(section(SCOPE, '3')).map((cells) => bare(cells[0])).filter((c) => /^SC\d+$/.test(c));
  assert.deepEqual(declared, Object.keys(SCOPE_ACCEPTANCE_MAP),
    'an invariant is stated in §3 but mapped onto no acceptance criterion (or the reverse)');
});

test('CM3: the contract adds no business entity, and nothing here can touch a database', () => {
  // Structural, not a promise in prose: a module that imports Prisma or Nest is a module that has
  // started to be an implementation, and this unit is finished before implementation starts.
  for (const [name, src] of [['contract', CONTRACT_SRC], ['decision', DECISION_SRC]] as const) {
    assert.ok(!/@prisma\/client|@nestjs|PrismaService/.test(src),
      `${name} module reaches for the database layer; §1 says it decides rules, not writes`);
  }
  assert.match(section(SCOPE, '8'), /不新增业务实体/, 'CM3 no longer says what it promises');
  // Everything this contract names is either an existing column or a derived value.
  assert.equal(AUTHORITATIVE_OWNERSHIP_FIELD, 'projectId');
  assert.deepEqual([...SCOPE_PROVENANCE_FIELDS],
    ['discoveredFromProjectId', 'triggerEvent', 'sourceTaskId', 'sourceSessionId']);
});

test('§2: the scope token is derived from exactly the pair it claims to describe', () => {
  assert.equal(projectScopeToken('11111111-2222-3333-4444-555555555555', 7n),
    'psc:v1:11111111-2222-3333-4444-555555555555:7');
  assert.equal(projectScopeToken('p', '7'), projectScopeToken('p', 7));
  // Different scopes never collide, which is the whole of its job.
  const tokens = new Set([
    projectScopeToken('a', 1), projectScopeToken('a', 2),
    projectScopeToken('b', 1), projectScopeToken('b', 2),
  ]);
  assert.equal(tokens.size, 4);
  assert.match(section(SCOPE, '2'), /psc:v1:<projectId>:<generation>/, '§2 no longer states the shape');
});

test('the closed sets are closed: no duplicates, and every member is used by the tables', () => {
  for (const [name, members] of [
    ['operations', SCOPE_OPERATIONS], ['required actions', SCOPE_REQUIRED_ACTIONS],
    ['states', SCOPE_WORK_STATES], ['events', SCOPE_WORK_EVENTS], ['codes', SCOPE_REFUSAL_CODES],
  ] as const) {
    assert.equal(new Set(members).size, members.length, `${name} has a duplicate member`);
  }
  const usedActions = new Set(SCOPE_RULES.map((r) => r.requiredAction).filter(Boolean));
  assert.deepEqual([...usedActions].sort(), [...SCOPE_REQUIRED_ACTIONS].sort(),
    'a required action nothing can produce, or a rule producing one that is not declared');
  const usedCodes = new Set(SCOPE_RULES.map((r) => r.code).filter(Boolean));
  assert.deepEqual([...usedCodes].sort(), [...SCOPE_REFUSAL_CODES].sort(),
    'a code no rule produces, or a rule producing one that is not declared');
});
