import { WIKI_IMPORT_JOB, WIKI_IMPORT_RULES, WIKI_LIMITS } from '@orbit/shared';

/**
 * What the import makes of a note (contracts/wiki.contract.json `import.server`, design §8, P5): the prompt,
 * the reading of the model's answer, and the checks every entry is held to before it becomes an op — ported
 * from `src/runner-go/wiki_import.go`, which does the same on the runner until P10 removes it.
 *
 * ONE RULE, TWO IMPLEMENTATIONS, NO DRIFT. The two paths run side by side until P10, and what is deterministic
 * here — the prompt, the parse, the repair, the field checks, the quote, the verify command, a path's reading —
 * answers exactly what the Go code answers for the same input (`wiki-import.golden.json` holds both to the same
 * outputs). The one thing that is not a port is where the anchors are checked: the runner held them to the
 * checkout it ran in, and the server holds them to the space's snapshot of origin/main (contract `repoOps`) —
 * a path the tree has, a commit origin/main reaches.
 *
 * Nothing in this file touches the database or the model: the job (wiki-import-job.ts) asks, and this reads.
 */

/** The kinds the model may write. A principle is the owner's (contract `reviewModes.floors.principleOwnerOnly`). */
export const WIKI_IMPORT_KINDS = ['convention', 'decision', 'pitfall', 'recipe', 'concept'] as const;

/** The one language a note's entries are held to (the trial of 2026-09-28: the model titled Chinese notes in English). */
export const WIKI_IMPORT_CHINESE = 'Chinese';

/** One note as the model is shown it: the text the server kept, where it came from, and its prose's language. */
export interface WikiImportNote {
  id: string;
  path: string;
  date: string;
  text: string;
  /** "Chinese" when an entry's title is held to it (wikiImportNoteLanguage), "" otherwise. */
  lang: string;
}

/** One op the model's answer became, and — once it was proposed — what became of it. */
export interface WikiImportOp {
  body: Record<string, unknown>;
}

// ── Go's own readings of text, where the port has to answer exactly what the runner answers ──────────────

/** Go's unicode.IsSpace, which strings.TrimSpace and strings.Fields read by. */
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'gu');
const GO_FIELDS = new RegExp(`[${GO_SPACE}]+`, 'u');

/** strings.TrimSpace. */
export function goTrimSpace(text: string): string {
  return text.replace(GO_TRIM, '');
}

/** strings.Join(strings.Fields(text), " "): every run of white space one space, none at either end. */
export function collapseWhitespace(text: string): string {
  return text.split(GO_FIELDS).filter((field) => field !== '').join(' ');
}

/** The first `max` characters (code points), as Go's cutRunes cuts. */
export function cutRunes(text: string, max: number): string {
  const runes = [...text];
  return runes.length <= max ? text : runes.slice(0, max).join('');
}

/** The last `max` characters (code points), as Go's lastRunes keeps them. */
function lastRunes(text: string, max: number): string {
  const runes = [...text];
  return runes.length <= max ? text : runes.slice(runes.length - max).join('');
}

/** strings.Trim(text, cutset): every leading and trailing character of the set. */
function trimChars(text: string, cutset: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && cutset.includes(text[start])) start += 1;
  while (end > start && cutset.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** Go's printable runes (strconv.IsPrint): letters, marks, numbers, punctuation, symbols and the ASCII space. */
const GO_PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
const GO_ESCAPES: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };

/**
 * Go's %q of a string the model wrote (strconv.Quote), the way a problem names it back: quoted, with every
 * rune that would not show written as an escape — so an invisible character in a title shows in the retry.
 */
function goQuote(text: string): string {
  let out = '"';
  for (const rune of text) {
    const code = rune.codePointAt(0) ?? 0;
    if (rune === '"' || rune === '\\') out += `\\${rune}`;
    else if (GO_PRINTABLE.test(rune)) out += rune;
    else if (GO_ESCAPES[rune]) out += GO_ESCAPES[rune];
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += `\\U${code.toString(16).padStart(8, '0')}`;
  }
  return `${out}"`;
}

/**
 * Go's json.Marshal of a value decoded from JSON: object keys sorted by their bytes, and `<`, `>`, `&`,
 * U+2028 and U+2029 escaped. The retry names the rejected entries in this form and the idempotency key is
 * the sha256 of it, so both are the bytes the runner writes for the same value.
 */
