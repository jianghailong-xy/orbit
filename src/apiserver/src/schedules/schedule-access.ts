/**
 * What a run's access level becomes on the engine that runs it (docs/scheduled-tasks-design.md §6.2, §12).
 *
 * A level is a claim made to the person on the card, so it is enforced rather than prompted: the run's session gets
 * a permission mode, and for OPEN_PR a list of tools it may not call. The mode is resolved per engine through
 * `derivePermissionSemantics` (permissionSemantics.ts), the same table every client describes a mode with:
 *
 *   * each level has its modes in order, the wanted one first and then the nearest one that is not wider;
 *   * the first mode the engine honours is the one the run gets;
 *   * when the engine honours none of them, the level is not enforceable there: `schedule_create` is refused
 *     SCHEDULE_ACCESS_NOT_ENFORCEABLE, and a run that would start on it is HELD.
 *
 * CHECK_ONLY falls back from Plan to Don't Ask: both refuse an unapproved write without asking, and on DeepSeek
 * Harness Don't Ask is its read-only file sandbox. OPEN_PR falls back from Accept Edits to Default, which asks
 * before every edit instead of allowing those in the worktree. The table this gives, and what was measured on the
 * real CLIs, is §6.2's and §12's in the design.
 *
 * Claude Code is the exception for CHECK_ONLY: its level resolves to Default, not Plan, since its headless Plan never
 * permission-checks Bash (`touch` and `date > file` ran there, measured on 2.1.325). Every run on Claude Code, whatever
 * its level, is then claimed in Auto (`scheduleRunPermissionMode`, owner 2026-11-18). What a check may not do is
 * denied rather than asked: the file tools and the Orbit CLI outright, every Orbit tool outside a short allow list
 * (`bg_run` would start a shell outside Claude's check), and any tool but a shell command that still asks is answered
 * DENY by the server before it becomes a card (`checkOnlyRefusesApproval`). Of the workspace's "Always allow" rules only
 * exact commands a scheduled run's card approved are matched by the server (`checkOnlyRuleCoversApproval`).
 * A run is held to the level it started with (`runAccessLevel`). The runner closes the rest for a claim with
 * `scheduledCheckOnly` (runner-go schedule_check_only.go): every Orbit tool prompt refused, the CLI denied by its own
 * path, no settings file loaded (docs/scheduled-tasks-engine-modes.md §7, §9, §10).
 */
import {
  AgentProvider,
  bashCommandRules,
  bashPrefix,
  bashSegments,
  CURSOR_PERMISSION_MODES,
  DSH_PERMISSION_MODES,
  PermissionMode,
  derivePermissionSemantics,
} from '@orbit/shared';

import type { AccessLevel } from './schedule-envelope';

export const SCHEDULE_ACCESS_NOT_ENFORCEABLE = 'SCHEDULE_ACCESS_NOT_ENFORCEABLE';

/** Each level's modes, the wanted one first, then the nearest that is not wider. */
export const ACCESS_LEVEL_MODES: Readonly<Record<AccessLevel, readonly PermissionMode[]>> = {
  CHECK_ONLY: [PermissionMode.PLAN, PermissionMode.DONT_ASK],
  OPEN_PR: [PermissionMode.ACCEPT_EDITS, PermissionMode.DEFAULT],
  LAND: [PermissionMode.ACCEPT_EDITS, PermissionMode.DEFAULT],
};

/**
 * The mode a run at `level` gets on `engine`, or null when the engine can enforce none of the level's modes. An
 * engine nobody named (null) is judged as Claude Code, the engine a session that names none starts on.
 */
