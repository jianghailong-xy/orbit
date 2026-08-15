/**
 * Separating what a person typed from what Orbit appended to it.
 *
 * Two features add context to a message at delivery — `#`-reference expansion and a task list's
 * condition board. Both deliberately leave `conversation_turn.content` alone, so the durable
 * record of what was sent is the person's own words. But the runner echoes what it *received*
 * into the transcript, which is what the UI renders: the result was a one-line question followed
 * by a block of generated status text, inside the user's own bubble, looking for all the world
 * like they had typed it.
 *
 * Stripping it outright would trade that for a worse problem — the agent answering about a quota
 * outage nobody appears to have mentioned. So the blocks come out of the bubble body and are
 * replaced by one muted line naming what was attached, with the full text on hover. The record is
 * untouched; only the reading of it changes.
 */

/** The blocks Orbit appends at delivery. Nothing else is ever removed from a person's message. */
const INJECTED_TAGS = ['referenced-list', 'referenced-task', 'list-conditions'] as const;

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

/** A block's closing tag, at the very end of what is left. */
const CLOSE_AT_END = new RegExp(`\\n</(${INJECTED_TAGS.join('|')})>\\s*$`);

/**
 * Split a delivered message into what was typed and what was appended to it.
 *
 * Works backwards from the end — where delivery appends — rather than matching anywhere, because
 * a person is entitled to write `<list-conditions>` in the middle of a sentence without having it
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

const TAG_LABEL: Record<InjectedTag, string> = {
  'referenced-list': 'referenced list',
  'referenced-task': 'referenced task',
  'list-conditions': 'list conditions',
};

/**
 * "referenced list, list conditions ×2" — what was attached, counted where it repeats.
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