export function goJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return goJsonString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => goJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${keys.map((key) => `${goJsonString(key)}:${goJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return 'null';
}

function goJsonString(text: string): string {
  return JSON.stringify(text).replace(/[<>&\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// ── The note's language ──────────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_BLOCK = /^---\n[\s\S]*?\n---\n/u;
const CODE_BLOCK = /```[\s\S]*?```/gu;
const CODE_SPAN = /`[^`\n]*`/gu;
// RE2's \S is everything but its five ASCII spaces.
const URL_PATTERN = /https?:\/\/[^\t\n\f\r ]+/gu;
const HAN = /\p{Script=Han}/u;

/**
 * "Chinese" when the note's prose — its text without frontmatter, code and URLs — is mostly Han characters,
 * counting a Latin word as five letters; "" otherwise. Of the owner's 1,135 memory files, 1,103 come out at
 * 0.5 or more and 27 below 0.2: 0.3 splits them.
 */
export function wikiImportNoteLanguage(text: string): string {
  let prose = text.replace(FRONTMATTER_BLOCK, '');
  for (const code of [CODE_BLOCK, CODE_SPAN, URL_PATTERN]) prose = prose.replace(code, ' ');
  let han = 0;
  let latin = 0;
  for (const rune of prose) {
    if (HAN.test(rune)) han += 1;
    else if (/^[A-Za-z]$/u.test(rune)) latin += 1;
  }
  return han > 0 && han / (han + latin / 5) >= 0.3 ? WIKI_IMPORT_CHINESE : '';
}

function hasHan(text: string): boolean {
  for (const rune of text) if (HAN.test(rune)) return true;
  return false;
}

/**
 * Whether the note gives the command as it is written, in its code — a code block or a `span`: a recipe's
 * verify command is run as it stands, and neither a description of a check («full-api on main») nor a link
 * to another note («见 [[full-api-red-on-main]]») is one, though the note's prose holds both.
 */
export function wikiImportNoteGives(note: string, command: string): boolean {
  const wanted = collapseWhitespace(goTrimSpace(command).replace(/^\$ /u, ''));
  if (wanted === '') return false;
  const code = [...(note.match(CODE_BLOCK) ?? []), ...(note.replace(CODE_BLOCK, ' ').match(CODE_SPAN) ?? [])];
  return code.some((piece) => collapseWhitespace(trimChars(piece, '`')).includes(wanted));
}

// ── The prompt ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The demo's extraction prompt (prompts.py) for one note: what is worth an entry and what is not, the one shape
 * the answer may take, and a fictional example. Word for word the runner's (wikiImportPrompt).
 */
export function wikiImportPrompt(note: WikiImportNote): string {
  return `Below is a NOTE: one Markdown file kept beside a code repository. It is an instruction file for coding agents (a CLAUDE.md or an AGENTS.md), or one file of an agent's memory library, whose frontmatter gives the memory a name, a one-line description and a type (user: about the owner; feedback: how the owner wants work done; project: ongoing work; reference: facts and pointers). Agents wrote most of these notes while working for the repository's owner: "the user" in a note is the owner.

TASK: extract the knowledge in this note that would change how a future agent works in this repository and that it could NOT learn by reading the code for one minute:
- rules and corrections — how the owner wants things done, a practice the note says to follow -> convention
- decisions, with the alternatives and why they were rejected -> decision
- traps and surprises: something behaves differently than expected, with the cause and the fix -> pitfall
- a multi-step procedure, with a command that shows it worked -> recipe
- the meaning of a project-specific term or mechanism that is easy to get wrong -> concept
Never write a principle: principles are the owner's alone. Write a general rule with its reason as a convention.
Do NOT extract: status or progress reports, what was built, one-off facts about a single task, generic programming advice, or anything the code states plainly. A note that only lists or links other notes -> []. Prefer fewer, stronger entries. If there is nothing worth keeping, output [].

OUTPUT: a JSON array (at most ${WIKI_IMPORT_RULES.entriesPerNote} objects), nothing else — no prose, no code fence. Each object is FLAT:
{"kind": "convention|decision|pitfall|recipe|concept",
 "title": "<= 60 characters, states the knowledge itself",
 "summary": "one or two short sentences a future agent can act on",
 ...the kind's own fields at the top level (below)...,
 "anchors": {"paths": [repository file paths the note names], "commits": [commit shas the note names]},
 "quote": "a span of the note, copied character for character, that shows it (<= 150 characters)"}
The kind's own fields (all required; be terse: each text field one short sentence):
- convention: "rule", "scope": ["where it applies"], "exceptions" ("" if none)
- decision: "context", "decision", "alternatives": [{"option": "...", "whyRejected": "..."}], "consequences", "decidedAt": "YYYY-MM-DD"
- pitfall: "trigger": {"paths": [...], "commands": [...], "errorSignature": "..."} (at least one non-empty; [] for an empty list), "symptom", "cause", "fix"
- recipe: "steps": ["..."], "verify": {"command": "<a command the note gives, copied as it is written>", "expectedExit": 0}
- concept: "definition", "boundaries"
RULES:
- quote: copied exactly from the note, backticks and punctuation included — no "…", no paraphrase, no translation. Prefer a span without double quotes; if one is unavoidable, escape it as \\".
- Write titles and text fields in the language the note is written in; keep code, paths and commands verbatim.
- verify.command is a command copied exactly from the note's code (a code block or a span in backticks), one that shows the procedure worked — never a description of a check or a link to another note. A procedure the note gives no such command for is not a recipe: write it as a convention, or leave it out.
- Only put a path or a sha in anchors if it appears in the note; never invent one. decidedAt is the date the note gives the decision, or else the note's date.

EXAMPLE (a fictional repository, for format only):
NOTE (memory/upload-fixture-port.md, 2025-03-02):
---
name: upload-fixture-port
description: STORAGE_PORT is read at import time, so fixtures must hand out the URL
metadata:
  type: feedback
---
Upload tests failed with \`Error: connect ECONNREFUSED 127.0.0.1:9000\` on CI.
STORAGE_PORT is read when src/api/storage.ts is imported, before the fixture sets it.
The user said: never hard-code ports in a fixture; always take them from what the fixture returns.
OUTPUT:
[{"kind":"pitfall","title":"STORAGE_PORT is read at import, so a fixture sets it too late","summary":"Set STORAGE_PORT before src/api/storage.ts is imported, or tests connect to the default 9000.","trigger":{"paths":["src/api/storage.ts"],"commands":[],"errorSignature":"connect ECONNREFUSED 127.0.0.1:9000"},"symptom":"Upload tests fail with ECONNREFUSED 127.0.0.1:9000","cause":"STORAGE_PORT is read when the module is imported, before the fixture sets it","fix":"Have the fixture return the URL and read the port from there","anchors":{"paths":["src/api/storage.ts"],"commits":[]},"quote":"STORAGE_PORT is read when src/api/storage.ts is imported, before the fixture sets it."},
 {"kind":"convention","title":"Tests take ports from the fixture, never hard-code them","summary":"Take every port from what the fixture returns.","rule":"Never hard-code a port in a fixture; take it from what the fixture returns","scope":["test fixtures"],"exceptions":"","anchors":{"paths":[],"commits":[]},"quote":"never hard-code ports in a fixture; always take them from what the fixture returns."}]

==== NOTE (${note.path}, ${note.date}) ====
${note.text}
==== END OF NOTE ====
${wikiImportLanguageLine(note)}Output the JSON array now.`;
}

/** The note's language, named last, where the model reads it after the English example; "" for none. */
function wikiImportLanguageLine(note: WikiImportNote): string {
  if (note.lang === '') return '';
  return `This note is written in ${note.lang}: write every title, summary and text field in ${note.lang}, `
    + 'although the example above is in English; keep code, paths and commands verbatim.\n';
}

/** Ask once more, naming what did not hold up (prompts.py's retry_suffix). */
export function wikiImportRetrySuffix(answer: string, parsed: boolean, built: WikiImportBuilt): string {
  if (!parsed) {
    return `\n\nYOUR ANSWER WAS NOT A JSON ARRAY OF FLAT ENTRY OBJECTS:\n${lastRunes(answer, 3000)}\n\nOutput the JSON array only, as specified.`;
  }
  return `\n\nSOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n${cutRunes(goJson(built.rejected), 6000)}\n\nPROBLEMS:\n- `
    + `${built.problems.slice(0, 12).join('\n- ')}\nOutput a JSON array with corrected versions of ONLY these rejected entries (flat `
    + 'objects as specified; fill every required field). Drop an entry you cannot support. Output the JSON array only.';
}

// ── The answer ───────────────────────────────────────────────────────────────────────────────────────────

/** One entry as the model wrote it: a JSON object, or null where it wrote null in the array. */
export type WikiImportAnswerEntry = Record<string, unknown> | null;

const FENCE = /```(?:json)?[\t\n\f\r ]*([\s\S]*?)```/gu;
const TRAILING_COMMA = /,[\t\n\f\r ]*([\]}])/gu;
const QUOTE_VALUE = /("quote"[\t\n\f\r ]*:[\t\n\f\r ]*")([\s\S]*?)("[\t\n\f\r ]*\}[\t\n\f\r ]*[,\]])/gu;
const BARE_QUOTE = /([^\\])"/gu;

