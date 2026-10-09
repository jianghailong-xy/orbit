// The engine's guess at the person's next message (docs/prompt-suggestions-design.md). The runner
// files it as a `prompt_suggestion` event against the turn it follows; it is never a transcript
// row, only the grey line an empty composer offers with a Use button.

interface EventLike {
  type: string;
  payload?: unknown;
}

/**
 * The suggestion still standing: the newest of user / turn_end / prompt_suggestion, when that is a
 * suggestion. A suggestion always arrives after its own turn's turn_end, so a later turn_end is a
 * newer turn ending (one the engine started itself included), and a later user event is the
 * person — on any device — having already said something.
 */
export function currentPromptSuggestion(events: readonly EventLike[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'prompt_suggestion') {
      const text = (ev.payload as { text?: unknown } | null | undefined)?.text;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    }
    if (ev.type === 'user' || ev.type === 'turn_end') return null;
  }
  return null;
}

/** What the composer has to be for a suggestion to be offered in it (design §4.4). */
export interface PromptSuggestionGate {
  /** No turn in flight: the last one ended and nothing has been sent since. */
  idle: boolean;
  /** Nothing typed and nothing staged. */
  draftEmpty: boolean;
  /** A reply to a question card is armed: the box belongs to that answer. */
  replying: boolean;
  /** Cards waiting on the person — tool approvals and questions, and the owner items the session
   *  summary counts. The card is what to answer, so nothing is guessed beside it. */
  pendingApprovals: number;
  waitingKind?: string | null;
  /** The conversation is Open (not Completed or in the Trash) and a message can reach it. */
  sendable: boolean;
  /** The run failed: its own card says what to do next. */
  failed: boolean;
}

export function offeredPromptSuggestion(suggestion: string | null, gate: PromptSuggestionGate): string | null {
  if (!suggestion) return null;
  if (!gate.idle || !gate.draftEmpty || gate.replying || !gate.sendable || gate.failed) return null;
  if (gate.pendingApprovals > 0 || gate.waitingKind) return null;
  return suggestion;
}
