import { WIKI_REVIEW_RULES, type WikiVerificationEvidence } from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';

/**
 * What a verification can read (criterion 7, revision 4; contract `reviewModes.verification.evidence`).
 *
 * ONE TEXT PER RECORD, FOR EVERY READER. A record's text is what a submission's quote is checked against
 * (`resolveSources`), what a verifier is handed (`listVerifications`), and what a dossier line's position
 * counts in (criterion 2, revision 2; contract `maintenance.dossier.spans`), so none of them disagrees
 * about what a record says: a quote taken from what the verifier read verifies, a verdict is never about
 * text the quote check did not see, and the words a dossier line points at are the words a quote of them
 * is checked against.
 *
 * WHAT A RECORD SAYS. A user's, an assistant's and a thinking event carry prose (`text`); a tool call is its
 * tool's name and its input; a tool result is its content, a string or the text of its blocks; an error is
 * its message; a background task its command and what it reported; a turn's end how it ended; and a
 * system event only the words it carries (a compaction's summary, a runner's notice, an engine's stderr) —
 * the rest of them are counts. A tool call's row is the call and its result together: its tool's name, its
 * input and its output. An approval is the answers given and the owner's note, and for a plan the plan it
 * decided. Empty is not text: Claude's thinking arrives empty far more often than not, and an empty record
 * is one there is nothing to read in, not a piece of evidence that says nothing.
 *
 * IN PARTS. Each text is its parts, one per line — a field, or one key of a tool's input — so that what
 * places a dossier line's words in it can find the part they came from (`wiki-dossier.ts`).
 */

/** One part of a record's text: the field or the input key it is, and its words. */
export interface RecordPart {
  key: string;
  text: string;
}

/** A record's text: its parts, one per line, or null when it has none. */
export function partsText(parts: readonly RecordPart[]): string | null {
  return parts.length > 0 ? parts.map((part) => part.text).join('\n') : null;
}

/** A string worth reading: not missing, not only whitespace. */
export function hasText(text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== '';
}

function field(payload: unknown, name: string): unknown {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[name] : undefined;
}

/** The non-blank string fields of a payload, in the order named. */
function textFields(payload: unknown, names: readonly string[]): RecordPart[] {
  return names.flatMap((name) => {
    const text = field(payload, name);
    return hasText(text) ? [{ key: name, text }] : [];
  });
}

/** A tool's input as a person would read it: each key on its line, a string as itself. */
function inputParts(input: unknown): RecordPart[] {
  if (typeof input === 'string') return [{ key: 'input', text: input }];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return [{ key: 'input', text: JSON.stringify(input ?? null) }];
  return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({
    key: `input.${key}`,
    text: `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  }));
}

/** A tool's name and its input, as a tool_use event and a tool call's row both begin. */
function callParts(name: unknown, input: unknown): RecordPart[] {
  const parts: RecordPart[] = hasText(name) ? [{ key: 'name', text: name }] : [];
  if (input === undefined) return parts;
  const given = inputParts(input);
  return hasText(partsText(given)) ? [...parts, ...given] : parts;
}

/** A tool result's content: a string, or the text of each of its blocks (an image has none). */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return hasText(content) ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.map((block) => field(block, 'text')).filter(hasText);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** The parts of the text one run event carries: none when it carries none. */
export function runEventParts(type: string, payload: unknown): RecordPart[] {
  switch (type) {
    case 'user':
    case 'assistant':
    case 'thinking':
      return textFields(payload, ['text']);
    case 'tool_use':
      return callParts(field(payload, 'name'), field(payload, 'input'));
    case 'tool_result': {
      const text = contentText(field(payload, 'content'));
      if (text === null) return [];
      const content = { key: 'content', text };
      return field(payload, 'isError') === true ? [{ key: 'error', text: 'The tool reported an error:' }, content] : [content];
    }
    case 'error':
      return textFields(payload, ['message']);
    case 'background_task':
      return textFields(payload, ['command', 'summary']);
    case 'turn_end':
      return textFields(payload, ['subtype']);
    case 'system':
      return textFields(payload, ['text', 'notice', 'stderr']);
    default:
      return [];
  }
}

/** The text one run event carries, or null when it carries none. */
export function runEventText(type: string, payload: unknown): string | null {
  return partsText(runEventParts(type, payload));
}

/**
 * A tool's output as a person reads it: a string, or the text of its blocks — a list of them, or the
 * `content` of a result that carries its blocks there — and anything else as its JSON.
 */
export function toolOutputText(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === 'string' || Array.isArray(output)) return contentText(output);
  const blocks = field(output, 'content');
  if (Array.isArray(blocks)) return contentText(blocks);
  const json = JSON.stringify(output);
  return hasText(json) ? json : null;
}

/** The parts of a tool call's text: its tool's name, its input, and its output. */
export function toolCallParts(call: { name: string | null; input: unknown; output: unknown }): RecordPart[] {
  const output = toolOutputText(call.output);
  return [
    ...callParts(call.name, call.input === null ? undefined : call.input),
    ...(output === null ? [] : [{ key: 'output', text: output }]),
  ];
}

/** The text a tool call's row carries: the call and its result together. */
export function toolCallText(call: { name: string | null; input: unknown; output: unknown }): string | null {
  return partsText(toolCallParts(call));
}

/** A record's value as text: a string as itself, anything else as its JSON. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * The parts of an approval's text: the answers given and the owner's note — each a line, empty or not — and,
 * for a plan, the plan it decided.
 */
export function approvalParts(approval: { toolName: string; input: unknown; answers: unknown; message: string | null }): RecordPart[] {
  const parts: RecordPart[] = [
    { key: 'answers', text: approval.answers === null ? '' : asText(approval.answers) },
    { key: 'message', text: approval.message ?? '' },
  ];
  const plan = approval.toolName === 'ExitPlanMode' ? field(approval.input, 'plan') : undefined;
  return hasText(plan) ? [...parts, { key: 'plan', text: plan }] : parts;
}

/** The text an approval carries. */
export function approvalText(approval: { toolName: string; input: unknown; answers: unknown; message: string | null }): string {
  return partsText(approvalParts(approval))!;
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
