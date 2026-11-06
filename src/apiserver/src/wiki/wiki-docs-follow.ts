import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_DOCS_FOLLOW,
  wikiDocsFollowCardResult,
  wikiDocsFollowSectionResult,
  wikiDocsFollowWaiting,
  type WikiChatRewriteResult,
  type WikiChatSectionRef,
  type WikiDocsFollowFact,
  type WikiDocsFollowReport,
  type WikiDocsFollowWaiting,
  type WikiJobKind,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { readWikiRepoReadiness } from '../wiki-worker/wiki-repo-ops';
import { WikiSystemModelReads } from './wiki-system-model';
import { normalizeRepoUrl } from './wiki.service';

/**
 * The follow job's facts (contracts/wiki.contract.json `docs.follow`; docs/wiki-contract.md §29; design
 * docs/wiki-chat-design.md §8.1): any change that reaches main, and any press of a chat's card, has the wiki follow at
 * once — the sections it touched are written again by the wiki-worker's `docs_follow` job
 * (wiki-worker/wiki-docs-follow-job.ts), without waiting for maintenance to be due.
 *
 * TWO KINDS OF FACT, AND NOTHING ELSE. A press of a card that has Rewrites (C6's Apply, Edit and Try again) calls
 * `followWikiDocsPress` in its own transaction. A merge receipt into main — a session's merge, or a landing line's
 * landing or promotion — is followed once its transaction has committed, by `followWikiDocsAfterReceipts`, which every
 * door that writes such a receipt calls after its commit. There is no clock, no schedule and no sweep (hard constraint
 * 5): with no fact there is no job. A commit pushed to main outside Orbit has no fact; the next follow job or
 * maintenance run compares with main as it then stands and takes it in.
 *
 * ONE QUEUED JOB A SPACE (`docs.follow.queue`). A fact arriving while the space's follow job is queued joins it in one
 * write — its facts appended, its priority raised to the highest it now carries — under the space's row lock, so two
 * facts at once make one job; one arriving while it runs queues the next, which the claim takes once the running one
 * ends (`jobs.onePerSpace`). The same receipt delivered twice, or the receipts a promotion writes for each of its
 * tasks, are one change of main — one range of commits — and are carried once.
 */

/** A press of a card (C6): the card, its chat, its Rewrites and the entries it wrote (contract `docs.follow.triggers.press`). */
export interface WikiDocsFollowPress {
  ownerId: string;
  spaceId: string;
  draftId: string;
  /** The chat's session. */
  chatId: string;
  sections: readonly WikiChatSectionRef[];
  entryIds: readonly string[];
}

/** Where a fact goes: the job it joined or made, and whether it made it. */
export interface WikiDocsFollowQueued {
  jobId: string;
  made: boolean;
}

const COMMIT = /^[0-9a-f]{40}$/u;

/** Whose retries and warnings these are: the follow's, by the operation each names. */
const logger = new Logger('WikiDocsFollow');

/** What a version's reason may name of a title (`wiki_doc_section_version_title_chk`). */
const TITLE_MAX = 500;

function titleOf(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const title = (candidate ?? '').trim();
    if (title !== '') return Array.from(title).slice(0, TITLE_MAX).join('');
  }
  return null;
}

/** The facts of a follow job's input, as its row holds them: anything else is no fact. */
export function wikiDocsFollowFactsOf(input: unknown): WikiDocsFollowFact[] {
  const facts = input !== null && typeof input === 'object' ? (input as { facts?: unknown }).facts : undefined;
  return Array.isArray(facts) ? (facts as WikiDocsFollowFact[]).filter((fact) => fact && (fact.kind === 'press' || fact.kind === 'merge' || fact.kind === 'landing')) : [];
}

/** The priority a fact asks for (contract `docs.follow.priorities`): a press and a chat's merge are the owner's work. */
export function wikiDocsFollowPriority(fact: WikiDocsFollowFact): number {
  const { priorities } = WIKI_DOCS_FOLLOW;
  if (fact.kind === 'press') return priorities.press;
  if (fact.kind === 'merge') return fact.chat ? priorities.chatMerge : priorities.merge;
  return priorities.landing;
}

