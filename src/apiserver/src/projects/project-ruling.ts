import {
  BadRequestException,
  Logger,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PROJECT_RULING_COORDINATOR_ONLY,
  PROJECT_RULING_LIMITS,
  PROJECT_RULING_QUOTE_NOT_FOUND,
  PROJECT_RULING_SUPERSEDES_NOT_LIVE,
  PROJECT_RULING_TURN_NOT_FOUND,
  type CoordinatorQuestion,
  type ProjectRulingSourceKind,
  type ProjectRulingView,
} from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { isOrbitAuthoredTurnOf } from '../sessions/orbit-authored-turn';

/**
 * Owner rulings as project records (docs/coordinator-handoff-v2-design.md §2, migration 0970).
 *
 * Two ways in. An answered ask_owner question writes one in the answer's own transaction
 * (`autoRulingFromAnswer`). A coordinator records one given in chat (`recordProjectRuling`), and the
 * quote has to be found in that turn's owner text — the same whitespace-normalized substring check
 * the wiki holds a note's citation to. A ruling that replaces another marks it superseded; neither is
 * deleted. Every read and write is held to the project's owner.
 */

const logger = new Logger('ProjectRuling');

/** How many live rulings `project_get` carries at most, oldest first. */
export const PROJECT_RULINGS_READ_MAX = 200;

const RULING_SELECT = {
  id: true,
  projectId: true,
  ruling: true,
  quote: true,
  sourceKind: true,
  sourceId: true,
  recordedBySessionId: true,
  supersededById: true,
  createdAt: true,
} as const;

type RulingRow = Prisma.ProjectRulingGetPayload<{ select: typeof RULING_SELECT }>;

