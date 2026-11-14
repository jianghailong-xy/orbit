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
 * Claude Code is the exception for CHECK_ONLY: it runs in Don't Ask, not Plan. Its headless Plan never
 * permission-checks Bash, so `touch` and `date > file` ran there (measured on 2.1.325); in Don't Ask its own
 * read-only check still runs `git log`, `ls`, `cat` and `grep`, and refuses every shell command that writes. Don't
 * Ask runs only what an allow rule names, so the run's allow list is short and explicit: no workspace "Always
 * allow" rule (one could cover a writing command or Edit), no `mcp__orbit__*` wildcard (`bg_run` would start a shell
 * outside Claude's check, and Plan's runner gate refused Orbit's writes before), only the Orbit tools a check needs,
 * and WebFetch/WebSearch. The Orbit CLI, which the runner allows by its absolute path for every command it offers,
 * is denied outright (docs/scheduled-tasks-engine-modes.md §7).
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
  if (claudeCheckOnly(level, provider)) return PermissionMode.DONT_ASK;
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

/** Whether this is a CHECK_ONLY run on Claude Code, which runs in Don't Ask with its own tool lists. */
function claudeCheckOnly(level: AccessLevel | null | undefined, provider: string | null | undefined): boolean {
  return level === 'CHECK_ONLY' && (provider ?? AgentProvider.CLAUDE) === AgentProvider.CLAUDE;
}

/**
 * Everything a CHECK_ONLY run on Claude Code may call beyond what Claude Code judges read-only by itself (Read,
 * Grep, Glob, `git log`, `ls`, …). In Don't Ask nothing else runs, so each Orbit tool here is one a check needs:
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
 * What a CHECK_ONLY run on Claude Code may not call, even where an allow rule names it: the file tools, and the
 * Orbit CLI. The runner allows the CLI by its absolute path for every command it offers, writes included
 * (`Bash(/usr/local/bin/orbit task update *)`, quoted and unquoted); a deny rule wins over those. The run reads
 * Orbit through the tools above instead.
 */
export const CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash(*/orbit *)',
  "Bash('*/orbit' *)",
];

/**
 * The tools the run's session may use without asking. A CHECK_ONLY run on Claude Code gets exactly
 * CHECK_ONLY_CLAUDE_ALLOWED_TOOLS: in Don't Ask an allow rule is all that runs a call the engine does not judge
 * read-only, so neither the workspace's rules nor the `mcp__orbit__*` wildcard is kept. Every other run keeps what
 * the claim computed.
 */
export function scheduleRunAllowedTools(
  base: string[],
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
): string[] {
  if (!claudeCheckOnly(accessLevel, provider)) return base;
  return [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS];
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
