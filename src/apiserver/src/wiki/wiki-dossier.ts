import { Prisma } from '@prisma/client';
import {
  WIKI_MAINTENANCE_RULES,
  wikiCallDraftsInChat,
  wikiCallReadsWiki,
  wikiCallWritesNote,
  wikiEstimateTokens,
  type WikiDossier,
  type WikiDossierSource,
  type WikiDossierSpan,
  type WikiPromptedBy,
  type WikiSourceKind,
} from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { redactSecrets } from '../common/secret-redaction';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import { approvalParts, hasText, partsText, runEventParts, toolCallParts, toolOutputText, type RecordPart } from './wiki-verify-evidence';

/**
 * One session's DOSSIER: what a Wiki maintenance run reads instead of the session itself (design §8.2
 * step 1, contracts/wiki.contract.json `maintenance.dossier`, criterion 2).
 *
 * WHAT IT IS. The session compressed into a timeline of one-line events — the owner's words, the
 * questions it was asked and the answers, the agent's replies, the sentences of its thinking that carry
 * a signal, a compressed tool timeline, a settled task's closing comments, its merge receipts and the
 * blockers the owner resolved — scored for signals and packed into at most 8,000 estimated tokens.
 * Each line starts with a short name (`L12`) and `sources` maps every name to the first-hand record it
 * came from, which is what a proposal made from the dossier cites.
 *
 * EVERY LINE SAYS WHERE ITS WORDS ARE (criterion 2, revision 2). Beside its record, each line carries
 * spans: where in that record's text — the one text a quote of it is checked against
 * (`wiki-verify-evidence.ts`), redacted — each piece of its words was copied from, in code points, with
 * the words found there. A line copied whole is one span. A line the dossier compressed points at the
 * pieces of the record it was cut from: a tool call at its command and at its result's first and last
 * line, a message cut short at the part it kept, a thought at its signal sentences. A proposal then
 * quotes the record's own words at a known place rather than the dossier's shorthand for them, and
 * whatever reads the proposal can go back to the record and find them there, word for word.
 *
 * WHERE THE RULES COME FROM. This is the demo's deterministic half (task 34VS7P8eDpXiMzpLZ8PY4:
 * `prepare.py` for the timeline, `pack.py` packer v2 for the scoring and the packing), written again in
 * TypeScript: the agent's own trace had to be in it (`release.sh next` tagging a release was only ever
 * in a tool result and a thought), memory-file tool calls had to be out of it, and 8k recalled more
 * than 16k. Where the two differ, the difference is named where it is made.
 *
 * REDACTED FIRST. Every text a record carries goes through the shared redactor, with the owner's
 * workspace.env values as literals, before anything is measured, clipped or packed: what is cut to the
 * budget is already redacted, so no cut can leave half a secret for the redactor to miss.
 *
 * DETERMINISTIC. The same records give the same text, byte for byte, and the same hash. Every list is
 * ordered by a total key (a sequence number, a time and an id), nothing reads the clock, and the only
 * inputs are the records and the literals.
 *
 * NEVER STORED. The text is handed to the maintenance run and forgotten; what is kept is the sources — each
 * span's place, never its words — and the hash (`wiki_dossier`, hard constraint 4).
 *
 * THE AGENT'S NOTES, WHEN ASKED FOR (`DossierOptions.claims`, docs/wiki-memory-claims-design.md §3.1 and §6.2). A
 * write to a memory file is what the agent believed at that moment: a question for the case to answer, never a
 * source. Asked for, the text is another file altogether, for the pass that does nothing but check those notes:
 * each one a `C1 claim:` line at its moment in the timeline, which no source can name, the owner's words, and the
 * records that bear on each note. Not asked for, or with no write to read, the text is the one this file always
 * made, byte for byte. A backfill names imported notes as what a session claimed (`DossierOptions.notes`, design §5): they
 * are read by the same rules, and they stand in for the session's writes, whose earlier versions it does not read again.
 * A session's `wiki_note`s are the same kind of note (design §4), read from their rows: a call that files one is left out of
 * every dossier, as a read of the wiki is, so that a note cannot come back as a source.
 */

// ── The records one session's dossier is made from ──────────────────────────────────────────────

/** Anything that can run a raw read: the service's client or a transaction's. */
export type DossierReader = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface DossierSessionRow {
  id: string;
  title: string;
  provider: string;
  /** The CLI that ran it (migration 0414); null on a row from before that, whose provider says. */
  engine?: string | null;
  model: string | null;
  status: string;
  createdAt: Date;
  taskId: string | null;
  parentSessionId: string | null;
  dispatchOrigin: string;
  /** The space this session is a wiki chat of (migration 0476), or null: a chat's drafting calls stay out. */
  wikiChatSpaceId?: string | null;
}

export interface DossierTurnRow {
  id: string;
  seq: number;
  kind: string;
  clientTurnId: string;
  sendIntent: string | null;
  content: string | null;
  createdAt: Date;
}

export interface DossierApprovalRow {
  id: string;
  toolName: string;
  status: string;
  message: string | null;
  answers: unknown;
  questions: unknown;
  plan: string | null;
  input: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** A `wiki_note` the session wrote (migration 0472): its stored text, redacted when it was kept. */
export interface DossierWikiNote {
  id: string;
  text: string;
  createdAt: Date;
}

/** A write to a memory file as the event's input holds it, each text cut to `WIKI_DOSSIER_CLAIMS.bodyMaxChars`. */
export interface DossierMemoryWrite {
  content: string | null;
  oldString: string | null;
  newString: string | null;
  /** MultiEdit's list, as the tool's input holds it. */
  edits: unknown;
}

export interface DossierEventRow {
  id: string;
  seq: number;
  type: string;
  createdAt: Date;
  text: string | null;
  parentToolUseId: string | null;
  toolUseId: string | null;
  toolName: string | null;
  command: string | null;
  filePath: string | null;
  /** Which key of the input the path is: `file_path`, `path` or `notebook_path`. */
  filePathKey: string | null;
  pattern: string | null;
  background: string | null;
  input: string | null;
  /** The write, when this tool_use is one to a memory file (`MEMORY_FILE`). */
  memoryWrite?: DossierMemoryWrite | null;
  resultOf: string | null;
  isError: string | null;
  resultHead: string | null;
  resultTail: string | null;
  bgCommand: string | null;
  bgStatus: string | null;
  bgExit: string | null;
  bgSummary: string | null;
  errorMessage: string | null;
  subtype: string | null;
}

export interface DossierTaskRow {
  id: string;
  title: string;
  status: string;
  acceptanceCriteria: string | null;
  completionCriterion: string;
  /** This session is the task's newest: the task's own records (comments, blockers) are carried here. */
  latest: boolean;
}

export interface DossierCommentRow {
  id: string;
  authorType: string;
  body: string;
  createdAt: Date;
}

export interface DossierReceiptRow {
  id: string;
  result: string;
  sourceBranch: string;
  sourceSha: string;
  targetBranch: string;
  targetShaAfter: string | null;
  recordedBy: string;
  createdAt: Date;
}

export interface DossierBlockerRow {
  id: string;
  kind: string;
  requiredAction: string;
  resolutionNote: string;
  resolvedAt: Date;
}

export interface DossierRecords {
  session: DossierSessionRow;
  turns: DossierTurnRow[];
  approvals: DossierApprovalRow[];
  events: DossierEventRow[];
  /**
   * tool_use id → tool_call id, for the tool lines to cite the row that holds the call and its result
   * together — the record a quote of either is found in (`toolCallText`).
   */
  toolCallIds: Map<string, string>;
  task: DossierTaskRow | null;
  comments: DossierCommentRow[];
  receipts: DossierReceiptRow[];
  blockers: DossierBlockerRow[];
  /** The session read the web (a WebFetch or WebSearch call): the taint mark (design §4.1 step 9). */
  tainted: boolean;
  /** Its `wiki_note`s, oldest first: none on records made by hand, as every session before the tool has none. */
  wikiNotes?: DossierWikiNote[];
}

/** Tools whose input is described by the columns above; any other tool's input is kept as JSON text. */
const DESCRIBED_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite', 'NotebookEdit', 'LS'];
/** Bookkeeping tools the timeline leaves out: they say what the agent planned, not what happened. */
const SKIPPED_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'ToolSearch']);
/** The tools that write a file: what writes a memory file, when the file is one (design §3.1). */
const MEMORY_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
/**
 * A memory file of an agent's library: stricter than `MEMORY_PATH`, which also takes a repository's `memory/x.md`.
 * The SQL half reads the same shape; the index itself is `MEMORY_INDEX`.
 */
const MEMORY_FILE = /\/projects\/[^/]+\/memory\/([^/]+\.md)$/u;
const MEMORY_FILE_SQL = '/projects/[^/]+/memory/[^/]+\\.md$';
const MEMORY_INDEX = 'MEMORY.md';

/** The numbers a dossier holds the agent's notes to (docs/wiki-memory-claims-design.md §3.1, §3.2, §6). */
export const WIKI_DOSSIER_CLAIMS = {
  /** How much of a written text is read. */
  bodyMaxChars: 4_000,
  /** Fewer new characters than this is no claim. */
  addedMinChars: 20,
  /** The most claims one dossier carries, memory writes and `wiki_note`s together, and the length of one. */
  perDossierMax: 6,
  lineMaxChars: 600,
  /** The share of the budget the owner's words may take: what is left goes to the records that bear on each note. */
  ownerShare: 0.35,
  /** Around one note: the records that name its code words, and the lines right before and after it. */
  namingLinesMax: 12,
  linesBefore: 8,
  linesAfter: 3,
  /** The most code words read from one claim, and the most results read to find them in. */
  wordsPerClaimMax: 16,
  resultsReadMax: 200,
  /** A result line that names a code word, at most, in code points. */
  resultLineMaxChars: 240,
  /** One session in this many keeps no claims, for what its memory can still measure (design §6.4). */
  heldOutEvery: 10,
} as const;

/** The terminal task statuses: a task in one of them is settled, and its closing comments count. */
const SETTLED_TASK_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

/**
 * Every character but the ones JavaScript's `trim` takes off: the SQL half of `hasText`, so that a tool result
 * is read here block for block as `toolOutputText` reads it.
 */
const TEXT_NOT_BLANK = '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';

/**
 * Read one session's records for its dossier, or null when the owner has no such session.
 *
 * Long values are cut in SQL before they cross the wire — a tool result or a thought can run to
 * megabytes, and the dossier keeps a line of each — at lengths well above anything the packer keeps.
 * What a line's position counts in is the record's whole text, so the fields a record's text is made of
 * besides its prose — an approval's note and plan, a background task's command and summary, a blocker's
 * question and answer — are read whole; they are short. A tool call's input and output are read whole only
 * for the calls the packed dossier carries (`toolRecords`).
 */