export function scheduleRunMode(level: AccessLevel, engine: string | null | undefined): PermissionMode | null {
  const provider = engine ?? AgentProvider.CLAUDE;
  if (claudeCheckOnly(level, provider)) return PermissionMode.DEFAULT;
  for (const mode of ACCESS_LEVEL_MODES[level]) {
    // A mode the engine refuses at session admission is no mode at all there.
    if (provider === AgentProvider.DSH && !DSH_PERMISSION_MODES.includes(mode)) continue;
    if (provider === AgentProvider.CURSOR && !CURSOR_PERMISSION_MODES.includes(mode)) continue;
    const semantics = derivePermissionSemantics(provider, mode);
    // Never "allow" for an action nobody pre-approved: an allow-everything mode is wider than both levels, whatever
    // its name.
    if (semantics.unapproved === 'allow') continue;
    if (semantics.honored) return mode;
    // CHECK_ONLY only: a mode that refuses every unapproved action is not wider, even where the engine cannot ask
    // as the mode would (OpenCode's Plan: reads run, fetches and commands are refused; measured, design §12).
    if (level === 'CHECK_ONLY' && semantics.unapproved === 'deny') return mode;
  }
  return null;
}

/** Whether this is a CHECK_ONLY run on Claude Code, which runs in Default with its own tool lists. */
function claudeCheckOnly(level: AccessLevel | null | undefined, provider: string | null | undefined): boolean {
  return level === 'CHECK_ONLY' && (provider ?? AgentProvider.CLAUDE) === AgentProvider.CLAUDE;
}

/**
 * Everything a CHECK_ONLY run on Claude Code may call beyond what Claude Code judges read-only by itself (Read,
 * Grep, Glob, `git log`, `ls`, …) without asking. Each Orbit tool here is one a check needs:
 *
 *   * the run's own schedule: report the run, read it, and change or end it, which the server already holds to the
 *     schedule the run serves and to its envelope (§8.3), and read the condition a WHEN rule's run was started by
 *     (`condition_get`, docs/condition-triggers-design.md §8);
 *   * `notify`, a line in front of the owner;
 *   * reads: tasks, sessions, projects, the wiki and Documents;
 *   * the guide, which reads the operation catalogue and asks the server nothing.
 *
 * Absent on purpose: `bg_run` (a shell outside Claude's check), `session_merge`, `task_start`, `task_update`,
 * `session_send`, the create doors and every other Orbit write; `file_upload`, since a report carries links, not files;
 * and the Files drive's tools, which a check has no use for.
 */
export const CHECK_ONLY_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  'mcp__orbit__schedule_run_report',
  'mcp__orbit__schedule_get',
  'mcp__orbit__schedule_list',
  'mcp__orbit__condition_get',
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
  'mcp__orbit__wiki_read',
  'mcp__orbit__file_fetch',
  'mcp__orbit__file_list',
  'mcp__orbit__browser_status',
  'mcp__orbit__guide',
  'WebFetch',
  'WebSearch',
];

/**
 * Every Orbit tool `orbit mcp` serves (docs/operation-catalog.md, MCP column) that CHECK_ONLY_CLAUDE_ALLOWED_TOOLS does
 * not name. Denied by name because Claude Code asks about an Orbit tool its allow rules do not cover, and the runner
 * answers that ask itself (runner-go mcp.go answerOrbitToolPrompt): outside Plan it allows every declared Orbit tool
 * with no card. A deny rule is applied before the ask. schedule-access.spec.ts holds this list to the catalogue.
 */
