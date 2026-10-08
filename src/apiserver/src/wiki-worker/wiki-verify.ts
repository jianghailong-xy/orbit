import {
  WIKI_REVIEW_RULES,
  WIKI_VERIFICATION_VERDICTS,
  type WikiSimilar,
  type WikiVerificationVerdict,
} from '@orbit/shared';
import { quoted, unwrapped } from '../wiki/wiki-plan';

/**
 * What the server asks a model about one waiting op, and how it reads the answer (contracts/wiki.contract.json
 * `agentSurface.verify` and `reviewModes.verification`, design §2.2 and §8): the model part of
 * `src/runner-go/wiki_verify.go`, ported word for word, so the two paths ask the same question of the same
 * op and read the answer as strictly.
 *
 * ONE OP AT A TIME, JUDGED FROM ITS RECORDS ALONE. The prompt carries the entry as it would read, the text of
 * every record it cites, the entries it may repeat (numbered, never by an id a local model copies wrong) and
 * the one JSON object that is an answer. Everything else — the ops to ask about, the evidence, the writing of
 * the verdict — is the wiki service's: this file builds the question and reads the answer, and
 * `recordVerifications` applies what it read.
 *
 * WHAT THE PORT KEEPS AND WHAT IT DOES NOT. The prompt, the numbering, the retry suffix, `parseWikiVerdict`
 * and `lastJSONObject` are the Go ones, down to the sentences a refusal says back (the runners' tests assert
 * those phrases, and so do the TS ones here). What it drops is everything about running a clean Claude Code:
 * there is no `claude` here — the model is the deployment's System model, called through the request queue
 * (`wiki-model-queue`), one request per op, whose identity is the op's id.
 *
 * A VERDICT THAT CANNOT BE READ IS REPORTED AS NOTHING (Wikova's lesson, the contract's `unreadable`): a
 * `null` from {@link parseWikiVerdict} is the whole of it, and the op keeps waiting.
 */

/** The whole system prompt one verification call carries (Go `wikiVerifySystemPrompt`). */
export const WIKI_VERIFY_SYSTEM_PROMPT = 'You verify proposed wiki entries against the records they cite. Judge only from '
  + 'those records, never from what you know. Answer with one JSON object and nothing else.';

/** The verdicts, in the contract's order (`reviewModes.verification.verdicts`), as Go's `wikiVerifyVerdicts`. */
export const WIKI_VERIFY_VERDICTS: readonly WikiVerificationVerdict[] = WIKI_VERIFICATION_VERDICTS;

/**
 * An entry a duplicate verdict may name: a live neighbour of the op, or an amend's own entry. The model is
 * shown it, and names it, by its number alone (E1, E2, …), never by its id: a local model copies a
 * 21-character id wrong — `34XhYj76NhjjOJTEFEtFE` came back as `34XhYj76NhjjOJTEFE` run after run (09-30 to
 * 10-02), and every such op stayed without a verdict.
 */
export interface WikiVerifyCandidate {
  number: string;
  id: string;
  kind: string;
  title: string;
  note: string;
}

/** One verdict as the model gave it, checked: `duplicateOf` is the id of the entry its number named. */
export interface WikiVerifyVerdict {
  verdict: WikiVerificationVerdict;
  reason: string;
  duplicateOf: string | null;
}

/** What naming a candidate reads of an op: its op, its own entry for an amend, and the neighbours recorded with it. */
export interface WikiVerifyItem {
  op: 'add' | 'amend';
  entryId: string | null;
  entry: { kind: string; title: string };
  similar: readonly WikiSimilar[];
}

/** What the prompt reads of an op: the entry as it would read, and every record it cites. */
export interface WikiVerifyPromptItem extends WikiVerifyItem {
  entry: { kind: string; title: string; summary: string; fields: Record<string, unknown> };
  sources: ReadonlyArray<{ kind: string; ref: string; quote: string | null; text: string | null; truncated: boolean }>;
}

/** The candidates of one op, in order and numbered (Go `wikiVerifyCandidates`). */
export function wikiVerifyCandidates(item: WikiVerifyItem): WikiVerifyCandidate[] {
  const out: WikiVerifyCandidate[] = [];
  if (item.op === 'amend' && item.entryId !== null) {
    out.push({ number: '', id: item.entryId, kind: item.entry.kind, title: item.entry.title, note: 'the entry this amend changes' });
  }
  for (const near of item.similar) {
    if (near.status !== 'active' || near.id === item.entryId) continue;
    out.push({ number: '', id: near.id, kind: near.kind, title: near.title, note: '' });
  }
  return out.map((candidate, index) => ({ ...candidate, number: `E${index + 1}` }));
}

