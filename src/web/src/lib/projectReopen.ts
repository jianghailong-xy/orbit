import type { ProjectReopenAskerView, ProjectReopenPayload } from '@orbit/shared';
import type { OwnerRequest } from './ownerRequests';
import { sameResourceId } from './watches';

/**
 * PROJECT_REOPEN on the web (docs/project-reopen-request-design.md §6; board docs/mocks/project-reopen-request): the words
 * the card, its one-line folds and the project page's row are drawn with, and the rules with no component in them.
 */

export const PROJECT_REOPEN_COPY = {
  heading: (title: string) => `↺ Reopen project “${title}”?`,
  doneSince: (date: string) => `DONE since ${date}`,
  cancelledSince: (date: string) => `Cancelled since ${date}`,
  openProject: 'Open project',
  agentSays: (why: string) => `The agent says: ${why}`,
  plannedWork: 'Planned work',
  foot: 'Reopening keeps what was accepted. The project closes again when its criteria are met.',
  askedBy: (title: string) => `Asked by “${title}”`,
  alsoAskedBy: (titles: readonly string[]) => `Also asked by ${titles.map((t) => `“${t}”`).join(', ')}`,
  alsoAskedByOthers: (count: number) => `Also asked by ${count} other session${count === 1 ? '' : 's'}`,
  reopen: 'Reopen',
  chat: '💬 Chat about this',
  declinePlaceholder: 'What should the agent know? It reads this.',
  decline: 'Decline',
  keep: 'Keep it',
  reopened: (title: string, when: string | null) => `Reopened “${title}”${when ? ` · ${when}` : ''}`,
  declined: (reason: string | null) => (reason ? `Declined: ${reason}` : 'Declined'),
  rowTitle: 'An agent asked to reopen this project',
  review: 'Review',
  reviewTitle: 'Reopen request',
} as const;

/** The payload a PROJECT_REOPEN request carries, or null when it is unreadable. */
export function projectReopenPayloadOf(payload: unknown): ProjectReopenPayload | null {
  const p = payload as Partial<ProjectReopenPayload> | null | undefined;
  return p && typeof p === 'object' && typeof p.projectId === 'string' && typeof p.settledAt === 'string'
    ? (p as ProjectReopenPayload)
    : null;
}

/** The project's title, which the server writes into the card's title (`Reopen project “<title>”?`). */
export function projectReopenProjectTitle(request: Pick<OwnerRequest, 'title'>): string {
  return /^Reopen project “([\s\S]*)”\?$/.exec(request.title)?.[1] ?? request.title;
}

/** The waiting PROJECT_REOPEN requests of one project, oldest first. */
export function waitingReopenRequests(requests: readonly OwnerRequest[], projectId: string): OwnerRequest[] {
  return requests
    .filter((r) => r.kind === 'PROJECT_REOPEN' && r.state === 'PENDING'
      && sameResourceId(projectReopenPayloadOf(r.payload)?.projectId ?? '', projectId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every session that asked, with its title when the server named it. The first is the request's own asker. */
export function reopenAskers(request: OwnerRequest): ProjectReopenAskerView[] {
  const asked = (request as { askers?: ProjectReopenAskerView[] }).askers;
  if (Array.isArray(asked) && asked.length > 0) return asked;
  return [{ sessionId: request.askedBySessionId, askedAt: request.createdAt, title: request.askedBySessionTitle ?? null }];
}

/** "Asked by “X”" and, when more sessions joined, "Also asked by …": the card outside the asking session, the row anywhere. */
export function askerLine(request: OwnerRequest, viewedFromSessionId?: string | null): string | null {
  const askers = reopenAskers(request);
  const first = askers[0];
  const others = askers.slice(1);
  const parts: string[] = [];
  const named = (a: ProjectReopenAskerView) => a.title;
  if (first.sessionId !== viewedFromSessionId && named(first)) parts.push(PROJECT_REOPEN_COPY.askedBy(first.title!));
  const otherTitles = others.map(named).filter((t): t is string => Boolean(t));
  if (others.length > 0) {
    parts.push(otherTitles.length === others.length
      ? PROJECT_REOPEN_COPY.alsoAskedBy(otherTitles)
      : PROJECT_REOPEN_COPY.alsoAskedByOthers(others.length));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "Nov 18", the date the project was settled. */
export function settledDate(settledAt: string): string {
  return new Date(settledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