/** Whether the job's facts already carry this one: the same press, or the same range of commits on main. */
function carries(facts: readonly WikiDocsFollowFact[], fact: WikiDocsFollowFact): boolean {
  return facts.some((one) => (fact.kind === 'press'
    ? one.kind === 'press' && one.draftId === fact.draftId && one.at === fact.at
    : one.kind !== 'press' && one.from === fact.from && one.sha === fact.sha));
}

/**
 * Join a fact to the space's queued follow job, or make one, under the space's row lock (`docs.follow.queue`). A change
 * of main a follow job of the space already carries — queued, running or ended — is not carried again: a receipt
 * delivered twice is one fact. Answers the job, or null when there was nothing to carry.
 */
async function joinFact(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; spaceId: string; fact: WikiDocsFollowFact },
): Promise<WikiDocsFollowQueued | null> {
  const { ownerId, spaceId, fact } = input;
  const space = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`);
  if (space.length === 0) return null;
  if (fact.kind !== 'press') {
    const seen = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT j."id" FROM "wiki_job" j
       WHERE j."space_id" = ${spaceId}::uuid AND j."owner_id" = ${ownerId}::uuid AND j."kind" = ${WIKI_DOCS_FOLLOW.kind}
         AND j."input" -> 'facts' @> ${JSON.stringify([{ from: fact.from, sha: fact.sha }])}::jsonb
       ORDER BY j."created_at" DESC, j."id" DESC
       LIMIT 1`);
    if (seen.length > 0) return { jobId: seen[0].id, made: false };
  }
  const priority = wikiDocsFollowPriority(fact);
  const [queued] = await tx.$queryRaw<Array<{ id: string; input: unknown }>>(Prisma.sql`
    SELECT j."id", j."input" FROM "wiki_job" j
     WHERE j."space_id" = ${spaceId}::uuid AND j."owner_id" = ${ownerId}::uuid AND j."kind" = ${WIKI_DOCS_FOLLOW.kind}
       AND j."state" = 'queued'
     ORDER BY j."created_at" DESC, j."id" DESC
     LIMIT 1
     FOR UPDATE`);
  if (queued) {
    const facts = wikiDocsFollowFactsOf(queued.input);
    if (!carries(facts, fact)) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "wiki_job"
           SET "input" = ${JSON.stringify({ facts: [...facts, fact] })}::jsonb,
               "priority" = GREATEST("priority", ${priority}),
               "updated_at" = now()
         WHERE "id" = ${queued.id}::uuid AND "state" = 'queued'`);
    }
    return { jobId: queued.id, made: false };
  }
  const id = randomUUID();
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "input", "priority", "state")
    VALUES (${id}::uuid, ${ownerId}::uuid, ${spaceId}::uuid, ${WIKI_DOCS_FOLLOW.kind},
            ${JSON.stringify({ facts: [fact] })}::jsonb, ${priority}, 'queued')`);
  return { jobId: id, made: true };
}

/**
 * A press of a card that has Rewrites (contract `docs.follow.triggers.press`), in the press's own transaction: each of
 * the card's written sections marked stale — `stale_at`, docs.withdrawal's mark — so it is written whatever its
 * fingerprint (`docs.follow.sections.forced`), and the fact joined to the space's follow job at the press's priority.
 *
 * LOCKS, after whatever the press wrote of its entries: the sections' documents FOR NO KEY UPDATE in id order, then the
 * sections, as a document's writer and a verdict's withdrawal take them (entries first, documents after); then the
 * space's row and the job. A space with no confirmed plan writes no document, and none is made for it.
 */
