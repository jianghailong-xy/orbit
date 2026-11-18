import {
  WIKI_DEFAULT_TOPICS,
  WIKI_MAINTAIN_JOB,
  WIKI_MAINTENANCE_JOB,
  type WikiDossier,
  type WikiDossierSource,
  type WikiDossierSpan,
  type WikiReviewMode,
  wikiRepeatsNote,
  type WikiPromptedBy,
} from '@orbit/shared';
import {
  answerField,
  wikiImportDeferredAnchors,
  cutRunes,
  goTrimSpace,
  wikiImportFieldValue,
  wikiImportIsObject,
  wikiImportLastRunes,
  wikiImportOptionalFields,
  wikiImportRequiredFields,
  wikiImportText,
  wikiImportTextList,
  parseWikiImportAnswer,
  type WikiImportAnswerEntry,
  type WikiImportNote,
  WIKI_IMPORT_FENCE,
} from './wiki-import-extract';

/**
 * The model's part of a maintenance run the server executes (contracts/wiki.contract.json
 * `maintenance.job.server`, design §8, P8): the extraction prompt and everything the model's answer is held
 * to before it becomes an op — the off-topic answer, the parse, each entry's kind and fields, every source a
 * line of the dossier with its quote copied from it, the anchors the space's snapshot holds, the one retry
 * with the reasons the first answer was refused, the batches a run proposes in, and the circuit breaker's
 * hold-back over them. Ported from `src/runner-go/wiki_maintain.go`, which did the same on the runner until
 * P11 removed it.
 *
 * ONE RULE, NO DRIFT. This file answers what the runner's Go code answered for the same input: the prompt,
 * the line reading, the plain comparison, the quote's place in the record, the retry suffix, the batch
 * grouping and the breaker's page arithmetic are the Go functions' word for word. What is
 * not a port is where the anchors are checked — the runner held them to its checkout, and the server holds
 * them to the space's snapshot of origin/main (`repoOps`) — and where the model is: the request queue, with
 * the deployment's System model.
 *
 * Nothing here touches the database or the model: the job (`wiki-maintain-job.ts`) asks, and this reads.
 */

/** The whole system prompt an extraction call carries (the demo's EXTRACT_SYSTEM). */
export const WIKI_MAINTAIN_SYSTEM_PROMPT = 'You compile durable engineering knowledge from a coding-agent work record into wiki '
  + 'entries. You output only a JSON array.';

/** The kinds an extraction may give (the phase-1 kinds); a principle is the owner's alone and is counted, not kept. */
export const WIKI_MAINTAIN_KINDS = ['principle', 'convention', 'decision', 'pitfall', 'recipe', 'concept'] as const;

/** One topic of the space, as the prompt's TOPIC TABLE and an entry's `topic` read it. */
export interface WikiMaintainTopic {
  slug: string;
  title: string;
  description: string;
}

/** What the prompt is told about the space and its repository. */
export interface WikiMaintainPromptContext {
  title: string;
  repo: { urlNorm: string };
  topics: readonly WikiMaintainTopic[];
}

/** The topics a space with none of its own extracts against (`WIKI_DEFAULT_TOPICS`), as the context route answers. */
export function wikiMaintainTopicsOf(topics: ReadonlyArray<{ slug: string; title: string; description: string | null }>): WikiMaintainTopic[] {
  if (topics.length === 0) {
    return WIKI_DEFAULT_TOPICS.map((topic) => ({ slug: topic.slug, title: topic.title, description: topic.description }));
  }
  return topics.map((topic) => ({ slug: topic.slug, title: topic.title, description: topic.description ?? '' }));
}

/** Who speaks in a case file: the lines of the extraction prompt's legend. */
const WIKI_MAINTAIN_SPEAKERS = `- owner: the human account owner (their words carry the most weight); user: a message most likely typed by the owner
- sender / parent: a message from another agent (a coordinator) — not the owner
- taskprompt: the task's opening prompt (title, description) written by the owner or a coordinator
- agent: the coding agent's reply; think: sentences from the agent's private reasoning; sub-agent: a helper agent
- tool: a tool call and its result ("ERR:" marks a failure, "×N" folds repeated reads/edits)
- comment / merge / blocker / openitem / system: task records`;

/** The answer for a case about something else. */
const WIKI_MAINTAIN_OFF_TOPIC = `FIRST: if this case is not about the repository above and the way it is developed — another product, a personal errand, a conversation about something else — output exactly {"offTopic": true} and nothing else.`;

/** An entry as the model is to write it, with what its kind asks for and the rules it is held to. */
const WIKI_MAINTAIN_ENTRY_SHAPE = `{"kind": "principle|convention|decision|pitfall|recipe|concept",
 "title": "<= 60 chars, states the knowledge itself (not the task)",
 "summary": "one or two short sentences a future agent can act on",
 "topic": one topic key from the TOPIC TABLE,
 ...the kind's own fields at the top level (below)...,
 "anchors": {"paths": [repo-relative file paths named in the case], "commits": [commit shas named in the case]},
 "sources": [{"ref": "L12", "quote": "exact words copied from line L12"}],
 "verified": true if the case shows it confirmed by a command or result, false if it is only claimed}
The kind's own fields (all required; be terse: each text field is one short sentence, <= 60 Chinese characters or 30 English words):
- principle: "statement", "rationale"
- convention: "rule", "scope": ["where it applies"], "exceptions" ("" if none)
- decision: "context", "decision", "alternatives": [{"option": "...", "whyRejected": "..."}], "consequences", "decidedAt": "YYYY-MM-DD"
- pitfall: "trigger": {"paths": [...], "commands": [...], "errorSignature": "..."} (at least one non-empty; [] for an empty list), "symptom", "cause", "fix"
- recipe: "steps": ["..."], "verify": {"command": "...", "expectedExit": 0}
- concept: "definition", "boundaries"
RULES:
- sources: 1 or 2 per entry. The quote is a contiguous span copied character for character from the line with that ref (<= 150 chars, no "…", no paraphrase, no translation). Quote the words the line carries from its record, never the case file's own markers ("$ ", "→ ok:", "ERR:", "(steer)", "…[cut]", "×N"). Never quote a span holding [redacted]. Prefer spans without double-quote characters; if one is unavoidable, escape it as \\".
- Write titles and text fields in English, whatever language the case is in; keep code, paths and commands verbatim.
- Only put a path in anchors if it appears in the case and is a path of this repository; never invent paths or shas.`;

