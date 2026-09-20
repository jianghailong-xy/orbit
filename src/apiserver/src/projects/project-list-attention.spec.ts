import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectStatus } from '@prisma/client';
import {
  emptyProjectListAttention,
  readProjectListAttention,
} from './project-list-attention';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

/** A fake `$queryRaw` that answers the two grouped reads by the table each one names. */
function fakePrisma(
  blockers: unknown[],
  items: unknown[],
): { prisma: never; queries: Array<{ text: string; values: unknown[] }> } {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  return {
    queries,
    prisma: {
      $queryRaw: async (sql: { text: string; values: unknown[] }) => {
        queries.push(sql);
        return /project_blocker/.test(sql.text) ? blockers : items;
      },
    } as never,
  };
}

test('the blocker aggregate returns one typed summary per project', async () => {
  const attentionSinceAt = new Date('2026-08-01T00:00:00.000Z');
  const nextCheckAt = new Date('2026-08-01T01:00:00.000Z');
  const { prisma, queries } = fakePrisma(
    [{
      projectId: 'project-a',
      userBlockers: 2,
      coordinatorBlockers: 1,
      systemBlockers: 3,
      maxSeverity: 'CRITICAL',
      attentionSinceAt,
      nextCheckAt,
    }],
    [],
  );

  const rows = await readProjectListAttention(prisma, OWNER_ID, ProjectStatus.OPEN);

  assert.equal(queries.length, 2);
  const [blockers, items] = queries;
  assert.deepEqual(blockers?.values, [OWNER_ID, ProjectStatus.OPEN]);
  assert.match(blockers?.text ?? '', /proj\.owner_id = \$1::uuid/);
  assert.match(blockers?.text ?? '', /proj\."status" = \$2::project_status/);
  assert.match(blockers?.text ?? '', /blocker\.resolved_at IS NULL/);
  // A blocker can exist before it escalates to USER. Human waiting starts at the handoff, while
  // an escalated blocker no longer contributes its stale scheduler check.
  assert.match(blockers?.text ?? '', /coalesce\(blocker\.escalated_at, blocker\.first_seen_at\)/);
  assert.match(blockers?.text ?? '', /FILTER \(WHERE blocker\.escalated_at IS NULL\)/);
  assert.deepEqual(rows.get('project-a'), {
    userBlockers: 2,
    coordinatorBlockers: 1,
    systemBlockers: 3,
    maxSeverity: 'CRITICAL',
    attentionSinceAt,
    nextCheckAt,
    ownerItems: [],
    coordinatorItems: null,
  });
});

test('the item aggregate is grouped in the database, scoped by the same project join', async () => {
  const { prisma, queries } = fakePrisma([], []);

  await readProjectListAttention(prisma, OWNER_ID, ProjectStatus.OPEN);

  const items = queries[1];
  assert.deepEqual(items?.values, [OWNER_ID, ProjectStatus.OPEN]);
  assert.match(items?.text ?? '', /FROM project_open_item item/);
  assert.match(items?.text ?? '', /proj\.owner_id = \$1::uuid/);
  assert.match(items?.text ?? '', /proj\."status" = \$2::project_status/);
  assert.match(items?.text ?? '', /item\.state = 'OPEN'/);
  // Counted and aged, not listed: the list row names one action.
  assert.match(items?.text ?? '', /min\(item\.waiting_since\) AS "oldestWaitingSince"/);
  assert.match(
    items?.text ?? '',
    /GROUP BY item\.project_id, item\.kind, item\.assignee, item\.assignee_reason/,
  );
});

