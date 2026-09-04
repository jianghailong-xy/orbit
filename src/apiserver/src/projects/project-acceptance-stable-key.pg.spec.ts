/**
 * T5 on real PostgreSQL: a stated criterion's `key` is its own stable id, and the `content_hash`
 * beside it is no longer what any read derives that key from.
 *
 * WHAT CHANGED, AND WHY IT IS A WIRE CHANGE
 * -----------------------------------------
 * `key` used to be `contentHash.slice(0, 32)`. One string carried two intents — "the same
 * criterion after a reorder" and "a different criterion after an edit" — so every caller holding a
 * key was coupled to the exact words. `(key, revision)` states them apart: the id survives an
 * edit, the revision counts them. Callers that read a key as a content fingerprint therefore see a
 * different value; the affected list is in this task's comments.
 *
 * `content_hash` itself is untouched. It is written by exactly one place
 * (`ProjectsService.replaceAcceptanceDefinitions`, plus the BEFORE INSERT trigger
 * `project_acceptance_definition_normalize`) and it is still returned on the projection. What this
 * file proves is that nothing READS it to name a criterion — which is the whole of what the
 * project asked for, and the reason the known create/update disagreement in that column is left
 * exactly as it is rather than repaired.
 *
 * WHY THIS IS A `.pg.spec`
 * ------------------------
 * Every fact below is a fact about PostgreSQL. Criteria are written and edited through
 * `ProjectsService.update` — the owner's own path, and the only thing that increments a criterion's
 * `revision` — and read back through `ProjectsService.get`, which is the read behind
 * `GET /projects/:id` and `GET /runner/projects/:id` (`project_get`). A fixture that INSERTed rows
 * and asserted over a projection would prove that this file can format what it just wrote; it
 * would not prove that an edit through the product moves `revision` and leaves `key` alone.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-acceptance-stable-key\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { addTwins } from '../common/public-id-body';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** build/projects -> build -> apiserver -> src -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
/** Where every read path that could name a criterion lives. The outward `key` is produced by the
 *  API server and nowhere else, so this is the whole surface the scan below has to answer for. */
const READ_PATHS = path.join(REPO_ROOT, 'src/apiserver/src');
/** This file, which quotes the offending line on purpose and must not be scanned for it. */
const SELF = path.join(READ_PATHS, 'projects/project-acceptance-stable-key.pg.spec.ts');

/**
 * Two spellings of "this key came out of the content hash", both of which the pre-switch tree
 * contained: the projection's `key: contentHash.slice(0, 32)`, and a caller re-deriving the same
 * 32-character prefix for itself.
 */
const KEY_FROM_CONTENT_HASH = [
  /(^|[^\w.])key\s*:\s*[^,;\n]*\bcontent_?[Hh]ash\b/,
  /\bcontent_?[Hh]ash\b[^\n]*\.slice\(\s*0\s*,\s*32\s*\)/,
];

/** A comment line, in the spelling the rest of this repository's source scans use. The switch is
 *  a fact about CODE: a file that explains what the key used to be derived from is describing the
 *  removal, not performing it. */
function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/** Every TypeScript file under a directory. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.ts$/u.test(entry.name)) found.push(full);
  }
  return found;
}

/** One criterion as `project_get` returns it. */
interface StatedItem {
  id: string;
  key: string;
  ordinal: number;
  text: string;
  revision: number;
  contentHash: string;
}