export const CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS: readonly string[] = [
  'mcp__orbit__agent_create', 'mcp__orbit__agent_delete', 'mcp__orbit__agent_list', 'mcp__orbit__agent_update',
  'mcp__orbit__browser_clear_logins',
  'mcp__orbit__ask_owner', 'mcp__orbit__bg_kill', 'mcp__orbit__bg_list', 'mcp__orbit__bg_output',
  'mcp__orbit__drive_delete', 'mcp__orbit__drive_get', 'mcp__orbit__drive_list', 'mcp__orbit__drive_move',
  'mcp__orbit__drive_put', 'mcp__orbit__drive_sync',
  'mcp__orbit__bg_run', 'mcp__orbit__browser_open', 'mcp__orbit__criterion_check_report', 'mcp__orbit__criterion_check_start',
  'mcp__orbit__criterion_confirm', 'mcp__orbit__criterion_confirmation_withdraw', 'mcp__orbit__file_pin',
  'mcp__orbit__file_upload', 'mcp__orbit__integration_abandon', 'mcp__orbit__integration_observe',
  'mcp__orbit__integration_request_promotion', 'mcp__orbit__integration_retry',
  'mcp__orbit__integration_skip_merge_check', 'mcp__orbit__merge_receipt', 'mcp__orbit__merge_receipts',
  'mcp__orbit__open_item_hand_over', 'mcp__orbit__open_item_resolve', 'mcp__orbit__project_blocker_resolve',
  'mcp__orbit__project_create', 'mcp__orbit__project_crossings', 'mcp__orbit__project_delete',
  'mcp__orbit__project_ensure_coordinator', 'mcp__orbit__project_integration_get',
  'mcp__orbit__project_merge_evidence', 'mcp__orbit__project_request_done', 'mcp__orbit__project_request_reopen',
  'mcp__orbit__project_request_start',
  'mcp__orbit__project_ruling_record',
  'mcp__orbit__project_send', 'mcp__orbit__project_update', 'mcp__orbit__provider_create',
  'mcp__orbit__provider_delete', 'mcp__orbit__provider_list', 'mcp__orbit__provider_update',
  'mcp__orbit__request_owner_action', 'mcp__orbit__runner_delete', 'mcp__orbit__runner_engine_install',
  'mcp__orbit__runner_engine_install_status', 'mcp__orbit__runner_list', 'mcp__orbit__schedule_create',
  'mcp__orbit__schedule_delete', 'mcp__orbit__schedule_pause', 'mcp__orbit__schedule_resume',
  'mcp__orbit__schedule_run_now', 'mcp__orbit__schedule_run_stop', 'mcp__orbit__schedule_wakeup',
  'mcp__orbit__session_await', 'mcp__orbit__session_complete', 'mcp__orbit__session_create',
  'mcp__orbit__session_delete', 'mcp__orbit__session_end', 'mcp__orbit__session_interrupt',
  'mcp__orbit__session_list', 'mcp__orbit__session_merge', 'mcp__orbit__session_move', 'mcp__orbit__session_reply',
  'mcp__orbit__session_send', 'mcp__orbit__settings_get', 'mcp__orbit__settings_propose', 'mcp__orbit__subagent_rate',
  'mcp__orbit__task_attribution', 'mcp__orbit__task_await', 'mcp__orbit__task_batch_pin', 'mcp__orbit__task_comment',
  'mcp__orbit__task_confirmation_return', 'mcp__orbit__task_confirmation_review', 'mcp__orbit__task_create',
  'mcp__orbit__task_create_batch', 'mcp__orbit__task_delete', 'mcp__orbit__task_dependency_add',
  'mcp__orbit__task_dependency_graph', 'mcp__orbit__task_dependency_remove', 'mcp__orbit__task_evidence_decide',
  'mcp__orbit__task_evidence_list', 'mcp__orbit__task_evidence_submit', 'mcp__orbit__task_labels',
  'mcp__orbit__task_progress_report', 'mcp__orbit__task_reopen', 'mcp__orbit__task_request_confirmation',
  'mcp__orbit__task_start', 'mcp__orbit__task_update', 'mcp__orbit__tasklist_create', 'mcp__orbit__tasklist_delete',
  'mcp__orbit__tasklist_get', 'mcp__orbit__tasklist_list', 'mcp__orbit__tasklist_propose_dag',
  'mcp__orbit__tasklist_update', 'mcp__orbit__watch_cancel', 'mcp__orbit__watch_create', 'mcp__orbit__watch_get',
  'mcp__orbit__watch_list', 'mcp__orbit__watch_update', 'mcp__orbit__wiki_draft', 'mcp__orbit__wiki_note',
  'mcp__orbit__wiki_propose', 'mcp__orbit__withdraw_owner_request',
  // Served by `orbit mcp` beside the catalogue (runner-go subagent.go): it starts a SubAgent, work outside this check.
  'mcp__orbit__delegate',
  // Served beside it (runner-go subagent_workflow.go): it starts SubAgents from a script, work outside this check.
  'mcp__orbit__workflow',
  // Puts a sign-in card in front of the owner and waits for it (runner-go browser_tools.go): not a check's to ask.
  'mcp__orbit__browser_request_sign_in',
];

