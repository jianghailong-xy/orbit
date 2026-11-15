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
 * Claude Code is the exception for CHECK_ONLY: it runs in Default, not Plan. Its headless Plan never permission-checks
 * Bash, so `touch` and `date > file` ran there (measured on 2.1.325). In Default, with the lists below, its own
 * read-only check still runs `git log`, `ls`, `cat` and `grep` with no ask, and every other shell command asks: the
 * ordinary approval card, which Allow once, Always allow (a workspace rule) or Deny answers, as the owner ruled on
 * 2026-11-15. Nothing but a shell command may ask (`checkOnlyRefusesApproval`): the file tools and the Orbit CLI are
 * denied outright, so is every Orbit tool outside a short allow list (`bg_run` would start a shell outside Claude's
 * check, and the runner answers Claude's prompt for an Orbit tool itself, allowing it outside Plan), and any other
 * tool that asks is answered DENY by the server before it becomes a card. Of the workspace's "Always allow" rules
 * only `Bash(…)` ones are carried (docs/scheduled-tasks-engine-modes.md §7, §9).
 */
import {
  AgentProvider,
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
 *     schedule the run serves and to its envelope (§8.3);
 *   * `notify`, a line in front of the owner;
 *   * reads: tasks, sessions, projects, the wiki and Orbit Files.
 *
 * Absent on purpose: `bg_run` (a shell outside Claude's check), `session_merge`, `task_start`, `task_update`,
 * `session_send`, the create doors and every other Orbit write; `file_upload`, since a report carries links, not files.
 */
export const CHECK_ONLY_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
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
];

/**
 * Every Orbit tool `orbit mcp` serves (docs/operation-catalog.md, MCP column) that CHECK_ONLY_CLAUDE_ALLOWED_TOOLS does
 * not name. Denied by name because Claude Code asks about an Orbit tool its allow rules do not cover, and the runner
 * answers that ask itself (runner-go mcp.go answerOrbitToolPrompt): outside Plan it allows every declared Orbit tool
 * with no card. A deny rule is applied before the ask. schedule-access.spec.ts holds this list to the catalogue.
 */
export const CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS: readonly string[] = [
  'mcp__orbit__agent_create', 'mcp__orbit__agent_delete', 'mcp__orbit__agent_list', 'mcp__orbit__agent_update',
  'mcp__orbit__ask_owner', 'mcp__orbit__bg_kill', 'mcp__orbit__bg_list', 'mcp__orbit__bg_output',
  'mcp__orbit__bg_run', 'mcp__orbit__criterion_check_report', 'mcp__orbit__criterion_check_start',
  'mcp__orbit__criterion_confirm', 'mcp__orbit__criterion_confirmation_withdraw', 'mcp__orbit__file_pin',
  'mcp__orbit__file_upload', 'mcp__orbit__integration_abandon', 'mcp__orbit__integration_observe',
  'mcp__orbit__integration_request_promotion', 'mcp__orbit__integration_retry',
  'mcp__orbit__integration_skip_merge_check', 'mcp__orbit__merge_receipt', 'mcp__orbit__merge_receipts',
  'mcp__orbit__open_item_hand_over', 'mcp__orbit__open_item_resolve', 'mcp__orbit__project_blocker_resolve',
  'mcp__orbit__project_create', 'mcp__orbit__project_crossings', 'mcp__orbit__project_delete',
  'mcp__orbit__project_ensure_coordinator', 'mcp__orbit__project_integration_get',
  'mcp__orbit__project_merge_evidence', 'mcp__orbit__project_request_done', 'mcp__orbit__project_request_start',
  'mcp__orbit__project_send', 'mcp__orbit__project_update', 'mcp__orbit__provider_create',
  'mcp__orbit__provider_delete', 'mcp__orbit__provider_list', 'mcp__orbit__provider_update',
  'mcp__orbit__request_owner_action', 'mcp__orbit__runner_delete', 'mcp__orbit__runner_engine_install',
  'mcp__orbit__runner_engine_install_status', 'mcp__orbit__runner_list', 'mcp__orbit__schedule_create',
  'mcp__orbit__schedule_delete', 'mcp__orbit__schedule_pause', 'mcp__orbit__schedule_resume',
  'mcp__orbit__schedule_run_now', 'mcp__orbit__schedule_run_stop', 'mcp__orbit__schedule_wakeup',
  'mcp__orbit__session_await', 'mcp__orbit__session_complete', 'mcp__orbit__session_create',
  'mcp__orbit__session_delete', 'mcp__orbit__session_end', 'mcp__orbit__session_interrupt',
  'mcp__orbit__session_list', 'mcp__orbit__session_merge', 'mcp__orbit__session_reply', 'mcp__orbit__session_send',
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
  ...CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS,
];

/**
 * The tools the run's session may use without asking. A CHECK_ONLY run on Claude Code gets
 * CHECK_ONLY_CLAUDE_ALLOWED_TOOLS and, of what the claim computed, only the workspace's `Bash(…)` rules: a shell
 * command the owner answered Always allow to does not ask again. Neither the `mcp__orbit__*` wildcard nor a rule for
 * any other tool (Edit, Write, an MCP tool) is kept, and a rule for the whole shell (`Bash`, `Bash(*)`) is not either:
 * it would run every writing command unasked. Every other run keeps what the claim computed.
 */
export function scheduleRunAllowedTools(
  base: string[],
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
): string[] {
  if (!claudeCheckOnly(accessLevel, provider)) return base;
  return [...new Set([...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS, ...base.filter(isNarrowBashRule)])];
}

/** `Bash(git status:*)` yes; `Bash`, `Bash(*)`, `Bash(:*)`, `Edit`, `mcp__orbit__*` no. */
function isNarrowBashRule(token: string): boolean {
  const match = /^Bash\((.*)\)$/s.exec(token);
  return !!match && !/^[\s*:]*$/.test(match[1]);
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
  'mcp__orbit__integration_request_promotion',
  'mcp__orbit__integration_skip_merge_check',
  'Bash(gh pr merge:*)',
  'Bash(gh release:*)',
  'Bash(npm publish:*)',
  'Bash(docker push:*)',
  'Skill(release)',
  'Skill(upgrade)',
];

/** The workspace's own disallowed tools, plus the run's when the session serves a schedule's run. */
export function scheduleRunDisallowedTools(
  base: string[],
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
): string[] {
  if (accessLevel === 'OPEN_PR') return [...new Set([...base, ...OPEN_PR_DISALLOWED_TOOLS])];
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
