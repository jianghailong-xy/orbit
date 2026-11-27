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
 * Every runtime keeps it, each its own way (docs/permission-matrix.md): Claude Code and Kimi are
 * handed it as an allow rule, Cursor CLI and Antigravity answer their own permission requests from
 * it, and Codex, which takes no allowlist, has the runner consent to each Orbit tool by its name.
 * The rule takes the engine's own prompt away and nothing else: what a call may then do is still
 * Orbit's to say — a write that needs the owner files its own card in every mode, and in Plan every
 * write is refused by the runner's Plan gate (runner-go plan_gate.go).
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
 * The mode a session STARTING or REACHING another is judged by (owner ruling R3): the mode its engine is actually
 * running in (session.actual_permission_mode, sessions/actual-permission-mode.ts), not the stored intent.
 *
 * The fallback, when no actual mode is recorded, is the stored mode resolved against the account default. Only a
 * session claimed before migration 1755 that has not been claimed since has none: every claim records the mode it
 * hands the runner, and a session that is calling has been claimed. For those few the stored mode is what their
 * claim handed the runner except where a model lacked Auto, and it is the comparison these rules made before R3, so
 * nothing they could do yesterday is refused or newly allowed by the fallback.
 */
export function runningPermissionMode(
  session: { permissionMode: string | null; actualPermissionMode?: string | null },
  owner: OwnerPreferences,
): PermissionMode {
  const actual = session.actualPermissionMode;
  if (actual && (Object.values(PermissionMode) as string[]).includes(actual)) return actual as PermissionMode;
  return resolvePermissionMode(session.permissionMode, owner);
}

/**
 * What a session in each mode may not start. A session that may do less than another may not start
 * that other, or the wider session does for it what it may not do itself. Auto and Bypass start
 * anything, so they are not here.
 *
 * The starting (or reaching) side is compared by the mode it is actually running in (runningPermissionMode, R3);
 * the side being started or reached by the mode it is asked to run in, or its stored intent, which is what its next
 * turn is handed.
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

/** The session starting another: the mode it is actually running in (runningPermissionMode) and its engine. */
export interface SessionModeStarter {
  mode: string;
  engine: string | null;
}

/**
 * The one comparison. What a child may do is judged by what it will really do on its engine, and what
 * its starter may start by the mode the starter is actually running in (R3). A Codex session in Don't Ask starting another is
 * the one exception: the two are the same thing, so neither is wider.
 */
export function isWiderThanStarter(starter: SessionModeStarter, mode: string, engine: string | null): boolean {
  const wider = WIDER_THAN[starter.mode];
  if (!wider) return false;
  if (mode === starter.mode && engine !== null && engine === starter.engine) return false;
  return wider.has(runsAsBypass(mode, engine) ? PermissionMode.BYPASS : mode);
}

/**
 * A SubAgent's rule (docs/subagent-design.md §5.3): never wider than its parent, with no exemption. The order
 * is isWiderThanStarter's, but an Auto parent is held to it too — its SubAgent may not run Bypass, nor a mode
 * that runs as Bypass on the child's engine. Only a Bypass parent's may run anything. Sessions starting
 * sessions keep isWiderThanStarter's rule.
 */
export function isWiderThanParent(parent: SessionModeStarter, mode: string, engine: string | null): boolean {
  if (parent.mode === PermissionMode.BYPASS) return false;
  if (parent.mode !== PermissionMode.AUTO) return isWiderThanStarter(parent, mode, engine);
  if (mode === parent.mode && engine !== null && engine === parent.engine) return false;
  return (runsAsBypass(mode, engine) ? PermissionMode.BYPASS : mode) === PermissionMode.BYPASS;
}

/**
 * The mode a SubAgent runs in (docs/subagent-design.md §5.3): the one its definition names when that is not wider
 * than the parent's, else the parent's — on every engine, read-only or not. A read-only child is not narrowed to
 * Plan: the runner keeps it read-only on its engine and answers what it asks the way the parent's mode does. An
 * engine that cannot hold the mode gets the nearest one it holds that is not wider: DeepSeek Harness has no Plan,
 * Accept Edits or Bypass, and Cursor CLI no Default (assertDshPermissionMode, assertCursorPermissionMode).
 */
export function subagentChildMode(
  parentMode: PermissionMode,
  child: { readonly?: boolean; asked?: string | null },
  engine: string,
): PermissionMode {
  const mode = !child.readonly && child.asked ? (child.asked as PermissionMode) : parentMode;
  return SUBAGENT_NEAREST_MODE[engine]?.[mode] ?? mode;
}

/** Per engine, the mode it cannot hold and the nearest one it holds that is not wider. */
const SUBAGENT_NEAREST_MODE: Readonly<Record<string, Partial<Record<string, PermissionMode>>>> = {
  [AgentProvider.DSH]: {
    [PermissionMode.PLAN]: PermissionMode.DONT_ASK,
    [PermissionMode.ACCEPT_EDITS]: PermissionMode.DEFAULT,
    [PermissionMode.BYPASS]: PermissionMode.AUTO,
  },
  [AgentProvider.CURSOR]: {
    [PermissionMode.DEFAULT]: PermissionMode.PLAN,
  },
};

/** What a SubAgent of this parent may run in on this engine (isWiderThanParent), in the pickers' order. */
export function modesASubagentMayRunIn(parent: SessionModeStarter, engine: string | null): PermissionMode[] {
  return Object.values(PermissionMode).filter((mode) => !isWiderThanParent(parent, mode, engine));
}

/** What a session may name for one it starts on this engine, in the order the pickers show them. */
export function modesItMayStart(starter: SessionModeStarter, engine: string | null): PermissionMode[] {
  return Object.values(PermissionMode).filter((mode) => !isWiderThanStarter(starter, mode, engine));
}

export const PERMISSION_MODE_WIDER_THAN_SESSION = 'PERMISSION_MODE_WIDER_THAN_SESSION';

/** What a mode comes to on an engine that runs it as Bypass, said after the sentence naming it. */
export function whatItRunsAs(mode: string, engine: string | null): string {
  return runsAsBypass(mode, engine)
    ? ` On ${ENGINE_CLI_NAMES[engine as AgentProvider]} that mode runs as ${PermissionMode.BYPASS}: nothing is reviewed or sandboxed.`
    : '';
}

/** The refusal every door answers with: what was asked for, and `next`, the door's own way forward. */
export function widerModeRefusal(
  starterMode: string,
  mode: string,
  engine: string | null,
  next: string,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: PERMISSION_MODE_WIDER_THAN_SESSION,
    message: `This session runs in "${starterMode}", so a session it starts may not run in "${mode}".${whatItRunsAs(mode, engine)} ${next}`,
  });
}

export const SESSION_WIDER_THAN_CALLER = 'SESSION_WIDER_THAN_CALLER';

/**
 * The same refusal for a session that already exists (sessions/session-reach.ts): `act` finishes
 * "may not ...", and `next` is what this caller can do instead.
 */
export function widerSessionRefusal(
  callerMode: string,
  target: string,
  mode: string,
  engine: string | null,
  act: string,
  next: string,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: SESSION_WIDER_THAN_CALLER,
    message:
      `This session runs in "${callerMode}", and session ${target} runs in "${mode}", which is wider, so this session may `
      + `not ${act}. Nothing was changed.${whatItRunsAs(mode, engine)} ${next}`,
  });
}
