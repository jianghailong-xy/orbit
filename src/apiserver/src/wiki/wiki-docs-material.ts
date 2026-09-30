import { Prisma } from '@prisma/client';
import {
  WIKI_DOC_MATERIAL_RULES,
  WIKI_DOC_RECORD_KINDS,
  type WikiDocMaterialEntry,
  type WikiDocMaterialRecord,
  type WikiDocMaterialWeight,
  type WikiDocRecordKind,
  type WikiEntryKind,
  type WikiPlanSessionCondition,
  type WikiSourceKind,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import type { PrismaService } from '../prisma/prisma.service';
import { findQuote } from './wiki-docs';
import { isOwnerTurn, type WikiPrincipal, type WikiService } from './wiki.service';

/**
 * The server's half of a document section's material (criterion 9; contracts/wiki.contract.json
 * `docs.material`, `docs.reads.material`): what only the database has, for `orbit wiki docs build`.
 * The repository's half — design-document sections, code and contracts at origin/main — is read by the
 * runner in its checkout; this file never names a path.
 *
 * TWO WAYS IN, BOTH BY THE SECTION'S SESSION CONDITION. The space's live entries that fit it
 * (`sectionFit`: its keywords or anchor paths find them, or — of its entry kinds — its topics or projects
 * do) are the way in to the first-hand records their current revisions cite: an entry is the via entry of
 * what it leads to, never the material itself. A maintenance run places an entry in the plan by the same
 * rule (wiki-docs-affected.ts). And with projects and keywords named, the owner's own words in those
 * projects' sessions and the comments on their tasks, in the time window.
 *
 * ONE TEXT PER RECORD. Every record is read through the one reader a record has (`WikiService.sourceText`)
 * and redacted with the owner's workspace.env values, exactly as a footnote's check reads it
 * (`WikiDocs.checkFootnote`): so `chars`, where the text handed out stands in the record's redacted text,
 * is the range a footnote on it names, and a quote copied from the text is found by the check.
 */

type Reader = Pick<PrismaService, '$queryRaw' | 'wikiSource' | 'wikiNote' | 'project' | 'session' | 'task' | 'toolCall' | 'taskComment'>;

/** A section's session condition as the plan stores it: projects by id (wiki-plan.ts `PlanSources`). */
export interface StoredSessionCondition {
  projects: string[];
  since: string | null;
  until: string | null;
  keywords: string[];
  anchorPaths: string[];
  entryKinds: string[];
  topics: string[];
  evidence: string;
}

interface CandidateEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  blob: string;
  topics: string[];
  anchors: unknown;
  currentRevision: number;
  recordedAt: Date;
}

/** One record found, before it is read: how, and through which entry. */
interface Found {
  kind: WikiDocRecordKind;
  ref: string;
  found: 'entry' | 'search';
  via: { entryId: string; title: string; kind: WikiEntryKind; quote: string | null } | null;
  /** What the excerpt is centred on: the entry source's quote, else the first keyword. */
  quote: string | null;
  /** An owner's comment reads as the owner's words; the reader does not say so of a comment. */
  ownerComment?: boolean;
}

const RECORD_KINDS = new Set<string>(WIKI_DOC_RECORD_KINDS);

/** A LIKE pattern that matches `text` anywhere, its own %, _ and \ taken literally. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/gu, (ch) => `\\${ch}`)}%`;
}

/** A LIKE pattern for a path and everything under it. */
function underPattern(path: string): string {
  return `${path.replace(/[\\%_]/gu, (ch) => `\\${ch}`)}%`;
}

/** Keywords worth looking for: trimmed, two characters or more, each once. */
export function conditionKeywords(condition: StoredSessionCondition): string[] {
  return [...new Set((condition.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => Array.from(keyword).length >= 2))];
}

