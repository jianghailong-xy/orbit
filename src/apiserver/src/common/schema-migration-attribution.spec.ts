import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps `schema.prisma` from pointing a reader at the wrong migration.
 *
 * Two features landed one migration apart and are described a few hundred lines apart in the same
 * file: 0131 added the @mention/context ledger, 0132 added the dependency revision. A bulk edit
 * once moved eight of the ledger's citations onto 0132, which changes no SQL and so passes every
 * runtime test, while telling anyone reading the rolling-deploy and backfill contract to look in a
 * migration that does not contain the column, table, CHECK or trigger under discussion.
 *
 * Nothing here hard-codes a migration number. The creating migration is looked up from the
 * migration that actually contains the object, so renumbering the tree moves this check with it.
 */
const PRISMA = path.resolve(__dirname, '../../prisma');
const SCHEMA = path.join(PRISMA, 'schema.prisma');
const MIGRATIONS = path.join(PRISMA, 'migrations');

/** The database objects the @mention/context ledger is made of. */
const LEDGER = ['context_task_id', 'mention_delivery_version', 'task_comment_mention_delivery'];
/** The dependency revision, whose own citations must NOT follow the ledger. */
const DEPENDENCY_REVISION = ['task_dependency_revision'];

/** A citation of a migration by number: `migration 0131`, `0131's trigger`, `(see 0131)`. */
const CITATION = /\b(0\d{3})\b/g;

/** The migration directory that brings `object` into existence. Exactly one may. */
function creatorOf(object: string): string {
  const introduces = new RegExp(`(?:CREATE TABLE|ADD COLUMN)\\s+"${object}"`, 'i');
  const found = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => introduces.test(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')));
  assert.equal(found.length, 1, `expected exactly one migration to create "${object}", got ${found.join(', ') || 'none'}`);
  return found[0].slice(0, 4);
}

interface Declaration {
  /** `Model` for the model's own header, `Model.field` for a field. */
  key: string;
  model: string;
  /** The model a relation field points at, with `[]`/`?` stripped. Empty for scalars. */
  type: string;
  /** The column this field maps to, if it declares one. */
  column: string;
  /** The `@relation("NAME")` this field belongs to, if any. */
  relation: string;
  /** The `fields: [...]` a relation field owns, if any. */
  owns: string[];
}

const MODEL = /^model\s+(\w+)\s*\{/;
const FIELD = /^\s{2}(\w+)\s+(\w+)(\[\]|\?)?/;
const MAP = /@map\("([^"]+)"\)/;
const TABLE = /@@map\("([^"]+)"\)/;
const RELATION = /@relation\("([^"]+)"/;
const OWNS = /fields:\s*\[([^\]]*)\]/;

const lines = readFileSync(SCHEMA, 'utf8').split('\n');

