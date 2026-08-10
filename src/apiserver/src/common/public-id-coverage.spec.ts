import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, Param, Query } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { uuidToBase62 } from '@orbit/shared';
import { Base62UuidPipe, OptionalBase62UuidPipe } from './base62-uuid.pipe';
import { PublicIdBodyPipe } from './public-id';
import { CreateTaskDto } from '../tasks/dto';
import { AgentsController } from '../agents/agents.controller';
import { AttachmentsController } from '../attachments/attachments.controller';
import { AdminProvidersController } from '../providers/admin-providers.controller';
import { ProvidersController } from '../providers/providers.controller';
import { RunnersController } from '../runners/runners.controller';
import { SessionTagsController } from '../session-tags/session-tags.controller';
import { SessionsController } from '../sessions/sessions.controller';
import { SharedController } from '../shared/shared.controller';
import { TaskListsController } from '../task-lists/task-lists.controller';
import { TasksController } from '../tasks/tasks.controller';
import { AdminController } from '../users/admin.controller';
import { RunnerAgentsController } from '../runner-api/runner-agents.controller';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerServiceTokensController } from '../runner-api/runner-service-tokens.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';

// Every id crossing the HTTP boundary arrives from a URL, a human, or a model — pasted out of a
// client link, echoed from a previous tool result, or invented. The columns behind them are all
// `@db.Uuid`, so an id that isn't one reaches Prisma as an unhandled P2023 (or, in the raw-SQL
// list queries, `invalid input syntax for type uuid`) and the caller gets a bare 500 it cannot act
// on. Base62UuidPipe is the single gate: it resolves the base62 short id the clients put in URLs,
// passes a raw UUID through, and turns everything else into a 400.
//
// Names that are NOT ids: `token` (share token), `userCode` (device pairing code), `seq` (an
// integer cursor). They key by their own columns and must stay unpiped.
const NON_ID_PARAMS = new Set(['token', 'userCode', 'seq']);

// Query filters that carry an id. Kept explicit rather than pattern-matched on the name, so
// adding one is a deliberate act rather than something a regex silently decides.
const ID_QUERIES = new Set([
  'runnerId',
  'agentId',
  'tagId',
  'listId',
  'assigneeId',
  'sessionId',
  'parentSessionId',
]);

const CONTROLLERS = [
  AgentsController,
  AttachmentsController,
  AdminProvidersController,
  ProvidersController,
  RunnersController,
  SessionTagsController,
  SessionsController,
  SharedController,
  TaskListsController,
  TasksController,
  AdminController,
  RunnerAgentsController,
  RunnerApiController,
  RunnerServiceTokensController,
  RunnerSessionsController,
  RunnerTasksController,
];

// Nest records one entry per decorated argument under `__routeArguments__`, keyed
// `paramtype:index`; `data` is the name passed to the decorator and `pipes` the pipes bound to
// it. RouteParamtypes isn't public API, so read the two numbers off a probe rather than hardcode
// them — a renumbering inside Nest would otherwise turn this whole spec green against nothing.
class Probe {
  probe(@Param('p') _p: string, @Query('q') _q: string) {}
}
const [PARAM, QUERY] = (() => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'probe') as Record<
    string,
    { data?: unknown }
  >;
  const kindOf = (name: string) =>
    Number(Object.entries(args).find(([, a]) => a.data === name)![0].split(':')[0]);
  return [kindOf('p'), kindOf('q')];
})();

function inspect(controller: new (...args: never[]) => unknown) {
  const seen: string[] = [];
  const missing: string[] = [];
  for (const method of Object.getOwnPropertyNames(controller.prototype as object)) {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as
      | Record<string, { data?: unknown; pipes?: unknown[] }>
      | undefined;
    for (const [key, arg] of Object.entries(args ?? {})) {
      const kind = Number(key.split(':')[0]);
      const name = arg.data;
      if (typeof name !== 'string') continue;
      const wanted =
        kind === PARAM && !NON_ID_PARAMS.has(name)
          ? Base62UuidPipe
          : kind === QUERY && ID_QUERIES.has(name)
            ? OptionalBase62UuidPipe
            : null;
      if (!wanted) continue;
      seen.push(`${method}(${name})`);
      if (!(arg.pipes ?? []).includes(wanted)) missing.push(`${method}(${name})`);
    }
  }
  return { seen, missing };
}

