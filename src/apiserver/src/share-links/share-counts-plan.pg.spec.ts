import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ShareLinksService, type SessionShareCounts } from './share-links.service';

/**
 * A shared session's counts are an index-only scan on `run_event_session_type_idx` — asserted on
 * real PostgreSQL, with the index dropped inside a rolled-back transaction as the control.
 *
 * `ShareLinksService.sessionCounts` answers a link's page view: how many messages and how many tool
 * calls a session holds, counted over the whole transcript. Until migration 0420 nothing indexed
 * `type`, so the count visited every event the session has — measured on a 5125-event session, the
 * Bitmap Heap Scan read all 5125 heap blocks to count 4,100 rows — and a link's view paid it again
 * every time. `run_event_session_type_idx` carries the type beside the session, so the same
 * statement scans the indexed types only and reads no heap page at all.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT A SPEED CLAIM
 * ================================================
 * Which storage the statement reads: with the index, no node of the plan touches `run_event`'s heap
 * and the count's rows come from the index alone (Heap Fetches 0, after this fixture's own VACUUM);
 * with the index dropped, a heap node over `run_event` returns and it reads the session's rows one
 * page at a time. The fixture is built so the two paths cannot be confused: each of the shared
 * session's 1,200 events is laid down one per page, interleaved with 40 rows of other sessions'
 * transcripts, so the control's heap blocks are proportional to the session rather than to the
 * index. Times are not asserted — a measure of this machine, not of the access path.
 *
 * The statements explain are the ones the service itself built, captured from the client's own query
 * log rather than written here, so a read that changes shape cannot leave this spec asserting a
 * statement nobody sends any more. Both paths return the same counts, which is the claim that
 * matters most: this is an access path, not a new answer.
 *
 * `bash scripts/run-pg-spec.sh src/apiserver/src/share-links/share-counts-plan.pg.spec.ts`
 *
 * Not destructive: every row belongs to an owner this run creates.
 */

const URL = process.env.COORDINATOR_PG_URL;
const INDEX = 'run_event_session_type_idx';
const RUN = randomUUID().slice(0, 8);

/** The shared session's own events: assistant 400, user 300, tool_use 200, system 300. */
const ASSISTANT = 400;
const USER = 300;
const TOOL_USE = 200;
const SYSTEM = 300;
const EVENTS = ASSISTANT + USER + TOOL_USE + SYSTEM;
/** Other sessions' events written between two of this session's, so its rows are pages apart. */
const PER_LEVEL = 10;
const FILLER_SESSIONS = 20;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Heap Fetches'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

/** The plan nodes that read a relation's heap rather than only its indexes. */
const HEAP_NODES = new Set(['Seq Scan', 'Bitmap Heap Scan', 'Index Scan', 'Tid Scan', 'Sample Scan']);