export async function loadDossierRecords(reader: DossierReader, ownerId: string, sessionId: string): Promise<DossierRecords | null> {
  const [session] = await reader.$queryRaw<DossierSessionRow[]>`
    SELECT s."id"::text AS "id", s."title", s."provider", s."engine", s."model", s."status"::text AS "status",
           s."created_at" AS "createdAt", s."task_id"::text AS "taskId",
           s."parent_session_id"::text AS "parentSessionId", s."dispatch_origin"::text AS "dispatchOrigin",
           s."wiki_chat_space_id"::text AS "wikiChatSpaceId"
      FROM "session" s
     WHERE s."id" = ${sessionId}::uuid AND s."owner_id" = ${ownerId}::uuid`;
  if (!session) return null;

  const turns = await reader.$queryRaw<DossierTurnRow[]>`
    SELECT t."id"::text AS "id", t."seq", t."kind", t."client_turn_id" AS "clientTurnId",
           t."send_intent" AS "sendIntent", left(t."content", 12000) AS "content", t."created_at" AS "createdAt"
      FROM "conversation_turn" t
     WHERE t."session_id" = ${sessionId}::uuid AND t."kind" IN ('message', 'steer', 'interrupt', 'shell')
     ORDER BY t."seq"`;

  const approvals = await reader.$queryRaw<DossierApprovalRow[]>`
    SELECT a."id"::text AS "id", a."tool_name" AS "toolName", a."status", a."message" AS "message",
           a."answers" AS "answers",
           CASE WHEN a."tool_name" = 'AskUserQuestion' THEN a."input"->'questions' END AS "questions",
           CASE WHEN a."tool_name" = 'ExitPlanMode' AND jsonb_typeof(a."input"->'plan') = 'string' THEN a."input"->>'plan' END AS "plan",
           CASE WHEN a."tool_name" NOT IN ('AskUserQuestion', 'ExitPlanMode') THEN left(a."input"::text, 400) END AS "input",
           a."created_at" AS "createdAt", a."decided_at" AS "decidedAt"
      FROM "approval" a
     WHERE a."session_id" = ${sessionId}::uuid
     ORDER BY a."created_at", a."id"`;

  const events = await reader.$queryRaw<DossierEventRow[]>`
    SELECT e."id"::text AS "id", e."seq", e."type", e."created_at" AS "createdAt",
           CASE WHEN e."type" IN ('assistant', 'thinking', 'user') THEN left(e."payload"->>'text', 20000) END AS "text",
           e."payload"->>'parentToolUseId' AS "parentToolUseId",
           CASE WHEN e."type" = 'tool_use' THEN e."payload"->>'id' END AS "toolUseId",
           CASE WHEN e."type" = 'tool_use' THEN e."payload"->>'name' END AS "toolName",
           CASE WHEN e."type" = 'tool_use' THEN left(e."payload"->'input'->>'command', 1500) END AS "command",
           CASE WHEN e."type" = 'tool_use' THEN left(coalesce(e."payload"->'input'->>'file_path', e."payload"->'input'->>'path',
                e."payload"->'input'->>'notebook_path'), 400) END AS "filePath",
           CASE WHEN e."type" = 'tool_use' THEN CASE
                WHEN e."payload"->'input'->>'file_path' IS NOT NULL THEN 'file_path'
                WHEN e."payload"->'input'->>'path' IS NOT NULL THEN 'path'
                WHEN e."payload"->'input'->>'notebook_path' IS NOT NULL THEN 'notebook_path' END END AS "filePathKey",
           CASE WHEN e."type" = 'tool_use' THEN left(e."payload"->'input'->>'pattern', 300) END AS "pattern",
           CASE WHEN e."type" = 'tool_use' THEN e."payload"->'input'->>'run_in_background' END AS "background",
           CASE WHEN e."type" = 'tool_use' AND coalesce(e."payload"->>'name', '') <> ALL (${DESCRIBED_TOOLS}::text[])
                THEN left((e."payload"->'input')::text, 2000) END AS "input",
           CASE WHEN e."type" = 'tool_use' AND e."payload"->>'name' = ANY(${MEMORY_WRITE_TOOLS}::text[])
                     AND e."payload"->'input'->>'file_path' ~ ${MEMORY_FILE_SQL}
                THEN jsonb_build_object(
                       'content', left(e."payload"->'input'->>'content', ${WIKI_DOSSIER_CLAIMS.bodyMaxChars}::int),
                       'oldString', left(e."payload"->'input'->>'old_string', ${WIKI_DOSSIER_CLAIMS.bodyMaxChars}::int),
                       'newString', left(e."payload"->'input'->>'new_string', ${WIKI_DOSSIER_CLAIMS.bodyMaxChars}::int),
                       'edits', e."payload"->'input'->'edits') END AS "memoryWrite",
           CASE WHEN e."type" = 'tool_result' THEN e."payload"->>'toolUseId' END AS "resultOf",
           CASE WHEN e."type" = 'tool_result' THEN e."payload"->>'isError' END AS "isError",
           CASE WHEN e."type" = 'tool_result' THEN left(r."content", 1200) END AS "resultHead",
           CASE WHEN e."type" = 'tool_result' AND length(r."content") > 1200 THEN right(r."content", 600) END AS "resultTail",
           CASE WHEN e."type" = 'background_task' AND jsonb_typeof(e."payload"->'command') = 'string' THEN e."payload"->>'command' END AS "bgCommand",
           CASE WHEN e."type" = 'background_task' THEN e."payload"->>'status' END AS "bgStatus",
           CASE WHEN e."type" = 'background_task' THEN e."payload"->>'exitCode' END AS "bgExit",
           CASE WHEN e."type" = 'background_task' AND jsonb_typeof(e."payload"->'summary') = 'string' THEN e."payload"->>'summary' END AS "bgSummary",
           CASE WHEN e."type" = 'error' THEN left(e."payload"->>'message', 1500) END AS "errorMessage",
           CASE WHEN e."type" = 'turn_end' THEN e."payload"->>'subtype' END AS "subtype"
      FROM "run_event" e
      -- A result's content as toolOutputText reads it: a string, or the text of its blocks — a list, or a
      -- result's own content list — blank ones left out; anything else as its JSON.
      LEFT JOIN LATERAL (
        SELECT CASE WHEN e."type" = 'tool_result' THEN
                 CASE WHEN jsonb_typeof(e."payload"->'content') = 'array' OR jsonb_typeof(e."payload"->'content'->'content') = 'array'
                      THEN (SELECT string_agg(b."x"->>'text', E'\n' ORDER BY b."n")
                              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e."payload"->'content') = 'array'
                                                             THEN e."payload"->'content' ELSE e."payload"->'content'->'content' END)
                                   WITH ORDINALITY AS b("x", "n")
                             WHERE jsonb_typeof(b."x"->'text') = 'string' AND (b."x"->>'text') ~ ${TEXT_NOT_BLANK})
                      ELSE e."payload"->>'content' END
               END AS "content"
      ) r ON true
     WHERE e."session_id" = ${sessionId}::uuid
       AND e."type" IN ('assistant', 'thinking', 'tool_use', 'tool_result', 'user', 'background_task', 'error', 'turn_end')
     ORDER BY e."seq"`;

  const calls = await reader.$queryRaw<Array<{ id: string; toolUseId: string; name: string }>>`
    SELECT c."id"::text AS "id", c."tool_use_id" AS "toolUseId", c."name"
      FROM "tool_call" c
     WHERE c."session_id" = ${sessionId}::uuid
     ORDER BY c."id"`;
  const toolCallIds = new Map<string, string>();
  let tainted = false;
  for (const call of calls) {
    if (call.toolUseId && !toolCallIds.has(call.toolUseId)) toolCallIds.set(call.toolUseId, call.id);
    if (call.name === 'WebFetch' || call.name === 'WebSearch' || call.name === 'webSearch') tainted = true;
  }

  let task: DossierTaskRow | null = null;
  let comments: DossierCommentRow[] = [];
  if (session.taskId) {
    const [row] = await reader.$queryRaw<Array<Omit<DossierTaskRow, 'latest'> & { latestSessionId: string | null }>>`
      SELECT t."id"::text AS "id", t."title", t."status"::text AS "status", left(t."acceptance_criteria", 4000) AS "acceptanceCriteria",
             t."completion_criterion"::text AS "completionCriterion",
             (SELECT s2."id"::text FROM "session" s2
               WHERE s2."task_id" = t."id" AND s2."deleted_at" IS NULL
               ORDER BY s2."created_at" DESC, s2."id" DESC LIMIT 1) AS "latestSessionId"
        FROM "task" t
       WHERE t."id" = ${session.taskId}::uuid AND t."owner_id" = ${ownerId}::uuid`;
    if (row) {
      task = {
        id: row.id,
        title: row.title,
        status: row.status,
        acceptanceCriteria: row.acceptanceCriteria,
        completionCriterion: row.completionCriterion,
        latest: row.latestSessionId === session.id,
      };
      if (task.latest && SETTLED_TASK_STATUSES.has(task.status)) {
        // The newest agent comments and every owner comment of a settled task (§8.2: its agent
        // comments' tail). The owner's are their own words about the work, and rare.
        comments = await reader.$queryRaw<DossierCommentRow[]>`
          SELECT c."id"::text AS "id", c."author_type"::text AS "authorType", left(c."body", 24000) AS "body", c."created_at" AS "createdAt"
            FROM (
              (SELECT * FROM "task_comment" WHERE "task_id" = ${task.id}::uuid AND "author_type" = 'AGENT'
                ORDER BY "created_at" DESC, "id" DESC LIMIT ${WIKI_MAINTENANCE_RULES.commentTail}::int)
              UNION ALL
              (SELECT * FROM "task_comment" WHERE "task_id" = ${task.id}::uuid AND "author_type" = 'USER'
                ORDER BY "created_at" DESC, "id" DESC LIMIT 10)
            ) c
           ORDER BY c."created_at", c."id"`;
      }
    }
  }

  const receipts = await reader.$queryRaw<DossierReceiptRow[]>`
    SELECT r."id"::text AS "id", r."result", r."source_branch" AS "sourceBranch", r."source_sha" AS "sourceSha",
           r."target_branch" AS "targetBranch", r."target_sha_after" AS "targetShaAfter", r."recorded_by" AS "recordedBy",
           r."created_at" AS "createdAt"
      FROM "session_merge_receipt" r
     WHERE r."session_id" = ${sessionId}::uuid AND r."owner_id" = ${ownerId}::uuid
     ORDER BY r."created_at", r."id"`;

  // A blocker the owner resolved with a note, about this session — or about its task, carried on the
  // task's newest session so that a task's retries do not each repeat it.
  const subjects = [session.id, ...(task?.latest ? [task.id] : [])];
  const blockers = await reader.$queryRaw<DossierBlockerRow[]>`
    SELECT b."id"::text AS "id", b."kind", b."required_action" AS "requiredAction",
           b."resolution_note" AS "resolutionNote", b."resolved_at" AS "resolvedAt"
      FROM "project_blocker" b
      JOIN "project" p ON p."id" = b."project_id"
     WHERE p."owner_id" = ${ownerId}::uuid AND b."subject_id" = ANY(${subjects}::text[])
       AND b."resolved_by" = 'USER' AND b."resolved_at" IS NOT NULL
       AND b."resolution_note" IS NOT NULL AND btrim(b."resolution_note") <> ''
     ORDER BY b."resolved_at", b."id"`;

  const wikiNotes = await reader.$queryRaw<DossierWikiNote[]>`
    SELECT n."id"::text AS "id", n."text", n."created_at" AS "createdAt"
      FROM "wiki_note" n
     WHERE n."session_id" = ${sessionId}::uuid AND n."owner_id" = ${ownerId}::uuid
     ORDER BY n."created_at", n."id"`;

  return { session, turns, approvals, events, toolCallIds, task, comments, receipts, blockers, tainted, wikiNotes };
}

/** The owner's own workspace.env values: redacted literally wherever they appear (design §10.2). */
export async function ownerEnvLiterals(reader: DossierReader, ownerId: string): Promise<string[]> {
  const rows = await reader.$queryRaw<Array<{ env: unknown }>>`
    SELECT w."env" AS "env" FROM "workspace" w WHERE w."owner_id" = ${ownerId}::uuid ORDER BY w."id"`;
  const literals: string[] = [];
  for (const { env } of rows) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) continue;
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') literals.push(value);
    }
  }
  return literals;
}

// ── The text of the records other code cites ────────────────────────────────────────────────────

/**
 * A merge receipt as one line: what the dossier shows and what a `merge_receipt` source resolves to
 * (`WikiService.sourceText`), one function so that a quote taken from the one is found in the other.
 */
export function mergeReceiptText(receipt: Pick<DossierReceiptRow, 'result' | 'sourceBranch' | 'sourceSha' | 'targetBranch' | 'targetShaAfter'>): string {
  const after = receipt.targetShaAfter ? `@${receipt.targetShaAfter}` : '';
  return `${receipt.result} ${receipt.sourceBranch}@${receipt.sourceSha} → ${receipt.targetBranch}${after}`;
}

/** A blocker the owner resolved, as an `owner_decision` source resolves to: what it asked, and the note. */
export function ownerResolutionText(blocker: Pick<DossierBlockerRow, 'requiredAction' | 'resolutionNote'>): string {
  return partsText(ownerResolutionParts(blocker))!;
}

/** The parts of an owner decision's text, a line each. */
function ownerResolutionParts(blocker: Pick<DossierBlockerRow, 'requiredAction' | 'resolutionNote'>): RecordPart[] {
  return [{ key: 'requiredAction', text: blocker.requiredAction }, { key: 'resolutionNote', text: blocker.resolutionNote }];
}


// ── Words, and where in their record each came from ─────────────────────────────────────────────

/**
 * Text, and for each of its UTF-16 units where it was copied from: an offset into the evidence of the line
 * it belongs to, or -1 for the dossier's own words — a speaker's label, a marker, what says a cut was made.
 */
interface Mapped {
  text: string;
  origin: number[];
}

/** The dossier's own words: copied from nowhere. */
function own(text: string): Mapped {
  return { text, origin: new Array<number>(text.length).fill(-1) };
}

function cat(...parts: Mapped[]): Mapped {
  return { text: parts.map((part) => part.text).join(''), origin: parts.flatMap((part) => part.origin) };
}

function sub(words: Mapped, start: number, end = words.text.length): Mapped {
  return { text: words.text.slice(start, end), origin: words.origin.slice(start, end) };
}

