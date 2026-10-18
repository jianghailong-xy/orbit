import {
  AgentProvider,
  decodeCursorModel,
  ENGINE_CLI_NAMES,
  runnerCatalogRow,
  type RunnerEngineHealth,
  type RunnerModelCatalog,
  type RunnerModelInfo,
} from '@orbit/shared';

/**
 * What the clients need to know about Cursor CLI (`cursor`) that no other engine shares, read the way
 * the runner and the server read it (docs/cursor-runtime-contract.md; the owner's design board,
 * docs/mocks/cursor-engine).
 *
 * Orbit runs one pinned build of Cursor CLI (contract §1) and installs it itself, so a runner is asked
 * whether it can START Cursor CLI — it declares `provider:cursor` once that build is ready there, and
 * its engine report says what is missing when it is not — and, separately, whether the account a
 * session would run on is signed in (`auth`, the CLI's own `agent models`).
 */

/** Cursor CLI's name, as every list of engines writes it. */
export const CURSOR_CLI = ENGINE_CLI_NAMES[AgentProvider.CURSOR];

/** The heartbeat capability the server requires before it hands out, resumes or leases a Cursor CLI
 *  session (contract §16.1): declared only while the pinned build is ready on that runner. */
export const CURSOR_RUNNER_CAPABILITY = 'provider:cursor';
/** What a runner declares once it signs a Cursor CLI account the control plane names into that
 *  account's own directory (contract §16.1, P4b). Without it nothing offers to add one. */
export const CURSOR_ACCOUNT_LOGIN_CAPABILITY = 'cursor-account-login/v1';
/** What a runner declares once it can carry a Cursor conversation to another account or key
 *  (contract §13.3, D5). No runner declares it until two real identities have shown it works. */
export const CURSOR_ACCOUNT_MOVE_CAPABILITY = 'cursor-account-move/v1';
/** The Cursor CLI build Orbit runs (contract §1): newer releases are not followed. */
export const CURSOR_PINNED_VERSION = '2026.10.14-941492e';
/** The preset a Cursor User API Key is connected from — not `cursor`, the engine's own name. */
export const CURSOR_KEY_PRESET = 'cursor-api';
/** Where a Cursor key is connected. */
export const CURSOR_CONNECT_HREF = `/providers/new/${CURSOR_KEY_PRESET}`;

/** Why a runner can't start Cursor CLI, most fundamental first, or `ready`. */
export type CursorRunnerState = 'ready' | 'updateRunner' | 'unsupportedPlatform' | 'unsupportedVersion' | 'notInstalled';

export interface CursorRunnerFacts {
  capabilities?: readonly string[] | null;
  engines?: readonly Pick<RunnerEngineHealth, 'engine' | 'installed' | 'installationError'>[] | null;
}

/** The runner's own report of Cursor CLI, when it has one. */
const cursorHealth = (runner: CursorRunnerFacts | null | undefined) =>
  runner?.engines?.find((engine) => engine.engine === AgentProvider.CURSOR);

/** Whether this runner knows Cursor CLI at all: it declares it, or reports it among its engines —
 *  every engine its release knows, installed or not. A runner that does neither predates it. */
export function runnerKnowsCursor(runner: CursorRunnerFacts | null | undefined): boolean {
  return !!runner?.capabilities?.includes(CURSOR_RUNNER_CAPABILITY) || !!cursorHealth(runner);
}

/**
 * Whether this runner can start a Cursor CLI session, in the board's order of what is most
 * fundamental (Web 1 ②): a runner that predates Cursor CLI, then a platform the pinned build was never
 * measured on, then a build other than the pinned one, then none at all. A runner whose report says the
 * pinned build is ready and still does not declare it carries no session driver for it, which an update
 * brings — the server refuses it a session either way. Signed in or not is the credential's question,
 * not the runner's: a key carries its own.
 */
export function cursorRunnerState(runner: CursorRunnerFacts | null | undefined): CursorRunnerState {
  const health = cursorHealth(runner);
  const declared = !!runner?.capabilities?.includes(CURSOR_RUNNER_CAPABILITY);
  if (!health) return declared ? 'ready' : 'updateRunner';
  const error = health.installationError ?? '';
  if (error.startsWith('CURSOR_PLATFORM_UNSUPPORTED')) return 'unsupportedPlatform';
  if (error.startsWith('CURSOR_VERSION_INCOMPATIBLE')) return 'unsupportedVersion';
  if (!health.installed) return 'notInstalled';
  return declared ? 'ready' : 'updateRunner';
}

/** The words a picker row or a machine's row uses for a state that blocks a session. */
export const CURSOR_STATE_LABEL: Record<Exclude<CursorRunnerState, 'ready'>, string> = {
  updateRunner: 'Update runner',
  unsupportedPlatform: 'Not supported here',
  unsupportedVersion: 'Unsupported version',
  notInstalled: 'Not installed',
};

/** One sentence under a machine's Cursor CLI row on what the state means and what fixes it. Not
 *  installed has none: its row offers the install itself. A platform the pinned build does not run on
 *  is the runner's own sentence, which names both platforms. */
