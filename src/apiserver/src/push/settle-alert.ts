import { RunStatus } from '@prisma/client';

/** The session fields the decision below reads — nothing else is load-bearing. */
export interface SettleInput {
  status: RunStatus | string;
  retryAt: Date | null;
  completedAt: Date | null;
  deletedAt: Date | null;
  error?: string | null;
  /** The rolling recap (Session.recapText), when one has been written — see the body rule below. */
  recapText?: string | null;
}

/** What to say about a settled session, or null for "this is not worth an interruption". */
export interface SettleAlert {
  /** Mirrors the `kind` the macOS shell puts on its own local notification for the same event. */
  kind: 'finished' | 'failed';
  /** Alert body. The session's title is the alert *title*, so this only says what happened. */
  body: string;
}

/** Longest error excerpt worth carrying — a lock-screen line, not a stack trace. */
const MAX_ERROR_CHARS = 120;

/**
 * Longest body a notification carries, in characters — the same limit `agent-alert.ts` applies.
 * Both bodies are prose a model wrote, so both are sized by what a lock-screen line holds;
 * `MAX_ERROR_CHARS` above is a different thing, an excerpt of a machine's error text.
 */
const MAX_BODY_CHARS = 200;

/**
 * Whether a session that just reached a terminal status is worth pushing to its owner's phone,
 * and what to say. Pure so the edge cases below are testable without Prisma or APNs.
 *
 * The rule is "did this happen on its own, and is it over": a notification exists to pull
 * someone back who has walked away, so anything they did themselves — ending the session,
 * stopping the run, filing it — is never announced back to them, and anything the server is
 * about to undo is not an outcome yet. That leaves exactly two events, which is also what the
 * macOS shell derives locally from its own polling (OrbitKit `SessionDelta`): a run that
 * succeeded, and a run that failed. Keeping the two derivations agreeing is why this mirrors
 * `isSettled` rather than inventing a second definition of "done".
 *
 * When the session has a recap it is the body: "Finished" says only that the wait is over, while
 * the recap says what the wait was for. The two events above still decide *whether* to announce,
 * so a recap never turns a deliberate end into an interruption — only what it says once one is
 * already going to.
 */
export function settleAlert(s: SettleInput): SettleAlert | null {
  // A retry the server has already armed is a failure it intends to undo by itself
  // (AutoRetryService re-sends the same message once the quota/provider/runner is back).
  // Announcing it reports a failure the user never had.
  if (s.retryAt) return null;
  // Trashed — whatever it did, its owner is done with it.
  if (s.deletedAt) return null;
  // SUCCEEDED is only ever reached by a run that finished on its own: either the runner
  // finalized it that way, or a task ran to DONE and `gracefulEndStatus` settled it. Both mean
  // nobody was necessarily watching. `completedAt` is deliberately NOT checked here — the
  // task_done path files the session in Completed as part of ending it, so requiring an
  // unfiled row would drop the single most important notification this function exists for.
  const kind: SettleAlert['kind'] | null =
    s.status === RunStatus.SUCCEEDED
      ? 'finished'
      : // A failure its owner has already filed to Completed is one they have already seen.
        s.status === RunStatus.FAILED && !s.completedAt
        ? 'failed'
        : // Everything else that is terminal is CANCELLED, which is only ever reached
          // deliberately — the user ended the session, stopped the run, or cancelled its task.
          // INTERRUPTED isn't terminal at all, and neither are the live statuses.
          null;
  if (!kind) return null;
  const recap = recapBody(s.recapText);
  return { kind, body: recap ?? (kind === 'finished' ? 'Finished' : failureLine(s.error)) };
}

/**
 * The recap as an alert body, or null for "there is none to prefer".
 *
 * Whitespace is collapsed the way `agentAlert` does it — a recap is stored as one line already
 * (recap.ts trims it and caps it at `RECAP_MAX_CHARS`), but a legacy row written before that, or
 * a value that somehow escaped it, must not put a newline in a lock screen. Clipping rather than
 * refusing is the same call: the first sentence is what decides whether someone comes to look.
 * A recap that is present but empty is not a recap, so the rules above still speak.
 */
function recapBody(recapText: string | null | undefined): string | null {
  const text = (recapText ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`;
}

/** One readable line out of a run's error text — the first thing that says something. */
function failureLine(error: string | null | undefined): string {
  const line = (error ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return 'Failed';
  const excerpt =
    line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1).trimEnd()}…` : line;
  return `Failed · ${excerpt}`;
}
