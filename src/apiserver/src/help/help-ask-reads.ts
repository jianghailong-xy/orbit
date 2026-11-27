import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  NestMiddleware,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Prisma, type Runner } from '@prisma/client';
import { HELP_ASK_READS, type HelpAskRead } from '@orbit/shared';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentRunner } from '../runner-api/current-runner.decorator';
import { RUNNER_CALLER_HEADER } from '../runner-api/runner-link-required';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RUNNER_BEATS, runnerIsOnline, runnerLastBeatAt } from '../runners/runner-presence';
import { legacySessionStatus, LEGACY_STATUS_SELECT, readLandingSettlements } from '../sessions/session-legacy-words';
import { turnStateOf } from '../sessions/session-turn-state';

/**
 * What an Ask may read of the account (docs/mocks/help-center board 02 ②: "machine status and heartbeat, session
 * status, task status, account quota"), and the fence that holds it to that.
 *
 * The four reads are GET /runner/help-ask/<read>, each answered only to an Ask session (`x-orbit-session-id` names a
 * session with `help_ask` set) of the runner's owner, on the runner that asked: an ordinary session reads the account
 * through its own tools, and these doors are for nobody else. Each answers the fewest fields that say the state —
 * names, statuses, times, quota windows — and never a prompt, a transcript, a file, a repository or a key.
 *
 * The fence (`HelpAskRunnerFence`): a call made with the runner credential by a process that is not the runner daemon —
 * `orbit mcp` or the CLI, which name themselves in `x-orbit-runner-caller` — on behalf of an Ask session reaches no
 * runner door but these four. The runner already starts an Ask with nothing else to call (runner-go help_ask.go);
 * this is the server's own refusal, so a runner that got that wrong still could not write.
 */

/** The doors an Ask's tools may call, method and path: the four reads, and nothing else. */
export const HELP_ASK_ALLOWED_RUNNER_ROUTES: ReadonlyArray<{ method: 'GET'; path: string }> = HELP_ASK_READS.map(
  (read) => ({ method: 'GET' as const, path: `/runner/help-ask/${read}` }),
);

/** How many sessions and tasks a read lists, newest first. */
const READ_ROWS = 30;

/** The refusal an Ask's tool gets at any other door. */
export function helpAskReadOnlyRefusal(method: string, path: string): ForbiddenException {
  return new ForbiddenException({
    code: 'HELP_ASK_READ_ONLY',
    message: `An Ask is read-only: it may read machine, session and task status and the account's quota, and nothing else (${method} ${path} refused).`,
  });
}

/** The path a request names below the API prefix: `/api/runner/x` and `/runner/x` are both `/runner/x`. */
export function runnerPathOf(url: string): string | null {
  const path = url.split('?')[0];
  const match = path.match(/^(?:\/api)?(\/runner(?:\/.*)?)$/u);
  return match ? match[1].replace(/\/+$/u, '') || '/runner' : null;
}

/** Whether an Ask may make this call. */
export function helpAskMayCall(method: string, path: string): boolean {
  return HELP_ASK_ALLOWED_RUNNER_ROUTES.some((route) => route.method === method.toUpperCase() && route.path === path);
}

/**
 * Whether a session is an Ask. `help_ask` never changes once the row is written (0850's guard), so an answer once read
 * stays true for the life of the process; the cache holds the last ids asked about, both answers.
 */
@Injectable()
export class HelpAskSessions {
  private readonly known = new Map<string, boolean>();

  constructor(private readonly prisma: PrismaService) {}

  async isAsk(sessionId: string): Promise<boolean> {
    const cached = this.known.get(sessionId);
    if (cached !== undefined) return cached;
    if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return false;
    const rows = await this.prisma.$queryRaw<Array<{ ask: boolean }>>`
      SELECT ("help_ask" IS NOT NULL) AS "ask" FROM "session" WHERE "id" = ${sessionId}::uuid`;
    const ask = rows[0]?.ask === true;
    // A session that does not exist yet answers false, and is not remembered: it may be written a moment later.
    if (rows.length > 0) {
      if (this.known.size >= 10_000) this.known.delete(this.known.keys().next().value as string);
      this.known.set(sessionId, ask);
    }
    return ask;
  }
}

