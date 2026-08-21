import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, Query } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { RunnerTasksController } from './runner-tasks.controller';

/**
 * `?projectId=` arrives in whichever spelling the caller holds. An agent reads a project id off a
 * web URL (`/projects/3H8pGALtipnCnHud4zBiky`, base62) or echoes a raw UUID back out of a previous
 * tool result, and the column is `@db.Uuid` — so an undecoded base62 string reaches the raw-SQL
 * ranking as `invalid input syntax for type uuid`, which is a bare 500 the caller cannot act on.
 *
 * `public-id-coverage.spec.ts` already fails the build when a route accepts an id-named query
 * without the pipe. This is the other half: that the pipe bound to THIS parameter actually decodes,
 * on both routes, so the two spellings reach TasksService as the same uuid.
 */

const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const BASE62 = uuidToBase62(UUID);

// Nest keys `__routeArguments__` as `paramtype:index`; read the query paramtype off a probe rather
// than hardcoding a number that only Nest's internals promise.
class Probe {
  probe(@Query('q') _q: string) {}
}
const QUERY = Number(
  Object.keys(Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'probe') as object)[0].split(':')[0],
);

function projectIdPipe(method: 'listTasks' | 'listTaskPage'): PublicIdPipe {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerTasksController, method) as Record<
    string,
    { data?: unknown; pipes?: unknown[] }
  >;
  const entry = Object.entries(args).find(
    ([key, arg]) => Number(key.split(':')[0]) === QUERY && arg.data === 'projectId',
  );
  assert.ok(entry, `${method} does not accept a projectId query parameter`);
  const [, arg] = entry;
  const pipe = (arg.pipes ?? []).find((p) => p === PublicIdPipe || p instanceof PublicIdPipe);
  assert.ok(pipe, `${method}(projectId) is not resolved through PublicIdPipe`);
  return pipe === PublicIdPipe ? new PublicIdPipe() : (pipe as PublicIdPipe);
}

for (const method of ['listTasks', 'listTaskPage'] as const) {
  test(`${method} accepts a project id in either spelling`, () => {
    const pipe = projectIdPipe(method);
    const asQuery = { type: 'query', data: 'projectId' } as const;

    assert.equal(pipe.transform(BASE62, asQuery), UUID);
    assert.equal(pipe.transform(UUID, asQuery), UUID);
  });

  // An absent filter is a legitimate request for the unfiltered list, and stays absent — this is
  // the property that keeps the legacy no-query call on `tasks.list`.
  test(`${method} leaves an absent project id absent`, () => {
    const pipe = projectIdPipe(method);
    const asQuery = { type: 'query', data: 'projectId' } as const;

    assert.equal(pipe.transform(undefined, asQuery), undefined);
    assert.equal(pipe.transform('', asQuery), undefined);
  });

  test(`${method} rejects a project id Prisma would 500 on, and names it`, () => {
    const pipe = projectIdPipe(method);
    const asQuery = { type: 'query', data: 'projectId' } as const;

    assert.throws(
      () => pipe.transform('not an id!', asQuery),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match((error as BadRequestException).message, /projectId/);
        return true;
      },
    );
  });
}
