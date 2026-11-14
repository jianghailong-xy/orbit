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
 */
import { AgentProvider, PermissionMode, derivePermissionSemantics } from '@orbit/shared';

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
  for (const mode of ACCESS_LEVEL_MODES[level]) {
    const semantics = derivePermissionSemantics(provider, mode);
    // Honoured, and never "allow" for an action nobody pre-approved: an allow-everything mode is wider than both
    // levels, whatever its name.
    if (semantics.honored && semantics.unapproved !== 'allow') return mode;
  }
  return null;
}

/**
 * What an OPEN_PR run may not call (§6.2's *May not* column): merging, which is the person's, and the release and
 * deploy doors. A CHECK_ONLY run needs none: Plan refuses every write already.
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

/** The workspace's own disallowed tools, plus the run's when the session serves an OPEN_PR schedule's run. */
export function scheduleRunDisallowedTools(base: string[], accessLevel: AccessLevel | null | undefined): string[] {
  if (accessLevel !== 'OPEN_PR') return base;
  return [...new Set([...base, ...OPEN_PR_DISALLOWED_TOOLS])];
}
