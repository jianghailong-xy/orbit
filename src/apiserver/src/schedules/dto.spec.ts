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
  const maxRunsErrors = async (Dto: typeof ScheduleCreateDto | typeof ScheduleUpdateDto, body: object) =>
    (await validate(plainToInstance(Dto, body), { whitelist: true })).filter((e) => e.property === 'maxRuns');
  for (const Dto of [ScheduleCreateDto, ScheduleUpdateDto]) {
    for (const maxRuns of [1, 3]) {
      assert.deepEqual(await maxRunsErrors(Dto, { maxRuns }), [], `${Dto.name} ${maxRuns}`);
      assert.equal(plainToInstance(Dto, { maxRuns }).maxRuns, maxRuns, 'kept through the whitelist');
    }
    for (const maxRuns of [0, -1, 1.5, '3']) {
      assert.equal((await maxRunsErrors(Dto, { maxRuns })).length, 1, `${Dto.name} refuses ${JSON.stringify(maxRuns)}`);
    }
  }
  assert.deepEqual(await maxRunsErrors(ScheduleUpdateDto, { maxRuns: null }), [], 'null removes the planned end by count');
});

test('a card press may carry No end (dropSuggestedEnd), a boolean', async () => {
  for (const body of [{}, { dropSuggestedEnd: true }, { timezone: 'Asia/Shanghai', dropSuggestedEnd: false }]) {
    const dto = plainToInstance(ScheduleDecisionDto, body);
    assert.deepEqual(await validate(dto, { whitelist: true }), []);
    assert.deepEqual(Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)), body);
  }
  assert.equal((await validate(plainToInstance(ScheduleDecisionDto, { dropSuggestedEnd: 'yes' }))).length, 1);
});
