import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * "A" is real: an ordinary actor writes `status: DONE` over HTTP and it goes through.
 *
 * The account owner was offered two shapes for this on 2026-09-03 — a narrower guard, or no guard
 * at all — and chose no guard. Migration 0229 removed the database gate and the same change
 * removed `ProjectsService.refuseDirectDone`, which is what made the write a 409
 * `PROJECT_DONE_AUTOMATIC_ONLY` for every principal including the account owner.
 *
 * This is asserted over real HTTP rather than as a unit call, because that refusal lived in three
 * places a unit call can miss: the DTO's `@IsIn`, the validation pipe, and the service. A request
 * that reaches the service is the only proof that none of the three still refuses it — and a
 * routing probe that 404s or a validation pipe that 400s would both look like "nothing threw" to a
 * test that only asserted the absence of a ConflictException.
 *
 * The negative control is `PROJECT_DONE_AUTOMATIC_ONLY` itself: `project-acceptance-judgment-
 * removal.spec.ts` asserts that the code appears nowhere outside the immutable migration history,
 * so a refusal cannot come back under the old name without both files failing.
 */

const PROJECT_ID = randomUUID();
const OWNER_ID = randomUUID();

/** What the SERVICE was asked to write, recorded so the assertion is about the row and not only
 *  about the status code the door returned. */
const written: Array<Record<string, unknown>> = [];

/**
 * The REAL `ProjectsService`, over a Prisma double.
 *
 * A service double would defeat the point: `refuseDirectDone` lived in the service, so a probe
 * that stubbed the service would pass whether or not the refusal had been removed. This runs the
 * whole write path — DTO validation, the authoring-shape check, the row lock, the update — and
 * only the database underneath it is fake.
 */
function realProjectsService(): ProjectsService {
  const project = {
    id: PROJECT_ID,
    status: 'DONE',
    title: 'unguarded',
    acceptanceCriterionDefinitions: [],
    members: [],
    // A number rather than the column's BigInt: this probe serializes the response to JSON,
    // and a BigInt in it would be a 500 about `JSON.stringify` rather than about the gate.
    runtime: { coordinatorGeneration: 0 },
  };
  const tx = {
    $queryRaw: async () => [{
      coordinator_enabled: false,
      config_revision: 0,
      status: 'OPEN',
      coordinator_session_id: null,
    }],
    project: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return project;
      },
    },
    session: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    project: {
      findFirst: async () => ({
        id: PROJECT_ID, coordinatorEnabled: false, coordinatorSessionId: null,
      }),
    },
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
  };
  return new ProjectsService(prisma as never, {} as never);
}

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by this probe`);
};

@Module({
  controllers: [ProjectsController],
  providers: [
    { provide: ProjectsService, useFactory: realProjectsService },
    { provide: ProjectAcceptanceService, useValue: { recordMergeEvidence: refuse('acceptance') } },
    { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
    { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
    { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    { provide: PrismaService, useValue: {} },
  ],
})
class DoneModule {}

test('PATCH /projects/:id with status DONE is accepted, with no gate and no refusal', async (t) => {
  const app = await NestFactory.create(DoneModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const response = await fetch(`${base}/api/projects/${PROJECT_ID}`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer an-ordinary-actor',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ status: 'DONE' }),
  });
  const text = await response.text();

  assert.equal(response.status, 200, `PATCH answered ${response.status}: ${text}`);
  assert.doesNotMatch(text, /PROJECT_DONE_AUTOMATIC_ONLY/);
  assert.match(text, /"status":"DONE"/);
  // And it was not merely accepted at the door: DONE reached the UPDATE as the value to write.
  assert.equal(written.length, 1);
  assert.equal(written[0].status, 'DONE');
});
