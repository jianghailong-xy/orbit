import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProjectIntegrationLogEntry, ProjectIntegrationLogPage } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * Check output, as the control plane stores and pages it (docs/project-integration-line-contract.md
 * §2.2 J-T4's output route, §2.9 LS2; design docs/landing-session-design.md §8 phase 3).
 *
 * A v2 runner streams each check's combined output while the check runs. The writer is
 * `receiveIntegrationJobOutput` in `runner-api/integration-job-relay.ts`; this module holds the two
 * reads that serve it — one for the landing session's page (`GET /sessions/:id/landing/log`, the
 * user gate) and one for the runner read's `log` slot (`GET /runner/projects/:id/integration` by
 * `jobId`). Both are the same page: entries in production order, narrowed by the selectors a reader
 * already has, continued by an opaque cursor.
 */

/**
 * How much of one check's output the control plane keeps: the first and last bytes, with the middle
 * dropped. The design's rule is "a cap per check, head and tail kept" (§2.9 LS2); these are the
 * numbers. The end is where a failure says why, which is why the tail is the larger half.
 */
export const INTEGRATION_LOG_HEAD_BYTES = 64 * 1024;
export const INTEGRATION_LOG_TAIL_BYTES = 192 * 1024;
/** The largest chunk one upload may carry. The runner sends 16 KiB; this is the hard ceiling. */
export const INTEGRATION_LOG_MAX_CHUNK_BYTES = 64 * 1024;
/** One page of a log read. */
export const INTEGRATION_LOG_PAGE_SIZE = 100;

/** Where a log read starts: the attempt, and the narrowing a reader already has. */
export interface IntegrationLogSelectors {
  jobId?: string;
  /** The claim generation, from 1. */
  claim?: number;
  /** The round inside that claim, from 1. */
  round?: number;
  /** The check's position in the run, from 1. */
  check?: number;
  /** The continuation a previous page answered with. */
  cursor?: string;
}

/** One stored chunk, as the query returns it before it becomes an entry. */
interface LogRow {
  claim: string;
  round: number;
  checkName: string;
  checkIndex: number;
  seq: number;
  text: string;
  truncatedBytes: number;
  at: Date;
}

/**
 * `GET /runner/projects/:id/integration?jobId=…`'s log slot: the output of one attempt of this
 * project. A job that is not this project's is answered as one that does not exist — the runner read
 * has already established the project and the acting session, so the job is resolved within them.
 */
export async function readProjectIntegrationLog(
  prisma: Pick<PrismaService, 'projectIntegrationJob' | '$queryRaw'>,
  projectId: string,
  jobId: string,
  selectors: IntegrationLogSelectors,
): Promise<ProjectIntegrationLogPage<Date>> {
  const job = await prisma.projectIntegrationJob.findFirst({
    where: { id: jobId, projectId },
    select: { id: true },
  });
  if (!job) throw new NotFoundException('integration job not found');
  return readLogPage(prisma, jobId, selectors);
}

/**
 * `GET /sessions/:id/landing/log`: the output of one attempt of a landing session, or of its newest
 * attempt when the request names none. The caller has established that the session is the reader's;
 * this resolves the landing subject and, if it names one, the job within that subject — so a landing
 * can never read another landing's output, nor a job of another project's.
 *
 * A landing that has not been attempted yet answers an empty page with no job, which is the state a
 * reader shows before the first attempt is claimed.
 */
