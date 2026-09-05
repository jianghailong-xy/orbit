import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Every place production code can set `project.status`, frozen before the coordinator-wake work.
 *
 * The claim this file keeps honest is a negative one: that work adds no new way for a project's
 * status to be written, so DONE stays what one explicit `project_update` makes it. A negative
 * claim needs a list taken BEFORE the work. Taken after, every reading is compared against
 * whatever the tree had become by then, and a write added along the way is simply part of the
 * baseline.
 *
 * The scan is syntactic, over the same text a reviewer reads, and it looks for both shapes that
 * reach the column: a Prisma write on the `project` model whose input carries a `status`, and a
 * raw statement that names the column itself. A census written only around the Prisma call shape
 * reads `UPDATE "project" SET "status" = ...` as a string nobody sends anywhere, reports nothing,
 * and is then green for the rest of its life.
 *
 * `writeSites` takes source TEXT rather than a directory, so the cases below can hand it files
 * that do not exist. A census that can only be run against the real tree cannot be shown to notice
 * anything: the one tree it has is the tree whose answer is already written down here.
 *
 * Bounded on purpose to `src/apiserver/src`. A trigger under `prisma/migrations` could write the
 * column too; this file makes no claim about one.
 */

// Resolved against the package root, not `__dirname`: this runs from `build/projects`, and the
// subject is the TypeScript a reviewer reads, not the JavaScript it compiles to.
const SRC = path.resolve(__dirname, '../../src');

/**
 * Every place production code under `src/apiserver/src` can set `project.status`, as the tree
 * stood at f3f403bf -- before the first line of coordinator-wake work.
 *
 * One entry, and it is the endpoint an owner calls: `ProjectsService.update` copies `dto.status`
 * into the Prisma input when the request carried one. No background job writes the column, and no
 * raw statement does either. A second entry here means this project grew a status writer, which is
 * the one thing it said it would not do; the entry has to be explained before it is added.
 */
const FROZEN_WRITE_SITES: readonly string[] = ['projects/projects.service.ts#update'];

/** The Prisma model writes whose input can carry a `status`. Reads are absent on purpose. */
const PRISMA_PROJECT_WRITE =
  /\.project\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/;
/** `status` in key position -- a Prisma input field, never the word as it appears in prose. */
const STATUS_KEY = /\bstatus\s*:/;
/**
 * A raw statement that assigns the column. Both lazy spans stop at the tokens that end an
 * assignment list, so `UPDATE "project" SET "goal" = ... WHERE ... "status" = ...` -- a write of a
 * different column that merely READS this one -- is not counted as a write of it.
 */
const SQL_UPDATE_STATUS =
  /\bUPDATE\s+(?:"project"|project\b)(?:(?!\bUPDATE\b|`|;)[\s\S])*?\bSET\b(?:(?!\bWHERE\b|\bRETURNING\b|`|;)[\s\S])*?(?:"status"|\bstatus\b)\s*=/gi;
/** An insert that supplies the column rather than leaving it to the column default. */
const SQL_INSERT_STATUS =
  /\bINSERT\s+INTO\s+(?:"project"|project\b)\s*\([^)]*?(?:"status"|\bstatus\b)/gi;

const METHOD =
  /^ {2}(?:private |protected |public |static |readonly |abstract )*(?:async )?(?:\*)?([A-Za-z0-9_$]+)\s*[(<]/;
const FUNCTION =
  /^export (?:async )?function ([A-Za-z0-9_$]+)|^(?:async )?function ([A-Za-z0-9_$]+)|^export const ([A-Za-z0-9_$]+)\s*[=:]/;
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'do', 'else', 'try',
]);

interface ScannedSource {
  /** Spelled the way the census spells it: relative to `src/apiserver/src`, forward slashes. */
  readonly path: string;
  readonly content: string;
}

/**
 * Blank out comments without moving a single line.
 *
 * These files describe their own statements in prose -- "no background task writes it" -- and a
 * census that counted a sentence would report a write site nobody can delete.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

/**
 * The declaration each line belongs to, which is what a site is anchored to instead of a line
 * number: a line number turns every edit above a write into a failure, and a failure that means
 * "somebody added a paragraph" is one people learn to re-baseline without reading.
 */
function unitsByLine(code: string): string[] {
  let unit = '(module)';
  return code.split('\n').map((line) => {
    const asMethod = METHOD.exec(line);
    if (asMethod && !NOT_A_METHOD.has(asMethod[1])) {
      unit = asMethod[1];
    } else {
      const asFunction = FUNCTION.exec(line);
      if (asFunction) unit = asFunction[1] ?? asFunction[2] ?? asFunction[3];
    }
    return unit;
  });
}

