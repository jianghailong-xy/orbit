import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import {
  isWiderThanStarter,
  modeLimitsWhatItStarts,
  modesItMayStart,
  PERMISSION_MODE_WIDER_THAN_SESSION,
  SESSION_WIDER_THAN_CALLER,
  widerModeRefusal,
  widerSessionRefusal,
} from './permission-mode';

const { PLAN, DEFAULT, ACCEPT_EDITS, AUTO, DONT_ASK, BYPASS } = PermissionMode;
const ALL = [PLAN, DEFAULT, ACCEPT_EDITS, AUTO, DONT_ASK, BYPASS];

/** The owner's table, written out rather than derived from the code under test. */
const MAY_START: Record<PermissionMode, PermissionMode[]> = {
  [PLAN]: [PLAN],
  [DEFAULT]: [PLAN, DEFAULT, ACCEPT_EDITS, DONT_ASK],
  [ACCEPT_EDITS]: [PLAN, DEFAULT, ACCEPT_EDITS, DONT_ASK],
  [DONT_ASK]: [PLAN, DEFAULT, ACCEPT_EDITS, AUTO, DONT_ASK],
  [AUTO]: ALL,
  [BYPASS]: ALL,
};

for (const parent of ALL) {
  test(`${parent} starts what the table says on an engine that keeps every mode`, () => {
    const starter = { mode: parent, engine: AgentProvider.CLAUDE };
    for (const child of ALL) {
      assert.equal(
        isWiderThanStarter(starter, child, AgentProvider.CLAUDE),
        !MAY_START[parent].includes(child),
        `${parent} starting ${child}`,
      );
    }
    assert.deepEqual(modesItMayStart(starter, AgentProvider.CLAUDE).sort(), [...MAY_START[parent]].sort());
  });
}

test('only Auto and Bypass start anything at all', () => {
  assert.deepEqual(ALL.filter((mode) => !modeLimitsWhatItStarts(mode)).sort(), [AUTO, BYPASS].sort());
});

test('Codex Don\'t Ask runs as Bypass, so it is as wide as Bypass for whoever starts it', () => {
  for (const mode of [DEFAULT, ACCEPT_EDITS, DONT_ASK]) {
    assert.equal(isWiderThanStarter({ mode, engine: AgentProvider.CLAUDE }, DONT_ASK, AgentProvider.CODEX), true, mode);
    assert.equal(isWiderThanStarter({ mode, engine: AgentProvider.CLAUDE }, DONT_ASK, AgentProvider.CLAUDE), false, mode);
  }
  for (const mode of [AUTO, BYPASS]) {
    assert.equal(isWiderThanStarter({ mode, engine: AgentProvider.CLAUDE }, DONT_ASK, AgentProvider.CODEX), false, mode);
  }
});

test('the one exception is a Codex session in Don\'t Ask starting another', () => {
  const codex = { mode: DONT_ASK, engine: AgentProvider.CODEX };
  assert.equal(isWiderThanStarter(codex, DONT_ASK, AgentProvider.CODEX), false);
  // What it may start is still its stored mode's: it runs as Bypass, and it still may not start Bypass.
  assert.equal(isWiderThanStarter(codex, BYPASS, AgentProvider.CODEX), true);
  assert.equal(isWiderThanStarter(codex, BYPASS, AgentProvider.CLAUDE), true);
  // A Default Codex session is not that exception.
  assert.equal(isWiderThanStarter({ mode: DEFAULT, engine: AgentProvider.CODEX }, DONT_ASK, AgentProvider.CODEX), true);
});

test('Auto on an engine whose Auto reviews nothing is as wide as Bypass', () => {
  const starter = { mode: DONT_ASK, engine: AgentProvider.CLAUDE };
  for (const engine of [AgentProvider.KIMI, AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY]) {
    assert.equal(isWiderThanStarter(starter, AUTO, engine), true, engine);
  }
  for (const engine of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.DSH, AgentProvider.CURSOR]) {
    assert.equal(isWiderThanStarter(starter, AUTO, engine), false, engine);
  }
});

test('an engine nobody has named yet is judged by the mode\'s name', () => {
  assert.equal(isWiderThanStarter({ mode: DONT_ASK, engine: null }, DONT_ASK, null), false);
  assert.equal(isWiderThanStarter({ mode: DONT_ASK, engine: null }, AUTO, null), false);
  assert.equal(isWiderThanStarter({ mode: DONT_ASK, engine: null }, BYPASS, null), true);
  assert.equal(isWiderThanStarter({ mode: DEFAULT, engine: null }, AUTO, null), true);
});

test('the refusal carries its code, the two modes and the door\'s way forward', () => {
  const refusal = widerModeRefusal(DONT_ASK, DONT_ASK, AgentProvider.CODEX, 'Ask the owner.');
  assert.ok(refusal instanceof ForbiddenException);
  const body = refusal.getResponse() as { code: string; message: string };
  assert.equal(body.code, PERMISSION_MODE_WIDER_THAN_SESSION);
  assert.match(body.message, /This session runs in "dontAsk"/);
  assert.match(body.message, /On Codex that mode runs as bypassPermissions/);
  assert.match(body.message, /Ask the owner\.$/);
  const plain = widerModeRefusal(PLAN, AUTO, AgentProvider.CLAUDE, 'Ask the owner.');
  assert.doesNotMatch((plain.getResponse() as { message: string }).message, /runs as/);
});

test('the refusal for a session that already exists names both modes, the act, and what to do next', () => {
  const refusal = widerSessionRefusal(DEFAULT, 'target-id', AUTO, AgentProvider.CLAUDE, 'end it', 'Ask your coordinator.');
  assert.ok(refusal instanceof ForbiddenException);
  const body = refusal.getResponse() as { statusCode: number; code: string; message: string };
  assert.equal(body.statusCode, 403);
  assert.equal(body.code, SESSION_WIDER_THAN_CALLER);
  assert.equal(
    body.message,
    `This session runs in "${DEFAULT}", and session target-id runs in "${AUTO}", which is wider, so this session may not end it. Nothing was changed. Ask your coordinator.`,
  );
  const onKimi = widerSessionRefusal(DONT_ASK, 'target-id', AUTO, AgentProvider.KIMI, 'end it', 'Ask.');
  assert.match((onKimi.getResponse() as { message: string }).message, /On Kimi[^.]* that mode runs as bypassPermissions/);
});