/** The repository and the topics, as a prompt names them. */
function wikiMaintainPromptScope(context: WikiMaintainPromptContext, about: string): { name: string; scope: string; topics: string } {
  // filepath.Base of the repository URL, as the Go prompt read it.
  const trimmed = context.repo.urlNorm.replace(/\/+$/u, '');
  const name = context.repo.urlNorm !== '' ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : context.title;
  let scope = `THE REPOSITORY: ${JSON.stringify(name)}`;
  if (context.repo.urlNorm !== '') scope += ` (${context.repo.urlNorm})`;
  if (about !== '') scope += ` — ${about}`;
  let topics = '';
  for (const topic of context.topics) topics += `- ${topic.slug}: ${topic.description !== '' ? topic.description : topic.title}\n`;
  return { name, scope, topics };
}

/**
 * The demo's extraction prompt (prompts.py EXTRACT_INSTRUCTIONS, the A2+6 run: at most six entries, the
 * few-shot example), for this space's repository: the model is told which repository the case is about and
 * what it is, and to say so when the case is about something else.
 */
export function wikiMaintainPrompt(context: WikiMaintainPromptContext, about: string, dossier: string): string {
  const { name, scope, topics } = wikiMaintainPromptScope(context, about);
  return `Below is a CASE FILE: a compressed timeline of one piece of work in the "${name}" repository (one task, possibly retried, or one standalone chat session).
${scope}
Each line starts with a ref (like L37) and a speaker:
${WIKI_MAINTAIN_SPEAKERS}
"… (N lines omitted)" marks lines left out.

${WIKI_MAINTAIN_OFF_TOPIC}

TASK: extract the knowledge from this case that would change how a future agent works in this repository and that it could NOT learn by reading the code for one minute:
- owner rules and corrections (how the owner wants things done) -> convention (or principle, if it is a general value with a reason)
- decisions the owner made, with the alternatives and why they were rejected -> decision
- traps and surprises: something behaved differently than expected, with the cause and the fix -> pitfall
- a multi-step procedure that was run and verified to work -> recipe
- the meaning of a project-specific term or mechanism that is easy to get wrong -> concept
Do NOT extract: task progress or status reports, what was built, one-off facts about this task only, generic programming advice, or anything the code states plainly. Prefer fewer, stronger entries. If there is nothing worth keeping, output [].

OUTPUT: a JSON array (at most ${WIKI_MAINTENANCE_JOB.entriesPerSessionMax} objects), nothing else — no prose, no code fence. Each object is FLAT:
${WIKI_MAINTAIN_ENTRY_SHAPE}

TOPIC TABLE:
${topics}
EXAMPLE (a fictional repository, for format only):
CASE: Fix the flaky upload test
task · 1 session(s) · 2025-03-02 → 2025-03-02 · task status DONE · completion EXECUTABLE

L1 meta: ── session 1 · 2025-03-02 09:10 · claude ──
L2 taskprompt: Start the task "Fix the flaky upload test". Description: upload.spec.ts times out now and then on CI.
   … (3 lines omitted)
L6 tool: $ npm test -w api -- upload.spec.ts → ERR: Exit code 1 … Error: connect ECONNREFUSED 127.0.0.1:9000
L7 think: Turns out STORAGE_PORT is read when the module is imported, before the fixture sets it.
L8 tool: edit src/api/test/storage-fixture.ts → ok
L9 tool: $ npm test -w api -- upload.spec.ts → ok: 14 passing
L10 owner: From now on, never hard-code the port in a fixture; always take it from what the fixture returns.
L11 agent: OK. Root cause: STORAGE_PORT is read when the module is imported, and the fixture sets it only afterwards, so the test connected to the default 9000. The fixture now returns the url.
OUTPUT:
[{"kind":"pitfall","title":"STORAGE_PORT is read at import, before the fixture sets it","summary":"A test must set STORAGE_PORT before the import, or it connects to the default 9000 and fails with ECONNREFUSED.","topic":"testing","trigger":{"paths":["src/api/test/storage-fixture.ts"],"commands":["npm test -w api -- upload.spec.ts"],"errorSignature":"connect ECONNREFUSED 127.0.0.1:9000"},"symptom":"The upload test fails now and then with ECONNREFUSED 127.0.0.1:9000","cause":"STORAGE_PORT is read when the module is imported, and the fixture sets it too late","fix":"The fixture returns the url, and the test takes the address from it","anchors":{"paths":["src/api/test/storage-fixture.ts"],"commits":[]},"sources":[{"ref":"L6","quote":"Error: connect ECONNREFUSED 127.0.0.1:9000"},{"ref":"L11","quote":"STORAGE_PORT is read when the module is imported, and the fixture sets it only afterwards"}],"verified":true},
 {"kind":"convention","title":"Test fixtures never hard-code the port","summary":"A test fixture always takes the port from what the fixture returns.","topic":"testing","rule":"never hard-code the port in a fixture; always take it from what the fixture returns","scope":["test fixtures"],"exceptions":"","anchors":{"paths":[],"commits":[]},"sources":[{"ref":"L10","quote":"From now on, never hard-code the port in a fixture; always take it from what the fixture returns."}],"verified":false}]

A case with only routine progress (edits, a passing test, "done") -> []
A case about something other than the repository above -> {"offTopic": true}

==== CASE FILE ====
${dossier}
==== END OF CASE FILE ====
Output the JSON array now.`;
}

/** What the model may say became of a note (§3.3), in the words the prompt gives it. */
export const WIKI_MAINTAIN_NOTE_OUTCOMES = ['shown', 'narrowed', 'contradicted', 'absent', 'not_durable'] as const;