/**
 * The array of entries in the model's answer: bare, in a code fence, as {"entries": [...]}, or after some
 * reasoning. null when there is none — which `[]` is not.
 */
export function parseWikiImportAnswer(text: string): WikiImportAnswerEntry[] | null {
  const trimmed = goTrimSpace(text);
  const candidates = [...trimmed.matchAll(FENCE)].map((match) => goTrimSpace(match[1]));
  candidates.push(trimmed);
  for (const candidate of candidates) {
    for (const body of [candidate, wikiImportRepair(candidate)]) {
      const entries = wikiImportEntries(body);
      if (entries) return entries;
    }
  }
  // The longest array of entries anywhere in it, for an answer that reasons before it answers.
  for (const body of [trimmed, wikiImportRepair(trimmed)]) {
    let best: WikiImportAnswerEntry[] | null = null;
    let bestSpan = -1;
    for (let start = body.indexOf('['); start >= 0; start = body.indexOf('[', start + 1)) {
      const decoded = decodeArrayAt(body, start);
      if (decoded && entryLike(decoded.value) && decoded.value.length > 0 && decoded.span > bestSpan) {
        best = decoded.value;
        bestSpan = decoded.span;
      }
    }
    if (best) return best;
  }
  if (trimmed.endsWith('[]')) return [];
  return null;
}