/**
 * Every Claude Code built-in tool a check does not use, by name (2.1.325's set). Some act with no permission ask in Default
 * and Don't Ask alike (measured, docs/scheduled-tasks-engine-modes.md §10): EnterWorktree created a git worktree,
 * CronCreate scheduled a recurring prompt, and in Don't Ask Monitor ran `touch` and Workflow ran a SubAgent that wrote a
 * file. EnterPlanMode among them: Plan entered by the engine itself would hold back the run's own report (in Plan Claude
 * Code asks about every Orbit tool not marked read-only, and such a run's runner refuses each such ask). A runner
 * advertising CLAUDE_SCHEDULED_CHECK_ONLY_ASKS_V1 also offers such a run only the built-ins a check uses (--tools
 * Bash,Read,Grep,Glob,WebFetch,WebSearch,ToolSearch), which holds for a built-in a later Claude Code adds; this list
 * holds the known ones on any runner.
 */
export const CHECK_ONLY_CLAUDE_DENIED_BUILTINS: readonly string[] = [
  'Agent', 'AskUserQuestion', 'BashOutput', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'EnterPlanMode',
  'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'KillShell', 'ListAgents', 'Monitor', 'PushNotification',
  'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'SendToProject', 'SendToProjectContext', 'Skill',
  'Task', 'Workflow',
];

/**
 * What a CHECK_ONLY run on Claude Code may not call, even where an allow rule names it: the file tools, the Orbit CLI
 * and the Orbit tools outside its allow list. The runner allows the CLI by its absolute path for every command it
 * offers, writes included (`Bash(/usr/local/bin/orbit task update *)`, quoted and unquoted), and a workspace rule may
 * name it too; a deny rule wins over both. The run reads Orbit through the allowed tools instead.
 */
export const CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash(*/orbit *)',
  "Bash('*/orbit' *)",
  ...CHECK_ONLY_CLAUDE_DENIED_BUILTINS,
  ...CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS,
];

/**
 * The permission mode the claim hands the runner, and a scheduled run's SubAgents get: Auto for every run on Claude
 * Code, whatever its level (owner 2026-11-18: "scheduled runs use Auto", all schedules), so that no command an
 * unattended run needs waits on a card nobody is there to answer. Measured 2026-11-17, a LAND run waited 278 minutes
 * on them and timed out; on 2026-11-18 an OPEN_PR run's SubAgent, which then took the session's stored mode, waited
 * 2 hours on one. The level's denials still hold: Claude's --disallowedTools (scheduleRunDisallowedTools) and the
 * server doors (scheduleRunDeniesApproval, checkOnlyRefusesApproval) refuse them in every mode. Claude only: no other
 * engine's Auto has a classifier (permissionSemantics.ts), so every other engine keeps the session's mode. On a model
 * with no Auto the run's engine starts in Default and says so (the claim hands it Auto all the same,
 * queue/claim-permission-mode.ts); a SubAgent's mode is still normalized (normalizeBuiltinPermissionMode).
 */
export function scheduleRunPermissionMode(
  mode: PermissionMode,
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
): PermissionMode {
  if (accessLevel && (provider ?? AgentProvider.CLAUDE) === AgentProvider.CLAUDE) return PermissionMode.AUTO;
  return mode;
}

/**
 * The level a run's session is held to: the one the run started with (`schedule_run.access_level`, migration 0860),
 * so moving the schedule to OPEN_PR, or deleting it, while a check runs does not widen that check. The schedule's own
 * level only for a run started before 0860 recorded it.
 */
export function runAccessLevel(
  run: { accessLevel: AccessLevel | null; schedule?: { accessLevel: AccessLevel } | null } | null | undefined,
): AccessLevel | null {
  return run ? run.accessLevel ?? run.schedule?.accessLevel ?? null : null;
}

