/**
 * Starting a project's next coordinator in a workspace the owner picks
 * (docs/mocks/coordinator-move-workspace/03-final ④–⑥): the picker's rows and the confirmation's
 * words. The server's `POST /projects/:id/coordinator/replace` with `{ workspaceId }` does the work;
 * a workspace it would refuse (`sessions.create`: disabled, or on no runner) is greyed here with the
 * same reason, so the press is not offered where it cannot succeed.
 */

export const START_COORDINATOR_COPY = {
  menuTitle: 'Start a new coordinator in…',
  menuDetail: 'The same, in a workspace you pick. This project is coordinated from there afterwards.',
  pickerTitle: 'Start a new coordinator in…',
  current: 'Current',
  runnerOffline: 'Runner offline',
  pickerFoot: "The new coordinator starts empty, on the workspace’s own engine and account.",
  disabled: 'This workspace is disabled.',
  noRunner: 'This workspace has no runner.',
  keep: 'Keep this coordinator',
  /** The Move panel's way out for a row whose conversation cannot come along. */
  startNewHere: 'Start new here…',
} as const;

/** A workspace as `GET /workspaces` lists it — only what the picker reads. */
export interface PickerWorkspace {
  id: string;
  name: string;
  enabled?: boolean;
  runnerId?: string | null;
  runner?: { name?: string | null; displayName?: string | null } | null;
  lastProvider?: string | null;
}

export interface CoordinatorWorkspaceRow {
  workspaceId: string;
  name: string;
  provider: string;
  /** `<Provider> · <runner>`, or why a new coordinator cannot open there. */
  detail: string;
  /** Null when a new coordinator can open here. */
  reason: string | null;
  current: boolean;
  runnerOffline: boolean;
}

/** The picker's rows, in the sidebar's order (the list's own). */
export function coordinatorWorkspaceRows(
  workspaces: readonly PickerWorkspace[],
  currentWorkspaceId: string | null,
  onlineRunnerIds: ReadonlySet<string> | null,
  providerName: (slug: string) => string,
): CoordinatorWorkspaceRow[] {
  return workspaces.map((w) => {
    const reason = w.enabled === false
      ? START_COORDINATOR_COPY.disabled
      : !w.runnerId
        ? START_COORDINATOR_COPY.noRunner
        : null;
    const provider = w.lastProvider || 'claude';
    const runnerName = w.runner?.displayName || w.runner?.name || null;
    return {
      workspaceId: w.id,
      name: w.name,
      provider,
      detail: reason ?? [providerName(provider), runnerName].filter(Boolean).join(' · '),
      reason,
      current: w.id === currentWorkspaceId,
      // Unknown liveness (the runner list not read yet) is no pill rather than a wrong one.
      runnerOffline: reason == null && !!w.runnerId && onlineRunnerIds != null && !onlineRunnerIds.has(w.runnerId),
    };
  });
}

/** What the conversation being left behind is, for the confirmation's first paragraph. */
export type OutgoingCoordinator = 'open' | 'completed' | 'none';

export const startCoordinatorTitle = (workspace: string): string =>
  `Start a new coordinator in ${workspace}?`;

/** The confirmation's paragraphs: where the old conversation stays, and what moves with the new one. */
export function startCoordinatorParagraphs(args: {
  project: string;
  to: string;
  from: string | null;
  outgoing: OutgoingCoordinator;
}): string[] {
  const { project, to, from, outgoing } = args;
  const where = from ? ` in ${from}` : '';
  const paragraphs: string[] = [];
  if (outgoing === 'open') {
    paragraphs.push(`The current conversation is completed — a turn in flight finishes first — and stays readable${where}.`);
  } else if (outgoing === 'completed') {
    paragraphs.push(`The current conversation stays completed and readable${where}.`);
  }
  paragraphs.push(
    `${project} is coordinated from a new, empty conversation in ${to}, and its row moves to ${to}’s list. Its tasks keep running where they are.`,
  );
  return paragraphs;
}

export const startCoordinatorAction = (workspace: string, outgoing: OutgoingCoordinator): string =>
  outgoing === 'open' ? `Complete and start in ${workspace}` : `Start in ${workspace}`;
