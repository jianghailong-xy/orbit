import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { TestModelProviderDto } from './dto';

function probe(runtime: string): TestModelProviderDto {
  const dto = new TestModelProviderDto();
  dto.baseUrl = 'https://example.test/v1';
  dto.apiKey = 'secret';
  dto.runtime = runtime;
  return dto;
}

test('configured providers can still borrow only Claude or Codex', async () => {
  assert.equal((await validate(probe('claude'))).length, 0);
  assert.equal((await validate(probe('codex'))).length, 0);
  assert.notEqual((await validate(probe('kimi'))).length, 0);
});
