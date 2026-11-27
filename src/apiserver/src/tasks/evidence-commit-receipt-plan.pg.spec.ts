/**
 * A COMMIT citation's "is this commit recorded under another task of mine" (`resolveCommit` in
 * task-evidence-envelope.ts) finds the receipt through `session_merge_receipt_source_sha_idx` (migration 1270).
 * It no longer reads the whole table. Asserted on real PostgreSQL.
 *
 * Production, 2026-11-19 (pg_stat_statements queryid 8550742065809416404):
 *     SELECT "id" FROM "session_merge_receipt" WHERE ("owner_id" = $1 AND "source_sha" = $2) LIMIT $3 OFFSET $4
 * 398,826 calls, about 453 buffers each, 0 rows in total. Every read of an evidence card resolves its citations
 * again (`describeEvidenceCitations`, used by the pending-judgment, evidence-review and evidence-list reads).
 * Each COMMIT citation that is not this task's receipt or checkpoint asks this. Two owners share the table, so
 * `owner_id` selects nothing, and nothing indexed `source_sha`: each call scanned all 6,221 rows.
 *
 * WHAT IS ASSERTED
 * ================
 * The statement is the one `describeEvidenceCitations` issues, taken from the client's own query log. It is
 * explained twice inside a rolled-back transaction: as it stands, and with the index dropped as the control.
 * For a sha nobody recorded (production's only case) and for one recorded under another task, the read with
 * the index:
 *   - answers what the control answers;
 *   - has no Seq Scan on `session_merge_receipt`;
 *   - reads at most a tenth of the control's buffers.
 * The citation's answer is checked too. On a tree without the migration, both runs scan sequentially and the
 * spec is red.
 *
 * Fixture: 6,200 receipts of one owner, with a `detail` like production's (3.9 MB over 6,221 rows).
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/tasks/evidence-commit-receipt-plan.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates, and is deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { describeEvidenceCitations } from './task-evidence-envelope';

const URL_ = process.env.COORDINATOR_PG_URL;
const INDEX = 'session_merge_receipt_source_sha_idx';
const RECEIPTS = 6_200;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function seqScans(plan: PlanNode): string[] {
  const found: string[] = [];
  const walk = (node: PlanNode): void => {
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) found.push(node['Relation Name']);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return found;
}

test('a COMMIT citation looks for another task\'s receipt by its sha, answering what the whole-table read answered',
  { skip: !URL_, concurrency: 1, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL_!);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    const db = new PrismaClient({ adapter: new PrismaPg(URL_!), log: [{ emit: 'event', level: 'query' }] });
    const ownerId = randomUUID();
    try {
      await verifyCoordinatorPgIdentity(sql);
      await db.user.create({
        data: { id: ownerId, email: `commit-plan-${ownerId}@evidence.invalid`, name: 'commit plan', passwordHash: 'x' },
      });
      const workspaceId = randomUUID();
      await sql.query(`INSERT INTO "workspace"("id", "name", "owner_id") VALUES ($1, 'commit plan', $2)`, [workspaceId, ownerId]);
      const cited = await db.task.create({
        data: { ownerId, title: 'the cited task', creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' },
        select: { id: true },
      });
      const other = await db.task.create({
        data: { ownerId, title: 'another task', creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' },
        select: { id: true },
      });
      await sql.query(
        `INSERT INTO "session"("id", "title", "prompt", "owner_id", "creator_id", "workspace_id", "dispatch_origin",
                               "turn_state", "finished_at", "created_at", "updated_at")
         SELECT gen_random_uuid(), 'merged ' || i, 'p', $1::uuid, $1::uuid, $2::uuid, 'USER', NULL, now(),
                timestamp '2026-09-01' + make_interval(mins => i), timestamp '2026-09-01' + make_interval(mins => i)
           FROM generate_series(1, $3::int) AS i`,
        [ownerId, workspaceId, RECEIPTS],
      );
      await sql.query(
        `INSERT INTO "session_merge_receipt"("id", "owner_id", "session_id", "task_id", "result", "source_branch",
                                             "source_sha", "target_branch", "recorded_by", "idempotency_key", "detail",
                                             "created_at")
         SELECT gen_random_uuid(), $1::uuid, s."id", $2::uuid, 'ERROR', 'orbit/' || s."title",
                md5(s."id"::text) || substr(md5(s."title"), 1, 8), 'main', 'RUNNER', 'plan-' || s."id",
                jsonb_build_object('command', 'git merge --ff-only', 'output',
                                   md5(s."id"::text || 'a') || md5(s."id"::text || 'b') || md5(s."id"::text || 'c')
                                   || md5(s."id"::text || 'd') || md5(s."id"::text || 'e') || md5(s."id"::text || 'f')
                                   || md5(s."id"::text || 'g') || md5(s."id"::text || 'h') || md5(s."id"::text || 'i')
                                   || md5(s."id"::text || 'j') || md5(s."id"::text || 'k') || md5(s."id"::text || 'l')),
                s."created_at"
           FROM "session" s WHERE s."owner_id" = $1::uuid`,
        [ownerId, other.id],
      );
      const [recorded] = (await sql.query(
        `SELECT "source_sha" AS "sha" FROM "session_merge_receipt" WHERE "owner_id" = $1::uuid ORDER BY "created_at" DESC LIMIT 1`,
        [ownerId],
      )).rows as Array<{ sha: string }>;
      await sql.query('VACUUM ANALYZE "session_merge_receipt"');

      const sent: Array<{ text: string; values: unknown[] }> = [];
      db.$on('query', (e) => sent.push({ text: e.query, values: JSON.parse(e.params) as unknown[] }));

      const shas = [
        { name: 'a sha nobody recorded', ref: 'f'.repeat(40), foreign: false },
        { name: 'a sha another task recorded', ref: recorded.sha, foreign: true },
      ];
      for (const sha of shas) {
        sent.length = 0;
        const [citation] = await describeEvidenceCitations(
          db as never, { ownerId, taskId: cited.id }, [{ kind: 'COMMIT', ref: sha.ref }],
        );
        assert.equal(citation.resolved, false, `${sha.name}: it is not the cited task's commit`);
        assert.equal(
          (citation as { reason?: string }).reason?.includes('another task') ?? false, sha.foreign,
          `${sha.name}: the citation says whether another task recorded it`,
        );
        const issued = sent.find((entry) => entry.text.includes('"session_merge_receipt"')
          && entry.text.includes('"source_sha"') && !entry.text.includes('"task_id"'));
        assert.ok(issued, `${sha.name}: the foreign-receipt read was captured (${sent.map((s) => s.text.slice(0, 60)).join(' | ')})`);

        const explain = async (dropIndex: boolean) => {
          await sql.query('BEGIN');
          try {
            if (dropIndex) await sql.query(`DROP INDEX IF EXISTS "${INDEX}"`);
            const plan = (await sql.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${issued!.text}`, issued!.values))
              .rows[0]['QUERY PLAN'][0].Plan as PlanNode;
            const rows = (await sql.query(issued!.text, issued!.values)).rows.length;
            return { rows, buffers: (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0), seq: seqScans(plan) };
          } finally {
            await sql.query('ROLLBACK');
          }
        };
        const control = await explain(true);
        const indexed = await explain(false);
        console.log(`${sha.name}: without ${INDEX} ${control.buffers} buffers, seq scans [${control.seq.join(', ')}]; `
          + `with it ${indexed.buffers} buffers, seq scans [${indexed.seq.join(', ')}]`);

        assert.equal(control.rows, sha.foreign ? 1 : 0, `${sha.name}: the control answers as the fixture says`);
        assert.equal(indexed.rows, control.rows, `${sha.name}: the indexed read answers what the control answers`);
        assert.ok(control.seq.includes('session_merge_receipt'), `${sha.name}: the control scans the table (fixture too small)`);
        assert.ok(!indexed.seq.includes('session_merge_receipt'), `${sha.name}: the read scans session_merge_receipt sequentially`);
        assert.ok(indexed.buffers * 10 <= control.buffers,
          `${sha.name}: the read took ${indexed.buffers} buffers against the control's ${control.buffers}`);
      }
    } finally {
      await sql.query('DELETE FROM "session_merge_receipt" WHERE "owner_id" = $1::uuid', [ownerId]).catch(() => undefined);
      await db.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.task.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
      await db.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    }
  });