/** The numbers the candidates are listed by, in their order (Go `wikiVerifyNumbers`). */
export function wikiVerifyNumbers(candidates: readonly WikiVerifyCandidate[]): string[] {
  return candidates.map((candidate) => candidate.number);
}

/** The entry's fields as the prompt lists them: JSON, two-space indented, and nothing when it holds nothing. */
function fieldsBlock(fields: Record<string, unknown>): string {
  if (Object.keys(fields).length === 0) return '';
  try {
    // Go marshals a map with its keys sorted; this keeps the same order, so the same op makes the same prompt.
    return `${JSON.stringify(sortKeys(fields), null, 2)}\n`;
  } catch {
    return '';
  }
}

/** A value with every object's keys sorted, as Go's map marshalling writes them. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/**
 * The one op, written for a model that sees nothing else: the entry as it would read, each record it cites,
 * the entries it may repeat, and the one answer it may give (Go `wikiVerifyPrompt`).
 */
export function wikiVerifyPrompt(item: WikiVerifyPromptItem, candidates: readonly WikiVerifyCandidate[]): string {
  const lines: string[] = [];
  lines.push('Check one proposed wiki entry against the records it cites.', '');
  if (item.op === 'amend') {
    let amends = 'an entry of the space';
    for (const candidate of candidates) {
      if (candidate.id === item.entryId) amends = `entry ${candidate.number}, listed below`;
    }
    lines.push(`## The entry, as this change would leave it (a ${item.entry.kind}; the change amends ${amends})`);
  } else {
    lines.push(`## The entry (a ${item.entry.kind})`);
  }
  lines.push(`Title: ${item.entry.title}`, `Summary: ${item.entry.summary}`);
  const fields = fieldsBlock(item.entry.fields);
  if (fields !== '') lines.push('Fields:', fields.trimEnd());
  lines.push('', '## The records it cites');
  if (item.sources.length === 0) lines.push('None.');
  item.sources.forEach((source, index) => {
    lines.push('', `### Record ${index + 1}: ${source.kind} ${source.ref}`);
    if (source.quote !== null && source.quote.trim() !== '') lines.push(`The proposer quoted: ${JSON.stringify(source.quote)}`);
    if (source.text === null) {
      lines.push("(This record's text is not available: judge by the quote alone, if there is one.)");
      return;
    }
    lines.push('Text:', source.text);
    if (source.truncated) lines.push('(The text was cut here.)');
  });
  lines.push('', '## Entries the space already holds that it may repeat');
  if (candidates.length === 0) lines.push('None.');
  for (const candidate of candidates) {
    const note = candidate.note === '' ? '' : ` (${candidate.note})`;
    lines.push(`- ${candidate.number}: [${candidate.kind}] ${candidate.title}${note}`);
  }
  lines.push('', '## Your answer',
    'Decide from the records alone:',
    '- "supported": the records bear out everything the entry says.',
    '- "partial": the records bear out some of it, and some of what it says is not in them.',
    '- "unsupported": the records do not bear it out.',
    '- "duplicate": it says what one of the entries listed above already says; give that entry\'s number (E1, E2, …) as duplicateOf.',
    'Answer with one JSON object and nothing else:',
    '{"verdict": "supported" | "partial" | "unsupported" | "duplicate", "reason": "<one sentence>", '
      + '"duplicateOf": "<the entry\'s number, such as E1, only for a duplicate>"}');
  return lines.join('\n') + '\n';
}

/**
 * What a second pass adds to an op's prompt when the model's answer in the first was not a verdict (contract
 * `maintenance.job.run.steps`, verify): why it was not taken, and the numbers duplicateOf may be — the ones
 * listed above, or none. The answer is read as strictly as the first was (Go `wikiVerifyRetrySuffix`).
 */
export function wikiVerifyRetrySuffix(refused: string, candidates: readonly WikiVerifyCandidate[]): string {
  const lines: string[] = ['', '## Your last answer was not taken'];
  lines.push(`You were asked about this entry before, and your answer was not a verdict: ${refused}.`);
  if (candidates.length === 0) {
    lines.push('No entry is listed above, so this entry is no duplicate: answer supported, partial or unsupported, '
      + 'with no duplicateOf.');
  } else {
    lines.push('duplicateOf must be one of these numbers of the entries listed above: '
      + `${wikiVerifyNumbers(candidates).join(', ')}. Give it only for a duplicate; an entry that repeats none `
      + 'of them is no duplicate.');
  }
  lines.push('Answer again, with one JSON object and nothing else.');
  return lines.join('\n') + '\n';
}

