/**
 * What a scheduled run's access level becomes on its engine (schedule-access.ts, design §6.2): the mode, and the
 * tools the claim hands the runner. CHECK_ONLY on Claude Code runs in Default with its own allow and deny lists,
 * because Claude Code's headless Plan never permission-checks Bash, and a shell command it does not judge read-only
 * asks (docs/scheduled-tasks-engine-modes.md §7, §9).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PermissionMode } from '@orbit/shared';

import {
  CHECK_ONLY_CLAUDE_ALLOWED_TOOLS,
  CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS,
  CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS,
  OPEN_PR_DISALLOWED_TOOLS,
  scheduleRunAllowedTools,
  scheduleRunDisallowedTools,
  checkOnlyRefusesApproval,
  scheduleRunMode,
} from './schedule-access';
import { heldClause, heldCopy } from './schedule-attention';

const WORKSPACE_ALLOWED = ['mcp__orbit__*', 'Bash(npm install:*)', 'Edit'];

test('CHECK_ONLY on Claude Code runs in Default; every other engine and level keeps its mode', () => {
  assert.equal(scheduleRunMode('CHECK_ONLY', 'claude'), PermissionMode.DEFAULT);
  assert.equal(scheduleRunMode('CHECK_ONLY', null), PermissionMode.DEFAULT, 'no engine named is Claude Code');
  assert.equal(scheduleRunMode('OPEN_PR', 'claude'), PermissionMode.ACCEPT_EDITS);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'codex'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'kimi'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'opencode'), PermissionMode.PLAN);
});

test('a CHECK_ONLY run on Claude Code is allowed what a check needs and the workspace\'s shell rules, nothing else', () => {
  const allowed = scheduleRunAllowedTools(WORKSPACE_ALLOWED, 'CHECK_ONLY', 'claude');
  assert.deepEqual(allowed, [
    'mcp__orbit__schedule_run_report',
    'mcp__orbit__schedule_get',
    'mcp__orbit__schedule_list',
    'mcp__orbit__schedule_update',
    'mcp__orbit__schedule_end',
    'mcp__orbit__notify',
    'mcp__orbit__task_get',
    'mcp__orbit__task_list',
    'mcp__orbit__session_get',
    'mcp__orbit__session_search',
    'mcp__orbit__project_get',
    'mcp__orbit__wiki_search',
    'mcp__orbit__wiki_get',
    'mcp__orbit__file_fetch',
    'mcp__orbit__file_list',
    'WebFetch',
    'WebSearch',
    'Bash(npm install:*)',
  ]);
  assert.deepEqual(allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS, 'Bash(npm install:*)']);
  assert.ok(!allowed.includes('mcp__orbit__*'), 'no wildcard over Orbit\'s tools');
  for (const tool of [
    'bg_run', 'session_merge', 'task_start', 'task_update', 'task_reopen', 'session_send', 'project_send',
    'task_create', 'task_create_batch', 'project_create', 'session_create', 'task_comment', 'file_upload',
    'integration_request_promotion', 'provider_update', 'agent_update', 'runner_delete',
  ]) {
    assert.ok(!allowed.includes(`mcp__orbit__${tool}`), tool);
  }
  // Every listed Orbit tool is one the runner offers (S4's schedule_* tools included), so none is a dead rule.
  const catalogue = readFileSync(join(__dirname, '..', '..', '..', 'runner-go', 'operation_catalog.go'), 'utf8');
  for (const tool of allowed.filter((t) => t.startsWith('mcp__orbit__'))) {
    const name = tool.slice('mcp__orbit__'.length);
    assert.ok(catalogue.includes(`"${name}"`), `${name} is in runner-go's operation catalogue`);
  }
  for (const tool of ['schedule_create', 'schedule_pause', 'schedule_resume', 'schedule_run_now', 'schedule_run_stop', 'schedule_delete', 'schedule_wakeup']) {
    assert.ok(catalogue.includes(`"${tool}"`), tool);
    assert.ok(!allowed.includes(`mcp__orbit__${tool}`), `${tool} is not a CHECK_ONLY run's`);
  }
  // Only Orbit tools that read, report the run, or touch the run's own schedule.
  for (const tool of allowed.filter((t) => t.startsWith('mcp__orbit__'))) {
    assert.match(tool, /^mcp__orbit__(schedule_(run_report|get|list|update|end)|notify|[a-z]+_(get|list|search|fetch))$/, tool);
  }
  // A rule for a file edit is not carried: Edit is denied anyway, and no rule but a shell command's is the run's.
  assert.ok(!allowed.includes('Edit'));
});

test('of the workspace\'s rules a CHECK_ONLY run on Claude Code carries only narrow Bash(…) ones', () => {
  const workspace = [
    'mcp__orbit__*', 'Bash(npm test:*)', 'Bash(psql -c select 1)', 'Edit', 'Write(src/**)', 'mcp__orbit__bg_run',
    'mcp__docs__write', 'WebFetch(domain:example.com)', 'Bash', 'Bash(*)', 'Bash(:*)', 'Read(/etc/**)',
    'Bash(/usr/local/bin/orbit task update:*)',
  ];
  const carried = scheduleRunAllowedTools(workspace, 'CHECK_ONLY', 'claude').filter(
    (t) => !CHECK_ONLY_CLAUDE_ALLOWED_TOOLS.includes(t),
  );
  assert.deepEqual(carried, ['Bash(npm test:*)', 'Bash(psql -c select 1)', 'Bash(/usr/local/bin/orbit task update:*)']);
  // A rule for the Orbit CLI is carried, and the deny list still wins over it (measured, record §9).
  const denied = scheduleRunDisallowedTools([], 'CHECK_ONLY', 'claude');
  assert.ok(denied.includes('Bash(*/orbit *)'));
  // No duplicate when the workspace repeats an allowed tool.
  const twice = scheduleRunAllowedTools(['WebFetch', 'Bash(ls -la:*)', 'Bash(ls -la:*)'], 'CHECK_ONLY', 'claude');
  assert.equal(twice.filter((t) => t === 'WebFetch').length, 1);
  assert.equal(twice.filter((t) => t === 'Bash(ls -la:*)').length, 1);
});