export async function followWikiDocsPress(tx: Prisma.TransactionClient, press: WikiDocsFollowPress): Promise<WikiDocsFollowQueued | null> {
  const { ownerId, spaceId } = press;
  const sections = [...new Map(press.sections.map((s) => [`${s.doc}#${s.key}`, { doc: s.doc, key: s.key }])).values()];
  if (sections.length === 0) return null;
  const confirmed = await tx.wikiPlan.findFirst({ where: { ownerId, spaceId, status: 'confirmed' }, select: { id: true } });
  if (!confirmed) return null;
  const chat = await tx.session.findFirst({ where: { id: press.chatId, ownerId }, select: { title: true } });
  const at = new Date();
  await markWikiDocSectionsStale(tx, { ownerId, spaceId, sections, at });
  return joinFact(tx, {
    ownerId,
    spaceId,
    fact: {
      kind: 'press',
      draftId: press.draftId,
      chatId: press.chatId,
      title: titleOf(chat?.title, 'a chat')!,
      sections,
      entryIds: [...new Set(press.entryIds)],
      at: at.toISOString(),
    },
  });
}

/**
 * Mark written sections stale (docs.withdrawal's mark, contract `docs.follow.sections.forced`): their documents FOR NO
 * KEY UPDATE in id order first, as their writer and a withdrawal take them, then each section not marked already. A
 * section never written has nothing to mark: a follow job writes it anyway; and when every section asked for is marked
 * already, nothing is locked at all. Answers how many it marked.
 */
export async function markWikiDocSectionsStale(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; spaceId: string; sections: readonly WikiChatSectionRef[]; at: Date },
): Promise<number> {
  const slugs = [...new Set(input.sections.map((section) => section.doc))];
  if (slugs.length === 0) return 0;
  const unmarked = await tx.wikiDocSection.findMany({
    where: { ownerId: input.ownerId, staleAt: null, key: { in: [...new Set(input.sections.map((section) => section.key))] }, doc: { spaceId: input.spaceId, slug: { in: slugs } } },
    select: { key: true, doc: { select: { slug: true } } },
  });
  if (!unmarked.some((row) => input.sections.some((section) => section.doc === row.doc.slug && section.key === row.key))) return 0;
  const docs = await tx.$queryRaw<Array<{ id: string; slug: string }>>(Prisma.sql`
    SELECT "id"::text AS "id", "slug" FROM "wiki_doc"
     WHERE "owner_id" = ${input.ownerId}::uuid AND "space_id" = ${input.spaceId}::uuid AND "slug" = ANY(${slugs}::text[])
     ORDER BY "id"
     FOR NO KEY UPDATE`);
  let marked = 0;
  for (const doc of docs) {
    const keys = input.sections.filter((section) => section.doc === doc.slug).map((section) => section.key);
    const written = await tx.wikiDocSection.updateMany({
      where: { ownerId: input.ownerId, docId: doc.id, key: { in: keys }, staleAt: null },
      data: { staleAt: input.at },
    });
    marked += written.count;
  }
  return marked;
}

// ── Merges and landings ─────────────────────────────────────────────────────────────────────────

/** A receipt as the follow reads it. */
interface ReceiptRow {
  id: string;
  ownerId: string;
  sessionId: string;
  taskId: string | null;
  projectId: string | null;
  result: string;
  targetBranch: string;
  targetShaBefore: string | null;
  targetShaAfter: string | null;
  rebaseBaseSha: string | null;
  sourceSha: string;
  detail: unknown;
  createdAt: Date;
}

