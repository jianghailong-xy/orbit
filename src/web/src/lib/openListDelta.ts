/**
 * The Open list read as a delta (`GET /sessions?view=open&since=<cursor>`, docs/list-freshness-design.md
 * §3), the web's port of OrbitKit's OpenListReader and OpenListDelta.
 *
 * Each scope keeps the cursor the server last gave it and the list exactly as the server sent it under
 * that cursor (the base). A delta is applied to that base, never to the cache entry the screen draws:
 * that copy is written by optimistic edits, and a delta applied over them would keep an edit the server
 * turned down. So what a read returns is the list a whole read would have returned, in the server's
 * order. Each read hands out its own array over the base's rows, so an edit to the screen's array
 * cannot reach the base. An empty delta hands out the base's rows as they are, and React Query's
 * structural sharing then keeps the cache entry's reference, so no row draws again; it keeps the rows
 * a delta did not touch by reference too.
 *
 * The server answers `full: true` with the whole list and a fresh cursor for a first read and for any
 * cursor it no longer holds; that list replaces the base. A delta that does not fit its base (a row the
 * order names that neither side has, an upsert outside the order) is answered with one whole read.
 * A server that predates the delta read ignores `since` and answers the plain array, which is taken as
 * it is, with no cursor kept.
 */

export interface OpenListDelta<T> {
  full: false;
  upserts: T[];
  removedIds: string[];
  /** Every id in list order, present only when the order moved. */
  order?: string[] | null;
  cursor: string;
}

export type OpenListAnswer<T> = T[] | { full: true; sessions: T[]; cursor: string } | OpenListDelta<T>;

const isEmpty = (delta: OpenListDelta<unknown>): boolean =>
  delta.upserts.length === 0 && delta.removedIds.length === 0 && !delta.order;

/**
 * `base`, the list as the server last sent it under the cursor `delta` answers, brought up to the
 * server's list now. null when the two cannot be the same list.
 */
export function applyOpenListDelta<T extends { id: string }>(base: readonly T[], delta: OpenListDelta<T>): T[] | null {
  const fresh = new Map(delta.upserts.map((row) => [row.id, row]));
  if (delta.order) {
    const held = new Map<string, T>();
    for (const row of base) if (!held.has(row.id)) held.set(row.id, row);
    const list: T[] = [];
    for (const id of delta.order) {
      const row = fresh.get(id) ?? held.get(id);
      if (!row) return null;
      list.push(row);
    }
    const ordered = new Set(delta.order);
    for (const id of fresh.keys()) if (!ordered.has(id)) return null;
    return list;
  }
  // No order: every row kept its place, so nothing can have been added.
  const removed = new Set(delta.removedIds);
  const list: T[] = [];
  let replaced = 0;
  for (const row of base) {
    if (removed.has(row.id)) continue;
    const update = fresh.get(row.id);
    if (update) replaced += 1;
    list.push(update ?? row);
  }
  return replaced === fresh.size ? list : null;
}

/** Per scope: the cursor the server last gave, and the list as it sent it under that cursor. */
const held = new Map<string, { cursor: string; base: { id: string }[] }>();

/** Forgets every scope's cursor (tests; a signed-out tab has nothing to ask a delta against). */
export function forgetOpenListCursors(): void {
  held.clear();
}

/**
 * One read of the Open list of `scope`. `get` asks the server with the `since` it is given (`''` for
 * a first read, which the server answers whole).
 */
export async function readOpenList<T extends { id: string }>(
  scope: string,
  get: (since: string) => Promise<OpenListAnswer<T>>,
): Promise<T[]> {
  const mine = held.get(scope) as { cursor: string; base: T[] } | undefined;
  const answer = await get(mine?.cursor ?? '');
  if (Array.isArray(answer)) {
    held.delete(scope);
    return answer;
  }
  if (answer.full) {
    held.set(scope, { cursor: answer.cursor, base: answer.sessions });
    return [...answer.sessions];
  }
  if (mine) {
    const list = isEmpty(answer) ? mine.base : applyOpenListDelta(mine.base, answer);
    if (list) {
      held.set(scope, { cursor: answer.cursor, base: list });
      return [...list];
    }
  }
  // A delta with no base here, or one that does not fit it: read the list whole.
  held.delete(scope);
  const whole = await get('');
  if (Array.isArray(whole)) return whole;
  if (whole.full) {
    held.set(scope, { cursor: whole.cursor, base: whole.sessions });
    return [...whole.sessions];
  }
  throw new Error('The server answered a first Open-list read with a delta.');
}