/** A workspace rule as the claim reads it: the stored row, with where it came from. */
export type CarriedRule = { toolName: string; ruleContent: string; fromScheduleRun?: boolean };

/**
 * The tools the run's session may use without asking. A CHECK_ONLY run on Claude Code gets
 * CHECK_ONLY_CLAUDE_ALLOWED_TOOLS. Its exact-command standing grants are matched at the approval door; none are
 * exported as engine patterns. Every other run keeps what the claim computed.
 */
export function scheduleRunAllowedTools(
  base: string[],
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
  rules: readonly CarriedRule[] = [],
  runnerCapabilities: readonly string[] | null | undefined = [],
): string[] {
  if (!claudeCheckOnly(accessLevel, provider)) return base;
  // Commands are matched literally by the approval door, never parsed as Claude permission patterns.
  // This also stops old prefix grants from earlier scheduled cards reaching the engine.
  return [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS];
}

/** Refused when a client asks to remember anything other than the card's command. */
export const SCHEDULE_CHECK_ONLY_RULE_REFUSED = 'SCHEDULE_CHECK_ONLY_RULE_REFUSED';

/** The complete command, including quotes, whitespace and shell syntax, is one literal grant. */
export function checkOnlyCommandRules(card: { toolName: string; input: unknown }): { toolName: string; ruleContent: string }[] {
  const command = (card.input as { command?: unknown } | null)?.command;
  return card.toolName === 'Bash' && typeof command === 'string' && command.trim()
    ? [{ toolName: 'Bash', ruleContent: command }]
    : [];
}

/**
 * Older clients send prefixes; accept those only as a request to remember this card's exact command. That
 * includes the plain per-segment prefixes clients derived before they stopped remembering interpreters and
 * file-changing programs (`python3:*`): only the exact command is ever written.
 */
export function checkOnlyRuleRefusal(
  card: { toolName: string; input: unknown },
  rules: readonly { toolName: string; ruleContent?: string }[],
): string | null {
  const exact = checkOnlyCommandRules(card);
  const command = exact[0]?.ruleContent ?? '';
  const legacy = bashSegments(command).flatMap((segment) => {
    const prefix = bashPrefix(segment);
    return prefix ? [{ toolName: 'Bash', ruleContent: `${prefix}:*` }] : [];
  });
  const given = [...exact, ...bashCommandRules(command), ...legacy];
  for (const rule of rules) {
    if (exact.length && rule.toolName === 'Bash' && given.some((g) => g.ruleContent === rule.ruleContent)) continue;
    return `Always allow on a scheduled check's card covers only this exact command (${exact[0]?.ruleContent ?? 'nothing'}). Nothing was written.`;
  }
  return null;
}

/** Literal comparison avoids wildcard/prefix interpretation, even for commands containing '*' or ':*'. */
export function checkOnlyRuleCoversApproval(card: { toolName: string; input: unknown }, rules: readonly CarriedRule[]): boolean {
  const command = checkOnlyCommandRules(card)[0]?.ruleContent;
  const env = (card.input as { env?: unknown } | null)?.env;
  if (!command || (env != null && (typeof env !== 'object' || Object.keys(env).length > 0))) return false;
  return rules.some((r) => r.fromScheduleRun === true && r.toolName === 'Bash' && r.ruleContent === command);
}

/** What the engine reads when the server refuses such a request (checkOnlyRefusesApproval). */
export const CHECK_ONLY_REFUSED_MESSAGE =
  'Not run: this is a check-only scheduled run, which may ask only to run a shell command. Nothing was written. '
  + 'Read with the tools you have, and say in your report what you could not check.';

/**
 * Whether the server answers a permission request DENY at once instead of filing it as a card: a CHECK_ONLY run on
 * Claude Code may ask only about a shell command its engine runs. Any other tool (an MCP tool, a SubAgent's question,
 * a tool the deny list missed) and a shell command a runner-hosted job asks about (`bg_run` is the shell outside
 * Claude's check) never become a card, a Waiting on you item or a push, so pressing a card can never grant one.
 */
