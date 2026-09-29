import { encodeId } from './idCodec';

/**
 * A link to one record of a session's transcript — a turn, an event or a tool call — and what the
 * session page does with it: `/sessions/<session>?at=<record>` opens the session scrolled to that
 * record and marks it for a moment (criterion 10 v2: a wiki footnote's location link).
 *
 * The link names the record, never a seq. A seq is the transcript's own ordering and means nothing
 * outside it, while the record's id is what a wiki source stores and what the server resolves:
 * `GET /sessions/:id/events/page?around=<record>` answers with the page the record sits in and the seq
 * it resolved to (an event is itself, a turn the message it sent, a tool call its tool_use).
 *
 * OrbitKit's `DeepLink.swift` reads the same parameter on iOS, from `orbit://session/<id>?at=<record>`
 * and from a page URL of this deployment, so a link opens on the same record in either client.
 */

/** The query parameter a session URL names its record in. */
export const RECORD_PARAM = 'at';

/** How long the record a link opened stays marked — long enough to find it after the jump. */
export const RECORD_FLASH_MS = 2400;

/** The page that opens a session at one record, both ids in their public spelling. */
export function sessionRecordHref(sessionId: string, recordId: string): string {
  return `/sessions/${encodeURIComponent(encodeId(sessionId))}?${RECORD_PARAM}=${encodeURIComponent(encodeId(recordId))}`;
}

/**
 * The record a session URL names, in its public spelling — or null when it names none, or names
 * something that is not an id: a malformed link opens the session at its latest message, as a link
 * without the parameter does, rather than at an error.
 */
export function recordAtOf(search: URLSearchParams): string | null {
  const raw = search.get(RECORD_PARAM)?.trim();
  if (!raw) return null;
  try {
    return encodeId(raw);
  } catch {
    return null;
  }
}

/**
 * The element a seq's card starts at: the last `data-seq` stamp at or before it. Document order is
 * seq order, so an event folded inside a card — a tool result under its call, a run of grouped
 * calls — resolves to the card that shows it. The same rule ⌘F lands on a hit with.
 */
export function elementForSeq(root: ParentNode, seq: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>('[data-seq]')) {
    const s = Number(el.dataset.seq);
    if (Number.isFinite(s) && s <= seq) best = el;
    else if (s > seq) break;
  }
  return best;
}

/**
 * How far to scroll the transcript so a record sits where a reader looks first: centred when it fits
 * in the view with room to spare, otherwise its top `margin` under the top of the view — a long reply
 * is read from its start.
 */
export function recordScrollDelta(
  view: { top: number; height: number },
  record: { top: number; height: number },
  margin = 96,
): number {
  const gap = record.height <= view.height - 2 * margin ? (view.height - record.height) / 2 : margin;
  return record.top - view.top - gap;
}
