import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  EXCLUDED_SOURCES,
  STATEMENT_CLASSES,
  STATEMENT_UNITS,
  TRANSACTION_PARTICIPANTS,
  TRANSACTION_UNITS,
  TRIGGER_WRITE_SOURCES,
} from './db-write-inventory';

/**
 * What keeps `db-write-inventory.ts` from becoming a document that used to be true.
 *
 * Everything here is derived from the tree rather than remembered: the write sites are scanned out
 * of the TypeScript, the triggers are replayed out of `prisma/migrations`, and both are compared
 * to what the inventory declares. A new write, a moved method, a widened trigger column list or a
 * new cross-relation lock all fail this file until the entry that describes them moves with them.
 *
 * The scan is deliberately syntactic. A type-aware pass would be more precise and would also be a
 * second implementation of "what is a database write" that could drift from the one a reviewer
 * applies by eye; a regex over the same text a reviewer reads cannot.
 */

// Resolved against the package root, not `__dirname`: this runs from `build/common`, and the
// subject is the TypeScript a reviewer reads, not the JavaScript it compiles to.
const SRC = path.resolve(__dirname, '../../src');
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/** The Prisma model methods that write. `findMany`/`count`/`aggregate` are absent on purpose. */
const MODEL_WRITE =
  /\b(?:this\.prisma|prisma|tx|db|client|this\.db)\.([A-Za-z][A-Za-z0-9_]*)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/g;
const METHOD =
  /^ {2}(?:private |protected |public |static |readonly |abstract )*(?:async )?(?:\*)?([A-Za-z0-9_$]+)\s*[(<]/;
const FUNCTION =
  /^export (?:async )?function ([A-Za-z0-9_$]+)|^(?:async )?function ([A-Za-z0-9_$]+)|^export const ([A-Za-z0-9_$]+)\s*[=:]/;
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'do', 'else', 'try',
]);
/** A `$queryRaw` that takes a row or advisory lock — the reads that are really writes' neighbours. */
const TAKES_LOCK = /FOR (?:NO KEY )?UPDATE|FOR (?:KEY )?SHARE|pg_advisory/;
/**
 * A `$queryRaw` whose statement changes rows or schema.
 *
 * Every alternative ends on a boundary the keyword really has in SQL — the whitespace or quote that
 * has to follow it — because these run against prose and column aliases as well as statements. Without
 * the `\b`, `TRUNCATE` matches the `truncated` a read-only leaderboard selects, and a SELECT is then
 * asked to declare a retry decision for a write it does not make.
 */
const WRITES_ROWS = /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|CREATE\s+|DROP\s+|ALTER\s+|TRUNCATE\b)/i;

type Shape = 'TX_RETRIED' | 'TX_BARE' | 'INHERITED' | 'AUTOCOMMIT';

interface Scanned {
  at: string;
  shape: Shape;
  /** How many write/lock sites the method contains. */
  sites: number;
}

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Blank out comments without moving a single line.
 *
 * These files NAME their statements in prose — "`tx.task.update` below takes the same row" — and
 * counting a sentence as a write would ask the inventory to carry a retry decision for one.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

