/**
 * The ORBIT_CLAUDE_OPENAI_GATEWAY parity spec (docs/claude-engine-openai-gateway-design.md D6,
 * docs/provider-engine-contract.md §2.1, §4.2): with the flag off, every kind of credential resolves, dispatches
 * and lists its engines exactly as main did before the gateway existed; with it on, the only differences are the
 * OpenAI key's `engines` and the Claude Code session on that key.
 *
 * What "before" means is fixtures/gateway-flag-parity.json, written by gateway-flag-parity.cases.ts on main at
 * ccdef0955 (the recipe is in that file). Now, each case is built through the claim's current key-row step,
 * withKeyGatewayToken.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildParity, PARITY_CASES, type ParityResult } from './gateway-flag-parity.cases';
import { ANTHROPIC_GATEWAY_FLAG, KEY_GATEWAY_TOKEN_PREFIX, withKeyGatewayToken } from './key-gateway';
import { sameResolution } from './provider-engine-resolution';

const FIXTURE = path.resolve(__dirname, '../../src/providers/fixtures/gateway-flag-parity.json');
const before = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, ParityResult>;

/** Every field path at which `a` and `b` differ, `<case>.<field>…`. */
function differences(a: unknown, b: unknown, at: string): string[] {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].sort().flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

async function buildAll(flag: string | undefined): Promise<Record<string, ParityResult>> {
  const previous = process.env[ANTHROPIC_GATEWAY_FLAG];
  if (flag === undefined) delete process.env[ANTHROPIC_GATEWAY_FLAG];
  else process.env[ANTHROPIC_GATEWAY_FLAG] = flag;
  try {
    const out: Record<string, ParityResult> = {};
    for (const c of PARITY_CASES) out[c.name] = await buildParity(c, withKeyGatewayToken);
    return out;
  } finally {
    if (previous === undefined) delete process.env[ANTHROPIC_GATEWAY_FLAG];
    else process.env[ANTHROPIC_GATEWAY_FLAG] = previous;
  }
}

function diffAll(now: Record<string, ParityResult>): string[] {
  return PARITY_CASES.flatMap((c) => differences(before[c.name], now[c.name], c.name));
}

test('parity: the fixture covers every kind of credential, and nothing it holds is missing now', () => {
  const kinds = new Set(PARITY_CASES.map((c) => c.name.split('/')[0].replace(/-account$/, '')));
  assert.deepEqual([...kinds].sort(), [
    'account-pool', 'anthropic-key', 'cursor-key', 'deepseek-key', 'gemini-key', 'moonshot-key', 'openai-key',
    'opencode-config', 'runner-login', 'subscription-token',
  ]);
  assert.deepEqual(Object.keys(before).sort(), PARITY_CASES.map((c) => c.name).sort());
});

for (const flag of [undefined, '', 'false', 'FALSE', '1', 'yes']) {
  test(`parity: flag ${flag === undefined ? 'unset' : JSON.stringify(flag)} — resolution, dispatch environment and engines equal main before the gateway`, async () => {
    const now = await buildAll(flag);
    for (const c of PARITY_CASES) {
      assert.ok(sameResolution(before[c.name].resolution, now[c.name].resolution), `${c.name}: sameResolution`);
    }
    assert.deepEqual(diffAll(now), [], 'no field differs');
  });
}

test('parity: flag on — only the OpenAI key\'s engines and its Claude Code session differ', async () => {
  const now = await buildAll('true');
  const changed = diffAll(now);
  const claude = 'openai-key/claude';
  // Off the OpenAI key's Claude Code case, only the OpenAI key's engines list moves.
  assert.deepEqual(changed.filter((p) => !p.startsWith(`${claude}.`)), [
    'openai-key/codex.engines', 'openai-key/opencode.engines',
  ]);
  for (const name of ['openai-key/codex', 'openai-key/opencode', claude]) {
    assert.deepEqual(before[name].engines, ['codex', 'opencode'], `${name} before`);
    assert.deepEqual(now[name].engines, ['codex', 'claude', 'opencode'], `${name} now: codex stays the default (D7)`);
  }
  for (const c of PARITY_CASES) {
    if (c.name === claude || c.name.startsWith('openai-key/')) continue;
    assert.ok(sameResolution(before[c.name].resolution, now[c.name].resolution), `${c.name}: sameResolution`);
  }

  // Claude Code on the OpenAI key: refused before; now dispatched through the gateway, on a minted token.
  assert.equal(before[claude].env, null);
  assert.equal(before[claude].refusal, 'provider "openai" cannot run on Claude Code; it runs on Codex, OpenCode');
  assert.equal(before[claude].resolution.dispatchable, false);
  assert.equal(now[claude].refusal, null);
  const env = now[claude].env!;
  assert.ok(env.ANTHROPIC_AUTH_TOKEN.startsWith(KEY_GATEWAY_TOKEN_PREFIX), 'a minted orbit-gwk- token, never the key');
  assert.deepEqual({ ...env, ANTHROPIC_AUTH_TOKEN: '<minted>' }, {
    PARITY_WORKSPACE_VAR: 'kept',
    ANTHROPIC_BASE_URL: 'https://orbit.parity.invalid/api/gw/anthropic',
    ANTHROPIC_AUTH_TOKEN: '<minted>',
    ANTHROPIC_MODEL: 'gpt-5.1',
    ENABLE_CLAUDEAI_MCP_SERVERS: '0',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.1-mini',
    CLAUDE_CODE_INLINE_TOOLS: 'false',
    CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: '1',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '350000',
  });
  // resolutionOf reads the row unminted (it writes nothing): the gateway endpoint, and no credential of its own.
  assert.deepEqual({ ...now[claude].resolution, refusal: null }, {
    ...before[claude].resolution,
    engine: 'claude', endpoint: 'https://orbit.parity.invalid/api/gw/anthropic', keyFingerprint: null,
    dispatchable: true, refusal: null,
  });
});