/** The fence, on every /runner route (help-ask.module.ts), after the session header is read as a uuid. */
@Injectable()
export class HelpAskRunnerFence implements NestMiddleware {
  constructor(private readonly sessions: HelpAskSessions) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const caller = req.headers[RUNNER_CALLER_HEADER];
      const sessionId = req.headers['x-orbit-session-id'];
      const path = runnerPathOf(req.originalUrl ?? req.url);
      if (caller && typeof sessionId === 'string' && sessionId !== '' && path
        && !helpAskMayCall(req.method, path) && (await this.sessions.isAsk(sessionId))) {
        throw helpAskReadOnlyRefusal(req.method, path);
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}

/** Machine status and heartbeat: every machine of the account, online or not, and when it was last heard from. */
export async function readMachines(prisma: PrismaService, ownerId: string, now = Date.now()) {
  const runners = await prisma.runner.findMany({
    where: { ownerId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, displayName: true, status: true, ...RUNNER_BEATS, version: true, maxConcurrent: true,
      engines: true,
    },
  });
  return {
    machines: runners.map((runner) => {
      const beat = runnerLastBeatAt(runner);
      return {
        id: runner.id,
        name: runner.displayName || runner.name,
        online: runnerIsOnline(runner, now),
        lastHeartbeatAt: beat ? beat.toISOString() : null,
        secondsSinceHeartbeat: beat ? Math.max(0, Math.round((now - beat.getTime()) / 1000)) : null,
        runnerVersion: runner.version,
        maxConcurrent: runner.maxConcurrent,
        engines: (Array.isArray(runner.engines) ? (runner.engines as Array<Record<string, unknown>>) : []).map((e) => ({
          engine: e.engine, installed: e.installed, signedIn: e.auth,
        })),
      };
    }),
  };
}

/** Session status: the account's newest sessions not in Trash (Asks left out), with where each runs and where it stands. */
export async function readSessions(prisma: PrismaService, ownerId: string) {
  const sessions = await prisma.session.findMany({
    where: { ownerId, deletedAt: null, helpAsk: { equals: Prisma.DbNull } },
    orderBy: [{ updatedAt: 'desc' }],
    take: READ_ROWS,
    select: {
      id: true, title: true, ...LEGACY_STATUS_SELECT, error: true, completedAt: true, createdAt: true, updatedAt: true,
      lastTurnAt: true, engine: true, model: true,
      assignedRunner: { select: { name: true, displayName: true } },
      workspace: { select: { name: true } },
    },
  });
  const landings = await readLandingSettlements(prisma, sessions);
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: legacySessionStatus(s, landings.get(s.id)),
      paused: turnStateOf(s) === 'ABANDONED',
      completed: s.completedAt !== null,
      error: s.error,
      machine: s.assignedRunner ? s.assignedRunner.displayName || s.assignedRunner.name : null,
      workspace: s.workspace?.name ?? null,
      engine: s.engine,
      model: s.model,
      lastActiveAt: (s.lastTurnAt ?? s.createdAt).toISOString(),
    })),
  };
}

/** Task status: the account's newest tasks that have not ended, and the newest that failed. */
export async function readTasks(prisma: PrismaService, ownerId: string) {
  const tasks = await prisma.task.findMany({
    where: { ownerId, status: { in: ['OPEN', 'IN_PROGRESS', 'FAILED'] } },
    orderBy: [{ updatedAt: 'desc' }],
    take: READ_ROWS,
    select: { id: true, title: true, status: true, updatedAt: true, dispatchHold: true, project: { select: { title: true } } },
  });
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      held: t.dispatchHold,
      project: t.project?.title ?? null,
      updatedAt: t.updatedAt.toISOString(),
    })),
  };
}

/** Account quota: each machine's engine quota windows as its last heartbeat reported them. */
export async function readQuota(prisma: PrismaService, ownerId: string) {
  const runners = await prisma.runner.findMany({
    where: { ownerId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: { name: true, displayName: true, planUsage: true, accountPauses: true },
  });
  return {
    machines: runners.map((runner) => ({
      machine: runner.displayName || runner.name,
      planUsage: runner.planUsage ?? null,
      accountPauses: runner.accountPauses ?? null,
    })),
  };
}

/**
 * GET /runner/help-ask/:read — the four reads, to an Ask session of the runner's owner on this runner alone. Any
 * other caller is the 404 of a door that is not there for it.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/help-ask')
export class RunnerHelpAskController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':read')
  async read(
    @CurrentRunner() runner: Runner,
    @Param('read') read: string,
    @Headers('x-orbit-session-id') sessionId?: string,
  ) {
    if (!(HELP_ASK_READS as readonly string[]).includes(read)) throw new NotFoundException('no such help read');
    if (!sessionId || !/^[0-9a-f-]{36}$/iu.test(sessionId)) throw new NotFoundException('these reads answer an Ask session');
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId: runner.ownerId, assignedRunnerId: runner.id, helpAsk: { not: Prisma.DbNull } },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('these reads answer an Ask session');
    switch (read as HelpAskRead) {
      case 'machines': return readMachines(this.prisma, runner.ownerId);
      case 'sessions': return readSessions(this.prisma, runner.ownerId);
      case 'tasks': return readTasks(this.prisma, runner.ownerId);
      case 'quota': return readQuota(this.prisma, runner.ownerId);
    }
  }
}