/** `parts` with `separator`, the dossier's own, between each two. */
function joined(parts: readonly Mapped[], separator: string): Mapped {
  return cat(...parts.flatMap((part, index) => (index === 0 ? [part] : [own(separator), part])));
}

/**
 * The fields of a record a line's words were copied from, each redacted, one after another; and for each,
 * which part of the record's text it is (`RecordPart.key`) and where in that part's redacted text it starts
 * — past a label such as `command: `, or at the part's end for the tail of a long result.
 */
interface Evidence {
  text: string;
  fields: Array<{ part: string; from: number; to: number; offset: number | 'end' }>;
}

/** A record's text, redacted, and where each of its parts is in it: null when a redaction ran across two. */
interface Layout {
  text: string;
  regions: Map<string, { start: number; end: number }> | null;
}

/**
 * A record's text from its parts (`wiki-verify-evidence.ts`), redacted whole as a quote of it is read. Each
 * part redacted on its own lands where it is in the whole unless a secret ran across the line between two
 * parts, which is the one case its parts' places are not known.
 */
function layoutOf(parts: readonly RecordPart[], redact: (text: string) => string): Layout {
  const text = redact(partsText(parts) ?? '');
  const each = parts.length === 1 ? [text] : parts.map((part) => redact(part.text));
  if (each.join('\n') !== text) return { text, regions: null };
  const regions = new Map<string, { start: number; end: number }>();
  let at = 0;
  parts.forEach((part, index) => {
    regions.set(part.key, { start: at, end: at + each[index]!.length });
    at += each[index]!.length + 1;
  });
  return { text, regions };
}

/**
 * A record whose text is at hand: laid out, and its own text the evidence of the lines made from it. `part`
 * is one part's words as they sit in it, or null when that part is empty or its place is not known.
 */
interface Held {
  layout: Layout;
  evidence: Evidence;
  part: (key: string) => Mapped | null;
}

function held(parts: readonly RecordPart[], redact: (text: string) => string): Held {
  const layout = layoutOf(parts, redact);
  const whole: Mapped = { text: layout.text, origin: Array.from({ length: layout.text.length }, (_, index) => index) };
  const fields = layout.regions
    ? [...layout.regions].map(([part, region]) => ({ part, from: region.start, to: region.end, offset: 0 as const }))
    : [{ part: '', from: 0, to: layout.text.length, offset: 0 as const }];
  return {
    layout,
    evidence: { text: layout.text, fields },
    part: (key) => {
      const region = layout.regions?.get(key);
      return region && region.end > region.start ? sub(whole, region.start, region.end) : null;
    },
  };
}

/** A record that is a single text: a turn's content, an event's words, a comment's body. */
function heldText(key: string, text: string, redact: (text: string) => string): { held: Held; words: Mapped } {
  const record = held([{ key, text }], redact);
  return { held: record, words: record.part(key) ?? own(record.layout.text) };
}

/** Collects the fields a tool line's words are copied from, before the record they are in is read whole. */
class EvidenceBuilder {
  private text = '';
  private readonly fields: Evidence['fields'] = [];

  /** `value`, already redacted, as a field of `part` starting at `offset` in it: its words, each mapped. */
  add(part: string, value: string, offset: number | 'end' = 0): Mapped {
    const from = this.text.length;
    this.text += value;
    this.fields.push({ part, from, to: this.text.length, offset });
    return { text: value, origin: Array.from({ length: value.length }, (_, index) => from + index) };
  }

  done(): Evidence {
    return { text: this.text, fields: [...this.fields] };
  }
}

// ── The timeline (prepare.py) ───────────────────────────────────────────────────────────────────

type Speaker =
  | 'owner' | 'user' | 'sender' | 'parent' | 'system' | 'taskprompt'
  | 'agent' | 'sub-agent' | 'think' | 'tool' | 'comment' | 'comment-owner' | 'merge' | 'blocker' | 'claim';

type ToolKind = 'read' | 'edit' | 'bash' | 'tool';

interface Line extends Mapped {
  sp: Speaker;
  source: { kind: WikiSourceKind; id: string };
  /** The fields of the line's record its words were copied from (`origin` counts in them). */
  evidence: Evidence;
  /** Where those fields are in the record's text; null for a tool call, which is read whole once it is chosen. */
  layout: Layout | null;
  /** The words a line stands for when it shows none of them: a task's repeated opening prompt. */
  refers?: Mapped;
  /** The record's time, as milliseconds: lines are ordered by it, then by `order`, then as built. */
  at: number;
  order: number;
  decision?: boolean;
  /** Thinking: only its signal sentences are kept. A comment: only its digest. */
  rawThinking?: boolean;
  rawComment?: boolean;
  tool?: { kind: ToolKind; err: boolean; target: string; targetWords: Mapped; head: string; named?: boolean };
  /** A note the agent wrote (`DossierOptions.claims`): what the line says is the note, and nothing cites it. */
  claim?: Claim;
  fold?: string[];
  score: number;
  sig: string[];
  fixTo?: number;
  ref?: string;
}

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
/**
 * A tool call that reads or writes an agent's memory library: left out with its result. The memory is
 * a second-hand digest of these very sessions, and what it says must not come back as a new source.
 */
const MEMORY_PATH = /\.claude\/projects\/[^\s'"]*memory|MEMORY\.md|\/memory\/[\w.-]+\.md|\bmemory\/[\w.-]+\.md/;
/** A sentence that points at the memory library: cut from the text around it. */
const MEMORY_MENTION = /\.claude\/projects\/|MEMORY\.md|\/memory\/[\w.-]+\.md|\bmemory\/[\w.-]+\.md|记忆(?:文件|库|索引|条目|里|中|：|:)|\[\[[\w-]+\]\]/;
/**
 * The step list every task's opening prompt ends with: the same for every task, and says nothing of it.
 * Under the heading the brief has had since it became English (task-execution-prompt.ts), or the Chinese
 * one older transcripts hold. The last such heading, since the list ends the brief: a description that
 * says "Follow these steps:" itself keeps what follows it.
 */
const TASK_BOILERPLATE =
  /\n*(?:Follow these steps:|请按以下步骤进行：)(?![\s\S]*(?:Follow these steps:|请按以下步骤进行：))[\s\S]*$/;
const READLIKE_BASH = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:cat|sed -n|head|tail|ls|grep|rg|find|wc|nl|awk|less|file|stat|tree|git (?:log|show|diff|status|grep|ls-files|blame|rev-parse|branch)|jq|echo)\b/;
const MEMORY_SENTENCE_SPLIT = /(?<=[。！？!?\n])|(?<=\.\s)/;

/** The UTF-16 length of the first `max` code points of `text` — all of it, when it has no more. */
function pointsEnd(text: string, max: number): number {
  let units = 0;
  for (let points = 0; units < text.length && points < max; points += 1) {
    units += text.codePointAt(units)! > 0xffff ? 2 : 1;
  }
  return units;
}

/** `text` cut to `max` characters (code points, never half of one), with how much was left out. */
function clip(text: string | null | undefined, max: number): string {
  return clipped(own(text ?? ''), max).text;
}

function clipped(words: Mapped, max: number): Mapped {
  const value = words.text;
  if (value.length <= max) return words;
  const points = Array.from(value).length;
  if (points <= max) return words;
  return cat(headed(words, max), own(`…[+${points - max} chars]`));
}

/** The first `max` code points of `text`. */
function head(text: string, max: number): string {
  return headed(own(text), max).text;
}

function headed(words: Mapped, max: number): Mapped {
  return words.text.length <= max ? words : sub(words, 0, pointsEnd(words.text, max));
}

/** Words without the whitespace around them, as `trim` takes it off. */
function trimmed(words: Mapped): Mapped {
  const start = words.text.length - words.text.trimStart().length;
  const end = words.text.trimEnd().length;
  return start >= end ? own('') : sub(words, start, end);
}

function firstLine(text: string | null | undefined, max = 200): string {
  return firstLineOf(own(text ?? ''), max).text;
}

function firstLineOf(words: Mapped, max = 200): Mapped {
  const all = trimmed(words);
  const end = all.text.indexOf('\n');
  const line = end < 0 ? all : sub(all, 0, end);
  const cut = headed(line, max);
  return cut.text === line.text ? line : cat(cut, own('…'));
}