/** A note's outcome, or `unanswered`: the model did not say, or not so that it can be read, and nobody asks again. */
export type WikiMaintainNoteOutcome = (typeof WIKI_MAINTAIN_NOTE_OUTCOMES)[number] | 'unanswered';

/** What the model said of one note: its outcome, and the lines it named as showing it. */
export interface WikiMaintainNoteAnswer {
  outcome: WikiMaintainNoteOutcome;
  shownBy: string[];
}

/** The most lines `wikiMaintainCiteShownBy` adds to an entry's sources. */
const WIKI_MAINTAIN_NOTE_SOURCES_ADDED = 2;

/**
 * What the model said of each of the case's notes, read from wherever in its answer it said so: each
 * `{"note": "C1", "outcome": "shown", "shownBy": ["L12"]}` is a flat object of its own, so a broken entry beside it
 * costs it nothing. The first it said of a note counts; a note it does not name is `unanswered`.
 */
export function wikiMaintainNoteAnswers(answer: string, refs: readonly string[]): Map<string, WikiMaintainNoteAnswer> {
  const answers = new Map<string, WikiMaintainNoteAnswer>(refs.map((ref) => [ref, { outcome: 'unanswered', shownBy: [] }]));
  for (const [flat] of answer.matchAll(/\{[^{}]*\}/gu)) {
    let said: unknown;
    try {
      said = JSON.parse(flat);
    } catch {
      continue;
    }
    if (!wikiImportIsObject(said)) continue;
    const note = answerField(said, 'note');
    const outcome = answerField(said, 'outcome');
    if (typeof note !== 'string' || typeof outcome !== 'string' || answers.get(note)?.outcome !== 'unanswered') continue;
    if (!(WIKI_MAINTAIN_NOTE_OUTCOMES as readonly string[]).includes(outcome)) continue;
    answers.set(note, { outcome: outcome as WikiMaintainNoteOutcome, shownBy: wikiImportTextList(answerField(said, 'shownBy')) });
  }
  return answers;
}

/**
 * The speakers whose lines may say what happened or what the owner said. This only picks which of the lines the model
 * named to add; what a source counts as is `wikiEvidenceClass`'s to say, from its record, when it is read.
 */
const FIRST_HAND_SPEAKERS = new Set(['tool', 'merge', 'owner', 'blocker']);
/** The speakers whose words are the owner's: a source of theirs is quoted, or it does not read as their words. */
const OWNER_SPEAKERS = new Set(['owner', 'blocker']);
/** A tool line that wrote a file: what the agent wrote, not what happened (`wikiEvidenceClass`). */
const WRITE_TOOL_LINE = /^(?:edit|write|multiedit|notebookedit)(?: | ×)/u;

/**
 * An entry that came from a note also cites what the model said shows that note: it names the lines in `shownBy`
 * and then often writes the entry from the agent's reply about them, which only says what the agent believed. At
 * most `WIKI_MAINTAIN_NOTE_SOURCES_ADDED` first-hand lines are added to an op's sources, each one's record cited as
 * any other, and the verdict is still the verifier's, from those records.
 */
export function wikiMaintainCiteShownBy(
  ops: readonly WikiMaintainOp[],
  notes: ReadonlyMap<string, WikiMaintainNoteAnswer>,
  lines: ReadonlyMap<string, WikiMaintainLine>,
  noteWords: ReadonlyMap<string, string> = new Map(),
): void {
  for (const op of ops) {
    const shownBy = op.note ? notes.get(op.note)?.shownBy ?? [] : [];
    const noted = op.note ? noteWords.get(op.note) : undefined;
    const sources = op.body.sources as Array<Record<string, unknown>>;
    const cited = new Set(sources.map((source) => `${String(source.kind)}:${String(source.ref)}`));
    let added = 0;
    for (const ref of shownBy) {
      const line = lines.get(ref);
      if (!line || !FIRST_HAND_SPEAKERS.has(line.author) || WRITE_TOOL_LINE.test(line.text) || cited.has(`${line.kind}:${line.id}`)) continue;
      // A tool line that repeats the note shows that the note was read somewhere, not that it holds (`wikiFirstHandForNote`).
      if (line.author === 'tool' && noted !== undefined && wikiRepeatsNote(line.text, noted)) continue;
      if (added === WIKI_MAINTAIN_NOTE_SOURCES_ADDED) break;
      const source: Record<string, unknown> = { kind: line.kind, ref: line.id };
      const words = OWNER_SPEAKERS.has(line.author) ? line.spans.find((span) => (span.text ?? '').trim() !== '')?.text : undefined;
      const placed = words ? wikiMaintainPlace(line.spans, cutRunes(words, WIKI_MAINTAIN_JOB.quoteMaxChars)) : null;
      if (placed) {
        source.quote = placed.words;
        source.locator = { start: placed.start, end: placed.end };
      }
      sources.push(source);
      cited.add(`${line.kind}:${line.id}`);
      added += 1;
    }
  }
}

/** A case file's notes as its `C1 claim:` lines say them, by ref, the lines that continue one included. */
function wikiMaintainNoteWords(text: string): Map<string, string> {
  const words = new Map<string, string>();
  let current = '';
  for (const raw of text.split('\n')) {
    const head = /^(C\d+) claim: (.*)$/u.exec(raw);
    if (head) {
      current = head[1];
      words.set(current, head[2]);
    } else if (current !== '' && raw.startsWith(WIKI_MAINTAIN_CONTINUATION)) {
      words.set(current, `${words.get(current)}\n${raw.slice(WIKI_MAINTAIN_CONTINUATION.length)}`);
    } else {
      current = '';
    }
  }
  return words;
}

// ── The pass that only checks the agent's notes (docs/wiki-memory-claims-design.md §6.2) ─────────

/** The whole system prompt of a call of that pass. */
export const WIKI_MAINTAIN_CLAIMS_SYSTEM_PROMPT = 'You check what a coding agent wrote to its own memory against the record of its work, '
  + 'and compile what holds up into wiki entries. You output only a JSON object.';

