/**
 * Separating what a person typed from what Orbit appended to it.
 *
 * Orbit can add context to a message at delivery — `#`-reference expansion, a task list's
 * condition board, the background work a returning engine is told about, and the standing role of
 * a conversation promoted to project coordinator. These deliberately leave
 * `conversation_turn.content` alone, so the durable record of what was sent is the person's own
 * words. But the runner echoes what it *received* into the transcript, which is what the UI
 * renders: the result was a one-line question followed by a block of generated context, inside the
 * user's own bubble, looking for all the world like they typed it.
 *
 * Stripping it outright would trade that for a worse problem — the agent answering about a quota
 * outage nobody appears to have mentioned. So the appended part comes out of the bubble body and is
 * shown as Orbit's instead. The record is untouched; only the reading of it changes.
 *
 * Where the person's words end is what the apiserver recorded when it stored the event
 * (`controlPlaneNote`, see splitRecordedNote), never what the text happens to look like: someone
 * who types a `<background-jobs>` block into the composer sees it in their bubble exactly as typed.
 * An event with no note is still read the older way below, from its end, which is what keeps the
 * bubbles of messages stored before notes were recorded as they were.
 */

/**
 * The blocks an event with no recorded note is still read for. `<list-conditions>` and
 * `<background-jobs>` are not among them: those two are told apart by the note alone, so typing one
 * into the composer never makes it disappear.
 */
const INJECTED_TAGS = [
  'referenced-list',
  'referenced-task',
  'orbit_project_coordinator_context',
] as const;

export type InjectedTag = (typeof INJECTED_TAGS)[number];

export interface InjectedBlock {
  tag: InjectedTag;
  /** The block verbatim, including its tags — this is what the model actually read. */
  text: string;
}

export interface DeliveredMessage {
  /** What the person typed. */
  text: string;
  /** What was appended to it, in the order it was appended. */
  injected: InjectedBlock[];
}

/**
 * A `user` event's text split where the apiserver recorded that the person's words end.
 *
 * `controlPlaneNote` is exactly what delivery appended, stored beside an echo that is left whole,
 * so the split is a slice rather than a reading of the text. `note` comes back trimmed, as the block
 * the model read. Null when the event carries no such note.
 */
export function splitRecordedNote(payload: unknown): { text: string; note: string } | null {
  const { text, controlPlaneNote: note } = (payload ?? {}) as {
    text?: unknown;
    controlPlaneNote?: unknown;
  };
  if (typeof text !== 'string' || typeof note !== 'string' || !note.trim() || !text.endsWith(note)) {
    return null;
  }
  return { text: text.slice(0, text.length - note.length), note: note.trim() };
}

/** A block's closing tag, at the very end of what is left. */
const CLOSE_AT_END = new RegExp(`\\n</(${INJECTED_TAGS.join('|')})>\\s*$`);

/**
 * Split a delivered message into what was typed and what was appended to it.
 *
 * Works backwards from the end — where delivery appends — rather than matching anywhere, because
 * a person is entitled to write `<referenced-task>` in the middle of a sentence without having it
 * silently eaten.
 *
 * Finding the close first and then its opening, rather than one regex spanning both, is what
 * makes two *identical adjacent* blocks come out as two. A single pattern with a backreference
 * and an end anchor cannot: its lazy middle expands straight past the first closing tag to reach
 * the anchor, swallowing both blocks into one. Delivery appends two `<referenced-task>` blocks
 * whenever a message names two tasks, so that is the ordinary case rather than a corner.
 */
export function splitDeliveredMessage(raw: string): DeliveredMessage {
  let text = raw;
  const injected: InjectedBlock[] = [];
  for (;;) {
    const close = CLOSE_AT_END.exec(text);
    if (!close) break;
    const tag = close[1] as InjectedTag;
    const open = text.lastIndexOf(`\n\n<${tag}`, close.index);
    if (open < 0) break;
    // `<tag>` or `<tag ...>`, never `<tag-something-else>`.
    if (!/^[\s>]/.test(text.slice(open + 3 + tag.length))) break;
    injected.unshift({ tag, text: text.slice(open, close.index + close[0].length).trim() });
    text = text.slice(0, open);
  }
  return { text, injected };
}

/** The latest authored user text in echoed events, with the first-turn prompt fallback. */
export function lastTypedUserMessageText(
  events: readonly { type: string; payload?: unknown }[],
  openingPrompt?: string | null,
  numTurns?: number,
): string {
  // Split each candidate before deciding whether it carries text. A promoted coordinator's
  // image-only turn has a non-empty echo made solely of delivery context; choosing first and
  // splitting second would stop there and hide the older message that can actually be retried.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'user') continue;
    const echoed = (events[i].payload as { text?: unknown } | undefined)?.text;
    if (typeof echoed !== 'string') continue;
    const typed = splitRecordedNote(events[i].payload)?.text ?? splitDeliveredMessage(echoed).text;
    if (typed.trim()) return typed;
  }
  return numTurns === 0 && openingPrompt?.trim() ? openingPrompt : '';
}

const TAG_LABEL: Record<InjectedTag, string> = {
  'referenced-list': 'referenced list',
  'referenced-task': 'referenced task',
  orbit_project_coordinator_context: 'project coordinator context',
};

/**
 * "referenced list, referenced task ×2" — what was attached, counted where it repeats.
 *
 * Named rather than merely counted: "2 blocks attached" tells the reader nothing about why the
 * reply mentions something they never asked about, which is the entire reason this line exists.
 */
export function describeInjected(injected: InjectedBlock[]): string {
  const counts = new Map<InjectedTag, number>();
  for (const b of injected) counts.set(b.tag, (counts.get(b.tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, n]) => (n > 1 ? `${TAG_LABEL[tag]} ×${n}` : TAG_LABEL[tag]))
    .join(', ');
}