for (const controller of CONTROLLERS) {
  test(`${controller.name} resolves every id it accepts through Base62UuidPipe`, () => {
    const { seen, missing } = inspect(controller as never);
    assert.ok(seen.length > 0, 'found no id args — the metadata shape changed, not the routes');
    assert.deepEqual(missing, []);
  });
}

test('Base62UuidPipe accepts the short id the clients put in URLs', () => {
  const uuid = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
  assert.equal(new Base62UuidPipe().transform(uuidToBase62(uuid)), uuid);
  assert.equal(new Base62UuidPipe().transform(uuid), uuid);
  assert.equal(new Base62UuidPipe().transform(uuid.toUpperCase()), uuid);
});

test('Base62UuidPipe rejects an id Prisma would 500 on, and names it', () => {
  for (const bad of ['not a uuid', 'abc-def', '']) {
    assert.throws(() => new Base62UuidPipe().transform(bad), BadRequestException);
  }
  assert.throws(() => new Base62UuidPipe().transform('no-pe', { type: 'param', data: 'tagId' }), {
    message: 'invalid tagId',
  });
  // Base62's alphabet is every alnum, so a short all-alnum word IS a valid public id — it just
  // decodes to a uuid nothing is filed under. That's a 404's job, not the pipe's.
  assert.equal(new Base62UuidPipe().transform('nope'), '00000000-0000-0000-0000-000000b52cc2');
});

// A filter is optional, so absent stays absent — but a present one that won't parse is refused
// rather than dropped. Dropping it would answer "my children" with every session the owner has.
test('OptionalBase62UuidPipe passes absence through and still refuses garbage', () => {
  const uuid = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
  const pipe = new OptionalBase62UuidPipe();
  assert.equal(pipe.transform(undefined), undefined);
  assert.equal(pipe.transform('  '), undefined);
  assert.equal(pipe.transform(uuidToBase62(uuid)), uuid);
  assert.throws(() => pipe.transform('not a uuid'), BadRequestException);
});

// ── Body ids ──────────────────────────────────────────────────────────────────────────────────
const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const B62 = uuidToBase62(UUID);

test('IsPublicId normalizes a base62 body id before validating it', async () => {
  const dto = plainToInstance(CreateTaskDto, {
    title: 'x',
    assigneeId: B62,
    listId: UUID,
    dependsOnTaskIds: [B62, UUID],
  });
  assert.deepEqual(await validate(dto), []);
  assert.equal(dto.assigneeId, UUID);
  assert.equal(dto.listId, UUID);
  assert.deepEqual(dto.dependsOnTaskIds, [UUID, UUID]);
});

test('IsPublicId still rejects a body id that is neither spelling', async () => {
  const errors = await validate(plainToInstance(CreateTaskDto, { title: 'x', assigneeId: 'no-pe' }));
  assert.deepEqual(
    errors.map((e) => e.property),
    ['assigneeId'],
  );
});

test('PublicIdBodyPipe normalizes only the fields it was given', () => {
  const pipe = new PublicIdBodyPipe(['agentId', 'taskId']);
  const body = pipe.transform({ prompt: 'go', agentId: B62, taskId: UUID, title: 'zzz' });
  assert.deepEqual(body, { prompt: 'go', agentId: UUID, taskId: UUID, title: 'zzz' });
});

test('PublicIdBodyPipe refuses an undecodable id and ignores absent ones', () => {
  const pipe = new PublicIdBodyPipe(['agentId']);
  assert.deepEqual(pipe.transform({ prompt: 'go' }), { prompt: 'go' });
  assert.deepEqual(pipe.transform({ prompt: 'go', agentId: '' }), { prompt: 'go', agentId: '' });
  assert.throws(() => pipe.transform({ agentId: 'no-pe' }), { message: 'invalid agentId' });
});