/** Whether a receipt's target is the repository's main, which the wiki reads (`origin/main`). */
function targetsMain(branch: string): boolean {
  return branch.trim().replace(/^refs\/heads\//u, '').replace(/^origin\//u, '') === 'main';
}

/**
 * The commits a landed receipt put on main, as a range a diff can be asked for: main before it and after it, or —
 * for a door that named neither — the session's own work, from the base it was rebased on to its tip. A receipt that
 * names no range moved nothing that can be followed: an observation, or a check that found the work already there.
 */
function rangeOf(receipt: ReceiptRow): { from: string; sha: string } | null {
  const sha = (value: string | null): string | null => {
    const v = (value ?? '').trim().toLowerCase();
    return COMMIT.test(v) ? v : null;
  };
  const before = sha(receipt.targetShaBefore);
  const after = sha(receipt.targetShaAfter);
  if (before && after && before !== after) return { from: before, sha: after };
  const base = sha(receipt.rebaseBaseSha);
  const tip = sha(receipt.sourceSha);
  if (base && tip && base !== tip) return { from: base, sha: tip };
  return null;
}

/**
 * The fact a committed receipt is, and the spaces it is for (contract `docs.follow.triggers`, `docs.follow.space`): a
 * landed result into main with a range of commits; a session's merge, or — written by an integration job — a landing
 * of a task on a MAIN line or a project's promotion. The spaces are the session owner's whose repository is the
 * receipt's: its session's workspace's, or its project's codebase's, normalized as a space's is.
 */
async function receiptFact(prisma: PrismaService, receipt: ReceiptRow): Promise<{ ownerId: string; fact: WikiDocsFollowFact; spaceIds: string[] } | null> {
  if (receipt.result !== 'MERGED' && receipt.result !== 'ALREADY_MERGED') return null;
  if (!targetsMain(receipt.targetBranch)) return null;
  const range = rangeOf(receipt);
  if (!range) return null;
  const session = await prisma.session.findUnique({
    where: { id: receipt.sessionId },
    select: { ownerId: true, title: true, workspace: { select: { repoUrl: true } } },
  });
  if (!session) return null;
  const ownerId = session.ownerId;
  const detail = (receipt.detail ?? {}) as { source?: unknown; integrationJobId?: unknown };
  const landing = detail.source === 'integration-job';
  let title: string | null;
  if (landing) {
    const job = typeof detail.integrationJobId === 'string'
      ? await prisma.projectIntegrationJob.findUnique({ where: { id: detail.integrationJobId }, select: { kind: true } }).catch(() => null)
      : null;
    const project = receipt.projectId ? await prisma.project.findFirst({ where: { id: receipt.projectId, ownerId }, select: { title: true } }) : null;
    const task = receipt.taskId ? await prisma.task.findFirst({ where: { id: receipt.taskId, ownerId }, select: { title: true } }) : null;
    title = job?.kind === 'LAND_PROMOTION' ? titleOf(project?.title, task?.title, session.title) : titleOf(task?.title, project?.title, session.title);
  } else {
    title = titleOf(session.title);
  }
  const repos = new Set<string>();
  const own = session.workspace?.repoUrl ? normalizeRepoUrl(session.workspace.repoUrl) : null;
  if (own) repos.add(own);
  if (receipt.projectId) {
    const codebases = await prisma.projectCodebase.findMany({ where: { ownerId, projectId: receipt.projectId }, select: { canonicalRepoUrl: true } });
    for (const codebase of codebases) {
      const repo = normalizeRepoUrl(codebase.canonicalRepoUrl);
      if (repo) repos.add(repo);
    }
  }
  if (repos.size === 0) return null;
  // A space with no confirmed plan writes no document, and none is made for it.
  const spaces = await prisma.wikiSpace.findMany({
    where: { ownerId, repoUrlNorm: { in: [...repos] }, plans: { some: { status: 'confirmed' } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (spaces.length === 0) return null;
  const fact: WikiDocsFollowFact = {
    kind: landing ? 'landing' : 'merge',
    receiptId: receipt.id,
    title: titleOf(title, landing ? 'a landing' : 'a session')!,
    from: range.from,
    sha: range.sha,
    chat: !landing && await sessionIsChat(prisma, receipt.sessionId),
    at: receipt.createdAt.toISOString(),
  };
  return { ownerId, fact, spaceIds: spaces.map((space) => space.id) };
}

/** Whether a session is a wiki chat (`session.wiki_chat_space_id`, contract `chat.binding`): its merge is the owner's work. */
async function sessionIsChat(prisma: PrismaService, sessionId: string): Promise<boolean> {
  // Read off the row as a whole so that a build without the chat's column answers no rather than failing.
  const [row] = await prisma.$queryRaw<Array<{ chat: boolean }>>(Prisma.sql`
    SELECT (to_jsonb(s) ->> 'wiki_chat_space_id') IS NOT NULL AS "chat" FROM "session" s WHERE s."id" = ${sessionId}::uuid`);
  return row?.chat === true;
}

/**
 * Follow the receipts a door has just committed (contract `docs.follow.triggers.merge` and `.landing`): each landed one
 * into main joins, or makes, the follow job of each space it is for, in a transaction of its own per space. Called
 * after the receipt's transaction commits — a fact read before it would be a world the receipt is not yet part of —
 * and never raised: the merge is recorded either way, and a fact this could not follow is taken in by the next follow
 * job or maintenance run, which compare with main as it then stands. Answers the jobs it joined or made.
 */
export async function followWikiDocsAfterReceipts(
  prisma: PrismaService,
  receiptIds: ReadonlyArray<string | null | undefined>,
): Promise<WikiDocsFollowQueued[]> {
  const ids = [...new Set(receiptIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return [];
  const queued: WikiDocsFollowQueued[] = [];
  try {
    const receipts = await prisma.sessionMergeReceipt.findMany({
      where: { id: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, ownerId: true, sessionId: true, taskId: true, projectId: true, result: true, targetBranch: true,
        targetShaBefore: true, targetShaAfter: true, rebaseBaseSha: true, sourceSha: true, detail: true, createdAt: true,
      },
    });
    for (const receipt of receipts) {
      const followed = await receiptFact(prisma, receipt as ReceiptRow);
      if (!followed) continue;
      for (const spaceId of followed.spaceIds) {
        const joined = await withTransactionRetry(
          prisma,
          (tx) => joinFact(tx, { ownerId: followed.ownerId, spaceId, fact: followed.fact }),
          loggedRetry(logger, 'wiki.followDocs'),
        );
        if (joined) queued.push(joined);
      }
    }
  } catch (error) {
    logger.warn(`the wiki did not follow receipts ${ids.join(', ')}: ${(error as Error)?.message ?? error}`);
  }
  return queued;
}

/**
 * Follow the landed receipt a session's merge result has just committed (the runner's own merge, `mergeResult`): found
 * after the commit by what the result names — its session, the source tip it put on the target and the target — since
 * the result's transaction writes it without answering its id. Never raised, as `followWikiDocsAfterReceipts`.
 */
export async function followWikiDocsAfterSessionMerge(
  prisma: PrismaService,
  input: { sessionId: string; sourceSha: string; targetBranch: string },
): Promise<WikiDocsFollowQueued[]> {
  let ids: string[] = [];
  try {
    const receipt = await prisma.sessionMergeReceipt.findFirst({
      where: { sessionId: input.sessionId, sourceSha: input.sourceSha, targetBranch: input.targetBranch, result: { in: ['MERGED', 'ALREADY_MERGED'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    ids = receipt ? [receipt.id] : [];
  } catch (error) {
    logger.warn(`the wiki did not follow the merge of session ${input.sessionId}: ${(error as Error)?.message ?? error}`);
  }
  return followWikiDocsAfterReceipts(prisma, ids);
}

// ── The day's budget ────────────────────────────────────────────────────────────────────────────

/** Midnight UTC of the day `now` is in: where the day's budget of a space's follow jobs starts. */
export function wikiDocsFollowDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The sections a space's follow jobs wrote for merges and landings since midnight UTC (contract `docs.follow.daily`):
 * the versions those writes kept, each written for a merge or a landing — a press's are not counted, and a section left
 * unchanged was not written and kept nothing.
 */
export async function wikiDocsFollowSectionsToday(
  db: Pick<PrismaService, '$queryRaw'>,
  input: { ownerId: string; spaceId: string; now: Date },
): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS "n" FROM "wiki_doc_section_version" v
     WHERE v."owner_id" = ${input.ownerId}::uuid AND v."space_id" = ${input.spaceId}::uuid
       AND v."reason" IN ('merge', 'landing') AND v."replaced_at" >= ${wikiDocsFollowDayStart(input.now)}`);
  return row?.n ?? 0;
}

// ── What a card and Activity read ───────────────────────────────────────────────────────────────

/** One section of a card's rewrite (contract `chat.drafts.read`, rewrite.sections), its result null until the job ends. */
export interface WikiDocsFollowRewriteSection {
  doc: string;
  key: string;
  result: 'updated' | 'same' | 'failed' | 'gone' | null;
  changed: number | null;
  versionId: string | null;
}

/** A card's rewrite as its follow job says it (contract `chat.drafts.results`); `where` and `seen` are the card read's. */
export interface WikiDocsFollowRewrite {
  jobId: string;
  result: WikiChatRewriteResult;
  reason: WikiDocsFollowWaiting | null;
  /** The origin/main commit the job writes from, once it named one. */
  sha: string | null;
  sections: WikiDocsFollowRewriteSection[];
  /** When the job ended, for a settled rewrite. */
  settledAt: string | null;
}

interface FollowJobRow {
  id: string;
  state: string;
  waitingFor: string | null;
  input: unknown;
  report: unknown;
  progress: unknown;
  endedAt: Date | null;
}

/**
 * Each card's rewrite (contract `chat.drafts.results`): the newest follow job of the space that carried the card's
 * press, read as rewriting while it is queued with nothing holding it up or runs; waiting, with `docs.follow.waiting`'s
 * reason, while a job that writes documents runs in its space or the System model or the runner it reads through is
 * not there; and once it has ended, each of the card's sections as its report says, and the card as the first of
 * failed, same, updated and gone that one of them is. A card no job carried is not in the answer.
 */
export async function readWikiDocsFollowRewrites(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string; draftIds: readonly string[]; now?: Date },
): Promise<Map<string, WikiDocsFollowRewrite>> {
  const out = new Map<string, WikiDocsFollowRewrite>();
  const draftIds = [...new Set(input.draftIds)];
  if (draftIds.length === 0) return out;
  const jobs = await prisma.$queryRaw<FollowJobRow[]>(Prisma.sql`
    SELECT j."id"::text AS "id", j."state", j."waiting_for" AS "waitingFor", j."input", j."report", j."progress", j."ended_at" AS "endedAt"
      FROM "wiki_job" j
     WHERE j."owner_id" = ${input.ownerId}::uuid AND j."space_id" = ${input.spaceId}::uuid AND j."kind" = ${WIKI_DOCS_FOLLOW.kind}
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j."input" -> 'facts') = 'array' THEN j."input" -> 'facts' ELSE '[]'::jsonb END) f
                    WHERE f ->> 'draftId' = ANY(${draftIds}::text[]))
     ORDER BY j."created_at" DESC, j."id" DESC`);
  let holding: { writer: string | null; model: Awaited<ReturnType<WikiSystemModelReads['read']>>['state']; repo: Awaited<ReturnType<typeof readWikiRepoReadiness>>['look'] } | null = null;
  const holdUp = async () => {
    if (holding) return holding;
    const [running] = await prisma.$queryRaw<Array<{ kind: string }>>(Prisma.sql`
      SELECT "kind" FROM "wiki_job"
       WHERE "owner_id" = ${input.ownerId}::uuid AND "space_id" = ${input.spaceId}::uuid AND "state" = 'running'
         AND "kind" = ANY(${[...WIKI_DOCS_FOLLOW.writers]}::text[])
       ORDER BY "started_at" NULLS LAST, "id"
       LIMIT 1`);
    const now = input.now ?? new Date();
    const [model, repo] = await Promise.all([
      new WikiSystemModelReads(prisma).read(now),
      readWikiRepoReadiness(prisma, { ownerId: input.ownerId, spaceId: input.spaceId, now }),
    ]);
    holding = { writer: running?.kind ?? null, model: model.state, repo: repo.look };
    return holding;
  };
  for (const draftId of draftIds) {
    const job = jobs.find((row) => wikiDocsFollowFactsOf(row.input).some((fact) => fact.kind === 'press' && fact.draftId === draftId));
    if (!job) continue;
    const press = wikiDocsFollowFactsOf(job.input).filter((fact) => fact.kind === 'press' && fact.draftId === draftId);
    const asked = [...new Map(press.flatMap((fact) => (fact.kind === 'press' ? fact.sections : [])).map((s) => [`${s.doc}#${s.key}`, s])).values()];
    const progress = (job.progress ?? {}) as { sha?: unknown };
    const report = (job.report ?? null) as Partial<WikiDocsFollowReport> | null;
    if (job.state === 'queued' || job.state === 'running' || job.state === 'waiting') {
      let reason: WikiDocsFollowWaiting | null = null;
      if (job.state !== 'running') {
        const held = await holdUp();
        reason = wikiDocsFollowWaiting({
          state: job.state as 'queued' | 'waiting',
          waitingFor: (job.waitingFor as 'repo' | 'model' | null) ?? null,
          writerRunning: held.writer as WikiJobKind | null,
          model: held.model,
          repo: held.repo,
        });
      }
      out.set(draftId, {
        jobId: job.id,
        result: reason ? 'waiting' : 'rewriting',
        reason,
        sha: typeof progress.sha === 'string' && progress.sha !== '' ? progress.sha : null,
        sections: asked.map((s) => ({ doc: s.doc, key: s.key, result: null, changed: null, versionId: null })),
        settledAt: null,
      });
      continue;
    }
    const reported = Array.isArray(report?.sections) ? report.sections : [];
    const sections = asked.map((s): WikiDocsFollowRewriteSection => {
      const one = reported.find((row) => row.doc === s.doc && row.key === s.key);
      // A job that ended with no word of the section — cancelled, or ended at its retry limit — did not write it.
      if (!one) return { doc: s.doc, key: s.key, result: 'failed', changed: null, versionId: null };
      return { doc: s.doc, key: s.key, result: wikiDocsFollowSectionResult(one), changed: one.changed ?? null, versionId: one.versionId ?? null };
    });
    out.set(draftId, {
      jobId: job.id,
      result: wikiDocsFollowCardResult(sections.map((s) => s.result ?? 'failed')),
      reason: null,
      sha: typeof report?.sha === 'string' && report.sha !== '' ? report.sha : null,
      sections,
      settledAt: job.endedAt?.toISOString() ?? null,
    });
  }
  return out;
}

/**
 * Activity's `left` rows (contract `docs.versions.reads.changes`): each follow job of the space that ended leaving
 * sections for the next maintenance run, newest first, at most `limit`, when it ended and how many it left.
 */
export async function wikiDocsFollowLeftRows(
  db: Pick<PrismaService, '$queryRaw'>,
  input: { ownerId: string; spaceId: string; limit: number },
): Promise<Array<{ kind: 'left'; jobId: string; at: string; left: number }>> {
  const rows = await db.$queryRaw<Array<{ id: string; endedAt: Date; left: number }>>(Prisma.sql`
    SELECT j."id"::text AS "id", j."ended_at" AS "endedAt", (j."report" ->> 'left')::int AS "left"
      FROM "wiki_job" j
     WHERE j."owner_id" = ${input.ownerId}::uuid AND j."space_id" = ${input.spaceId}::uuid AND j."kind" = ${WIKI_DOCS_FOLLOW.kind}
       AND j."state" IN ('succeeded', 'failed') AND j."ended_at" IS NOT NULL
       AND jsonb_typeof(j."report" -> 'left') = 'number' AND (j."report" ->> 'left') ~ '^[1-9][0-9]{0,8}$'
     ORDER BY j."ended_at" DESC, j."id" DESC
     LIMIT ${input.limit}`);
  return rows.map((row) => ({ kind: 'left' as const, jobId: row.id, at: row.endedAt.toISOString(), left: row.left }));
}
