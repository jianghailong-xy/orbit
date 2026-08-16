import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { MACHINE_PROTOCOL } from '../common/machine-protocol';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAgentsController } from './runner-agents.controller';
import { RunnerSessionsController } from './runner-sessions.controller';
import { RunnerServiceTokensController } from './runner-service-tokens.controller';
import { RunnerTasksController } from './runner-tasks.controller';

/**
 * Which half of `/api/runner/*` a controller belongs to, pinned.
 *
 * The prefix is shared and the credential is shared; the only thing that differs is whether a
 * runner KEYS anything by the ids in the response. `RunnerApiController` does — scratch dirs,
 * `refs/orbit-base/<id>`, lease fences compared byte-for-byte — so it keeps UUIDs. The other four
 * are read by a model (via `orbit mcp`) or a person (via the `orbit` CLI), which hand the body
 * through verbatim, so they are spelled base62 like the rest of the API.
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

  for (const controller of [
    RunnerTasksController,
    RunnerSessionsController,
    RunnerAgentsController,
    RunnerServiceTokensController,
  ]) {
    assert.equal(
      Reflect.getMetadata(MACHINE_PROTOCOL, controller),
      undefined,
      `${controller.name} is read by a model or a person — its ids are addresses`,
    );
  }
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
