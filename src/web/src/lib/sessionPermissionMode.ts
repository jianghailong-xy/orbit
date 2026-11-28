import {
  PERMISSION_MODE_CORRECTION_FAILED_EVENT_SUBTYPE,
  type SessionPermissionModeChange,
  type SessionPermissionModeCorrectionRefusal,
} from '@orbit/shared';
import { MODE_OPTIONS } from './workspaceDefaults';

/**
 * The composer's Mode capsule and the transcript's mode-change lines, as the owner chose them on
 * docs/mocks/permission-mode-actual (2026-11-19: A1, B1, C1).
 *
 * The capsule shows the mode the session's engine is actually running in, as the server recorded it
 * (`actualPermissionMode`), never the stored mode adjusted by a guess here. The stored mode is the
 * owner's intent: the menu's check stays on it and nothing in this file rewrites it. Before a session
 * runs, the capsule shows the mode it will start in, which differs from the intent only where the
 * server substitutes one at claim (a model with no Auto, Bypass on a root runner).
 *
 * A gap between the two is either a switch under way (A1, short: "Default → Auto" with a spinner) or
 * one that lasts until something changes ("Default" with an amber dot); both carry their reason.
 * A correction Claude refused (the runner's `permission_mode_correction_failed`) is a gap that lasts,
 * with the CLI's own words, from the moment the runner says so. The session detail carries the one that
 * still stands, so the gap shows whether or not its event is among those loaded.
 */

/** A mode's word, as the capsule and the menu write it: `acceptEdits` → "Accept Edits". */
export const permissionModeLabel = (mode: string): string =>
  MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;

/** How long a switch counts as under way before it is shown as a gap that lasts. Per ruling R1 the
 *  runner corrects an engine that settled below Auto at once, and a pick reaches a resident engine in
 *  seconds; past this, saying "switching now" would no longer be true. */
export const MODE_SWITCH_WINDOW_MS = 30_000;

export type ModeGap = 'none' | 'switching' | 'lasting';

export interface ModeCapsule {
  /** The mode the engine runs in, or the one it will start in. */
  mode: string;
  gap: ModeGap;
  /** What the capsule says: the mode's word, or "Default → Auto" while a switch is under way. */
  label: string;
  /** The intent's word while the engine switches to it, else null. */
  to: string | null;
  /** Why the capsule differs from the intent: `lead` is drawn bold. Null when it does not. */
  reason: { lead: string; rest: string } | null;
  /** When a switch under way stops counting as one, for the view to look again; else null. */
  switchingUntil: number | null;
}

export interface ModeFacts {
  /** The owner's intent: the stored mode, or the draft's pick. */
  intent: string;
  engine: string;
  /** Whether the model has Auto on this runner (`supportsAuto`). */
  modelHasAuto: boolean;
  modelLabel: string;
  runsAsRoot?: boolean | null;
  /** A scheduled task's run, which Claude Code always runs in Auto (schedule-access.ts). */
  scheduled?: boolean;
}

/**
 * The runner's report that Claude would not take the Auto it asked for (runner-go claude_mode_correction.go):
 * `mode` is the mode it stays in, `reason` the CLI's own words. It travels as a system event of the
 * conversation and is no mode change, so it is read off the events loaded.
 */
export interface ModeCorrectionRefusal {
  seq: number;
  at: string;
  mode: string;
  requested: string;
  reason: string;
}

/** A refused correction as the capsule reads it: from an event loaded, or from the session detail. */
export type StandingRefusal = Pick<ModeCorrectionRefusal, 'at' | 'mode' | 'requested' | 'reason'>;

/**
 * The refused correction the capsule reads: the session detail's, which the server carries while it answers the
 * newest change whether or not its event is loaded, else the newest among the events loaded (an older server's
 * detail, or one read before the refusal reached it).
 */
export function standingRefusal(
  detail: SessionPermissionModeCorrectionRefusal | null | undefined,
  loaded: readonly ModeCorrectionRefusal[],
): StandingRefusal | null {
  if (detail) return { at: detail.at, mode: detail.mode, requested: detail.requestedMode, reason: detail.reason.trim() };
  return loaded.at(-1) ?? null;
}

/** How far the runner's clock may run behind the server's: the refusal is stamped by the runner, the
 *  report of the lower mode it answers by the server when it took the batch. */
const REFUSAL_CLOCK_SLACK_MS = 60_000;

