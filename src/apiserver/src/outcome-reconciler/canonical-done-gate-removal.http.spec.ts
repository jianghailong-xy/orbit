import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectsService } from '../projects/projects.service';
import { OutcomeSurfaceService } from './outcome-surface.service';
import { OutcomeSurfacesController } from './outcome-surfaces.controller';

/**
 * (d)(e) The doors that read the canonical DONE gate, over real HTTP, after it was removed.
 *
 * The account owner's condition on this removal was that no entry point may answer with a 500. The
 * disposition chosen for both is REMOVED rather than a stub: there is no projection behind them, and
 * a route that answers an obligation question with an empty list is worse than a route that is not
 * there. What that has to mean in practice is exactly this — the removed paths 404 and the ones
 * beside them still route — and a 404 versus a 401 is also how this distinguishes "the handler is
 * gone" from "the handler is there and refused me", which no source scan can tell apart.
 *
 * Both real guards run, over their real credentials; only what they READ is a double, so a route
 * that answered 404 because it was unauthenticated could not be mistaken for one that answered 404
 * because its handler is gone. Every service is a double too, because nothing here is supposed to
 * reach a handler body: a route that did would say so by failing on the double rather than by
 * quietly passing.
 */

const PROJECT_ID = randomUUID();
const ownerScope = { id: randomUUID(), ownerId: randomUUID() };

const surfaces = {
  parseFailureSurface: (value: string) => value.toUpperCase(),
  readFailureProjectSurface: async () => ({ schemaVersion: 1, surface: 'AGENT_QUEUE', items: [] }),
  humanInbox: async () => ({ schemaVersion: 2, surface: 'HUMAN_DECISION_INBOX', items: [] }),
};

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by a routing probe`);
};

@Module({
  controllers: [OutcomeSurfacesController, RunnerProjectsController],
  providers: [
    { provide: OutcomeSurfaceService, useValue: surfaces },
    { provide: ProjectsService, useValue: { get: refuse('ProjectsService.get') } },
    { provide: ProjectAcceptanceService, useValue: { overview: refuse('acceptance.overview') } },
    { provide: ProjectHandoffService, useValue: { list: refuse('handoffs.list') } },
    JwtAuthGuard,
    RunnerAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerScope.ownerId }) } },
    { provide: PrismaService, useValue: { runner: { findFirst: async () => ownerScope } } },
  ],
})
class RoutingModule {}

test('(d)(e) the removed obligation surfaces are gone, and the doors beside them still answer',
  async (t) => {
    const app = await NestFactory.create(RoutingModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    t.after(() => app.close());

    const get = async (route: string) => {
      const response = await fetch(`${base}/api/${route}`, {
        headers: { authorization: 'Bearer routing-probe' },
      });
      const text = await response.text();
      return { status: response.status, text };
    };

    // (d) The canonical obligation surface read: `GET /outcomes/projects/:id/:surface`. This was the
    // route `project_obligations` and the Web inbox reached, and the one that read the canonical
    // DONE gate through `outcome_projection.read_surface`.
    for (const surface of ['DONE_GATE', 'AGENT_QUEUE', 'PROJECT_ATTENTION', 'WEB',
      'OWNER_DECISION_INBOX']) {
      const answer = await get(`outcomes/projects/${PROJECT_ID}/${surface}`);
      assert.equal(answer.status, 404,
        `GET /outcomes/projects/:id/${surface} answered ${answer.status}: ${answer.text}`);
    }

    // (e) The runner/MCP door the `project_obligations` capability used.
    const runnerOutcome = await get(`runner/projects/${PROJECT_ID}/outcome?surface=AGENT_QUEUE`);
    assert.equal(runnerOutcome.status, 404,
      `GET /runner/projects/:id/outcome answered ${runnerOutcome.status}: ${runnerOutcome.text}`);

    // Nothing above is a 500, and nothing below became one either: the Failure Continuation
    // surfaces and the human inbox never came from the obligation projection and still answer.
    const kept = [
      `outcomes/inbox?limit=10`,
      `outcomes/projects/${PROJECT_ID}/failure-coordination/AGENT_QUEUE`,
      `runner/projects/${PROJECT_ID}/failure-coordination?surface=AGENT_QUEUE`,
    ];
    for (const route of kept) {
      const answer = await get(route);
      assert.equal(answer.status, 200, `GET /${route} answered ${answer.status}: ${answer.text}`);
    }
  });