export function cursorStateHint(
  state: CursorRunnerState,
  health?: Pick<RunnerEngineHealth, 'installationError'> | null,
): string | null {
  switch (state) {
    case 'updateRunner':
      return `This runner predates ${CURSOR_CLI}. It updates itself when no session is running on it.`;
    case 'unsupportedVersion':
      return `Orbit runs ${CURSOR_CLI} ${CURSOR_PINNED_VERSION}. Reinstall puts that version back on this runner; sessions here can’t start until then.`;
    case 'unsupportedPlatform': {
      const said = (health?.installationError ?? '').replace(/^CURSOR_PLATFORM_UNSUPPORTED:\s*/, '').trim();
      return said ? `${said.replace(/\.+$/, '')}.` : `Orbit doesn’t run ${CURSOR_CLI} on this runner’s platform yet.`;
    }
    default:
      return null;
  }
}

/** What a session needs from the runner to know whether it has talked (the server's
 *  cursorConversationStarted, apiserver providers/account-move-capability.ts). */
export interface CursorConversationFacts {
  numTurns?: number | null;
  runtimeSessionId?: string | null;
  status?: string | null;
  engineTurnActive?: boolean | null;
}

/**
 * Whether a Cursor CLI session has a conversation another account or key would have to continue: a turn
 * of it settled, Cursor opened its conversation (runtimeSessionId, reported right before the first
 * prompt), or a turn is running now. The same question the server asks before it moves one (P6b), so
 * the Provider menu never offers a move the server refuses.
 */
export function cursorConversationStarted(session: CursorConversationFacts | null | undefined): boolean {
  if (!session) return false;
  return (
    (session.numTurns ?? 0) > 0 ||
    !!session.runtimeSessionId ||
    session.status === 'RUNNING' ||
    (session.status === 'AWAITING_INPUT' && session.engineTurnActive === true)
  );
}

/** Under the Provider menu of a Cursor CLI session that has talked, on a runner that can't carry its
 *  conversation: why its other accounts and keys are listed but can't be picked (D5). The server's
 *  refusal of the same request says the same in its own words. */
export const CURSOR_MOVE_BLOCKED_NOTE =
  `${CURSOR_CLI} can’t carry a conversation to another account or key yet. Start a new session to use one of these.`;

/** In the model menu under Auto, which has no parameters to set (contract §10). */
export const CURSOR_AUTO_NOTE =
  'Auto picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set.';

/** A Cursor CLI session's model value read against the runner's catalogue: the model the menu checks, its
 *  row, and the settings the value names beside it (shared cursorModels.ts, contract §10). A value the
 *  catalogue lists as it stands is a model of its own, as the server reads it (runnerCatalogRow). */
export interface CursorModelPick {
  model: string;
  row?: RunnerModelInfo;
  parameters: Record<string, string>;
}

export function cursorModelPick(value: string, modelCatalog?: RunnerModelCatalog | null): CursorModelPick {
  const row = runnerCatalogRow(AgentProvider.CURSOR, value, modelCatalog);
  if (row && row.value === value) return { model: value, row, parameters: {} };
  const { model, parameters } = decodeCursorModel(value);
  return { model, row, parameters };
}

/** A row of the model menu for one of a Cursor model's own settings: what it is called there, the value
 *  in effect — the one the session's model value names when the model offers it, else the model's own —
 *  and the values to pick from, all as the runner's catalogue lists them. */
export interface CursorSettingRow {
  id: string;
  title: string;
  value: string;
  label: string;
  defaultValue: string;
  values: Array<{ value: string; label: string }>;
}

/** The menu's rows for a Cursor model's context size and fast lane, in the board's order (Web 5 ①), each
 *  only where the model's row lists it: Context, then Speed, which is Cursor's `fast` and reads Standard or
 *  Fast as every engine's Speed row does. Auto has none. */
export function cursorSettingRows(pick: CursorModelPick | null | undefined): CursorSettingRow[] {
  if (!pick) return [];
  return [
    { id: 'context', title: 'Context' },
    { id: 'fast', title: 'Speed' },
  ].flatMap(({ id, title }) => {
    const parameter = pick.row?.parameters?.find((candidate) => candidate.id === id);
    const values = (parameter?.values ?? [])
      .filter((option) => option.value)
      .map((option) => (id === 'fast' && option.value !== 'true' ? { ...option, label: 'Standard' } : option));
    if (!parameter || values.length === 0) return [];
    const defaultValue = parameter.default ?? '';
    const named = pick.parameters[id];
    const value = values.some((option) => option.value === named) ? named : defaultValue;
    const label = values.find((option) => option.value === value)?.label ?? value;
    return [{ id, title, value, label, defaultValue, values }];
  });
}

/** What the composer's chip says after the effort of a Cursor model (board Web 5 ⑤, "Claude Opus 5.5 High ·
 *  1M · Fast"): a context other than the model's own, then the fast lane when it is on. */
export function cursorChipSettings(rows: readonly CursorSettingRow[]): string[] {
  return rows.flatMap((row) =>
    (row.id === 'fast' ? row.value === 'true' : row.value !== row.defaultValue) ? [row.label] : [],
  );
}

/** Under the tray of messages waiting for a running Cursor CLI turn (contract §3.2: a prompt sent
 *  mid-turn cancels the turn, so Orbit queues it). */
export const CURSOR_QUEUE_NOTE =
  `${CURSOR_CLI} can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends.`;

/** The composer's placeholder while a Cursor CLI turn runs. */
export const CURSOR_RUNNING_PLACEHOLDER = `Reply — it goes to ${CURSOR_CLI} when this turn ends…`;

/** The context gauge's popover: Cursor CLI never reports context use over ACP (contract §4.1). */
export const CURSOR_CONTEXT_UNAVAILABLE =
  `${CURSOR_CLI} doesn’t report how much of the window a session has used, so there is no reading to show.`;