test('every Orbit tool orbit mcp serves is allowed or denied by name for a CHECK_ONLY run on Claude Code', () => {
  // The runner answers Claude Code's ask about an Orbit tool itself and allows it outside Plan, so a tool on neither
  // list would run unasked. docs/operation-catalog.md is generated from the runner's catalogue (and checked there).
  const doc = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'operation-catalog.md'), 'utf8');
  const table = doc.slice(0, doc.indexOf('## Writes Plan mode runs'));
  const served = [...table.matchAll(/^\| `([a-z_]+)` \|(?:[^|]*\|){7}\s*([a-z_+]+)\s*\|/gm)]
    .filter(([, , mcp]) => mcp !== 'absent' && mcp !== 'engine')
    .map(([, tool]) => `mcp__orbit__${tool}`);
  assert.ok(served.length > 100, `read ${served.length} tools off the catalogue`);
  const denied = scheduleRunDisallowedTools([], 'CHECK_ONLY', 'claude');
  for (const tool of served) {
    assert.ok(CHECK_ONLY_CLAUDE_ALLOWED_TOOLS.includes(tool) !== denied.includes(tool), `${tool}: allowed xor denied`);
  }
  for (const tool of CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS) assert.ok(served.includes(tool), `${tool} is served`);
  for (const tool of ['bg_run', 'bg_kill', 'task_update', 'session_merge', 'task_start', 'session_send', 'ask_owner']) {
    assert.ok(denied.includes(`mcp__orbit__${tool}`), tool);
  }
  // permission_prompt is the engine's door for every ask, a shell command's included: never denied.
  assert.ok(!denied.includes('mcp__orbit__permission_prompt'));
});

test('the server answers DENY at once for anything but a shell command a CHECK_ONLY run on Claude Code asks about', () => {
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'mcp__orbit__bg_run', 'mcp__orbit__task_update', 'mcp__docs__write',
    'AskUserQuestion', 'WebFetch', 'Skill']) {
    assert.equal(checkOnlyRefusesApproval('CHECK_ONLY', 'claude', tool, null), true, tool);
    assert.equal(checkOnlyRefusesApproval('CHECK_ONLY', null, tool, ''), true, `${tool}, no engine named`);
  }
  assert.equal(checkOnlyRefusesApproval('CHECK_ONLY', 'claude', 'Bash', null), false, 'a shell command is a card');
  assert.equal(checkOnlyRefusesApproval('CHECK_ONLY', 'claude', 'Bash', 'bgj_1'), true, 'a runner-hosted job\'s shell');
  // Every other run and engine asks as before.
  assert.equal(checkOnlyRefusesApproval('OPEN_PR', 'claude', 'Edit', null), false);
  assert.equal(checkOnlyRefusesApproval(null, 'claude', 'mcp__orbit__bg_run', null), false);
  for (const engine of ['codex', 'kimi', 'opencode', 'antigravity', 'cursor', 'dsh']) {
    assert.equal(checkOnlyRefusesApproval('CHECK_ONLY', engine, 'Shell', null), false, engine);
  }
});

test('a CHECK_ONLY run on Claude Code may not use the file tools, the Orbit CLI or other Orbit tools, whatever allows them', () => {
  const denied = scheduleRunDisallowedTools(['X'], 'CHECK_ONLY', 'claude');
  assert.deepEqual(denied, ['X', ...CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS]);
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
  // The runner allows `Bash(<orbit> <command> *)` for every CLI command, quoted and unquoted; these win over it.
  assert.ok(denied.includes('Bash(*/orbit *)'));
  assert.ok(denied.includes("Bash('*/orbit' *)"));
  assert.deepEqual(scheduleRunDisallowedTools(['X', 'Edit'], 'CHECK_ONLY', 'claude').filter((t) => t === 'Edit'), ['Edit']);
});

test('a run held because the account default is narrower says what to change, inside the item\'s length', () => {
  const clause = heldClause('MODE_WIDER_THAN_ACCOUNT_DEFAULT');
  assert.match(clause, /\(set it to Default in Settings > General\)$/);
  const { why } = heldCopy({
    title: 'Codex stable check',
    reason: 'MODE_WIDER_THAN_ACCOUNT_DEFAULT',
    plannedAt: new Date('2026-11-13T02:00:00Z'),
    agentName: null,
    workspaceName: 'apiserver',
    now: new Date('2026-11-13T03:00:00Z'),
    timezone: 'Asia/Shanghai',
  });
  assert.equal(
    why,
    `It could not start on Friday 10:00: ${clause}. Nothing runs until your default mode allows it and you resume.`,
    'the item is not cut short by the push\'s 180-character body',
  );
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
