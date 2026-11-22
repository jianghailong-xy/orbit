import type { BgShell } from './background';

// The folded "Background" row of a session's composer band: what it draws, from the session's
// background list (GET /sessions/:id/background), the cut-off time below and whether the session
// is live. One rule for web, OrbitKit and Android; every client's tests read
// `background-row.fixture.json` beside this file, so the three cannot drift.
//
// Owner decisions (project 34yq7HVPsPDGBiMEm8sL2, 2026-11-17):
//   D1  (revised 2026-11-21) an ended item, failed included, is shown only until the agent's next
//       turn or the person's next message after it ended, whichever comes first. `clearedAt` is the
//       later of the last message the person typed and the start of the agent's latest turn (any
//       turn, a wake's included: once the agent has been told, someone has followed it up); an
//       ended item is shown only if it ended after `clearedAt`. A wake note, a watch's wake and a
//       message another Orbit session sent (session_send / project_send, a `sessionMessage` card,
//       a coordinator's included) are not the person's message and never count as one (ruling
//       2026-11-20); the turn they open does count, as the agent's turn. An item that ended while
//       a turn was running stays until the next turn starts.
//   D2  the visible label is "Background"; the screen reader keeps "Background processes".
//   E1  several running: rotate the names, newest started first, 3000 ms each, 300 ms change.
//   E2  (revised 2026-11-21) a failure is neither counted nor pinned: the person can do nothing
//       about it (the agent was told). It keeps its cross wherever it is named and in the list.
//   E3  (revised 2026-11-21) nothing running: the last one to end is shown, failed or not.

/** The row's visible label. */
export const BACKGROUND_ROW_LABEL = 'Background';
/** The screen-reader label's start; the count or the one name follows. */
export const BACKGROUND_ROW_A11Y_PREFIX = 'Background processes, ';
/** How long each name shows while the names rotate. */
export const BACKGROUND_ROW_ROTATE_PER_NAME_MS = 3000;
/** How long the change from one name to the next takes. */
export const BACKGROUND_ROW_ROTATE_CHANGE_MS = 300;

/** The fields of a background list entry the row reads. */
export type BackgroundRowInput = Pick<
  BgShell,
  'shellId' | 'command' | 'description' | 'startedSeq' | 'status' | 'endedAt'
>;

/** The mark after a name: a spinner while running, then the list row's ✓ / ✕ / stop icon. */
export type BackgroundRowMark = 'running' | 'done' | 'failed' | 'killed';

/**
 * Where a name gives way when it does not fit: a description loses its tail ("Wait until the
 * handoff…"), a command its middle ("npm run build … tee build.log").
 */
export type BackgroundRowTruncate = 'tail' | 'middle';

export interface BackgroundRowItem {
  id: string;
  name: string;
  truncate: BackgroundRowTruncate;
  mark: BackgroundRowMark;
}

export interface BackgroundRowCountPart {
  kind: 'running';
  /** "N running". */
  text: string;
}

export type BackgroundRowName =
  /** One named item, still. */
  | { mode: 'one'; item: BackgroundRowItem }
  /** The running items' names in turn, newest started first, looping. */
  | { mode: 'rotate'; items: BackgroundRowItem[]; perNameMs: number; changeMs: number };

export type BackgroundRow =
  | { hidden: true }
  | {
      hidden: false;
      label: string;
      name: BackgroundRowName;
      /** The count's parts, zero parts left out; empty unless more than one item is shown. */
      countParts: BackgroundRowCountPart[];
      /** The parts joined by " · ", or null when there are none. */
      countLine: string | null;
      /** "Background processes, " + the count, or the one name. Never the rotating text. */
      accessibilityLabel: string;
    };

/** A list entry's name: its description, falling back to its command (then its id). */
export function backgroundItemName(item: BackgroundRowInput): { name: string; truncate: BackgroundRowTruncate } {
  const description = item.description?.trim();
  if (description) return { name: description, truncate: 'tail' };
  const command = item.command.trim();
  return { name: command || item.shellId, truncate: 'middle' };
}

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** The row's cut-off: the later of the person's last message and the agent's latest turn start (null: none). */
export function backgroundRowClearedAt(
  lastUserMessageAt: string | null,
  lastAgentTurnStartedAt: string | null,
): string | null {
  const a = time(lastUserMessageAt);
  const b = time(lastAgentTurnStartedAt);
  if (Number.isNaN(a)) return Number.isNaN(b) ? null : lastAgentTurnStartedAt;
  if (Number.isNaN(b)) return lastUserMessageAt;
  return b > a ? lastAgentTurnStartedAt : lastUserMessageAt;
}

/**
 * What the folded row draws.
 *
 * Shown items are the running ones (only on a live session: a session that is not live has
 * nothing running, whatever its list last said) plus the ended ones that ended after `clearedAt`
 * (all ended ones when it is null). See D1 above.
 */
export function backgroundRow(
  list: BackgroundRowInput[],
  clearedAt: string | null,
  sessionLive: boolean,
): BackgroundRow {
  const since = time(clearedAt);
  const running = sessionLive ? list.filter((s) => s.status === 'running') : [];
  const ended = list.filter(
    (s) =>
      (s.status === 'done' || s.status === 'failed' || s.status === 'killed') &&
      !Number.isNaN(time(s.endedAt)) &&
      (Number.isNaN(since) || time(s.endedAt) > since),
  );
  const shown = [...running, ...ended];
  if (shown.length === 0) return { hidden: true };

  const toItem = (s: BackgroundRowInput): BackgroundRowItem => ({
    id: s.shellId,
    ...backgroundItemName(s),
    mark: s.status as BackgroundRowMark,
  });
  const lastEnded = (xs: BackgroundRowInput[]) =>
    xs.reduce((a, b) => (time(b.endedAt) > time(a.endedAt) ? b : a));

  let name: BackgroundRowName;
  if (shown.length === 1) {
    name = { mode: 'one', item: toItem(shown[0]) };
  } else if (running.length >= 2) {
    name = {
      mode: 'rotate',
      items: [...running].sort((a, b) => b.startedSeq - a.startedSeq).map(toItem),
      perNameMs: BACKGROUND_ROW_ROTATE_PER_NAME_MS,
      changeMs: BACKGROUND_ROW_ROTATE_CHANGE_MS,
    };
  } else if (running.length === 1) {
    name = { mode: 'one', item: toItem(running[0]) };
  } else {
    name = { mode: 'one', item: toItem(lastEnded(ended)) };
  }

  // How many run; no failed count (E2).
  const countParts: BackgroundRowCountPart[] = [];
  if (shown.length > 1 && running.length > 0) countParts.push({ kind: 'running', text: `${running.length} running` });
  const countLine = countParts.length > 0 ? countParts.map((p) => p.text).join(' · ') : null;
  const spoken = countLine ?? (name.mode === 'rotate' ? name.items[0].name : name.item.name);

  return {
    hidden: false,
    label: BACKGROUND_ROW_LABEL,
    name,
    countParts,
    countLine,
    accessibilityLabel: BACKGROUND_ROW_A11Y_PREFIX + spoken,
  };
}
