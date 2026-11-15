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
  checkOnlyRuleRefusal,
  CHECK_ONLY_CLAUDE_DONT_ASK_DISALLOWED_TOOLS,
  CHECK_ONLY_CLAUDE_DENIED_BUILTINS,
  CLAUDE_SCHEDULED_CHECK_ONLY_ASKS_V1,
  OPEN_PR_DISALLOWED_TOOLS,
  scheduleRunAllowedTools,
  scheduleRunDisallowedTools,
  checkOnlyRefusesApproval,
  runAccessLevel,
  scheduleRunMode,
  scheduleRunPermissionMode,
} from './schedule-access';
import { heldClause, heldCopy } from './schedule-attention';

const WORKSPACE_ALLOWED = ['mcp__orbit__*', 'Bash(npm install:*)', 'Edit'];
/** A runner that closes what only it can (runner-go schedule_check_only.go): the asking lists. */
const ASKS = [CLAUDE_SCHEDULED_CHECK_ONLY_ASKS_V1];

test('CHECK_ONLY on Claude Code runs in Default; every other engine and level keeps its mode', () => {
  assert.equal(scheduleRunMode('CHECK_ONLY', 'claude'), PermissionMode.DEFAULT);
  assert.equal(scheduleRunMode('CHECK_ONLY', null), PermissionMode.DEFAULT, 'no engine named is Claude Code');
  assert.equal(scheduleRunMode('OPEN_PR', 'claude'), PermissionMode.ACCEPT_EDITS);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'codex'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'kimi'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'opencode'), PermissionMode.PLAN);
});

test('a CHECK_ONLY run on Claude Code is allowed what a check needs and nothing a person\'s sessions allowed', () => {
  const allowed = scheduleRunAllowedTools(WORKSPACE_ALLOWED, 'CHECK_ONLY', 'claude', [
    { toolName: 'Bash', ruleContent: 'npm install:*' },
    { toolName: 'Edit', ruleContent: '' },
  ], ASKS);
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
  ]);
  assert.deepEqual(allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS], 'Bash(npm install:*) came from an interactive session');
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

test('of the workspace\'s rules a CHECK_ONLY run on Claude Code carries only narrow Bash rules a scheduled card wrote', () => {
  const rules = [
    { toolName: 'Bash', ruleContent: 'npm test:*', fromScheduleRun: true },
    { toolName: 'Bash', ruleContent: 'psql:*', fromScheduleRun: true },
    // A person's interactive sessions wrote these: wider than any scheduled card asked for.
    { toolName: 'Bash', ruleContent: 'python:*', fromScheduleRun: false },
    { toolName: 'Bash', ruleContent: 'git:*' },
    { toolName: 'Bash', ruleContent: 'env:*', fromScheduleRun: false },
    // Never carried, whoever wrote them.
    { toolName: 'Edit', ruleContent: '', fromScheduleRun: true },
    { toolName: 'mcp__orbit__bg_run', ruleContent: '', fromScheduleRun: true },
    { toolName: 'Bash', ruleContent: '', fromScheduleRun: true },
    { toolName: 'Bash', ruleContent: '*', fromScheduleRun: true },
    { toolName: 'Bash', ruleContent: ':*', fromScheduleRun: true },
    { toolName: 'Bash', ruleContent: '/usr/local/bin/orbit task update:*', fromScheduleRun: true },
  ];
  const base = ['mcp__orbit__*', ...rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))];
  const carried = scheduleRunAllowedTools(base, 'CHECK_ONLY', 'claude', rules, ASKS).filter(
    (t) => !CHECK_ONLY_CLAUDE_ALLOWED_TOOLS.includes(t),
  );
  assert.deepEqual(carried, ['Bash(npm test:*)', 'Bash(psql:*)', 'Bash(/usr/local/bin/orbit task update:*)']);
  // A rule for the Orbit CLI is carried, and the deny list still wins over it (measured, record §9).
  assert.ok(scheduleRunDisallowedTools([], 'CHECK_ONLY', 'claude', ASKS).includes('Bash(*/orbit *)'));
  // Only a rule the claim itself put on the list: one its normalization dropped is not carried here either.
  assert.deepEqual(
    scheduleRunAllowedTools(['mcp__orbit__*'], 'CHECK_ONLY', 'claude', [{ toolName: 'Bash', ruleContent: 'ls:*', fromScheduleRun: true }], ASKS),
    [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS],
  );
  // No duplicate when the workspace repeats an allowed tool.
  const twice = scheduleRunAllowedTools(['WebFetch', 'Bash(ls -la:*)'], 'CHECK_ONLY', 'claude', [
    { toolName: 'Bash', ruleContent: 'ls -la:*', fromScheduleRun: true },
    { toolName: 'Bash', ruleContent: 'ls -la:*', fromScheduleRun: true },
  ], ASKS);
  assert.equal(twice.filter((t) => t === 'WebFetch').length, 1);
  assert.equal(twice.filter((t) => t === 'Bash(ls -la:*)').length, 1);
});

