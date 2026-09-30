import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_CURSOR_FACT_KINDS,
  WIKI_CURSOR_OUTCOMES,
  WIKI_MAINTENANCE_HEALTH,
  WIKI_MAINTENANCE_RULES,
  wikiMaintenanceSettings,
  type WikiCursorFactKind,
  type WikiCursorOutcome,
  type WikiCursorState,
  type WikiDossier,
  type WikiDossierBatch,
  type WikiDossierPage,
  type WikiErrorCluster,
  type WikiRefusalCode,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { buildDossier, loadDossierRecords, ownerEnvLiterals, storedDossierSources, type DossierReader } from './wiki-dossier';
import { normalizeRepoUrl, WikiRefusalError } from './wiki.service';

export { isWikiMaintenanceSession, setWikiMaintenance, wikiMaintenanceSpaceOf } from './wiki-maintenance-settings';

/**
 * The Wiki maintenance run's side of the server (design §8.2, contracts/wiki.contract.json
 * `maintenance`, criterion 2): who a maintenance session is, a space's maintenance settings, the
 * cursor and its backlog, and the dossier pages a run reads.
 *
 * WHO. A maintenance session is a session whose task is in its space's hidden «Wiki maintenance»
 * list; `isWikiMaintenanceSession` (wiki-maintenance-settings.ts, re-exported here) is the one test of
 * it, and every route of the door this serves asks it first.
 *
 * THE BACKLOG IS COUNTED, NOT KEPT UP. Every committed fact after the watermark — a session come to
 * rest, a task settled, an approval answered, a merge receipt, a criterion revised — is one, read from
 * the rows themselves whenever the cursor is read. Nothing here subscribes to anything or is injected
 * into the Sessions or Projects services: a fact that commits is in the next count, whether or not an
 * event about it was published, delivered or lost.
 *
 * THE CURSOR ONLY MOVES FORWARD, AND ONLY FOR A RUN THAT SUCCEEDED. A page hands out the position of
 * the last fact it covered as a token; `advanceCursor` moves the watermark to it only when the run says
 * it succeeded, only forward, and only as far as a page has handed out — one compare-and-set on the
 * row. A failed or truncated run moves nothing and is counted as a failure.
 */

// ── Facts, positions and tokens ─────────────────────────────────────────────────────────────────

/** A committed fact's place in the one order facts are read in: its time, then its kind, then its id. */
export interface FactPosition {
  at: Date;
  kind: WikiCursorFactKind;
  ref: string;
}

export interface Fact extends FactPosition {
  /** The session whose dossier the fact is about, when there is one. */
  sessionId: string | null;
}

/** -1, 0 or 1, as `a` comes before, at or after `b`; no position comes before every position. */
export function comparePositions(a: FactPosition | null, b: FactPosition | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const at = a.at.getTime() - b.at.getTime();
  if (at !== 0) return at < 0 ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return 0;
}

const TOKEN_PREFIX = 'wc1.';

