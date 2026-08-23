import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Body, Controller, Module, Post, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidToBase62 } from '@orbit/shared';

import { BatchExecuteDto, RunTaskDto } from './dto';

/**
 * `triggerId` ON THE WIRE, over real HTTP.
 *
 * The three things that decide whether this field is usable are all outside TypeScript's reach: a
 * POST with NO BODY AT ALL has to keep working (every client that predates the field sends none,
 * and Nest hands the handler whatever the pipe makes of `undefined`), the Base62 a client sends has
 * to arrive as the UUID the receipt is keyed on, and a value that is neither has to be refused
 * rather than quietly becoming part of a request name. A controller unit test that constructs a DTO
 * by hand proves none of them, because the pipe is the thing under test.
 *
 * Mounted on the same global `ValidationPipe` configuration `main.ts` installs — `whitelist`,
 * `transform`, `forbidNonWhitelisted: false` — because that configuration is half the behaviour.
 */
@Controller('tasks')
class WireController {
  @Post(':id/execute')
  execute(@Body() dto: RunTaskDto): unknown {
    return { triggerId: dto?.triggerId ?? null };
  }

  @Post('batch-execute')
  batch(@Body() dto: BatchExecuteDto): unknown {
    return { triggerId: dto?.triggerId ?? null, taskIds: dto?.taskIds ?? null };
  }
}

@Module({ controllers: [WireController] })
class WireModule {}

const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TASK = '550e8400-e29b-41d4-a716-446655440000';

test('a run request names its press on the wire, or names nothing at all', async (t) => {
  const app = await NestFactory.create(WireModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const post = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // WIRE COMPATIBILITY. No body, no content-type, nothing — which is what every build predating
  // this field sends, and what `POST /tasks/:id/execute` has always accepted.
  const bare = await post(`/tasks/${TASK}/execute`);
  assert.equal(bare.status, 201, 'a Run Now with no body is still a Run Now');
  assert.deepEqual(bare.body, { triggerId: null });

  // An empty body is the other spelling of the same thing.
  assert.deepEqual((await post(`/tasks/${TASK}/execute`, {})).body, { triggerId: null });

  // Base62 in, UUID out: the receipt is keyed on the decoded value, so a client that spells its
  // press the way every other id on this API is spelled must reach the same row as one that sends
  // the raw UUID.
  const base62 = await post(`/tasks/${TASK}/execute`, { triggerId: uuidToBase62(UUID) });
  assert.equal(base62.status, 201);
  assert.deepEqual(base62.body, { triggerId: UUID });
  assert.deepEqual((await post(`/tasks/${TASK}/execute`, { triggerId: UUID })).body,
    { triggerId: UUID });

  // ...and a value that is neither is REFUSED rather than becoming part of a request's name. A
  // token the server cannot decode is a token two clients could collide on.
  assert.equal((await post(`/tasks/${TASK}/execute`, { triggerId: 'not-an-id' })).status, 400);

  // The bulk door carries the same field on the same terms.
  const batch = await post('/tasks/batch-execute', {
    taskIds: [uuidToBase62(TASK)], triggerId: uuidToBase62(UUID),
  });
  assert.equal(batch.status, 201);
  assert.deepEqual(batch.body, { triggerId: UUID, taskIds: [TASK] });
  assert.deepEqual(
    (await post('/tasks/batch-execute', { taskIds: [uuidToBase62(TASK)] })).body,
    { triggerId: null, taskIds: [TASK] },
  );
});
