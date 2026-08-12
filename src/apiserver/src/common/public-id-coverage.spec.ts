import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, Param, Query } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdPipe } from './public-id';
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
// on. PublicIdPipe is the single gate: it resolves the base62 short id the clients put in URLs,
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
        (kind === PARAM && !NON_ID_PARAMS.has(name)) || (kind === QUERY && ID_QUERIES.has(name));
      if (!wanted) continue;
      seen.push(`${method}(${name})`);
      if (!(arg.pipes ?? []).includes(PublicIdPipe)) missing.push(`${method}(${name})`);
    }
  }
  return { seen, missing };
}

for (const controller of CONTROLLERS) {
  test(`${controller.name} resolves every id it accepts through PublicIdPipe`, () => {
    const { seen, missing } = inspect(controller as never);
    assert.ok(seen.length > 0, 'found no id args — the metadata shape changed, not the routes');
    assert.deepEqual(missing, []);
  });
}

// Those routes pass the CLASS, not an instance, so Nest builds the pipe through its DI
// container at boot — and anything the constructor declares becomes a dependency it has to
// resolve. A `string[]` parameter there took the whole apiserver down with "Nest can't resolve
// dependencies of the PublicIdPipe (?) ... argument Array at index [0]", which every unit test
// here sailed past because they all say `new PublicIdPipe()` themselves. Hence: no constructor
// arguments, and the body form is a static factory instead.
test('PublicIdPipe is constructible by Nest with no injectable dependencies', () => {
  assert.equal(PublicIdPipe.length, 0, 'constructor takes an argument Nest would try to inject');
  const declared = Reflect.getMetadata('design:paramtypes', PublicIdPipe) as unknown[] | undefined;
  assert.deepEqual(declared ?? [], [], 'constructor declares injectable parameter types');
  assert.ok(new PublicIdPipe() instanceof PublicIdPipe);
});

// ── The rule itself ───────────────────────────────────────────────────────────────────────────
const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const B62 = uuidToBase62(UUID);
const asParam = { type: 'param', data: 'id' } as const;
const asQuery = { type: 'query', data: 'agentId' } as const;

test('PublicIdPipe accepts both spellings of a public id', () => {
  const pipe = new PublicIdPipe();
  assert.equal(pipe.transform(B62, asParam), UUID);
  assert.equal(pipe.transform(UUID, asParam), UUID);
  assert.equal(pipe.transform(UUID.toUpperCase(), asParam), UUID);
});

test('PublicIdPipe rejects an id Prisma would 500 on, and names it', () => {
  const pipe = new PublicIdPipe();
  for (const bad of ['not a uuid', 'abc-def']) {
    assert.throws(() => pipe.transform(bad, asParam), BadRequestException);
  }
  assert.throws(() => pipe.transform('no-pe', { type: 'param', data: 'tagId' }), {
    message: 'invalid tagId',
  });
  // Base62's alphabet is every alnum, so a short all-alnum word IS a valid public id — it just
  // decodes to a uuid nothing is filed under. That's a 404's job, not the pipe's.
  assert.equal(pipe.transform('nope', asParam), '00000000-0000-0000-0000-000000b52cc2');
});

// The one behaviour that differs by position, and the reason it isn't a caller's choice: a
// missing PARAM must fail. Handing `undefined` to Prisma drops the id from the WHERE clause
// entirely, so `findFirst({ id: undefined, ownerId })` would answer with an arbitrary row of
// that owner's. A missing QUERY is just an unfiltered list, which is a real request.
test('PublicIdPipe requires a param and tolerates an absent query', () => {
  const pipe = new PublicIdPipe();
  for (const absent of [undefined, '', '  ']) {
    assert.throws(() => pipe.transform(absent, asParam), BadRequestException, `param ${absent}`);
    assert.equal(pipe.transform(absent, asQuery), undefined, `query ${absent}`);
  }
  assert.equal(pipe.transform(B62, asQuery), UUID);
  assert.throws(() => pipe.transform('not a uuid', asQuery), BadRequestException);
});

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

// Why the rule is declared per field instead of inferred from the name: the wire is full of
// id-NAMED fields that are not public ids. `toolUseId` (`toolu_01…`) and `bundleId`
// (`com.orbit.ios`) aren't even base62, so a name-matching rule would 400 them; `clientTurnId` is
// a free-form idempotency key that must survive byte-for-byte or a retry stops deduping. Several
// ride the runner protocol, where a wrong 400 breaks runners that are already installed.
test('PublicIdPipe normalizes only the fields it was given', () => {
  const pipe = PublicIdPipe.forFields('agentId', 'taskId');
  const body = pipe.transform({
    prompt: 'go',
    agentId: B62,
    taskId: UUID,
    clientTurnId: 'RETRY-KEY-1',
    toolUseId: 'toolu_01ABC',
    bundleId: 'com.orbit.ios',
  });
  assert.deepEqual(body, {
    prompt: 'go',
    agentId: UUID,
    taskId: UUID,
    clientTurnId: 'RETRY-KEY-1',
    toolUseId: 'toolu_01ABC',
    bundleId: 'com.orbit.ios',
  });
});

test('PublicIdPipe refuses an undecodable id and ignores absent ones', () => {
  const pipe = PublicIdPipe.forFields('agentId');
  assert.deepEqual(pipe.transform({ prompt: 'go' }), { prompt: 'go' });
  assert.deepEqual(pipe.transform({ prompt: 'go', agentId: '' }), { prompt: 'go', agentId: '' });
  assert.throws(() => pipe.transform({ agentId: 'no-pe' }), { message: 'invalid agentId' });
});
