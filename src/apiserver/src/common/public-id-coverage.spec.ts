import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NEVER_PUBLIC_ID_FIELDS, PUBLIC_ID_FIELDS, uuidToBase62 } from '@orbit/shared';
import { PublicIdPipe } from './public-id';
import {
  BatchAssignDto,
  BatchExecuteDto,
  BatchStopDto,
  CreateTaskCommentDto,
  CreateTaskDto,
} from '../tasks/dto';
import { UpdateTaskListDto } from '../task-lists/dto';
import { WorkspacesController } from '../workspaces/workspaces.controller';
import { AttachmentsController } from '../attachments/attachments.controller';
import { AdminProvidersController } from '../providers/admin-providers.controller';
import { ProvidersController } from '../providers/providers.controller';
import { RunnersController } from '../runners/runners.controller';
import { SessionTagsController } from '../session-tags/session-tags.controller';
import { SessionsController } from '../sessions/sessions.controller';
import { SharedController } from '../shared/shared.controller';
import { ProjectsController } from '../projects/projects.controller';
import { TaskListsController } from '../task-lists/task-lists.controller';
import { TasksController } from '../tasks/tasks.controller';
import { TaskCompletionEvidenceController } from '../tasks/task-completion-evidence.controller';
import { AdminController } from '../users/admin.controller';
import { RunnerAgentsController } from '../runner-api/runner-agents.controller';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { RunnerServiceTokensController } from '../runner-api/runner-service-tokens.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { RunnerTaskCompletionEvidenceController } from '../runner-api/runner-task-completion-evidence.controller';

// Every id crossing the HTTP boundary arrives from a URL, a human, or a model — pasted out of a
// client link, echoed from a previous tool result, or invented. The columns behind them are all
// `@db.Uuid`, so an id that isn't one reaches Prisma as an unhandled P2023 (or, in the raw-SQL
// list queries, `invalid input syntax for type uuid`) and the caller gets a bare 500 it cannot act
// on. PublicIdPipe is the single gate: it resolves the base62 short id the clients put in URLs,
// passes a raw UUID through, and turns everything else into a 400.
//
// Names that are NOT ids: `token` (share token), `userCode` (device pairing code), `seq` (an
// integer cursor), `version` (a task list revision's per-list number, guarded by ParseIntPipe).
// They key by their own columns and must stay unpiped.
// Deliberately a DENYLIST, and deliberately not replaced by PUBLIC_ID_FIELDS below: a route
// param IS the address, so the rule that fails safe is "every param is an id unless this list
// says otherwise". An allowlist would let a param nobody classified through unchecked. UUID
// exceptions are route-specific below: a generic `requestId` exemption would also silently exempt
// future public request-row addresses.
const NON_ID_PARAMS = new Set(['token', 'userCode', 'seq', 'version']);

const OPAQUE_PARAM_ROUTES: Readonly<Record<string, string>> = {
  'ProjectsController.decideCompletionAckOwnerDecision(requestId)':
    'the completion-ack request UUID is an exact bound-request fence; the project id remains the public address',
};

// Query filters, on the other hand, are a mixed bag of ids and ordinary filters, so those do
// read the shared classification — one list, so a name can't be an id on the way out and a
// free-form string on the way in.
const ID_QUERIES = PUBLIC_ID_FIELDS;