test('Always allow on a scheduled check\'s card may write only that card\'s command\'s rules', () => {
  const card = { toolName: 'Bash', input: { command: 'cd db && psql -c "select 1"' } };
  assert.equal(checkOnlyRuleRefusal(card, [{ toolName: 'Bash', ruleContent: 'psql:*' }]), null);
  assert.equal(checkOnlyRuleRefusal(card, [{ toolName: 'Bash', ruleContent: 'cd db:*' }, { toolName: 'Bash', ruleContent: 'psql:*' }]), null);
  for (const rule of [
    { toolName: 'Bash', ruleContent: 'python:*' },
    { toolName: 'Bash', ruleContent: '' },
    { toolName: 'Bash', ruleContent: '*' },
    { toolName: 'Bash', ruleContent: 'psql -c:*' },
    { toolName: 'Edit', ruleContent: '' },
    { toolName: 'mcp__orbit__bg_run', ruleContent: '' },
    { toolName: 'mcp__docs__write', ruleContent: '' },
  ]) {
    assert.match(checkOnlyRuleRefusal(card, [{ toolName: 'Bash', ruleContent: 'psql:*' }, rule]) ?? '', /covers only this card's command \(Bash\(cd db:\*\), Bash\(psql:\*\)\)/, JSON.stringify(rule));
  }
  // A command wrapped in a shell gives no rule at all, and a card for another tool gives none either.
  assert.ok(checkOnlyRuleRefusal({ toolName: 'Bash', input: { command: "bash -c 'touch x'" } }, [{ toolName: 'Bash', ruleContent: 'bash:*' }]));
  assert.ok(checkOnlyRuleRefusal({ toolName: 'Edit', input: { file_path: 'x' } }, [{ toolName: 'Edit', ruleContent: '' }]));
});

test('a run is held to the level it started with; the schedule\'s only for a run started before it was recorded', () => {
  assert.equal(runAccessLevel({ accessLevel: 'CHECK_ONLY', schedule: { accessLevel: 'OPEN_PR' } }), 'CHECK_ONLY');
  assert.equal(runAccessLevel({ accessLevel: 'CHECK_ONLY', schedule: null }), 'CHECK_ONLY');
  assert.equal(runAccessLevel({ accessLevel: null, schedule: { accessLevel: 'OPEN_PR' } }), 'OPEN_PR');
  assert.equal(runAccessLevel(null), null);
  assert.equal(runAccessLevel(undefined), null);
});

test('every Orbit tool orbit mcp serves is allowed or denied by name for a CHECK_ONLY run on Claude Code', () => {
  // The runner answers Claude Code's ask about an Orbit tool itself and allows it outside Plan, so a tool on neither
  // list would run unasked. docs/operation-catalog.md is generated from the runner's catalogue (and checked there).
  const doc = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'operation-catalog.md'), 'utf8');
  const table = doc.slice(0, doc.indexOf('## Writes Plan mode runs'));
  // Every row of the table is read, or the spec fails: a row it skipped would be a tool on neither list.
  const rows = table.split('\n').filter((line) => line.startsWith('| `'));
  const parsed = rows.map((line) => /^\| `([a-z_]+)` \|(?:[^|]*\|){7}\s*([a-z_+]+)\s*\|/.exec(line));
  rows.forEach((line, i) => assert.ok(parsed[i], `a catalogue row this spec cannot read: ${line}`));
  const served = parsed
    .map((m) => [m![1], m![2]] as const)
    .filter(([, mcp]) => mcp !== 'absent' && mcp !== 'engine')
    .map(([tool]) => `mcp__orbit__${tool}`);
  assert.ok(served.length > 100, `read ${served.length} tools off the catalogue`);
  // Served beside the catalogue (runner-go subagent.go); runner-go TestEveryServedOrbitToolIsOnACheckOnlyList checks
  // every tool `orbit mcp` lists, these included, against this file.
  served.push('mcp__orbit__delegate');
  const denied = scheduleRunDisallowedTools([], 'CHECK_ONLY', 'claude', ASKS);
  for (const tool of served) {
    assert.ok(CHECK_ONLY_CLAUDE_ALLOWED_TOOLS.includes(tool) !== denied.includes(tool), `${tool}: allowed xor denied`);
  }
  for (const tool of CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS) assert.ok(served.includes(tool), `${tool} is served`);
  for (const tool of ['bg_run', 'bg_kill', 'task_update', 'session_merge', 'task_start', 'session_send', 'ask_owner', 'delegate']) {
    assert.ok(denied.includes(`mcp__orbit__${tool}`), tool);
  }
  // permission_prompt is the engine's door for every ask, a shell command's included: never denied.
  assert.ok(!denied.includes('mcp__orbit__permission_prompt'));
});