/** The two mistakes a model makes most: an unescaped double quote inside a quote's value, and a trailing comma. */
export function wikiImportRepair(text: string): string {  const quoted = text.replace(QUOTE_VALUE, (_match, open: string, inner: string, close: string) => {
    let escaped = inner.replace(BARE_QUOTE, '$1\\"');
    if (escaped.startsWith('"')) escaped = `\\${escaped}`;
    return open + escaped + close;
  });
  return quoted.replace(TRAILING_COMMA, '$1');
}

/** A whole body that is an array of entries, or {"entries": [...]} (the key read as Go reads a field: any case). */
function wikiImportEntries(body: string): WikiImportAnswerEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(value)) {
    const list = asEntryList(value);
    return list && entryLike(list) ? list : null;
  }
  if (value !== null && typeof value === 'object') {
    let entries: unknown = null;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'entries') entries = item;
    }
    if (entries === null) return null;
    return Array.isArray(entries) ? asEntryList(entries) : null;
  }
  return null;
}

/** An array whose every element is an object or null, as Go decodes into []map[string]interface{}; else null. */
function asEntryList(value: unknown[]): WikiImportAnswerEntry[] | null {
  for (const item of value) {
    if (item !== null && (typeof item !== 'object' || Array.isArray(item))) return null;
  }
  return value as WikiImportAnswerEntry[];
}

function entryLike(list: WikiImportAnswerEntry[]): boolean {
  if (list.length === 0) return true;
  return list.some((entry) => entry !== null && ('kind' in entry || 'title' in entry));
}

/**
 * The JSON array that begins at `start`, as Go's json.Decoder reads the first value of a stream: the array
 * and how many bytes it took, or null when what begins there is not an array of objects.
 */
