import type { ShareLink } from '../api';
import { ago } from './watches';

/**
 * The words and small facts the Share dialog and Settings → Shared links both say about a public
 * link (docs/share-links-design.md §2, §8), so the two cannot drift apart.
 */

/** The public address of a link — what its owner copies and hands out. */
export const publicLinkUrl = (token: string): string => `${window.location.origin}/s/${token}`;

/** The same page as its owner's Preview opens it: `?preview=1`, which the link does not count as a
 *  view (its root page passes the flag on to the server). */
export const previewUrl = (token: string): string => `${publicLinkUrl(token)}?preview=1`;

/** "Oct 2", the way the dialog and the list name a day. */
export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "Viewed 14 times · last 2h ago", or "Not opened yet". Only opening the root page counts. */
export function viewsLine(link: Pick<ShareLink, 'viewCount' | 'lastViewedAt'>, now: number): string {
  if (link.viewCount === 0) return 'Not opened yet';
  const times = link.viewCount === 1 ? 'once' : `${link.viewCount} times`;
  return link.lastViewedAt ? `Viewed ${times} · last ${ago(link.lastViewedAt, now)}` : `Viewed ${times}`;
}

/** Expires: Never (the default) or a number of days from now; expiring ends the link. */
export const EXPIRY_CHOICES: readonly { value: string; label: string; days: number | null }[] = [
  { value: 'never', label: 'Never', days: null },
  { value: '1', label: '1 day', days: 1 },
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
];

/** "N link(s)"-style counts: "1 message", "77 messages". */
export const countOf = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * What a link lets a visitor see, one chip per layer it includes, in the dialog's order. The first
 * is the root's own content, which every link includes. Conversations is the chip to notice: it can
 * carry command output and file contents.
 */
export function includeChips(link: Pick<ShareLink, 'kind' | 'include'>): { label: string; warn?: true }[] {
  const on = (layer: keyof ShareLink['include'], fallback: boolean) => link.include[layer] ?? fallback;
  if (link.kind === 'SESSION') {
    return [{ label: 'Messages' }, ...(on('toolOutput', true) ? [{ label: 'Tool output' }] : [])];
  }
  return [
    { label: 'Overview' },
    ...(link.kind === 'PROJECT' && on('taskPages', true) ? [{ label: 'Task pages' }] : []),
    ...(on('commentsAndFiles', false) ? [{ label: 'Comments' }] : []),
    ...(on('conversations', false) ? [{ label: 'Conversations', warn: true as const }] : []),
  ];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The open links whose session was completed more than 30 days ago: still opening for anyone who
 * has them, for a conversation nobody is working in any more. What the list's banner offers to
 * turn off in one go.
 */
export function staleSessionLinks(links: readonly ShareLink[], now: number): ShareLink[] {
  return links.filter((link) => {
    if (link.state !== 'ACTIVE' || link.kind !== 'SESSION' || !link.root.completedAt) return false;
    const at = Date.parse(link.root.completedAt);
    return Number.isFinite(at) && now - at > THIRTY_DAYS_MS;
  });
}