test('the server answers DENY at once for anything but a shell command a CHECK_ONLY run on Claude Code asks about', () => {
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'mcp__orbit__bg_run', 'mcp__orbit__task_update', 'mcp__docs__write',
    'AskUserQuestion', 'WebFetch', 'Skill', 'bash', 'BASH', 'BashOutput', 'Bash ', ' Bash', 'Task', 'Agent',
    'mcp__docs__Bash', 'mcp__Bash__run', 'KillShell', '']) {
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
  const denied = scheduleRunDisallowedTools(['X'], 'CHECK_ONLY', 'claude', ASKS);
  assert.deepEqual(denied, ['X', ...CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS]);
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
  // The runner allows `Bash(<orbit> <command> *)` for every CLI command, quoted and unquoted; these win over it.
  assert.ok(denied.includes('Bash(*/orbit *)'));
  assert.ok(denied.includes("Bash('*/orbit' *)"));
  assert.deepEqual(scheduleRunDisallowedTools(['X', 'Edit'], 'CHECK_ONLY', 'claude', ASKS).filter((t) => t === 'Edit'), ['Edit']);
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
  for (const [file, session, caps] of [
    ['queue/queue.service.ts', 'session', 'session.assignedRunner?.capabilities'],
    ['runner-api/runner-api.controller.ts', 's', 'runner.capabilities'],
  ] as const) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(
      source.includes(`scheduleRunPermissionMode(\n            permissionMode, runAccessLevel(${session}.scheduleRun), provider, ${caps},\n          ),`),
      `${file}: the mode by the claiming runner's capability`,
    );
    const level = `runAccessLevel(${session}.scheduleRun),`;
    assert.ok(
      source.includes(`allowedTools: scheduleRunAllowedTools(\n          dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, workspace?.permissionRules ?? []),\n          ${level}\n          provider,\n          workspace?.permissionRules ?? [],\n          ${caps},\n        ),`),
      `${file}: allowedTools`,
    );
    assert.ok(
      source.includes('scheduleRun: { select: { accessLevel: true, schedule: { select: { accessLevel: true } } } }'),
      `${file}: reads the run's own level`,
    );
    assert.ok(
      source.includes(`disallowedTools: scheduleRunDisallowedTools(\n          (workspace?.disallowedTools as string[] | null) ?? [],\n          ${level}\n          provider,\n          ${caps},\n        ),`),
      `${file}: disallowedTools`,
    );
  }
});