export function projectRulingView(row: RulingRow): ProjectRulingView {
  return {
    id: row.id,
    projectId: row.projectId,
    ruling: row.ruling,
    quote: row.quote,
    sourceKind: row.sourceKind as ProjectRulingSourceKind,
    sourceId: row.sourceId,
    recordedBySessionId: row.recordedBySessionId,
    supersededById: row.supersededById,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The ruling an answered question makes: the question with the chosen option as the ruling, and the
 * owner's own answer as the quote — the text they typed, else the option they picked. Null when the
 * answer names neither (it cannot: the answer door refuses that).
 */
export function autoRulingFromAnswer(
  question: Pick<CoordinatorQuestion, 'question' | 'options'>,
  answer: { option?: number; text?: string },
): { ruling: string; quote: string } | null {
  const label = answer.option !== undefined ? question.options?.[answer.option]?.label?.trim() || null : null;
  const text = answer.text?.trim() || null;
  const quote = text ?? label;
  if (!quote) return null;
  const asked = question.question.trim();
  return { ruling: label ? `${asked} — ${label}` : asked, quote };
}

/** Is this turn the owner's own words? A message or steer that Orbit did not author and no session sent. */
export function isOwnerTextTurn(
  session: { id: string; promptByOrbit: boolean },
  turn: { kind: string; clientTurnId: string; senderSessionId: string | null; content: string | null },
): boolean {
  if (turn.kind !== 'message' && turn.kind !== 'steer') return false;
  if (turn.senderSessionId !== null || turn.content === null) return false;
  return !isOrbitAuthoredTurnOf(session, turn.clientTurnId);
}

/** Whitespace-normalized NFC text, as `wiki.service.ts#normalizeForQuote` reads a citation (kept here rather than
 *  imported, so the projects module does not load the wiki service). */
function normalizeForQuote(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Is the quote in the owner's text, once both are read the way a person reads them? */
export function quoteIsInOwnerText(ownerText: string, quote: string): boolean {
  const needle = normalizeForQuote(quote);
  if (needle.length < PROJECT_RULING_LIMITS.quoteMinChars) return false;
  return normalizeForQuote(ownerText).includes(needle);
}

/** The automatic ruling of an answered question, in the answer's transaction. */
export async function writeAutoRuling(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  itemId: string,
  question: Pick<CoordinatorQuestion, 'question' | 'options'>,
  answer: { option?: number; text?: string },
): Promise<void> {
  const made = autoRulingFromAnswer(question, answer);
  if (!made) return;
  await tx.projectRuling.create({
    data: { ownerId, projectId, ruling: made.ruling, quote: made.quote, sourceKind: 'ASK_OWNER', sourceId: itemId },
    select: { id: true },
  });
}

/** The project's live rulings, oldest first. One statement. */
export async function readLiveRulings(
  db: Pick<PrismaService, 'projectRuling'>,
  ownerId: string,
  projectId: string,
): Promise<ProjectRulingView[]> {
  const rows = await db.projectRuling.findMany({
    where: { ownerId, projectId, supersededById: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PROJECT_RULINGS_READ_MAX,
    select: RULING_SELECT,
  });
  return rows.map(projectRulingView);
}

/**
 * `project_ruling_record`: the project's coordinator records a ruling the owner gave in a turn.
 *
 * Refused unless the caller is the session the project points at as its coordinator; the turn is in
 * a conversation that coordinated this project (the current one, or one handed over from); the turn
 * is the owner's own words; and the quote is in them. `supersedes`, when given, names a live ruling
 * of the same project, which is marked superseded by the new one in the same transaction.
 */
export async function recordProjectRuling(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  actingSessionId: string | undefined,
  body: { ruling: string; quote: string; sourceTurnId: string; supersedes?: string | null },
): Promise<ProjectRulingView> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId },
    select: { coordinatorSessionId: true },
  });
  if (!project) throw new NotFoundException('project not found');
  const acting = actingSessionId?.trim();
  if (!acting || acting !== project.coordinatorSessionId) {
    throw new ForbiddenException({
      code: PROJECT_RULING_COORDINATOR_ONLY,
      message: 'only the conversation coordinating this project may record its owner rulings.',
    });
  }
  const ruling = body.ruling?.trim() ?? '';
  const quote = body.quote?.trim() ?? '';
  if (!ruling || ruling.length > PROJECT_RULING_LIMITS.rulingMaxChars) {
    throw new BadRequestException(`ruling is one sentence of 1 to ${PROJECT_RULING_LIMITS.rulingMaxChars} characters`);
  }
  if (quote.length < PROJECT_RULING_LIMITS.quoteMinChars || quote.length > PROJECT_RULING_LIMITS.quoteMaxChars) {
    throw new BadRequestException(
      `quote is the owner's own words, ${PROJECT_RULING_LIMITS.quoteMinChars} to ${PROJECT_RULING_LIMITS.quoteMaxChars} characters`,
    );
  }

  const turn = await prisma.conversationTurn.findFirst({
    where: { id: body.sourceTurnId, session: { ownerId } },
    select: {
      id: true,
      kind: true,
      clientTurnId: true,
      senderSessionId: true,
      content: true,
      session: { select: { id: true, promptByOrbit: true } },
    },
  });
  const coordinated = turn
    ? turn.session.id === project.coordinatorSessionId
      || (await prisma.coordinatorHandoff.count({
        where: { ownerId, projectId, fromSessionId: turn.session.id, state: 'COMPLETED' },
      })) > 0
    : false;
  if (!turn || !coordinated) {
    throw new NotFoundException({
      code: PROJECT_RULING_TURN_NOT_FOUND,
      message: 'sourceTurnId names no turn of a conversation that coordinated this project.',
    });
  }
  if (!isOwnerTextTurn(turn.session, turn) || !quoteIsInOwnerText(turn.content ?? '', quote)) {
    throw new BadRequestException({
      code: PROJECT_RULING_QUOTE_NOT_FOUND,
      message:
        'the quote is not in that turn\'s owner text. Copy the owner\'s words exactly from the turn they '
        + 'were said in; a turn Orbit or another session wrote is not the owner\'s.',
    });
  }

  const supersedes = body.supersedes?.trim() || null;
  const notLive = (): ConflictException => new ConflictException({
    code: PROJECT_RULING_SUPERSEDES_NOT_LIVE,
    message: 'supersedes names no live ruling of this project.',
  });
  const row = await withTransactionRetry(prisma, async (tx) => {
    if (supersedes) {
      const old = await tx.projectRuling.findFirst({
        where: { id: supersedes, ownerId, projectId, supersededById: null },
        select: { id: true },
      });
      if (!old) throw notLive();
    }
    const created = await tx.projectRuling.create({
      data: {
        ownerId,
        projectId,
        ruling,
        quote,
        sourceKind: 'TURN',
        sourceId: turn.id,
        recordedBySessionId: acting,
      },
      select: RULING_SELECT,
    });
    if (supersedes) {
      const marked = await tx.projectRuling.updateMany({
        where: { id: supersedes, ownerId, projectId, supersededById: null },
        data: { supersededById: created.id },
      });
      if (marked.count === 0) throw notLive();
    }
    return created;
  }, loggedRetry(logger, 'projectRuling.record'));
  return projectRulingView(row);
}
