import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectStatus } from '@prisma/client';
import {
  emptyProjectListAttention,
  readProjectListAttention,
} from './project-list-attention';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

test('the blocker aggregate returns one typed summary per project', async () => {
  let calls = 0;
  let query: { text: string; values: unknown[] } | undefined;
  const attentionSinceAt = new Date('2026-08-01T00:00:00.000Z');
  const nextCheckAt = new Date('2026-08-01T01:00:00.000Z');
  const prisma = {
    $queryRaw: async (sql: { text: string; values: unknown[] }) => {
      calls += 1;
      query = sql;
      return [{
        projectId: 'project-a',
        userBlockers: 2,
        coordinatorBlockers: 1,
        systemBlockers: 3,
        maxSeverity: 'CRITICAL',
        attentionSinceAt,
        nextCheckAt,
      }];
    },
  };

  const rows = await readProjectListAttention(
    prisma as never,
    OWNER_ID,
    ProjectStatus.OPEN,
  );

  assert.equal(calls, 1);
  assert.deepEqual(query?.values, [OWNER_ID, ProjectStatus.OPEN]);
  assert.match(query?.text ?? '', /proj\.owner_id = \$1::uuid/);
  assert.match(query?.text ?? '', /proj\."status" = \$2::project_status/);
  assert.match(query?.text ?? '', /blocker\.resolved_at IS NULL/);
  // A blocker can exist before it escalates to USER. Human waiting starts at the handoff, while
  // an escalated blocker no longer contributes its stale scheduler check.
  assert.match(query?.text ?? '', /coalesce\(blocker\.escalated_at, blocker\.first_seen_at\)/);
  assert.match(query?.text ?? '', /FILTER \(WHERE blocker\.escalated_at IS NULL\)/);
  assert.deepEqual(rows.get('project-a'), {
    userBlockers: 2,
    coordinatorBlockers: 1,
    systemBlockers: 3,
    maxSeverity: 'CRITICAL',
    attentionSinceAt,
    nextCheckAt,
  });
});

test('a project with no open blockers has one explicit empty shape', () => {
  assert.deepEqual(emptyProjectListAttention(), {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
  });
});