/** Every refused correction among `events`, oldest first. */
export function modeCorrectionRefusals(
  events: ReadonlyArray<{ seq: number; type: string; ts?: string; payload?: unknown }>,
): ModeCorrectionRefusal[] {
  const out: ModeCorrectionRefusal[] = [];
  for (const event of events) {
    if (event.type !== 'system') continue;
    const p = (event.payload ?? {}) as { subtype?: unknown; mode?: unknown; requested?: unknown; reason?: unknown };
    if (p.subtype !== PERMISSION_MODE_CORRECTION_FAILED_EVENT_SUBTYPE || typeof p.mode !== 'string') continue;
    out.push({
      seq: event.seq,
      at: event.ts ?? '',
      mode: p.mode,
      requested: typeof p.requested === 'string' ? p.requested : 'auto',
      reason: typeof p.reason === 'string' ? p.reason.trim() : '',
    });
  }
  return out;
}

/**
 * Whether `refusal` answers the change the engine runs under now: Claude's report of the mode it
 * settled on (or came back from a re-spawn in), which the runner then failed to correct. Any later
 * change (a correction that took, the owner's pick) ends it.
 */
export function refusalStands<R extends StandingRefusal>(
  refusal: R | null | undefined,
  latest: SessionPermissionModeChange | null | undefined,
  actual: string | null | undefined,
): refusal is R {
  if (!refusal || !latest || !actual) return false;
  if (latest.cause !== 'ENGINE_REPORT' && latest.cause !== 'RESPAWN') return false;
  if (latest.toMode !== actual || refusal.mode !== actual) return false;
  const at = Date.parse(refusal.at);
  return !Number.isFinite(at) || at >= Date.parse(latest.at) - REFUSAL_CLOCK_SLACK_MS;
}

/** The index of the change `refusal` answers: the newest report of the mode it stays in, from before it. */
function answeredChange(changes: readonly SessionPermissionModeChange[], refusal: ModeCorrectionRefusal): number | null {
  const at = Date.parse(refusal.at);
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i]!;
    if (change.cause !== 'ENGINE_REPORT' && change.cause !== 'RESPAWN') continue;
    if (change.toMode !== refusal.mode) continue;
    if (Number.isFinite(at) && Date.parse(change.at) > at + REFUSAL_CLOCK_SLACK_MS) continue;
    return i;
  }
  return null;
}

/** The CLI's words as a sentence. */
const sentence = (words: string): string => (/[.!?]$/.test(words) ? words : `${words}.`);

/** Why the capsule shows a refused correction (the board's lasting gap, with the CLI's reason). */
function refusalReason(refusal: StandingRefusal): { lead: string; rest: string } {
  const asked = permissionModeLabel(refusal.requested);
  return {
    lead: `Running in ${permissionModeLabel(refusal.mode)}.`,
    rest: refusal.reason
      ? `You asked for ${asked}, but the runner couldn’t switch Claude to it: ${sentence(refusal.reason)}`
      : `You asked for ${asked}, but the runner couldn’t switch Claude to it.`,
  };
}

export interface ModeCapsuleInput extends ModeFacts {
  /** What the server recorded the engine running in. Absent before a claim, from an older server, and
   *  for a draft or an ended session, whose capsule shows the mode it will start in. */
  actual?: string | null;
  /** The newest recorded change (the session detail's last), which says whether the engine settled below Auto. */
  latest?: SessionPermissionModeChange | null;
  /** When this client last picked the intent of the running session, while it travels to the engine. */
  pickedAt?: number | null;
  /** The refused correction that stands (standingRefusal): the detail's, or the newest among the events loaded. */
  refusal?: StandingRefusal | null;
  now: number;
}

const CLAUDE = 'claude';

/** What the intent is for display: a scheduled run on Claude Code runs in Auto whatever was stored. */
const intentOf = (facts: ModeFacts): string => (facts.scheduled && facts.engine === CLAUDE ? 'auto' : facts.intent);

/**
 * The mode the server hands the engine for `intent` (normalizeBuiltinPermissionMode): Default for Auto
 * on a model with no Auto, and Auto — or Default, on such a model — for Bypass on a root runner.
 */
function startingMode(intent: string, facts: ModeFacts): string {
  if (facts.engine !== CLAUDE) return intent;
  const auto = facts.modelHasAuto ? 'auto' : 'default';
  if (intent === 'bypassPermissions' && facts.runsAsRoot) return auto;
  if (intent === 'auto') return auto;
  return intent;
}

/** Why `mode` is not the intent, where the server substitutes it: a model with no Auto, a root runner. */
function substitutionReason(intent: string, mode: string, facts: ModeFacts, started: boolean): { lead: string; rest: string } {
  const lead = `${started ? 'Running' : 'Starts'} in ${permissionModeLabel(mode)}.`;
  if (intent === 'bypassPermissions') {
    const root = started ? 'You asked for Bypass, but Bypass can’t run on a root runner.' : 'Bypass can’t run on a root runner.';
    return { lead, rest: facts.modelHasAuto ? root : `${root.slice(0, -1)}, and ${facts.modelLabel} has no Auto.` };
  }
  return {
    lead,
    rest: started
      ? `You asked for Auto, but ${facts.modelLabel} has no Auto. Pick a model with Auto to get it back.`
      : `${facts.modelLabel} has no Auto; your pick stays Auto and applies on a model that has it.`,
  };
}

