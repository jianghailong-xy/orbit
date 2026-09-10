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
