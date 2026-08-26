import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { BLOCKER_SIGNAL_EXIT_INVENTORY, BlockerSignalFamily } from './blocker-signal-exit-inventory';

// Resolved against the package root. Tests run from `build/common`, while both inventories scan
// the TypeScript and migrations a reviewer edits rather than their compiled copies.
const SRC = path.resolve(__dirname, '../../src');
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

interface Declaration {
  family: BlockerSignalFamily;
  type: string;
  at: string;
}

interface ConstraintEvent {
  index: number;
  kinds: string[] | null;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (
      entry.name.endsWith('.ts')
      && !entry.name.endsWith('.spec.ts')
      && !entry.name.endsWith('.d.ts')
    ) {
      found.push(full);
    }
  }
  return found;
}

function signalFamily(name: string): BlockerSignalFamily | null {
  if (name.endsWith('_BLOCKER_KIND')) return 'PROJECT_BLOCKER';
  if (/_(?:SIGNAL_CODE|SIGNAL_KIND|SIGNAL_TYPE)$/.test(name)) return 'DURABLE_SIGNAL';
  return null;
}

/** Blank comments without changing line numbers; declarations mentioned only in prose are not code. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

/**
 * Discover named durable-open declarations over the whole source, not one line at a time.
 *
 * `[^=;]` deliberately includes newlines: `const`, its name, a type annotation, `=`, and the
 * literal may each be on separate lines. This is the exact shape the db-write inventory's
 * line-by-line matcher misses. The anchored initializer check keeps a computed value from being
 * silently treated as a type the contract understood.
 */
