/**
 * The maintenance trigger's "does this hint name a fact" read (`considerWikiMaintenance`, over `factsSql`) finds
 * the settled tasks after the space's cursor through `task_owner_updated_idx` (migration 1270). It no longer reads
 * every task the owner has. Asserted on real PostgreSQL, against a fixture sized and shaped like production.
 *
 * Production, 2026-11-19 (pg_stat_statements queryid -4419705567743594015): 40,069 calls of this statement at
 * about 26.7k buffers each. That window's 171 sequential scans of `task` were mostly this statement. The
 * settled-task arm asks `t.owner_id = $ AND t.status::text IN (…) AND t.updated_at >= $since`. One owner holds
 * nearly all of production's 115k tasks, and the cast keeps the status indexes out of reach. Nothing else
 * indexed `updated_at` without a project, so every call read the whole of `task`.
 *
 * WHAT IS ASSERTED
 * ================
 * The statement is the one the trigger issues, taken from the client's own query log. It is explained twice
 * inside a rolled-back transaction: as it stands, and with `task_owner_updated_idx` dropped as the control.
 * For each hint, the read with the index:
 *   - answers what the control answers;
 *   - has no Seq Scan on `task` or `session_merge_receipt`;
 *   - reads at most a tenth of the control's buffers of `task`, and fewer buffers in all.
 * The statement's two reads of `session` stay: the session arm's, and the task arm's DISTINCT ON over the
 * workspaces' sessions, which no index can serve because it is not parameterised by the task. Production,
 * 2026-11-19: 41,358 buffers a call, 32,887 of them on `task` and 4,234 + 4,231 on `session`.
 * The control itself must scan `task` sequentially, or the fixture could not tell the two apart. On a tree
 * without the migration, the index is missing in both runs, so the read scans `task` and the spec is red.
 * Times are not asserted.
 *
 * The fixture follows production's counts from 2026-11-19: 115k tasks under one owner, most of them an OPEN
 * backlog; 12k sessions; 6k merge receipts. Row widths are near production's: `task` 256 MB over 115k rows,
 * `session` 33 MB over 11.7k. The space's cursor sits behind the newest 200 settled tasks.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-maintain-trigger-plan.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates, and is deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { considerWikiMaintenance } from './wiki-maintenance-run';

const URL_ = process.env.COORDINATOR_PG_URL;
const INDEX = 'task_owner_updated_idx';

/** The owner's OPEN backlog: old, and never a fact. */
const OPEN_TASKS = 109_000;
/** Settled tasks the space's workspace was assigned, the newest of them after the cursor. */
const SETTLED_TASKS = 6_000;
const AFTER_CURSOR = 200;
/** Settled sessions in the workspace, each running one settled task (all but the newest 50) and holding one merge receipt. */
const SESSIONS = 5_950;
/** Sessions of no task, so the session table reaches production's 12k. */
const LOOSE_SESSIONS = 6_050;
const APPROVALS = 3_000;
/**
 * The size each row is padded to, so a page holds about as many rows as production's do: production's `task` is
 * 32.8k pages over 115k rows, and `session` 4.2k pages over 11.7k. Rows are padded to just under PostgreSQL's
 * 2 kB TOAST threshold, which is as wide as a row can be and still stay inline: past it, the padding is
 * compressed or moved out of line and the heap stays small, which is what the first versions of this fixture
 * did. Each table's unpadded row is measured first, and the padding makes up the difference.
 */
const ROW_BYTES = 1_950;

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

