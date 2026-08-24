import { AgentProvider } from '@orbit/shared';

/** The four settings the composer's pills can change on a session. */
export type ConfigField = 'model' | 'permissionMode' | 'effort' | 'provider';

/** Every field, so a caller can iterate them without re-listing them (and drifting). */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  'model',
  'permissionMode',
  'effort',
  'provider',
];

/** What each pill controls — the tooltip says this much even when it can say nothing else. */
const LABEL: Record<ConfigField, string> = {
  model: 'Model',
  permissionMode: 'Permission mode',
  effort: 'Reasoning effort',
  provider: 'Provider',
};

/**
 * Whether a change to this field reaches the engine that is already running, rather than the one
 * that runs next.
 *
 * The four fields stopped answering this the same way. Effort and provider are decided when the
 * engine process is BUILT — its flags and its environment — so changing them enqueues a `reload`:
 * the runner tears the process down and re-spawns it with `--resume`, and the inbox holds that
 * turn until no message is in flight. A change made mid-turn therefore lands on the next turn.
 * Model and permission mode are not build-time facts: a resident Claude Code takes `set_model`
 * and `set_permission_mode` on its control channel and honours them from that point in the turn
 * it is running, so they enqueue a `setconfig`, which the inbox hands over mid-turn.
 *
 * The split is the server's (SessionsService.updateConfig), and so is the gate below it: those
 * control frames exist on the claude runtime only, so a Codex / Kimi / OpenCode session still
 * re-spawns for every one of the four. Judged by the RUNTIME the session executes on and never by
 * its provider slug — a configured (BYOK) identity borrows one, and `runtimeForProvider` is this
 * client's copy of the server's `execRuntime`.
 */
export const appliesMidTurn = (field: ConfigField, runtime: string): boolean =>
  runtime === AgentProvider.CLAUDE && (field === 'model' || field === 'permissionMode');

const MID_TURN = 'applies immediately, even mid-turn';
const NEXT_TURN = 'applies on the next turn (the engine restarts to pick it up)';

export interface ConfigPillState {
  /**
   * A live session's pills PATCH the server, which is what makes "when does this land" a question
   * at all. A draft or ended session keeps the pick locally and carries it on create/resume, so
   * its pills promise no timing.
   */
  live: boolean;
  /** The assigned runner is reachable. A live session's PATCH needs it; nothing else does. */
  runnerOnline: boolean;
  trashed: boolean;
  missing: boolean;
  /**
   * The built-in runtime this session executes on (`runtimeForProvider`), or undefined while a
   * configured slug's borrowed runtime is still unresolved. Unknown means the pills say nothing
   * about timing rather than guessing: promising "even mid-turn" to a session that turns out to
   * be running on Codex is the false assurance this is derived to avoid.
   */
  runtime?: string;
  /**
   * What the chosen permission mode MEANS on that runtime, when the shared table has a caveat
   * (`derivePermissionSemantics().note`). Shown after the timing, so the mode pill answers both
   * "what will this do" and "as of when".
   */
  permissionNote?: string;
}

/**
 * The tooltip each config pill shows — one table, so the help cannot drift from the behaviour or
 * from its neighbours. Empty strings are never returned: a pill that can say nothing else still
 * names what it controls.
 */
export function configPillHints(state: ConfigPillState): Record<ConfigField, string> {
  const blocked = state.trashed
    ? 'Restore this session before changing settings'
    : state.missing
      ? 'Session not found'
      : state.live && !state.runnerOnline
        ? 'Runner offline — cannot change this now'
        : '';
  const hint = (field: ConfigField): string => {
    // An unresolved provider identity has no model space either, so the Model pill explains the
    // value it is showing instead of the timing it cannot promise.
    if (field === 'model' && state.runtime === undefined) {
      return 'Model will be resolved from the provider default';
    }
    if (blocked) return blocked;
    const timing =
      !state.live || state.runtime === undefined
        ? ''
        : appliesMidTurn(field, state.runtime)
          ? MID_TURN
          : NEXT_TURN;
    return timing ? `${LABEL[field]} — ${timing}` : LABEL[field];
  };
  // Ended as its own sentence: the note is one, and run straight on it reads as a single
  // sentence that says the mode applies mid-turn to a model that does not have it.
  const permissionNote = !blocked && state.permissionNote ? `. ${state.permissionNote}` : '';
  return {
    model: hint('model'),
    permissionMode: `${hint('permissionMode')}${permissionNote}`,
    effort: hint('effort'),
    provider: hint('provider'),
  };
}