test('a CHECK_ONLY run on Claude Code asks only on a runner that advertises it; any other gets S2b\'s Don\'t Ask exactly', () => {
  const rules = [{ toolName: 'Bash', ruleContent: 'npm test:*', fromScheduleRun: true }];
  const base = ['mcp__orbit__*', 'Bash(npm test:*)'];
  for (const caps of [[], null, undefined, ['claude-account-move/v1']]) {
    assert.equal(scheduleRunPermissionMode(PermissionMode.DEFAULT, 'CHECK_ONLY', 'claude', caps), PermissionMode.DONT_ASK);
    assert.deepEqual(scheduleRunAllowedTools(base, 'CHECK_ONLY', 'claude', rules, caps), [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS],
      'S2b\'s allow list, no rule carried');
    assert.deepEqual(scheduleRunDisallowedTools(['X'], 'CHECK_ONLY', 'claude', caps),
      ['X', 'Edit', 'Write', 'NotebookEdit', 'Bash(*/orbit *)', "Bash('*/orbit' *)", ...CHECK_ONLY_CLAUDE_DENIED_BUILTINS],
      'S2b\'s deny list as it landed, and every built-in a check does not use');
  }
  assert.deepEqual([...CHECK_ONLY_CLAUDE_DONT_ASK_DISALLOWED_TOOLS],
    ['Edit', 'Write', 'NotebookEdit', 'Bash(*/orbit *)', "Bash('*/orbit' *)", ...CHECK_ONLY_CLAUDE_DENIED_BUILTINS]);
  for (const tool of ['EnterWorktree', 'CronCreate', 'Monitor', 'Workflow', 'EnterPlanMode', 'Task', 'Skill']) {
    assert.ok(CHECK_ONLY_CLAUDE_DENIED_BUILTINS.includes(tool), tool);
  }
  for (const tool of ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch']) {
    assert.ok(!CHECK_ONLY_CLAUDE_DENIED_BUILTINS.includes(tool), `${tool} is a check's`);
  }
  // A runner that advertises it: Default, the carried rule, and the full deny list (EnterPlanMode, every other Orbit tool).
  assert.equal(scheduleRunPermissionMode(PermissionMode.DEFAULT, 'CHECK_ONLY', 'claude', ASKS), PermissionMode.DEFAULT);
  assert.deepEqual(scheduleRunAllowedTools(base, 'CHECK_ONLY', 'claude', rules, ASKS), [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS, 'Bash(npm test:*)']);
  const denied = scheduleRunDisallowedTools([], 'CHECK_ONLY', 'claude', ASKS);
  for (const tool of ['EnterPlanMode', 'mcp__orbit__delegate', 'mcp__orbit__bg_run', 'EnterWorktree', 'CronCreate']) {
    assert.ok(denied.includes(tool), tool);
  }
  // Every other run keeps its mode whatever the runner says.
  assert.equal(scheduleRunPermissionMode(PermissionMode.ACCEPT_EDITS, 'OPEN_PR', 'claude', []), PermissionMode.ACCEPT_EDITS);
  assert.equal(scheduleRunPermissionMode(PermissionMode.PLAN, 'CHECK_ONLY', 'codex', []), PermissionMode.PLAN);
  assert.equal(scheduleRunPermissionMode(PermissionMode.DEFAULT, null, 'claude', []), PermissionMode.DEFAULT);
});

test('migration 0860 marks no existing rule: only a CHECK_ONLY card\'s server-computed rules are ever carried', () => {
  const sql = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'migrations', '0860_schedule_check_only_asks', 'migration.sql'), 'utf8',
  );
  const statements = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.match(statements, /ADD COLUMN "from_schedule_run" BOOLEAN NOT NULL DEFAULT false/);
  assert.doesNotMatch(statements, /UPDATE\s+"workspace_permission_rule"/i, 'no backfill marks a rule');
  assert.match(statements, /UPDATE "schedule_run" r\s+SET "access_level"/);
});
