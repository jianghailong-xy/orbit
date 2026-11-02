import { ForbiddenException } from '@nestjs/common';
import { AgentProvider, ENGINE_CLI_NAMES, PermissionMode } from '@orbit/shared';

/**
 * How much freedom a run gets when nobody said.
 *
 * The permission posture is a property of the RUN, not of the checkout it happens in: the same
 * directory wants Plan for a risky migration and Auto for a test fix. So the authoritative value
 * is `Session.permissionMode`, and what a workspace used to hold was only the seed for it. That
 * seed now lives on the account (UserPreferences.defaultPermissionMode), one place a user can
 * change instead of one per directory.
 *
 * The floor when neither is set is AUTO — the mode that runs without asking. It is deliberately
 * the *code* default only: migration 0094 backfilled every existing account from the narrowest
 * mode any of its workspaces used, so no one who was being asked for approval silently stopped
 * being asked. New accounts, which have no such history, start here.
 */
export const DEFAULT_PERMISSION_MODE = PermissionMode.AUTO;

/**
 * Tools every session may use without raising an approval card.
 *
 * Only Orbit's own MCP server is on it: it is injected into every session, and under an
 * ask-me mode its tools would otherwise prompt the user to approve Orbit talking to Orbit.
 *
 * This used to be `Workspace.allowedTools`, a per-directory column — but in production not one
 * row ever held anything else: every single one was exactly this list, written by the server on
 * create. A column whose value is a constant is a constant, so it moved here (migration 0094).
 */
export const ALWAYS_ALLOWED_TOOLS = ['mcp__orbit__*'] as const;

/** The subset of a User row this needs; `preferences` is the free-form JSON column. */
export type OwnerPreferences = { preferences?: unknown } | null | undefined;

export function accountDefaultPermissionMode(owner: OwnerPreferences): PermissionMode | undefined {
  const prefs = (owner?.preferences ?? {}) as { defaultPermissionMode?: string };
  const mode = prefs.defaultPermissionMode;
  // Only a value this server still understands: an unknown string (older/newer client, hand-edited
  // row) must fall through to the floor rather than reach a runtime that cannot honour it.
  return (Object.values(PermissionMode) as string[]).includes(mode ?? '')
    ? (mode as PermissionMode)
    : undefined;
}

/** Session intent wins; else the owner's account default; else the floor. */
export function resolvePermissionMode(
  sessionMode: string | null | undefined,
  owner: OwnerPreferences,
): PermissionMode {
  return (
    (sessionMode as PermissionMode | null | undefined) ??
    accountDefaultPermissionMode(owner) ??
    DEFAULT_PERMISSION_MODE
  );
}

/**
 * What a session in each mode may not start. A session that may do less than another may not start
 * that other, or the wider session does for it what it may not do itself. Auto and Bypass start
 * anything, so they are not here.
 *
 * Every comparison is of the STORED mode, on both sides, which is not always what the owner chose:
 * moving a session to a model with no Auto writes Default back onto it (SessionsService.updateConfig).
 */
const WIDER_THAN: Readonly<Partial<Record<string, ReadonlySet<string>>>> = {
  [PermissionMode.PLAN]: new Set([
    PermissionMode.DEFAULT,
    PermissionMode.ACCEPT_EDITS,
    PermissionMode.AUTO,
    PermissionMode.DONT_ASK,
    PermissionMode.BYPASS,
  ]),
  [PermissionMode.DEFAULT]: new Set([PermissionMode.AUTO, PermissionMode.BYPASS]),
  [PermissionMode.ACCEPT_EDITS]: new Set([PermissionMode.AUTO, PermissionMode.BYPASS]),
  [PermissionMode.DONT_ASK]: new Set([PermissionMode.BYPASS]),
};

/** Whether a session in this mode is limited in what it may start. */
export function modeLimitsWhatItStarts(mode: string): boolean {
  return WIDER_THAN[mode] !== undefined;
}

/**
 * Whether a mode, on this engine, does what Bypass does: everything is run, nothing is reviewed, and
 * no sandbox is around it (`derivePermissionSemantics`). Codex takes no allowlist, so its Don't Ask is
 * `danger-full-access` with approvals off; Kimi, OpenCode and Antigravity run Auto as their own
 * allow-everything mode. A mode on an engine nobody has named yet is judged by its name.
 */
function runsAsBypass(mode: string, engine: string | null): boolean {
  if (mode === PermissionMode.DONT_ASK) return engine === AgentProvider.CODEX;
  if (mode === PermissionMode.AUTO) {
    return engine === AgentProvider.KIMI || engine === AgentProvider.OPENCODE || engine === AgentProvider.ANTIGRAVITY;
  }
  return false;
}

/** The session starting another: its stored mode and its engine. */
export interface SessionModeStarter {
  mode: string;
  engine: string | null;
}

/**
 * The one comparison. What a child may do is judged by what it will really do on its engine, and what
 * its starter may start by the starter's stored mode. A Codex session in Don't Ask starting another is
 * the one exception: the two are the same thing, so neither is wider.
 */
export function isWiderThanStarter(starter: SessionModeStarter, mode: string, engine: string | null): boolean {
  const wider = WIDER_THAN[starter.mode];
  if (!wider) return false;
  if (mode === starter.mode && engine !== null && engine === starter.engine) return false;
  return wider.has(runsAsBypass(mode, engine) ? PermissionMode.BYPASS : mode);
}

/** What a session may name for one it starts on this engine, in the order the pickers show them. */
export function modesItMayStart(starter: SessionModeStarter, engine: string | null): PermissionMode[] {
  return Object.values(PermissionMode).filter((mode) => !isWiderThanStarter(starter, mode, engine));
}

export const PERMISSION_MODE_WIDER_THAN_SESSION = 'PERMISSION_MODE_WIDER_THAN_SESSION';

/** The refusal every door answers with: what was asked for, and `next`, the door's own way forward. */
export function widerModeRefusal(
  starterMode: string,
  mode: string,
  engine: string | null,
  next: string,
): ForbiddenException {
  const why = runsAsBypass(mode, engine)
    ? ` On ${ENGINE_CLI_NAMES[engine as AgentProvider]} that mode runs as ${PermissionMode.BYPASS}: nothing is reviewed or sandboxed.`
    : '';
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: PERMISSION_MODE_WIDER_THAN_SESSION,
    message: `This session runs in "${starterMode}", so a session it starts may not run in "${mode}".${why} ${next}`,
  });
}