test('T5: a criterion key is its stable id, and no read derives it from the content hash', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const projects = new ProjectsService(prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService));

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `t5-${ownerId}@acceptance-stable-key.invalid`,
      name: 'T5',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'T5 subject project' } });

  /** State the whole collection through the owner's path — the only thing that moves `revision`. */
  async function state(items: Array<{ id?: string; text: string }>): Promise<void> {
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never);
  }

  /**
   * The OUTWARD read: what `project_get` hands a caller, in ordinal order.
   *
   * Deliberately `ProjectsService.get` rather than the internal projection. Acceptance criterion 6
   * of this project is about what a reader is TOLD, and an assertion over
   * `criteriaFromDefinitions` alone would hold just as well on a tree where the outward read never
   * carried a key at all.
   */
  async function outward(): Promise<StatedItem[]> {
    const detail = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedItem[];
    };
    return [...detail.acceptanceCriteriaItems].sort((a, b) => a.ordinal - b.ordinal);
  }

  /** The ids PostgreSQL holds for this project's criteria, in ordinal order. The projection's own
   *  `id` is not evidence for what the key names — one shape could invent both consistently. */
  async function storedIds(): Promise<string[]> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT "id"::text AS id FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return rows.map((row) => row.id);
  }

  /** What PostgreSQL itself holds for one criterion — never the projection's own account of it. */
  async function stored(id: string): Promise<{ revision: number; content_hash: string }> {
    const { rows } = await sql.query<{ revision: number; content_hash: string }>(
      `SELECT "revision", "content_hash" FROM "project_acceptance_criterion_definition"
        WHERE "id" = $1::uuid`,
      [id],
    );
    assert.equal(rows.length, 1, 'the criterion under test must be there to be read');
    return rows[0];
  }

  const FIRST = 'the dispatcher starts a ready task';
  const REWORDED = 'the dispatcher starts a ready task, and says so';
  const SECOND = 'the boundary is decided server-side';

  await state([{ text: FIRST }, { text: SECOND }]);
  const before = await outward();
  assert.equal(before.length, 2, 'the fixture states two criteria');

  // The guard that keeps every assertion below from passing vacuously. `key` unchanged is a fact
  // about a value only if there IS a value: `undefined === undefined` is the shape this whole
  // file would otherwise report as a pass on a tree that never made the switch.
  for (const item of before) {
    assert.equal(typeof item.key, 'string', 'the outward read must carry a key');
    assert.ok(item.key.length > 0, 'the outward read must carry a non-empty key');
    assert.equal(typeof item.revision, 'number', 'the outward read must carry a revision');
  }
  const [firstBefore, secondBefore] = before;

  // ═══ 1. rewriting the words moves the revision and not the key ════════════════════════════
  await t.test('rewriting a criterion’s text leaves its key alone and increments its revision',
    async () => {
      await state([{ id: firstBefore.id, text: REWORDED }, { id: secondBefore.id, text: SECOND }]);
      const after = await outward();
      const [firstAfter, secondAfter] = after;

      assert.equal(firstAfter.text, REWORDED, 'the fixture must actually have rewritten the words');
      // The content hash MOVED. Without this, "the key did not change" would also be satisfied by
      // a fixture whose edit never reached the database — the negative would be about nothing.
      const storedNow = await stored(firstBefore.id);
      assert.notEqual(storedNow.content_hash, firstBefore.contentHash,
        'the edit must move the stored content hash, or this asserts nothing about the key');
      assert.equal(firstAfter.contentHash, storedNow.content_hash);

      assert.equal(firstAfter.key, firstBefore.key,
        'the key is the criterion’s id: rewriting its words must not rename it');
      assert.equal(firstAfter.revision, firstBefore.revision + 1,
        'the revision is what an edit moves, and it moves by one');
      assert.equal(firstAfter.revision, storedNow.revision,
        'the outward revision is the row’s revision, not a number the projection invented');

      // The criterion nobody edited is evidence that the edit was scoped: a write path that
      // rewrote every row would satisfy the two assertions above by accident.
      assert.equal(secondAfter.key, secondBefore.key);
      assert.equal(secondAfter.revision, secondBefore.revision);
      assert.equal(secondAfter.contentHash, secondBefore.contentHash);
    });

  // ═══ 2. the key IS the definition's stable id ═════════════════════════════════════════════
  await t.test('the key equals the definition’s own id, in the spelling the response uses',
    async () => {
      const items = await outward();
      assert.deepEqual(items.map((item) => item.key), (await storedIds()).map(uuidToBase62),
        'the keys are these rows’ ids, read out of PostgreSQL rather than out of the projection');
      for (const item of items) {
        const definitionId = toUuid(item.id);
        assert.equal(item.key, uuidToBase62(definitionId),
          'the key is this definition’s id, base62 as every other id in the same response is');
        assert.equal(toUuid(item.key), definitionId,
          'and it decodes back to exactly the row it names');
        // Not merely "different from the old rule": the old value must not be reachable from it.
        assert.notEqual(item.key, item.contentHash.slice(0, 32));
        assert.notEqual(item.key, item.contentHash);
      }
    });

  await t.test('above the machine protocol the key, the id and the public id are one string',
    async () => {
      // The last step of the outward read is `PublicIdInterceptor`, whose mapper this is: for an
      // agent-facing controller — `project_get` is one — it replaces `id` with the base62 spelling
      // and adds `publicId`. Running it here is what turns "the key is base62" into "the key is
      // the same string the caller sees under the other two names", which is the property that
      // lets a reader hand back whichever of the three they happened to copy.
      const detail = await projects.get(ownerId, projectId);
      addTwins(detail, true);
      const items = (detail as unknown as {
        acceptanceCriteriaItems: Array<StatedItem & { publicId: string }>;
      }).acceptanceCriteriaItems;
      assert.equal(items.length, 2);
      for (const item of items) {
        assert.equal(item.key, item.id, 'the key and the id are the same row, spelled the same');
        assert.equal(item.key, item.publicId);
      }
    });

  await t.test('the key a caller reads is the key the write door resolves', async () => {
    // The gate `criterionKey` is checked against (`refuseTaskOpening`) and the resolution that
    // records it (`TasksService.resolveCriterionDeclarations`) both compare against
    // `criteriaFromDefinitions(...).key`. If that string ever differed from the one handed out,
    // every key a caller copied out of `project_get` would be refused as unknown.
    const items = await outward();
    assert.deepEqual(
      criteriaFromDefinitions(items).map((criterion) => criterion.key),
      items.map((item) => item.key),
    );
  });

  // ═══ 3. the revision is returned BESIDE the key, outwardly ════════════════════════════════
  await t.test('the outward read carries the revision beside the key', async () => {
    for (const item of await outward()) {
      assert.ok(Object.prototype.hasOwnProperty.call(item, 'key'),
        'project_get must name the criterion');
      assert.ok(Object.prototype.hasOwnProperty.call(item, 'revision'),
        'and must say, in the same object, which wording that name is on');
      assert.equal(item.revision, (await stored(toUuid(item.id))).revision);
    }
  });

  // ═══ 4. what the OLD key got right, kept ══════════════════════════════════════════════════
  await t.test('reordering the criteria leaves every key alone', async () => {
    const original = await outward();
    const [one, two] = original;

    await state([{ id: two.id, text: two.text }, { id: one.id, text: one.text }]);
    const reordered = await outward();

    assert.deepEqual(reordered.map((item) => item.ordinal), [1, 2]);
    assert.deepEqual(reordered.map((item) => item.text), [two.text, one.text],
      'the fixture must actually have swapped them');
    assert.deepEqual(reordered.map((item) => item.key), [two.key, one.key],
      'a reorder is presentation: the old content key survived one, and so must this one');
    assert.deepEqual(reordered.map((item) => item.revision), [two.revision, one.revision],
      'and a reorder is not an edit, so nothing counts as a new wording');

    // Put them back, so the scan below reads a tree the earlier cases still describe.
    await state([{ id: one.id, text: one.text }, { id: two.id, text: two.text }]);
  });

  // ═══ 5. nothing derives the outward key from the content hash ═════════════════════════════
  await t.test('no read path derives the outward key from contentHash', () => {
    // A dead regex is not a true negative. Both patterns are first run against the exact lines
    // the pre-switch tree contained, so a scan that has quietly stopped matching anything fails
    // here rather than reporting a clean sweep.
    const PRE_SWITCH = [
      '        key: contentHash.slice(0, 32),',
      '      const criterionKey = stated.contentHash.slice(0, 32);',
    ];
    for (const line of PRE_SWITCH) {
      assert.ok(KEY_FROM_CONTENT_HASH.some((pattern) => pattern.test(line)),
        `the scan no longer recognises the derivation it exists to refuse: ${line}`);
    }
    assert.equal(KEY_FROM_CONTENT_HASH.some((pattern) =>
      pattern.test('        key: criterionKeyOf(definition.id),')), false,
      'the scan must not refuse the rule that replaced it');
    assert.equal(isProseLine(' * It was `contentHash.slice(0, 32)` until this unit'), true,
      'a comment explaining what the key no longer comes from is not a derivation');
    assert.equal(isProseLine('        key: contentHash.slice(0, 32),'), false,
      'and the prose filter must not swallow the derivation itself');

    const files = sourceFiles(READ_PATHS).filter((file) => file !== SELF);
    assert.ok(files.length > 100,
      `the scan walked ${files.length} files; a scan that found nothing proves nothing`);

    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (isProseLine(line)) return;
        if (KEY_FROM_CONTENT_HASH.some((pattern) => pattern.test(line))) {
          offenders.push(`${path.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, []);

    // And the two projections that DO produce the outward key name the one rule that makes it.
    // Without this the assertion above would also pass on a tree that stopped emitting a key.
    for (const producer of ['projects/project-acceptance.ts', 'projects/projects.service.ts']) {
      const source = readFileSync(path.join(READ_PATHS, producer), 'utf8');
      assert.match(source, /key: criterionKeyOf\(/,
        `${producer} no longer names the rule the key comes from`);
    }
  });

  // ═══ the column this project deliberately did not repair ══════════════════════════════════
  await t.test('content_hash is still stored and still returned; it is only no longer read',
    async () => {
      const item = (await outward())[0];
      const row = await stored(toUuid(item.id));
      assert.match(row.content_hash, /^[0-9a-f]{64}$/, 'the column is untouched, values and all');
      assert.equal(item.contentHash, row.content_hash,
        'and the projection still reports it verbatim — this unit removed a reader, not a column');
    });
});