/** Buffers each relation's scan nodes read, by relation: where a plan's buffers went. */
function byRelation(plan: PlanNode): Map<string, number> {
  const sums = new Map<string, number>();
  const walk = (node: PlanNode): void => {
    // A scan node's count is its own pages and its index's, nothing of another relation.
    if (node['Relation Name']) {
      sums.set(node['Relation Name'], (sums.get(node['Relation Name']) ?? 0)
        + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0));
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return sums;
}

const spell = (sums: Map<string, number>) => [...sums].map(([relation, n]) => `${relation} ${n}`).join(', ');

/** About `n` bytes of base64 text (24 characters a part), different for every `seed`. */
const pad = (seed: string, n: number) =>
  `(SELECT string_agg(encode(decode(md5(${seed} || ':' || g), 'hex'), 'base64'), '')
      FROM generate_series(1, ${Math.max(0, Math.floor(n / 24))}) AS g)`;

/** What one row of `insert` (a statement with `$pad` where the padding goes) weighs unpadded, rolled back. */
async function unpadded(sql: Client, insert: string, values: unknown[]): Promise<number> {
  await sql.query('BEGIN');
  try {
    const { rows } = await sql.query(
      `WITH made AS (${insert.replace('$pad', "''")} RETURNING *) SELECT max(pg_column_size(made.*))::int AS n FROM made`,
      values,
    );
    return (rows[0] as { n: number }).n;
  } finally {
    await sql.query('ROLLBACK');
  }
}

test('the trigger reads the settled tasks after the cursor by index, answering what the whole-table read answered',
  { skip: !URL_, concurrency: 1, timeout: 900_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL_!);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    const db = new PrismaClient({ adapter: new PrismaPg(URL_!), log: [{ emit: 'event', level: 'query' }] });
    const ownerId = randomUUID();
    try {
      await verifyCoordinatorPgIdentity(sql);
      await db.user.create({
        data: { id: ownerId, email: `trigger-plan-${ownerId}@wiki.invalid`, name: 'trigger plan', passwordHash: 'x' },
      });
      const runnerId = randomUUID();
      await db.runner.create({
        data: { id: runnerId, name: `plan-${runnerId.slice(0, 8)}`, ownerId, tokenHash: `hash-${runnerId}`, lastHeartbeatAt: new Date() },
      });
      const workspaceId = randomUUID();
      await db.workspace.create({ data: { id: workspaceId, ownerId, name: 'plan checkout', runnerId, workDir: '/tmp/plan-spec' } });
      const spaceId = randomUUID();
      await db.wikiSpace.create({
        data: {
          id: spaceId, ownerId, slug: `plan-${spaceId.slice(0, 8)}`, title: 'app',
          repoUrlNorm: `github.com/example/plan-${spaceId.slice(0, 8)}`, rootCommitSha: 'b'.repeat(40),
          settings: { reviewMode: 'manual', maintenance: { enabled: true, workspaceId } } as never,
        },
      });
      await db.wikiSpaceWorkspace.create({ data: { spaceId, ownerId, workspaceId } });

      // ── the world: one owner's long history ──
      const openTasks = `INSERT INTO "task"("id", "title", "description", "owner_id", "creator_type", "creator_id", "status",
                            "completion_criterion", "created_at", "updated_at")
         SELECT gen_random_uuid(), 'open ' || i, $pad, $1::uuid, 'USER', $1::uuid, 'OPEN',
                'EVIDENCE_JUDGMENT', timestamp '2026-06-01' + make_interval(secs => i),
                timestamp '2026-06-01' + make_interval(secs => i)
           FROM generate_series(1, $2::int) AS i`;
      const taskPad = ROW_BYTES - await unpadded(sql, openTasks, [ownerId, 1]);
      await sql.query(openTasks.replace('$pad', pad("'o' || i", taskPad)), [ownerId, OPEN_TASKS]);
      await sql.query(
        `INSERT INTO "task"("id", "title", "description", "owner_id", "creator_type", "creator_id", "assignee_id",
                            "status", "completion_criterion", "created_at", "updated_at")
         SELECT gen_random_uuid(), 'done ' || i, ${pad("'d' || i", taskPad)}, $1::uuid, 'USER', $1::uuid, $2::uuid,
                'DONE', 'EVIDENCE_JUDGMENT', timestamp '2026-09-01' + make_interval(mins => i),
                timestamp '2026-09-01' + make_interval(mins => i)
           FROM generate_series(1, $3::int) AS i`,
        [ownerId, workspaceId, SETTLED_TASKS],
      );
      const taskSessions = `INSERT INTO "session"("id", "title", "prompt", "owner_id", "creator_id", "workspace_id", "dispatch_origin",
                               "turn_state", "task_id", "last_turn_at", "created_at", "updated_at", "finished_at")
         SELECT gen_random_uuid(), t."title", $pad, $1::uuid, $1::uuid, $2::uuid, 'USER',
                NULL, t."id", t."updated_at", t."updated_at", t."updated_at", t."updated_at"
           FROM "task" t
          WHERE t."owner_id" = $1::uuid AND t."status" = 'DONE'
          ORDER BY t."updated_at" LIMIT $3::int`;
      const sessionPad = ROW_BYTES - await unpadded(sql, taskSessions, [ownerId, workspaceId, 1]);
      await sql.query(taskSessions.replace('$pad', pad('t."title"', sessionPad)), [ownerId, workspaceId, SESSIONS]);
      await sql.query(
        `INSERT INTO "session"("id", "title", "prompt", "owner_id", "creator_id", "workspace_id", "dispatch_origin",
                               "turn_state", "last_turn_at", "created_at", "updated_at", "finished_at")
         SELECT gen_random_uuid(), 'loose ' || i, ${pad("'l' || i", sessionPad)}, $1::uuid, $1::uuid, $2::uuid, 'USER',
                NULL, timestamp '2026-08-01' + make_interval(mins => i),
                timestamp '2026-08-01' + make_interval(mins => i), timestamp '2026-08-01' + make_interval(mins => i),
                timestamp '2026-08-01' + make_interval(mins => i)
           FROM generate_series(1, $3::int) AS i`,
        [ownerId, workspaceId, LOOSE_SESSIONS],
      );
      await sql.query(
        `INSERT INTO "session_merge_receipt"("id", "owner_id", "session_id", "task_id", "result", "source_branch",
                                             "source_sha", "target_branch", "recorded_by", "idempotency_key", "created_at")
         SELECT gen_random_uuid(), $1::uuid, s."id", s."task_id", 'ERROR', 'orbit/plan', md5(s."id"::text) || 'abcdef01',
                'main', 'RUNNER', 'plan-' || s."id", s."last_turn_at"
           FROM "session" s WHERE s."owner_id" = $1::uuid AND s."task_id" IS NOT NULL`,
        [ownerId],
      );
      await sql.query(
        `INSERT INTO "approval"("id", "session_id", "tool_use_id", "tool_name", "input", "status", "decided_at")
         SELECT gen_random_uuid(), s."id", 'tu-' || s."id", 'ExitPlanMode', '{}'::jsonb, 'ALLOWED', s."last_turn_at"
           FROM "session" s WHERE s."owner_id" = $1::uuid
          ORDER BY s."created_at" LIMIT $2::int`,
        [ownerId, APPROVALS],
      );
      // The space's cursor: behind the newest settled tasks, as a space whose last run took in the rest.
      const [mark] = (await sql.query(
        `SELECT "id"::text AS "id", "updated_at" AS "at" FROM "task"
          WHERE "owner_id" = $1::uuid AND "status" = 'DONE' ORDER BY "updated_at" DESC OFFSET $2::int LIMIT 1`,
        [ownerId, AFTER_CURSOR],
      )).rows as Array<{ id: string; at: Date }>;
      await db.wikiCursor.create({
        data: {
          spaceId, ownerId, source: 'facts', positionAt: mark.at, positionKind: 'task_terminal', positionRef: mark.id,
          issuedAt: mark.at, issuedKind: 'task_terminal', issuedRef: mark.id,
        },
      });
      // The hint subjects: a session whose turn is still running (no fact: the ordinary hint), a settled session
      // after the cursor, and a settled task after the cursor with no session.
      const running = randomUUID();
      await db.session.create({
        data: {
          id: running, title: 'running', prompt: 'p', ownerId, creatorId: ownerId, dispatchOrigin: 'USER',
          turnState: 'IN_FLIGHT', workspaceId, assignedRunnerId: runnerId,
        },
      });
      const [settled] = (await sql.query(
        `SELECT "id"::text AS "id" FROM "session" WHERE "owner_id" = $1::uuid AND "task_id" IS NOT NULL
          ORDER BY "last_turn_at" DESC LIMIT 1`, [ownerId],
      )).rows as Array<{ id: string }>;
      const [lonely] = (await sql.query(
        `SELECT t."id"::text AS "id" FROM "task" t WHERE t."owner_id" = $1::uuid AND t."status" = 'DONE'
            AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."task_id" = t."id")
          ORDER BY t."updated_at" DESC LIMIT 1`, [ownerId],
      )).rows as Array<{ id: string }>;
      assert.ok(settled && lonely, 'the fixture has a settled session and a settled task after the cursor');
      await sql.query('VACUUM ANALYZE "task", "session", "session_merge_receipt", "approval"');
      const pages = (await sql.query(
        `SELECT relname, relpages FROM pg_class WHERE relname IN ('task', 'session', 'session_merge_receipt')`,
      )).rows as Array<{ relname: string; relpages: number }>;
      console.log(`fixture pages: ${pages.map((row) => `${row.relname} ${row.relpages}`).join(', ')}`);

      const sent: Array<{ text: string; values: unknown[] }> = [];
      db.$on('query', (e) => sent.push({ text: e.query, values: JSON.parse(e.params) as unknown[] }));
      const prisma = db as unknown as PrismaService;

      const hints = [
        { name: 'a running session', sessionIds: [running], taskIds: [] as string[], answers: 0 },
        { name: 'a settled session', sessionIds: [settled.id], taskIds: [] as string[], answers: 1 },
        { name: 'a settled task', sessionIds: [] as string[], taskIds: [lonely.id], answers: 1 },
      ];
      for (const hint of hints) {
        // A hint that finds the space due makes a run, and the next hint would then stop at "unfinished" before
        // the read this spec is about. Each hint asks of a space with no run in flight.
        await db.wikiMaintenanceRun.deleteMany({ where: { ownerId, spaceId } });
        await db.wikiJob.deleteMany({ where: { ownerId, spaceId } });
        sent.length = 0;
        await considerWikiMaintenance(prisma, ownerId, spaceId, { sessionIds: hint.sessionIds, taskIds: hint.taskIds });
        const issued = sent.find((entry) => entry.text.includes('AS "one"') && entry.text.includes('"session_merge_receipt"'));
        assert.ok(issued, `${hint.name}: the trigger's named read was captured`);

        const explain = async (dropIndex: boolean) => {
          await sql.query('BEGIN');
          try {
            if (dropIndex) await sql.query(`DROP INDEX IF EXISTS "${INDEX}"`);
            const plan = (await sql.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${issued!.text}`, issued!.values))
              .rows[0]['QUERY PLAN'][0].Plan as PlanNode;
            const rows = (await sql.query(issued!.text, issued!.values)).rows.length;
            return { rows, buffers: (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0), seq: seqScans(plan), by: byRelation(plan) };
          } finally {
            await sql.query('ROLLBACK');
          }
        };
        const control = await explain(true);
        const indexed = await explain(false);
        console.log(`${hint.name}: without ${INDEX} ${control.buffers} buffers, seq scans [${control.seq.join(', ')}]; `
          + `with it ${indexed.buffers} buffers, seq scans [${indexed.seq.join(', ')}] `
          + `(by relation without: ${spell(control.by)}; with: ${spell(indexed.by)})`);

        assert.equal(control.rows, hint.answers, `${hint.name}: the control answers as the fixture says`);
        assert.equal(indexed.rows, control.rows, `${hint.name}: the indexed read answers what the control answers`);
        assert.ok(control.seq.includes('task'), `${hint.name}: the control scans task (the fixture cannot tell the paths apart)`);
        for (const relation of ['task', 'session_merge_receipt']) {
          assert.ok(!indexed.seq.includes(relation), `${hint.name}: the read scans ${relation} sequentially`);
        }
        // The task arm's buffers, which were the statement's cost in production (32,887 of 41,358 on 2026-11-19).
        // The statement as a whole keeps its two reads of `session` (the session arm, and the task arm's
        // DISTINCT ON over the workspaces' sessions, which no index serves); those belong to the wiki's own work.
        const taskBefore = control.by.get('task') ?? 0;
        const taskAfter = indexed.by.get('task') ?? 0;
        assert.ok(taskAfter * 10 <= taskBefore,
          `${hint.name}: the read took ${taskAfter} buffers of task against the control's ${taskBefore}`);
        // Not above: a settled session's read touches no task page in either path, and the two session reads differ
        // by a page or two depending on where the heap puts the row (1490 against 1488 before session_release_fact_chk
        // widened nothing but moved the rows, 1488 against 1488 after). The task arm's tenfold cut is asserted above.
        assert.ok(indexed.buffers <= control.buffers,
          `${hint.name}: the read took ${indexed.buffers} buffers against the control's ${control.buffers}`);
      }
    } finally {
      await db.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await sql.query('DELETE FROM "approval" a USING "session" s WHERE s."id" = a."session_id" AND s."owner_id" = $1::uuid', [ownerId]).catch(() => undefined);
      await sql.query('DELETE FROM "session_merge_receipt" WHERE "owner_id" = $1::uuid', [ownerId]).catch(() => undefined);
      await db.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.task.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
      await db.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    }
  });