/**
 * Read the model's answer, and refuse anything that is not exactly a verdict — as `null`, because what it
 * refuses is reported as nothing: the op keeps waiting. An answer read generously is how a verifier ends up
 * letting through what it never said was supported. A number is one of the listed ones exactly, or none, and
 * an id — whole, cut short or nearly right — is no number; the verdict and the number are read as every
 * closed-set value is (Go `parseWikiVerdict`; `plan.gate.values`).
 */
export function parseWikiVerdict(text: string, candidates: readonly WikiVerifyCandidate[]): { verdict: WikiVerifyVerdict } | { refusal: string } {
  const body = lastJSONObject(text);
  if (body === null) return { refusal: 'no JSON object in it' };
  let value: { verdict?: unknown; reason?: unknown; duplicateOf?: unknown };
  try {
    value = JSON.parse(body) as typeof value;
  } catch (error) {
    return { refusal: `its JSON does not read as a verdict: ${message(error)}` };
  }
  const named = value.verdict === null || value.verdict === undefined ? null : unwrapped(String(value.verdict));
  if (named === null || !(WIKI_VERIFY_VERDICTS as readonly string[]).includes(named)) {
    return { refusal: `verdict is not one of ${WIKI_VERIFY_VERDICTS.join(', ')}` };
  }
  const verdict = named as WikiVerificationVerdict;
  if (typeof value.reason !== 'string' || value.reason.trim() === '') return { refusal: 'it gives no reason' };
  const reason = cutRunes(value.reason.trim(), WIKI_REVIEW_RULES.verificationReasonMaxChars);
  const duplicateOf = value.duplicateOf === null || value.duplicateOf === undefined ? '' : unwrapped(String(value.duplicateOf));
  if (verdict === 'duplicate') {
    const candidate = candidates.find((one) => one.number === duplicateOf);
    if (candidate) return { verdict: { verdict, reason, duplicateOf: candidate.id } };
    if (candidates.length === 0) {
      return { refusal: 'a duplicate must name one of the listed entries by its number, and none is listed '
        + `(it named ${quoted(duplicateOf)})` };
    }
    return { refusal: `a duplicate must name one of the listed entries by its number (${wikiVerifyNumbers(candidates).join(', ')}), `
      + `and ${quoted(duplicateOf)} is not one` };
  }
  if (duplicateOf !== '') {
    return { refusal: `a ${verdict} verdict names a duplicate (${quoted(duplicateOf)}), which only a duplicate does` };
  }
  return { verdict: { verdict, reason, duplicateOf: null } };
}

/**
 * The last complete JSON object in the text that carries a verdict, or null (Go `lastJSONObject`): a model
 * that thinks aloud before it answers still answers last, and one wrapped in a ```json fence is still one
 * object. Walked from the end exactly as the Go reader walks it — the last `}` that closes a slice some `{`
 * opens, and the rightmost `{` that makes it JSON — so both readers find the same object in the same text.
 */
export function lastJSONObject(text: string): string | null {
  let end = text.lastIndexOf('}');
  while (end >= 0) {
    let start = text.lastIndexOf('{', end);
    while (start >= 0) {
      try {
        const probe = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (probe !== null && typeof probe === 'object' && !Array.isArray(probe) && 'verdict' in probe) {
          return text.slice(start, end + 1);
        }
      } catch {
        // Not JSON from here to there: try a wider slice, as the Go reader does.
      }
      start = lastIndexOfBefore(text, '{', start);
    }
    end = lastIndexOfBefore(text, '}', end);
  }
  return null;
}

/**
 * The last occurrence of `search` strictly before `at`, or -1. `String.lastIndexOf` cannot say this: it
 * clamps a negative position to 0, so `text.lastIndexOf('}', -1)` finds the `}` at 0 and a Go-style
 * `for (let i = lastIndexOf(c, i - 1); i >= 0; ...)` never ends.
 */
function lastIndexOfBefore(text: string, search: string, at: number): number {
  return at <= 0 ? -1 : text.lastIndexOf(search, at - 1);
}

/** A text cut to a whole number of characters (code points), as the server stores a reason (Go `cutRunes`). */
export function cutRunes(text: string, max: number): string {
  const runes = [...text];
  return runes.length <= max ? text : runes.slice(0, max).join('');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
