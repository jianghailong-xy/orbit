/**
 * The ORBIT_CLAUDE_OPENAI_GATEWAY parity spec (docs/claude-engine-openai-gateway-design.md D6,
 * docs/provider-engine-contract.md §2.1, §4.2): with the flag off, every kind of credential resolves, dispatches
 * and lists its engines exactly as main did before the gateway existed; with it on, the only differences are the
 * OpenAI key's `engines` and the Claude Code session on that key.
 *
 * What "before" means is fixtures/gateway-flag-parity.json, written by gateway-flag-parity.cases.ts on main at
 * ccdef0955 (the recipe is in that file). Now, each case is built through the claim's current key-row step,
 * withKeyGatewayToken.
 *
 * ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY (P2b, design §9) is held to the same rule: off, nothing differs; on, only the
 * owner's own Codex login pool's `engines` and its Claude Code session do — and a shared Codex pool still never
 * runs Claude Code. Now a pool's credential is classified as dispatch classifies it (storedCredential) and its
 * claim's row is what QueueService.resolveLoginPool returns for it.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { buildParity, PARITY_CASES, POOLS, type ParityResult, type PoolHook } from './gateway-flag-parity.cases';
import { CLAUDE_CODEX_LOGIN_FLAG, claudeCodexLoginEnabled, codexLoginClaudeExecRow } from './codex-login-claude';
import { storedCredential } from './engine-provider';
import { ANTHROPIC_GATEWAY_FLAG, KEY_GATEWAY_TOKEN_PREFIX, withKeyGatewayToken } from './key-gateway';
import { POOL_LOGIN_TOKEN_PREFIX } from './shared-pool';
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

/** The pool step as dispatch has it now: storedCredential's classification, and resolveLoginPool's row. */
const POOL_NOW: PoolHook = {
  credential: async (db, c) => (await storedCredential(db, { ownerId: PARITY_OWNER, provider: c.provider, providerBuiltin: c.providerBuiltin }))!,
  row: (_db, c) => {
    const pool = POOLS[c.provider];
    if (!pool) return null;
    // resolveLoginPool answers only the owner's own Codex pool; the shared one is resolveSharedPool's, unchanged.
    const ownLogin = pool.engine === 'codex' && !pool.shared;
    return ownLogin && c.engine === AgentProvider.CLAUDE && claudeCodexLoginEnabled()
      ? codexLoginClaudeExecRow('orbit-gwl-parity-session-token')
      : pool.dispatches();
  },
};
/** The owner every parity case's session is of (gateway-flag-parity.cases.ts). */
const PARITY_OWNER = '0190f3c2-0000-7000-8000-00000000a001';

async function buildAll(flag: string | undefined, loginFlag: string | undefined): Promise<Record<string, ParityResult>> {
  const previous = [process.env[ANTHROPIC_GATEWAY_FLAG], process.env[CLAUDE_CODEX_LOGIN_FLAG]];
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set(ANTHROPIC_GATEWAY_FLAG, flag);
  set(CLAUDE_CODEX_LOGIN_FLAG, loginFlag);
  try {
    const out: Record<string, ParityResult> = {};
    for (const c of PARITY_CASES) out[c.name] = await buildParity(c, withKeyGatewayToken, POOL_NOW);
    return out;
  } finally {
    set(ANTHROPIC_GATEWAY_FLAG, previous[0]);
    set(CLAUDE_CODEX_LOGIN_FLAG, previous[1]);
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
  test(`parity: both flags ${flag === undefined ? 'unset' : JSON.stringify(flag)} — resolution, dispatch environment and engines equal main before the gateway`, async () => {
    const now = await buildAll(flag, flag);
    for (const c of PARITY_CASES) {
      assert.ok(sameResolution(before[c.name].resolution, now[c.name].resolution), `${c.name}: sameResolution`);
    }
    assert.deepEqual(diffAll(now), [], 'no field differs');
  });
}

test('parity: flag on — only the OpenAI key\'s engines and its Claude Code session differ', async () => {
  const now = await buildAll('true', undefined);
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

const OWN = 'account-pool/claude-on-own-codex-pool';
const SHARED = 'account-pool/claude-on-shared-codex-pool';

test('parity: ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY on — only the own Codex login pool\'s engines and its Claude Code session differ', async () => {
  const now = await buildAll(undefined, 'true');
  assert.deepEqual(diffAll(now).filter((p) => !p.startsWith(`${OWN}.`)), ['account-pool/codex.engines']);
  for (const name of ['account-pool/codex', OWN]) {
    assert.deepEqual(before[name].engines, ['codex'], `${name} before`);
    assert.deepEqual(now[name].engines, ['codex', 'claude'], `${name} now: codex stays the default (D7)`);
  }
  // A shared Codex pool is never offered Claude Code, and still refuses it; Codex on it is unchanged.
  for (const name of [SHARED, 'account-pool/codex-on-shared-codex-pool']) {
    assert.deepEqual(now[name], before[name], `${name} unchanged`);
    assert.deepEqual(now[name].engines, ['codex']);
  }
  assert.equal(now[SHARED].env, null);
  assert.match(now[SHARED].refusal ?? '', /cannot run on Claude Code/);
  for (const c of PARITY_CASES) {
    assert.ok(sameResolution(before[c.name].resolution, now[c.name].resolution), `${c.name}: sameResolution`);
  }

  // Claude Code on the owner's own pool: refused before; now dispatched through /api/gw/anthropic on the pool's
  // session token — never an account's token, and no Codex endpoint or key variable.
  assert.equal(before[OWN].env, null);
  assert.equal(before[OWN].refusal, 'provider "codex-pool" cannot run on Claude Code; it runs on Codex, OpenCode');
  assert.equal(now[OWN].refusal, null);
  const env = now[OWN].env!;
  assert.ok(env.ANTHROPIC_AUTH_TOKEN.startsWith(POOL_LOGIN_TOKEN_PREFIX));
  assert.deepEqual(env, {
    PARITY_WORKSPACE_VAR: 'kept',
    ANTHROPIC_BASE_URL: 'https://orbit.parity.invalid/api/gw/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'orbit-gwl-parity-session-token',
    ANTHROPIC_MODEL: 'gpt-5.6-sol',
    ENABLE_CLAUDEAI_MCP_SERVERS: '0',
    CLAUDE_CODE_INLINE_TOOLS: 'false',
    CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: '1',
  });
});

test('parity: both flags on — the two sets of differences, and nothing else', async () => {
  const now = await buildAll('true', 'true');
  const changed = diffAll(now).filter((p) => !p.startsWith(`${OWN}.`) && !p.startsWith('openai-key/claude.'));
  assert.deepEqual(changed, ['account-pool/codex.engines', 'openai-key/codex.engines', 'openai-key/opencode.engines']);
  assert.deepEqual(now[SHARED], before[SHARED]);
  assert.equal(now[OWN].env?.ANTHROPIC_AUTH_TOKEN, 'orbit-gwl-parity-session-token');
  assert.ok(now['openai-key/claude'].env?.ANTHROPIC_AUTH_TOKEN.startsWith(KEY_GATEWAY_TOKEN_PREFIX));
});