function decodeArrayAt(body: string, start: number): { value: WikiImportAnswerEntry[]; span: number } | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        const text = body.slice(start, i + 1);
        try {
          const value: unknown = JSON.parse(text);
          if (!Array.isArray(value)) return null;
          const list = asEntryList(value);
          return list ? { value: list, span: Buffer.byteLength(text, 'utf8') } : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── The entries ──────────────────────────────────────────────────────────────────────────────────────────

/** Each kind's fields a model must fill (contract `kinds.<kind>.fields`); the server checks the rest. */
const REQUIRED: Record<string, readonly string[]> = {
  convention: ['rule', 'scope'],
  decision: ['context', 'decision', 'alternatives', 'consequences', 'decidedAt'],
  pitfall: ['trigger', 'symptom', 'cause', 'fix'],
  recipe: ['steps', 'verify'],
  concept: ['definition', 'boundaries'],
};

/** The kinds' optional fields, carried when the model filled them. */
const OPTIONAL: Record<string, readonly string[]> = {
  convention: ['exceptions'],
  pitfall: ['detector'],
  concept: ['notToConfuseWith'],
};

/** What a set of the model's entries became: ops that hold up, what was wrong with the rest, the principles set aside. */
export interface WikiImportBuilt {
  ops: WikiImportOp[];
  rejected: WikiImportAnswerEntry[];
  problems: string[];
  principles: number;
  dropped: number;
  titles: Set<string>;
}

/** Each entry checked the way extract.py's validate did, and an add made of the ones that hold up. */
export function buildWikiImportOps(
  entries: readonly WikiImportAnswerEntry[],
  note: WikiImportNote,
  repo: WikiImportRepo | null,
): WikiImportBuilt {
  const built: WikiImportBuilt = { ops: [], rejected: [], problems: [], principles: 0, dropped: 0, titles: new Set() };
  for (const entry of entries) {
    const kind = goTrimSpace(typeof entry?.kind === 'string' ? entry.kind : '').toLowerCase();
    if (kind === 'principle') {
      built.principles += 1;
      continue;
    }
    const made = wikiImportOpFrom(entry ?? {}, kind, note, repo);
    if (made.problems.length > 0) {
      built.dropped += 1;
      built.rejected.push(entry);
      const title = typeof entry?.title === 'string' ? entry.title : '';
      for (const problem of made.problems) built.problems.push(`entry ${goQuote(cutRunes(title, 40))}: ${problem}`);
      continue;
    }
    const title = titleOf(made.op as WikiImportOp);
    if (built.titles.has(title)) {
      built.dropped += 1;
      continue;
    }
    built.titles.add(title);
    built.ops.push(made.op as WikiImportOp);
  }
  return built;
}

/**
 * The retry's ops in place of the entries it corrected: the ones rejected the first time no longer count as
 * dropped when their correction holds up. A principle in the retry is one the first answer already had.
 */
export function mergeWikiImportRetry(built: WikiImportBuilt, retry: WikiImportBuilt): void {
  for (const op of retry.ops) {
    const title = titleOf(op);
    if (built.titles.has(title)) continue;
    built.titles.add(title);
    built.ops.push(op);
    if (built.dropped > 0) built.dropped -= 1;
  }
}

function titleOf(op: WikiImportOp): string {
  const entry = op.body.entry as Record<string, unknown> | undefined;
  return (typeof entry?.title === 'string' ? entry.title : '').toLowerCase();
}

/** One entry as an add citing the note, or what is wrong with it. */
export function wikiImportOpFrom(
  entry: Record<string, unknown>,
  kind: string,
  note: WikiImportNote,
  repo: WikiImportRepo | null,
): { op: WikiImportOp | null; problems: string[] } {
  if (!(WIKI_IMPORT_KINDS as readonly string[]).includes(kind)) {
    return { op: null, problems: [`kind ${goQuote(kind)} is not one of ${WIKI_IMPORT_KINDS.join(', ')}`] };
  }
  const problems: string[] = [];
  const title = text(entry.title, 120);
  const summary = text(entry.summary, 280);
  if (title === '') problems.push('title is missing');
  else if (note.lang === WIKI_IMPORT_CHINESE && !hasHan(title)) {
    problems.push("title is not in the note's language: the note is written in Chinese, so write the title in Chinese");
  }
  if (summary === '') problems.push('summary is missing');
  const nested = isObject(entry.fields) ? entry.fields : {};
  const field = (name: string): unknown => (Object.hasOwn(entry, name) ? entry[name] : nested[name]);
  const fields: Record<string, unknown> = {};
  for (const name of REQUIRED[kind]) {
    const checked = wikiImportField(name, field(name), note);
    if (checked.problem !== '') {
      problems.push(checked.problem);
      continue;
    }
    fields[name] = checked.value;
  }
  for (const name of OPTIONAL[kind] ?? []) {
    const value = text(field(name), 4000);
    if (value !== '') fields[name] = value;
  }
  if (problems.length > 0) return { op: null, problems };
  const draft: Record<string, unknown> = { kind, title, summary, fields };
  const anchors = repo?.anchors(entry.anchors) ?? [];
  if (anchors.length > 0) draft.anchors = anchors;
  const source: Record<string, unknown> = { kind: 'note', ref: note.id };
  const quote = wikiImportQuote(note.text, text(entry.quote, 4000));
  if (quote !== null) source.quote = quote;
  return { op: { body: { op: 'add', entry: draft, sources: [source] } }, problems: [] };
}

/** One required field in the shape the kind's schema gives it, or what is wrong. */
function wikiImportField(name: string, value: unknown, note: WikiImportNote): { value?: unknown; problem: string } {
  const missing = `${name} is missing`;
  switch (name) {
    case 'scope':
    case 'steps': {
      const list = textList(value);
      return list.length === 0 ? { problem: missing } : { value: list, problem: '' };
    }
    case 'alternatives': {
      const items = Array.isArray(value) ? value : isObject(value) ? [value] : [];
      const alternatives: unknown[] = [];
      for (const item of items) {
        const alt = isObject(item) ? item : {};
        const option = text(alt.option, 4000);
        const why = text(alt.whyRejected, 4000);
        if (option !== '' && why !== '') alternatives.push({ option, whyRejected: why });
      }
      if (alternatives.length === 0) return { problem: 'alternatives needs at least one {option, whyRejected}' };
      return { value: capList(alternatives), problem: '' };
    }
    case 'decidedAt': {
      // A date that is not one — or none at all — is the note's own date.
      const date = text(value, 40);
      if (Buffer.byteLength(date, 'utf8') >= 10 && isCalendarDate(date.slice(0, 10))) return { value: date.slice(0, 10), problem: '' };
      return { value: note.date, problem: '' };
    }
    case 'trigger': {
      const trigger = isObject(value) ? value : {};
      const paths = textList(trigger.paths);
      const commands = textList(trigger.commands);
      const out: Record<string, unknown> = { paths, commands };
      const signature = text(trigger.errorSignature, 4000);
      if (signature !== '') out.errorSignature = signature;
      if (paths.length === 0 && commands.length === 0 && signature === '') {
        return { problem: 'trigger needs at least one of paths, commands or errorSignature' };
      }
      return { value: out, problem: '' };
    }
    case 'verify': {
      const verify = isObject(value) ? value : {};
      const command = text(verify.command, 4000);
      if (command === '') return { problem: 'verify needs a command' };
      if (!wikiImportNoteGives(note.text, command)) {
        return {
          problem: `verify.command ${goQuote(cutRunes(command, 80))} is not a command the note gives: copy one exactly from the note's `
            + 'code (a code block or a span in backticks), or, when the note gives none, write the procedure as a convention '
            + 'or leave it out',
        };
      }
      let exit = 0;
      if (typeof verify.expectedExit === 'number') exit = Math.trunc(verify.expectedExit);
      else if (typeof verify.expectedExit === 'string') {
        const leading = /^[+-]?\d+/u.exec(goTrimSpace(verify.expectedExit));
        if (leading) exit = Number.parseInt(leading[0], 10);
      }
      if (exit < 0 || exit > 255) exit = 0;
      return { value: { command, expectedExit: exit }, problem: '' };
    }
    default: {
      const value_ = text(value, 4000);
      return value_ === '' ? { problem: missing } : { value: value_, problem: '' };
    }
  }
}

/** A text field trimmed and cut to what the contract lets it hold; "" when it is not text or is blank. */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? cutRunes(goTrimSpace(value), max) : '';
}

