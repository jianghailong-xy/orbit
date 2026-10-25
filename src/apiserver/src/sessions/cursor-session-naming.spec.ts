import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { HeldKeyRow } from '../providers/held-key';
import { encryptSecret } from '../providers/provider-crypto';
import { ENGINE_NAMING_INSTRUCTIONS, engineNamingJob, titleFromPrompt } from './naming';

/**
 * Cursor CLI names a session in its first turn (session_info_update, docs/cursor-runtime-contract.md §3.2),
 * and its runner reports that title only when the claim asks for one (runner-go cursor_acp.go). The report is
 * kept while the session still carries the title its claim did and nothing else is compared, so a claim
 * that asked when it should not have would let Cursor CLI's title replace a task's, a person's or DeepSeek's.
 * engineNamingJob asks Cursor CLI by the rules it asks Claude Code and Codex by.
 */

process.env.PROVIDER_SECRET_KEY ??= 'cursor-session-naming-spec';

const PROMPT = 'Fix the flaky login timeout on Safari\nIt fails about once in ten runs.';
const NAMING = { description: PROMPT, instructions: ENGINE_NAMING_INSTRUCTIONS };
/** The engines that can answer from inside the process running the session. */
const NAMING_ENGINES = [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.CURSOR];

/** A session as its claim reads it: still titled with the fallback cut from its prompt, unless overridden. */
function session(overrides: Partial<Parameters<typeof engineNamingJob>[0]> = {}): Parameters<typeof engineNamingJob>[0] {
  return { title: titleFromPrompt(PROMPT), prompt: PROMPT, taskId: null, titleManagedByProject: false, model: null, ...overrides };
}

/** A configured row the session's provider names, as dispatch reads it. */
function row(runtime: string, baseUrl: string, secret: string, presetSlug: string | null = null): HeldKeyRow {
  return {
    runtime, baseUrl, apiKeyEnc: encryptSecret(secret), enabled: true,
    presetSlug, followsPreset: presetSlug !== null, models: [], defaultModel: null,
  };
}

function withDeepSeekKey<T>(key: string | undefined, fn: () => T): T {
  const original = process.env.DEEPSEEK_API_KEY;
  if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = key;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
}

test('P5a Cursor CLI is asked to name a session nothing else names, as Claude Code and Codex are, and no other engine is', () => {
  withDeepSeekKey(undefined, () => {
    for (const engine of NAMING_ENGINES) assert.deepEqual(engineNamingJob(session(), engine, null), NAMING, engine);
    // On a Cursor key saved in Orbit too: Cursor CLI alone spends one (heldKeyOf), so the server never named it.
    const cursorKey = row('cursor', 'https://api2.cursor.sh', 'key_cursor-session-naming-spec', 'cursor-api');
    assert.deepEqual(engineNamingJob(session({ model: 'default[]' }), AgentProvider.CURSOR, cursorKey), NAMING);
    // Bounded like every naming request.
    const long = session({ prompt: 'x'.repeat(2_000), title: 'x'.repeat(80) });
    assert.equal(engineNamingJob(long, AgentProvider.CURSOR, null)?.description.length, 600);
    // An engine with no way to answer from inside its own process is still not asked.
    for (const engine of [AgentProvider.KIMI, AgentProvider.ANTIGRAVITY, AgentProvider.OPENCODE, AgentProvider.DSH]) {
      assert.equal(engineNamingJob(session(), engine, null), undefined, engine);
    }
  });
});

test("P5a a title a task, a project, a person or DeepSeek gave is not handed to Cursor CLI, Claude Code or Codex to replace", () => {
  for (const engine of NAMING_ENGINES) {
    withDeepSeekKey(undefined, () => {
      // Each case differs from the session above in one thing only.
      assert.equal(engineNamingJob(session({ taskId: '44444444-4444-4444-8444-444444444444' }), engine, null), undefined, `${engine}: a task's title`);
      assert.equal(engineNamingJob(session({ titleManagedByProject: true }), engine, null), undefined, `${engine}: a project's title`);
      assert.equal(engineNamingJob(session({ title: 'My own name' }), engine, null), undefined, `${engine}: a person's rename`);
      assert.equal(engineNamingJob(session({ title: 'Safari login timeout' }), engine, null), undefined, `${engine}: DeepSeek's title`);
      // Opened with attachments and no words: its file names are its title. With no words and no title at
      // all, there is nothing to name it by.
      assert.equal(engineNamingJob(session({ prompt: '', title: 'trace.png' }), engine, null), undefined, `${engine}: no words`);
      assert.equal(engineNamingJob(session({ prompt: '', title: '' }), engine, null), undefined, `${engine}: no words, no title`);
    });
    // The server names it on its DeepSeek key, from the moment it is created: the claim does not race that
    // answer, even while it is still on its way.
    withDeepSeekKey('test-key', () => assert.equal(engineNamingJob(session(), engine, null), undefined, `${engine}: DeepSeek names it`));
  }
  // A key the server may spend named the session at creation, on that key (beautifySessionLater).
  withDeepSeekKey(undefined, () => {
    const deepseek = row('claude', 'https://api.deepseek.com/anthropic', 'sk-ds');
    assert.equal(engineNamingJob(session({ model: 'deepseek-chat' }), AgentProvider.CLAUDE, deepseek), undefined);
    const openai = row('codex', 'https://api.openai.com/v1', 'sk-openai');
    assert.equal(engineNamingJob(session({ model: 'gpt-5.5' }), AgentProvider.CODEX, openai), undefined);
  });
});
