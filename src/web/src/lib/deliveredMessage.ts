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
 * who types a `<referenced-task>` or `<background-jobs>` block into the composer sees it in their
 * bubble exactly as typed. An event with no note is shown as it was echoed. Events stored before
 * notes were recorded had theirs backfilled by the apiserver's own rule (2026-09-11), so there is no
 * older reading of the text to fall back on.
 */

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

/** The attachment ids a `user` event echoes, whichever of the two shapes it uses. */
function echoedAttachmentIds(payload: unknown): string[] {
  // New events echo `attachments` (id + mime + name, any type); older ones echo `images` (id only).
  // Same reading as the transcript's (see Transcript.tsx), so a retry sends exactly what the bubble
  // above it shows.
  const { attachments, images } = (payload ?? {}) as { attachments?: unknown; images?: unknown };
  const refs = Array.isArray(attachments) ? attachments : Array.isArray(images) ? images : [];
  return refs
    .map((ref) => (ref as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * The latest message a person authored, as a re-send would carry it: their words, and the ids of
 * the attachments that went out with them.
 *
 * Both halves come off the same event, deliberately. The bytes of an attachment are uploaded once
 * and referenced by id for the life of the turn, so a re-send needs nothing from the person to take
 * the files with it — but it has to take THAT message's files. Two separate walks back through the
 * transcript could stop at different events and send one message's words under another's images.
 *
 * The first-turn prompt fallback carries no ids: it is the text the session was opened with, read
 * off the session row rather than off an echoed turn, so there is no event to read refs from.
 */
export function lastTypedUserMessage(
  events: readonly { type: string; payload?: unknown }[],
  openingPrompt?: string | null,
  numTurns?: number,
): { text: string; attachmentIds: string[] } {
  // Split each candidate before deciding whether it carries text. A promoted coordinator's
  // image-only turn has a non-empty echo made solely of delivery context; choosing first and
  // splitting second would stop there and hide the older message that can actually be retried.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'user') continue;
    const echoed = (events[i].payload as { text?: unknown } | undefined)?.text;
    if (typeof echoed !== 'string') continue;
    const typed = splitRecordedNote(events[i].payload)?.text ?? echoed;
    if (typed.trim()) return { text: typed, attachmentIds: echoedAttachmentIds(events[i].payload) };
  }
  return {
    text: numTurns === 0 && openingPrompt?.trim() ? openingPrompt : '',
    attachmentIds: [],
  };
}

/** The latest authored user text in echoed events, with the first-turn prompt fallback. */
export function lastTypedUserMessageText(
  events: readonly { type: string; payload?: unknown }[],
  openingPrompt?: string | null,
  numTurns?: number,
): string {
  return lastTypedUserMessage(events, openingPrompt, numTurns).text;
}

/** What each of Orbit's blocks is called where a recorded note shows it (describeNote). */
const TAG_LABEL: Record<string, string> = {
  'referenced-list': 'referenced list',
  'referenced-task': 'referenced task',
  orbit_project_coordinator_context: 'project coordinator context',
  'list-conditions': 'list conditions',
  'background-jobs': 'background jobs',
};

/** Each name once, in the order first seen, counted where it repeats. */
function countNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

/**
 * "referenced task ×2, background jobs" — what a recorded note holds, counted where it repeats.
 *
 * Named rather than merely counted: "2 blocks attached" tells the reader nothing about why the
 * reply mentions something they never asked about, which is the entire reason this line exists.
 *
 * Only a name. The note was told apart from the person's words by where the apiserver recorded it
 * ends (splitRecordedNote), so nothing here decides what is shown as theirs. Delivery can append
 * several blocks to one message, so each is named by its opening tag and skipped past its closing
 * one; an opening that is not one of Orbit's blocks is still named, generically.
 */
export function describeNote(note: string): string {
  const names: string[] = [];
  let rest = note.trim();
  while (rest) {
    const tag = /^<([\w-]+)[\s>]/.exec(rest)?.[1];
    names.push(tag && Object.hasOwn(TAG_LABEL, tag) ? TAG_LABEL[tag] : 'context');
    const close = tag ? rest.indexOf(`\n</${tag}>`) : -1;
    if (close < 0) break;
    rest = rest.slice(close + `\n</${tag}>`.length).trim();
  }
  return countNames(names);
}
