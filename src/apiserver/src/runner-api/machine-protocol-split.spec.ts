import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { MACHINE_PROTOCOL } from '../common/machine-protocol';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAgentsController } from './runner-agents.controller';
import { RunnerDeleteController } from './runner-delete.controller';
import { RunnerEngineInstallController } from './runner-engine-install.controller';
import { RunnerLinkEventsController } from './runner-link-events.controller';
import { RunnerLinkModeController } from './runner-link-required.controller';
import { RunnerLinkWelcomeController } from './runner-link-welcome.controller';
import { RunnerNotifyController } from './runner-notify.controller';
import { RunnerProjectsController } from './runner-projects.controller';
import { RunnerProvidersController } from './runner-providers.controller';
import { RunnerRunnersController } from './runner-runners.controller';
import { RunnerSessionsController } from './runner-sessions.controller';
import { RunnerServiceTokensController } from './runner-service-tokens.controller';
import { RunnerTaskProgressController } from './runner-task-progress.controller';
import { RunnerTasksController } from './runner-tasks.controller';
import { RunnerWatchesController } from './runner-watches.controller';

/**
 * Which half of `/api/runner/*` a controller belongs to, pinned.
 *
 * The prefix is shared and the credential is shared; the only thing that differs is whether a
 * runner KEYS anything by the ids in the response. `RunnerApiController` does — scratch dirs,
 * `refs/orbit-base/<id>`, lease fences compared byte-for-byte — so it keeps UUIDs. The others are
 * read by a model (via `orbit mcp`) or a person (via the `orbit` CLI), which hand the body
 * through verbatim, so they are spelled base62 like the rest of the API — in the body they RETURN
 * and, since `PublicIdExceptionFilter`, in the body they THROW: 25E clause 1 is asserted against
 * `PATCH /runner/projects/:id`'s 409 as much as against its 200.
 *
 * Asserted as a closed list because both mistakes are silent. Marking an agent-facing controller
 * puts raw UUIDs back in front of the model with nothing failing. Failing to mark a new machine
 * route re-keys a live runner's on-disk state, and that one does not surface as an error either —
 * just diffs computed against the wrong commit.
 */
test('only the machine protocol keeps UUIDs', () => {
  assert.equal(
    Reflect.getMetadata(MACHINE_PROTOCOL, RunnerApiController),
    true,
    'claim/reclaim/leases/events/finalize/worktree ops key a runner’s disk',
  );
  assert.equal(
    Reflect.getMetadata(MACHINE_PROTOCOL, RunnerLinkWelcomeController),
    true,
    'the link gateway calls it, and the link serves the machine protocol alone',
  );
  assert.equal(
    Reflect.getMetadata(MACHINE_PROTOCOL, RunnerLinkEventsController),
    true,
    'the link gateway sends it the batches it would forward to the events route, whose session ids are UUIDs',
  );
  assert.equal(
    Reflect.getMetadata(MACHINE_PROTOCOL, RunnerLinkModeController),
    undefined,
    'the link gateway reads the cut-over switch over HTTPS with its own secret, not as a runner\'s call, and it names no id',
  );

  for (const controller of [
    RunnerTasksController,
    RunnerSessionsController,
    RunnerAgentsController,
    RunnerRunnersController,
    RunnerEngineInstallController,
    RunnerDeleteController,
    RunnerProjectsController,
    RunnerServiceTokensController,
    RunnerWatchesController,
    RunnerTaskProgressController,
    RunnerProvidersController,
    RunnerNotifyController,
  ]) {
    assert.equal(
      Reflect.getMetadata(MACHINE_PROTOCOL, controller),
      undefined,
      `${controller.name} is read by a model or a person — its ids are addresses`,
    );
  }
});

/** A controller's routes as Nest mounts them: `METHOD /prefix/path`. */
function routesOf(controller: { prototype: object }): string[] {
  const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const routes: string[] = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as object | undefined;
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) continue;
    const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
    routes.push(`${RequestMethod[method]} /${[prefix, sub].filter(Boolean).join('/')}`);
  }
  return routes;
}

test('the daemon\'s own calls are the machine protocol\'s, and the agents\' doors beside them stay agent-facing', () => {
  // The runner daemon sends these itself, never `orbit mcp` or the CLI, so they are served where the runner link serves
  // the daemon's calls (docs/runner-link-design.md §15.9): RunnerAuthGuard refuses a link call to any other controller.
  const daemon = routesOf(RunnerApiController);
  for (const route of [
    'POST /runner/cursor-key-check-result',
    'POST /runner/sessions/:id/cursor-key-check',
    'POST /runner/sessions/:id/notify',
  ]) {
    assert.ok(daemon.includes(route), `${route} is not RunnerApiController's`);
  }
  assert.deepEqual(routesOf(RunnerProvidersController).sort(), [
    'DELETE /runner/providers/:slug',
    'GET /runner/providers',
    'PATCH /runner/providers/:slug',
    'POST /runner/providers',
  ]);
  assert.deepEqual(routesOf(RunnerNotifyController), ['POST /runner/notify'], '`orbit notify` and the notify MCP tool');
});

/** The same two controllers through the interceptor itself, so the marker is checked against the
 *  behaviour it is supposed to produce rather than only against its own presence. */
function through(controller: object, body: Record<string, unknown>) {
  const context = { getClass: () => controller } as never;
  return lastValueFrom(
    new PublicIdInterceptor().intercept(context, { handle: () => of(body) } as never),
  ) as Promise<Record<string, unknown>>;
}

test('a task reaches the model spelled base62, a claim reaches the runner spelled uuid', async () => {
  const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';

  const task = await through(RunnerTasksController, { id: UUID, listId: UUID });
  assert.equal(task.id, uuidToBase62(UUID), 'this string is what `orbit mcp` prints to the model');
  assert.equal(task.listId, uuidToBase62(UUID));

  const claim = await through(RunnerApiController, { id: UUID, leaseOwner: UUID });
  assert.equal(claim.id, UUID, 'the runner names its scratch dir and base ref with this');
  assert.equal(claim.leaseOwner, UUID);
});