/**
 * The prompt of the pass: no extraction from the case at large, which `wikiMaintainPrompt` does on its own file. Each
 * note is a question for the lines to answer, and an entry is written only from a note they show.
 */
export function wikiMaintainClaimsPrompt(context: WikiMaintainPromptContext, about: string, dossier: string): string {
  const { name, scope, topics } = wikiMaintainPromptScope(context, about);
  return `Below is a CASE FILE: what a coding agent wrote to its own memory during one piece of work in the "${name}" repository, among the lines of the work that bear on it.
${scope}
Each line starts with a ref (like L37 or C1) and a speaker:
- claim: a note the agent wrote to its own memory. It is what the agent believed, not evidence
${WIKI_MAINTAIN_SPEAKERS}
"… (N lines omitted)" marks lines left out.

${WIKI_MAINTAIN_OFF_TOPIC}

TASK: check each note (each C line) against the L lines, and keep only what holds up and is worth keeping. First ask of each note whether it holds anything that would change how a future agent works in this repository and that it could NOT learn by reading the code for one minute. If not, its outcome is not_durable, whatever the lines show. Otherwise give it one of the others:
- shown: a tool or owner line shows the very thing the note says. Name those lines in "shownBy".
- narrowed: such lines show part of what the note says. Name them, and keep only that part.
- contradicted: the lines show otherwise.
- absent: the lines neither show nor refute it. A line on the same subject that does not show this very thing is absent. So is a note that only an agent, think, sender, parent or taskprompt line repeats: those lines say what someone believed, and the note is what the agent believed.
- not_durable: task progress or status reports, what was built, where something lives, one-off facts about this task only, generic programming advice, or anything the code states plainly.
Then write one entry for each note you answered shown or narrowed, from what its lines show. A note that says several things still gets one entry: the one thing in it a future agent would most need, and that its lines show. Write no other entry: nothing from a note answered contradicted, absent or not_durable, and nothing from lines no note is about.

OUTPUT: one JSON object, nothing else — no prose, no code fence. "notes" has one object for every C line, and comes first. "entries" has one object for every note answered shown or narrowed, and each starts with that note's "note":
{"notes": [{"note": "C1", "outcome": "shown", "shownBy": ["L12", "L15"]}, {"note": "C2", "outcome": "absent", "shownBy": []}],
 "entries": [{"note": "C1", "kind": ...}]}
Each object in "entries" is FLAT:
${WIKI_MAINTAIN_ENTRY_SHAPE}
- An entry cites the lines of its note's "shownBy". A C line is never a source: citing one drops the entry.

TOPIC TABLE:
${topics}
EXAMPLE (a fictional repository, for format only):
CASE: Fix the flaky upload test
task · 1 session(s) · 2025-03-02 → 2025-03-02 · task status DONE · completion EXECUTABLE

L6 tool: $ npm test -w api -- upload.spec.ts → ERR: Exit code 1 … Error: connect ECONNREFUSED 127.0.0.1:9000
L7 think: Turns out STORAGE_PORT is read when the module is imported, before the fixture sets it.
L8 tool: edit src/api/test/storage-fixture.ts → ok
L9 tool: $ npm test -w api -- upload.spec.ts → ok: 14 passing
C1 claim: The upload test fails with ECONNREFUSED 127.0.0.1:9000 until the fixture returns the url.
C2 claim: The upload service retries three times before it gives up.
C3 claim: Task 12 is done and merged.
OUTPUT:
{"notes":[{"note":"C1","outcome":"shown","shownBy":["L6","L9"]},{"note":"C2","outcome":"absent","shownBy":[]},{"note":"C3","outcome":"not_durable","shownBy":[]}],
 "entries":[{"note":"C1","kind":"pitfall","title":"The upload test needs the url from the fixture","summary":"The upload test fails with ECONNREFUSED 127.0.0.1:9000 until the fixture returns the url.","topic":"testing","trigger":{"paths":["src/api/test/storage-fixture.ts"],"commands":["npm test -w api -- upload.spec.ts"],"errorSignature":"connect ECONNREFUSED 127.0.0.1:9000"},"symptom":"The upload test fails with ECONNREFUSED 127.0.0.1:9000","cause":"The test connects before it has the fixture's address","fix":"The fixture returns the url, and the test takes the address from it","anchors":{"paths":["src/api/test/storage-fixture.ts"],"commits":[]},"sources":[{"ref":"L6","quote":"Error: connect ECONNREFUSED 127.0.0.1:9000"},{"ref":"L9","quote":"14 passing"}],"verified":true}]}

==== CASE FILE ====
${dossier}
==== END OF CASE FILE ====
Output the JSON object now.`;
}

/** Ask once more, naming what did not hold up and which notes the answer owes an entry. */
function wikiMaintainClaimsRetrySuffix(answer: string, parsed: boolean, built: WikiMaintainBuilt, owed: readonly string[]): string {
  const problems = [
    ...(parsed ? [] : ['the output was not a valid JSON object of notes and flat entry objects']),
    ...built.problems.slice(0, 12),
    ...owed.map((ref) => `note ${ref} was answered shown or narrowed and has no entry: write it, or answer it again as absent`),
  ];
  const before = parsed ? cutRunes(JSON.stringify(built.rejected), 6000) : wikiImportLastRunes(answer, 3000);
  return `\n\nYOUR ANSWER DID NOT HOLD UP:\n${before}\n\nPROBLEMS:\n- ${problems.join('\n- ')}\n`
    + 'Output the JSON object again: "notes" as before, for every C line, and in "entries" ONLY the corrected entries and the ones '
    + 'still owed, each with its "note" (flat objects as specified; copy quotes exactly from the cited line; fill every required '
    + 'field). Drop an entry you cannot support. Output the JSON object only.';
}

