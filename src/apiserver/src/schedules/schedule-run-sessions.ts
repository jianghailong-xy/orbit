import { Injectable, NotFoundException } from '@nestjs/common';
import { SessionRunSource } from '@prisma/client';

import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import type { OpenRunSession, ScheduleRunSessionPort } from './schedule-runs.service';

/**
 * The session doors a scheduled run uses, through SessionsService like every other door that opens a session: a
 * run's session is an ordinary session of its workspace, opened by the platform (`promptByOrbit`) with
 * `runSource = SCHEDULE` and `scheduleRunId` in its own INSERT (docs/scheduled-tasks-design.md §6.3).
 */
@Injectable()
export class SessionsScheduleRunPort implements ScheduleRunSessionPort {
  constructor(private readonly sessions: SessionsService) {}

  async open(input: OpenRunSession): Promise<void> {
    await this.sessions.create(
      input.ownerId,
      {
        workspaceId: input.workspaceId,
        title: input.title,
        prompt: input.prompt,
        permissionMode: input.permissionMode,
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
      },
      {
        id: input.sessionId,
        runSource: SessionRunSource.SCHEDULE,
        scheduleRunId: input.scheduleRunId,
        // Not a person's conversation: it must not become the workspace default (workspace-provider.ts).
        openedBy: 'SCHEDULE',
        promptByOrbit: true,
        noWorktree: input.noWorktree,
      },
    );
  }

  async land(ownerId: string, sessionId: string): Promise<void> {
    await this.sessions.mergeToMain(ownerId, sessionId, 'main');
  }

  async interrupt(ownerId: string, sessionId: string): Promise<void> {
    await this.sessions.interrupt(ownerId, sessionId);
  }

  async complete(ownerId: string, sessionId: string): Promise<void> {
    await this.sessions.complete(ownerId, sessionId);
  }

  /**
   * Retire a run's session so it can never run again: its auto-retry cancelled (a FAILED session would otherwise be
   * brought back beside the retry's new one), then ended. A session already ended, or never written, is retired.
   */
  async end(ownerId: string, sessionId: string): Promise<void> {
    try {
      await this.sessions.cancelAutoRetry(ownerId, sessionId);
      await this.sessions.end(ownerId, sessionId);
    } catch (error) {
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) return;
      throw error;
    }
  }
}