function nodes(plan: PlanNode, relation: string): PlanNode[] {
  const found: PlanNode[] = [];
  const walk = (node: PlanNode): void => {
    if (node['Relation Name'] === relation) found.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return found;
}

test('a shared session\'s counts read the index and no heap page, and answer the same counts',
  { skip: !URL, concurrency: 1, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    const db = new PrismaClient({
      adapter: new PrismaPg(URL!),
      log: [{ emit: 'event', level: 'query' }],
    });
    try {
      await verifyCoordinatorPgIdentity(identity);

      // ── the world: an owner, a runner, a workspace, one shared session, and other transcripts ──
      const ownerId = randomUUID();
      await db.user.create({
        data: { id: ownerId, email: `counts-${RUN}-${ownerId}@share-counts.invalid`, name: 'counts', passwordHash: 'x' },
      });
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      await db.runner.create({
        data: {
          id: runnerId, ownerId, name: 'counts runner', tokenHash: `share-counts-${runnerId}`,
          status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
        },
      });
      await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `counts ${RUN}`, enabled: true } });
      const session = async (title: string): Promise<string> => {
        const id = randomUUID();
        await db.session.create({
          data: {
            id, ownerId, creatorId: ownerId, workspaceId, title, prompt: title,
            status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
          },
        });
        return id;
      };
      const shared = await session('shared');
      const fillers: string[] = [];
      for (let i = 0; i < FILLER_SESSIONS; i += 1) fillers.push(await session(`filler ${i}`));

      // One row per page for the shared session, and the types the count must and must not see. The
      // level is derived from a single series so the rows are written in that order — a cross join
      // hands the executor whichever side it likes, which had already put this session's rows side by
      // side on one page and left the control too cheap to tell the two paths apart.
      await identity.query(
        `INSERT INTO "run_event" ("id", "session_id", "seq", "type", "payload")
         SELECT gen_random_uuid(),
                CASE WHEN k = 0 THEN $1::uuid
                     ELSE ($2::uuid[])[1 + ((g * $3::int + k) % array_length($2::uuid[], 1))] END,
                CASE WHEN k = 0 THEN g ELSE 1000000 + g * $3::int + k END,
                CASE WHEN k = 0 THEN
                       CASE WHEN g <= $5::int THEN 'assistant'
                            WHEN g <= $5::int + $6::int THEN 'user'
                            WHEN g <= $5::int + $6::int + $7::int THEN 'tool_use'
                            ELSE 'system' END
                     ELSE 'assistant' END,
                jsonb_build_object('text', repeat(md5(random()::text), 40))
           FROM (SELECT ((i - 1) / ($3::int + 1)) + 1 AS g, (i - 1) % ($3::int + 1) AS k
                   FROM generate_series(1, $4::int * ($3::int + 1)) AS i) AS x`,
        [shared, fillers, PER_LEVEL, EVENTS, ASSISTANT, USER, TOOL_USE],
      );
      // Statistics and visibility, because EXPLAIN answers from both and neither exists after a bulk
      // load until autovacuum gets round to it.
      await identity.query('VACUUM ANALYZE "run_event"');

      // ── the statement the service sends, from the client's own query log ──
      const sent: Array<{ text: string; values: unknown[] }> = [];
      db.$on('query', (e) => sent.push({ text: e.query, values: JSON.parse(e.params) }));
      const service = new ShareLinksService(db as unknown as PrismaService);
      const counts: SessionShareCounts = await (service as unknown as {
        sessionCounts(sessionId: string): Promise<SessionShareCounts>;
      }).sessionCounts(shared);
      const statement = sent.find((entry) => entry.text.includes('GROUP BY') && entry.text.includes('run_event'));
      assert.ok(statement, `the counts read was captured (${sent.map((s) => s.text.slice(0, 40)).join(' | ')})`);

      const run = async (dropIndex: boolean) => {
        await identity.query('BEGIN');
        try {
          if (dropIndex) await identity.query(`DROP INDEX "${INDEX}"`);
          const explained = await identity.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement!.text}`, statement!.values,
          );
          const rows = await identity.query(statement!.text, statement!.values);
          const plan = explained.rows[0]['QUERY PLAN'][0].Plan as PlanNode;
          const onRelation = nodes(plan, 'run_event');
          return {
            heap: onRelation.filter((node) => HEAP_NODES.has(node['Node Type'])),
            heapBlocks: onRelation
              .filter((node) => HEAP_NODES.has(node['Node Type']))
              .reduce((n, node) => n + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0), 0),
            indexed: onRelation.filter((node) => node['Index Name'] === INDEX),
            byType: new Map(rows.rows.map((row: { type: string; '_count$_all': string | number }) =>
              [row.type, Number(row['_count$_all'])])),
          };
        } finally {
          await identity.query('ROLLBACK');
        }
      };

      const withIndex = await run(false);
      const withoutIndex = await run(true);

      // The control first: without the index the statement reads the session's rows from the heap,
      // one page at a time. A fixture where this fails could not tell the two paths apart.
      assert.ok(withoutIndex.heap.length > 0, `dropping ${INDEX} left the read on the heap`);
      assert.ok(withoutIndex.heapBlocks >= EVENTS / 2,
        `the control read ${withoutIndex.heapBlocks} heap blocks for a ${EVENTS}-event session`);

      assert.equal(withIndex.heap.length, 0, 'the count reads no heap page');
      assert.equal(withIndex.indexed.length, 1, `${INDEX} does not serve the read`);
      assert.equal(withIndex.indexed[0]['Node Type'], 'Index Only Scan', 'the count stays in the index');
      assert.equal(withIndex.indexed[0]['Heap Fetches'], 0, 'nothing was fetched from the heap');
      assert.equal((withIndex.indexed[0]['Actual Rows'] ?? 0) * (withIndex.indexed[0]['Actual Loops'] ?? 1),
        ASSISTANT + USER + TOOL_USE, 'only the indexed types are scanned');

      // The same answer from both paths.
      assert.equal(counts.messages, ASSISTANT + USER);
      assert.equal(counts.toolCalls, TOOL_USE);
      assert.equal(withIndex.byType.get('assistant'), ASSISTANT);
      assert.equal(withIndex.byType.get('user'), USER);
      assert.equal(withIndex.byType.get('tool_use'), TOOL_USE);
      assert.deepEqual(withoutIndex.byType, withIndex.byType);
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