function lastLineOf(words: Mapped, max = 160): Mapped {
  const value = sub(words, 0, words.text.trimEnd().length);
  if (!value.text) return own('');
  const line = trimmed(sub(value, value.text.lastIndexOf('\n') + 1));
  const cut = headed(line, max);
  return cut.text === line.text ? line : cat(cut, own('…'));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The sentences of `text` that do not point at the memory library. */
function withoutMemory(text: string): string {
  return withoutMemoryOf(own(text)).text;
}

function withoutMemoryOf(words: Mapped): Mapped {
  if (!words.text || !MEMORY_MENTION.test(words.text)) return words;
  // The split is at points between sentences and takes nothing out, so its parts lie end to end.
  const kept: Mapped[] = [];
  let at = 0;
  for (const part of words.text.split(MEMORY_SENTENCE_SPLIT)) {
    if (part && !MEMORY_MENTION.test(part)) kept.push(sub(words, at, at + part.length));
    at += part.length;
  }
  return cat(...kept);
}

/**
 * A shell command's program and subcommand, with `cd`, variable assignments and wrappers taken off:
 * what tells "the same kind of command" apart from another (a failure and the success that fixed it).
 */
export function commandHead(command: string | null | undefined): string {
  let c = (command ?? '').trim().split('\n', 1)[0] ?? '';
  c = c.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  c = c.replace(/^(?:(?:env\s+(?:-\S+\s+)*)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)+)/, '');
  c = c.replace(/^(?:timeout\s+\S+\s+|sudo\s+|time\s+|nice\s+|nohup\s+)+/, '');
  const tokens = (c.match(/[^\s|;&]+/g) ?? []).slice(0, 3);
  if (tokens.length === 0) return '';
  const parts = [basename(tokens[0]!)];
  const multi = ['git', 'npm', 'npx', 'go', 'docker', 'bash', 'sh', 'node', 'python3', 'python', 'swift', 'xcodebuild', 'gh',
    'orbit', 'systemctl', 'make', 'cargo', 'psql', 'prisma', 'vitest', 'tsc', 'curl'];
  if (tokens.length > 1 && multi.includes(parts[0]!)) {
    let second = tokens[1]!;
    if (['bash', 'sh', 'node', 'python3', 'python'].includes(parts[0]!)) second = second.replace(/.*\//, '');
    parts.push(second);
    if (['docker', 'npm', 'gh'].includes(parts[0]!) && tokens.length > 2 && !tokens[2]!.startsWith('-')) {
      parts.push(tokens[2]!.replace(/.*\//, ''));
    }
  }
  return parts.join(' ').slice(0, 80);
}

/**
 * Who a conversation turn is from, as the dossier labels it. The label is a reading aid and grants
 * nothing: whether a turn is the owner's own words for a review mode is `isOwnerTurn`'s to say, when a
 * proposal cites it.
 */
function speakerOf(turn: DossierTurnRow, session: DossierSessionRow): Speaker {
  const key = turn.clientTurnId ?? '';
  const isTask = session.taskId !== null;
  if (turn.kind === 'interrupt') return UUID_UPPER.test(key) || !session.parentSessionId ? 'owner' : 'sender';
  if (turn.kind === 'shell') return key.startsWith('system:') ? 'system' : 'owner';
  if (key.startsWith('initial-')) {
    if (isTask) return 'taskprompt';
    if (session.parentSessionId) return 'parent';
    if (session.dispatchOrigin === 'PROJECT_COORDINATOR') return 'system';
    return 'owner';
  }
  if (isOrbitAuthoredTurn(key)) return 'system';
  if (UUID_UPPER.test(key) || key.startsWith('owner-') || turn.sendIntent !== null) return 'owner';
  if (session.parentSessionId) return 'parent';
  if (isTask) return 'sender';
  return UUID_LOWER.test(key) ? 'user' : 'sender';
}

/**
 * `needle`'s words where they stand in `haystack`, from `from` on — an answer's question is the key of the
 * answers the approval holds — or `needle` as the dossier's own when they do not stand there.
 */
function foundIn(haystack: Mapped | null, needle: string, from = 0): Mapped {
  const at = haystack && needle ? haystack.text.indexOf(needle, from) : -1;
  return at < 0 ? own(needle) : sub(haystack!, at, at + needle.length);
}

/** An AskUserQuestion's questions and the answers given, as one line. */
function askedAndAnswered(approval: DossierApprovalRow, record: Held, redact: (text: string) => string): Mapped {
  const questions = Array.isArray(approval.questions) ? (approval.questions as Array<Record<string, unknown>>) : [];
  const answers = approval.answers !== null && typeof approval.answers === 'object' && !Array.isArray(approval.answers)
    ? (approval.answers as Record<string, unknown>)
    : {};
  const given = record.part('answers');
  const parts = questions.map((question) => {
    const text = typeof question.question === 'string' ? question.question : '';
    const options = (Array.isArray(question.options) ? question.options : [])
      .map((option) => (option !== null && typeof option === 'object' ? (option as { label?: unknown }).label : null))
      .filter((label): label is string => typeof label === 'string' && label !== '')
      .slice(0, 6)
      .map((label) => clip(redact(label), 80));
    const chosen = answers[text];
    const asked = foundIn(given, redact(text));
    const after = asked.origin[0] !== undefined && asked.origin[0] >= 0 && given ? asked.origin[asked.origin.length - 1]! + 1 - given.origin[0]! : 0;
    const answer = chosen === undefined || chosen === null ? own('(none)') : foundIn(given, redact(JSON.stringify(chosen)), after);
    return cat(own('Q: '), clipped(asked, 400), own(` [options: ${options.join(' | ')}] → A: `), answer);
  });
  let line = cat(own(`AskUserQuestion ${approval.status}. `), joined(parts, ' ; '));
  if (approval.message) line = cat(line, own(' · owner note: '), clipped(record.part('message') ?? own(redact(approval.message)), 1500));
  return line;
}

/**
 * The session as a timeline of one-line events, every text already redacted (prepare.py
 * `build_timeline`, for one session), with the notes `claims` chose at their moments.
 */
function timeline(records: DossierRecords, redact: (text: string) => string, claims: ClaimsRead | null = null): Line[] {
  const { session } = records;
  const lines: Line[] = [];
  const add = (
    at: Date | null,
    order: number,
    sp: Speaker,
    words: Mapped,
    source: Line['source'],
    record: { evidence: Evidence; layout: Layout | null },
    extra: Partial<Line> = {},
  ) => {
    lines.push({
      sp, text: words.text, origin: words.origin, source, evidence: record.evidence, layout: record.layout,
      at: at ? at.getTime() : 0, order, score: 0, sig: [], ...extra,
    });
  };

  // The conversation turns.
  const hasMessages = records.turns.some((turn) => turn.kind === 'message');
  let openingSeen = false;
  for (const turn of records.turns) {
    const sp = speakerOf(turn, session);
    const key = turn.clientTurnId ?? '';
    const { held: record, words: content } = heldText('content', turn.content ?? '', redact);
    if (key.startsWith('bg-wake') && content.text.trim() === '') continue;
    const source = { kind: 'turn' as const, id: turn.id };
    if (turn.kind === 'interrupt') {
      add(turn.createdAt, 1, sp, content.text.trim()
        ? cat(own('⏹ interrupted the agent: '), clipped(content, 2000))
        : own('⏹ interrupted the agent'), source, record);
      continue;
    }
    if (turn.kind === 'shell') {
      add(turn.createdAt, 1, sp, cat(own('! '), clipped(content, 600)), source, record);
      continue;
    }
    let text: Mapped;
    if (sp === 'taskprompt') {
      const boilerplate = TASK_BOILERPLATE.exec(content.text);
      const prompt = clipped(withoutMemoryOf(boilerplate ? sub(content, 0, boilerplate.index) : content), 9000);
      // A retry opens with the same prompt as before; the demo said so rather than repeating it.
      if (openingSeen) {
        add(turn.createdAt, 1, sp, own('(the same opening prompt again)'), source, record, { refers: prompt });
        continue;
      }
      openingSeen = true;
      text = prompt;
    } else if (sp === 'owner' || sp === 'user') {
      text = clipped(content, 6000);
    } else if (sp === 'system') {
      text = clipped(content, /^(?:watch:|open-item|pc:|project-started|task-run)/.test(key) ? 700 : 1200);
    } else {
      text = clipped(withoutMemoryOf(content), 3000);
    }
    add(turn.createdAt, 1, sp, turn.kind === 'steer' ? cat(own('(steer) '), text) : text, source, record);
  }

  // The approvals: the owner's answers to what the agent asked.
  for (const approval of records.approvals) {
    const source = { kind: 'approval' as const, id: approval.id };
    const record = held(approvalParts({
      toolName: approval.toolName,
      input: approval.plan === null ? {} : { plan: approval.plan },
      answers: approval.answers,
      message: approval.message,
    }), redact);
    const note = (max: number) => clipped(record.part('message') ?? own(redact(approval.message ?? '')), max);
    if (approval.toolName === 'AskUserQuestion') {
      if (approval.status === 'PENDING' || approval.status === 'ABANDONED') continue;
      add(approval.createdAt, 2, 'owner', askedAndAnswered(approval, record, redact), source, record, { decision: true });
    } else if (approval.toolName === 'ExitPlanMode') {
      add(approval.createdAt, 2, 'agent', cat(own('PLAN: '), clipped(record.part('plan') ?? own(redact(approval.plan ?? '')), 2500)), source, record);
      if (approval.status !== 'PENDING' && approval.status !== 'ABANDONED') {
        const decided = own(`plan ${approval.status.toLowerCase()}`);
        add(approval.decidedAt ?? approval.createdAt, 3, 'owner', approval.message ? cat(decided, own(': '), note(1500)) : decided,
          source, record, { decision: true });
      }
    } else if (approval.status === 'DENIED' && approval.message) {
      // A denial that says why is the owner teaching; a bare click is not (§8.2: DENIED with a reason).
      add(approval.decidedAt ?? approval.createdAt, 3, 'owner',
        cat(own(`${approval.toolName} denied ${clip(redact(approval.input ?? ''), 200)} · note: `), note(1000)),
        source, record, { decision: true });
    }
  }

  // The agent's own trace.
  const chat = Boolean(records.session.wikiChatSpaceId);
  const results = new Map<string, DossierEventRow>();
  for (const event of records.events) {
    if (event.type === 'tool_result' && event.resultOf) results.set(event.resultOf, event);
  }
  for (const event of records.events) {
    const source = { kind: 'event' as const, id: event.id };
    const nested = Boolean(event.parentToolUseId);
    switch (event.type) {
      case 'assistant': {
        const { held: record, words } = heldText('text', event.text ?? '', redact);
        const text = withoutMemoryOf(words);
        if (text.text.trim()) add(event.createdAt, 4, nested ? 'sub-agent' : 'agent', clipped(text, 5000), source, record);
        break;
      }
      case 'thinking': {
        const { held: record, words } = heldText('text', event.text ?? '', redact);
        const text = withoutMemoryOf(words);
        if (text.text.trim()) add(event.createdAt, 4, 'think', text, source, record, { rawThinking: true });
        break;
      }
      case 'user': {
        // A session from before conversation turns were stored: its user events are its messages.
        const { held: record, words } = heldText('text', event.text ?? '', redact);
        if (!hasMessages && words.text.trim()) add(event.createdAt, 1, 'user', clipped(words, 6000), source, record);
        break;
      }
      case 'tool_use': {
        const claim = claims?.chosen.get(event.id);
        if (claim) {
          add(event.createdAt, 5, 'claim', own(claim.text), source, CLAIM_RECORD, { claim });
          break;
        }
        // The evidence for a note is before it: a later result keeps the line it always had.
        // A wiki chat's drafting call, left out with its result (contract `chat.dossier`): every op a chat
        // proposes and every `wiki_draft` is a card the owner may discard, and a discarded one must not come
        // back through this run. The owner's words in the chat stay: they are turns, above.
        if (chat && wikiCallDraftsInChat(event.toolName, event.command)) break;
        const named = claims && event.createdAt.getTime() <= claims.lastAt ? claims.resultLines.get(event.toolUseId ?? '') : undefined;
        const line = toolLine(event, results.get(event.toolUseId ?? ''), redact, named);
        if (!line) break;
        const callId = event.toolUseId ? records.toolCallIds.get(event.toolUseId) : undefined;
        add(event.createdAt, 5, 'tool', line.words, callId ? { kind: 'tool_call', id: callId } : source,
          { evidence: line.evidence, layout: null }, { tool: line.tool });
        break;
      }
      case 'background_task': {
        const finished = event.bgStatus === 'completed' || event.bgStatus === 'failed' || event.bgStatus === 'killed'
          || (event.bgExit !== null && event.bgExit !== '');
        if (!finished) break;
        const command = redact(event.bgCommand ?? '');
        if (MEMORY_PATH.test(command) || wikiCallReadsWiki(null, command) || wikiCallWritesNote(null, command)) break;
        if (chat && wikiCallDraftsInChat(null, command)) break;
        const record = held(runEventParts('background_task', { command: event.bgCommand, summary: event.bgSummary }), redact);
        const ok = ['0', 'None', ''].includes(String(event.bgExit ?? '')) && event.bgStatus !== 'failed';
        const exit = event.bgExit === null || event.bgExit === '' ? '' : ` exit=${event.bgExit}`;
        const summary = event.bgSummary
          ? cat(own(' — '), clipped(record.part('summary') ?? own(redact(event.bgSummary)), 300))
          : own('');
        add(event.createdAt, 5, 'tool', cat(own(`bg ${event.bgStatus ?? ''}${exit}: `), firstLineOf(record.part('command') ?? own(command), 160), summary),
          source, record, {
            tool: { kind: 'bash', err: !ok, target: firstLine(command, 80), targetWords: own(firstLine(command, 80)), head: commandHead(command) },
          });
        break;
      }
      case 'error': {
        const { held: record, words } = heldText('message', event.errorMessage ?? '', redact);
        add(event.createdAt, 5, 'system', cat(own('ERROR: '), clipped(words, 500)), source, record);
        break;
      }
      case 'turn_end':
        if (event.subtype && event.subtype !== 'success') {
          const record = held(runEventParts('turn_end', { subtype: event.subtype }), redact);
          add(event.createdAt, 6, 'system', cat(own('turn ended: '), record.part('subtype') ?? own(redact(event.subtype))), source, record);
        }
        break;
      default:
        break;
    }
  }

  // The session's `wiki_note`s, each a note at the moment it was written, as a write to a memory file is.
  for (const note of records.wikiNotes ?? []) {
    const claim = claims?.chosen.get(note.id);
    if (claim) {
      add(note.createdAt, 5, 'claim', own(claim.text), { kind: 'note', id: note.id }, CLAIM_RECORD, { claim });
    }
  }

  // The task's closing records, and the session's receipts and the owner's resolutions.
  for (const comment of records.comments) {
    const { held: record, words } = heldText('body', comment.body, redact);
    const body = withoutMemoryOf(words);
    if (!body.text.trim()) continue;
    add(comment.createdAt, 7, comment.authorType === 'USER' ? 'comment-owner' : 'comment', body,
      { kind: 'task_comment', id: comment.id }, record, { rawComment: true });
  }
  for (const receipt of records.receipts) {
    const record = held([{ key: 'receipt', text: mergeReceiptText(receipt) }], redact);
    add(receipt.createdAt, 7, 'merge',
      cat(record.part('receipt') ?? own(redact(mergeReceiptText(receipt))), own(` (recorded by ${redact(receipt.recordedBy)})`)),
      { kind: 'merge_receipt', id: receipt.id }, record);
  }
  for (const blocker of records.blockers) {
    const record = held(ownerResolutionParts(blocker), redact);
    add(blocker.resolvedAt, 7, 'blocker',
      cat(own(`${blocker.kind}: `), clipped(record.part('requiredAction') ?? own(redact(blocker.requiredAction)), 400),
        own(' → the owner resolved it: '), clipped(record.part('resolutionNote') ?? own(redact(blocker.resolutionNote)), 1500)),
      { kind: 'owner_decision', id: blocker.id }, record, { decision: true });
  }

  // The notes a backfill named, each after everything of the moment it stands at.
  for (const { id, at, claim } of claims?.imported ?? []) add(at, 8, 'claim', own(claim.text), { kind: 'note', id }, CLAIM_RECORD, { claim });

  // Oldest first; a stable sort, so records of one moment keep the order they were built in.
  lines.sort((a, b) => a.at - b.at || a.order - b.order);

  // A run of reads (or of edits) is one line.
  const folded: Line[] = [];
  for (const line of lines) {
    const previous = folded[folded.length - 1];
    if (previous && line.sp === 'tool' && previous.sp === 'tool' && line.tool && previous.tool
      && !line.tool.err && !previous.tool.err && (line.tool.kind === 'read' || line.tool.kind === 'edit')
      && previous.tool.kind === line.tool.kind && !line.tool.named && !previous.tool.named) {
      (previous.fold ??= [previous.tool.target]).push(line.tool.target);
      continue;
    }
    folded.push(line);
  }
  for (const line of folded) {
    if (!line.fold || !line.tool) continue;
    // Only the first target is the line's own record's; the others are the records folded into it.
    const targets = [...new Set(line.fold)];
    const words = cat(
      own(`${line.tool.kind} ×${line.fold.length}: `),
      joined([headed(line.tool.targetWords, 90), ...targets.slice(1, 6).map((target) => own(head(target, 90)))], ', '),
      own(targets.length > 6 ? ' …' : ''),
    );
    line.text = words.text;
    line.origin = words.origin;
  }
  // A note is numbered on its own: the lines a proposal may cite are numbered as if it were not there.
  let said = 0;
  let noted = 0;
  for (const line of folded) line.ref = line.sp === 'claim' ? `C${noted += 1}` : `L${said += 1}`;
  return folded;
}

/**
 * One tool call and its result as a line, or null for a call the dossier leaves out. Its words are copied
 * from the call's fields as the timeline read them — the command, the path, the result's first and last
 * line — and placed in the call's text once the call is read whole (`toolRecords`). `named` is a line from the
 * result's middle that names what a note claims (`claimResultLines`): the line shows it too, after the first.
 */
function toolLine(
  use: DossierEventRow,
  result: DossierEventRow | undefined,
  redact: (text: string) => string,
  named?: string,
): { words: Mapped; evidence: Evidence; tool: NonNullable<Line['tool']> } | null {
  const name = use.toolName ?? '?';
  const command = redact(use.command ?? '');
  const filePath = redact(use.filePath ?? '');
  const pattern = redact(use.pattern ?? '');
  const input = redact(use.input ?? '');
  if (MEMORY_PATH.test([command, filePath, pattern, input].join(' '))) return null;
  if (SKIPPED_TOOLS.has(name)) return null;
  // A read of the wiki, left out with its result: what the wiki said must not come back as a source of what it says.
  if (wikiCallReadsWiki(name, command)) return null;
  // A note being filed, left out for the same reason: its record says the note's own words.
  if (wikiCallWritesNote(name, command)) return null;
  const evidence = new EvidenceBuilder();
  const field = (key: string, value: string): Mapped => evidence.add(`input.${key}`, value, key.length + 2);
  let err = String(result?.isError ?? '').toLowerCase() === 'true';
  let resultHead = redact(result?.resultHead ?? '');
  let resultTail = redact(result?.resultTail ?? '');
  const exit = /^\s*Exit code (\d+)/.exec(resultHead);
  if (exit && exit[1] !== '0') err = true;
  let headWords: Mapped;
  let tailWords: Mapped;
  let namedWords = own('');
  if (MEMORY_MENTION.test(resultHead.slice(0, 300))) {
    resultHead = '(memory file content omitted)';
    resultTail = '';
    headWords = own(resultHead);
    tailWords = own('');
  } else {
    headWords = evidence.add('output', resultHead);
    tailWords = evidence.add('output', resultTail, 'end');
    if (named) namedWords = evidence.add('output', named);
  }
  const withNamed = (outcome: Mapped, between: string): Mapped =>
    (namedWords.text && !outcome.text.includes(namedWords.text) ? cat(outcome, own(between), namedWords) : outcome);
  let text: Mapped;
  let kind: ToolKind;
  let target: Mapped;
  let group: string;
  if (name === 'Bash') {
    kind = READLIKE_BASH.test(command) && !err ? 'read' : 'bash';
    const commandWords = field('command', command);
    text = cat(own('$ '), firstLineOf(commandWords, 220));
    const more = command.split('\n').length - 1;
    if (more > 0) text = cat(text, own(` …(+${more} lines)`));
    if (use.background === 'true') text = cat(text, own(' [background]'));
    target = firstLineOf(commandWords, 80);
    group = commandHead(command);
  } else if (name === 'Read' || name === 'Glob' || name === 'Grep' || name === 'LS') {
    kind = 'read';
    const path = field(use.filePathKey ?? 'file_path', filePath);
    target = pattern ? cat(path, own(' /'), field('pattern', pattern), own('/')) : path;
    text = cat(own(`${name.toLowerCase()} `), target);
    group = name;
  } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    kind = 'edit';
    target = field(use.filePathKey ?? 'file_path', filePath);
    text = cat(own(`${name.toLowerCase()} `), target);
    group = `${name} ${target.text}`;
  } else {
    kind = 'tool';
    const orbit = name.startsWith('mcp__orbit__') || name.startsWith('orbit');
    text = cat(evidence.add('name', name), own(` ${clip(withoutMemory(input), orbit ? 900 : 300)}`));
    target = own(name);
    group = name;
  }
  if (result) {
    let outcome: Mapped;
    if (err) {
      outcome = withNamed(cat(own('ERR: '), firstLineOf(headWords, 240)), ' … ');
      const last = lastLineOf(resultTail ? tailWords : headWords, 200);
      if (last.text && !outcome.text.includes(last.text)) outcome = cat(outcome, own(' … '), last);
    } else if (kind === 'bash' || kind === 'tool') {
      outcome = own('ok');
      const first = firstLineOf(headWords, 160);
      if (first.text) outcome = cat(outcome, own(': '), first);
      outcome = withNamed(outcome, first.text ? ' … ' : ': ');
      const last = resultTail ? lastLineOf(tailWords, 140) : own('');
      if (last.text && last.text !== first.text) outcome = cat(outcome, own(' … '), last);
    } else {
      outcome = withNamed(own('ok'), ': ');
    }
    text = cat(text, own(' → '), outcome);
  }
  const tool: NonNullable<Line['tool']> = { kind, err, target: target.text, targetWords: target, head: group };
  if (namedWords.text) tool.named = true;
  return { words: text, evidence: evidence.done(), tool };
}

// ── The agent's notes (docs/wiki-memory-claims-design.md §3.1, §3.2) ───────────────────────────

/** One note a dossier carries: the write, the imported note or the `wiki_note` it is, and its words, redacted and cut. */
interface Claim {
  by: WikiPromptedBy;
  feedback: boolean;
  text: string;
}

/** What a `wiki_note` is known by where a write is known by its file's name (`WikiPromptedBy`). */
const WIKI_NOTE_FILE = 'wiki_note';

/** A claim's line has no record behind it: nothing cites it, and no words of it are placed anywhere. */
const CLAIM_RECORD: { evidence: Evidence; layout: Layout | null } = { evidence: { text: '', fields: [] }, layout: null };

/** An imported note a backfill names for a session (`DossierOptions.notes`). */
export interface DossierImportedNote {
  id: string;
  /** Where the file was read from, of which its name is what a write of it is known by. */
  path: string;
  /** The file's text as `wiki_note` keeps it: redacted, its frontmatter included. */
  text: string;
}

/** Where a note no write of which is in the session's records stands: after everything, since all of it came before. */
const AFTER_EVERYTHING = new Date(8.64e15);

/** What the session's memory writes came to, before the packer has its say. */
interface ClaimsRead {
  /** The notes chosen, by the tool_use event that wrote each, or by the `wiki_note`'s own id. */
  chosen: Map<string, Claim>;
  /** The imported notes chosen, with the moment each stands at; none unless a backfill named any. */
  imported: Array<{ id: string; at: Date; claim: Claim }>;
  /** A line from the middle of a result that names a code word of a note, by the call's tool_use id. */
  resultLines: Map<string, string>;
  /** When the last chosen note was written, as milliseconds: no later record is its evidence. */
  lastAt: number;
  seen: number;
  notes: number;
  skipped: number;
  overCap: number;
  heldOut: number;
}

/** A dossier's notes, as a run reports them (`report.claims`) and a proposal traces them (`promptedBy`). */
export interface DossierClaims {
  /** The writes to memory files the session made, and of those: what said too little, and what a held-out session kept out. */
  seen: number;
  skipped: number;
  heldOut: number;
  /** The `wiki_note`s the session wrote. A session held out still has them read: that is a measure of its memory alone. */
  notes: number;
  /** What passed the cap, of either. */
  overCap: number;
  /** The notes the text carries, in order. */
  lines: Array<{ ref: string } & WikiPromptedBy>;
}

/**
 * A session held out: its dossier has no notes, so that its memory can still measure what reading the session
 * alone finds (design §6.4). A digest of its id, so the same session is always on the same side.
 */
export function wikiClaimsHeldOut(sessionId: string): boolean {
  return parseInt(sha256(sessionId).slice(0, 8), 16) % WIKI_DOSSIER_CLAIMS.heldOutEvery === 0;
}

const MEMORY_FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
const MEMORY_TYPE = /^[ \t]*type:[ \t]*["']?([\w-]+)/mu;
/** A line that is a pointer to another note: a hub's or an index's, with at most a hook after it. */
const MEMORY_LINK_LINE = /^\s*(?:[-*+]\s+|\d+\.\s+)?\[\[?[^\]\n]+\]/u;

/** What a write says: the words it added, how many of them are new, and the file's type where the write names it. */
function memoryWritten(write: DossierMemoryWrite): { type: string | null; body: string; added: number } {
  if (typeof write.content === 'string') {
    const front = MEMORY_FRONTMATTER.exec(write.content);
    const body = (front ? write.content.slice(front[0].length) : write.content).trim();
    return { type: front ? (MEMORY_TYPE.exec(front[1]!)?.[1] ?? null) : null, body, added: Array.from(body).length };
  }
  const max = WIKI_DOSSIER_CLAIMS.bodyMaxChars;
  const edits = Array.isArray(write.edits)
    ? (write.edits as Array<Record<string, unknown> | null>).map((edit) => [edit?.old_string, edit?.new_string])
    : [[write.oldString, write.newString]];
  const parts = edits.map(([before, after]) => editedWords(
    typeof before === 'string' ? before.slice(0, max) : '',
    typeof after === 'string' ? after.slice(0, max) : '',
  ));
  return {
    type: null,
    body: parts.map((part) => part.body).filter((body) => body !== '').join('\n'),
    added: parts.reduce((sum, part) => sum + part.added, 0),
  };
}

/**
 * The words a write to a memory file added, from the input its tool_use event holds, read as a dossier reads them: what
 * an op that came from that note is held to when its verdict is recorded (`wikiRepeatsNote`).
 */
export function memoryWriteWords(input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>;
  const max = WIKI_DOSSIER_CLAIMS.bodyMaxChars;
  const cut = (value: unknown): string | null => (typeof value === 'string' ? value.slice(0, max) : null);
  return memoryWritten({
    content: cut(fields.content),
    oldString: cut(fields.old_string),
    newString: cut(fields.new_string),
    edits: fields.edits ?? null,
  }).body;
}

/**
 * The part of `after` that `before` does not have: its whole lines that are new, since a changed word means
 * nothing without its line, and how many characters really changed, since a typo fixed in a long line says little.
 */
function editedWords(before: string, after: string): { body: string; added: number } {
  const most = Math.min(before.length, after.length);
  let start = 0;
  while (start < most && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < most - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  const old = new Set(before.split('\n').map((line) => line.trim()));
  const body = after.split('\n').filter((line) => line.trim() !== '' && !old.has(line.trim())).join('\n');
  return { body, added: Array.from(after.slice(start, after.length - end).trim()).length };
}

/** A hub or an index: more than half its lines are pointers to other notes. */
function mostlyLinks(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  return lines.filter((line) => MEMORY_LINK_LINE.test(line)).length * 2 > lines.length;
}

const CODE_SNIPPET = /`([^`\n]{3,120})`/gu;
/** A path, a file name, a camelCase, PascalCase, snake_case or CONSTANT name, a flag, a sha. */
const CODE_WORD = /(?<![\w/.-])[\w.@-]+(?:\/[\w.@-]+)+|(?<![\w.-])[\w-]+\.(?:ts|tsx|js|mjs|go|py|sh|sql|json|ya?ml|md|swift|kt|toml|html|css)\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[A-Z][A-Z0-9]{3,}\b|(?<![\w-])--[a-z][\w-]+|(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gu;

/** The words of a note a record can be matched by, first come first, at most `wordsPerClaimMax`. */
function codeWordsOf(text: string): string[] {
  const snippets = [...text.matchAll(CODE_SNIPPET)].map((match) => match[1]!.trim());
  const tokens = [...text.replace(CODE_SNIPPET, ' $1 ').matchAll(CODE_WORD)].map((match) => match[0].replace(/[.:,;]+$/u, ''));
  const words = [...new Set([...snippets, ...tokens])].filter((word) => word.length >= 4);
  return words.slice(0, WIKI_DOSSIER_CLAIMS.wordsPerClaimMax);
}

/** The session's writes to memory files that did not fail, oldest first, each with the file's name; the index is none. */
function memoryWrites(records: DossierRecords): Array<{ event: DossierEventRow; file: string }> {
  const failed = new Set<string>();
  for (const event of records.events) {
    if (event.type === 'tool_result' && event.resultOf && String(event.isError ?? '').toLowerCase() === 'true') failed.add(event.resultOf);
  }
  return records.events.flatMap((event) => {
    const file = event.type === 'tool_use' && event.memoryWrite ? MEMORY_FILE.exec(event.filePath ?? '')?.[1] : undefined;
    return !file || file === MEMORY_INDEX || failed.has(event.toolUseId ?? '') ? [] : [{ event, file }];
  });
}

/** What one write or note says as a claim, or null for what says too little (§3.1). */
function claimOf(by: WikiPromptedBy, type: string | null, written: ReturnType<typeof memoryWritten>, redact: (text: string) => string): Claim | null {
  if (type === 'user' || written.added < WIKI_DOSSIER_CLAIMS.addedMinChars || mostlyLinks(written.body)) return null;
  return { by, feedback: type === 'feedback', text: clip(redact(written.body).trim(), WIKI_DOSSIER_CLAIMS.lineMaxChars) };
}

/** Which of these claims a dossier carries (§3.1), the later of them later in `kept`: the feedback first, then the newest. */
function chooseClaims<T extends { claim: Claim }>(kept: readonly T[]): T[] {
  return kept
    .map((one, index) => ({ one, index }))
    .sort((a, b) => Number(b.one.claim.feedback) - Number(a.one.claim.feedback) || b.index - a.index)
    .slice(0, WIKI_DOSSIER_CLAIMS.perDossierMax)
    .map(({ one }) => one);
}

/**
 * The session's notes, read and chosen (§3.1): its writes to memory files, unless it is held out, and its `wiki_note`s, which
 * rank with the feedback: someone chose to tell the wiki this.
 */
function memoryClaims(records: DossierRecords, redact: (text: string) => string, heldOut: boolean): Omit<ClaimsRead, 'resultLines'> {
  const typeOf = new Map<string, string | null>();
  const kept: Array<{ key: string; at: number; claim: Claim }> = [];
  const writes = memoryWrites(records);
  for (const { event, file } of writes) {
    const written = memoryWritten(event.memoryWrite!);
    // An edit names no type of its own: the file's is what the session last wrote it with.
    const type = typeof event.memoryWrite!.content === 'string' ? written.type : (typeOf.get(file) ?? null);
    typeOf.set(file, type);
    const claim = claimOf({ eventId: event.id, file }, type, written, redact);
    if (claim) kept.push({ key: event.id, at: event.createdAt.getTime(), claim });
  }
  const noted = (records.wikiNotes ?? []).map((note) => ({
    key: note.id,
    at: note.createdAt.getTime(),
    claim: { by: { noteId: note.id, file: WIKI_NOTE_FILE }, feedback: true, text: clip(redact(note.text).trim(), WIKI_DOSSIER_CLAIMS.lineMaxChars) },
  }));
  // In the order they were written, which is the events' own when there is nothing to merge them with.
  const inOrder = heldOut ? noted : noted.length === 0 ? kept : [...kept, ...noted].sort((a, b) => a.at - b.at);
  const chosen = chooseClaims(inOrder);
  return {
    chosen: new Map(chosen.map(({ key, claim }) => [key, claim])),
    imported: [],
    lastAt: chosen.reduce((latest, { at }) => Math.max(latest, at), 0),
    seen: writes.length,
    notes: noted.length,
    skipped: heldOut ? 0 : writes.length - kept.length,
    overCap: inOrder.length - chosen.length,
    heldOut: heldOut ? writes.length : 0,
  };
}

/**
 * The imported notes a backfill named (design §5), read and chosen as writes are. Each is the last version of a file: it
 * stands where the session last wrote that file, which is the moment its agent said so, or after everything when no write
 * of it is in these records. The session's writes are not read beside them: the note is what became of them.
 */
function importedClaims(records: DossierRecords, notes: readonly DossierImportedNote[], redact: (text: string) => string): Omit<ClaimsRead, 'resultLines'> {
  const lastWrite = new Map(memoryWrites(records).map(({ event, file }) => [file, event.createdAt]));
  const placed = notes
    .map((note) => {
      const file = basename(note.path);
      return { note, file, at: lastWrite.get(file) ?? AFTER_EVERYTHING };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const kept = placed.flatMap(({ note, file, at }) => {
    const written = memoryWritten({ content: note.text.slice(0, WIKI_DOSSIER_CLAIMS.bodyMaxChars), oldString: null, newString: null, edits: null });
    const claim = claimOf({ noteId: note.id, file }, written.type, written, redact);
    return claim ? [{ id: note.id, at, claim }] : [];
  });
  const imported = chooseClaims(kept);
  return {
    chosen: new Map(),
    imported,
    lastAt: imported.reduce((latest, { at }) => Math.max(latest, at.getTime()), 0),
    seen: notes.length,
    notes: 0,
    skipped: notes.length - kept.length,
    overCap: kept.length - imported.length,
    heldOut: 0,
  };
}

/**
 * For the calls whose result names a code word of a note, the line of the result that names most of them, cut
 * around the word: a dossier line shows a result's first and last line and no read's at all, and what bears on a
 * note is as often in the middle. Read here from the row a line's words are placed in (`toolRecords`), and only
 * for the sessions with notes.
 */
async function claimResultLines(
  reader: DossierReader,
  sessionId: string,
  words: readonly string[],
  redact: (text: string) => string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (words.length === 0) return found;
  const rows = await reader.$queryRaw<Array<{ toolUseId: string; output: unknown }>>`
    SELECT c."tool_use_id" AS "toolUseId", c."output"
      FROM "tool_call" c
     WHERE c."session_id" = ${sessionId}::uuid AND c."name" <> ALL(${MEMORY_WRITE_TOOLS}::text[])
       AND pg_column_size(c."output") <= ${TOOL_OUTPUT_READ_MAX_BYTES}::int
       AND EXISTS (SELECT 1 FROM unnest(${[...words]}::text[]) AS w("word") WHERE position(w."word" IN c."output"::text) > 0)
     ORDER BY c."id" DESC
     LIMIT ${WIKI_DOSSIER_CLAIMS.resultsReadMax}::int`;
  for (const row of rows) {
    const text = toolOutputText(row.output);
    if (text === null || found.has(row.toolUseId)) continue;
    const line = lineNaming(text, words, redact);
    if (line !== null) found.set(row.toolUseId, line);
  }
  return found;
}

/** The line of `text` that names the most of `words`, the first of equals, redacted and cut around the first it names. */
function lineNaming(text: string, words: readonly string[], redact: (text: string) => string): string | null {
  let best: { line: string; named: number } | null = null;
  for (const raw of text.split('\n')) {
    const named = words.filter((word) => raw.includes(word)).length;
    if (named === 0 || (best && named <= best.named)) continue;
    const line = redact(raw).trim();
    if (MEMORY_MENTION.test(line) || !words.some((word) => line.includes(word))) continue;
    best = { line, named };
  }
  if (!best) return null;
  const { line } = best;
  const max = WIKI_DOSSIER_CLAIMS.resultLineMaxChars;
  if (Array.from(line).length <= max) return line;
  const hit = Math.min(...words.map((word) => line.indexOf(word)).filter((at) => at >= 0));
  const points = Array.from(line);
  const start = Math.max(0, Array.from(line.slice(0, hit)).length - Math.floor(max / 3));
  return points.slice(start, start + max).join('');
}

/**
 * For each note, the lines to carry for it, best first. The records before it that name its code words: the owner's
 * words and the tool lines that do not write a file. A word many lines name says less than a word few do, so a line
 * weighs what each word it names is worth; of equals, the nearest to the note. And by turns with those, the lines
 * right around it, nearest first, for a note that names little: what the agent had just seen is what it wrote down.
 */
function evidenceFor(lines: readonly Line[], claims: readonly number[]): number[][] {
  return claims.map((at) => {
    const words = codeWordsOf(lines[at]!.text);
    const namedBy = new Map<number, string[]>();
    const lineCount = new Map<string, number>();
    for (let i = 0; i < at; i += 1) {
      const line = lines[i]!;
      if (!OWNER_SPEAKERS.includes(line.sp) && !(line.sp === 'tool' && line.tool?.kind !== 'edit')) continue;
      const named = words.filter((word) => line.text.includes(word));
      if (named.length === 0) continue;
      namedBy.set(i, named);
      for (const word of named) lineCount.set(word, (lineCount.get(word) ?? 0) + 1);
    }
    const weight = (i: number) => namedBy.get(i)!.reduce((sum, word) => sum + 1 / lineCount.get(word)!, 0);
    const naming = [...namedBy.keys()].sort((a, b) => weight(b) - weight(a) || b - a).slice(0, WIKI_DOSSIER_CLAIMS.namingLinesMax);
    const before: number[] = [];
    for (let i = at - 1; i >= 0 && before.length < WIKI_DOSSIER_CLAIMS.linesBefore; i -= 1) if (lines[i]!.sp !== 'claim') before.push(i);
    const after: number[] = [];
    for (let i = at + 1; i < lines.length && after.length < WIKI_DOSSIER_CLAIMS.linesAfter; i += 1) if (lines[i]!.sp !== 'claim') after.push(i);
    const near = [...before, ...after];
    return Array.from({ length: Math.max(naming.length, near.length) }, (_, i) => [naming[i], near[i]])
      .flat()
      .filter((i): i is number => i !== undefined);
  });
}

// ── Signals and packing (pack.py, packer v2) ────────────────────────────────────────────────────

const OWNER_SPEAKERS: readonly Speaker[] = ['owner', 'user'];
const OWNER_RULE = /不要|别(?![的人处名称])|必须|以后|改成|改为|不对|不是这样|不应该|应该|不能|禁止|记住|一律|务必|总是|永远|每次|千万|不准|不许|不用再|统一|默认|只能|优先|\b(?:don'?t|do not|never|always|must|should|stop|from now on|instead|make sure|remember|prefer)\b/i;
const OWNER_DECIDE = /按建议|就这样|按你说的|同意|可以|行吧|好的|批准|确认|就用|选(?:第)?[一二三四1-4]|方案|\b(?:ok|okay|go ahead|approved?|lgtm|yes|sure|do it)\b/i;
const OWNER_ASK = /为什么|为啥|怎么|是什么|什么意思|如何|区别|原因|\b(?:why|how come|how does|how do|what is|what does|explain)\b|[?？]/i;
const SURPRISE_STRONG = /原来|竟然|根因|根本原因|才发现|没想到|意外|问题在于|症结|罪魁|误以为|以为.{0,30}(?:但|却|结果)|踩坑|踩到|\b(?:turns? out|turned out|root cause|the real (?:cause|reason|problem|issue)|surpris\w*|unexpected\w*|silently|gotcha|culprit|misread|i assumed|i was wrong|wrongly|not a dry.?run|the catch|trap|footgun|caveat)\b|(?:not|n't) (?:a |really a |just a )?dry.?run/i;
const SURPRISE_WEAK = /其实|实际上|并不|不是.{0,20}而是|\b(?:isn't|is not|wasn't|actually|instead of|rather than|contrary)\b/i;
const PATHLIKE = /(?<![\w/.-])(?:(?:src|scripts|docs|contracts|test|gateway|\.github)\/[\w./@-]+|docker-compose\.yml)/;
const SHALIKE = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/;
const IRREVERSIBLE = /git push|git tag|push(?:ed)? (?:the )?tag|--force|force-push|tagging v|\brm -rf|drop (?:table|database|column)|delete from|truncate |docker compose (?:up|down)|upgrade\.sh|release\.sh|systemctl (?:restart|stop)|kill -9/i;
const SENTENCE_SPLIT = /(?<=[。！？!?\n])|(?<=[.;:]\s)/;
const CONCLUSION = /结论|原因|决定|注意|坑|教训|发现|lesson|conclusion|decid|note:/i;

/** Of a thought, only the sentences that carry a signal. */
function signalSentences(words: Mapped, maxChars: number): Mapped {
  const kept: Mapped[] = [];
  let used = 0;
  // The split is at points between sentences and takes nothing out, so its parts lie end to end.
  let at = 0;
  for (const sentence of words.text.split(SENTENCE_SPLIT)) {
    const s = trimmed(sub(words, at, at + sentence.length));
    at += sentence.length;
    if (!s.text || !(SURPRISE_STRONG.test(s.text) || SURPRISE_WEAK.test(s.text))) continue;
    const cut = headed(s, 400);
    if (used + cut.text.length > maxChars) break;
    kept.push(cut);
    used += cut.text.length;
  }
  return joined(kept, ' … ');
}

/** Of a comment, its first paragraph and the paragraphs that conclude something. */
function commentDigest(words: Mapped, maxChars: number): Mapped {
  const paragraphs: Mapped[] = [];
  let at = 0;
  for (const gap of words.text.matchAll(/\n\s*\n/g)) {
    paragraphs.push(sub(words, at, gap.index));
    at = gap.index + gap[0].length;
  }
  paragraphs.push(sub(words, at));
  const kept = paragraphs.map(trimmed).filter((paragraph) => paragraph.text !== '');
  if (kept.length === 0) return own('');
  const digest = [headed(kept[0]!, 500)];
  let used = digest[0]!.text.length;
  for (const paragraph of kept.slice(1)) {
    if (!(SURPRISE_STRONG.test(paragraph.text) || CONCLUSION.test(paragraph.text))) continue;
    const cut = headed(paragraph, 600);
    if (used + cut.text.length > maxChars) break;
    digest.push(cut);
    used += cut.text.length;
  }
  return joined(digest, '\n');
}

/** Score every line for the signals it carries (pack.py `prepare_lines`, then v2's additions). */
function scored(all: Line[]): Line[] {
  const lines: Line[] = [];
  for (const line of all) {
    if (line.rawThinking) {
      const words = signalSentences(line, 700);
      if (!words.text) continue;
      lines.push({ ...line, ...words });
    } else if (line.rawComment) {
      const words = commentDigest(line, 2200);
      if (!words.text) continue;
      lines.push({ ...line, ...words });
    } else {
      lines.push({ ...line });
    }
  }
  const n = lines.length;
  const mark = (line: Line, score: number, signal: string) => {
    line.score += score;
    line.sig.push(signal);
  };
  lines.forEach((line, i) => {
    const { sp, text } = line;
    if (OWNER_SPEAKERS.includes(sp)) {
      if (OWNER_RULE.test(text)) mark(line, 5, 'owner-rule');
      if (text.length < 80 && OWNER_DECIDE.test(text)) mark(line, 2, 'owner-decision');
      if (OWNER_ASK.test(text)) {
        line.sig.push('owner-ask');
        let explained = 0;
        for (let j = i + 1; j < Math.min(n, i + 12); j += 1) {
          if (OWNER_SPEAKERS.includes(lines[j]!.sp)) break;
          if (lines[j]!.sp === 'agent') {
            mark(lines[j]!, 2, 'explanation');
            explained += 1;
            if (explained >= 2) break;
          }
        }
      }
    } else if ((sp === 'sender' || sp === 'parent') && OWNER_RULE.test(text)) {
      mark(line, 2, 'sender-rule');
    }
    if (line.decision) mark(line, 4, 'owner-decision');
    if (sp === 'agent' || sp === 'think' || sp === 'comment' || sp === 'sub-agent') {
      if (SURPRISE_STRONG.test(text)) mark(line, 3, 'surprise');
      else if (SURPRISE_WEAK.test(text)) mark(line, 1, 'surprise-weak');
      if (PATHLIKE.test(text) || SHALIKE.test(text)) line.score += 0.5;
    }
    if (sp === 'tool' && line.tool?.err) {
      // A failure followed within a few tool steps by a success of the same kind of command.
      for (let j = i + 1; j < Math.min(n, i + 14); j += 1) {
        const later = lines[j]!;
        if (later.sp === 'tool' && later.tool && later.tool.head && later.tool.head === line.tool.head && !later.tool.err) {
          const weight = line.tool.kind === 'bash' ? 3 : 1;
          mark(line, weight, 'fail');
          mark(later, weight, 'fixed');
          line.fixTo = j;
          break;
        }
      }
    }
    if (sp === 'tool' && IRREVERSIBLE.test(text)) mark(line, 2, 'irreversible');
  });
  // v2: the agent explaining itself at length is where conclusions live, and a reaction right after a
  // failed or irreversible step is where a surprise is written down.
  lines.forEach((line, i) => {
    if (line.sp === 'agent' && line.text.length >= 150) mark(line, 1.5, 'agent-report');
    if ((line.sp === 'agent' || line.sp === 'think') && (SURPRISE_WEAK.test(line.text) || SURPRISE_STRONG.test(line.text))) {
      for (let j = Math.max(0, i - 2); j < i; j += 1) {
        const before = lines[j]!;
        if (before.sp === 'tool' && (before.tool?.err || before.sig.includes('irreversible'))) {
          mark(line, 1.5, 'reaction');
          before.score += 1;
          break;
        }
      }
    }
  });
  return lines;
}

interface Packed {
  text: string;
  /** The lines the text carries, in order, each with its words as the text carries them. */
  carried: Array<{ line: Line; words: Mapped }>;
  tokens: number;
  truncated: boolean;
}

/**
 * The header and the lines, packed into `budget` tokens (pack.py `pack_v2`): the owner's words and
 * the session's closing reply first, then windows around the signals, highest first, then the agent's
 * longer replies — and rendered back in time order, a gap marked by how many lines it left out. Lines that hold
 * the agent's notes are packed otherwise (`claims` below): the notes, the owner's words, what bears on each note.
 */
function pack(header: string, all: Line[], budget: number): Packed {
  const lines = scored(all);
  const n = lines.length;
  const caps = budget <= 4000
    ? { owner: 1500, task: 1200, final: 800, agent: 700, other: 400 }
    : budget <= 8000
      ? { owner: 3000, task: 3000, final: 1500, agent: 1200, other: 700 }
      : { owner: 6000, task: 6000, final: 3000, agent: 2400, other: 1200 };
  // What the per-line estimate below does not see — a line's `L12 agent: ` name, the indent of its
  // later lines, the markers between gaps — is paid for out of this, and checked after rendering.
  const reserve = Math.ceil(budget * 0.04);
  const limit = budget - reserve;
  const chosen = new Map<number, Mapped>();
  const takenOrder: number[] = [];
  let cut = false;
  let used = wikiEstimateTokens(header);
  const render = (line: Line, cap: number): Mapped => {
    if (line.text.length <= cap) return { text: line.text, origin: line.origin };
    const kept = headed(line, cap);
    return kept.text === line.text ? kept : cat(kept, own('…[cut]'));
  };
  const take = (i: number, cap: number): boolean => {
    if (chosen.has(i)) return true;
    const words = render(lines[i]!, cap);
    const cost = wikiEstimateTokens(words.text) + 6;
    if (used + cost > limit) return false;
    chosen.set(i, words);
    takenOrder.push(i);
    used += cost;
    return true;
  };
  const capFor = (line: Line) => (line.sp === 'agent' ? caps.agent : caps.other);

  const finish = (): Packed => {
    const renderAll = (): Packed => {
      const out = [header, ''];
      const carried: Packed['carried'] = [];
      let previous = -1;
      for (const i of [...chosen.keys()].sort((a, b) => a - b)) {
        if (i > previous + 1 && previous >= 0) out.push(`   … (${i - previous - 1} lines omitted)`);
        const line = lines[i]!;
        const words = chosen.get(i)!;
        out.push(`${line.ref} ${line.sp}: ${words.text.replace(/\n/g, '\n    ')}`);
        carried.push({ line, words });
        previous = i;
      }
      if (previous >= 0 && previous < n - 1) out.push(`   … (${n - 1 - previous} lines omitted)`);
      const text = out.join('\n');
      return { text, carried, tokens: wikiEstimateTokens(text), truncated: false };
    };
    let packed = renderAll();
    // The estimate above is per line; the budget is for the whole text. What does not fit is taken off
    // in the reverse of the order it was put in, so what goes first is what mattered least.
    while (packed.tokens > budget && takenOrder.length > 0) {
      chosen.delete(takenOrder.pop()!);
      packed = renderAll();
    }
    if (packed.tokens > budget) {
      // Only a header longer than the whole budget gets here: cut it, and say so.
      packed = { ...packed, text: cutToTokens(packed.text, budget), tokens: 0 };
      packed.tokens = wikiEstimateTokens(packed.text);
    }
    for (const words of chosen.values()) if (words.text.endsWith('…[cut]')) cut = true;
    packed.truncated = chosen.size < n || cut;
    return packed;
  };

  const claims: number[] = [];
  lines.forEach((line, i) => {
    if (line.sp === 'claim') claims.push(i);
  });
  if (claims.length > 0) {
    // The notes, the feedback first and then the newest: what does not fit is left out and counted.
    claims.sort((a, b) => Number(lines[b]!.claim!.feedback) - Number(lines[a]!.claim!.feedback) || b - a);
    const notes = claims.filter((i) => take(i, lines[i]!.text.length));
    // The task's opening, to say what the work was, and the owner's words, the strongest first, within their share.
    const opening = lines.findIndex((line) => line.sp === 'taskprompt');
    if (opening >= 0) take(opening, caps.other);
    let ownerRoom = Math.floor(budget * WIKI_DOSSIER_CLAIMS.ownerShare);
    const owners = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => OWNER_SPEAKERS.includes(line.sp) || line.decision)
      .sort((a, b) => b.line.score - a.line.score || b.i - a.i);
    for (const { i } of owners) {
      const cost = wikiEstimateTokens(render(lines[i]!, caps.final).text) + 6;
      if (cost <= ownerRoom && take(i, caps.final)) ownerRoom -= cost;
    }
    // Then what bears on each note, a line for every note in turn, so that no one note takes the whole file.
    const evidence = evidenceFor(lines, notes);
    for (let round = 0; evidence.some((hits) => round < hits.length); round += 1) {
      for (const hits of evidence) {
        const line = hits[round];
        if (line !== undefined) take(line, capFor(lines[line]!));
      }
    }
    return finish();
  }

  let lastAgent = -1;
  lines.forEach((line, i) => {
    if (line.sp === 'agent') lastAgent = i;
  });
  // The demo's mandatory lines — the owner's words and decisions, the task's prompt, the closing reply —
  // and the records §8.2 names on their own: a settled task's closing comments and the merge receipts.
  const mandatory: Array<{ rank: number; i: number; cap: number }> = [];
  lines.forEach((line, i) => {
    if (line.sp === 'taskprompt') mandatory.push({ rank: 1, i, cap: caps.task });
    else if (OWNER_SPEAKERS.includes(line.sp) || line.decision) mandatory.push({ rank: 0, i, cap: caps.owner });
    else if (line.sp === 'comment' || line.sp === 'comment-owner' || line.sp === 'merge') mandatory.push({ rank: 2, i, cap: caps.final });
  });
  if (lastAgent >= 0) mandatory.push({ rank: 3, i: lastAgent, cap: caps.final });
  mandatory.sort((a, b) => a.rank - b.rank || a.i - b.i);
  for (const { i, cap } of mandatory) {
    if (!take(i, cap)) take(i, Math.max(200, Math.floor(cap / 4)));
  }

  const keepInWindow = (j: number, center: number): boolean => {
    const line = lines[j]!;
    if (j === center || line.sp !== 'tool') return true;
    return Boolean(line.tool?.err) || line.sig.includes('irreversible') || line.sig.includes('fixed') || lines[center]!.sp === 'tool';
  };
  const windows: Array<{ lo: number; hi: number; score: number; center: number }> = [];
  lines.forEach((line, i) => {
    if (line.score < 1.5) return;
    const radius = line.sp === 'tool' ? 1 : 2;
    const lo = Math.max(0, i - radius);
    let hi = Math.min(n - 1, i + radius);
    if (line.fixTo !== undefined) {
      hi = Math.min(n - 1, Math.max(hi, line.fixTo + 1));
      if (hi - lo > 12) hi = lo + 12;
    }
    windows.push({ lo, hi, score: line.score, center: i });
  });
  windows.sort((a, b) => b.score - a.score || b.lo - a.lo || a.center - b.center);
  for (const window of windows) {
    const indexes: number[] = [];
    for (let j = window.lo; j <= window.hi; j += 1) {
      if (keepInWindow(j, window.center) && !chosen.has(j)) indexes.push(j);
    }
    const cost = indexes.reduce((sum, j) => sum + wikiEstimateTokens(render(lines[j]!, capFor(lines[j]!)).text) + 6, 0);
    if (used + cost <= limit) {
      for (const j of indexes) take(j, capFor(lines[j]!));
    } else {
      take(window.center, capFor(lines[window.center]!));
    }
    if (used >= limit) break;
  }
  const rest = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => line.sp === 'agent' && !chosen.has(i))
    .sort((a, b) => b.line.text.length - a.line.text.length || b.i - a.i);
  for (const { i } of rest) {
    if (used >= limit - 50) break;
    take(i, caps.agent);
  }

  return finish();
}

/** `text` cut at the last line break that keeps it within `budget` estimated tokens. */
function cutToTokens(text: string, budget: number): string {
  const points = Array.from(text);
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (wikiEstimateTokens(points.slice(0, mid).join('') + '…[cut]') <= budget) lo = mid;
    else hi = mid - 1;
  }
  return `${points.slice(0, lo).join('')}…[cut]`;
}

// ── Where each line's words are ─────────────────────────────────────────────────────────────────

/**
 * A tool call's output is read whole to place a line in it only up to this size as stored: past it, the
 * line's call and the first line of its result are placed and the result's last line is not.
 */
const TOOL_OUTPUT_READ_MAX_BYTES = 262_144;

/**
 * The tool calls — and the tool_use events of calls with no row — the carried tool lines cite, read whole:
 * a tool call's text is its name, its input and its output (`toolCallParts`), and an event's is its
 * payload's (`runEventParts`). Only the lines a dossier carries are read, so a session of a thousand calls
 * costs the reads of the few dozen it shows.
 */
async function toolRecords(
  reader: DossierReader,
  sessionId: string,
  calls: readonly string[],
  events: readonly string[],
): Promise<{ calls: Map<string, RecordPart[]>; events: Map<string, RecordPart[]> }> {
  const out = { calls: new Map<string, RecordPart[]>(), events: new Map<string, RecordPart[]>() };
  if (calls.length > 0) {
    const rows = await reader.$queryRaw<Array<{ id: string; name: string; input: unknown; output: unknown }>>`
      SELECT c."id"::text AS "id", c."name", c."input",
             CASE WHEN pg_column_size(c."output") <= ${TOOL_OUTPUT_READ_MAX_BYTES}::int THEN c."output" END AS "output"
        FROM "tool_call" c
       WHERE c."session_id" = ${sessionId}::uuid AND c."id" = ANY(${[...calls]}::uuid[])`;
    for (const row of rows) out.calls.set(row.id, toolCallParts(row));
  }
  if (events.length > 0) {
    const rows = await reader.$queryRaw<Array<{ id: string; payload: unknown }>>`
      SELECT e."id"::text AS "id", e."payload" FROM "run_event" e
       WHERE e."session_id" = ${sessionId}::uuid AND e."id" = ANY(${[...events]}::uuid[])`;
    for (const row of rows) out.events.set(row.id, runEventParts('tool_use', row.payload));
  }
  return out;
}

/**
 * Where a line's words are in its record's text: each run of them copied from one field of the record, put
 * where that field is in the text and held to the words found there — a run that is not found is left out,
 * never placed near enough. Ranges in UTF-16 units of the layout's text.
 */
function placed(words: Mapped, evidence: Evidence, layout: Layout): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  let i = 0;
  while (i < words.text.length) {
    const origin = words.origin[i]!;
    if (origin < 0) {
      i += 1;
      continue;
    }
    const field = evidence.fields.find((one) => origin >= one.from && origin < one.to);
    let j = i + 1;
    while (j < words.text.length && words.origin[j] === words.origin[j - 1]! + 1 && field && words.origin[j]! < field.to) j += 1;
    const piece = words.text.slice(i, j);
    const region = field ? layout.regions?.get(field.part) : undefined;
    let start = -1;
    if (field && region) {
      const base = field.offset === 'end' ? region.end - (field.to - field.from) : region.start + field.offset;
      const expected = base + (origin - field.from);
      if (expected >= region.start && expected + piece.length <= region.end && layout.text.startsWith(piece, expected)) {
        start = expected;
      } else {
        const again = layout.text.indexOf(piece, region.start);
        if (again >= 0 && again + piece.length <= region.end) start = again;
      }
    } else if (!layout.regions) {
      start = layout.text.indexOf(piece, cursor);
    }
    if (start >= 0) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === start) last[1] = start + piece.length;
      else ranges.push([start, start + piece.length]);
      cursor = start + piece.length;
    }
    i = j;
  }
  return ranges;
}

/**
 * A line's spans: where its words are, or — for a line that shows none of its record's words — where the
 * words it stands for are: a repeated prompt's prompt, a decision's plan, a status's record. A record with
 * no words at all is pointed at where its text begins, and ends: a span of none.
 */
function spansOf(line: Line, words: Mapped, layout: Layout): WikiDossierSpan[] {
  let ranges = placed(words, line.evidence, layout);
  if (ranges.length === 0 && line.refers) ranges = placed(line.refers, line.evidence, layout);
  if (ranges.length === 0) {
    const regions = layout.regions ? [...layout.regions.values()] : [{ start: 0, end: layout.text.length }];
    const worded = regions.find((region) => hasText(layout.text.slice(region.start, region.end)));
    ranges = [worded ? [worded.start, worded.end] : [0, 0]];
  }
  return inCodePoints(layout.text, ranges);
}

/** UTF-16 ranges of `text` as code point spans, each with the words it covers. */
function inCodePoints(text: string, ranges: ReadonlyArray<readonly [number, number]>): WikiDossierSpan[] {
  const marks = [...new Set(ranges.flat())].sort((a, b) => a - b);
  const points = new Map<number, number>();
  let unit = 0;
  let count = 0;
  for (const mark of marks) {
    for (; unit < mark; count += 1) unit += text.codePointAt(unit)! > 0xffff ? 2 : 1;
    points.set(mark, count);
  }
  return ranges.map(([start, end]) => ({ start: points.get(start)!, end: points.get(end)!, text: text.slice(start, end) }));
}

/** Each carried line's record and spans: the tool calls among them read whole first. */
async function sourcesOf(
  reader: DossierReader,
  records: DossierRecords,
  carried: Packed['carried'],
  redact: (text: string) => string,
): Promise<WikiDossierSource[]> {
  // A note cites nothing, and nothing can cite it: it is not one of the lines a source may name.
  const cited = carried.filter(({ line }) => line.sp !== 'claim');
  const unread = cited.filter(({ line }) => line.layout === null);
  const tools = await toolRecords(
    reader,
    records.session.id,
    unread.filter(({ line }) => line.source.kind === 'tool_call').map(({ line }) => line.source.id),
    unread.filter(({ line }) => line.source.kind === 'event').map(({ line }) => line.source.id),
  );
  return cited.map(({ line, words }) => {
    const parts = line.layout ? null : (line.source.kind === 'tool_call' ? tools.calls : tools.events).get(line.source.id);
    const layout = line.layout ?? layoutOf(parts ?? [], redact);
    return { ref: line.ref!, kind: line.source.kind, id: line.source.id, spans: spansOf(line, words, layout) };
  });
}

// ── The dossier ─────────────────────────────────────────────────────────────────────────────────

export interface DossierOptions {
  /** The owner's workspace.env values, replaced wherever they appear verbatim. */
  literals: readonly string[];
  /** Tokens the dossier may take. The contract's 8,000 unless a test names a smaller one. */
  maxTokens?: number;
  /**
   * Make the file of the pass that only checks the agent's notes: the writes to memory files as `C1 claim:` lines,
   * the owner's words and the records that bear on each note, and nothing else (docs/wiki-memory-claims-design.md
   * §3.1, §6.2). Off by default; a session with no note to carry gets the same bytes either way, and no pass.
   */
  claims?: boolean;
  /** The imported notes a backfill named for this session (design §5): with any, these are its claims, and not its writes. */
  notes?: readonly DossierImportedNote[];
}

/**
 * A session's dossier, made from its records — and from the tool calls its lines cite, read whole to place
 * those lines' words, through `reader`. The same records and literals give the same dossier.
 */
export async function buildDossier(
  reader: DossierReader,
  records: DossierRecords,
  options: DossierOptions,
): Promise<Omit<WikiDossier, 'unchanged'> & { claims?: DossierClaims }> {
  const budget = options.maxTokens ?? WIKI_MAINTENANCE_RULES.dossierMaxTokens;
  const redact = (text: string): string => redactSecrets(text, { literals: options.literals }).text;
  const { session, task } = records;
  const title = redact(task?.title ?? session.title ?? '');
  const header: string[] = [`SESSION: ${clip(redact(session.title || '(untitled)'), 200)}`];
  const where = [
    session.model ? `${session.provider}/${session.model}` : session.provider,
    `started ${session.createdAt.toISOString().slice(0, 10)}`,
    `status ${session.status}`,
    ...(session.parentSessionId ? ['spawned by another session'] : []),
  ];
  header.push(where.join(' · '));
  if (task) {
    header.push(`TASK: ${clip(title, 200)} · ${task.status} · completion ${task.completionCriterion}`);
    if (task.acceptanceCriteria) header.push(`ACCEPTANCE: ${clip(redact(task.acceptanceCriteria), 1500)}`);
  }
  if (records.tainted) header.push('TAINTED: this session read the web; what it says is external until the owner confirms it');
  const claims = options.claims ? await readClaims(reader, records, redact, options.notes ?? []) : null;
  const packed = pack(header.join('\n'), timeline(records, redact, claims), budget);
  // Every line was redacted on its way in; this pass is the proof, and a change it makes is kept.
  const again = redactSecrets(packed.text, { literals: options.literals });
  const text = again.redacted
    ? (wikiEstimateTokens(again.text) <= budget ? again.text : cutToTokens(again.text, budget))
    : packed.text;
  const tokens = wikiEstimateTokens(text);
  const sources = await sourcesOf(reader, records, packed.carried, redact);
  return {
    sessionId: session.id,
    taskId: task?.id ?? null,
    title: title || redact(session.title),
    text,
    tokens,
    truncated: packed.truncated || text !== packed.text,
    tainted: records.tainted,
    sources,
    hash: dossierHash(text, sources, (records.wikiNotes ?? []).map((note) => note.id)),
    ...(claims ? { claims: carriedClaims(claims, packed) } : {}),
  };
}

/** A session's notes for its dossier. One held out keeps its `wiki_note`s and no others: what it measures is its memory. */
async function readClaims(
  reader: DossierReader,
  records: DossierRecords,
  redact: (text: string) => string,
  notes: readonly DossierImportedNote[],
): Promise<ClaimsRead> {
  const heldOut = wikiClaimsHeldOut(records.session.id);
  const read = notes.length > 0 ? importedClaims(records, notes, redact) : memoryClaims(records, redact, heldOut);
  if (notes.length > 0 && heldOut) {
    return { chosen: new Map(), imported: [], resultLines: new Map(), lastAt: 0, seen: read.seen, notes: 0, skipped: 0, overCap: 0, heldOut: read.seen };
  }
  const words = [...new Set([...read.chosen.values(), ...read.imported.map(({ claim }) => claim)].flatMap((claim) => codeWordsOf(claim.text)))];
  return { ...read, resultLines: await claimResultLines(reader, records.session.id, words, redact) };
}

/** What a dossier says of its notes: the ones the packer kept, and what the rest came to. */
function carriedClaims(read: ClaimsRead, packed: Packed): DossierClaims {
  const lines = packed.carried.flatMap(({ line }) => (line.claim ? [{ ref: line.ref!, ...line.claim.by }] : []));
  return { seen: read.seen, notes: read.notes, skipped: read.skipped, overCap: read.overCap + read.chosen.size + read.imported.length - lines.length, heldOut: read.heldOut, lines };
}

/**
 * The hash a dossier is kept by: its text, a NUL, and its sources' records as JSON. The spans are not in it:
 * they are where the same records' words are, and a dossier whose text and records did not change is one
 * the run has already read. A session's `wiki_note`s are in no text of this kind, and filing one adds no line to it, so
 * their ids are added to what is hashed: a new note is something the run has not read, and its answer said a run would.
 */
export function dossierHash(
  text: string,
  sources: ReadonlyArray<Pick<WikiDossierSource, 'ref' | 'kind' | 'id'>>,
  noteIds: readonly string[] = [],
): string {
  const records = `${text}\u0000${JSON.stringify(sources.map(({ ref, kind, id }) => ({ ref, kind, id })))}`;
  return sha256(noteIds.length === 0 ? records : `${records}\u0000${noteIds.join(',')}`);
}

/**
 * The sources as `wiki_dossier` keeps them: each line's record and where its spans are — never the words in
 * them, which are the session's text and are never stored (hard constraint 4).
 */
export function storedDossierSources(sources: readonly WikiDossierSource[]): Array<Omit<WikiDossierSource, 'spans'> & { spans: Array<{ start: number; end: number }> }> {
  return sources.map(({ ref, kind, id, spans }) => ({ ref, kind, id, spans: spans.map(({ start, end }) => ({ start, end })) }));
}
