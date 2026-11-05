import { TRASH_RETENTION_DAYS } from '@orbit/shared';

/**
 * What keeps a session in Trash past its 30 days, as `GET /sessions/:id` says: the hourly purge leaves it while one of its
 * files is pinned, or cited by evidence and not yet expired (apiserver files/file-retention.ts).
 */
export type TrashHold = 'PINNED_FILE' | 'CITED_FILE';

const DAY_MS = 86_400_000;

/**
 * The words after `In Trash` on a trashed conversation. A date would be untrue of a session a file is holding, however far
 * past it the session is, so what holds it is said instead. A server older than the hold sends no `hold`, and gets the date.
 */
export function trashNoteWhen(
  deletedAt: string | Date | null | undefined,
  hold: TrashHold | null | undefined,
  now: number = Date.now(),
): string {
  if (hold === 'PINNED_FILE') return ' · kept while a file in it is pinned';
  if (hold === 'CITED_FILE') return ' · kept while evidence cites a file in it';
  if (!deletedAt) return '';
  const left = Math.max(0, Math.ceil((new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * DAY_MS - now) / DAY_MS));
  return left <= 0 ? ' · deletes soon' : ` · auto-deletes in ${left} day${left === 1 ? '' : 's'}`;
}