export async function readLandingIntegrationLog(
  prisma: PrismaService,
  input: { ownerId: string; sessionId: string; selectors: IntegrationLogSelectors },
): Promise<ProjectIntegrationLogPage<Date>> {
  const landing = await prisma.projectLanding.findFirst({
    where: { sessionId: input.sessionId, ownerId: input.ownerId },
    select: { id: true },
  });
  if (!landing) throw new NotFoundException('this session is not a landing session');
  const job = input.selectors.jobId
    ? await prisma.projectIntegrationJob.findFirst({
      where: { id: input.selectors.jobId, landingId: landing.id },
      select: { id: true },
    })
    : await prisma.projectIntegrationJob.findFirst({
      where: { landingId: landing.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  if (input.selectors.jobId && !job) throw new NotFoundException('integration job not found');
  if (!job) return { jobId: null, entries: [], nextCursor: null };
  return readLogPage(prisma, job.id, input.selectors);
}

/**
 * One page of one job's output, in the order it was produced: claim, then round, then the check's
 * position, then the chunk's seq. `limit + 1` is read so "is there another page" needs no second
 * query, and the cursor names the last entry returned.
 */
async function readLogPage(
  prisma: Pick<PrismaService, '$queryRaw'>,
  jobId: string,
  selectors: IntegrationLogSelectors,
): Promise<ProjectIntegrationLogPage<Date>> {
  const cursor = selectors.cursor ? decodeLogCursor(selectors.cursor) : null;
  const narrowed = Prisma.sql`
    ${selectors.claim !== undefined ? Prisma.sql`AND "claim_generation" = ${BigInt(selectors.claim)}` : Prisma.empty}
    ${selectors.round !== undefined ? Prisma.sql`AND "round" = ${selectors.round}` : Prisma.empty}
    ${selectors.check !== undefined ? Prisma.sql`AND "check_index" = ${selectors.check}` : Prisma.empty}
    ${cursor
    ? Prisma.sql`AND ("claim_generation", "round", "check_index", "seq")
                 > (${BigInt(cursor.claim)}::bigint, ${cursor.round}::int, ${cursor.checkIndex}::int, ${cursor.seq}::int)`
    : Prisma.empty}`;
  const rows = await prisma.$queryRaw<LogRow[]>(Prisma.sql`
    SELECT "claim_generation" AS "claim", "round", "check_name" AS "checkName",
           "check_index" AS "checkIndex", "seq", "text", "truncated_bytes" AS "truncatedBytes",
           "created_at" AS "at"
      FROM "project_integration_job_log"
     WHERE "job_id" = ${jobId}::uuid
       ${narrowed}
     ORDER BY "claim_generation" ASC, "round" ASC, "check_index" ASC, "seq" ASC
     LIMIT ${INTEGRATION_LOG_PAGE_SIZE + 1}`);
  const entries = rows.slice(0, INTEGRATION_LOG_PAGE_SIZE).map((row): ProjectIntegrationLogEntry<Date> => ({
    jobId,
    claim: Number(row.claim),
    round: row.round,
    check: { name: row.checkName as 'TASK_ACCEPTANCE' | 'MERGE_CHECK', index: row.checkIndex },
    seq: row.seq,
    text: row.text,
    truncatedBytes: row.truncatedBytes,
    at: row.at,
  }));
  const last = entries.at(-1);
  return {
    jobId,
    entries,
    nextCursor: rows.length > INTEGRATION_LOG_PAGE_SIZE && last ? encodeLogCursor(last) : null,
  };
}

/** The continuation a page answers with: the position of its last entry. Opaque to the caller. */
function encodeLogCursor(entry: ProjectIntegrationLogEntry<Date>): string {
  return Buffer.from(JSON.stringify({
    c: entry.claim, r: entry.round, k: entry.check.index, s: entry.seq,
  }), 'utf8').toString('base64url');
}

/** A cursor this module issued, or a 400 — never a query that silently starts somewhere else. */
function decodeLogCursor(raw: string): { claim: number; round: number; checkIndex: number; seq: number } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    const [claim, round, checkIndex, seq] = [parsed.c, parsed.r, parsed.k, parsed.s];
    if ([claim, round, checkIndex, seq].every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) {
      return {
        claim: claim as number, round: round as number, checkIndex: checkIndex as number, seq: seq as number,
      };
    }
  } catch {
    // The refusal below is the answer for every malformed cursor, whatever its shape.
  }
  throw new BadRequestException('cursor is not one this read issued');
}
