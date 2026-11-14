/**
 * What a scheduled run's access level becomes on its engine (schedule-access.ts, design §6.2): the mode, and the
 * tools the claim hands the runner. CHECK_ONLY on Claude Code runs in Don't Ask with its own allow and deny lists,
 * because Claude Code's headless Plan never permission-checks Bash (docs/scheduled-tasks-engine-modes.md §7).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PermissionMode } from '@orbit/shared';

import {
  CHECK_ONLY_CLAUDE_ALLOWED_TOOLS,
  CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS,
  OPEN_PR_DISALLOWED_TOOLS,
  scheduleRunAllowedTools,
  scheduleRunDisallowedTools,
  scheduleRunMode,
} from './schedule-access';

const WORKSPACE_ALLOWED = ['mcp__orbit__*', 'Bash(npm install:*)', 'Edit'];

test('CHECK_ONLY on Claude Code runs in Don\'t Ask; every other engine and level keeps its mode', () => {
  assert.equal(scheduleRunMode('CHECK_ONLY', 'claude'), PermissionMode.DONT_ASK);
  assert.equal(scheduleRunMode('CHECK_ONLY', null), PermissionMode.DONT_ASK, 'no engine named is Claude Code');
  assert.equal(scheduleRunMode('OPEN_PR', 'claude'), PermissionMode.ACCEPT_EDITS);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'codex'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'kimi'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'opencode'), PermissionMode.PLAN);
});

test('a CHECK_ONLY run on Claude Code may fetch a URL and use Orbit, and keeps none of the workspace\'s allow rules', () => {
  const allowed = scheduleRunAllowedTools(WORKSPACE_ALLOWED, 'CHECK_ONLY', 'claude');
  assert.deepEqual(allowed, ['mcp__orbit__*', 'WebFetch', 'WebSearch']);
  assert.deepEqual([...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS], ['WebFetch', 'WebSearch']);
  // A workspace rule could cover a writing command or a file edit, which Don't Ask would then run.
  assert.ok(!allowed.includes('Bash(npm install:*)'));
  assert.ok(!allowed.includes('Edit'));
  // No shell allow rule at all: Claude Code's own read-only check is what runs git log, ls, cat and grep.
  assert.ok(!allowed.some((rule) => rule.startsWith('Bash')));
});

test('a CHECK_ONLY run on Claude Code may not use the file tools or Orbit\'s create doors, on either surface', () => {
  const denied = scheduleRunDisallowedTools(['X'], 'CHECK_ONLY', 'claude');
  assert.deepEqual(denied, ['X', ...CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS]);
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
  for (const door of ['task_create', 'task_create_batch', 'project_create', 'session_create']) {
    assert.ok(denied.includes(`mcp__orbit__${door}`), door);
  }
  // The runner allows `Bash(<orbit> task create *)`; these deny rules win over it (measured, §7 of the record).
  for (const words of ['task create', 'task create-batch', 'project create', 'session create']) {
    assert.ok(denied.includes(`Bash(* ${words} *)`), words);
  }
  assert.deepEqual(scheduleRunDisallowedTools(['X', 'Edit'], 'CHECK_ONLY', 'claude').filter((t) => t === 'Edit'), ['Edit']);
});

test('every other run keeps the claim\'s tools: CHECK_ONLY elsewhere, OPEN_PR, and a session that is no run', () => {
  for (const provider of ['codex', 'kimi', 'opencode', 'dsh', 'cursor', 'antigravity']) {
    assert.deepEqual(scheduleRunAllowedTools(WORKSPACE_ALLOWED, 'CHECK_ONLY', provider), WORKSPACE_ALLOWED, provider);
    assert.deepEqual(scheduleRunDisallowedTools(['X'], 'CHECK_ONLY', provider), ['X'], provider);
  }
  assert.deepEqual(scheduleRunAllowedTools(WORKSPACE_ALLOWED, 'OPEN_PR', 'claude'), WORKSPACE_ALLOWED);
  assert.deepEqual(scheduleRunDisallowedTools(['X'], 'OPEN_PR', 'claude'), ['X', ...OPEN_PR_DISALLOWED_TOOLS]);
  assert.deepEqual(scheduleRunAllowedTools(WORKSPACE_ALLOWED, null, 'claude'), WORKSPACE_ALLOWED);
  assert.deepEqual(scheduleRunDisallowedTools(['X'], undefined, 'claude'), ['X']);
});

test('both claim paths hand the runner the run\'s allow and deny lists, by the session\'s level and provider', () => {
  const root = join(__dirname, '..', '..', 'src');
  for (const [file, session] of [
    ['queue/queue.service.ts', 'session'],
    ['runner-api/runner-api.controller.ts', 's'],
  ] as const) {
    const source = readFileSync(join(root, file), 'utf8');
    const level = `${session}.scheduleRun?.schedule.accessLevel,`;
    assert.ok(
      source.includes(`allowedTools: scheduleRunAllowedTools(\n          dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, workspace?.permissionRules ?? []),\n          ${level}\n          provider,\n        ),`),
      `${file}: allowedTools`,
    );
    assert.ok(
      source.includes(`disallowedTools: scheduleRunDisallowedTools(\n          (workspace?.disallowedTools as string[] | null) ?? [],\n          ${level}\n          provider,\n        ),`),
      `${file}: disallowedTools`,
    );
  }
});