/** A list of texts, blanks left out and cut to the contract's list size; a lone text is a list of one. */
function textList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const item of items) {
    const value_ = text(item, 4000);
    if (value_ !== '') out.push(value_);
  }
  return capList(out);
}

function capList<T>(items: T[]): T[] {
  return items.length > 20 ? items.slice(0, 20) : items;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Go's time.Parse("2006-01-02", …): four digits, a month that is one, a day the month has. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ── The quote ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The quote as the note holds it: as the model wrote it when the note has it (the server compares with runs of
 * whitespace collapsed, and so does this), else the note's own span when the model only dropped backticks,
 * asterisks or curly quotes from it, else null — the note stays the entry's source with no quote.
 */
export function wikiImportQuote(note: string, quote: string): string | null {
  if (quote === '') return null;
  if (collapseWhitespace(note).includes(collapseWhitespace(quote))) return cutRunes(quote, WIKI_LIMITS.quoteMaxChars);
  const { plain, offsets } = plainOf(note);
  const wanted = goTrimSpace(plainOf(quote).plain);
  if (wanted === '') return null;
  const at = plain.indexOf(wanted);
  if (at < 0) return null;
  const start = offsets[at];
  const last = offsets[at + wanted.length - 1];
  const size = (note.codePointAt(last) ?? 0) > 0xffff ? 2 : 1;
  const [from, to] = wholeMarks(note, start, last + size);
  const span = goTrimSpace(note.slice(from, to));
  return span === '' ? null : cutRunes(span, WIKI_LIMITS.quoteMaxChars);
}