/**
 * Every `path#declaration` in these sources that can set `project.status`, sorted and deduplicated.
 *
 * The Prisma pair is matched per DECLARATION rather than per call, because the input is routinely
 * built somewhere else in the same method -- `ProjectsService.update` assembles its
 * `Prisma.ProjectUpdateInput` about seventy lines above the `tx.project.update` that sends it, and
 * a scan of the call's own arguments sees a variable name. Pairing per declaration also counts a
 * method that writes the project and merely mentions `status` in a row type. That direction is the
 * safe one: an entry too many costs a line here and a sentence explaining it, an entry too few
 * costs the whole point of the file.
 */
function writeSites(sources: readonly ScannedSource[]): string[] {
  const sites = new Set<string>();
  for (const source of sources) {
    const code = withoutComments(source.content);
    const units = unitsByLine(code);

    const writes = new Set<string>();
    const inputs = new Set<string>();
    code.split('\n').forEach((line, index) => {
      if (PRISMA_PROJECT_WRITE.test(line)) writes.add(units[index]);
      if (STATUS_KEY.test(line)) inputs.add(units[index]);
    });
    for (const unit of writes) if (inputs.has(unit)) sites.add(`${source.path}#${unit}`);

    for (const pattern of [SQL_UPDATE_STATUS, SQL_INSERT_STATUS]) {
      for (const match of code.matchAll(pattern)) {
        sites.add(`${source.path}#${units[code.slice(0, match.index).split('\n').length - 1]}`);
      }
    }
  }
  return [...sites].sort();
}

/**
 * Walked off the filesystem rather than asked of `git ls-files`, because an uncommitted file is
 * exactly the state a new write site is in while it is being added: a census that enumerates the
 * index is green for the author and red for whoever commits next.
 */
function productionSources(dir: string = SRC, found: ScannedSource[] = []): ScannedSource[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      productionSources(full, found);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
    found.push({
      path: path.relative(SRC, full).split(path.sep).join('/'),
      content: readFileSync(full, 'utf8'),
    });
  }
  return found;
}

const source = (relative: string, lines: readonly string[]): ScannedSource =>
  ({ path: relative, content: lines.join('\n') });

// (a) ---------------------------------------------------------------------------------------------
test('(a) production code writes project.status in exactly the frozen places', () => {
  const sources = productionSources();
  assert.ok(sources.length > 0, 'the census scanned no source files at all');
  const found = writeSites(sources);
  // An empty result agrees with an empty expectation, and would keep agreeing after a write was
  // added and the scan silently stopped matching anything. The list is asserted non-empty first so
  // that the comparison below can never be a comparison of nothing with nothing.
  assert.ok(found.length > 0, 'the census found no project.status write site at all');
  assert.ok(FROZEN_WRITE_SITES.length > 0, 'the frozen baseline is empty');
  assert.deepEqual(found, [...FROZEN_WRITE_SITES]);
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) a raw statement that assigns the column is counted, not just the Prisma shape', () => {
  const raw = source('projects/project-settle.repository.ts', [
    'export async function settleProject(query: Query, id: string): Promise<void> {',
    '  await query(`UPDATE "project"',
    "       SET \"status\" = 'DONE'::\"ProjectStatus\", \"updated_at\" = CURRENT_TIMESTAMP",
    '     WHERE "id" = $1::uuid`, [id]);',
    '}',
  ]);
  assert.deepEqual(writeSites([raw]), ['projects/project-settle.repository.ts#settleProject']);

  // The control the shape above needs: the tree really does contain a raw update of the project
  // row that reads `status` in its predicate. Counting that one would make the census unfalsifiable
  // in the other direction -- every statement about a project would be a status write.
  const other = source('projects/project-goal.repository.ts', [
    'export async function seedGoal(query: Query, id: string, goal: string): Promise<void> {',
    '  await query(`UPDATE "project"',
    '       SET "goal" = $2, "updated_at" = CURRENT_TIMESTAMP',
    "     WHERE \"id\" = $1::uuid AND \"status\" = 'OPEN'`, [id, goal]);",
    '}',
  ]);
  assert.deepEqual(writeSites([other]), []);

  // And prose is not code. Both shapes, written the way this repository writes about them.
  const prose = source('projects/project-wake.notes.ts', [
    'export function why(): string {',
    '  // A wake records a fact; it never runs `UPDATE "project" SET "status" = ...`,',
    '  // and never reaches tx.project.update({ data: { status } }) either.',
    '  return \'nothing is written here\';',
    '}',
  ]);
  assert.deepEqual(writeSites([prose]), []);
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) a new write site appears as one more entry than the frozen baseline', () => {
  // The shape the coordinator-wake work would take if it ever reached for this column: a service
  // of its own, writing the project row from the path that decides what happens next.
  const added = source('projects/project-wake.service.ts', [
    'export class ProjectWakeService {',
    '  async settle(tx: Prisma.TransactionClient, id: string): Promise<void> {',
    "    await tx.project.update({ where: { id }, data: { status: 'DONE' } });",
    '  }',
    '}',
  ]);
  assert.deepEqual(
    writeSites([...productionSources(), added]),
    [...FROZEN_WRITE_SITES, 'projects/project-wake.service.ts#settle'].sort(),
  );
});
