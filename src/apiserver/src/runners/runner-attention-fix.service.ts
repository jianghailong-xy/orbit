import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReportedEngine, RunnerAttentionFixKind, RunnerAttentionFixRequest, RunnerAttentionFixResult } from '@orbit/shared';
import { isReportedEngine } from '../common/runner-engines';
import { sanitizeRunnerSelfUpdate } from '../common/runner-self-update';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { isEngineSignedOut } from '../sessions/engine-signin-preflight';
import { SessionsService } from '../sessions/sessions.service';
import {
  AGENT_FIX_RUNNER_SELECT,
  agentFixesOf,
  agentFixSignedOut,
  attentionFixEntries,
  attentionFixKey,
  attentionFixNeedsEngine,
  attentionFixPrompt,
  entryHolds,
} from './attention-fix';

/** The codes a refusal carries beside its message, so a client can tell them apart without reading prose. */
export const AGENT_FIX_BLOCKED = 'AGENT_FIX_BLOCKED';
export const AGENT_FIX_RUNNING = 'AGENT_FIX_RUNNING';
export const AGENT_FIX_NO_WARNING = 'AGENT_FIX_NO_WARNING';
export const AGENT_FIX_NO_WARNING_MESSAGE = 'This machine no longer reports that warning.';

/**
 * Fix with an agent: POST /runners/:id/attention/:kind/fix (attention-fix.ts holds the rules).
 *
 * One press starts an ordinary session, at once: in the runner's most recently used workspace, pinned to
 * that runner, with the workspace's own defaults — SessionsService.create resolves its engine, model,
 * effort, accounts and permission mode exactly as for a session the owner opens there with no choices —
 * and a first message built from what the runner reports about the warning. Refused, with the line every
 * client shows in place of the button, while the machine is offline, has no workspace, or that
 * workspace's engine is signed out there; refused too while an agent this door started for the same
 * warning is still open. The warning itself leaves only when the runner reports success.
 */
@Injectable()
export class RunnerAttentionFixService {
  private readonly log = new Logger('RunnerAttentionFix');

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async fix(
    ownerId: string,
    runnerId: string,
    kind: RunnerAttentionFixKind,
    body: RunnerAttentionFixRequest | undefined,
  ): Promise<RunnerAttentionFixResult> {
    let engine: ReportedEngine | null = null;
    if (attentionFixNeedsEngine(kind)) {
      if (!isReportedEngine(body?.engine)) throw new BadRequestException('engine is required for this warning');
      engine = body.engine;
    }
    const latest = typeof body?.latest === 'string' && body.latest.trim().length <= 64 ? body.latest.trim() || null : null;
    const nowMs = Date.now();
    const runner = await this.prisma.runner.findFirst({ where: { id: runnerId, ownerId }, select: AGENT_FIX_RUNNER_SELECT });
    if (!runner) throw new NotFoundException('runner not found');

    const where = (await agentFixesOf(this.prisma, ownerId, [runner], nowMs)).get(runner.id)!;
    const key = attentionFixKey(kind, engine);
    const already = where.fixing.find((f) => attentionFixKey(f.kind, f.engine) === key);
    if (already) throw this.running(already.workspaceName, already.sessionId);
    if (where.blocked) {
      throw new ConflictException({ code: AGENT_FIX_BLOCKED, reason: where.blocked.code, message: where.blocked.message });
    }
    const opening = attentionFixPrompt(runner, kind, engine, latest, nowMs, sanitizeRunnerSelfUpdate(runner.selfUpdate));
    if (!opening) throw new ConflictException({ code: AGENT_FIX_NO_WARNING, message: AGENT_FIX_NO_WARNING_MESSAGE });

    // Claim the warning before the session exists, holding the runner row: two presses at once find
    // each other here, and the second is refused. The session is then created WITH the claimed id.
    const sessionId = randomUUID();
    await withTransactionRetry(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ attention_fixes: unknown }>>`
        SELECT "attention_fixes" FROM "runner" WHERE "id" = ${runnerId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
      if (!row) throw new NotFoundException('runner not found');
      const entry = attentionFixEntries(row.attention_fixes).get(key);
      if (await entryHolds(tx, ownerId, entry, nowMs)) {
        const holder = await tx.session.findFirst({ where: { id: entry!.sessionId }, select: { workspace: { select: { name: true } } } });
        throw this.running(holder?.workspace?.name ?? where.workspaceName ?? '', entry!.sessionId);
      }
      const value = JSON.stringify({ sessionId, at: new Date(nowMs).toISOString() });
      await tx.$executeRaw`
        UPDATE "runner"
           SET "attention_fixes" = COALESCE("attention_fixes", '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::jsonb)
         WHERE "id" = ${runnerId}::uuid AND "owner_id" = ${ownerId}::uuid`;
    }, loggedRetry(this.log, 'runners.attentionFix.claim'));

    try {
      await this.sessions.create(
        ownerId,
        { workspaceId: where.workspaceId!, assignedRunnerId: runnerId, prompt: opening.prompt, title: opening.title },
        { id: sessionId },
      );
    } catch (error) {
      await this.release(runnerId, key, sessionId);
      // The create door judges the account the session runs on exactly; say it the way the button does.
      if (isEngineSignedOut(error)) {
        throw new ConflictException({
          code: AGENT_FIX_BLOCKED,
          reason: 'engineSignedOut',
          message: agentFixSignedOut(where.workspaceName!, where.engineName ?? where.engine ?? 'its engine'),
        });
      }
      throw error;
    }
    return { sessionId, workspaceId: where.workspaceId!, workspaceName: where.workspaceName!, title: opening.title };
  }

  private running(workspaceName: string, sessionId: string): ConflictException {
    return new ConflictException({
      code: AGENT_FIX_RUNNING,
      message: `An agent is already fixing this in ${workspaceName}.`,
      sessionId,
    });
  }

  /** Free the warning again after a create that failed: only while it still names this press's session. */
  private async release(runnerId: string, key: string, sessionId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "runner" SET "attention_fixes" = "attention_fixes" - ${key}::text
       WHERE "id" = ${runnerId}::uuid AND "attention_fixes" -> ${key}::text ->> 'sessionId' = ${sessionId}`);
  }
}
