import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * `GET /projects/sidebar` reaches the rail's read, and never the `:id` route beside it.
 *
 * Both routes are GETs on the same segment, so which one answers `/projects/sidebar` is decided by
 * DECLARATION ORDER alone — and the two failure modes of getting that wrong look like nothing at
 * all from the service: the id route's `PublicIdPipe` rejects `sidebar` with a 400, and the rail
 * draws no projects. A unit call into `ProjectsService.listSidebar` cannot tell the two apart,
 * which is the whole reason this is asserted over real HTTP with the real controller.
 *
 * The payload is asserted too, because it is the contract the web reads: `buckets.running` alone,
 * `taskCounts`, no `goal`. A route that answered with the whole index row would pass a test that
 * only asked for a 200.
 */

const OWNER_ID = randomUUID();
const PROJECT_ID = randomUUID();

/** What the RAIL read was asked for, so the assertion is about the route and not only the status
 *  code. The `:id` read records itself the same way: reaching it is the failure under test. */
const reached: string[] = [];

/** A row shaped exactly as `ProjectsService.listSidebar` returns one. */
const railRow = {
  id: PROJECT_ID,
  title: 'the rail',
  status: 'OPEN',
  createdAt: '2026-08-01T00:00:00.000Z',
  startedAt: '2026-08-02T00:00:00.000Z',
  buckets: { running: 2 },
  taskCounts: { done: 4, failed: 1, total: 9 },
  lastActivityAt: '2026-10-02T00:00:00.000Z',
  attention: { userBlockers: 1, ownerItems: [], coordinatorItems: null, startRequest: null },
  coordinatorActivity: null,
};

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by this probe`);
};

@Module({
  controllers: [ProjectsController],
  providers: [
    {
      provide: ProjectsService,
      useValue: {
        listSidebar: async (ownerId: string) => {
          reached.push(`sidebar:${ownerId}`);
          return [railRow];
        },
        get: refuse('the :id read'),
      },
    },
    { provide: ProjectAcceptanceService, useValue: { recordMergeEvidence: refuse('acceptance') } },
    { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
    { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
    { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
    { provide: ProjectOpenItemService, useValue: { list: refuse('open items') } },
    { provide: ProjectFuseService, useValue: { resume: refuse('the fuse') } },
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    { provide: PrismaService, useValue: {} },
  ],
})
class SidebarModule {}

test('GET /projects/sidebar is the rail read, not a project id', async (t) => {
  const app = await NestFactory.create(SidebarModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const response = await fetch(`${base}/api/projects/sidebar`, {
    headers: { authorization: 'Bearer the-owner' },
  });
  const text = await response.text();

  assert.equal(response.status, 200, `GET /projects/sidebar answered ${response.status}: ${text}`);
  assert.deepEqual(reached, [`sidebar:${OWNER_ID}`],
    'the rail read answered, scoped to the authenticated owner — not the :id route');
  const [row] = JSON.parse(text) as Array<typeof railRow>;
  assert.deepEqual(row.buckets, { running: 2 },
    'one lane, under the name the index reports it by');
  assert.deepEqual(row.taskCounts, { done: 4, failed: 1, total: 9 });
  assert.equal(row.title, 'the rail');
  assert.ok(!('goal' in row) && !('_count' in row),
    'the page-wide fields the rail does not draw are not sent to a poll that runs every 15s');
});
