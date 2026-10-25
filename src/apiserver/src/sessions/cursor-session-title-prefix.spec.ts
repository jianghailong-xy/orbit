import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { HeldKeyRow } from '../providers/held-key';
import { encryptSecret } from '../providers/provider-crypto';
import { ENGINE_NAMING_INSTRUCTIONS, engineNamingJob, titleFromPrompt } from './naming';

/**
 * D-P8-2: P8 opened a Cursor CLI session on a saved Cursor key with no title, and after its first turn it was
 * called "Orbit Agent Instructions". Cursor CLI names a conversation from the first prompt it is sent
 * (docs/cursor-runtime-contract.md §3.2); that prompt led with Orbit's agent instructions, and the runner
 * reported the name because the claim asked for one. The runner now reports no title for a conversation it
 * opened (runner-go TestCursorSessionTitlePrefix), so the session keeps the title it was created with. This is
 * the server's half: that title is the one cut from the person's first message, and the claim asks for a name
 * against it, by the P5a follow-up's rule.
 */

process.env.PROVIDER_SECRET_KEY ??= 'cursor-session-title-prefix-spec';

/** P8's message, and the title its session was created with — the one runner-go cursor_session_title_test.go starts from. */
const P8_MESSAGE = 'Please explain in two sentences what the add() function in calc.py does. Do not run any commands.';
const P8_TITLE = 'Please explain in two sentences what the add() function in calc.py does. Do not ';

test("D-P8-2 an untitled Cursor CLI session carries the title cut from its first message, and its claim asks for a name against it", () => {
  const original = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(titleFromPrompt(P8_MESSAGE), P8_TITLE);
    const key: HeldKeyRow = {
      runtime: 'cursor', baseUrl: 'https://api2.cursor.sh', apiKeyEnc: encryptSecret('key_cursor-session-title-prefix-spec'),
      enabled: true, presetSlug: 'cursor-api', followsPreset: true, models: [], defaultModel: null,
    };
    const session = { title: P8_TITLE, prompt: P8_MESSAGE, taskId: null, titleManagedByProject: false, model: 'default[]' };
    assert.deepEqual(engineNamingJob(session, AgentProvider.CURSOR, key), { description: P8_MESSAGE, instructions: ENGINE_NAMING_INSTRUCTIONS });
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
});
