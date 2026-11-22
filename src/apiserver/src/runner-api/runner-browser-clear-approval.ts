import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { toUuid } from '@orbit/shared';

import type { ManagedRunnerBrowserGate } from '../managed-runners/managed-runner-browser-gate';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The confirmation card browser_clear_logins and `orbit browser clear-logins` ask on (board
 * docs/mocks/runner-browser/03-agent-tools.html ②), and the server's half of it: the same card machinery as
 * runner_delete (runner-delete-approval.ts).
 *
 *   - WHAT IT SAYS IS THE SERVER'S. The asker sends nothing; the card is filed with the account's Orbit Cloud runner
 *     and this copy, read here ({@link browserClearCardInput}). With the browser switch off, or an account without an
 *     Orbit Cloud runner, no card is filed: a yes to it could not be acted on.
 *   - THE CLEAR NEEDS IT. POST /runner/browser/clear goes through only against this card, filed by the asking session,
 *     ALLOWED by a person (a standing rule's allow has no decider and is never given: standingGrantCovers), and not
 *     used before ({@link claimBrowserClearApproval}). A declined card (DENIED) or an expired one (ABANDONED: the call
 *     that asked went away unanswered) sends nothing to the runner.
 *   - ONE YES, ONE CLEAR. Unlike a delete, a clear repeated later would remove logins saved since, which nobody was
 *     asked about, so the card is spent by the clear it allowed.
 *
 * Nothing here names a site: the card says only that every saved login goes.
 */

/** The tool name the runner files the card under. The server matches on it, so both ends spell it alike. */
export const BROWSER_CLEAR_APPROVAL_TOOL_NAME = 'orbit_browser_clear_logins';

/** The card's copy: what the owner is saying yes to. */
export const BROWSER_CLEAR_CARD_TEXT =
  'Clear saved logins on the Orbit Cloud runner: the browser stops, and every saved login on the runner is removed. '
  + 'Every site signed in to there is signed out, for you and for every agent on the runner.';

export const BROWSER_CLEAR_APPROVAL_REQUIRED = 'BROWSER_CLEAR_APPROVAL_REQUIRED';

/** The key the clear writes into the card's input when it spends the card. */
const SPENT_KEY = 'clearRequestedAt';

type Db = Pick<PrismaService, 'managedRunner' | 'runner' | '$queryRaw'>;

/** The account's Orbit Cloud runner, or 404 when it has none. */
export async function accountBrowserRunner(prisma: Db, ownerId: string): Promise<{ id: string; name: string; displayName: string | null }> {
  const managed = await prisma.managedRunner.findUnique({ where: { ownerId }, select: { runnerId: true } });
  const runner = managed
    ? await prisma.runner.findFirst({ where: { id: managed.runnerId, ownerId }, select: { id: true, name: true, displayName: true } })
    : null;
  if (!runner) throw new NotFoundException('This account has no Orbit Cloud runner, so there is no browser and no saved logins to clear');
  return runner;
}

/**
 * The input the card is stored with — the server's own — or null for every other card. Refused before it is filed
 * with the browser switch off (404, as for a tool that does not exist) or without an Orbit Cloud runner.
 */
export async function browserClearCardInput(
  prisma: Db,
  gate: Pick<ManagedRunnerBrowserGate, 'enabled'> | undefined,
  ownerId: string,
  toolName: string,
): Promise<{ description: string; runnerId: string; runnerName: string } | null> {
  if (toolName !== BROWSER_CLEAR_APPROVAL_TOOL_NAME) return null;
  if (!gate?.enabled) throw new NotFoundException('The Orbit Cloud browser is switched off on this Orbit server');
  const runner = await accountBrowserRunner(prisma, ownerId);
  return { description: BROWSER_CLEAR_CARD_TEXT, runnerId: runner.id, runnerName: runner.displayName || runner.name };
}

/**
 * Spend the card `approvalId` for one clear, or refuse: it must be this card, filed by `sessionId`, ALLOWED by a person,
 * about `runnerId`, and not spent. One statement, so two clears racing on one yes send one request.
 */
export async function claimBrowserClearApproval(
  prisma: Db,
  sessionId: string,
  rawApprovalId: unknown,
  runnerId: string,
): Promise<string> {
  let approvalId: string | null = null;
  try {
    approvalId = typeof rawApprovalId === 'string' && rawApprovalId.trim() ? toUuid(rawApprovalId.trim()) : null;
  } catch {
    approvalId = null;
  }
  const spent = approvalId
    ? await prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE approval
           SET input = input || jsonb_build_object(${SPENT_KEY}::text, to_jsonb(now()))
         WHERE id = ${approvalId}::uuid
           AND session_id = ${sessionId}::uuid
           AND tool_name = ${BROWSER_CLEAR_APPROVAL_TOOL_NAME}
           AND status = 'ALLOWED'
           AND decided_by_id IS NOT NULL
           AND input ->> 'runnerId' = ${runnerId}
           AND NOT (input ? ${SPENT_KEY}::text)
        RETURNING id::text AS id`
    : [];
  if (spent.length === 1) return spent[0].id;
  throw new ForbiddenException({
    code: BROWSER_CLEAR_APPROVAL_REQUIRED,
    message: 'clearing saved logins needs the account owner\'s yes on a confirmation card in this conversation, and this '
      + 'request names no such card (or one that was declined, expired or already used). Ask through '
      + 'browser_clear_logins (orbit browser clear-logins), which puts the card in front of them; nothing was cleared.',
  });
}