function declaredTypesInSource(source: string, fileName: string): Declaration[] {
  const code = withoutComments(source);
  const found: Declaration[] = [];
  const declaration = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*(?:_BLOCKER_KIND|_(?:SIGNAL_CODE|SIGNAL_KIND|SIGNAL_TYPE)))\s*(?::[^=;]+)?=/g;
  for (const match of code.matchAll(declaration)) {
    const name = match[1];
    const family = signalFamily(name)!;
    const initializer = /^\s*\(*\s*(['"`])([A-Z][A-Z0-9_]*)\1/.exec(code.slice(match.index + match[0].length));
    const value = initializer?.[2] ?? null;
    const line = code.slice(0, match.index).split('\n').length;
    assert.ok(
      value,
      `${fileName}:${line}: ${name} declares a blocker/signal type but is not initialized `
        + 'with a static string literal; the exit contract cannot inventory it',
    );
    found.push({
      family,
      type: value,
      at: `${fileName}:${line}`,
    });
  }
  // Do not make the naming convention an escape hatch. An inline discriminant is a declaration
  // too, even when its author skipped the exported constant the ordinary path uses.
  const inlineType = /\b(blockerKind|signal(?:Code|Kind|Type))\s*:\s*(['"`])([A-Z][A-Z0-9_]*)\2/g;
  for (const match of code.matchAll(inlineType)) {
    found.push({
      family: match[1] === 'blockerKind' ? 'PROJECT_BLOCKER' : 'DURABLE_SIGNAL',
      type: match[3],
      at: `${fileName}:${code.slice(0, match.index).split('\n').length}`,
    });
  }
  return found;
}

function sqlStrings(list: string): string[] {
  return [...list.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1].replace(/''/g, "'"));
}

/** Every change to the live blocker-kind CHECK in one migration, in statement order. */
function blockerConstraintEvents(sql: string): ConstraintEvent[] {
  const events: ConstraintEvent[] = [];
  for (const match of sql.matchAll(
    /DROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+"?project_blocker_kind_chk"?/gi,
  )) {
    events.push({ index: match.index, kinds: null });
  }
  for (const match of sql.matchAll(
    /ADD\s+CONSTRAINT\s+"?project_blocker_kind_chk"?\s+CHECK\s*\(\s*"?kind"?\s+IN\s*\(([\s\S]*?)\)\s*\)/gi,
  )) {
    events.push({ index: match.index, kinds: sqlStrings(match[1]) });
  }
  return events.sort((left, right) => left.index - right.index);
}

/** Replay migrations because an older CHECK remains on disk after a later one replaces it. */
function liveProjectBlockerKinds(migrations = MIGRATIONS): string[] {
  let live: string[] | null = null;
  for (const dir of readdirSync(migrations).sort()) {
    let sql: string;
    try {
      sql = readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    for (const event of blockerConstraintEvents(sql)) live = event.kinds;
  }
  assert.ok(live, 'project_blocker_kind_chk is not installed after replaying migrations');
  return live;
}

function declarationKey(declaration: Pick<Declaration, 'family' | 'type'>): string {
  return `${declaration.family}:${declaration.type}`;
}

function declaredTypes(): Declaration[] {
  const declarations: Declaration[] = liveProjectBlockerKinds().map((type) => ({
    family: 'PROJECT_BLOCKER',
    type,
    at: 'prisma/migrations#project_blocker_kind_chk',
  }));
  for (const file of sourceFiles(SRC).sort()) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    declarations.push(...declaredTypesInSource(readFileSync(file, 'utf8'), rel));
  }
  // A named blocker constant normally repeats the database declaration. Collapse the same type,
  // but retain different families: a signal and its backing blocker are two episodes and need two
  // exit registrations even if a future implementation chooses the same spelling for both.
  return [...new Map(declarations.map((entry) => [declarationKey(entry), entry])).values()];
}

test('every blocker and durable signal declaration has a registered exit condition', () => {
  const declared = new Map(declaredTypes().map((entry) => [declarationKey(entry), entry]));
  const registered = new Map(BLOCKER_SIGNAL_EXIT_INVENTORY.map((entry) => [
    declarationKey(entry),
    entry,
  ]));

  const unregistered = [...declared]
    .filter(([key]) => !registered.has(key))
    .map(([key, entry]) => `${key} (${entry.at})`)
    .sort();
  assert.deepEqual(
    unregistered,
    [],
    'a blocker/signal type was declared without its exit edge — add it to '
      + 'BLOCKER_SIGNAL_EXIT_INVENTORY with the concrete condition that ends the open episode',
  );

  const stale = [...registered]
    .filter(([key]) => !declared.has(key))
    .map(([key]) => key)
    .sort();
  assert.deepEqual(
    stale,
    [],
    'an exit registration no longer names a declared blocker/signal type — remove or rename it',
  );
});

test('exit registrations are unique and state a concrete condition', () => {
  const keys = BLOCKER_SIGNAL_EXIT_INVENTORY.map(declarationKey);
  assert.equal(new Set(keys).size, keys.length, 'duplicate blocker/signal exit registration');
  for (const entry of BLOCKER_SIGNAL_EXIT_INVENTORY) {
    assert.equal(entry.type, entry.type.trim(), `${declarationKey(entry)} has whitespace in its type`);
    assert.match(entry.type, /^[A-Z][A-Z0-9_]*$/, `${declarationKey(entry)} is not a stable type code`);
    assert.ok(
      entry.resolveWhen.trim().length >= 60,
      `${declarationKey(entry)} must state a concrete, reviewable resolve condition`,
    );
    assert.doesNotMatch(
      entry.resolveWhen,
      /\b(?:TODO|TBD|FIXME)\b/i,
      `${declarationKey(entry)} still has a placeholder resolve condition`,
    );
  }
});

test('the declaration scanner sees a type whose declaration spans lines', () => {
  const declarations = declaredTypesInSource(`
    export const MULTILINE_SIGNAL_CODE
      : string
      =
      ('MULTILINE_SIGNAL' as const);
  `, 'multiline-fixture.ts');
  assert.deepEqual(declarations.map(({ family, type }) => ({ family, type })), [{
    family: 'DURABLE_SIGNAL',
    type: 'MULTILINE_SIGNAL',
  }]);
});

test('inline blocker and signal discriminants cannot bypass the registration convention', () => {
  const declarations = declaredTypesInSource(`
    const outcome = {
      signalCode:
        'INLINE_SIGNAL_WITHOUT_A_NAMED_CONSTANT',
      blockerKind:
        'INLINE_BLOCKER_WITHOUT_A_NAMED_CONSTANT',
    };
  `, 'inline-fixture.ts');
  assert.deepEqual(declarations.map(({ family, type }) => ({ family, type })), [
    {
      family: 'DURABLE_SIGNAL',
      type: 'INLINE_SIGNAL_WITHOUT_A_NAMED_CONSTANT',
    },
    {
      family: 'PROJECT_BLOCKER',
      type: 'INLINE_BLOCKER_WITHOUT_A_NAMED_CONSTANT',
    },
  ]);
});

test('the migration scanner sees a blocker CHECK whose declaration spans lines', () => {
  const events = blockerConstraintEvents(`
    ALTER TABLE "project_blocker"
      ADD CONSTRAINT "project_blocker_kind_chk"
      CHECK (
        "kind"
        IN (
          'ONE_KIND',
          'TWO_KIND'
        )
      );
  `);
  assert.deepEqual(events.map((event) => event.kinds), [['ONE_KIND', 'TWO_KIND']]);
});
