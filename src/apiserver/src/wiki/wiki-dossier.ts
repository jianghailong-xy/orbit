import { Prisma } from '@prisma/client';
import {
  WIKI_MAINTENANCE_RULES,
  wikiEstimateTokens,
  type WikiDossier,
  type WikiDossierSource,
  type WikiSourceKind,
} from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { redactSecrets } from '../common/secret-redaction';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';

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
 * NEVER STORED. The text is handed to the maintenance run and forgotten; what is kept is the sources and
 * the hash (`wiki_dossier`, hard constraint 4).
 */

// ── The records one session's dossier is made from ──────────────────────────────────────────────

/** Anything that can run a raw read: the service's client or a transaction's. */
export type DossierReader = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface DossierSessionRow {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  status: string;
  createdAt: Date;
  taskId: string | null;
  parentSessionId: string | null;
  dispatchOrigin: string;
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
  pattern: string | null;
  background: string | null;
  input: string | null;
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
  /** tool_use id → tool_call id, for the tool lines to cite the row whose output is the result. */
  toolCallIds: Map<string, string>;
  task: DossierTaskRow | null;
  comments: DossierCommentRow[];
  receipts: DossierReceiptRow[];
  blockers: DossierBlockerRow[];
  /** The session read the web (a WebFetch or WebSearch call): the taint mark (design §4.1 step 9). */
  tainted: boolean;
}

/** Tools whose input is described by the columns above; any other tool's input is kept as JSON text. */
const DESCRIBED_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite', 'NotebookEdit', 'LS'];
/** Bookkeeping tools the timeline leaves out: they say what the agent planned, not what happened. */
const SKIPPED_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'ToolSearch']);
/** The terminal task statuses: a task in one of them is settled, and its closing comments count. */
const SETTLED_TASK_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

/**
 * Read one session's records for its dossier, or null when the owner has no such session.
 *
 * Long values are cut in SQL before they cross the wire — a tool result or a thought can run to
 * megabytes, and the dossier keeps a line of each — at lengths well above anything the packer keeps.
 */
export async function loadDossierRecords(reader: DossierReader, ownerId: string, sessionId: string): Promise<DossierRecords | null> {
  const [session] = await reader.$queryRaw<DossierSessionRow[]>`
    SELECT s."id"::text AS "id", s."title", s."provider", s."model", s."status"::text AS "status",
           s."created_at" AS "createdAt", s."task_id"::text AS "taskId",
           s."parent_session_id"::text AS "parentSessionId", s."dispatch_origin"::text AS "dispatchOrigin"
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
    SELECT a."id"::text AS "id", a."tool_name" AS "toolName", a."status", left(a."message", 3000) AS "message",
           a."answers" AS "answers",
           CASE WHEN a."tool_name" = 'AskUserQuestion' THEN a."input"->'questions' END AS "questions",
           CASE WHEN a."tool_name" = 'ExitPlanMode' THEN left(a."input"->>'plan', 5000) END AS "plan",
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
           CASE WHEN e."type" = 'tool_use' THEN left(e."payload"->'input'->>'pattern', 300) END AS "pattern",
           CASE WHEN e."type" = 'tool_use' THEN e."payload"->'input'->>'run_in_background' END AS "background",
           CASE WHEN e."type" = 'tool_use' AND coalesce(e."payload"->>'name', '') <> ALL (${DESCRIBED_TOOLS}::text[])
                THEN left((e."payload"->'input')::text, 2000) END AS "input",
           CASE WHEN e."type" = 'tool_result' THEN e."payload"->>'toolUseId' END AS "resultOf",
           CASE WHEN e."type" = 'tool_result' THEN e."payload"->>'isError' END AS "isError",
           CASE WHEN e."type" = 'tool_result' THEN left(r."content", 1200) END AS "resultHead",
           CASE WHEN e."type" = 'tool_result' AND length(r."content") > 1200 THEN right(r."content", 600) END AS "resultTail",
           CASE WHEN e."type" = 'background_task' THEN left(e."payload"->>'command', 600) END AS "bgCommand",
           CASE WHEN e."type" = 'background_task' THEN e."payload"->>'status' END AS "bgStatus",
           CASE WHEN e."type" = 'background_task' THEN e."payload"->>'exitCode' END AS "bgExit",
           CASE WHEN e."type" = 'background_task' THEN left(e."payload"->>'summary', 1000) END AS "bgSummary",
           CASE WHEN e."type" = 'error' THEN left(e."payload"->>'message', 1500) END AS "errorMessage",
           CASE WHEN e."type" = 'turn_end' THEN e."payload"->>'subtype' END AS "subtype"
      FROM "run_event" e
      LEFT JOIN LATERAL (
        SELECT CASE WHEN e."type" = 'tool_result' THEN
                 CASE WHEN jsonb_typeof(e."payload"->'content') = 'array'
                      THEN (SELECT string_agg(coalesce(x->>'text', ''), E'\n') FROM jsonb_array_elements(e."payload"->'content') x)
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
    SELECT b."id"::text AS "id", b."kind", left(b."required_action", 1000) AS "requiredAction",
           left(b."resolution_note", 3000) AS "resolutionNote", b."resolved_at" AS "resolvedAt"
      FROM "project_blocker" b
      JOIN "project" p ON p."id" = b."project_id"
     WHERE p."owner_id" = ${ownerId}::uuid AND b."subject_id" = ANY(${subjects}::text[])
       AND b."resolved_by" = 'USER' AND b."resolved_at" IS NOT NULL
       AND b."resolution_note" IS NOT NULL AND btrim(b."resolution_note") <> ''
     ORDER BY b."resolved_at", b."id"`;

  return { session, turns, approvals, events, toolCallIds, task, comments, receipts, blockers, tainted };
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
  return `${blocker.requiredAction}\n${blocker.resolutionNote}`;
}

