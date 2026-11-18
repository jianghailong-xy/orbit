import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ScheduleUpdateDto } from './dto';

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