const CONTROLLERS = [
  WorkspacesController,
  AttachmentsController,
  AdminProvidersController,
  ProvidersController,
  RunnersController,
  SessionTagsController,
  SessionsController,
  SharedController,
  ProjectsController,
  TaskListsController,
  TasksController,
  TaskCompletionEvidenceController,
  AdminController,
  RunnerAgentsController,
  RunnerApiController,
  RunnerProjectsController,
  RunnerServiceTokensController,
  RunnerSessionsController,
  RunnerTasksController,
  RunnerTaskCompletionEvidenceController,
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

// A route binds the pipe either as the CLASS (Nest instantiates it) or as an instance from one of
// the static factories. Both run the same `transform`, so both count as resolved — matching only
// the class would push a route that declares a sentinel back into `missing`.
const resolvesPublicId = (pipes: unknown[]) =>
  pipes.some((p) => p === PublicIdPipe || p instanceof PublicIdPipe);
const validatesOpaqueUuid = (pipes: unknown[]) =>
  pipes.some((p) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe);

function inspect(controller: new (...args: never[]) => unknown) {
  const seen: string[] = [];
  const missing: string[] = [];
  const opaque: string[] = [];
  const opaqueUnvalidated: string[] = [];
  // Every name this controller resolves through the pipe, whether or not the rule wanted it —
  // the input to the "a fence token is never translated" check below.
  const piped: string[] = [];
  for (const method of Object.getOwnPropertyNames(controller.prototype as object)) {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as
      | Record<string, { data?: unknown; pipes?: unknown[] }>
      | undefined;
    for (const [key, arg] of Object.entries(args ?? {})) {
      const kind = Number(key.split(':')[0]);
      const name = arg.data;
      if (typeof name !== 'string') continue;
      if (resolvesPublicId(arg.pipes ?? [])) piped.push(name);
      const routeArg = `${controller.name}.${method}(${name})`;
      if (kind === PARAM && OPAQUE_PARAM_ROUTES[routeArg]) {
        opaque.push(routeArg);
        if (!validatesOpaqueUuid(arg.pipes ?? [])) opaqueUnvalidated.push(routeArg);
      }
      const wanted =
        (kind === PARAM && !NON_ID_PARAMS.has(name) && !OPAQUE_PARAM_ROUTES[routeArg])
        || (kind === QUERY && ID_QUERIES.has(name));
      if (!wanted) continue;
      seen.push(`${method}(${name})`);
      if (!resolvesPublicId(arg.pipes ?? [])) missing.push(`${method}(${name})`);
    }
  }
  return { seen, missing, opaque, opaqueUnvalidated, piped };
}

for (const controller of CONTROLLERS) {
  test(`${controller.name} resolves every id it accepts through PublicIdPipe`, () => {
    const { seen, missing } = inspect(controller as never);
    assert.ok(seen.length > 0, 'found no id args — the metadata shape changed, not the routes');
    assert.deepEqual(missing, []);
  });
}

test('opaque UUID route exceptions are exact, live, and use a non-translating UUID validator', () => {
  const live = CONTROLLERS.flatMap((controller) => inspect(controller as never).opaque).sort();
  assert.deepEqual(live, Object.keys(OPAQUE_PARAM_ROUTES).sort());
  const unvalidated = CONTROLLERS.flatMap(
    (controller) => inspect(controller as never).opaqueUnvalidated,
  );
  assert.deepEqual(unvalidated, []);
});

// ── The classification is exhaustive ──────────────────────────────────────────────────────────
// The point of failing here rather than in review: the cost of a misclassified id is not a 400
// someone notices, it is a base62 string reaching a `::uuid` cast or a fence comparison. Adding
// a `@db.Uuid` column is the moment to decide which it is, so the build asks then.
const SCHEMA = readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
const UUID_COLUMNS = new Set(
  [...SCHEMA.matchAll(/^\s*(\w+)\s+\S+.*@db\.Uuid/gm)].map((m) => m[1]),
);

test('every @db.Uuid column is classified, and classified once', () => {
  assert.ok(UUID_COLUMNS.size > 30, 'parsed almost no uuid columns — the schema format changed');
  const unclassified = [...UUID_COLUMNS].filter(
    (f) => !PUBLIC_ID_FIELDS.has(f) && !NEVER_PUBLIC_ID_FIELDS.has(f),
  );
  assert.deepEqual(
    unclassified,
    [],
    'new @db.Uuid column(s): add each to PUBLIC_ID_FIELDS (an address a caller may hand back) ' +
      'or NEVER_PUBLIC_ID_FIELDS (an opaque lease/fence token compared byte-for-byte)',
  );
  const both = [...UUID_COLUMNS].filter(
    (f) => PUBLIC_ID_FIELDS.has(f) && NEVER_PUBLIC_ID_FIELDS.has(f),
  );
  assert.deepEqual(both, [], 'classified as both a public id and never one');
});

// The half that has teeth today: the output side does not encode yet, so the only way to break
// the symmetry right now is to start DECODING a fence token — at which point the runner's echo
// of it stops matching what the server stored.
test('no route resolves a lease/fence token through PublicIdPipe', () => {
  const offenders = CONTROLLERS.flatMap((c) =>
    inspect(c as never)
      .piped.filter((name) => NEVER_PUBLIC_ID_FIELDS.has(name))
      .map((name) => `${c.name}(${name})`),
  );
  assert.deepEqual(offenders, []);
});

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
const asQuery = { type: 'query', data: 'workspaceId' } as const;

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

// …which is exactly why a filter whose vocabulary includes a word-shaped sentinel has to declare
// it. A sentinel that decodes cleanly produces no error anywhere: it becomes a uuid nothing is
// filed under, the query answers empty, and the feature just quietly stops existing.
test('PublicIdPipe hands a declared sentinel through and still decodes ids', () => {
  const pipe = PublicIdPipe.allowing('none');
  const asListId = { type: 'query', data: 'listId' } as const;
  assert.equal(pipe.transform('none', asListId), 'none');
  assert.equal(pipe.transform(B62, asListId), UUID);
  assert.equal(pipe.transform(UUID, asListId), UUID);
  // Undeclared words keep decoding — the exemption is per-value, not a blanket opt-out.
  assert.equal(pipe.transform('nope', asListId), '00000000-0000-0000-0000-000000b52cc2');
  assert.throws(() => pipe.transform('not a uuid', asListId), BadRequestException);
});

// The regression, guarded where it happened — at the route, not at the service. `?listId=none`
// means "tasks in no list"; once the pipe decoded it to 000…b52c46 the endpoint answered empty,
// and since the web/macOS "No list" sidebar row only renders when that count is > 0, every
// unlisted task (the shape an agent creates by default) became unreachable in the UI.
// `task-list-pagination.spec.ts` stayed green throughout: it calls `listPage` directly.
test('the tasks page route keeps the listId=none sentinel intact', () => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, TasksController, 'listPage') as Record<
    string,
    { data?: unknown; pipes?: unknown[] }
  >;
  const arg = Object.values(args).find((a) => a.data === 'listId');
  const pipe = (arg?.pipes ?? []).find((p) => p instanceof PublicIdPipe) as PublicIdPipe | undefined;
  assert.ok(pipe, 'listId must bind a PublicIdPipe instance that exempts the sentinel');
  assert.equal(pipe.transform('none', { type: 'query', data: 'listId' }), 'none');
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

// The batch DTOs took a base62 id, validated it as a plain string, and handed it to Prisma — a
// 500 on the exact ids the clients put in URLs. `UpdateTaskListDto.foremanWorkspaceId` had the
// mirror-image bug: `@IsUUID()` refused the short spelling with a 400. Both are the shape a
// decorator audit catches and a type-checker never will, so they get a behavioural test too.
test('the batch DTOs accept a pasted public id', async () => {
  const assign = plainToInstance(BatchAssignDto, { taskIds: [B62, UUID], assigneeId: B62 });
  assert.deepEqual(await validate(assign), []);
  assert.deepEqual(assign.taskIds, [UUID, UUID]);
  assert.equal(assign.assigneeId, UUID);

  for (const Dto of [BatchExecuteDto, BatchStopDto]) {
    const dto = plainToInstance(Dto, { taskIds: [B62] });
    assert.deepEqual(await validate(dto), [], Dto.name);
    assert.deepEqual(dto.taskIds, [UUID], Dto.name);
  }

  const comment = plainToInstance(CreateTaskCommentDto, { body: 'ping', mentions: [B62] });
  assert.deepEqual(await validate(comment), []);
  assert.deepEqual(comment.mentions, [UUID]);

  const list = plainToInstance(UpdateTaskListDto, { foremanWorkspaceId: B62 });
  assert.deepEqual(await validate(list), []);
  assert.equal(list.foremanWorkspaceId, UUID);
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
  const pipe = PublicIdPipe.forFields('workspaceId', 'taskId');
  const body = pipe.transform({
    prompt: 'go',
    workspaceId: B62,
    taskId: UUID,
    clientTurnId: 'RETRY-KEY-1',
    toolUseId: 'toolu_01ABC',
    bundleId: 'com.orbit.ios',
  });
  assert.deepEqual(body, {
    prompt: 'go',
    workspaceId: UUID,
    taskId: UUID,
    clientTurnId: 'RETRY-KEY-1',
    toolUseId: 'toolu_01ABC',
    bundleId: 'com.orbit.ios',
  });
});

test('PublicIdPipe refuses an undecodable id and ignores absent ones', () => {
  const pipe = PublicIdPipe.forFields('workspaceId');
  assert.deepEqual(pipe.transform({ prompt: 'go' }), { prompt: 'go' });
  assert.deepEqual(pipe.transform({ prompt: 'go', workspaceId: '' }), { prompt: 'go', workspaceId: '' });
  assert.throws(() => pipe.transform({ workspaceId: 'no-pe' }), { message: 'invalid workspaceId' });
});
