import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import { WIKI_SYSTEM_MODEL, WIKI_SYSTEM_MODEL_ENV, WIKI_SYSTEM_MODEL_THINKING } from '@orbit/shared';

import { currentWikiSystemModel, readWikiSystemModel } from './wiki-system-model';

/**
 * How the wiki-worker reads its System model from the environment (wiki-system-model.ts, contract `systemModel.env`):
 * all three of the address, the key and the model or it is unconfigured, the concurrency's default, the opt-in
 * thinking switch, and what is said about a value that cannot be used — never quoting the key or the address.
 */

// From build/wiki-worker back to the repository root, as wiki-rollout.spec.ts reads the contract.
const CONTRACT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8')) as {
  systemModel: { env: Record<string, string>; envRules: { defaultConcurrency: number; thinkingValues: string[] } };
};

const KEY = 'sk-local-0123456789abcdef';
const BASE = 'http://10.1.2.3:8000';
const FULL = {
  ORBIT_WIKI_MODEL_BASE_URL: BASE,
  ORBIT_WIKI_MODEL_API_KEY: KEY,
  ORBIT_WIKI_MODEL: 'qwen3-coder',
};

test('the five variables are the contract\'s, and none is a name an agent session carries', () => {
  assert.deepEqual(CONTRACT.systemModel.env, { ...WIKI_SYSTEM_MODEL_ENV });
  assert.equal(CONTRACT.systemModel.envRules.defaultConcurrency, WIKI_SYSTEM_MODEL.defaultConcurrency);
  assert.deepEqual(CONTRACT.systemModel.envRules.thinkingValues, [...WIKI_SYSTEM_MODEL_THINKING]);
  for (const name of Object.values(WIKI_SYSTEM_MODEL_ENV)) assert.doesNotMatch(name, /^ANTHROPIC_/);
});

test('nothing set: unconfigured, with nothing to complain about — a deployment without a System model', () => {
  assert.deepEqual(readWikiSystemModel({}), {
    configured: false,
    baseUrl: null,
    apiKey: null,
    model: null,
    concurrency: 4,
    thinking: null,
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
    { configured: true, baseUrl: BASE, apiKey: KEY, model: 'qwen3-coder', concurrency: 8, thinking: null, missing: [], problems: [] },
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

test('the thinking switch: disabled and enabled are taken as written; unset, empty or blank is no setting, and says nothing', () => {
  for (const setting of ['disabled', 'enabled'] as const) {
    assert.deepEqual(readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_THINKING: setting }), {
      configured: true, baseUrl: BASE, apiKey: KEY, model: 'qwen3-coder', concurrency: 4, thinking: setting, missing: [], problems: [],
    }, setting);
    // Trimmed, as every other variable is.
    assert.equal(readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_THINKING: ` ${setting}\n` }).thinking, setting);
  }
  for (const unset of [{}, { ORBIT_WIKI_MODEL_THINKING: '' }, { ORBIT_WIKI_MODEL_THINKING: '  ' }]) {
    const config = readWikiSystemModel({ ...FULL, ...unset });
    assert.equal(config.thinking, null, JSON.stringify(unset));
    assert.deepEqual(config.problems, [], JSON.stringify(unset));
    assert.equal(config.configured, true);
  }
});

test('a thinking value that is neither is said, and no thinking is sent; it does not unconfigure the model', () => {
  for (const asked of ['Disabled', 'ENABLED', 'off', 'false', 'none', 'adaptive', '{"type":"disabled"}']) {
    const config = readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_THINKING: asked });
    assert.equal(config.thinking, null, asked);
    assert.equal(config.configured, true, 'a thinking value of its own does not unconfigure the model');
    assert.deepEqual(config.problems, [`ORBIT_WIKI_MODEL_THINKING=${JSON.stringify(asked)} is not disabled or enabled: no thinking field is sent`]);
  }
});

test('the thinking switch decides nothing about whether there is a System model', () => {
  // Alone it is not a configuration somebody started: nothing is missing that anybody asked for.
  const alone = readWikiSystemModel({ ORBIT_WIKI_MODEL_THINKING: 'disabled' });
  assert.equal(alone.configured, false);
  assert.deepEqual(alone.missing, ['ORBIT_WIKI_MODEL_BASE_URL', 'ORBIT_WIKI_MODEL_API_KEY', 'ORBIT_WIKI_MODEL']);
  assert.deepEqual(alone.problems, []);
  assert.equal(alone.thinking, 'disabled');
  // And a model without a key stays unconfigured, whatever it says.
  const noKey = readWikiSystemModel({ ...FULL, ORBIT_WIKI_MODEL_API_KEY: '', ORBIT_WIKI_MODEL_THINKING: 'disabled' });
  assert.equal(noKey.configured, false);
  assert.deepEqual(noKey.missing, ['ORBIT_WIKI_MODEL_API_KEY']);
});

test('the worker\'s log names the thinking switch when it is set, says a value it cannot use once, and never the key', (t) => {
  const said: string[] = [];
  const warned: string[] = [];
  t.mock.method(Logger.prototype, 'log', (message: unknown) => {
    said.push(String(message));
  });
  t.mock.method(Logger.prototype, 'warn', (message: unknown) => {
    warned.push(String(message));
  });
  const names = [...Object.values(WIKI_SYSTEM_MODEL_ENV)];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const environment = (thinking: string | undefined) => {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, FULL);
    if (thinking !== undefined) process.env.ORBIT_WIKI_MODEL_THINKING = thinking;
  };

  environment('disabled');
  assert.equal(currentWikiSystemModel().thinking, 'disabled');
  assert.deepEqual(said, ['System model qwen3-coder at http://10.1.2.3:8000; 4 request(s) in flight at once; thinking disabled on every call']);
  assert.deepEqual(warned, []);

  // A value it cannot use: said once as a problem, however often the configuration is read, and nothing named as sent.
  environment('off');
  for (let read = 0; read < 3; read += 1) assert.equal(currentWikiSystemModel().thinking, null);
  assert.deepEqual(warned, ['ORBIT_WIKI_MODEL_THINKING="off" is not disabled or enabled: no thinking field is sent']);
  assert.equal(said.length, 2);
  assert.equal(said[1], 'System model qwen3-coder at http://10.1.2.3:8000; 4 request(s) in flight at once');

  // Unset: the line it always was.
  environment(undefined);
  assert.equal(currentWikiSystemModel().thinking, null);
  assert.equal(said[2], 'System model qwen3-coder at http://10.1.2.3:8000; 4 request(s) in flight at once');
  assert.equal(warned.length, 1);

  environment('enabled');
  currentWikiSystemModel();
  assert.equal(said[3], 'System model qwen3-coder at http://10.1.2.3:8000; 4 request(s) in flight at once; thinking enabled on every call');
  for (const line of [...said, ...warned]) assert.equal(line.includes(KEY), false, `${line} names the key`);
});