/** What the pass came to for one session. */
export interface WikiMaintainClaimsRun {
  offTopic: boolean;
  /** What the model said of each note the file carries. */
  notes: Map<string, WikiMaintainNoteAnswer>;
  /** One op for a note at most, each from a note answered shown or narrowed. */
  ops: WikiMaintainOp[];
  built: WikiMaintainBuilt | null;
  retried: boolean;
  /** The entries that held up and were not kept: no note, a note not shown, a second one of a note. */
  leftOut: { noNote: number; noteNotShown: number; secondOfNote: number };
  /** The ops as the model cited them, before the lines of `shownBy` were added: how many sources each had. */
  citedByModel: number[];
}

/**
 * The pass, for one file: the model's answer, checked as an extraction's is, the notes it answered read beside the
 * entries, and asked for once more when something did not hold up or a note it says is shown has no entry. `ask` answers
 * null for a second answer that cannot be had; a first one that cannot be had is the caller's failure, as in `extract`.
 * A note is taken from the first answer that says, so that nobody talks the model into a better outcome by asking again.
 */
export async function wikiMaintainCheckClaims(input: {
  dossier: Pick<WikiDossier, 'text' | 'sources' | 'sessionId'>;
  refs: readonly string[];
  context: WikiMaintainPromptContext;
  about: string;
  repo: WikiMaintainRepoGate | null;
  ask: (prompt: string, again: boolean) => Promise<string | null>;
  now?: Date;
}): Promise<WikiMaintainClaimsRun> {
  const { dossier, refs, context, about, repo, ask, now } = input;
  const lines = wikiMaintainLines(dossier);
  const build = (entries: readonly WikiImportAnswerEntry[]) => buildWikiMaintainOps(entries, dossier, lines, repo, context.topics, now);
  const prompt = wikiMaintainClaimsPrompt(context, about, dossier.text);
  const leftOut = { noNote: 0, noteNotShown: 0, secondOfNote: 0 };
  const first = (await ask(prompt, false)) ?? '';
  const notes = wikiMaintainNoteAnswers(first, refs);
  if (wikiMaintainOffTopic(first)) return { offTopic: true, notes, ops: [], built: null, retried: false, leftOut, citedByModel: [] };
  const parsed = parseWikiImportAnswer(first);
  const built = build(parsed ?? []);
  const holds = (ref: string): boolean => {
    const outcome = notes.get(ref)?.outcome;
    return outcome === 'shown' || outcome === 'narrowed';
  };
  const owed = refs.filter((ref) => holds(ref) && !built.ops.some((op) => op.note === ref));
  const retried = parsed === null || built.problems.length > 0 || owed.length > 0;
  if (retried) {
    const again = await ask(prompt + wikiMaintainClaimsRetrySuffix(first, parsed !== null, built, owed), true);
    if (again !== null) {
      for (const [ref, said] of wikiMaintainNoteAnswers(again, refs)) {
        if (notes.get(ref)?.outcome === 'unanswered') notes.set(ref, said);
      }
      const second = parseWikiImportAnswer(again);
      if (second !== null) mergeWikiMaintainBuilt(built, build(second));
    }
  }
  const taken = new Set<string>();
  const ops = built.ops.filter((op) => {
    if (!op.note) leftOut.noNote += 1;
    else if (!holds(op.note)) leftOut.noteNotShown += 1;
    else if (taken.has(op.note)) leftOut.secondOfNote += 1;
    else {
      taken.add(op.note);
      return true;
    }
    return false;
  });
  const citedByModel = ops.map((op) => (op.body.sources as unknown[]).length);
  wikiMaintainCiteShownBy(ops, notes, lines, wikiMaintainNoteWords(dossier.text));
  return { offTopic: false, notes, ops, built, retried, leftOut, citedByModel };
}

/** The model saying the session is not about this repository: `{"offTopic": true}`. */
export function wikiMaintainOffTopic(answer: string): boolean {
  let text = goTrimSpace(answer);
  const fenced = WIKI_IMPORT_FENCE.exec(text);
  WIKI_IMPORT_FENCE.lastIndex = 0;
  if (fenced) text = goTrimSpace(fenced[1]);
  if (!text.startsWith('{')) return false;
  try {
    // Go decodes into a struct, so the key reads in any case: {"OffTopic": true} says it too.
    const said = JSON.parse(text) as Record<string, unknown>;
    return said !== null && typeof said === 'object' && answerField(said, 'offTopic') === true;
  } catch {
    return false;
  }
}

// ── The dossier's lines ─────────────────────────────────────────────────────────────────────────

/** One line of a dossier a source may name: its text, the record behind it, and where in that record's text the line's words are. */
export interface WikiMaintainLine {
  text: string;
  kind: string;
  id: string;
  author: string;
  spans: WikiDossierSpan[];
}

/** The indent a dossier line's own later lines carry. */
export const WIKI_MAINTAIN_CONTINUATION = '    ';

const LINE_HEAD = /^L(\d+) ([a-z-]+): ?(.*)$/u;

/**
 * A dossier's named lines: each `L12 owner: …` with the lines that continue it, and the record its sources map
 * the name to. The server writes every newline of a line's text as a newline and four spaces (wiki-dossier.ts),
 * a blank one included, so a line continues exactly as far as the lines under it carry that indent; an omission
 * marker (`   … (N lines omitted)`) has three, and ends it.
 */
export function wikiMaintainLines(dossier: Pick<WikiDossier, 'text' | 'sources'>): Map<string, WikiMaintainLine> {
  const records = new Map<string, WikiDossierSource>();
  for (const source of dossier.sources) records.set(source.ref, source);
  const lines = new Map<string, WikiMaintainLine>();
  let current = '';
  for (const raw of dossier.text.split('\n')) {
    const head = LINE_HEAD.exec(raw);
    if (head) {
      current = `L${head[1]}`;
      const record = records.get(current);
      if (!record) {
        current = '';
        continue;
      }
      lines.set(current, { text: head[3], kind: record.kind, id: record.id, author: head[2], spans: record.spans ?? [] });
      continue;
    }
    if (current === '' || !raw.startsWith(WIKI_MAINTAIN_CONTINUATION)) {
      current = '';
      continue;
    }
    const line = lines.get(current)!;
    line.text += `\n${raw.slice(WIKI_MAINTAIN_CONTINUATION.length)}`;
  }
  return lines;
}

