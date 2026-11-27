import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { HelpAskMarker, HelpAskOutcome, HelpAskPage } from '@orbit/shared';
import { isSessionGenerating } from '../common/session-generating';
import { releaseWasFailure, type ReleaseFailureFacts } from '../common/session-release';
import { turnStateOf, type TurnStateFacts } from '../sessions/session-turn-state';

// What `session.help_ask` (migration 0850) holds and how it reads: pure, so the claim (queue.service.ts) and the
// runner doors can read it without the Ask door's module (help-ask.ts).

/** The longest first question kept as the title; the full question is the prompt. */
const TITLE_CHARS = 120;
const PAGE_ROUTE_CHARS = 300;
const PAGE_LABEL_CHARS = 120;
const PAGE_ERRORS = 10;
const PAGE_ERROR_CHARS = 120;

/** An Ask's column, read where a session is told apart as one. */
export function helpAskMarkerOf(value: Prisma.JsonValue | null | undefined): HelpAskMarker | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const page = (value as { page?: unknown }).page;
  try {
    return { page: readHelpAskPage(page) };
  } catch {
    return { page: null };
  }
}

export function readHelpAskPage(value: unknown): HelpAskPage | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('page must be { route, label, errors }');
  const { route, label, errors } = value as Record<string, unknown>;
  if (typeof route !== 'string' || route === '' || route.length > PAGE_ROUTE_CHARS || !route.startsWith('/')) {
    throw new BadRequestException(`page.route must be the app path the question was asked from, at most ${PAGE_ROUTE_CHARS} characters`);
  }
  if (typeof label !== 'string' || label.trim() === '' || label.length > PAGE_LABEL_CHARS) {
    throw new BadRequestException(`page.label must be what the page chip calls the page, at most ${PAGE_LABEL_CHARS} characters`);
  }
  const list = errors ?? [];
  if (!Array.isArray(list) || list.length > PAGE_ERRORS
    || list.some((e) => typeof e !== 'string' || e === '' || e.length > PAGE_ERROR_CHARS)) {
    throw new BadRequestException(`page.errors must be at most ${PAGE_ERRORS} error texts the page shows`);
  }
  return { route, label: label.trim(), errors: list as string[] };
}

/** The first question as a title: one line, at most TITLE_CHARS. */
export function helpAskTitle(content: string): string {
  const line = content.trim().replace(/\s+/gu, ' ');
  return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/** Where an Ask stands, as Your questions says it. */
export function helpAskOutcome(
  session: ReleaseFailureFacts & TurnStateFacts & Parameters<typeof isSessionGenerating>[0],
): HelpAskOutcome {
  // Released by a failure (common/session-release.ts).
  if (releaseWasFailure(session)) return 'failed';
  const turn = turnStateOf(session);
  if (turn === 'QUEUED' || turn === 'IN_FLIGHT' || isSessionGenerating(session)) return 'working';
  return 'answered';
}

