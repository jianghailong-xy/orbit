import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CURSOR_CONVERSATION_MOVE_REFUSAL } from './account-move-capability';

/**
 * A Cursor CLI session that has talked is refused another account or key in one sentence wherever a person
 * meets the refusal (D5): at the control plane's doors (P6b, CURSOR_CONVERSATION_MOVE_REFUSAL), and at the
 * runner, which refuses the start of a session its workspace has moved to another account or key since its
 * conversation was opened (runner cursor_identity_pin.go). The two never compile together, so the sentence is
 * asserted across both.
 */

// `build/providers` → the package, and the repo above it.
const REPO = path.resolve(__dirname, '../../../..');

test('P6b follow-up the runner refuses a talked Cursor CLI session’s start on another identity in the control plane’s words', () => {
  const source = readFileSync(path.join(REPO, 'src/runner-go/cursor_identity_pin.go'), 'utf8');
  const declared = [...source.matchAll(/^const cursorConversationMoveRefusal = "((?:[^"\\]|\\.)*)"$/gm)];
  assert.equal(declared.length, 1, 'cursor_identity_pin.go declares cursorConversationMoveRefusal once, as one string');
  assert.equal(JSON.parse(`"${declared[0][1]}"`), CURSOR_CONVERSATION_MOVE_REFUSAL);
});
