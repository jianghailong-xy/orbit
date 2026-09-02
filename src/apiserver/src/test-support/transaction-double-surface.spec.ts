/**
 * The invariant this whole mechanism exists for: a transaction double's member surface must
 * cover everything production reaches on a transaction, and a shortfall must surface while
 * building rather than half an hour into an acceptance as `X is not a function`.
 *
 * Four separate drifts of exactly that shape were paid for in full Release DAG rounds:
 * `args[0].join is not a function`, `conversationTurn.findMany`, `task.findMany` and
 * `runner.findUnique`. Each is a fixture below, and each is asserted to fail now at compile or
 * static-check time.
 *
 * The negative controls matter as much as the positives. A checker that passed everything would
 * satisfy every "no missing members" assertion here, so each rule is also handed an input it must
 * reject, naming what it rejected.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  accommodations,
  auditTransactionSurface,
  declaredSurface,
  describeMissing,
  rawQueryHandRolling,
  usedSurface,
} from './transaction-surface-check';

const API = path.resolve(__dirname, '..', '..');
const SRC = path.join(API, 'src');
const TSC = path.join(API, 'node_modules', '.bin', 'tsc');

/**
 * The delegate names come from the generated client, never from a list kept here. A model that is
 * renamed therefore stops being recognised at the moment it stops existing, instead of leaving
 * this audit quietly matching a name the schema no longer has.
 */
const DELEGATES: ReadonlySet<string> = new Set(
  Object.keys(Prisma.ModelName).map((model) => model.charAt(0).toLowerCase() + model.slice(1)),
);

function read(relative: string): string {
  return readFileSync(path.join(SRC, relative), 'utf8');
}

