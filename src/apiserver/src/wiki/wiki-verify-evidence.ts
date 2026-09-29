import { WIKI_REVIEW_RULES, type WikiVerificationEvidence } from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';

/**
 * What a verification can read (criterion 7, revision 4; contract `reviewModes.verification.evidence`).
 *
 * ONE TEXT PER RECORD, FOR EVERY READER. A run event's text is what a submission's quote is checked
 * against (`resolveSources`), what a verifier is handed (`listVerifications`) and what a document's
 * footnote is checked against (`wiki-docs.ts`, contract `docs.verification.records`), so none of them
 * disagrees about what a record says: a quote taken from what the verifier read verifies, and a
 * verdict is never about text the quote check did not see. A tool call's, a task's and an approval's
 * text are defined here for the same reason.
 *
 * WHAT AN EVENT SAYS. A user's, an assistant's and a thinking event carry prose (`text`); a tool call
 * is its tool's name and its input; a tool result is its content, a string or the text of its blocks;
 * an error is its message; and a system event only the words it carries (a compaction's summary, a
 * runner's notice, an engine's stderr) — the rest of them are counts. Empty is not text: Claude's
 * thinking arrives empty far more often than not, and an empty record is one there is nothing to read
 * in, not a piece of evidence that says nothing.
 */

/** A string worth reading: not missing, not only whitespace. */
export function hasText(text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== '';
}

function field(payload: unknown, name: string): unknown {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[name] : undefined;
}

/** The non-blank string fields of a payload, in the order named, one per line. */
function textFields(payload: unknown, names: readonly string[]): string | null {
  const parts = names.map((name) => field(payload, name)).filter(hasText);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** A tool's input as a person would read it: each key on its line, a string as itself. */
function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return JSON.stringify(input ?? null);
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

/** A tool result's content: a string, or the text of each of its blocks (an image has none). */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return hasText(content) ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.map((block) => field(block, 'text')).filter(hasText);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** The text one run event carries, or null when it carries none. */
export function runEventText(type: string, payload: unknown): string | null {
  switch (type) {
    case 'user':
    case 'assistant':
    case 'thinking':
      return textFields(payload, ['text']);
    case 'tool_use': {
      const name = field(payload, 'name');
      const input = field(payload, 'input');
      const parts = [hasText(name) ? name : null, input === undefined ? null : inputText(input)].filter(hasText);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'tool_result': {
      const text = contentText(field(payload, 'content'));
      if (text === null) return null;
      return field(payload, 'isError') === true ? `The tool reported an error:\n${text}` : text;
    }
    case 'error':
      return textFields(payload, ['message']);
    case 'system':
      return textFields(payload, ['text', 'notice', 'stderr']);
    default:
      return null;
  }
}

/** A record's JSON column as text: a string as itself, anything else as its JSON. */
export function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** A tool call's text: its output, or none while it has none. */
export function toolCallText(output: unknown): string | null {
  return output === null || output === undefined ? null : jsonText(output);
}

/** A task's text: its title, and its description under it. */
export function taskText(task: { title: string; description: string | null }): string {
  return `${task.title}\n${task.description ?? ''}`;
}

/** An approval's text: the answers given, and the note beside them. */
export function approvalText(approval: { answers: unknown; message: string | null }): string {
  return [approval.answers === null || approval.answers === undefined ? '' : jsonText(approval.answers), approval.message ?? ''].join('\n');
}

/**
 * The event types the verification list read before revision 4: a user's or an assistant's text,
 * and no other event's. A verdict recorded then carries no evidence mark (migration 0314), and what
 * it could read is decided by this rule rather than by today's.
 */
export const EVENT_TYPES_READ_BEFORE_REVISION_4: readonly string[] = ['user', 'assistant'];

/** One source's text as the reader of a verdict recorded before revision 4 was handed it. */
export function readBeforeRevision4(source: { kind: string; eventType?: string | null }, text: string | null): string | null {
  if (source.kind !== 'event') return text;
  return EVENT_TYPES_READ_BEFORE_REVISION_4.includes(source.eventType ?? '') ? text : null;
}

/** What a verifier is handed of one record: redacted as everything stored is (§10.2), then cut. */
export function verifierText(text: string | null, literals: readonly string[]): { text: string | null; truncated: boolean } {
  if (!hasText(text)) return { text: null, truncated: false };
  const chars = [...redactSecrets(text, { literals }).text];
  const max = WIKI_REVIEW_RULES.verificationSourceMaxChars;
  return { text: chars.slice(0, max).join(''), truncated: chars.length > max };
}

/** The evidence mark of an op: readable when at least one of its sources has text. */
export function evidenceOf(texts: ReadonlyArray<string | null>): WikiVerificationEvidence {
  return texts.some(hasText) ? 'readable' : 'unreadable';
}
