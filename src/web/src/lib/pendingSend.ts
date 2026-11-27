import type { AcceptedUserTurn } from './acceptedUserTurn';

/**
 * A message typed in the composer leaves it at the press and waits in the transcript as its own
 * bubble, `Sending…`, until the server takes it (docs/mocks/composer-sending-bubble). These are the
 * pieces of that which are not React: how long the composer waits for an answer, the error that
 * waiting out becomes, and the bubble list's three moves.
 */

/** How long a send waits for the server's answer before its bubble says `Not sent` (decision Ⓑ). A
 *  send normally comes back in well under a second; reviving an ended session takes a few. */
export const SEND_ANSWER_TIMEOUT_MS = 20_000;

/** The send had no answer in time. Its request was ended, so it may or may not have reached the
 *  server: Retry sends the same `clientTurnId`, which the server answers with the turn it already
 *  took rather than taking a second one. */
export class SendNotAnsweredError extends Error {
  constructor() {
    super("The server didn't answer in 20 seconds. Retry sends the same message again; it can't arrive twice.");
    this.name = 'SendNotAnsweredError';
  }
}

/** The composer's Stop had no answer in time either: the same limit, said for a stop. */
export const STOP_NOT_ANSWERED = "The server didn't answer in 20 seconds. Press Stop to try again.";

/** A signal that ends the request when the answer is late, and `done` to call once it has come. */
export function answerDeadline(ms = SEND_ANSWER_TIMEOUT_MS): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new SendNotAnsweredError()), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

/** Whether a failed send failed because its answer was late (the fetch rejects with the abort reason). */
export function isSendNotAnswered(e: unknown): boolean {
  return e instanceof SendNotAnsweredError || (e instanceof DOMException && e.name === 'AbortError');
}

/** The newest seq in a transcript: a pending send's echo is a user event after it. */
export function newestSeq(events: readonly { seq: number }[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

/** Add a pending send's bubble, or put a `Not sent` one back to `Sending…` for its Retry. */
export function withPendingSend(current: readonly AcceptedUserTurn[], turn: AcceptedUserTurn): AcceptedUserTurn[] {
  return [...current.filter((t) => t.key !== turn.key), turn].slice(-32);
}

/** The bubble says `Not sent`, with why in its tooltip. */
export function markNotSent(current: AcceptedUserTurn[], key: string, reason: string): AcceptedUserTurn[] {
  let changed = false;
  const next = current.map((turn) => {
    if (turn.key !== key || !turn.pending) return turn;
    changed = true;
    return { ...turn, pending: { ...turn.pending, state: 'notSent' as const, reason } };
  });
  return changed ? next : current;
}

/** The bubble leaves: the server took it (and the ordinary accepted bubble or the queue draws it),
 *  or it went back into the composer. */
export function dropPendingSend(current: AcceptedUserTurn[], key: string): AcceptedUserTurn[] {
  const next = current.filter((turn) => turn.key !== key);
  return next.length === current.length ? current : next;
}