/** Go's unicode.IsSpace, which strings.Fields reads by (the port's own copy, as wiki-import-extract's is). */
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const GO_FIELDS = new RegExp(`[${GO_SPACE}]+`, 'u');
const GO_SPACE_ONE = new RegExp(`^[${GO_SPACE}]$`, 'u');

/**
 * Text as the demo's `norm_quote` compared it: backticks and asterisks out, curly quotes straight, runs of
 * whitespace one space.
 */
export function wikiMaintainPlain(text: string): string {
  return wikiMaintainPlainRunes([...text]).plain.join('').split(GO_FIELDS).filter((part) => part !== '').join(' ');
}

/**
 * {@link wikiMaintainPlain} over code points, with where each one it keeps stands in the code points it was
 * given: a run of whitespace is the one space at its first code point.
 */
export function wikiMaintainPlainRunes(words: readonly string[]): { plain: string[]; at: number[] } {
  const plain: string[] = [];
  const at: number[] = [];
  let space = -1;
  for (let i = 0; i < words.length; i += 1) {
    const r = words[i];
    if (r === '`' || r === '*') continue;
    if (GO_SPACE_ONE.test(r)) {
      if (space < 0) space = i;
      continue;
    }
    if (space >= 0 && plain.length > 0) {
      plain.push(' ');
      at.push(space);
    }
    space = -1;
    let kept = r;
    if (kept === '“' || kept === '”' || kept === '„') kept = '"';
    else if (kept === '‘' || kept === '’') kept = "'";
    plain.push(kept);
    at.push(i);
  }
  return { plain, at };
}

/** Where `needle` first stands in `haystack`, or -1. */
function runesIndex(haystack: readonly string[], needle: readonly string[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let j = 0;
    while (j < needle.length && haystack[i + j] === needle[j]) j += 1;
    if (j === needle.length) return i;
  }
  return -1;
}

/**
 * Find a quote in the words a line's spans hold, read as a quote is compared ({@link wikiMaintainPlain}:
 * markdown marks and curly quotes aside, a run of whitespace one space), and answer the record's own words
 * there — marks, quotes and spacing as the record has them — and where they are: code points of the record's
 * redacted text, cut to the quote limit. A quote no single span holds, or whose words the redactor took out,
 * is not the record's words, and is not placed.
 */
export function wikiMaintainPlace(spans: readonly WikiDossierSpan[], quote: string): { words: string; start: number; end: number } | null {
  const want = [...wikiMaintainPlain(quote)];
  if (want.length === 0) return null;
  for (const span of spans) {
    const words = [...(span.text ?? '')];
    const { plain, at } = wikiMaintainPlainRunes(words);
    const i = runesIndex(plain, want);
    if (i < 0) continue;
    let start = at[i];
    let end = at[i + want.length - 1] + 1;
    if (end - start > WIKI_MAINTAIN_JOB.quoteMaxChars) end = start + WIKI_MAINTAIN_JOB.quoteMaxChars;
    const found = words.slice(start, end).join('');
    if (found.includes('[redacted]')) return null;
    return { words: found, start: span.start + start, end: span.start + end };
  }
  return null;
}

// ── An entry, checked ───────────────────────────────────────────────────────────────────────────

/** One add a run may propose, and where it came from. */
export interface WikiMaintainOp {
  body: Record<string, unknown>;
  topic: string;
  session: string;
  title: string;
  /** The note of the case file the entry came from (`C1`), when the model said and the case carries it. Not a source. */
  note?: string;
  /** The write that note is, for the op to keep: set by the run on the ops of the pass that checks the notes. */
  promptedBy?: WikiPromptedBy;
}

/** Why an op is here, and what was wrong with the rest of an answer: the runner's `wikiMaintainBuilt`. */
export interface WikiMaintainBuilt {
  ops: WikiMaintainOp[];
  rejected: WikiImportAnswerEntry[];
  problems: string[];
  extracted: number;
  dropped: number;
  foreign: number;
  principles: number;
  titles: Set<string>;
}

/** The repository's anchors, as the space's snapshot answers them: a path the tree has, a commit origin/main reaches. */
export interface WikiMaintainRepoGate {
  /** The anchors that hold up in the tree the run reads. */
  anchors(raw: unknown): Array<Record<string, string | boolean>>;
  /**
   * False on a folder, which checks no commit (docs/wiki-repo-tiers-design.md §5.1): a commit an entry names is not
   * taken, and is not counted among the anchors it names, so an entry naming only commits is kept with no code anchor.
   */
  readsCommits?: boolean;
}

const DATE_IN_TEXT = /started (\d{4}-\d{2}-\d{2})/u;

/**
 * Each entry checked the way the demo's extract.py validated it, and an add of the ones that hold up: a known
 * kind with its fields, sources that are lines of the dossier with their quotes copied from those lines, and
 * anchors that exist in the space's snapshot. An entry whose code anchors all point outside the repository is
 * another repository's knowledge, and is dropped. With no snapshot (`repo` null) its code anchors are kept as
 * `deferred` (contract `anchorRules.deferred`) rather than dropped; on a folder (`readsCommits` false) its commits are
 * not taken at all.
 */
