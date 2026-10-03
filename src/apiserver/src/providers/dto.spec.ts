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

test('configured providers borrow one of the four runtime CLIs', async () => {
  assert.equal((await validate(probe('claude'))).length, 0);
  assert.equal((await validate(probe('codex'))).length, 0);
  // Kimi is borrowable as a RUNTIME (that is how a Moonshot key reaches the Kimi CLI); it stays
  // reserved as a provider SLUG, which provider-slug.ts enforces separately.
  assert.equal((await validate(probe('kimi'))).length, 0);
  // So is Antigravity: a Gemini key reaches agy through its environment (GEMINI_API_KEY).
  assert.equal((await validate(probe('antigravity'))).length, 0);
  // OpenCode is not: it picks its own provider and model, so there is nothing a row could hand it.
  assert.notEqual((await validate(probe('opencode'))).length, 0);
  assert.notEqual((await validate(probe('moonshot'))).length, 0);
});