/** A named span of a file, so a shared identifier like `tx` is audited only where it is the one. */
function region(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `region start not found: ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `region end not found: ${to}`);
  return source.slice(start, end);
}

/**
 * Every production region that declares a transaction surface, and the identifier it reads it
 * through. Adding a narrowed function here is what puts it under the audit.
 */
const AUDITED = [
  {
    label: 'sessions/current-work-delivery.ts',
    file: 'sessions/current-work-delivery.ts',
    identifiers: ['tx'],
  },
  {
    label: 'projects/task-aggregation-writer.ts',
    file: 'projects/task-aggregation-writer.ts',
    identifiers: ['db'],
  },
  {
    label: 'runner-api/runner-api.controller.ts#retryPlanFor',
    file: 'runner-api/runner-api.controller.ts',
    identifiers: ['tx'],
    from: 'private async retryPlanFor(',
    to: 'private async assertSessionOwnership(',
  },
] as const;

test('every audited production region reaches only members its own surface declares', () => {
  for (const entry of AUDITED) {
    const whole = read(entry.file);
    const scoped = 'from' in entry ? region(whole, entry.from, entry.to) : whole;
    const report = auditTransactionSurface(scoped, entry.identifiers, DELEGATES, whole);

    assert.ok(
      report.declared.length > 0,
      `${entry.label} declares no transaction surface; the audit would be vacuous`,
    );
    assert.ok(
      report.used.length > 0,
      `${entry.label} reaches no transaction member; the audit would be vacuous`,
    );
    assert.deepEqual(report.missing, [], describeMissing(entry.label, report.missing));
  }
});

test('no audited production region makes a Prisma delegate optional to suit a double', () => {
  for (const entry of AUDITED) {
    const whole = read(entry.file);
    const scoped = 'from' in entry ? region(whole, entry.from, entry.to) : whole;
    assert.deepEqual(
      accommodations(scoped, entry.identifiers, DELEGATES),
      [],
      `${entry.label} defends against a delegate a real client always has`,
    );
  }
});

test('the difference is reported by name, not as a count', () => {
  const source = `
    type T = TransactionSurface<{ task: ['findMany'] }>;
    async function f(tx: T) {
      await tx.task.findMany({});
      await tx.runner.findUnique({});
      await tx.conversationTurn.findMany({});
    }
  `;
  const report = auditTransactionSurface(source, ['tx'], DELEGATES);

  assert.deepEqual(
    report.missing.map((entry) => `${entry.delegate}.${entry.method}`),
    ['conversationTurn.findMany', 'runner.findUnique'],
  );
  const sentence = describeMissing('fixture', report.missing);
  assert.match(sentence, /missing 2 member\(s\)/);
  assert.match(sentence, /conversationTurn\.findMany/);
  assert.match(sentence, /runner\.findUnique/);
});

test('prose naming a delegate is not mistaken for reaching one', () => {
  const source = `
    /** tx.task.findMany is described here and never called. */
    type T = TransactionSurface<{ task: ['findMany'] }>;
    // tx.runner.findUnique in a line comment either.
    async function f(tx: T) { await tx.task.findMany({}); }
  `;
  assert.deepEqual(
    usedSurface(source, ['tx'], DELEGATES).map((entry) => `${entry.delegate}.${entry.method}`),
    ['task.findMany'],
  );
});

test('the accommodation rule rejects each way production can dodge a delegate', () => {
  const dodges = [
    'if (tx?.task) return;',
    'const rows = await tx.task?.findMany({});',
    "if (!('task' in tx)) return;",
    "if (typeof tx.task === 'undefined') return;",
  ];
  for (const dodge of dodges) {
    assert.equal(
      accommodations(dodge, ['tx'], DELEGATES).length,
      1,
      `accommodation not detected: ${dodge}`,
    );
  }
  assert.deepEqual(
    accommodations('const at = runner?.planUsage; const n = row?.count;', ['tx'], DELEGATES),
    [],
    'optional chaining on a result row is not an accommodation',
  );
});

test('a $queryRaw double may not take the two calling conventions apart itself', () => {
  const handRolled = `
    const tx = {
      $queryRaw: async (...args: unknown[]) => {
        const sql = args[0].join('?');
        return [];
      },
    };
  `;
  assert.deepEqual(rawQueryHandRolling(handRolled), ['args[0]']);

  const routed = `
    const tx = {
      $queryRaw: async (...args: unknown[]) => {
        const sql = renderRawQuery(args).text;
        return [];
      },
    };
  `;
  assert.deepEqual(rawQueryHandRolling(routed), []);
});

/** Every spec on disk, tracked or not: a rule that skipped new files would miss the next drift. */
function everySpec(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) everySpec(full, found);
    else if (entry.name.endsWith('.spec.ts')) found.push(full);
  }
  return found;
}

/**
 * This file is the one place a violation is deliberate: the rule's own counter-example above is a
 * `$queryRaw` body that reads `args[0]`, and it has to stay one, or the test proving the rule
 * catches anything would be asserting against nothing. It is named here rather than pattern-matched
 * so the exemption cannot silently widen, and the sweep asserts it removed exactly this one file.
 */
const RULE_FIXTURES = path.join(SRC, 'test-support', 'transaction-double-surface.spec.ts');

test('no spec hand-rolls the $queryRaw calling conventions', () => {
  const all = everySpec(SRC);
  assert.ok(all.length > 100, `expected the whole spec inventory, saw ${all.length}`);
  const specs = all.filter((spec) => spec !== RULE_FIXTURES);
  assert.equal(all.length - specs.length, 1, 'the fixture exemption must remove exactly one file');
  const offenders: string[] = [];
  for (const spec of specs) {
    const hand = rawQueryHandRolling(readFileSync(spec, 'utf8'));
    if (hand.length > 0) offenders.push(`${path.relative(SRC, spec)}: ${hand.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `these doubles parse $queryRaw arguments themselves: ${offenders.join('; ')}`);
});

/**
 * Compile one fixture in isolation and hand back tsc's diagnostics.
 *
 * The fixture imports the real production surface, so what is proved is the shipped declaration's
 * behaviour and not a restatement of it. `@prisma/client` is resolved the same way the compiled
 * spec resolves it, which under the Full API acceptance is the isolated client generated for the
 * candidate schema rather than the workspace one.
 */