// ── The timeline (prepare.py) ───────────────────────────────────────────────────────────────────

type Speaker =
  | 'owner' | 'user' | 'sender' | 'parent' | 'system' | 'taskprompt'
  | 'agent' | 'sub-agent' | 'think' | 'tool' | 'comment' | 'comment-owner' | 'merge' | 'blocker';

type ToolKind = 'read' | 'edit' | 'bash' | 'tool';

interface Line {
  sp: Speaker;
  text: string;
  source: { kind: WikiSourceKind; id: string };
  /** The record's time, as milliseconds: lines are ordered by it, then by `order`, then as built. */
  at: number;
  order: number;
  decision?: boolean;
  /** Thinking: only its signal sentences are kept. A comment: only its digest. */
  rawThinking?: boolean;
  rawComment?: boolean;
  tool?: { kind: ToolKind; err: boolean; target: string; head: string };
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
/** The step list every task's opening prompt ends with: the same for every task, and says nothing of it. */
const TASK_BOILERPLATE = /\n*请按以下步骤进行：[\s\S]*$/;
const READLIKE_BASH = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:cat|sed -n|head|tail|ls|grep|rg|find|wc|nl|awk|less|file|stat|tree|git (?:log|show|diff|status|grep|ls-files|blame|rev-parse|branch)|jq|echo)\b/;
const MEMORY_SENTENCE_SPLIT = /(?<=[。！？!?\n])|(?<=\.\s)/;