/** Widen note[start:stop] over a backtick or a `**` it holds one half of, so a quote reads `release.sh next`. */
function wholeMarks(note: string, start: number, stop: number): [number, number] {
  for (const mark of ['`', '**']) {
    if ((note.slice(start, stop).split(mark).length - 1) % 2 === 0) continue;
    if (start >= mark.length && note.slice(start - mark.length, start) === mark) start -= mark.length;
    else if (stop + mark.length <= note.length && note.slice(stop, stop + mark.length) === mark) stop += mark.length;
  }
  return [start, stop];
}

/**
 * The text with the marks a model drops from a quote taken out and every run of white space one space, with
 * the index in the text of the character each of its code units came from.
 */
function plainOf(text: string): { plain: string; offsets: number[] } {
  let plain = '';
  const offsets: number[] = [];
  let space = false;
  let index = 0;
  for (const rune of text) {
    const at = index;
    index += rune.length;
    let r = rune;
    if (r === '`' || r === '*') continue;
    if (r === '“' || r === '”' || r === '„') r = '"';
    else if (r === '‘' || r === '’') r = "'";
    if (r === ' ' || r === '\t' || r === '\n' || r === '\r') {
      if (space) continue;
      space = true;
      r = ' ';
    } else {
      space = false;
    }
    plain += r;
    for (let n = 0; n < r.length; n += 1) offsets.push(at);
  }
  return { plain, offsets };
}

// ── The anchors, held to the space's snapshot ────────────────────────────────────────────────────────────

const WORKTREE_PREFIX = /^.*?\/\.orbit\/worktrees\/[^/]+\//u;
const LINE_SUFFIX = /:\d+(?:[-:]\d+)?$/u;
const SHA = /^[0-9a-f]{7,40}$/u;

/** What the repository is, for the anchors: the snapshot's tree and the commits its origin/main reaches. */
export interface WikiImportRepoIndex {
  files: readonly string[];
  commits: readonly string[];
}

/**
 * The repository the anchors are held to: a path its origin/main tree has (a file or a directory of one), a
 * commit its origin/main reaches. With no snapshot there are no anchors at all rather than unchecked ones —
 * a sha that is not an ancestor poisons whatever trusts it.
 */
export class WikiImportRepo {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();
  private readonly commitSet: Set<string>;

  /**
   * @param root the checkout the command ran in, when it named one: a note's absolute path under it is read
   *   relative to it, as the runner reads one under its own checkout.
   * @param name the repository's name (…/orbit.git reads orbit): a note that names a file by an absolute path
   *   names it inside some checkout called that.
   */
  constructor(index: WikiImportRepoIndex, private readonly root: string, private readonly name: string) {
    for (const file of index.files) {
      this.files.add(file);
      for (let dir = parentOf(file); dir !== '.' && dir !== '/'; dir = parentOf(dir)) this.dirs.add(dir);
    }
    this.commitSet = new Set(index.commits.map((sha) => sha.toLowerCase()));
  }

