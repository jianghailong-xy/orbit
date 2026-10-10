/**
 * run_event.type values that mean a runtime actually produced output for a turn — it received the
 * message and started working, so the message is part of the conversation a `claude --resume`
 * restores. Presence of any of these on a re-delivered message turn is the signal that it must
 * NOT be re-fed verbatim (see dequeueTurn / buildResumeContinuation).
 */
export const RUNTIME_STARTED_EVENT_TYPES = ['assistant', 'thinking', 'tool_use'] as const;

// OpenCode's JSON stream reports tool_use only after the tool has completed. Its
// turn-scoped step_start system event closes the side-effect replay window before that.
export const RUNTIME_STARTED_SYSTEM_SUBTYPE = 'step_start';

// Cap on how much of the interrupted message we quote back — enough to orient claude without
// re-emphasizing a long instruction it should verify-then-continue rather than re-run.
const MAX_QUOTED = 1000;

/**
 * The prompt delivered in place of a user message when its turn is re-delivered after being
 * interrupted mid-flight — its runner died/restarted before acking, so the inbox's at-least-once
 * lease re-delivers it. `claude --resume` has already restored the original message and whatever
 * the interrupted turn managed to do, so re-feeding the original text would re-run its side
 * effects (the motivating case: a deploy that restarted this very runner, then ran a second time).
 * This drives claude to continue from the restored state instead, and explicitly warns it off
 * repeating completed side effects. The original is quoted (capped) only for orientation.
 */
export function buildResumeContinuation(original: string | null | undefined): string {
  const head =
    '[Orbit] The last message you were working on was interrupted because its runner restarted; the ' +
    'conversation so far has been restored. First check the actual current state, then carry on and finish ' +
    'it — never repeat any operation with side effects that has already completed ' +
    '(for example a deploy, commit, push or send, or creating or deleting a resource).';
  const quoted = (original ?? '').trim();
  if (!quoted) return head;
  const preview = quoted.length > MAX_QUOTED ? quoted.slice(0, MAX_QUOTED) + '…' : quoted;
  return `${head}\n\nThe interrupted message:\n${preview}`;
}