/** A position as the opaque token a page hands out and an advance names (contract `maintenance.cursor.token`). */
export function encodeCursorToken(spaceId: string, position: FactPosition | null): string {
  const body = { s: spaceId, p: position ? [position.at.toISOString(), position.kind, position.ref] : null };
  return TOKEN_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** The position a token names, or WIKI_CURSOR_INVALID for one that is not a token of this space. */
export function decodeCursorToken(token: string, spaceId: string): FactPosition | null {
  const invalid = (why: string): never =>
    refuse('WIKI_CURSOR_INVALID', `${why}: a cursor token is what a dossier page of this space handed out, passed on unchanged`);
  const value = token.trim();
  if (!value.startsWith(TOKEN_PREFIX)) invalid('the token is not a cursor token');
  let body: { s?: unknown; p?: unknown };
  try {
    body = JSON.parse(Buffer.from(value.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8')) as typeof body;
  } catch {
    return invalid('the token does not decode');
  }
  if (typeof body.s !== 'string' || body.s.toLowerCase() !== spaceId.toLowerCase()) invalid('the token is another space\'s');
  if (body.p === null) return null;
  if (!Array.isArray(body.p) || body.p.length !== 3) return invalid('the token names no position');
  const [at, kind, ref] = body.p as unknown[];
  const when = typeof at === 'string' ? new Date(at) : new Date(Number.NaN);
  if (Number.isNaN(when.getTime()) || typeof ref !== 'string' || ref === ''
    || !(WIKI_CURSOR_FACT_KINDS as readonly unknown[]).includes(kind)) {
    return invalid('the token names no position');
  }
  return { at: when, kind: kind as WikiCursorFactKind, ref };
}

function refuse(code: WikiRefusalCode, message: string): never {
  throw new WikiRefusalError({ code, message });
}

/** Where a space's facts come from: its workspaces, its projects, and the list its own runs are in. */
export interface SpaceScope {
  ownerId: string;
  spaceId: string;
  workspaceIds: string[];
  /** The projects whose task sessions run in the space's workspaces, or whose codebase is its repository. */
  projectIds: string[];
  /**
   * Sessions of the space's workspaces that speak for a project whose work runs elsewhere: a project's
   * coordinator session, or a judgment session its coordinator wake opened, when none of that project's
   * task sessions runs in one of the space's workspaces. They are no fact of the space, and no dossier.
   */
  foreignSessionIds: string[];
  maintenanceListId: string | null;
}

/**
 * The space's scope (contract `maintenance.cursor.scope`).
 *
 * AN ORDINARY SESSION BELONGS TO THE WORKSPACE IT RAN IN, and a space reads the sessions of its bound
 * workspaces. A session that SPEAKS FOR A PROJECT does not: a project's coordinator session and the
 * judgment sessions its wakes open run in the coordinator's workspace, which says where the coordinator
 * was set up and nothing about the codebase the project works on. Such a session belongs to the space
 * only when one of its projects WORKS here: one of the project's task sessions ran in one of the
 * space's workspaces, one of its tasks is assigned to one, or its codebase is the space's repository.
 * A project that says nothing about where it works — no task assigned anywhere, no task that ran
 * anywhere, no codebase — goes by its coordinator's workspace, which is all there is to go by.
 *
 * Why the three and not the first alone: read literally, "its task sessions ran here" leaves out every
 * project whose tasks have not run yet — on 2026-09-28 that was fifteen of orbit's own projects,
 * coordinator conversations full of the owner's decisions, six of them with tasks nobody had assigned.
 * The case the rule is for — a project whose tasks are assigned to, and ran in, another workspace — is
 * left out all the same.
 */
export async function spaceScope(prisma: PrismaService, ownerId: string, spaceId: string): Promise<SpaceScope> {
  const space = await prisma.wikiSpace.findFirst({
    where: { id: spaceId, ownerId },
    select: { id: true, repoUrlNorm: true, settings: true },
  });
  if (!space) throw new NotFoundException('no such wiki space');
  const bindings = await prisma.wikiSpaceWorkspace.findMany({
    where: { spaceId, ownerId },
    select: { workspaceId: true },
    orderBy: { workspaceId: 'asc' },
  });
  const workspaceIds = bindings.map((binding) => binding.workspaceId);
  // A project is the space's when its work runs here — a task session in one of the space's
  // workspaces — or when its codebase is the space's repository (contract `space.binding.projects`),
  // compared through the one normalizer repository identity has.
  const projectIds = new Set<string>();
  if (space.repoUrlNorm) {
    const codebases = await prisma.projectCodebase.findMany({
      where: { ownerId },
      select: { projectId: true, canonicalRepoUrl: true },
    });
    for (const codebase of codebases) {
      if (normalizeRepoUrl(codebase.canonicalRepoUrl) === space.repoUrlNorm) projectIds.add(codebase.projectId);
    }
  }
  let foreignSessionIds: string[] = [];
  if (workspaceIds.length > 0) {
    const working = await prisma.$queryRaw<Array<{ projectId: string }>>`
      SELECT t."project_id"::text AS "projectId"
        FROM "session" s JOIN "task" t ON t."id" = s."task_id"
       WHERE s."owner_id" = ${ownerId}::uuid AND s."workspace_id" = ANY(${workspaceIds}::uuid[]) AND s."deleted_at" IS NULL
         AND t."project_id" IS NOT NULL
      UNION
      SELECT t."project_id"::text
        FROM "task" t
       WHERE t."owner_id" = ${ownerId}::uuid AND t."assignee_id" = ANY(${workspaceIds}::uuid[]) AND t."project_id" IS NOT NULL`;
    for (const row of working) projectIds.add(row.projectId);
    const worksHere = new Set(projectIds);
    // Every session of the space's workspaces that speaks for a project, with the projects it speaks for.
    const speaking = await prisma.$queryRaw<Array<{ sessionId: string; projectId: string }>>`
      SELECT sp."sessionId"::text AS "sessionId", sp."projectId"::text AS "projectId"
        FROM (
          SELECT p."coordinator_session_id" AS "sessionId", p."id" AS "projectId"
            FROM "project" p
           WHERE p."owner_id" = ${ownerId}::uuid AND p."coordinator_session_id" IS NOT NULL
          UNION
          SELECT w."session_id", w."project_id"
            FROM "project_coordinator_wake" w JOIN "project" p ON p."id" = w."project_id"
           WHERE p."owner_id" = ${ownerId}::uuid AND w."session_id" IS NOT NULL
        ) sp
        JOIN "session" s ON s."id" = sp."sessionId"
       WHERE s."workspace_id" = ANY(${workspaceIds}::uuid[])
       ORDER BY 1, 2`;
    const spoken = [...new Set(speaking.map((row) => row.projectId))];
    // Of those projects, the ones that say where they work at all: a task assigned somewhere, a task that
    // ran somewhere, or a codebase. A task with neither says nothing, and neither does a project of them
    // alone. One pass each, joined rather than probed per task: `session` has no index on its task.
    const placed = new Set(
      spoken.length === 0 ? [] : (await prisma.$queryRaw<Array<{ projectId: string }>>`
        SELECT t."project_id"::text AS "projectId" FROM "task" t
         WHERE t."project_id" = ANY(${spoken}::uuid[]) AND t."assignee_id" IS NOT NULL
        UNION
        SELECT t."project_id"::text FROM "task" t JOIN "session" s ON s."task_id" = t."id"
         WHERE t."project_id" = ANY(${spoken}::uuid[]) AND s."deleted_at" IS NULL
        UNION
        SELECT pc."project_id"::text FROM "project_codebase" pc WHERE pc."project_id" = ANY(${spoken}::uuid[])`)
        .map((row) => row.projectId),
    );
    // A session is foreign when every project it speaks for works somewhere, and nowhere here.
    const bySession = new Map<string, string[]>();
    for (const row of speaking) bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row.projectId]);
    const foreign = [...bySession.entries()]
      .filter(([, projects]) => projects.every((projectId) => !worksHere.has(projectId) && placed.has(projectId)))
      .map(([sessionId]) => ({ id: sessionId }));
    foreignSessionIds = foreign.map((row) => row.id);
  }
  return {
    ownerId,
    spaceId,
    workspaceIds,
    projectIds: [...projectIds].sort(),
    foreignSessionIds,
    maintenanceListId: wikiMaintenanceSettings((space.settings as Record<string, unknown> | null)?.maintenance).listId,
  };
}

/**
 * The space's committed facts (contract `maintenance.cursor.factKinds`), as one statement over the five
 * sources. Nothing of a maintenance run is among them: its sessions, its tasks, its approvals and its
 * receipts are the run's own work, and counting them would have a run feed its own backlog.
 */
export function factsSql(scope: SpaceScope, from: FactPosition | null): Prisma.Sql {
  const owner = scope.ownerId;
  const list = scope.maintenanceListId;
  const since = from ? from.at.toISOString() : null;
  // A task outside the maintenance list — or no task at all.
  const notMaintenance = (column: Prisma.Sql) =>
    Prisma.sql`(${list}::uuid IS NULL OR ${column} IS NULL OR ${column} <> ${list}::uuid)`;
  const onOrAfter = (column: Prisma.Sql) => (since ? Prisma.sql`AND ${column} >= ${since}::timestamp` : Prisma.empty);
  // A session that speaks for a project whose work runs elsewhere (`SpaceScope.foreignSessionIds`).
  const ours = (column: Prisma.Sql) => Prisma.sql`${column} <> ALL(${scope.foreignSessionIds}::uuid[])`;
  return Prisma.sql`
    SELECT 'session_settled'::text AS "kind", s."id"::text AS "ref", s."id"::text AS "sessionId", s."last_turn_at" AS "at"
      FROM "session" s
      LEFT JOIN "task" t ON t."id" = s."task_id"
     WHERE s."owner_id" = ${owner}::uuid AND s."workspace_id" = ANY(${scope.workspaceIds}::uuid[]) AND s."deleted_at" IS NULL
       AND s."last_turn_at" IS NOT NULL
       AND s."status"::text IN ('AWAITING_INPUT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
       AND ${ours(Prisma.sql`s."id"`)}
       AND ${notMaintenance(Prisma.sql`t."list_id"`)} ${onOrAfter(Prisma.sql`s."last_turn_at"`)}
    UNION ALL
    SELECT 'task_terminal'::text, t."id"::text, l."id"::text, t."updated_at"
      FROM "task" t
      -- The task's newest session in the space's workspaces, if it has one: one join over those
      -- sessions, since the session table has no index of its own on the task a session runs.
      LEFT JOIN (
        SELECT DISTINCT ON (s2."task_id") s2."task_id", s2."id"
          FROM "session" s2
         WHERE s2."owner_id" = ${owner}::uuid AND s2."workspace_id" = ANY(${scope.workspaceIds}::uuid[])
           AND s2."deleted_at" IS NULL AND s2."task_id" IS NOT NULL
         ORDER BY s2."task_id", s2."created_at" DESC, s2."id" DESC
      ) l ON l."task_id" = t."id"
     WHERE t."owner_id" = ${owner}::uuid AND t."status"::text IN ('DONE', 'CANCELLED', 'FAILED')
       AND (t."assignee_id" = ANY(${scope.workspaceIds}::uuid[]) OR l."task_id" IS NOT NULL)
       AND ${notMaintenance(Prisma.sql`t."list_id"`)} ${onOrAfter(Prisma.sql`t."updated_at"`)}
    UNION ALL
    SELECT 'approval_answered'::text, a."id"::text, a."session_id"::text, a."decided_at"
      FROM "approval" a
      JOIN "session" s ON s."id" = a."session_id"
      LEFT JOIN "task" t ON t."id" = s."task_id"
     WHERE s."owner_id" = ${owner}::uuid AND s."workspace_id" = ANY(${scope.workspaceIds}::uuid[]) AND s."deleted_at" IS NULL
       AND a."decided_at" IS NOT NULL AND ${ours(Prisma.sql`s."id"`)}
       AND ((a."tool_name" = 'AskUserQuestion' AND a."status" = 'ALLOWED')
         OR (a."tool_name" = 'ExitPlanMode' AND a."status" IN ('ALLOWED', 'DENIED'))
         OR (a."status" = 'DENIED' AND a."message" IS NOT NULL AND btrim(a."message") <> ''))
       AND ${notMaintenance(Prisma.sql`t."list_id"`)} ${onOrAfter(Prisma.sql`a."decided_at"`)}
    UNION ALL
    SELECT 'merge_receipt'::text, r."id"::text, r."session_id"::text, r."created_at"
      FROM "session_merge_receipt" r
      JOIN "session" s ON s."id" = r."session_id"
      LEFT JOIN "task" t ON t."id" = s."task_id"
     WHERE r."owner_id" = ${owner}::uuid AND s."workspace_id" = ANY(${scope.workspaceIds}::uuid[]) AND s."deleted_at" IS NULL
       AND ${ours(Prisma.sql`s."id"`)}
       AND ${notMaintenance(Prisma.sql`t."list_id"`)} ${onOrAfter(Prisma.sql`r."created_at"`)}
    UNION ALL
    SELECT 'criterion_revised'::text, d."id"::text,
           CASE WHEN p."coordinator_session_id" = ANY(${scope.foreignSessionIds}::uuid[])
                  OR NOT EXISTS (SELECT 1 FROM "session" cs WHERE cs."id" = p."coordinator_session_id"
                                   AND cs."workspace_id" = ANY(${scope.workspaceIds}::uuid[]) AND cs."deleted_at" IS NULL)
                THEN NULL ELSE p."coordinator_session_id"::text END,
           d."updated_at"
      FROM "project_acceptance_criterion_definition" d
      JOIN "project" p ON p."id" = d."project_id"
     WHERE p."owner_id" = ${owner}::uuid AND d."project_id" = ANY(${scope.projectIds}::uuid[])
       ${onOrAfter(Prisma.sql`d."updated_at"`)}`;
}

/** `(at, kind, ref) > from`, or true from the beginning. */
export function afterSql(from: FactPosition | null): Prisma.Sql {
  if (!from) return Prisma.sql`true`;
  return Prisma.sql`(f."at", f."kind", f."ref") > (${from.at.toISOString()}::timestamp, ${from.kind}::text, ${from.ref}::text)`;
}

interface FactRow {
  kind: WikiCursorFactKind;
  ref: string;
  sessionId: string | null;
  at: Date;
}

/** The facts after `from`, up to `until`, oldest first, at most `limit` of them. */
export async function factsAfter(
  reader: DossierReader,
  scope: SpaceScope,
  from: FactPosition | null,
  until: Date,
  limit: number,
): Promise<Fact[]> {
  if (scope.workspaceIds.length === 0 && scope.projectIds.length === 0) return [];
  const rows = await reader.$queryRaw<FactRow[]>`
    SELECT f."kind", f."ref", f."sessionId", f."at"
      FROM (${factsSql(scope, from)}) f
     WHERE ${afterSql(from)} AND f."at" <= ${until.toISOString()}::timestamp
     ORDER BY f."at", f."kind", f."ref"
     LIMIT ${limit}::int`;
  return rows.map((row) => ({ ...row, at: new Date(row.at) }));
}

export interface Backlog {
  backlog: number;
  byKind: Record<WikiCursorFactKind, number>;
  pendingSessions: number;
  oldestPendingAt: Date | null;
}

/** How many facts there are after the watermark — every one of them, however recent. */
export async function countBacklog(reader: DossierReader, scope: SpaceScope, from: FactPosition | null): Promise<Backlog> {
  const byKind = Object.fromEntries(WIKI_CURSOR_FACT_KINDS.map((kind) => [kind, 0])) as Record<WikiCursorFactKind, number>;
  if (scope.workspaceIds.length === 0 && scope.projectIds.length === 0) {
    return { backlog: 0, byKind, pendingSessions: 0, oldestPendingAt: null };
  }
  const rows = await reader.$queryRaw<Array<{ kind: WikiCursorFactKind; facts: number; sessions: number; oldest: Date | null }>>`
    SELECT f."kind", count(*)::int AS "facts", count(DISTINCT f."sessionId")::int AS "sessions", min(f."at") AS "oldest"
      FROM (${factsSql(scope, from)}) f
     WHERE ${afterSql(from)}
     GROUP BY f."kind"`;
  const [distinct] = await reader.$queryRaw<Array<{ sessions: number }>>`
    SELECT count(DISTINCT f."sessionId")::int AS "sessions" FROM (${factsSql(scope, from)}) f WHERE ${afterSql(from)}`;
  let backlog = 0;
  let oldest: Date | null = null;
  for (const row of rows) {
    byKind[row.kind] = row.facts;
    backlog += row.facts;
    const at = row.oldest ? new Date(row.oldest) : null;
    if (at && (!oldest || at < oldest)) oldest = at;
  }
  return { backlog, byKind, pendingSessions: distinct?.sessions ?? 0, oldestPendingAt: oldest };
}

/**
 * A space's backlog after a position, counted from its facts and writing nothing: what the maintenance
 * trigger (criterion 3) and the Wiki home page's status line (criterion 5) can ask without a cursor row.
 */
export async function wikiSpaceBacklog(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  after: FactPosition | null,
): Promise<Backlog> {
  return countBacklog(prisma, await spaceScope(prisma, ownerId, spaceId), after);
}

// ── The cursor row ──────────────────────────────────────────────────────────────────────────────

interface CursorRow {
  id: string;
  positionAt: Date | null;
  positionKind: string | null;
  positionRef: string | null;
  issuedAt: Date | null;
  issuedKind: string | null;
  issuedRef: string | null;
  lastOkAt: Date | null;
  lastRunAt: Date | null;
  lastOutcome: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  heldReason: string | null;
  heldAt: Date | null;
}

const CURSOR_SELECT = {
  id: true,
  positionAt: true,
  positionKind: true,
  positionRef: true,
  issuedAt: true,
  issuedKind: true,
  issuedRef: true,
  lastOkAt: true,
  lastRunAt: true,
  lastOutcome: true,
  consecutiveFailures: true,
  lastError: true,
  heldReason: true,
  heldAt: true,
} satisfies Prisma.WikiCursorSelect;

function positionOf(at: Date | null, kind: string | null, ref: string | null): FactPosition | null {
  return at && kind && ref ? { at, kind: kind as WikiCursorFactKind, ref } : null;
}

/**
 * Which two conditions make a maintenance task due (criterion 3 reads these; nothing here starts one):
 * `rules.backlogThreshold` SESSIONS with a fact after the watermark — design §8.2's «20 个会话», so a
 * session that came to rest with its task settled and its branch merged is one, not three — or the
 * oldest fact after it older than `rules.maxPendingAgeHours`.
 */
export function maintenanceDue(state: { pendingSessions: number; oldestPendingAt: Date | null }, now: Date): { backlog: boolean; age: boolean } {
  const ageMs = WIKI_MAINTENANCE_RULES.maxPendingAgeHours * 3_600_000;
  return {
    backlog: state.pendingSessions >= WIKI_MAINTENANCE_RULES.backlogThreshold,
    age: state.oldestPendingAt !== null && now.getTime() - state.oldestPendingAt.getTime() > ageMs,
  };
}

// ── Pages of dossiers ───────────────────────────────────────────────────────────────────────────

/** The most facts one page reads past its start before it stops and says there is more. */
export const PAGE_FACT_SCAN = 5_000;

/** A task title's template: its digits read as `#` (contract `maintenance.dossier.batchProjects`). */
export function titleTemplate(title: string): string {
  return title.replace(/[0-9]+/g, '#');
}

/**
 * A tool error's signature: the first line of its output with what varies from one occurrence to
 * the next — numbers, hex, paths, quoted text — read as placeholders (contract
 * `maintenance.dossier.errorClusters`).
 */
export function errorSignature(output: string): string {
  const first = output.trim().split('\n', 1)[0] ?? '';
  return first
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<q>')
    .replace(/(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export interface DossierPageOptions {
  after?: string | null;
  /** A cursor token the page does not go past: the position a run's task expects it to reach. */
  until?: string | null;
  limit?: number;
  /** Now, for a spec to hold still; the grace a fact is given to commit is counted back from it. */
  now?: Date;
  graceSeconds?: number;
  /** A budget smaller than the contract's, for a spec. */
  maxTokens?: number;
}

/**
 * One page over facts read oldest first: the facts it covers until it holds `limit` sessions, the
 * sessions they name, and the position of the last one — the page's token. The same walk makes a
 * maintenance task's expected position (wiki-maintenance-run.ts), so a run that pages from the same
 * watermark reaches exactly what its task expects.
 */
export function pageOf(
  facts: readonly Fact[],
  start: FactPosition | null,
  limit: number,
  scanFull: boolean,
): { end: FactPosition | null; sessionIds: string[]; covered: number; more: boolean } {
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  let end: FactPosition | null = start;
  let covered = 0;
  let more = scanFull;
  for (const fact of facts) {
    if (fact.sessionId && !seen.has(fact.sessionId)) {
      if (seen.size >= limit) {
        more = true;
        break;
      }
      seen.add(fact.sessionId);
      sessionIds.push(fact.sessionId);
    }
    end = { at: fact.at, kind: fact.kind, ref: fact.ref };
    covered += 1;
  }
  if (covered < facts.length) more = true;
  return { end, sessionIds, covered, more };
}

export interface CursorAdvanceInput {
  to: string;
  outcome?: WikiCursorOutcome;
  error?: string | null;
}

@Injectable()
export class WikiMaintenance {
  private readonly logger = new Logger(WikiMaintenance.name);

  constructor(
    private readonly prisma: PrismaService,
    // The one notification a failing run sends (contract `maintenance.health.notify`). Best-effort and
    // after the statement, like WikiService's, and defaulted for the same reason: the specs that
    // construct this service by hand do not each have to stub a sender they never read.
    private readonly push: PushService = undefined as unknown as PushService,
  ) {}

  /** The space's cursor row, made the first time anything reads it. */
  private async cursorRow(ownerId: string, spaceId: string): Promise<CursorRow> {
    return this.prisma.wikiCursor.upsert({
      where: { spaceId_source: { spaceId, source: 'facts' } },
      create: { spaceId, ownerId, source: 'facts' },
      update: {},
      select: CURSOR_SELECT,
    });
  }

  /**
   * Where the space's maintenance stands: the watermark, the backlog counted from the facts after it,
   * and the run's health. The count is written back onto the row, which is what a reader that does not
   * count — the Wiki home page's status line — reads.
   */
  async cursorState(ownerId: string, spaceId: string, now: Date = new Date()): Promise<WikiCursorState> {
    const scope = await spaceScope(this.prisma, ownerId, spaceId);
    const row = await this.cursorRow(ownerId, spaceId);
    return this.stateOf(scope, row, now);
  }

  private async stateOf(scope: SpaceScope, row: CursorRow, now: Date): Promise<WikiCursorState> {
    const watermark = positionOf(row.positionAt, row.positionKind, row.positionRef);
    const counted = await countBacklog(this.prisma, scope, watermark);
    const lagSeconds = counted.oldestPendingAt ? Math.max(0, Math.floor((now.getTime() - counted.oldestPendingAt.getTime()) / 1000)) : 0;
    await this.prisma.wikiCursor.updateMany({
      where: { id: row.id },
      data: {
        backlog: counted.backlog,
        pendingSessions: counted.pendingSessions,
        oldestPendingAt: counted.oldestPendingAt,
        lagSeconds,
        countedAt: now,
      },
    });
    return {
      spaceId: scope.spaceId,
      position: watermark ? encodeCursorToken(scope.spaceId, watermark) : null,
      backlog: counted.backlog,
      byKind: counted.byKind,
      pendingSessions: counted.pendingSessions,
      oldestPendingAt: counted.oldestPendingAt?.toISOString() ?? null,
      lagSeconds,
      lastOkAt: row.lastOkAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastOutcome: (row.lastOutcome as WikiCursorOutcome | null) ?? null,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.lastError,
      due: maintenanceDue(counted, now),
      held: row.heldReason && row.heldAt
        ? { reason: row.heldReason as 'daily_limit_reached' | 'review_queue_full', at: row.heldAt.toISOString() }
        : null,
    };
  }

  /**
   * One page of dossiers: the facts after the start — the later of `after` and the watermark — that
   * are at least the grace old, oldest first, until the page holds `limit` sessions. Each session they
   * name gets its dossier, or, for a batch project, a share of the batch's counts; the page's token is
   * the position of the last fact it covered, and its `from` the position it started after — where a run
   * that keeps none of the page leaves the cursor. What it hands out is recorded: the furthest position
   * (what an advance may reach) and each dossier's sources and hash.
   */
  async dossierPage(ownerId: string, spaceId: string, options: DossierPageOptions = {}): Promise<WikiDossierPage> {
    const now = options.now ?? new Date();
    const limit = Math.min(
      WIKI_MAINTENANCE_RULES.pageSessionsMax,
      Math.max(1, Math.floor(options.limit ?? WIKI_MAINTENANCE_RULES.pageSessionsDefault)),
    );
    const scope = await spaceScope(this.prisma, ownerId, spaceId);
    const row = await this.cursorRow(ownerId, spaceId);
    const watermark = positionOf(row.positionAt, row.positionKind, row.positionRef);
    let start = watermark;
    if (options.after) {
      const asked = decodeCursorToken(options.after, spaceId);
      if (comparePositions(asked, start) > 0) start = asked;
    }
    const grace = options.graceSeconds ?? WIKI_MAINTENANCE_RULES.settleGraceSeconds;
    const settled = new Date(now.getTime() - grace * 1000);
    // A page never passes the position its run's task expects (`until`): what is after it is the next
    // run's. The facts before it are read to the grace like any others.
    const stop = options.until ? decodeCursorToken(options.until, spaceId) : null;
    const until = stop && stop.at < settled ? stop.at : settled;
    const scanned = await factsAfter(this.prisma, scope, start, until, PAGE_FACT_SCAN);
    const facts = stop ? scanned.filter((fact) => comparePositions(fact, stop) <= 0) : scanned;
    const { end, sessionIds, covered, more } = pageOf(facts, start, limit, scanned.length === PAGE_FACT_SCAN);

    const literals = await ownerEnvLiterals(this.prisma, ownerId);
    const { batchOf, batches } = await this.batches(ownerId, sessionIds);
    const dossiers: Array<Omit<WikiDossier, 'unchanged'>> = [];
    for (const sessionId of sessionIds) {
      if (batchOf.has(sessionId)) continue;
      const records = await loadDossierRecords(this.prisma, ownerId, sessionId);
      if (!records) continue;
      dossiers.push(await buildDossier(this.prisma, records, { literals, maxTokens: options.maxTokens }));
    }
    const errorClusters = await this.errorClusters(scope, sessionIds, now, literals);

    // What was handed out. The furthest position only ever moves forward, by one compare-and-set.
    const kept = dossiers.length > 0
      ? await this.prisma.wikiDossier.findMany({
        where: { spaceId, sessionId: { in: dossiers.map((dossier) => dossier.sessionId) } },
        select: { sessionId: true, hash: true, pageAt: true, pageKind: true, pageRef: true },
      })
      : [];
    const keptBySession = new Map(kept.map((one) => [one.sessionId, one]));
    const page: WikiDossier[] = dossiers.map((dossier) => {
      const before = keptBySession.get(dossier.sessionId);
      const processed = before !== undefined && before.hash === dossier.hash
        && comparePositions(positionOf(before.pageAt, before.pageKind, before.pageRef), watermark) <= 0;
      return { ...dossier, unchanged: processed };
    });
    if (end) await this.recordIssue(ownerId, spaceId, row.id, end, dossiers);

    return {
      spaceId,
      from: encodeCursorToken(spaceId, start),
      cursor: encodeCursorToken(spaceId, end),
      more,
      facts: covered,
      dossiers: page,
      batches,
      errorClusters,
      state: await this.stateOf(scope, await this.cursorRow(ownerId, spaceId), now),
    };
  }

  /** The furthest position handed out, and each dossier's sources and hash — never its text, nor its spans' words. */
  private async recordIssue(
    ownerId: string,
    spaceId: string,
    cursorId: string,
    end: FactPosition,
    dossiers: ReadonlyArray<Omit<WikiDossier, 'unchanged'>>,
  ): Promise<void> {
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "wiki_cursor"
             SET "issued_at" = ${end.at.toISOString()}::timestamptz, "issued_kind" = ${end.kind}, "issued_ref" = ${end.ref},
                 "updated_at" = now()
           WHERE "id" = ${cursorId}::uuid
             AND ("issued_at" IS NULL
               OR ("issued_at", "issued_kind", "issued_ref") < (${end.at.toISOString()}::timestamptz, ${end.kind}::text, ${end.ref}::text))`;
        for (const dossier of dossiers) {
          const data = {
            hash: dossier.hash,
            sourceIds: storedDossierSources(dossier.sources) as unknown as Prisma.InputJsonValue,
            tokens: dossier.tokens,
            truncated: dossier.truncated,
            pageAt: end.at,
            pageKind: end.kind,
            pageRef: end.ref,
            issuedAt: new Date(),
          };
          await tx.wikiDossier.upsert({
            where: { spaceId_sessionId: { spaceId, sessionId: dossier.sessionId } },
            create: { spaceId, ownerId, sessionId: dossier.sessionId, ...data },
            update: data,
            select: { id: true },
          });
        }
      },
      loggedRetry(this.logger, 'wiki.recordDossierIssue'),
    );
  }

  /**
   * The page's sessions that belong to a batch project, and the batches' counts (contract
   * `maintenance.dossier.batchProjects`). A batch is a title template shared by
   * `rules.batchTemplateMinTasks` or more tasks of one project — or of one list, for a task in no
   * project: FineWeb's 110,000 tasks have seven templates between them, and a dossier each would be
   * the same dossier 110,000 times. Such a session is counted, never extracted.
   */
  private async batches(ownerId: string, sessionIds: readonly string[]): Promise<{ batchOf: Map<string, string>; batches: WikiDossierBatch[] }> {
    const batchOf = new Map<string, string>();
    if (sessionIds.length === 0) return { batchOf, batches: [] };
    const tasks = await this.prisma.$queryRaw<Array<{ sessionId: string; projectId: string | null; listId: string | null; title: string }>>`
      SELECT s."id"::text AS "sessionId", t."project_id"::text AS "projectId", t."list_id"::text AS "listId", t."title"
        FROM "session" s JOIN "task" t ON t."id" = s."task_id"
       WHERE s."id" = ANY(${[...sessionIds]}::uuid[]) AND t."owner_id" = ${ownerId}::uuid
         AND (t."project_id" IS NOT NULL OR t."list_id" IS NOT NULL)`;
    const groups = new Map<string, { projectId: string | null; listId: string | null; template: string; sessions: string[] }>();
    for (const task of tasks) {
      const template = titleTemplate(task.title);
      const key = `${task.projectId ?? ''}|${task.projectId ? '' : task.listId ?? ''}|${template}`;
      const group = groups.get(key) ?? { projectId: task.projectId, listId: task.projectId ? null : task.listId, template, sessions: [] };
      group.sessions.push(task.sessionId);
      groups.set(key, group);
    }
    const batches: WikiDossierBatch[] = [];
    for (const [key, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const statuses = await this.prisma.$queryRaw<Array<{ status: string; tasks: number }>>`
        SELECT t."status"::text AS "status", count(*)::int AS "tasks"
          FROM "task" t
         WHERE t."owner_id" = ${ownerId}::uuid
           AND ${group.projectId ? Prisma.sql`t."project_id" = ${group.projectId}::uuid` : Prisma.sql`t."project_id" IS NULL AND t."list_id" = ${group.listId}::uuid`}
           AND regexp_replace(t."title", '[0-9]+', '#', 'g') = ${group.template}
         GROUP BY t."status"
         ORDER BY t."status"`;
      const total = statuses.reduce((sum, row) => sum + row.tasks, 0);
      if (total < WIKI_MAINTENANCE_RULES.batchTemplateMinTasks) continue;
      for (const sessionId of group.sessions) batchOf.set(sessionId, key);
      const errors = await this.prisma.$queryRaw<Array<{ tool: string; output: string | null }>>`
        SELECT c."name" AS "tool", CASE jsonb_typeof(c."output")
                 WHEN 'string' THEN left(c."output" #>> '{}', 400)
                 WHEN 'array' THEN left((SELECT string_agg(coalesce(x->>'text', ''), E'\\n') FROM jsonb_array_elements(c."output") x), 400)
                 ELSE left(c."output"::text, 400) END AS "output"
          FROM "tool_call" c
         WHERE c."session_id" = ANY(${group.sessions}::uuid[]) AND c."is_error"
         ORDER BY c."id"`;
      const counted = new Map<string, { tool: string; signature: string; count: number }>();
      for (const error of errors) {
        const signature = errorSignature(error.output ?? '');
        const id = `${error.tool}\u0000${signature}`;
        const entry = counted.get(id) ?? { tool: error.tool, signature, count: 0 };
        entry.count += 1;
        counted.set(id, entry);
      }
      batches.push({
        projectId: group.projectId,
        listId: group.listId,
        template: redactSecrets(group.template).text,
        tasks: total,
        byStatus: Object.fromEntries(statuses.map((row) => [row.status, row.tasks])),
        sessions: group.sessions.length,
        errors: [...counted.values()]
          .sort((a, b) => b.count - a.count || (a.tool + a.signature < b.tool + b.signature ? -1 : 1))
          .slice(0, 5)
          .map((entry) => ({ ...entry, signature: redactSecrets(entry.signature).text })),
      });
    }
    return { batchOf, batches };
  }

  /**
   * The tool error signatures `rules.errorClusterMinSessions` or more of the space's recent sessions
   * share, of those this page's sessions are in (contract `maintenance.dossier.errorClusters`).
   */
  private async errorClusters(scope: SpaceScope, sessionIds: readonly string[], now: Date, literals: readonly string[]): Promise<WikiErrorCluster[]> {
    if (sessionIds.length === 0 || scope.workspaceIds.length === 0) return [];
    const since = new Date(now.getTime() - WIKI_MAINTENANCE_RULES.errorClusterLookbackDays * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; sessionId: string; tool: string; output: string | null }>>`
      SELECT c."id"::text AS "id", c."session_id"::text AS "sessionId", c."name" AS "tool", CASE jsonb_typeof(c."output")
                 WHEN 'string' THEN left(c."output" #>> '{}', 400)
                 WHEN 'array' THEN left((SELECT string_agg(coalesce(x->>'text', ''), E'\\n') FROM jsonb_array_elements(c."output") x), 400)
                 ELSE left(c."output"::text, 400) END AS "output"
        FROM "tool_call" c
        JOIN "session" s ON s."id" = c."session_id"
        LEFT JOIN "task" t ON t."id" = s."task_id"
       WHERE s."owner_id" = ${scope.ownerId}::uuid AND s."workspace_id" = ANY(${scope.workspaceIds}::uuid[])
         AND s."deleted_at" IS NULL AND s."last_turn_at" >= ${since.toISOString()}::timestamp
         AND s."id" <> ALL(${scope.foreignSessionIds}::uuid[])
         AND (${scope.maintenanceListId}::uuid IS NULL OR t."list_id" IS NULL OR t."list_id" <> ${scope.maintenanceListId}::uuid)
         AND c."is_error"
       ORDER BY c."id"`;
    const onPage = new Set(sessionIds);
    const clusters = new Map<string, { tool: string; signature: string; sessions: Set<string>; occurrences: number; examples: WikiErrorCluster['examples'] }>();
    for (const row of rows) {
      const text = redactSecrets(row.output ?? '', { literals }).text;
      const signature = errorSignature(text);
      if (!signature) continue;
      const key = `${row.tool}\u0000${signature}`;
      const cluster = clusters.get(key) ?? { tool: row.tool, signature, sessions: new Set<string>(), occurrences: 0, examples: [] };
      cluster.occurrences += 1;
      if (!cluster.sessions.has(row.sessionId) && cluster.examples.length < 3) {
        cluster.examples.push({ toolCallId: row.id, sessionId: row.sessionId, firstLine: text.trim().split('\n', 1)[0]!.slice(0, 240) });
      }
      cluster.sessions.add(row.sessionId);
      clusters.set(key, cluster);
    }
    return [...clusters.values()]
      .filter((cluster) => cluster.sessions.size >= WIKI_MAINTENANCE_RULES.errorClusterMinSessions
        && [...cluster.sessions].some((sessionId) => onPage.has(sessionId)))
      .sort((a, b) => b.sessions.size - a.sessions.size || b.occurrences - a.occurrences
        || (a.tool + a.signature < b.tool + b.signature ? -1 : 1))
      .map((cluster) => ({
        tool: cluster.tool,
        signature: cluster.signature,
        sessions: cluster.sessions.size,
        occurrences: cluster.occurrences,
        examples: cluster.examples,
      }));
  }

  /**
   * A maintenance run reports how it ended (contract `maintenance.cursor.advance`). Only a run that
   * succeeded moves the watermark, only forward, and only as far as a page has handed out; a failed or
   * truncated one moves nothing and is counted as a failure.
   */
  async advanceCursor(
    ownerId: string,
    spaceId: string,
    input: CursorAdvanceInput,
    now: Date = new Date(),
  ): Promise<{ advanced: boolean; outcome: WikiCursorOutcome; state: WikiCursorState }> {
    const outcome = input.outcome ?? 'succeeded';
    if (!(WIKI_CURSOR_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new BadRequestException(`outcome must be one of ${WIKI_CURSOR_OUTCOMES.join(', ')}`);
    }
    const scope = await spaceScope(this.prisma, ownerId, spaceId);
    const row = await this.cursorRow(ownerId, spaceId);

    if (outcome !== 'succeeded') {
      // A run that did not succeed is counted whether or not it got as far as a page: its token, when
      // it names one, is still checked as this space's, and moves nothing either way.
      if (input.to) decodeCursorToken(input.to, spaceId);
      const said = redactSecrets((input.error ?? '').trim()).text.slice(0, 2000).trim();
      const lastError = said || `the run ended ${outcome}`;
      // One statement that counts the failure and reads the count back: of reports racing on the row,
      // each reads a number of its own, so exactly one reads the threshold (contract
      // `maintenance.health.notify`).
      const [counted] = await this.prisma.$queryRaw<Array<{ failures: number }>>`
        UPDATE "wiki_cursor"
           SET "consecutive_failures" = "consecutive_failures" + 1, "last_error" = ${lastError},
               "last_run_at" = ${now.toISOString()}::timestamptz, "last_outcome" = ${outcome}, "updated_at" = now()
         WHERE "id" = ${row.id}::uuid
        RETURNING "consecutive_failures" AS "failures"`;
      if (counted?.failures === WIKI_MAINTENANCE_HEALTH.notifyAfterFailures) {
        await this.announceFailing(ownerId, spaceId, counted.failures, lastError);
      }
      return { advanced: false, outcome, state: await this.stateOf(scope, await this.cursorRow(ownerId, spaceId), now) };
    }

    const target = decodeCursorToken(input.to ?? '', spaceId);
    const issued = positionOf(row.issuedAt, row.issuedKind, row.issuedRef);
    if (target !== null && comparePositions(target, issued) > 0) {
      refuse('WIKI_CURSOR_INVALID', 'the token names a position past every page this space has handed out');
    }
    const watermark = positionOf(row.positionAt, row.positionKind, row.positionRef);
    const order = comparePositions(target, watermark);
    if (order < 0) return this.behind(scope, row, now);
    const success = {
      lastOkAt: now,
      lastRunAt: now,
      lastOutcome: 'succeeded',
      consecutiveFailures: 0,
      lastError: null,
    } as const;
    if (order === 0) {
      await this.prisma.wikiCursor.updateMany({ where: { id: row.id }, data: success });
      return { advanced: false, outcome, state: await this.stateOf(scope, await this.cursorRow(ownerId, spaceId), now) };
    }
    const moved = await this.prisma.$executeRaw`
      UPDATE "wiki_cursor"
         SET "position_at" = ${target!.at.toISOString()}::timestamptz, "position_kind" = ${target!.kind}, "position_ref" = ${target!.ref},
             "last_ok_at" = ${now.toISOString()}::timestamptz, "last_run_at" = ${now.toISOString()}::timestamptz,
             "last_outcome" = 'succeeded', "consecutive_failures" = 0, "last_error" = NULL, "updated_at" = now()
       WHERE "id" = ${row.id}::uuid
         AND ("position_at" IS NULL
           OR ("position_at", "position_kind", "position_ref") < (${target!.at.toISOString()}::timestamptz, ${target!.kind}::text, ${target!.ref}::text))
         AND "issued_at" IS NOT NULL
         AND ("issued_at", "issued_kind", "issued_ref") >= (${target!.at.toISOString()}::timestamptz, ${target!.kind}::text, ${target!.ref}::text)`;
    const after = await this.cursorRow(ownerId, spaceId);
    if (moved === 0) {
      // Another run moved it first: to this very position (a success that moves nothing), or further.
      const now2 = positionOf(after.positionAt, after.positionKind, after.positionRef);
      if (comparePositions(target, now2) < 0) return this.behind(scope, after, now);
      await this.prisma.wikiCursor.updateMany({ where: { id: row.id }, data: success });
      return { advanced: false, outcome, state: await this.stateOf(scope, await this.cursorRow(ownerId, spaceId), now) };
    }
    return { advanced: true, outcome, state: await this.stateOf(scope, after, now) };
  }

  /**
   * The owner's one notification for a streak of failed runs, from the report that made it the
   * threshold. After the statement and best-effort: a title that cannot be read, or a phone that does
   * not ring, leaves the failure recorded all the same.
   */
  private async announceFailing(ownerId: string, spaceId: string, failures: number, lastError: string): Promise<void> {
    try {
      const space = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { title: true } });
      void this.push?.notifyWikiMaintenanceFailing({ ownerId, spaceId, title: space?.title ?? '', failures, lastError });
    } catch (error) {
      this.logger.warn(`the owner was not told of a failing maintenance run: ${(error as Error).message}`);
    }
  }

  private async behind(scope: SpaceScope, row: CursorRow, now: Date): Promise<never> {
    const state = await this.stateOf(scope, row, now);
    const code: WikiRefusalCode = 'WIKI_CURSOR_BEHIND';
    throw new HttpException(
      {
        code,
        message: 'the cursor is already past this token: another run advanced it further, and it only moves forward',
        state,
      },
      HttpStatus.CONFLICT,
    );
  }
}