/** Anchor paths as prefixes: backticks, a leading ./ and a trailing * taken off. */
export function conditionPaths(condition: StoredSessionCondition): string[] {
  return [...new Set((condition.anchorPaths ?? [])
    .map((path) => path.trim().replace(/^`+|`+$/gu, '').replace(/^\.\//u, '').replace(/\*+$/u, '').trim())
    .filter((path) => path !== '' && path !== '/'))];
}

function keywordHits(text: string, keywords: readonly string[]): number {
  const low = text.toLowerCase();
  return keywords.filter((keyword) => low.includes(keyword.toLowerCase())).length;
}

/** An entry's anchor paths: the `path` of each anchor that has one. */
export function anchorPathsOf(anchors: unknown): string[] {
  if (!Array.isArray(anchors)) return [];
  return anchors.flatMap((anchor) => {
    const path = anchor !== null && typeof anchor === 'object' ? (anchor as Record<string, unknown>).path : undefined;
    return typeof path === 'string' && path !== '' ? [path] : [];
  });
}

// ── Where an entry belongs ──────────────────────────────────────────────────────────────────────

const UUID_TEXT = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** An entry as the fit reads it: its words, kind, topics, anchor paths, and the projects its sources are in. */
export interface FitCandidate {
  id: string;
  kind: string;
  /** Title, summary, fields and aliases, as one text. */
  blob: string;
  topics: readonly string[];
  anchorPaths: readonly string[];
  projects: ReadonlySet<string>;
}

/**
 * Whether an entry fits a section's session condition, and how well (contract `docs.affected.fit`): 3 a
 * keyword, 2 an anchor path under the condition's, 1 a topic, 1 a kind, 1 a project. It fits by a keyword
 * or an anchor path, or — of one of the condition's kinds, when it names any — by a topic or a project.
 */
export function sectionFit(condition: StoredSessionCondition, entry: FitCandidate): { fits: boolean; score: number } {
  const keywords = conditionKeywords(condition);
  const paths = conditionPaths(condition);
  const hits = keywordHits(entry.blob, keywords);
  const path = entry.anchorPaths.some((anchor) => paths.some((prefix) => anchor === prefix || anchor.startsWith(prefix)));
  const kinds = new Set(condition.entryKinds ?? []);
  const kind = kinds.has(entry.kind);
  const kindAllowed = kinds.size === 0 || kind;
  const topics = new Set(condition.topics ?? []);
  const topic = entry.topics.some((slug) => topics.has(slug));
  const project = (condition.projects ?? []).some((id) => entry.projects.has(id));
  const fits = hits > 0 || path || (kindAllowed && (topic || project));
  return { fits, score: 3 * hits + (path ? 2 : 0) + (topic ? 1 : 0) + (kind ? 1 : 0) + (project ? 1 : 0) };
}

/**
 * The projects each entry was taken from: the projects of the sessions its current revision's live sources
 * are records of — a session of one of a project's tasks, or its coordinator's — and of the tasks and task
 * comments it cites. Only the owner's rows; a source that names no row of theirs names no project.
 */
export async function entryProjects(db: Pick<Reader, '$queryRaw'>, ownerId: string, entryIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (entryIds.length === 0) return out;
  const rows = await db.$queryRaw<Array<{ entryId: string; projectId: string }>>(Prisma.sql`
    WITH "src" AS (
      SELECT e."id" AS "entryId", s."kind" AS "kind",
             CASE WHEN s."ref" ~ ${UUID_TEXT} THEN s."ref"::uuid END AS "rid"
        FROM "wiki_entry" e
        JOIN "wiki_entry_revision" r ON r."entry_id" = e."id" AND r."owner_id" = e."owner_id" AND r."revision" = e."current_revision"
        JOIN "wiki_source" s ON s."revision_id" = r."id" AND s."owner_id" = r."owner_id" AND s."state" = 'live'
       WHERE e."owner_id" = ${ownerId}::uuid AND e."id" = ANY(${[...entryIds]}::uuid[])
    ), "sess" AS (
      SELECT src."entryId", t."session_id" AS "sessionId" FROM "src" JOIN "conversation_turn" t ON t."id" = src."rid" WHERE src."kind" = 'turn'
      UNION SELECT src."entryId", x."id" FROM "src" JOIN "session" x ON x."id" = src."rid" WHERE src."kind" = 'turn'
      UNION SELECT src."entryId", v."session_id" FROM "src" JOIN "run_event" v ON v."id" = src."rid" WHERE src."kind" = 'event'
      UNION SELECT src."entryId", c."session_id" FROM "src" JOIN "tool_call" c ON c."id" = src."rid" WHERE src."kind" = 'tool_call'
    )
    SELECT DISTINCT z."entryId"::text AS "entryId", z."projectId"::text AS "projectId" FROM (
      SELECT sess."entryId", k."project_id" AS "projectId"
        FROM "sess" JOIN "session" x ON x."id" = sess."sessionId" AND x."owner_id" = ${ownerId}::uuid
        JOIN "task" k ON k."id" = x."task_id" AND k."owner_id" = ${ownerId}::uuid
      UNION SELECT sess."entryId", p."id" FROM "sess" JOIN "project" p ON p."coordinator_session_id" = sess."sessionId" AND p."owner_id" = ${ownerId}::uuid
      UNION SELECT src."entryId", k."project_id" FROM "src" JOIN "task" k ON k."id" = src."rid" AND k."owner_id" = ${ownerId}::uuid WHERE src."kind" = 'task'
      UNION SELECT src."entryId", k."project_id" FROM "src" JOIN "task_comment" c ON c."id" = src."rid"
        JOIN "task" k ON k."id" = c."task_id" AND k."owner_id" = ${ownerId}::uuid WHERE src."kind" = 'task_comment'
    ) z
    WHERE z."projectId" IS NOT NULL`);
  for (const row of rows) {
    if (!out.has(row.entryId)) out.set(row.entryId, new Set());
    out.get(row.entryId)!.add(row.projectId);
  }
  return out;
}

/**
 * The space's live entries — of one of `kinds`, when any is named — taken from a session or a task of one of
 * the projects: the way in a section's projects give to its material (`sectionFit`).
 */
export async function entriesOfProjects(
  db: Pick<Reader, '$queryRaw'>,
  input: { ownerId: string; spaceId: string; projects: readonly string[]; kinds: readonly string[] },
): Promise<string[]> {
  if (input.projects.length === 0) return [];
  const { ownerId, spaceId } = input;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH "ps" AS (
      SELECT p."coordinator_session_id" AS "id" FROM "project" p
       WHERE p."owner_id" = ${ownerId}::uuid AND p."id" = ANY(${[...input.projects]}::uuid[]) AND p."coordinator_session_id" IS NOT NULL
      UNION
      SELECT s."id" FROM "session" s JOIN "task" k ON k."id" = s."task_id"
       WHERE s."owner_id" = ${ownerId}::uuid AND k."owner_id" = ${ownerId}::uuid AND k."project_id" = ANY(${[...input.projects]}::uuid[])
    ), "pt" AS (
      SELECT k."id" FROM "task" k WHERE k."owner_id" = ${ownerId}::uuid AND k."project_id" = ANY(${[...input.projects]}::uuid[])
    ), "src" AS (
      SELECT e."id" AS "entryId", s."kind" AS "kind", CASE WHEN s."ref" ~ ${UUID_TEXT} THEN s."ref"::uuid END AS "rid"
        FROM "wiki_entry" e
        JOIN "wiki_entry_revision" r ON r."entry_id" = e."id" AND r."owner_id" = e."owner_id" AND r."revision" = e."current_revision"
        JOIN "wiki_source" s ON s."revision_id" = r."id" AND s."owner_id" = r."owner_id" AND s."state" = 'live'
       WHERE e."owner_id" = ${ownerId}::uuid AND e."space_id" = ${spaceId}::uuid
         AND e."status" = 'active' AND e."anchor_state" NOT IN ('changed', 'missing')
         AND (cardinality(${[...input.kinds]}::text[]) = 0 OR e."kind" = ANY(${[...input.kinds]}::text[]))
    )
    SELECT DISTINCT src."entryId"::text AS "id" FROM "src"
     WHERE (src."kind" = 'turn' AND (src."rid" IN (SELECT "id" FROM "ps")
              OR EXISTS (SELECT 1 FROM "conversation_turn" t WHERE t."id" = src."rid" AND t."session_id" IN (SELECT "id" FROM "ps"))))
        OR (src."kind" = 'event' AND EXISTS (SELECT 1 FROM "run_event" v WHERE v."id" = src."rid" AND v."session_id" IN (SELECT "id" FROM "ps")))
        OR (src."kind" = 'tool_call' AND EXISTS (SELECT 1 FROM "tool_call" c WHERE c."id" = src."rid" AND c."session_id" IN (SELECT "id" FROM "ps")))
        OR (src."kind" = 'task' AND src."rid" IN (SELECT "id" FROM "pt"))
        OR (src."kind" = 'task_comment' AND EXISTS (SELECT 1 FROM "task_comment" c WHERE c."id" = src."rid" AND c."task_id" IN (SELECT "id" FROM "pt")))`);
  return rows.map((row) => row.id);
}

/** Day bounds of the window: since at 00:00, until through the end of its day (UTC); open either side. */
function windowOf(condition: StoredSessionCondition): { from: Date; to: Date } {
  const day = (value: string | null): Date | null => (value && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? new Date(`${value}T00:00:00.000Z`) : null);
  const since = day(condition.since);
  const until = day(condition.until);
  return {
    from: since ?? new Date('1970-01-01T00:00:00.000Z'),
    to: until ? new Date(until.getTime() + 24 * 3600 * 1000) : new Date('9999-01-01T00:00:00.000Z'),
  };
}

/**
 * The entries the condition picks (contract `docs.material.entries`): the live ones that fit it
 * (`sectionFit`) — a keyword or an anchor path finds them, or, of one of its kinds, one of its topics or
 * projects does — scored 3 per keyword, 2 for a path, 1 for a topic, 1 for a kind, 1 for a project; best
 * first, the newest among equal.
 */
async function pickEntries(db: Reader, ownerId: string, spaceId: string, condition: StoredSessionCondition): Promise<Array<CandidateEntry & { score: number }>> {
  const keywords = conditionKeywords(condition);
  const paths = conditionPaths(condition);
  const topics = [...new Set(condition.topics ?? [])];
  const kinds = [...new Set(condition.entryKinds ?? [])];
  const projects = [...new Set(condition.projects ?? [])];
  if (keywords.length === 0 && paths.length === 0 && topics.length === 0 && projects.length === 0) return [];
  const likes = keywords.map(containsPattern);
  const unders = paths.map(underPattern);
  const byProject = await entriesOfProjects(db, { ownerId, spaceId, projects, kinds });
  const rows = await db.$queryRaw<Array<{
    id: string; kind: string; title: string; summary: string; blob: string; topics: string[]; anchors: unknown;
    currentRevision: number; recordedAt: Date;
  }>>(Prisma.sql`
    SELECT e."id"::text AS "id", e."kind" AS "kind", e."title" AS "title", e."summary" AS "summary",
           e."title" || ' ' || e."summary" || ' ' || e."fields"::text || ' ' || array_to_string(e."aliases", ' ') AS "blob",
           e."topics" AS "topics", e."anchors" AS "anchors", e."current_revision" AS "currentRevision", e."recorded_at" AS "recordedAt"
      FROM "wiki_entry" e
     WHERE e."owner_id" = ${ownerId}::uuid AND e."space_id" = ${spaceId}::uuid
       AND e."status" = 'active' AND e."anchor_state" NOT IN ('changed', 'missing')
       AND ((e."title" || ' ' || e."summary" || ' ' || e."fields"::text || ' ' || array_to_string(e."aliases", ' ')) ILIKE ANY(${likes}::text[])
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e."anchors") = 'array' THEN e."anchors" ELSE '[]'::jsonb END) a
                        WHERE a->>'path' LIKE ANY(${unders}::text[]))
            OR (e."topics" && ${topics}::text[] AND (cardinality(${kinds}::text[]) = 0 OR e."kind" = ANY(${kinds}::text[])))
            OR e."id" = ANY(${byProject}::uuid[]))`);
  const projectsOf = await entryProjects(db, ownerId, rows.map((row) => row.id));
  const scored = rows.map((row) => {
    const fit = sectionFit(condition, {
      id: row.id,
      kind: row.kind,
      blob: row.blob,
      topics: row.topics ?? [],
      anchorPaths: anchorPathsOf(row.anchors),
      projects: projectsOf.get(row.id) ?? new Set<string>(),
    });
    return { ...row, score: fit.score, found: fit.fits };
  });
  return scored
    .filter((row) => row.found)
    .sort((a, b) => b.score - a.score || b.recordedAt.getTime() - a.recordedAt.getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, WIKI_DOC_MATERIAL_RULES.entriesPerSection);
}

/**
 * The owner's own words and their tasks' comments in the condition's projects and window that carry a
 * keyword (contract `docs.material.search`): the most keywords first, the newest among equal.
 */
async function searchRecords(db: Reader, ownerId: string, condition: StoredSessionCondition): Promise<Found[]> {
  const keywords = conditionKeywords(condition);
  const projects = [...new Set(condition.projects ?? [])];
  if (keywords.length === 0 || projects.length === 0) return [];
  const likes = keywords.map(containsPattern);
  const { from, to } = windowOf(condition);
  const turns = await db.$queryRaw<Array<{ id: string; kind: string; sendIntent: string | null; clientTurnId: string; content: string; createdAt: Date }>>(Prisma.sql`
    SELECT t."id"::text AS "id", t."kind" AS "kind", t."send_intent"::text AS "sendIntent", t."client_turn_id" AS "clientTurnId",
           t."content" AS "content", t."created_at" AS "createdAt"
      FROM "conversation_turn" t
     WHERE t."session_id" IN (
             SELECT p."coordinator_session_id" FROM "project" p
              WHERE p."owner_id" = ${ownerId}::uuid AND p."id" = ANY(${projects}::uuid[]) AND p."coordinator_session_id" IS NOT NULL
             UNION
             SELECT s."id" FROM "session" s JOIN "task" k ON k."id" = s."task_id"
              WHERE s."owner_id" = ${ownerId}::uuid AND k."owner_id" = ${ownerId}::uuid AND k."project_id" = ANY(${projects}::uuid[]))
       AND t."kind" IN ('message', 'steer') AND t."created_at" >= ${from} AND t."created_at" < ${to}
       AND char_length(t."content") BETWEEN 2 AND 4000 AND t."content" ILIKE ANY(${likes}::text[])
     ORDER BY t."created_at" DESC
     LIMIT 200`);
  const comments = await db.$queryRaw<Array<{ id: string; authorType: string; body: string; createdAt: Date }>>(Prisma.sql`
    SELECT c."id"::text AS "id", c."author_type"::text AS "authorType", c."body" AS "body", c."created_at" AS "createdAt"
      FROM "task_comment" c JOIN "task" k ON k."id" = c."task_id"
     WHERE k."owner_id" = ${ownerId}::uuid AND k."project_id" = ANY(${projects}::uuid[])
       AND c."created_at" >= ${from} AND c."created_at" < ${to} AND c."body" ILIKE ANY(${likes}::text[])
     ORDER BY c."created_at" DESC
     LIMIT 200`);
  const ranked = <T extends { createdAt: Date }>(rows: T[], text: (row: T) => string): T[] =>
    rows
      .map((row) => ({ row, hits: keywordHits(text(row), keywords) }))
      .sort((a, b) => b.hits - a.hits || b.row.createdAt.getTime() - a.row.createdAt.getTime())
      .map(({ row }) => row);
  const ownerTurns = ranked(turns.filter((turn) => isOwnerTurn(turn)), (turn) => turn.content).slice(0, WIKI_DOC_MATERIAL_RULES.ownerTurnsPerSection);
  const taken = ranked(comments, (comment) => comment.body).slice(0, WIKI_DOC_MATERIAL_RULES.commentsPerSection);
  return [
    ...ownerTurns.map((turn): Found => ({ kind: 'turn', ref: turn.id, found: 'search', via: null, quote: null })),
    ...taken.map((comment): Found => ({ kind: 'task_comment', ref: comment.id, found: 'search', via: null, quote: null, ownerComment: comment.authorType === 'USER' })),
  ];
}

/** Where `text` (NFC code points) is cut to `rules.excerptChars` around `at`: a third before, the rest after. */
function excerptAround(points: readonly string[], at: number | null): { start: number; end: number } {
  const width = WIKI_DOC_MATERIAL_RULES.excerptChars;
  if (points.length <= width) return { start: 0, end: points.length };
  const centre = at ?? 0;
  const start = Math.max(0, Math.min(centre - Math.floor(width / 3), points.length - width));
  return { start, end: start + width };
}

/** The evidence weight a record is read with (contract `docs.material.weights`). */
function weightOf(kind: WikiDocRecordKind, found: { ownerWords: boolean; text: string; eventType?: string; isError?: boolean; ownerComment?: boolean }): WikiDocMaterialWeight {
  switch (kind) {
    case 'turn':
    case 'approval':
      return found.ownerWords ? 'decision' : 'other';
    case 'owner_decision':
      return 'decision';
    case 'task_comment':
      return found.ownerComment ? 'decision' : 'merge';
    case 'merge_receipt':
      return 'merge';
    case 'tool_call':
      return found.isError ? 'error' : 'output';
    case 'event':
      if (found.eventType === 'error' || found.text.startsWith('The tool reported an error:')) return 'error';
      if (found.eventType === 'tool_result' || found.eventType === 'background_task') return 'output';
      return 'other';
    default:
      return 'other';
  }
}

/**
 * The server's half of one section's material: the entries its condition picks, the records they cite and
 * the ones its projects, window and keywords find, each read, redacted, cut and placed.
 */
export async function gatherDocMaterial(
  db: Reader,
  wiki: Pick<WikiService, 'sourceText'>,
  input: { ownerId: string; spaceId: string; condition: StoredSessionCondition | null; literals: readonly string[] },
): Promise<{ entries: WikiDocMaterialEntry[]; records: WikiDocMaterialRecord[]; unresolved: Array<{ kind: string; ref: string; entryId: string }> }> {
  const { ownerId, spaceId, condition, literals } = input;
  if (!condition) return { entries: [], records: [], unresolved: [] };
  const keywords = conditionKeywords(condition);

  const picked = await pickEntries(db, ownerId, spaceId, condition);
  const found: Found[] = [];
  const unresolved: Array<{ kind: string; ref: string; entryId: string }> = [];
  for (const entry of picked) {
    const sources = await db.wikiSource.findMany({
      where: { ownerId, state: 'live', revision: { entryId: entry.id, revision: entry.currentRevision } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { kind: true, ref: true, locator: true, quote: true },
    });
    let taken = 0;
    for (const source of sources) {
      if (taken >= WIKI_DOC_MATERIAL_RULES.sourcesPerEntry) break;
      if (!RECORD_KINDS.has(source.kind)) continue;
      // A turn cited as "the calling session's own" is stored by its session, with the turn in the locator.
      const locator = (source.locator ?? {}) as Record<string, unknown>;
      const ref = source.kind === 'turn' && typeof locator.turnId === 'string' ? locator.turnId : source.ref;
      taken += 1;
      found.push({
        kind: source.kind as WikiDocRecordKind,
        ref,
        found: 'entry',
        via: { entryId: entry.id, title: entry.title, kind: entry.kind as WikiEntryKind, quote: source.quote },
        quote: source.quote,
      });
    }
  }
  found.push(...(await searchRecords(db, ownerId, condition)));

  // Every record read through the one reader, redacted as a footnote's check reads it; a record met twice, once.
  const reader: WikiPrincipal = { origin: 'maintenance', ownerId, userId: null, sessionId: null, toolCallId: null };
  const seen = new Set<string>();
  const read: Array<{ found: Found; ref: string; text: string; points: string[]; ownerWords: boolean; sessionId: string | null; eventType?: string }> = [];
  for (const item of found) {
    const record = await wiki.sourceText(db as unknown as Prisma.TransactionClient, reader, { kind: item.kind as WikiSourceKind, ref: item.ref }).catch(() => null);
    if (!record || record.text === null) {
      if (item.via) unresolved.push({ kind: item.kind, ref: item.ref, entryId: item.via.entryId });
      continue;
    }
    const key = `${item.kind}:${record.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = redactSecrets(record.text, { literals }).text.normalize('NFC');
    if (text.trim() === '') continue;
    read.push({ found: item, ref: record.ref, text, points: Array.from(text), ownerWords: record.ownerWords, sessionId: record.sessionId, eventType: record.eventType });
  }

  // What each record is in, for the model's header and the page's link: its session, task and project.
  const sessionIds = [...new Set(read.map((item) => item.sessionId).filter((id): id is string => id !== null))];
  const sessions = sessionIds.length === 0 ? [] : await db.session.findMany({
    where: { ownerId, id: { in: sessionIds } },
    select: { id: true, title: true, taskId: true },
  });
  const commentIds = read.filter((item) => item.found.kind === 'task_comment').map((item) => item.ref);
  const comments = commentIds.length === 0 ? [] : await db.taskComment.findMany({
    where: { id: { in: commentIds }, task: { ownerId } },
    select: { id: true, taskId: true, authorType: true, createdAt: true },
  });
  const callIds = read.filter((item) => item.found.kind === 'tool_call').map((item) => item.ref);
  const calls = callIds.length === 0 ? [] : await db.toolCall.findMany({
    where: { id: { in: callIds }, session: { ownerId } },
    select: { id: true, name: true, isError: true, startedAt: true },
  });
  const noteIds = read.filter((item) => item.found.kind === 'note').map((item) => item.ref);
  const notes = noteIds.length === 0 ? [] : await db.wikiNote.findMany({ where: { ownerId, id: { in: noteIds } }, select: { id: true, path: true, createdAt: true } });
  const noteOf = new Map(notes.map((note) => [note.id, note]));
  const taskIds = [...new Set([
    ...sessions.map((session) => session.taskId),
    ...comments.map((comment) => comment.taskId),
    ...read.filter((item) => item.found.kind === 'task').map((item) => item.ref),
  ].filter((id): id is string => typeof id === 'string'))];
  const tasks = taskIds.length === 0 ? [] : await db.task.findMany({ where: { ownerId, id: { in: taskIds } }, select: { id: true, title: true, projectId: true } });
  const projectIds = [...new Set(tasks.map((task) => task.projectId).filter((id): id is string => id !== null))];
  const projects = projectIds.length === 0 ? [] : await db.project.findMany({ where: { ownerId, id: { in: projectIds } }, select: { id: true, title: true } });
  const sessionOf = new Map(sessions.map((session) => [session.id, session]));
  const commentOf = new Map(comments.map((comment) => [comment.id, comment]));
  const callOf = new Map(calls.map((call) => [call.id, call]));
  const taskOf = new Map(tasks.map((task) => [task.id, task]));
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  const turnMeta = read.some((item) => item.found.kind === 'turn' || item.found.kind === 'event')
    ? await db.$queryRaw<Array<{ id: string; label: string; at: Date }>>(Prisma.sql`
        SELECT t."id"::text AS "id", t."kind" AS "label", t."created_at" AS "at" FROM "conversation_turn" t
         WHERE t."id" = ANY(${read.filter((item) => item.found.kind === 'turn').map((item) => item.ref)}::uuid[])
        UNION ALL
        SELECT e."id"::text AS "id", e."type" AS "label", e."created_at" AS "at" FROM "run_event" e
         WHERE e."id" = ANY(${read.filter((item) => item.found.kind === 'event').map((item) => item.ref)}::uuid[])`)
    : [];
  const metaOf = new Map(turnMeta.map((row) => [row.id, row]));

  const records: WikiDocMaterialRecord[] = read.map((item) => {
    const { found: how, points, text } = item;
    // Centred on what found it: the entry source's quote where it stands, else the first keyword.
    let at: number | null = null;
    if (how.quote) at = findQuote(text, how.quote)?.start ?? null;
    if (at === null) {
      const low = text.toLowerCase();
      for (const keyword of keywords) {
        const i = low.indexOf(keyword.toLowerCase());
        if (i >= 0) {
          at = Array.from(text.slice(0, i)).length;
          break;
        }
      }
    }
    const range = excerptAround(points, at);
    const session = item.sessionId ? sessionOf.get(item.sessionId) : undefined;
    const comment = how.kind === 'task_comment' ? commentOf.get(item.ref) : undefined;
    const call = how.kind === 'tool_call' ? callOf.get(item.ref) : undefined;
    const taskId = comment?.taskId ?? session?.taskId ?? (how.kind === 'task' ? item.ref : null) ?? null;
    const task = taskId ? taskOf.get(taskId) : undefined;
    const project = task?.projectId ? projectOf.get(task.projectId) : undefined;
    const meta = metaOf.get(item.ref);
    const note = how.kind === 'note' ? noteOf.get(item.ref) : undefined;
    // A comment is the owner's words when the owner wrote it, however it was found.
    const ownerComment = how.ownerComment === true || comment?.authorType === 'USER';
    const label = meta?.label ?? call?.name ?? comment?.authorType ?? null;
    const at_ = meta?.at ?? call?.startedAt ?? comment?.createdAt ?? note?.createdAt ?? null;
    return {
      kind: how.kind,
      ref: item.ref,
      found: how.found,
      via: how.via,
      weight: weightOf(how.kind, { ownerWords: item.ownerWords, text, eventType: item.eventType, isError: call?.isError, ownerComment }),
      ownerWords: item.ownerWords || ownerComment || how.kind === 'owner_decision',
      label,
      at: at_ ? at_.toISOString() : null,
      sessionId: item.sessionId,
      sessionTitle: session?.title ?? null,
      taskId: task?.id ?? taskId,
      taskTitle: task?.title ?? null,
      projectId: project?.id ?? null,
      projectTitle: project?.title ?? null,
      notePath: note?.path ?? null,
      text: points.slice(range.start, range.end).join(''),
      chars: range,
      length: points.length,
    };
  });
  const entries: WikiDocMaterialEntry[] = picked.map((entry) => ({
    id: entry.id,
    kind: entry.kind as WikiEntryKind,
    title: entry.title,
    summary: entry.summary,
    score: entry.score,
    recordedAt: entry.recordedAt.toISOString(),
  }));
  return { entries, records, unresolved };
}

/** The condition as the read answers it: the plan's own words, its projects named as they stand now. */
export async function conditionView(db: Reader, ownerId: string, condition: StoredSessionCondition | null): Promise<WikiPlanSessionCondition | null> {
  if (!condition) return null;
  const ids = [...new Set(condition.projects ?? [])];
  const projects = ids.length === 0 ? [] : await db.project.findMany({ where: { ownerId, id: { in: ids } }, select: { id: true, title: true } });
  const titles = new Map(projects.map((project) => [project.id, project.title]));
  return {
    projects: ids.map((id) => ({ id, title: titles.get(id) ?? null })),
    since: condition.since ?? null,
    until: condition.until ?? null,
    keywords: condition.keywords ?? [],
    anchorPaths: condition.anchorPaths ?? [],
    entryKinds: (condition.entryKinds ?? []) as WikiPlanSessionCondition['entryKinds'],
    topics: condition.topics ?? [],
    evidence: condition.evidence ?? '',
  };
}
