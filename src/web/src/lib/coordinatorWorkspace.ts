import type { SessionMoveTargets } from '@orbit/shared';

/**
 * Change: where a project is coordinated from (docs/mocks/coordinator-move-workspace/04-change).
 * One door for both ways of getting there — the coordinator conversation moves along when it can
 * (`POST /sessions/:id/move`), or a new, empty one opens there (`POST /projects/:id/coordinator/replace`
 * with `{ workspaceId }`). Which way each workspace allows is the server's answer: `move-targets`
 * for a conversation that exists, and for one that does not (in Trash, never opened) the two refusals
 * `sessions.create` gives a workspace — disabled, or on no runner — read off the workspace list.
 */

export const CHANGE_COPY = {
  link: 'Change',
  /** The Unavailable card's button and the phone menus' item. */
  button: 'Change workspace…',
  title: 'Change workspace',
  sub: (project: string, from: string | null) => (from ? `${project} · coordinated from ${from}` : project),
  current: 'Current',
  runnerOffline: 'Runner offline',
  comesAlong: 'Conversation comes along',
  newConversation: 'New conversation',
  foot: 'Tasks keep running where they are. Only where the project is coordinated from changes.',
  disabled: 'This workspace is disabled.',
  noRunner: 'This workspace has no runner.',
  cancel: 'Cancel',
  move: 'Move conversation',
  startThere: 'Start a new one there',
} as const;

/** A workspace as `GET /workspaces` lists it — only what the list reads. */
export interface PickerWorkspace {
  id: string;
  name: string;
  enabled?: boolean;
  runnerId?: string | null;
  runner?: { name?: string | null; displayName?: string | null } | null;
  lastProvider?: string | null;
}

/** How a picked workspace can take the project: the conversation moves along, or a new one opens there. */
export type ChangeWay = 'move' | 'new';

export interface ChangeRow {
  workspaceId: string;
  name: string;
  provider: string;
  /** `<Provider> · <runner>`, `Current`, or why nothing can open there. */
  detail: string;
  /** Null for the current workspace and for one nothing can open in (greyed). */
  way: ChangeWay | null;
  /** Why the conversation cannot come along, for a `new` row (the server's sentence); why nothing
   *  can open there, for a greyed one. */
  reason: string | null;
  current: boolean;
  runnerOffline: boolean;
}

const currentRow = (id: string, name: string, provider: string): ChangeRow => ({
  workspaceId: id, name, provider, detail: CHANGE_COPY.current, way: null, reason: null, current: true, runnerOffline: false,
});

/** The rows for a coordinator conversation that exists: its own workspace first, then the server's targets. */
export function changeRowsFromTargets(
  answer: SessionMoveTargets,
  current: { id: string; name: string; provider?: string },
  providerName: (slug: string) => string,
): ChangeRow[] {
  const rows = answer.targets.map((t): ChangeRow => {
    const comesAlong = answer.reason == null && t.reason == null;
    const way: ChangeWay | null = comesAlong ? 'move' : t.startsCoordinator ? 'new' : null;
    return {
      workspaceId: t.workspaceId,
      name: t.name,
      provider: t.provider,
      detail: way ? [providerName(t.provider), t.runnerName].filter(Boolean).join(' · ') : (t.reason ?? ''),
      way,
      reason: comesAlong ? null : (answer.reason ?? t.reason),
      current: false,
      runnerOffline: way != null && t.runnerId != null && !t.runnerOnline,
    };
  });
  return [currentRow(current.id, current.name, current.provider ?? 'claude'), ...rows];
}

/** The rows when there is no conversation to bring (in Trash, or never opened): every usable workspace
 *  takes a new one. */
export function changeRowsFromWorkspaces(
  workspaces: readonly PickerWorkspace[],
  currentWorkspaceId: string | null,
  onlineRunnerIds: ReadonlySet<string> | null,
  providerName: (slug: string) => string,
): ChangeRow[] {
  const rows = workspaces.map((w): ChangeRow => {
    const provider = w.lastProvider || 'claude';
    if (w.id === currentWorkspaceId) return currentRow(w.id, w.name, provider);
    const reason = w.enabled === false ? CHANGE_COPY.disabled : !w.runnerId ? CHANGE_COPY.noRunner : null;
    const runnerName = w.runner?.displayName || w.runner?.name || null;
    return {
      workspaceId: w.id,
      name: w.name,
      provider,
      detail: reason ?? [providerName(provider), runnerName].filter(Boolean).join(' · '),
      way: reason ? null : 'new',
      reason,
      current: false,
      // Unknown liveness (the runner list not read yet) is no pill rather than a wrong one.
      runnerOffline: reason == null && !!w.runnerId && onlineRunnerIds != null && !onlineRunnerIds.has(w.runnerId),
    };
  });
  // The current workspace leads, as it does when the server lists the targets.
  return [...rows.filter((r) => r.current), ...rows.filter((r) => !r.current)];
}

/** What the conversation being left behind is. */
export type OutgoingCoordinator = 'open' | 'completed' | 'none';

export const changeTitle = (project: string, to: string): string => `Coordinate ${project} from ${to}?`;

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The confirmation when the conversation can come along: both ways, the move first. `files` is the
 *  sentence about changes left on the branch (Move's own, moveConfirmParagraphs), when there are any. */
export function changeMoveParagraphs(args: {
  to: string;
  from: string;
  needsEnd: boolean;
  files: string | null;
}): string[] {
  const { to, from, needsEnd, files } = args;
  const move = [`this conversation goes to ${to} and continues there.`];
  if (needsEnd) move.push('It ends first.');
  if (files) move.push(files);
  return [
    `Move conversation: ${move.join(' ')}`,
    `Start a new one there: this conversation is completed and stays readable in ${from}, and a new, empty one opens in ${to}.`,
    'Either way, its tasks keep running where they are.',
  ];
}

/** The confirmation when only a new conversation can open there: why, first, when there is one. */
export function changeNewParagraphs(args: {
  to: string;
  from: string | null;
  outgoing: OutgoingCoordinator;
  reason: string | null;
}): string[] {
  const { to, from, outgoing, reason } = args;
  const where = from ? ` in ${from}` : '';
  const paragraphs: string[] = [];
  if (reason && outgoing !== 'none') paragraphs.push(`This conversation can’t come along: ${sentence(reason)}`);
  if (outgoing === 'open') {
    paragraphs.push(`It is completed — a turn in flight finishes first — and stays readable${where}. A new, empty one opens in ${to}.`);
  } else if (outgoing === 'completed') {
    paragraphs.push(`It stays completed and readable${where}. A new, empty one opens in ${to}.`);
  } else {
    paragraphs.push(`A new, empty one opens in ${to}.`);
  }
  paragraphs.push('Its tasks keep running where they are.');
  return paragraphs;
}

export const changeNewAction = (to: string, outgoing: OutgoingCoordinator): string =>
  outgoing === 'open' ? `Complete and start in ${to}` : `Start in ${to}`;
