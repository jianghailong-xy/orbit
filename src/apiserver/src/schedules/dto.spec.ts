import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ScheduleCreateDto, ScheduleDecisionDto, ScheduleUpdateDto } from './dto';

test('schedule_update keeps an optional readBack through the whitelist and validates it', async () => {
  for (const body of [{}, { readBack: 'I check and report each day.' }, { readBack: 'x'.repeat(500) }]) {
    const dto = plainToInstance(ScheduleUpdateDto, body);
    assert.deepEqual(await validate(dto, { whitelist: true }), []);
    assert.deepEqual(Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)), body);
  }
  for (const readBack of [42, 'x'.repeat(501)]) {
    assert.equal((await validate(plainToInstance(ScheduleUpdateDto, { readBack }))).length, 1);
  }
});

test('maxRuns (§8.5) passes the whitelist as a whole number of at least 1, and null clears it on schedule_update', async () => {
  const maxRunsErrors = async (dto: object) =>
    (await validate(dto, { whitelist: true })).filter((e) => e.property === 'maxRuns');
  for (const maxRuns of [1, 3]) {
    const create = plainToInstance(ScheduleCreateDto, { maxRuns });
    const update = plainToInstance(ScheduleUpdateDto, { maxRuns });
    assert.deepEqual(await maxRunsErrors(create), [], `create ${maxRuns}`);
    assert.deepEqual(await maxRunsErrors(update), [], `update ${maxRuns}`);
    assert.deepEqual([create.maxRuns, update.maxRuns], [maxRuns, maxRuns], 'kept through the whitelist');
  }
  for (const maxRuns of [0, -1, 1.5, '3']) {
    const refused = `refuses ${JSON.stringify(maxRuns)}`;
    assert.equal((await maxRunsErrors(plainToInstance(ScheduleCreateDto, { maxRuns }))).length, 1, `create ${refused}`);
    assert.equal((await maxRunsErrors(plainToInstance(ScheduleUpdateDto, { maxRuns }))).length, 1, `update ${refused}`);
  }
  const cleared = plainToInstance(ScheduleUpdateDto, { maxRuns: null });
  assert.deepEqual(await maxRunsErrors(cleared), [], 'null removes the planned end by count');
});

test('a card press may carry No end (dropSuggestedEnd), a boolean', async () => {
  for (const body of [{}, { dropSuggestedEnd: true }, { timezone: 'Asia/Shanghai', dropSuggestedEnd: false }]) {
    const dto = plainToInstance(ScheduleDecisionDto, body);
    assert.deepEqual(await validate(dto, { whitelist: true }), []);
    assert.deepEqual(Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)), body);
  }
  assert.equal((await validate(plainToInstance(ScheduleDecisionDto, { dropSuggestedEnd: 'yes' }))).length, 1);
});