/** Every method in the tree that writes, with how it reaches the database. */
function scan(): Scanned[] {
  const units = new Map<string, { kinds: Set<string>; sites: number; inherits: boolean }>();
  for (const file of sources(SRC).sort()) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (EXCLUDED_SOURCES.some((excluded) => rel === excluded.path || rel.startsWith(excluded.path))) {
      continue;
    }
    const raw = readFileSync(file, 'utf8');
    const code = withoutComments(raw);
    const lines = code.split('\n');
    const rawLines = raw.split('\n');
    let method = '(module)';
    let declaredAt = 0;
    lines.forEach((line, index) => {
      const declaration = rawLines[index];
      const asMethod = METHOD.exec(declaration);
      if (asMethod && !NOT_A_METHOD.has(asMethod[1])) {
        method = asMethod[1];
        declaredAt = index;
      } else {
        const asFunction = FUNCTION.exec(declaration);
        if (asFunction) {
          method = asFunction[1] ?? asFunction[2] ?? asFunction[3];
          declaredAt = index;
        }
      }
      const key = `${rel}#${method}`;
      const add = (kind: string): void => {
        let unit = units.get(key);
        if (!unit) {
          // A method that takes a transaction client is a participant: its boundary is its
          // caller's. Read off the signature, so a helper that started opening its own
          // transaction cannot change category quietly.
          const signature = lines.slice(declaredAt, declaredAt + 14).join('\n');
          const head = signature.slice(0, signature.indexOf('{') >= 0 ? signature.indexOf('{') : signature.length);
          unit = { kinds: new Set(), sites: 0, inherits: /TransactionClient|\btx\s*[:?]|\bdb\s*[:?]/.test(head) };
          units.set(key, unit);
        }
        unit.kinds.add(kind);
        unit.sites += 1;
      };
      let hit: RegExpExecArray | null;
      MODEL_WRITE.lastIndex = 0;
      while ((hit = MODEL_WRITE.exec(line))) add('STATEMENT');
      if (/withTransactionRetry\(/.test(line)) add('TX_RETRIED');
      else if (/\$transaction\(/.test(line)) add('TX_BARE');
      if (/\$executeRaw/.test(line)) add('RAW_WRITE');
      if (/\$queryRaw/.test(line)) {
        // A tagged template spans lines; take the window up to its terminator.
        const window = lines.slice(index, index + 16).join('\n');
        const end = window.indexOf('`;');
        const statement = end >= 0 ? window.slice(0, end + 2) : window;
        if (TAKES_LOCK.test(statement)) add('LOCK');
        else if (WRITES_ROWS.test(statement)) add('RAW_WRITE');
      }
    });
  }
  return [...units]
    .map(([at, unit]) => {
      const shape: Shape = unit.kinds.has('TX_RETRIED')
        ? 'TX_RETRIED'
        : unit.kinds.has('TX_BARE')
          ? 'TX_BARE'
          : unit.inherits
            ? 'INHERITED'
            : 'AUTOCOMMIT';
      return { at, shape, sites: unit.sites };
    })
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
}

const SCANNED = scan();

test('every database write in the tree is in the inventory, and nothing else is', () => {
  const declared = new Map<string, Shape>([
    ...TRANSACTION_UNITS.map((unit) => [unit.at, unit.shape] as const),
    ...TRANSACTION_PARTICIPANTS.map((unit) => [unit.at, 'INHERITED'] as const),
    ...STATEMENT_UNITS.map((unit) => [unit.at, 'AUTOCOMMIT'] as const),
  ]);
  const scanned = new Map(SCANNED.map((unit) => [unit.at, unit.shape]));

  const unregistered = [...scanned].filter(([at]) => !declared.has(at)).map(([at, shape]) => `${at} (${shape})`);
  assert.deepEqual(
    unregistered,
    [],
    'a database write appeared with no inventory entry — add it to db-write-inventory.ts with its ' +
      'lock order, its identity, its replay argument and what answers a conflict it cannot absorb',
  );

  const stale = [...declared]
    .filter(([at]) => !scanned.has(at))
    // Participants inside an excluded source are declared so the exclusion is of the boundary
    // only; the scan never sees them, which is the point.
    .filter(([at]) => !EXCLUDED_SOURCES.some((excluded) => at.startsWith(excluded.path)))
    .map(([at]) => at);
  assert.deepEqual(stale, [], 'an inventory entry no longer describes anything — remove it');

  const miscategorised = [...scanned]
    .filter(([at, shape]) => declared.get(at) !== shape)
    .map(([at, shape]) => `${at}: inventory says ${declared.get(at)}, source says ${shape}`);
  assert.deepEqual(
    miscategorised,
    [],
    'a write changed how it reaches the database — its retry decision has to be restated, not moved',
  );
});

test('every retried unit really is retried, and every statement really is not', () => {
  const files = new Map<string, string>();
  const read = (rel: string): string => {
    let source = files.get(rel);
    if (!source) {
      source = readFileSync(path.join(SRC, rel), 'utf8');
      files.set(rel, source);
    }
    return source;
  };
  for (const unit of TRANSACTION_UNITS) {
    const [rel] = unit.at.split('#');
    assert.match(
      read(rel),
      /withTransactionRetry\(/,
      `${unit.at} is declared ${unit.shape} and ${rel} does not call withTransactionRetry`,
    );
  }
  for (const unit of STATEMENT_UNITS) {
    assert.ok(
      STATEMENT_CLASSES[unit.class],
      `${unit.at} names a statement class that does not exist`,
    );
    assert.ok(unit.statements >= 1, `${unit.at} claims ${unit.statements} statements`);
  }
});

/**
 * Every retry says which operation it is.
 *
 * An unlabelled retry absorbs a conflict and leaves no record that it did, which is the one
 * failure mode a retry loop can have that looks exactly like health. The label is also what the
 * metrics and the runbook aggregate on, so it has to exist at the call site rather than be
 * recovered from a stack.
 */
test('every retry names the operation it is retrying', () => {
  const LABEL = /loggedRetry\(this\.(?:log|logger),|this\.transientWriteRetry\('/g;
  const mismatched: string[] = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === 'common/transaction-retry.ts') continue;
    if (EXCLUDED_SOURCES.some((excluded) => rel === excluded.path || rel.startsWith(excluded.path))) continue;
    const code = withoutComments(readFileSync(file, 'utf8'));
    const calls = code.match(/withTransactionRetry\(/g)?.length ?? 0;
    if (calls === 0) continue;
    // `tasks.service.ts` has one more label expression than calls: the private helper that
    // forwards to `loggedRetry` is itself one.
    const labels = (code.match(LABEL)?.length ?? 0) - (/private transientWriteRetry\(/.test(code) ? 1 : 0);
    if (labels !== calls) mismatched.push(`${rel}: ${calls} retries, ${labels} labels`);
  }
  assert.deepEqual(
    mismatched,
    [],
    'a retry was added without an operation name — it would absorb conflicts silently and appear ' +
      'in no metric',
  );
});

/**
 * Nobody else answers the question the classifier answers.
 *
 * The failure this prevents is not a duplicated constant — it is two places deciding what
 * "transient" means and disagreeing, which is how a conflict ends up retried by one layer and
 * answered 500 by another. So the SQLSTATEs and Prisma's code for them may appear in exactly one
 * module, plus the tests and fixtures that deliberately produce them.
 */
test('40P01, 40001 and P2034 are decided in one place', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === 'common/transaction-retry.ts' || rel.startsWith('deadlock/')) continue;
    const code = withoutComments(readFileSync(file, 'utf8'));
    if (/40P01|40001|P2034/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    'a private copy of the transient-conflict verdict appeared — call classifyTransactionError ' +
      'instead, so the retry loop and the error boundary cannot disagree',
  );
});

/**
 * The lines of one transaction closure: from its `=> {` to the `}` that matches it.
 *
 * Braces, not parentheses. A parenthesis count runs on past the closure into the `.catch(…)` that
 * often follows — and that catch runs AFTER the rollback, which is where two of these services
 * deliberately read with the unmanaged client. Scanning it would report the one shape that is
 * definitely correct.
 */
function closureBody(lines: readonly string[], start: number): { from: number; to: number } | null {
  let opened = -1;
  for (let cursor = start; cursor < Math.min(start + 6, lines.length); cursor += 1) {
    if (/=>\s*\{/.test(lines[cursor].replace(/\/\/.*$/, ''))) {
      opened = cursor;
      break;
    }
  }
  if (opened < 0) return null;
  let depth = 0;
  let seen = false;
  for (let cursor = opened; cursor < lines.length; cursor += 1) {
    const code = lines[cursor].replace(/\/\/.*$/, '');
    for (const character of code) {
      if (character === '{') {
        depth += 1;
        seen = true;
      } else if (character === '}') {
        depth -= 1;
        // Char-precise, because the closure's own `}` and the `{` of a `.catch(async (e) => {`
        // chained onto it routinely share a line. Stopping at end-of-line would swallow the catch,
        // which runs AFTER the rollback and is exactly where the unmanaged client belongs.
        if (seen && depth <= 0) return { from: opened, to: cursor };
      }
    }
  }
  return null;
}

/** Every transaction closure in a source file that is not a comment. */
function closures(source: string): Array<{ from: number; to: number }> {
  const lines = source.split('\n');
  const found: Array<{ from: number; to: number }> = [];
  lines.forEach((line, index) => {
    if (!/\$transaction\(|withTransactionRetry\(/.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const body = closureBody(lines, index);
    if (body) found.push(body);
  });
  return found;
}

/**
 * Nothing inside a transaction may reach the database through the UNMANAGED client.
 *
 * `this.prisma.x.update(...)` inside a `tx` closure is a write in its own transaction: it commits
 * whether or not the surrounding one does, it is not rolled back with a victim, and a retry issues
 * it once per attempt. It is also invisible — the code reads exactly like the transactional
 * statement beside it. Nothing in the tree does this today; this is what keeps it that way.
 */
test('a transaction writes through its own client and no other', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (EXCLUDED_SOURCES.some((excluded) => rel === excluded.path || rel.startsWith(excluded.path))) continue;
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (const { from, to } of closures(source)) {
      for (let cursor = from + 1; cursor < to; cursor += 1) {
        const body = lines[cursor];
        if (/^\s*(\/\/|\*)/.test(body)) continue;
        if (/this\.prisma\./.test(body.replace(/\/\/.*$/, ''))) {
          offenders.push(`${rel}:${cursor + 1}: ${body.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a statement inside a transaction went through the unmanaged client — it commits on its own, ' +
      'survives the rollback of the transaction around it, and runs once per retry attempt. Use tx.',
  );
});

/**
 * No external action inside a retried closure.
 *
 * This is the one property a retry can break that nothing else in the system would notice: an
 * email, a push, a realtime publish or an HTTP call inside the closure happens once per ATTEMPT,
 * so a deadlock the loop absorbs silently becomes two notifications. Every one of them in this
 * codebase sits after the commit, and this is what keeps it that way.
 */
test('nothing outside the database happens inside a transaction', () => {
  const EXTERNAL =
    /this\.realtime\.|this\.push\.|publishForUser|publishSessionUpdated|publishTaskChanged|publishRunEvent|sendMail|mailer|\bfetch\(|nodemailer|\.emit\(/;
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (EXCLUDED_SOURCES.some((excluded) => rel === excluded.path || rel.startsWith(excluded.path))) continue;
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (const { from, to } of closures(source)) {
      for (let cursor = from; cursor <= to; cursor += 1) {
        const body = lines[cursor];
        if (/^\s*(\/\/|\*)/.test(body)) continue;
        if (EXTERNAL.test(body)) offenders.push(`${rel}:${cursor + 1}: ${body.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'an external action moved inside a transaction — a retried closure would perform it once per ' +
      'attempt. Move it after the commit.',
  );
});

/** Replaying the migrations is the only honest way to know which triggers are installed. */
function liveTriggers(): Map<string, { table: string; event: string; kind: string; since: string; fn: string }> {
  const live = new Map<string, { table: string; event: string; kind: string; since: string; fn: string }>();
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    const file = path.join(MIGRATIONS, dir, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const dropped of sql.matchAll(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([a-z_0-9]+)"?\s+ON/gi)) {
      live.delete(dropped[1]);
    }
    const created =
      /CREATE\s+(CONSTRAINT\s+)?TRIGGER\s+"?([a-z_0-9]+)"?\s+((?:BEFORE|AFTER|INSTEAD\s+OF)[\s\S]*?)\s+ON\s+"?([a-z_]+)"?[\s\S]*?EXECUTE\s+(?:PROCEDURE|FUNCTION)\s+"?([a-z_0-9]+)"?/gi;
    for (const match of sql.matchAll(created)) {
      live.set(match[2], {
        table: match[4],
        event: match[3].split(/\s+/).join(' '),
        kind: match[1] ? 'CONSTRAINT' : 'ROW/STATEMENT',
        since: dir,
        fn: match[5],
      });
    }
  }
  return live;
}

/** The last body each trigger function was given, so `takes` describes what runs today. */
function functionBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    let sql: string;
    try {
      sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    for (const match of sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([a-z_0-9]+)"?[\s\S]*?\$\$([\s\S]*?)\$\$/gi,
    )) {
      bodies.set(match[1], match[2]);
    }
  }
  return bodies;
}

/** What a trigger function reaches for in OTHER relations, following the functions it calls. */
function crossRelationEffects(
  fn: string,
  table: string,
  bodies: Map<string, string>,
  seen = new Set<string>(),
): Set<string> {
  const effects = new Set<string>();
  const body = bodies.get(fn);
  if (!body || seen.has(fn)) return effects;
  seen.add(fn);
  for (const match of body.matchAll(/FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/gi)) {
    const before = body.slice(Math.max(0, match.index! - 320), match.index!);
    // Case-sensitive on purpose: every statement in these migrations spells its keywords in
    // upper case, and matching `from` as well picks the next word out of an English sentence.
    const from = [...before.matchAll(/FROM\s+"?([a-z_]+)"?/g)].map((m) => m[1]);
    const target = from[from.length - 1];
    if (target && target !== table) effects.add(`${target} LOCK`);
  }
  for (const match of body.matchAll(
    /INSERT\s+INTO\s+"?([a-z_]+)|UPDATE\s+"?([a-z_]+)"?\s+SET|DELETE\s+FROM\s+"?([a-z_]+)/gi,
  )) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && target !== table) effects.add(`${target} WRITE`);
  }
  for (const match of body.matchAll(/(?:PERFORM|SELECT)\s+"?([a-z_0-9]+)"?\s*\(/gi)) {
    for (const nested of crossRelationEffects(match[1], table, bodies, seen)) effects.add(nested);
  }
  return effects;
}

test('the installed triggers are the ones the inventory describes', () => {
  const live = liveTriggers();
  const bodies = functionBodies();
  const derived = [...live]
    .map(([trigger, meta]) => ({
      table: meta.table,
      trigger,
      event: meta.event,
      kind: meta.kind,
      since: meta.since,
      takes: [...crossRelationEffects(meta.fn, meta.table, bodies)].sort(),
    }))
    .sort((left, right) =>
      left.table === right.table
        ? left.trigger < right.trigger
          ? -1
          : 1
        : left.table < right.table
          ? -1
          : 1,
    );
  assert.deepEqual(
    derived,
    TRIGGER_WRITE_SOURCES.map((entry) => ({ ...entry, takes: [...entry.takes] })),
    'a migration changed which triggers are installed, what columns one fires on, or what one ' +
      'reaches for in another relation — update TRIGGER_WRITE_SOURCES, and check whether the ' +
      'canonical lock order (docs/postgres-lock-order.md) still holds',
  );
});

test('the trigger that makes a task status write a two-lock operation is still declared that way', () => {
  // The single most load-bearing entry in the trigger list: it is why a plain `status` PATCH has
  // to pre-lock the project, and why `clearFailedForRetry` is recorded as a residual rather than
  // as safe. Named explicitly so a migration that narrows it cannot pass by updating the list.
  const fact = TRIGGER_WRITE_SOURCES.find((t) => t.trigger === 'project_acceptance_task_fact_update');
  assert.ok(fact, 'project_acceptance_task_fact_update is gone');
  assert.equal(fact.table, 'task');
  assert.ok(fact.takes.includes('project LOCK'), 'it no longer takes the project row');
  for (const column of ['status', 'completion_policy', 'project_id', 'verdict', 'verifies_task_id']) {
    assert.ok(fact.event.includes(`"${column}"`), `it no longer fires on ${column}`);
  }
});

test('every excluded source still exists and every class is still used', () => {
  for (const excluded of EXCLUDED_SOURCES) {
    const full = path.join(SRC, excluded.path);
    assert.doesNotThrow(() => readdirSync(excluded.path.endsWith('/') ? full : path.dirname(full)),
      `${excluded.path} is excluded and no longer exists`);
    assert.ok(excluded.why.length > 40, `${excluded.path} is excluded without an argument`);
  }
  const used = new Set(STATEMENT_UNITS.map((unit) => unit.class));
  for (const name of Object.keys(STATEMENT_CLASSES)) {
    assert.ok(used.has(name as never), `statement class ${name} describes nothing — remove it`);
  }
});