const plain = (mode: string): ModeCapsule => ({
  mode,
  gap: 'none',
  label: permissionModeLabel(mode),
  to: null,
  reason: null,
  switchingUntil: null,
});

const lasting = (mode: string, reason: { lead: string; rest: string }): ModeCapsule => ({
  mode,
  gap: 'lasting',
  label: permissionModeLabel(mode),
  to: null,
  reason,
  switchingUntil: null,
});

export function modeCapsule(input: ModeCapsuleInput): ModeCapsule {
  const intent = intentOf(input);
  const starting = startingMode(intent, input);
  const actual = input.actual;
  if (!actual) {
    // Not running yet (C1): the mode it will start in, which the server substitutes only where it must.
    return starting === intent ? plain(intent) : lasting(starting, substitutionReason(intent, starting, input, false));
  }
  if (actual === intent) return plain(actual);
  // The runner asked Claude for Auto and Claude said no: nothing is under way, and the CLI's words say why.
  if (refusalStands(input.refusal, input.latest, actual)) return lasting(actual, refusalReason(input.refusal));
  if (starting !== intent) {
    // The intent cannot run here; the engine runs in what the server put in its place.
    return actual === starting
      ? lasting(actual, substitutionReason(intent, actual, input, true))
      : lasting(actual, { lead: `Running in ${permissionModeLabel(actual)}.`, rest: `You asked for ${permissionModeLabel(intent)}.` });
  }
  // The intent can run here, so the engine is on its way to it: Claude settled below the Auto it was
  // asked for and the runner corrects it (R1), or a pick is travelling to the engine.
  const latest = input.latest;
  const settledBelow =
    intent === 'auto' &&
    !!latest &&
    latest.toMode === actual &&
    (latest.cause === 'ENGINE_REPORT' || latest.cause === 'RESPAWN');
  const since = settledBelow ? Date.parse(latest!.at) : (input.pickedAt ?? Number.NaN);
  const until = since + MODE_SWITCH_WINDOW_MS;
  const lead = `Running in ${permissionModeLabel(actual)}.`;
  if (Number.isFinite(until) && input.now < until) {
    return {
      mode: actual,
      gap: 'switching',
      label: `${permissionModeLabel(actual)} → ${permissionModeLabel(intent)}`,
      to: permissionModeLabel(intent),
      reason: settledBelow
        ? { lead, rest: 'Claude started below the Auto you asked for; the runner is switching it to Auto now.' }
        : { lead, rest: `Switching to ${permissionModeLabel(intent)} now.` },
      switchingUntil: until,
    };
  }
  return lasting(
    actual,
    settledBelow
      ? { lead, rest: 'Claude started below the Auto you asked for, and the runner hasn’t switched it back.' }
      : { lead, rest: `You asked for ${permissionModeLabel(intent)}; the engine hasn’t switched yet.` },
  );
}

/**
 * The note after a mode's name in the menu, where the model changes what it does (C1): Auto on a
 * model with no Auto stays selectable and says what the session does instead.
 */
export function autoMenuNote(facts: Pick<ModeFacts, 'engine' | 'modelHasAuto' | 'modelLabel'>, started: boolean): string | null {
  if (facts.engine !== CLAUDE || facts.modelHasAuto) return null;
  return `not on ${facts.modelLabel}, ${started ? 'runs as' : 'starts in'} Default`;
}

/** One line of the transcript recording a mode change (B1): the sentence around the mode it names. */
export interface ModeChangeLine {
  key: string;
  at: string;
  before: string;
  /** The mode's word, drawn bold. */
  mode: string;
  after: string;
  /** Whether this is the change behind the gap the capsule shows now, drawn amber. */
  gap: boolean;
  /** For a refused correction, the event it is: the line goes right where the runner said it. */
  seq?: number;
}

/** Where the owner was when they changed it, as `session_permission_mode_change.client` names it. */
function byWhom(client: string | null): string {
  switch (client) {
    case 'web':
      return 'by you, on the web';
    case 'ios':
      return 'by you, on iOS';
    case 'macos':
      return 'by you, on the Mac';
    case 'android':
      return 'by you, on Android';
    case 'terminal':
      return 'by you, in the terminal';
    case 'feishu':
      return 'by you, in Feishu';
    case 'session':
      return 'by another session';
    case 'pat':
      return 'with an access token';
    default:
      return 'by you';
  }
}

/**
 * The transcript's record of how the session's mode came to be, one line per change the server
 * recorded, with who or what made it. A first claim in the mode asked for is how every session starts
 * and says nothing; an engine report the runner corrected is said by the correction's own line.
 */