/** `text` cut to `max` characters (code points, never half of one), with how much was left out. */
function clip(text: string | null | undefined, max: number): string {
  const value = text ?? '';
  if (value.length <= max) return value;
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max).join('')}…[+${points.length - max} chars]`;
}

/** The first `max` code points of `text`. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

function firstLine(text: string | null | undefined, max = 200): string {
  const line = (text ?? '').trim().split('\n', 1)[0] ?? '';
  const cut = head(line, max);
  return cut === line ? line : `${cut}…`;
}

function lastLine(text: string | null | undefined, max = 160): string {
  const value = (text ?? '').trimEnd();
  if (!value) return '';
  const line = value.slice(value.lastIndexOf('\n') + 1).trim();
  const cut = head(line, max);
  return cut === line ? line : `${cut}…`;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The sentences of `text` that do not point at the memory library. */
function withoutMemory(text: string): string {
  if (!text || !MEMORY_MENTION.test(text)) return text;
  return text.split(MEMORY_SENTENCE_SPLIT).filter((part) => part && !MEMORY_MENTION.test(part)).join('');
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

/** An AskUserQuestion's questions and the answers given, as one line. */
function askedAndAnswered(approval: DossierApprovalRow, redact: (text: string) => string): string {
  const questions = Array.isArray(approval.questions) ? (approval.questions as Array<Record<string, unknown>>) : [];
  const answers = approval.answers !== null && typeof approval.answers === 'object' && !Array.isArray(approval.answers)
    ? (approval.answers as Record<string, unknown>)
    : {};
  const parts = questions.map((question) => {
    const text = typeof question.question === 'string' ? question.question : '';
    const options = (Array.isArray(question.options) ? question.options : [])
      .map((option) => (option !== null && typeof option === 'object' ? (option as { label?: unknown }).label : null))
      .filter((label): label is string => typeof label === 'string' && label !== '')
      .slice(0, 6)
      .map((label) => clip(redact(label), 80));
    const chosen = answers[text];
    return `Q: ${clip(redact(text), 400)} [options: ${options.join(' | ')}] → A: ${
      chosen === undefined || chosen === null ? '(none)' : redact(JSON.stringify(chosen))
    }`;
  });
  let line = `AskUserQuestion ${approval.status}. ${parts.join(' ; ')}`;
  if (approval.message) line += ` · owner note: ${clip(redact(approval.message), 1500)}`;
  return line;
}

/**
 * The session as a timeline of one-line events, every text already redacted (prepare.py
 * `build_timeline`, for one session).
 */
function timeline(records: DossierRecords, redact: (text: string) => string): Line[] {
  const { session } = records;
  const lines: Line[] = [];
  const add = (at: Date | null, order: number, sp: Speaker, text: string, source: Line['source'], extra: Partial<Line> = {}) => {
    lines.push({ sp, text, source, at: at ? at.getTime() : 0, order, score: 0, sig: [], ...extra });
  };

  // The conversation turns.
  const hasMessages = records.turns.some((turn) => turn.kind === 'message');
  let openingSeen = false;
  for (const turn of records.turns) {
    const sp = speakerOf(turn, session);
    const key = turn.clientTurnId ?? '';
    const content = redact(turn.content ?? '');
    if (key.startsWith('bg-wake') && content.trim() === '') continue;
    const source = { kind: 'turn' as const, id: turn.id };
    if (turn.kind === 'interrupt') {
      add(turn.createdAt, 1, sp, `⏹ interrupted the agent${content.trim() ? `: ${clip(content, 2000)}` : ''}`, source);
      continue;
    }
    if (turn.kind === 'shell') {
      add(turn.createdAt, 1, sp, `! ${clip(content, 600)}`, source);
      continue;
    }
    let text: string;
    if (sp === 'taskprompt') {
      // A retry opens with the same prompt as before; the demo said so rather than repeating it.
      if (openingSeen) {
        add(turn.createdAt, 1, sp, '(the same opening prompt again)', source);
        continue;
      }
      openingSeen = true;
      text = clip(withoutMemory(content.replace(TASK_BOILERPLATE, '')), 9000);
    } else if (sp === 'owner' || sp === 'user') {
      text = clip(content, 6000);
    } else if (sp === 'system') {
      text = clip(content, /^(?:watch:|open-item|pc:|project-started|task-run)/.test(key) ? 700 : 1200);
    } else {
      text = clip(withoutMemory(content), 3000);
    }
    add(turn.createdAt, 1, sp, turn.kind === 'steer' ? `(steer) ${text}` : text, source);
  }

  // The approvals: the owner's answers to what the agent asked.
  for (const approval of records.approvals) {
    const source = { kind: 'approval' as const, id: approval.id };
    if (approval.toolName === 'AskUserQuestion') {
      if (approval.status === 'PENDING' || approval.status === 'ABANDONED') continue;
      add(approval.createdAt, 2, 'owner', askedAndAnswered(approval, redact), source, { decision: true });
    } else if (approval.toolName === 'ExitPlanMode') {
      add(approval.createdAt, 2, 'agent', `PLAN: ${clip(redact(approval.plan ?? ''), 2500)}`, source);
      if (approval.status !== 'PENDING' && approval.status !== 'ABANDONED') {
        const note = approval.message ? `: ${clip(redact(approval.message), 1500)}` : '';
        add(approval.decidedAt ?? approval.createdAt, 3, 'owner', `plan ${approval.status.toLowerCase()}${note}`, source, { decision: true });
      }
    } else if (approval.status === 'DENIED' && approval.message) {
      // A denial that says why is the owner teaching; a bare click is not (§8.2: DENIED with a reason).
      add(approval.decidedAt ?? approval.createdAt, 3, 'owner',
        `${approval.toolName} denied ${clip(redact(approval.input ?? ''), 200)} · note: ${clip(redact(approval.message), 1000)}`,
        source, { decision: true });
    }
  }

  // The agent's own trace.
  const results = new Map<string, DossierEventRow>();
  for (const event of records.events) {
    if (event.type === 'tool_result' && event.resultOf) results.set(event.resultOf, event);
  }
  for (const event of records.events) {
    const source = { kind: 'event' as const, id: event.id };
    const sub = Boolean(event.parentToolUseId);
    switch (event.type) {
      case 'assistant': {
        const text = withoutMemory(redact(event.text ?? ''));
        if (text.trim()) add(event.createdAt, 4, sub ? 'sub-agent' : 'agent', clip(text, 5000), source);
        break;
      }
      case 'thinking': {
        const text = withoutMemory(redact(event.text ?? ''));
        if (text.trim()) add(event.createdAt, 4, 'think', text, source, { rawThinking: true });
        break;
      }
      case 'user': {
        // A session from before conversation turns were stored: its user events are its messages.
        const text = redact(event.text ?? '');
        if (!hasMessages && text.trim()) add(event.createdAt, 1, 'user', clip(text, 6000), source);
        break;
      }
      case 'tool_use': {
        const line = toolLine(event, results.get(event.toolUseId ?? ''), redact);
        if (!line) break;
        const callId = event.toolUseId ? records.toolCallIds.get(event.toolUseId) : undefined;
        add(event.createdAt, 5, 'tool', line.text, callId ? { kind: 'tool_call', id: callId } : source, { tool: line.tool });
        break;
      }
      case 'background_task': {
        const finished = event.bgStatus === 'completed' || event.bgStatus === 'failed' || event.bgStatus === 'killed'
          || (event.bgExit !== null && event.bgExit !== '');
        if (!finished) break;
        const command = redact(event.bgCommand ?? '');
        if (MEMORY_PATH.test(command)) break;
        const ok = ['0', 'None', ''].includes(String(event.bgExit ?? '')) && event.bgStatus !== 'failed';
        const exit = event.bgExit === null || event.bgExit === '' ? '' : ` exit=${event.bgExit}`;
        const summary = event.bgSummary ? ` — ${clip(redact(event.bgSummary), 300)}` : '';
        add(event.createdAt, 5, 'tool', `bg ${event.bgStatus ?? ''}${exit}: ${firstLine(command, 160)}${summary}`, source, {
          tool: { kind: 'bash', err: !ok, target: firstLine(command, 80), head: commandHead(command) },
        });
        break;
      }
      case 'error':
        add(event.createdAt, 5, 'system', `ERROR: ${clip(redact(event.errorMessage ?? ''), 500)}`, source);
        break;
      case 'turn_end':
        if (event.subtype && event.subtype !== 'success') add(event.createdAt, 6, 'system', `turn ended: ${event.subtype}`, source);
        break;
      default:
        break;
    }
  }

  // The task's closing records, and the session's receipts and the owner's resolutions.
  for (const comment of records.comments) {
    const body = withoutMemory(redact(comment.body));
    if (!body.trim()) continue;
    add(comment.createdAt, 7, comment.authorType === 'USER' ? 'comment-owner' : 'comment', body,
      { kind: 'task_comment', id: comment.id }, { rawComment: true });
  }
  for (const receipt of records.receipts) {
    add(receipt.createdAt, 7, 'merge', `${redact(mergeReceiptText(receipt))} (recorded by ${redact(receipt.recordedBy)})`,
      { kind: 'merge_receipt', id: receipt.id });
  }
  for (const blocker of records.blockers) {
    add(blocker.resolvedAt, 7, 'blocker',
      `${blocker.kind}: ${clip(redact(blocker.requiredAction), 400)} → the owner resolved it: ${clip(redact(blocker.resolutionNote), 1500)}`,
      { kind: 'owner_decision', id: blocker.id }, { decision: true });
  }

  // Oldest first; a stable sort, so records of one moment keep the order they were built in.
  lines.sort((a, b) => a.at - b.at || a.order - b.order);

  // A run of reads (or of edits) is one line.
  const folded: Line[] = [];
  for (const line of lines) {
    const previous = folded[folded.length - 1];
    if (previous && line.sp === 'tool' && previous.sp === 'tool' && line.tool && previous.tool
      && !line.tool.err && !previous.tool.err && (line.tool.kind === 'read' || line.tool.kind === 'edit')
      && previous.tool.kind === line.tool.kind) {
      (previous.fold ??= [previous.tool.target]).push(line.tool.target);
      continue;
    }
    folded.push(line);
  }
  for (const line of folded) {
    if (!line.fold || !line.tool) continue;
    const targets = [...new Set(line.fold)];
    line.text = `${line.tool.kind} ×${line.fold.length}: ${targets.slice(0, 6).map((target) => head(target, 90)).join(', ')}${
      targets.length > 6 ? ' …' : ''
    }`;
  }
  folded.forEach((line, index) => {
    line.ref = `L${index + 1}`;
  });
  return folded;
}

/** One tool call and its result as a line, or null for a call the dossier leaves out. */
function toolLine(
  use: DossierEventRow,
  result: DossierEventRow | undefined,
  redact: (text: string) => string,
): { text: string; tool: NonNullable<Line['tool']> } | null {
  const name = use.toolName ?? '?';
  const command = redact(use.command ?? '');
  const filePath = redact(use.filePath ?? '');
  const pattern = redact(use.pattern ?? '');
  const input = redact(use.input ?? '');
  if (MEMORY_PATH.test([command, filePath, pattern, input].join(' '))) return null;
  if (SKIPPED_TOOLS.has(name)) return null;
  let err = String(result?.isError ?? '').toLowerCase() === 'true';
  let resultHead = redact(result?.resultHead ?? '');
  let resultTail = redact(result?.resultTail ?? '');
  const exit = /^\s*Exit code (\d+)/.exec(resultHead);
  if (exit && exit[1] !== '0') err = true;
  if (MEMORY_MENTION.test(resultHead.slice(0, 300))) {
    resultHead = '(memory file content omitted)';
    resultTail = '';
  }
  let text: string;
  let kind: ToolKind;
  let target: string;
  let group: string;
  if (name === 'Bash') {
    kind = READLIKE_BASH.test(command) && !err ? 'read' : 'bash';
    text = `$ ${firstLine(command, 220)}`;
    const more = command.split('\n').length - 1;
    if (more > 0) text += ` …(+${more} lines)`;
    if (use.background === 'true') text += ' [background]';
    target = firstLine(command, 80);
    group = commandHead(command);
  } else if (name === 'Read' || name === 'Glob' || name === 'Grep' || name === 'LS') {
    kind = 'read';
    target = `${filePath}${pattern ? ` /${pattern}/` : ''}`;
    text = `${name.toLowerCase()} ${target}`;
    group = name;
  } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    kind = 'edit';
    target = filePath;
    text = `${name.toLowerCase()} ${target}`;
    group = `${name} ${target}`;
  } else {
    kind = 'tool';
    const orbit = name.startsWith('mcp__orbit__') || name.startsWith('orbit');
    text = `${name} ${clip(withoutMemory(input), orbit ? 900 : 300)}`;
    target = name;
    group = name;
  }
  if (result) {
    let outcome: string;
    if (err) {
      outcome = `ERR: ${firstLine(resultHead, 240)}`;
      const last = lastLine(resultTail || resultHead, 200);
      if (last && !outcome.includes(last)) outcome += ` … ${last}`;
    } else if (kind === 'bash' || kind === 'tool') {
      outcome = 'ok';
      const first = firstLine(resultHead, 160);
      if (first) outcome += `: ${first}`;
      const last = resultTail ? lastLine(resultTail, 140) : '';
      if (last && last !== first) outcome += ` … ${last}`;
    } else {
      outcome = 'ok';
    }
    text += ` → ${outcome}`;
  }
  return { text, tool: { kind, err, target, head: group } };
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
function signalSentences(text: string, maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const s = sentence.trim();
    if (!s || !(SURPRISE_STRONG.test(s) || SURPRISE_WEAK.test(s))) continue;
    const cut = head(s, 400);
    if (used + cut.length > maxChars) break;
    kept.push(cut);
    used += cut.length;
  }
  return kept.join(' … ');
}

/** Of a comment, its first paragraph and the paragraphs that conclude something. */
function commentDigest(body: string, maxChars: number): string {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return '';
  const kept = [head(paragraphs[0]!, 500)];
  let used = kept[0]!.length;
  for (const paragraph of paragraphs.slice(1)) {
    if (!(SURPRISE_STRONG.test(paragraph) || CONCLUSION.test(paragraph))) continue;
    const cut = head(paragraph, 600);
    if (used + cut.length > maxChars) break;
    kept.push(cut);
    used += cut.length;
  }
  return kept.join('\n');
}

/** Score every line for the signals it carries (pack.py `prepare_lines`, then v2's additions). */
function scored(all: Line[]): Line[] {
  const lines: Line[] = [];
  for (const line of all) {
    if (line.rawThinking) {
      const text = signalSentences(line.text, 700);
      if (!text) continue;
      lines.push({ ...line, text });
    } else if (line.rawComment) {
      const text = commentDigest(line.text, 2200);
      if (!text) continue;
      lines.push({ ...line, text });
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
  sources: WikiDossierSource[];
  tokens: number;
  truncated: boolean;
}

/**
 * The header and the lines, packed into `budget` tokens (pack.py `pack_v2`): the owner's words and
 * the session's closing reply first, then windows around the signals, highest first, then the agent's
 * longer replies — and rendered back in time order, a gap marked by how many lines it left out.
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
  const chosen = new Map<number, string>();
  const takenOrder: number[] = [];
  let cut = false;
  let used = wikiEstimateTokens(header);
  const render = (line: Line, cap: number): string => {
    if (line.text.length <= cap) return line.text;
    const kept = head(line.text, cap);
    return kept === line.text ? kept : `${kept}…[cut]`;
  };
  const take = (i: number, cap: number): boolean => {
    if (chosen.has(i)) return true;
    const text = render(lines[i]!, cap);
    const cost = wikiEstimateTokens(text) + 6;
    if (used + cost > limit) return false;
    chosen.set(i, text);
    takenOrder.push(i);
    used += cost;
    return true;
  };
  const capFor = (line: Line) => (line.sp === 'agent' ? caps.agent : caps.other);

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
    const cost = indexes.reduce((sum, j) => sum + wikiEstimateTokens(render(lines[j]!, capFor(lines[j]!))) + 6, 0);
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

  const renderAll = (): Packed => {
    const out = [header, ''];
    const sources: WikiDossierSource[] = [];
    let previous = -1;
    for (const i of [...chosen.keys()].sort((a, b) => a - b)) {
      if (i > previous + 1 && previous >= 0) out.push(`   … (${i - previous - 1} lines omitted)`);
      const line = lines[i]!;
      out.push(`${line.ref} ${line.sp}: ${chosen.get(i)!.replace(/\n/g, '\n    ')}`);
      sources.push({ ref: line.ref!, kind: line.source.kind, id: line.source.id });
      previous = i;
    }
    if (previous >= 0 && previous < n - 1) out.push(`   … (${n - 1 - previous} lines omitted)`);
    const text = out.join('\n');
    return { text, sources, tokens: wikiEstimateTokens(text), truncated: false };
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
  for (const text of chosen.values()) if (text.endsWith('…[cut]')) cut = true;
  packed.truncated = chosen.size < n || cut;
  return packed;
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

// ── The dossier ─────────────────────────────────────────────────────────────────────────────────

export interface DossierOptions {
  /** The owner's workspace.env values, replaced wherever they appear verbatim. */
  literals: readonly string[];
  /** Tokens the dossier may take. The contract's 8,000 unless a test names a smaller one. */
  maxTokens?: number;
}

/** A session's dossier, made from its records. Pure: the same records and literals give the same dossier. */
export function buildDossier(records: DossierRecords, options: DossierOptions): Omit<WikiDossier, 'unchanged'> {
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
  const packed = pack(header.join('\n'), timeline(records, redact), budget);
  // Every line was redacted on its way in; this pass is the proof, and a change it makes is kept.
  const again = redactSecrets(packed.text, { literals: options.literals });
  const text = again.redacted
    ? (wikiEstimateTokens(again.text) <= budget ? again.text : cutToTokens(again.text, budget))
    : packed.text;
  const tokens = wikiEstimateTokens(text);
  return {
    sessionId: session.id,
    taskId: task?.id ?? null,
    title: title || redact(session.title),
    text,
    tokens,
    truncated: packed.truncated || text !== packed.text,
    tainted: records.tainted,
    sources: packed.sources,
    hash: dossierHash(text, packed.sources),
  };
}

/** The hash a dossier is kept by: its text, a NUL, and its sources as JSON. */
export function dossierHash(text: string, sources: readonly WikiDossierSource[]): string {
  return sha256(`${text}\u0000${JSON.stringify(sources.map(({ ref, kind, id }) => ({ ref, kind, id })))}`);
}
