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
 * read-only check still runs `git log`, `ls`, `cat` and `grep`, and refuses every shell command that writes. The run
 * keeps no workspace "Always allow" rule (one could cover a writing command or Edit), may fetch with WebFetch and
 * WebSearch, and may not use the file tools or Orbit's create doors, which Plan's own gate refused before
 * (docs/scheduled-tasks-engine-modes.md §7).
 */
import {
  AgentProvider,
  CURSOR_PERMISSION_MODES,
  DSH_PERMISSION_MODES,
  PermissionMode,
  derivePermissionSemantics,
} from '@orbit/shared';

import { ALWAYS_ALLOWED_TOOLS } from '../common/permission-mode';

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

/** What a CHECK_ONLY run on Claude Code may use without asking, beyond Orbit's own tools: fetching a URL. */
export const CHECK_ONLY_CLAUDE_ALLOWED_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];

/**
 * What a CHECK_ONLY run on Claude Code may not call: the file tools, and Orbit's create doors as MCP tools and as
 * the Orbit CLI, which the runner otherwise allows (`Bash(<orbit> task create *)`; a deny rule wins over it).
 */
export const CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'mcp__orbit__task_create',
  'mcp__orbit__task_create_batch',
  'mcp__orbit__project_create',
  'mcp__orbit__session_create',
  'Bash(* task create *)',
  'Bash(* task create-batch *)',
  'Bash(* project create *)',
  'Bash(* session create *)',
];

/**
 * The tools the run's session may use without asking. A CHECK_ONLY run on Claude Code gets Orbit's own tools and
 * WebFetch/WebSearch only: in Don't Ask an allow rule is all that runs a call the engine does not judge read-only,
 * so the workspace's rules are left out. Every other run keeps what the claim computed.
 */
export function scheduleRunAllowedTools(
  base: string[],
  accessLevel: AccessLevel | null | undefined,
  provider: string | null | undefined,
): string[] {
  if (!claudeCheckOnly(accessLevel, provider)) return base;
  return [...ALWAYS_ALLOWED_TOOLS, ...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS];
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