export function modeChangeLines(
  changes: readonly SessionPermissionModeChange[],
  facts: ModeFacts & { actual?: string | null; refusals?: readonly ModeCorrectionRefusal[] },
): ModeChangeLine[] {
  const intent = intentOf(facts);
  const gapOpen = !!facts.actual && facts.actual !== intent;
  const refusals = facts.refusals ?? [];
  // A refusal that still stands is the gap's own line; the report it answers is then said plainly.
  const standing = refusalStands(refusals.at(-1), changes.at(-1), facts.actual) && gapOpen ? refusals.at(-1)! : null;
  const lines: ModeChangeLine[] = [];
  // Which line each change drew, by the change's index.
  const lineOf = new Map<number, number>();
  changes.forEach((change, i) => {
    const next = changes[i + 1];
    const latest = i === changes.length - 1;
    const gap = latest && gapOpen && change.toMode === facts.actual && !standing;
    const mode = permissionModeLabel(change.toMode);
    const line = (before: string, after = '', amber = gap): void => {
      // By seq where the server numbers its changes: two can share a moment, cause and mode, never a seq.
      const key = change.seq !== undefined ? `seq-${change.seq}` : `${change.at}|${change.cause}|${change.toMode}|${i}`;
      lineOf.set(i, lines.length);
      lines.push({ key, at: change.at, before, mode, after, gap: amber });
    };
    // Why the mode is not the intent, for the line behind a gap the server's substitution opened.
    const substituted = gap && startingMode(intent, facts) === change.toMode;
    const because = substituted
      ? intent === 'bypassPermissions'
        ? ', not Bypass — Bypass can’t run on a root runner'
        : ` — ${facts.modelLabel} has no Auto`
      : gap
        ? `, not ${permissionModeLabel(intent)}`
        : '';
    switch (change.cause) {
      case 'CLAIM':
        // The server says when the claim handed another mode than the one asked for, and why.
        if (change.reason === 'SCHEDULED_RUN') {
          // The rule, not a gap.
          line(change.fromMode ? 'Resumed in ' : 'Started in ', ' — scheduled runs always use Auto', false);
        } else if (change.reason === 'ROOT_RUNNER') {
          const asked = permissionModeLabel(change.requestedMode ?? 'bypassPermissions');
          line(change.fromMode ? 'Resumed in ' : 'Started in ', `, not ${asked} — ${asked} can’t run on a root runner`);
        } else if (facts.scheduled && facts.engine === CLAUDE && change.toMode === 'auto') {
          line(change.fromMode ? 'Resumed in ' : 'Started in ', ' — scheduled runs always use Auto');
        } else if (change.fromMode) {
          line('Resumed in ', because);
        } else if (gap) {
          line('Started in ', because);
        }
        return;
      case 'OWNER_PICK':
        if (substituted && intent === 'auto') line('Mode now ', ` — you picked ${facts.modelLabel}, which has no Auto`);
        else line('Mode set to ', ` ${byWhom(change.client)}${because}`);
        return;
      case 'ENGINE_REPORT':
        if (next?.cause === 'RUNNER_CORRECTION') return;
        line('Claude started in ', because);
        return;
      case 'RUNNER_CORRECTION': {
        // What it corrected: Claude's start, or its re-spawn when that is the change before.
        const how = changes[i - 1]?.cause === 'RESPAWN' ? 'restarted' : 'started';
        if (change.fromMode) line('Mode set back to ', ` by the runner — Claude had ${how} in ${permissionModeLabel(change.fromMode)}`);
        else line('Mode set to ', ' by the runner');
        return;
      }
      case 'RESPAWN':
        // Back in the mode asked for, the intent was applied again; in another, that is what it came back in.
        if (change.toMode === intent) line('Claude restarted; mode ', ' re-applied');
        else line('Claude restarted in ', because);
        return;
      case 'ORBIT_CHANGE':
        line('Mode set to ', ` by Orbit${because}`);
        return;
      default:
        line('Mode now ', because);
    }
  });
  for (const refusal of refusals) {
    // The report it answers goes right before it: the server stamps a change when it took the runner's batch, after the
    // runner's own stamp on the refusal, so by time alone the report would land below its answer.
    const answered = answeredChange(changes, refusal);
    const reportLine = answered === null ? undefined : lines[lineOf.get(answered) ?? -1];
    if (reportLine) reportLine.seq = refusal.seq;
    lines.push({
      key: `refused|${refusal.seq}`,
      at: refusal.at,
      seq: refusal.seq,
      before: 'Claude stays in ',
      mode: permissionModeLabel(refusal.mode),
      after: refusal.reason
        ? ` — the runner couldn’t switch it to ${permissionModeLabel(refusal.requested)}: ${refusal.reason}`
        : ` — the runner couldn’t switch it to ${permissionModeLabel(refusal.requested)}`,
      gap: refusal === standing,
    });
  }
  return lines;
}