  /** The model's {paths, commits} as the anchors that hold up in this repository. */
  anchors(raw: unknown): Array<Record<string, string>> {
    const given = isObject(raw) ? raw : {};
    const out: Array<Record<string, string>> = [];
    const seen = new Set<string>();
    for (const value of textList(given.paths)) {
      const path = this.path(value);
      if (path !== null && !seen.has(`p:${path}`)) {
        seen.add(`p:${path}`);
        out.push({ type: 'path', path });
      }
    }
    for (const value of textList(given.commits)) {
      const sha = this.commit(value);
      if (sha !== null && !seen.has(`c:${sha}`)) {
        seen.add(`c:${sha}`);
        out.push({ type: 'commit', sha });
      }
    }
    return capList(out);
  }

  /**
   * A path the model named, relative to the repository, when its tree has it. An absolute one is read inside
   * the command's checkout, an Orbit worktree, or any directory named for the repository: /root/orbit/src/x
   * reads src/x.
   */
  path(raw: string): string | null {
    let path = trimChars(goTrimSpace(raw), '`"\'').replace(LINE_SUFFIX, '');
    if (this.root !== '' && path.startsWith(`${this.root}/`)) path = path.slice(this.root.length + 1);
    else if (WORKTREE_PREFIX.test(path)) path = path.replace(WORKTREE_PREFIX, '');
    else if (path.startsWith('/') || path.startsWith('~/')) {
      const at = path.indexOf(`/${this.name}/`);
      if (this.name !== '' && at >= 0) path = path.slice(at + this.name.length + 2);
    }
    if (path.startsWith('./')) path = path.slice(2);
    if (path.endsWith('/')) path = path.slice(0, -1);
    if (path === '' || path.startsWith('/')) return null;
    return this.files.has(path) || this.dirs.has(path) ? path : null;
  }

  /**
   * A sha the model named, in full, when origin/main reaches the commit it names: the whole sha, or a prefix of
   * seven or more characters that names exactly one of the commits it reaches.
   */
  commit(raw: string): string | null {
    const sha = trimChars(goTrimSpace(raw), '`"\'').toLowerCase();
    if (!SHA.test(sha)) return null;
    if (this.commitSet.has(sha)) return sha;
    let found: string | null = null;
    for (const full of this.commitSet) {
      if (!full.startsWith(sha)) continue;
      if (found !== null) return null;
      found = full;
    }
    return found;
  }
}

/** path.Dir for a repository path. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return '.';
  if (cut === 0) return '/';
  return path.slice(0, cut);
}

/** The system prompt every read carries (contract `import.server.systemPrompt`). */
export const WIKI_IMPORT_SYSTEM_PROMPT = WIKI_IMPORT_JOB.systemPrompt;

// ── The same checks, read by the maintenance run (P8) ───────────────────────────────────────────
//
// An extraction's entries are held to the same field checks the import's are (`wikiImportField`), with the
// dossier's date where a note's date was: the maintenance port reuses them rather than answering them twice.

/** The fields a kind requires, and the ones it may carry (the runner's `wikiImportRequired`/`wikiImportOptional`). */
export function wikiImportRequiredFields(kind: string): readonly string[] {
  return REQUIRED[kind] ?? [];
}

export function wikiImportOptionalFields(kind: string): readonly string[] {
  return OPTIONAL[kind] ?? [];
}

/** One required field in the shape the kind's schema gives it, or what is wrong (the runner's `wikiImportField`). */
export function wikiImportFieldValue(name: string, value: unknown, note: WikiImportNote): { value?: unknown; problem: string } {
  return wikiImportField(name, value, note);
}

/** A text field trimmed and cut to what the contract lets it hold; "" when it is not text or is blank. */
export function wikiImportText(value: unknown, max: number): string {
  return text(value, max);
}

/** A list of texts, blanks left out and cut to the contract's list size; a lone text is a list of one. */
export function wikiImportTextList(value: unknown): string[] {
  return textList(value);
}

/** The last `max` characters of an answer, for a retry's suffix. */
export function wikiImportLastRunes(value: string, max: number): string {
  return lastRunes(value, max);
}

/** Whether a value is a JSON object (not null, not an array). */
export function wikiImportIsObject(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

/** The code fence a model wraps its answer in; the maintenance run reads `{"offTopic": true}` out of one too. */
export const WIKI_IMPORT_FENCE = FENCE;