/** Every model and field in the schema, with the database identity each carries. */
function parse(): { declarations: Map<number, Declaration>; tables: Map<string, string> } {
  const declarations = new Map<number, Declaration>();
  const tables = new Map<string, string>();
  let model = '';
  lines.forEach((line, index) => {
    const opens = MODEL.exec(line);
    if (opens) {
      model = opens[1];
      tables.set(model, model.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
      declarations.set(index, { key: model, model, type: '', column: '', relation: '', owns: [] });
      return;
    }
    if (line.startsWith('}')) { model = ''; return; }
    if (!model) return;
    const mapped = TABLE.exec(line);
    if (mapped) { tables.set(model, mapped[1]); return; }
    const field = FIELD.exec(line);
    if (!field) return;
    declarations.set(index, {
      key: `${model}.${field[1]}`,
      model,
      type: field[2],
      column: MAP.exec(line)?.[1] ?? '',
      relation: RELATION.exec(line)?.[1] ?? '',
      owns: (OWNS.exec(line)?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    });
  });
  return { declarations, tables };
}

/**
 * Every declaration that belongs to `objects`, reached the four ways the schema can name one: the
 * field that maps the column, every field of the model that maps the table, a relation field whose
 * TYPE is that model, and a relation field on the far side of a relation the column owns.
 */
function declarationsFor(
  objects: string[],
  { declarations, tables }: ReturnType<typeof parse>,
): Set<string> {
  const models = new Set(
    [...tables].filter(([, table]) => objects.includes(table)).map(([name]) => name),
  );
  const columns = new Set(
    [...declarations.values()].filter((d) => objects.includes(d.column)).map((d) => d.key),
  );
  const relations = new Set(
    [...declarations.values()]
      .filter((d) => d.relation && d.owns.some((name) => columns.has(`${d.model}.${name}`)))
      .map((d) => d.relation),
  );
  const belongs = new Set<string>();
  for (const d of declarations.values()) {
    if (models.has(d.model) || columns.has(d.key) || models.has(d.type) || relations.has(d.relation)) {
      belongs.add(d.key);
    }
  }
  return belongs;
}

/** Every `///` block, the declarations it documents, and the migrations it cites. */
function blocks(declarations: Map<number, Declaration>): Array<{
  line: number; documents: string[]; cites: string[];
}> {
  const found: Array<{ line: number; documents: string[]; cites: string[] }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\/\/\//.test(lines[index])) continue;
    const start = index;
    let text = '';
    while (index < lines.length && /^\s*\/\/\//.test(lines[index])) { text += `${lines[index]}\n`; index += 1; }
    // The block documents every declaration that follows it before the next comment or blank line.
    // Two are common: a doc that describes a column can sit above a relation field added later.
    const documents: string[] = [];
    for (let at = index; at < lines.length; at += 1) {
      if (!lines[at].trim() || /^\s*\/\//.test(lines[at])) break;
      const declaration = declarations.get(at);
      if (!declaration) break;
      documents.push(declaration.key);
    }
    CITATION.lastIndex = 0;
    const cites = [...new Set([...text.matchAll(CITATION)].map((hit) => hit[1]))];
    if (documents.length && cites.length) found.push({ line: start + 1, documents, cites });
  }
  return found;
}

test('the ledger and the dependency revision were created by the migrations they are cited as', () => {
  for (const object of LEDGER) assert.equal(creatorOf(object), creatorOf(LEDGER[0]), `${object} is not created alongside the rest of the ledger`);
  assert.notEqual(creatorOf(LEDGER[0]), creatorOf(DEPENDENCY_REVISION[0]), 'the two features must be separate migrations for this file to have a subject');
  const ledgerSql = readFileSync(
    path.join(MIGRATIONS, readdirSync(MIGRATIONS).filter((n) => n.startsWith(creatorOf(DEPENDENCY_REVISION[0])))[0], 'migration.sql'),
    'utf8',
  );
  for (const object of LEDGER) {
    assert.ok(!ledgerSql.includes(object), `the dependency-revision migration must not contain ${object}`);
  }
});

test('every schema comment about the ledger cites the migration that created it', () => {
  const parsed = parse();
  const subjects = [
    { objects: LEDGER, what: 'the @mention/context ledger' },
    { objects: DEPENDENCY_REVISION, what: 'the dependency revision' },
  ].map((subject) => ({
    ...subject,
    owns: declarationsFor(subject.objects, parsed),
    migration: creatorOf(subject.objects[0]),
  }));

  const wrong: string[] = [];
  let checked = 0;
  for (const block of blocks(parsed.declarations)) {
    for (const subject of subjects) {
      if (!block.documents.some((key) => subject.owns.has(key))) continue;
      checked += 1;
      // Citing the predecessor a migration replaced is fair — the creating migration must be there
      // too, so the comment says where the object a reader is looking at actually comes from.
      if (!block.cites.includes(subject.migration)) {
        wrong.push(
          `schema.prisma:${block.line} documents ${block.documents.join(', ')} — part of ${subject.what}, ` +
          `created by migration ${subject.migration} — but cites only ${block.cites.join(', ')}`,
        );
      }
    }
  }
  assert.deepEqual(wrong, [], `a schema comment points at a migration that does not contain what it describes:\n${wrong.join('\n')}`);
  // The count is pinned so that a refactor that stops matching any declaration fails loudly rather
  // than passing by checking nothing.
  assert.equal(checked, 10, 'expected 10 documented citations across the ledger and the dependency revision');
});