export function buildWikiMaintainOps(
  entries: readonly WikiImportAnswerEntry[],
  dossier: Pick<WikiDossier, 'text' | 'sessionId'>,
  lines: ReadonlyMap<string, WikiMaintainLine>,
  repo: WikiMaintainRepoGate | null,
  topics: readonly WikiMaintainTopic[],
  now: Date = new Date(),
): WikiMaintainBuilt {
  const built: WikiMaintainBuilt = { ops: [], rejected: [], problems: [], extracted: 0, dropped: 0, foreign: 0, principles: 0, titles: new Set() };
  let date = now.toISOString().slice(0, 10);
  const found = DATE_IN_TEXT.exec(dossier.text);
  if (found) date = found[1];
  const known = new Set(topics.map((topic) => topic.slug));
  for (const entry of entries) {
    const item = entry ?? {};
    built.extracted += 1;
    const kind = wikiImportText(item.kind, 120).toLowerCase();
    const title = wikiImportText(item.title, 120);
    if (kind === 'principle') {
      // A principle is the owner's alone to write (WIKI_KIND_OWNER_ONLY): set aside, and counted.
      built.principles += 1;
      continue;
    }
    const problems: string[] = [];
    const reject = (list: readonly string[]): void => {
      built.dropped += 1;
      built.rejected.push(item);
      for (const problem of list) built.problems.push(`entry ${JSON.stringify(cutRunes(title, 40))}: ${problem}`);
    };
    if (!(WIKI_MAINTAIN_KINDS as readonly string[]).includes(kind)) {
      reject([`kind ${JSON.stringify(kind)} is not one of ${WIKI_MAINTAIN_KINDS.slice(1).join(', ')}`]);
      continue;
    }
    const summary = wikiImportText(item.summary, 280);
    if (title === '') problems.push('title is missing');
    if (summary === '') problems.push('summary is missing');
    const nested = wikiImportIsObject(item.fields) ? item.fields : {};
    const field = (name: string): unknown => (Object.hasOwn(item, name) ? item[name] : nested[name]);
    const fields: Record<string, unknown> = {};
    const note: WikiImportNote = { id: dossier.sessionId, path: '', date, text: dossier.text, lang: '' };
    for (const name of wikiImportRequiredFields(kind)) {
      const checked = wikiImportFieldValue(name, field(name), note);
      if (checked.problem !== '') {
        problems.push(checked.problem);
        continue;
      }
      fields[name] = checked.value;
    }
    for (const name of wikiImportOptionalFields(kind)) {
      const value = wikiImportText(field(name), 4000);
      if (value !== '') fields[name] = value;
    }
    const { sources, problems: sourceProblems } = wikiMaintainSources(item.sources, lines);
    problems.push(...sourceProblems);
    if (sources.length === 0) problems.push('no valid source: cite a line of the case file, with its quote copied from it');
    if (problems.length > 0) {
      reject(problems);
      continue;
    }
    const given = wikiImportIsObject(item.anchors) ? item.anchors : {};
    const named = wikiImportTextList(given.paths).length + (repo?.readsCommits === false ? 0 : wikiImportTextList(given.commits).length);
    // With no snapshot (the sessions tier), the anchors it names are kept, deferred to the first run that reads the
    // code (docs/wiki-repo-tiers-design.md §5.2): nothing says yet whose they are.
    const anchors: Array<Record<string, string | boolean>> = repo ? repo.anchors(item.anchors) : wikiImportDeferredAnchors(item.anchors);
    if (named > 0 && anchors.length === 0) {
      // Every code anchor it names is outside this repository — or, with no snapshot, none reads as a path of a
      // repository or a whole sha: the knowledge is another repository's.
      built.foreign += 1;
      continue;
    }
    const draft: Record<string, unknown> = { kind, title, summary, fields };
    let topic = wikiImportText(item.topic, 200);
    if (known.has(topic)) draft.topics = [topic];
    else topic = '';
    if (anchors.length > 0) draft.anchors = anchors;
    if (built.titles.has(title.toLowerCase())) {
      built.dropped += 1;
      continue;
    }
    built.titles.add(title.toLowerCase());
    const op: WikiMaintainOp = { body: { op: 'add', entry: draft, sources }, topic, session: dossier.sessionId, title };
    const noted = wikiImportText(item.note, 20);
    if (/^C\d+$/u.test(noted) && dossier.text.includes(`\n${noted} claim: `)) op.note = noted;
    built.ops.push(op);
  }
  return built;
}

/** The retry's ops in place of the entries it corrected; a principle in it was already counted. */
export function mergeWikiMaintainBuilt(built: WikiMaintainBuilt, retry: WikiMaintainBuilt): void {
  for (const op of retry.ops) {
    if (built.titles.has(op.title.toLowerCase())) continue;
    built.titles.add(op.title.toLowerCase());
    built.ops.push(op);
    if (built.dropped > 0) built.dropped -= 1;
  }
  built.foreign += retry.foreign;
}

/**
 * An entry's `[{ref, quote}]` as the sources an add cites: the record behind each line it names. A quote that
 * is not copied from that line is a problem. One that is, is proposed as the record's own words where the
 * line's spans put them — its quote those words, its locator their place — and a quote the spans do not hold,
 * the dossier's shorthand for the record, leaves the record cited without one.
 */