function compileFixture(body: string): { ok: boolean; output: string } {
  const client = path.dirname(require.resolve('@prisma/client'));
  const dir = mkdtempSync(path.join(API, 'build', 'transaction-double-drift-'));
  try {
    writeFileSync(path.join(dir, 'fixture.ts'), body);
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        lib: ['ES2022'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        paths: { '@prisma/client': [client] },
      },
      files: ['fixture.ts'],
    }));
    try {
      execFileSync(TSC, ['-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' });
      return { ok: true, output: '' };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CURRENT_WORK = path.join(SRC, 'sessions', 'current-work-delivery').replaceAll('\\', '/');
const SURFACE = path.join(SRC, 'common', 'prisma-transaction-surface').replaceAll('\\', '/');

/** A double that supplies every declared member, so the fixture harness is proved to accept one. */
const COMPLETE_CURRENT_WORK = `
import type { CurrentWorkSteerTransaction } from '${CURRENT_WORK}';
const tx: CurrentWorkSteerTransaction = {
  conversationTurn: {
    findMany: (() => []) as never,
    updateMany: (() => ({ count: 0 })) as never,
  },
};
void tx;
`;

test('the drift harness accepts a double that supplies every declared member', () => {
  const result = compileFixture(COMPLETE_CURRENT_WORK);
  assert.ok(result.ok, `a complete double must compile, tsc said: ${result.output}`);
});

/**
 * The three member-shaped drifts, each reintroduced against the real shipped surface.
 *
 * `task.findMany` and `runner.findUnique` are declared through the shared surface helper here
 * rather than through their own modules, because importing a Nest controller would pull half the
 * application into a fixture; the audit above is what proves the shipped modules declare exactly
 * these members, and this is what proves removing one stops compiling.
 */
const MEMBER_DRIFTS = [
  {
    name: 'conversationTurn.findMany',
    expect: /Property 'findMany' is missing[\s\S]*ConversationTurnDelegate/,
    fixture: `
import type { CurrentWorkSteerTransaction } from '${CURRENT_WORK}';
const tx: CurrentWorkSteerTransaction = {
  conversationTurn: { updateMany: (() => ({ count: 0 })) as never },
};
void tx;
`,
  },
  {
    name: 'task.findMany',
    expect: /Property 'findMany' is missing[\s\S]*TaskDelegate/,
    fixture: `
import type { TransactionSurface } from '${SURFACE}';
type Scope = TransactionSurface<{ task: ['findMany'] }>;
const db: Scope = { task: {} };
void db;
`,
  },
  {
    name: 'runner.findUnique',
    expect: /Property 'findUnique' is missing[\s\S]*RunnerDelegate/,
    fixture: `
import type { TransactionSurface } from '${SURFACE}';
type Quota = TransactionSurface<{ runner: ['findUnique'] }>;
const tx: Quota = { runner: {} };
void tx;
`,
  },
] as const;

for (const drift of MEMBER_DRIFTS) {
  test(`removing ${drift.name} from a double fails to compile, and the error names it`, () => {
    const result = compileFixture(drift.fixture);
    assert.equal(result.ok, false, `removing ${drift.name} still compiled`);
    assert.match(result.output, drift.expect);
    assert.match(result.output, new RegExp(drift.name.split('.')[1]));
  });
}

test('production reaching a delegate its surface never declared fails to compile, naming it', () => {
  const result = compileFixture(`
import type { CurrentWorkSteerTransaction } from '${CURRENT_WORK}';
export async function production(tx: CurrentWorkSteerTransaction) {
  return tx.runner.findUnique({ where: { id: 'x' } });
}
`);
  assert.equal(result.ok, false, 'reaching an undeclared delegate still compiled');
  assert.match(result.output, /Property 'runner' does not exist on type/);
});

test('production reaching an undeclared method of a declared delegate fails to compile, naming it', () => {
  const result = compileFixture(`
import type { CurrentWorkSteerTransaction } from '${CURRENT_WORK}';
export async function production(tx: CurrentWorkSteerTransaction) {
  return tx.conversationTurn.deleteMany({ where: {} });
}
`);
  assert.equal(result.ok, false, 'reaching an undeclared method still compiled');
  assert.match(result.output, /Property 'deleteMany' does not exist on type/);
});

test('a surface naming a method Prisma does not declare fails to compile', () => {
  const result = compileFixture(`
import type { TransactionSurface } from '${SURFACE}';
type Bad = TransactionSurface<{ task: ['findManny'] }>;
declare const tx: Bad;
void tx;
`);
  assert.equal(result.ok, false, 'a misspelled method name still compiled');
  assert.match(result.output, /findManny/);
});

test('every surface declaration in the audited modules is honoured by the shipped source', () => {
  for (const entry of AUDITED) {
    const declared = declaredSurface(read(entry.file));
    for (const member of declared) {
      if (!member.delegate) continue;
      assert.ok(
        DELEGATES.has(member.delegate),
        `${entry.label} declares '${member.delegate}', which the generated client does not have`,
      );
    }
  }
});