test('the four owner item kinds come from the kind, the escalations from the reason', async () => {
  const asked = new Date('2026-08-01T00:00:00.000Z');
  const { prisma } = fakePrisma([], [
    // A merge approval and a question are the owner's from birth, whatever their reason says.
    { projectId: 'project-a', kind: 'PROMOTION_APPROVAL', assignee: 'OWNER', assigneeReason: 'DEFAULT', count: 1, oldestWaitingSince: asked, nextEscalationAt: null },
    { projectId: 'project-a', kind: 'COORDINATOR_QUESTION', assignee: 'OWNER', assigneeReason: 'DEFAULT', count: 2, oldestWaitingSince: new Date('2026-08-02T00:00:00.000Z'), nextEscalationAt: null },
    // An exception that reached the owner carries which door it came through, and every one of
    // those doors is the same fact to whoever is being told "this is yours now".
    { projectId: 'project-b', kind: 'TASK_FAILED', assignee: 'OWNER', assigneeReason: 'CHAIN_LIMIT', count: 3, oldestWaitingSince: asked, nextEscalationAt: null },
    { projectId: 'project-c', kind: 'INTEGRATION_CONFLICT', assignee: 'OWNER', assigneeReason: 'HANDED_OVER', count: 1, oldestWaitingSince: asked, nextEscalationAt: null },
    { projectId: 'project-d', kind: 'FUSE_PAUSED', assignee: 'OWNER', assigneeReason: 'DEFAULT', count: 1, oldestWaitingSince: asked, nextEscalationAt: null },
  ]);

  const rows = await readProjectListAttention(prisma, OWNER_ID);

  assert.deepEqual(rows.get('project-a')?.ownerItems, [
    { kind: 'PROMOTION_APPROVAL', count: 1, oldestWaitingSince: asked },
    { kind: 'COORDINATOR_QUESTION', count: 2, oldestWaitingSince: new Date('2026-08-02T00:00:00.000Z') },
  ]);
  assert.deepEqual(rows.get('project-b')?.ownerItems, [
    { kind: 'ESCALATED', count: 3, oldestWaitingSince: asked },
  ]);
  assert.deepEqual(rows.get('project-c')?.ownerItems, [
    { kind: 'ESCALATED', count: 1, oldestWaitingSince: asked },
  ]);
  assert.deepEqual(rows.get('project-d')?.ownerItems, [
    { kind: 'FUSE_PAUSED', count: 1, oldestWaitingSince: asked },
  ]);
  // A project the blockers never mentioned is still in the map, with the empty blocker shape: the
  // row draws its chip from the item, and a missing entry would read as a project with neither.
  assert.deepEqual(rows.get('project-c')?.userBlockers, 0);
});

test('an item the coordinator holds is one summary, led by the kind that has waited longest', async () => {
  const { prisma } = fakePrisma([], [
    { projectId: 'project-a', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', count: 2, oldestWaitingSince: new Date('2026-08-02T00:00:00.000Z'), nextEscalationAt: new Date('2026-08-03T00:00:00.000Z') },
    { projectId: 'project-a', kind: 'TASK_FAILED', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', count: 1, oldestWaitingSince: new Date('2026-08-01T00:00:00.000Z'), nextEscalationAt: new Date('2026-08-04T00:00:00.000Z') },
  ]);

  const held = (await readProjectListAttention(prisma, OWNER_ID)).get('project-a')?.coordinatorItems;

  assert.deepEqual(held, {
    count: 3,
    // The lead is the one that has waited longest, which is what the row's chip names.
    leadKind: 'TASK_FAILED',
    oldestWaitingSince: new Date('2026-08-01T00:00:00.000Z'),
    // The first of them to stop being the coordinator's.
    nextEscalationAt: new Date('2026-08-03T00:00:00.000Z'),
  });
  // Owner decision 10: an exception the coordinator is still working on is not the owner's to be
  // told about, so it is not one of the four either.
  const row = (await readProjectListAttention(prisma, OWNER_ID)).get('project-a');
  assert.deepEqual(row?.ownerItems, []);
});

test('a coordinator-kind item is the coordinator’s, not one of the four, even with no reason', async () => {
  // The negative control for the two classifiers: `ownerItemKind` answers about the OWNER, and a
  // row it declines is read as the coordinator's only when the coordinator is actually its
  // assignee. An item with the owner and no escalation story behind it is neither.
  const { prisma } = fakePrisma([], [
    { projectId: 'project-a', kind: 'TASK_FAILED', assignee: 'OWNER', assigneeReason: 'DEFAULT', count: 1, oldestWaitingSince: new Date(), nextEscalationAt: null },
  ]);

  const row = (await readProjectListAttention(prisma, OWNER_ID)).get('project-a');

  assert.deepEqual(row?.ownerItems, []);
  assert.equal(row?.coordinatorItems, null);
});

test('a project with no open blockers and no items has one explicit empty shape', () => {
  assert.deepEqual(emptyProjectListAttention(), {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
    ownerItems: [],
    coordinatorItems: null,
  });
});