export function wikiMaintainSources(
  raw: unknown,
  lines: ReadonlyMap<string, WikiMaintainLine>,
): { sources: Array<Record<string, unknown>>; problems: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const sources: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const source = wikiImportIsObject(item) ? item : {};
    const ref = goTrimSpace(String(source.ref ?? ''));
    const line = lines.get(ref);
    if (!line) {
      problems.push(`source ref ${ref} is not a line of the case file`);
      continue;
    }
    const quote = wikiImportText(source.quote, 4000);
    const plainQuote = wikiMaintainPlain(quote);
    if ([...plainQuote].length < 4) {
      problems.push(`source ${ref} has no quote`);
      continue;
    }
    if (!wikiMaintainPlain(line.text).includes(plainQuote)) {
      problems.push(`quote for ${ref} is not copied exactly from that line`);
      continue;
    }
    const key = `${line.kind}:${line.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cited: Record<string, unknown> = { kind: line.kind, ref: line.id };
    if (line.spans.length === 0) {
      // A server from before dossier lines said where their words are: the line's own words, which the
      // self-check's dry run holds to the record.
      cited.quote = cutRunes(quote, WIKI_MAINTAIN_JOB.quoteMaxChars);
    } else {
      const placed = wikiMaintainPlace(line.spans, quote);
      if (placed) {
        cited.quote = placed.words;
        cited.locator = { start: placed.start, end: placed.end };
      }
    }
    sources.push(cited);
  }
  return { sources, problems };
}

/** Ask once more, naming what did not hold up (prompts.py's retry_suffix). */
export function wikiMaintainRetrySuffix(answer: string, parsed: boolean, built: WikiMaintainBuilt): string {
  const tail = 'Output a JSON array with corrected versions of ONLY these rejected entries (flat '
    + 'objects as specified; copy quotes exactly from the cited line; fill every required field). Drop an entry you cannot '
    + 'support. Output the JSON array only.';
  if (!parsed) {
    return `\n\nSOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n${wikiImportLastRunes(answer, 3000)}`
      + `\n\nPROBLEMS:\n- the output was not a valid JSON array of flat entry objects\n${tail}`;
  }
  const rejected = JSON.stringify(built.rejected);
  const problems = built.problems.slice(0, 12);
  return `\n\nSOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n${cutRunes(rejected, 6000)}\n\nPROBLEMS:\n- `
    + `${problems.join('\n- ')}\n${tail}`;
}

// ── Batches, the dry run and the breaker ────────────────────────────────────────────────────────

/** One changeset's worth of ops, of one topic, and what the dry run said of each. */
export interface WikiMaintainBatch {
  topic: string;
  ops: WikiMaintainOp[];
  /**
   * Of each op whether the review mode would change an entry with it, now or on a verdict — or would have, had
   * the batch left the breaker room for it: what the breaker counts.
   */
  changes: boolean[];
}

/** The most ops one changeset may hold, by the space's mode (`limits.opsPerChangeset`, `limits.opsPerTurn`). */
export function wikiMaintainBatchSize(mode: WikiReviewMode): number {
  return mode === 'manual' ? WIKI_MAINTAIN_JOB.opsPerTurn : WIKI_MAINTAIN_JOB.opsPerChangeset;
}

/** The topic names of a run's ops, in Go's byte order — the order the batches are proposed in. */
export function wikiMaintainTopicOrder(ops: readonly WikiMaintainOp[]): string[] {
  return [...new Set(ops.map((op) => op.topic))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** How many more entries the run may change through the review mode, and whether anything bounds it. */
export function wikiMaintainRemaining(
  reading: { remaining: number | null } | null,
  context: { activeEntries: number; breaker: { minActiveEntries: number; maxChangedPercent: number } },
): { remaining: number; bounded: boolean } {
  if (reading !== null) {
    if (reading.remaining === null) return { remaining: 0, bounded: false };
    return { remaining: reading.remaining, bounded: true };
  }
  const { activeEntries, breaker } = context;
  if (breaker.minActiveEntries <= 0 || breaker.maxChangedPercent <= 0 || activeEntries < breaker.minActiveEntries) {
    return { remaining: 0, bounded: false };
  }
  return { remaining: Math.trunc((activeEntries * breaker.maxChangedPercent) / 100), bounded: true };
}

/**
 * What the breaker holds back, before anything is written (contract `maintenance.job.run.steps`, the breaker).
 * The pages are kept in the order they were read while what their ops would change fits; from the first page
 * that does not fit, every op is held back and the cursor stops where that page starts — the page whose index
 * comes back as `stop`, or null when nothing was held back. `need[page]` is what each page's ops would change.
 */
export function wikiMaintainBreakerHold(
  batches: readonly WikiMaintainBatch[],
  pageOf: ReadonlyMap<string, number>,
  pages: number,
  remaining: number,
): { batches: WikiMaintainBatch[]; heldBack: number; stop: number | null } {
  const need = new Array<number>(pages).fill(0);
  for (const batch of batches) {
    batch.ops.forEach((op, i) => {
      if (batch.changes[i]) need[pageOf.get(op.session) ?? 0] += 1;
    });
  }
  let stop = pages;
  let used = 0;
  for (let page = 0; page < pages; page += 1) {
    if (used + need[page] > remaining) {
      stop = page;
      break;
    }
    used += need[page];
  }
  if (stop === pages) return { batches: [...batches], heldBack: 0, stop: null };
  const kept: WikiMaintainBatch[] = [];
  let heldBack = 0;
  for (const batch of batches) {
    const left: WikiMaintainBatch = { topic: batch.topic, ops: [], changes: [] };
    batch.ops.forEach((op, i) => {
      if ((pageOf.get(op.session) ?? 0) >= stop) {
        heldBack += 1;
        return;
      }
      left.ops.push(op);
      left.changes.push(batch.changes[i]);
    });
    if (left.ops.length > 0) kept.push(left);
  }
  return { batches: kept, heldBack, stop };
}

/** Run `n` calls, `width` at a time, and start none after the first failure that must stop the run. */
export async function wikiMaintainParallel(n: number, width: number, call: (i: number) => Promise<void>): Promise<Error | null> {
  const slots = Math.max(1, width);
  let next = 0;
  let first: Error | null = null;
  const workers = new Array(Math.min(slots, Math.max(n, 1))).fill(0).map(async () => {
    for (;;) {
      if (first !== null) return;
      const i = next;
      next += 1;
      if (i >= n) return;
      try {
        await call(i);
      } catch (error) {
        if (first === null) first = error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  });
  await Promise.all(workers);
  return first;
}

/** The answer of one proposal, as far as a run reads it: the outcomes and the dry run's breaker reading. */
export interface WikiMaintainAnswer {
  changesetId: string | null;
  ops: unknown[];
  breaker: { remaining: number | null } | null;
}

/** One op's outcome as the runner read it: its status, and its first refusal's code and message. */
export function wikiMaintainOutcomeAt(ops: readonly unknown[], index: number): {
  status: string;
  code: string;
  message: string;
  waitsFor: string;
} {
  const row = ops[index];
  if (!wikiImportIsObject(row)) return { status: '', code: '', message: '', waitsFor: '' };
  const status = typeof row.status === 'string' ? row.status : '';
  const waitsFor = typeof row.waitsFor === 'string' ? row.waitsFor : '';
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  const first = reasons.find((reason) => wikiImportIsObject(reason)) as Record<string, unknown> | undefined;
  return {
    status,
    code: typeof first?.code === 'string' ? first.code : '',
    message: typeof first?.message === 'string' ? first.message : '',
    waitsFor,
  };
}
