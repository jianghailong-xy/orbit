import type { OpenItemDeliveryCard, TaskStartCard } from '@orbit/shared';

import { buildResumeContinuation } from './resume-continuation';

/**
 * The part of a delivered message the control plane appended, recorded beside the runner's echo.
 *
 * Delivery appends context to a person's message — `#`-reference summaries, a list console's
 * condition board, the background work a returning engine is told about, a promoted coordinator's
 * standing role — and leaves `conversation_turn.content` as the words they wrote. The runner echoes
 * what it was handed as the `user` event, so that event's text is both at once, and every client
 * drew all of it inside the person's own bubble: blocks that say "不是用户说的", signed by the user.
 *
 * Where their words end is known when the event is stored, without reading the text for anything
 * shaped like a block: the echo is the turn's content — or, for an interrupted turn handed out
 * again, the continuation that replaced it — followed by what delivery added. The note is exactly
 * that remainder. Someone who typed a `<background-jobs>` block themselves typed it into the turn,
 * so it stays theirs; and an echo that does not begin with what was written gets no note at all,
 * so a note can only ever hold text the person provably did not write.
 */
export function controlPlaneNoteOf(echoed: string, authored: string | null): string | null {
  // The continuation first: an empty authored text is a prefix of every echo, while the
  // continuation's head is nothing a person types.
  for (const delivered of [buildResumeContinuation(authored), authored ?? '']) {
    if (!echoed.startsWith(delivered)) continue;
    const note = echoed.slice(delivered.length);
    return note.trim() ? note : null;
  }
  return null;
}

/**
 * A `user` event's payload as it is stored: `text` untouched — it is what the engine read, and a
 * transcript rebuilt for a resumed engine replays it — with `controlPlaneNote` beside it when
 * delivery appended something. `authored` is the turn's content, or undefined when there is no turn
 * to say what was written. A note arriving from the runner is dropped either way: only the control
 * plane knows what it appended.
 */
export function withControlPlaneNote(
  payload: Record<string, unknown>,
  authored: string | null | undefined,
): Record<string, unknown> {
  if (typeof payload?.text !== 'string') return payload;
  const stored = { ...payload };
  delete stored.controlPlaneNote;
  const note = authored === undefined ? null : controlPlaneNoteOf(payload.text, authored);
  if (note !== null) stored.controlPlaneNote = note;
  return stored;
}

/**
 * The same rule for the reading a control-plane turn is drawn FROM rather than the one appended to
 * it: `openItemDelivery` is what an exception item's delivery carries beside its words — the item's
 * kind, its title, the files a merge conflicted on, the doors that exist, and the landing the
 * platform already knew (`OpenItemDeliveryCard`).
 *
 * A delivery to the coordinator is 30 lines of prose and, without this, nothing else: the fields the
 * item was opened with are rendered into that paragraph and dropped, so a client draws the turn as
 * a message somebody typed and a reader has to take the paragraph's word for everything in it.
 *
 * `null` is the ordinary case and not a failure — most turns are a person's — so a card of null
 * means the payload is stored with the field ABSENT rather than empty, the same way a note that was
 * not recorded leaves no key. And a card arriving from the runner is dropped for the same reason a
 * note is: only the control plane knows what it wrote for a turn.
 */
export function withOpenItemDelivery(
  payload: Record<string, unknown>,
  card: OpenItemDeliveryCard | null,
): Record<string, unknown> {
  if (typeof payload?.text !== 'string') return payload;
  const stored = { ...payload };
  delete stored.openItemDelivery;
  if (card !== null) stored.openItemDelivery = card;
  return stored;
}

/**
 * The same rule for the turn that starts a task's run: `taskStart` is the task as its brief was
 * built from it (`TaskStartCard`, tasks/task-start-card.ts), recorded beside the echo so a client can
 * draw the brief as a card rather than as the owner's own message. Absent — not empty — for every
 * other turn, and a card arriving from the runner is dropped for the reason the two above give.
 */
export function withTaskStart(
  payload: Record<string, unknown>,
  card: TaskStartCard | null,
): Record<string, unknown> {
  if (typeof payload?.text !== 'string') return payload;
  const stored = { ...payload };
  delete stored.taskStart;
  if (card !== null) stored.taskStart = card;
  return stored;
}