export function checkOnlyRefusesApproval(
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
  toolName: string,
  backgroundJobId: string | null | undefined,
): boolean {
  if (!claudeCheckOnly(accessLevel, provider)) return false;
  return toolName !== 'Bash' || !!backgroundJobId?.trim();
}

/**
 * What an OPEN_PR run may not call (§6.2's *May not* column): merging, which is the person's, and the release and
 * deploy doors. A CHECK_ONLY run gets none on an engine whose mode refuses edits itself; on Claude Code it gets
 * CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS.
 */
export const OPEN_PR_DISALLOWED_TOOLS: readonly string[] = [
  'mcp__orbit__session_merge',
  'mcp__orbit__integration_*',
  'mcp__orbit__integration_request_promotion',
  'mcp__orbit__integration_skip_merge_check',
  'Bash(gh pr merge:*)',
  'Bash(git push * main)',
  'Bash(git push * main:*)',
  'Bash(git push * *:main)',
  'Bash(git push * *:refs/heads/main)',
  'Bash(gh release:*)',
  'Bash(npm publish:*)',
  'Bash(docker push:*)',
  'Skill(release)',
  'Skill(upgrade)',
];

/** Match level denials at the server door, regardless of the engine asking. */
export function scheduleRunDeniesApproval(
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
  toolName: string,
  input: unknown,
): boolean {
  const card = input as { command?: unknown; skill?: unknown } | null;
  const glob = (pattern: string, value: string) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(value);
  };
  const commands = (command: string): string[] => bashSegments(command).flatMap((segment) => {
    // Codex sends argv as a shell-quoted command, e.g. /bin/bash -lc 'gh pr merge 12'.
    const wrapper = segment.trim().match(/^(?:\/[^\s]+\/)?(?:bash|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/);
    if (!wrapper) return [segment.trim()];
    const inner = wrapper[1] === "'"
      ? wrapper[2].replace(/'\\''/g, "'")
      : wrapper[2].replace(/\\(["\\$`])/g, '$1');
    return commands(inner);
  });
  return scheduleRunDisallowedTools([], accessLevel, provider).some((rule) => {
    const scoped = rule.match(/^([^()]+)\((.*)\)$/);
    if (!scoped) return glob(rule, toolName);
    const [, tool, content] = scoped;
    if (tool === 'Bash' && (toolName === 'Bash' || toolName === 'Terminal')) {
      if (typeof card?.command !== 'string') return false;
      return commands(card.command).some((command) => content.endsWith(':*')
        ? glob(content.slice(0, -2), command) || glob(`${content.slice(0, -2)} *`, command)
        : glob(content, command));
    }
    return tool === toolName && typeof card?.skill === 'string' && glob(content, card.skill);
  });
}

/** The workspace's own disallowed tools, plus the run's when the session serves a schedule's run. */
export function scheduleRunDisallowedTools(
  base: string[],
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
): string[] {
  if (accessLevel === 'OPEN_PR' || accessLevel === 'LAND') return [...new Set([...base, ...OPEN_PR_DISALLOWED_TOOLS])];
  // The full list on every runner: Auto runs what it is not denied, so every Orbit write is denied by name.
  if (claudeCheckOnly(accessLevel, provider)) return [...new Set([...base, ...CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS])];
  return base;
}

/**
 * What the claim adds to the agent config of a session serving a schedule's run. `scheduledCheckOnly` tells the
 * runner that this Plan session is a CHECK_ONLY run, which on Codex then runs in Codex's own read-only sandbox with
 * no approvals, so it can read the checkout (design §6.2; record §8). Absent on every other session, and an older
 * runner ignores it: both keep Codex's ordinary Plan, which declines every command.
 */
export function scheduleRunAgentFields(accessLevel: AccessLevel | null | undefined): { scheduledCheckOnly?: true } {
  return accessLevel === 'CHECK_ONLY' ? { scheduledCheckOnly: true } : {};
}
