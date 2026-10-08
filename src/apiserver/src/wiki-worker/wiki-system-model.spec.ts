import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WIKI_SYSTEM_MODEL, WIKI_SYSTEM_MODEL_ENV } from '@orbit/shared';

import { readWikiSystemModel } from './wiki-system-model';

/**
 * How the wiki-worker reads its System model from the environment (wiki-system-model.ts, contract `systemModel.env`):
 * all three of the address, the key and the model or it is unconfigured, the concurrency's default, and what is said
 * about a value that cannot be used — never quoting the key or the address.
 */

// From build/wiki-worker back to the repository root, as wiki-rollout.spec.ts reads the contract.
const CONTRACT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8')) as {
  systemModel: { env: Record<string, string>; envRules: { defaultConcurrency: number } };
};

const KEY = 'sk-local-0123456789abcdef';
const BASE = 'http://10.1.2.3:8000';
const FULL = {
  ORBIT_WIKI_MODEL_BASE_URL: BASE,
  ORBIT_WIKI_MODEL_API_KEY: KEY,
  ORBIT_WIKI_MODEL: 'qwen3-coder',
};

test('the four variables are the contract\'s, and none is a name an agent session carries', () => {
  assert.deepEqual(CONTRACT.systemModel.env, { ...WIKI_SYSTEM_MODEL_ENV });
  assert.equal(CONTRACT.systemModel.envRules.defaultConcurrency, WIKI_SYSTEM_MODEL.defaultConcurrency);
  for (const name of Object.values(WIKI_SYSTEM_MODEL_ENV)) assert.doesNotMatch(name, /^ANTHROPIC_/);
});

test('nothing set: unconfigured, with nothing to complain about — a deployment without a System model', () => {
  assert.deepEqual(readWikiSystemModel({}), {
    configured: false,
    baseUrl: null,
    apiKey: null,
    model: null,
    concurrency: 4,
    missing: ['ORBIT_WIKI_MODEL_BASE_URL', 'ORBIT_WIKI_MODEL_API_KEY', 'ORBIT_WIKI_MODEL'],
    problems: [],
  });
  // Blank is unset.
  assert.equal(readWikiSystemModel({ ORBIT_WIKI_MODEL_BASE_URL: '  ', ORBIT_WIKI_MODEL: '' }).problems.length, 0);
});

test('all three set: configured, the address without its trailing slash, everything trimmed', () => {
  assert.deepEqual(
    readWikiSystemModel({
      ORBIT_WIKI_MODEL_BASE_URL: ` ${BASE}/ `,
      ORBIT_WIKI_MODEL_API_KEY: ` ${KEY}\n`,
      ORBIT_WIKI_MODEL: ' qwen3-coder ',
      ORBIT_WIKI_MODEL_CONCURRENCY: ' 8 ',
    }),
    { configured: true, baseUrl: BASE, apiKey: KEY, model: 'qwen3-coder', concurrency: 8, missing: [], problems: [] },
  );
  // A path under the host is kept: calls go to {base}/v1/messages.
  assert.equal(readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_BASE_URL: 'https://gpu.example/vllm//' }).baseUrl, 'https://gpu.example/vllm');
});

test('any of the three missing: unconfigured, saying which — and the values that were set are not repeated', () => {
  const noKey = readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_API_KEY: '' });
  assert.equal(noKey.configured, false);
  assert.equal(noKey.baseUrl, null);
  assert.equal(noKey.apiKey, null);
  // The name is still the model's: the status row says which model is waiting for its key.
  assert.equal(noKey.model, 'qwen3-coder');
  assert.deepEqual(noKey.missing, ['ORBIT_WIKI_MODEL_API_KEY']);
  assert.deepEqual(noKey.problems, [
    'ORBIT_WIKI_MODEL_API_KEY is not set: the System model needs ORBIT_WIKI_MODEL_BASE_URL, ORBIT_WIKI_MODEL_API_KEY and '
      + 'ORBIT_WIKI_MODEL, and is unconfigured',
  ]);
  const keyOnly = readWikiSystemModel({ ORBIT_WIKI_MODEL_API_KEY: KEY });
  assert.deepEqual(keyOnly.missing, ['ORBIT_WIKI_MODEL_BASE_URL', 'ORBIT_WIKI_MODEL']);
  assert.match(keyOnly.problems.join('\n'), /^ORBIT_WIKI_MODEL_BASE_URL, ORBIT_WIKI_MODEL are not set/);
  for (const config of [noKey, keyOnly]) {
    assert.equal(JSON.stringify(config.problems).includes(KEY), false);
    assert.equal(JSON.stringify(config.problems).includes(BASE), false);
  }
});

test('an address that is not an http(s) URL without credentials is unusable, and is not quoted', () => {
  for (const base of ['10.1.2.3:8000', 'localhost:8000', 'ftp://10.1.2.3/', `http://wiki:${KEY}@10.1.2.3:8000`, 'not a url']) {
    const config = readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_BASE_URL: base });
    assert.equal(config.configured, false, base);
    assert.deepEqual(config.missing, ['ORBIT_WIKI_MODEL_BASE_URL'], base);
    assert.deepEqual(config.problems, [
      'ORBIT_WIKI_MODEL_BASE_URL is not an http or https URL without credentials: the System model is unconfigured',
    ], base);
  }
});

test('a concurrency that is not a positive whole number is said, and the default used', () => {
  for (const asked of ['0', '-1', '1.5', 'four', '1e3']) {
    const config = readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_CONCURRENCY: asked });
    assert.equal(config.concurrency, 4, asked);
    assert.equal(config.configured, true, 'a concurrency of its own does not unconfigure the model');
    assert.deepEqual(config.problems, [`ORBIT_WIKI_MODEL_CONCURRENCY=${JSON.stringify(asked)} is not a positive whole number: 4 is used`]);
  }
  assert.equal(readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_CONCURRENCY: '1' }).concurrency, 1);
});
