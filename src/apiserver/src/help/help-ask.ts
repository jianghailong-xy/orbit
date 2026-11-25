import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatorType, Prisma } from '@prisma/client';
import {
  HELP_ASK_ENGINES,
  HELP_ASK_V1,
  helpAskEngineLabel,
  ORBIT_RELEASE_REPOSITORY_DEFAULT,
  PermissionMode,
  uuidToBase62,
  type HelpAskAdminResult,
  type HelpAskChoices,
  type HelpAskList,
  type HelpAskMachine,
  type HelpAskRow,
  type HelpAskStuck,
  type RunnerEngineHealth,
} from '@orbit/shared';
import type { AuthCredential } from '../common/current-user.decorator';
import { runnerOs } from '../common/runner-platform';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline, runnerLastBeatAt } from '../runners/runner-presence';
import type { CreateSessionDto } from '../sessions/dto';
import type { CreateTaskDto } from '../tasks/dto';
import { TasksService } from '../tasks/tasks.service';
import { TURN_STATE_SELECT } from '../sessions/session-turn-state';
import { helpAskMarkerOf, helpAskOutcome, helpAskTitle, readHelpAskPage } from './help-ask-marker';
import { SessionsService } from '../sessions/sessions.service';

/**
 * The help center's Ask (docs/mocks/help-center board 02 §1–§4; decisions on board 03): a question answered by an
 * ordinary session on one of the person's own machines. Like the wiki chat (docs/wiki-chat-design.md §0), it is not a
 * new runtime: it is made by SessionsService.create, and its title, price, transcript, turns, Trash and phone are a
 * session's. What only an Ask has:
 *
 *   - `session.help_ask` (migration 0850), set in the row's own INSERT and never after: the page it was asked from;
 *   - no workspace: it runs on the machine picked here, in a scratch folder the runner fills with the article
 *     library (runner-go help_ask.go), and it is in no session list (SessionsService.list leaves it out);
 *   - read-only: the runner starts Claude Code with Read, Grep and Glob and the four help reads alone, and the runner
 *     doors refuse an Ask's tools everything else (help-ask-reads.ts);
 *   - no server-side model call (board 03, decision 1): it is titled by its first question, not named by a model.
 *
 * The machine and engine are remembered per person (`user.preferences.helpAsk`), and offered first next time.
 */

/** How many questions Your questions lists. */
export const HELP_ASK_LIST_LIMIT = 100;

const RUNNER_SELECT = {
  id: true,
  name: true,
  displayName: true,
  status: true,
  ...RUNNER_BEATS,
  engines: true,
  capabilities: true,
} satisfies Prisma.RunnerSelect;

type ChoiceRunner = Prisma.RunnerGetPayload<{ select: typeof RUNNER_SELECT }>;

function machineOf(runner: ChoiceRunner, now: number): HelpAskMachine {
  const engines = (Array.isArray(runner.engines) ? (runner.engines as unknown as RunnerEngineHealth[]) : [])
    .filter((health) => health && health.installed && health.auth === 'yes')
    .map((health) => ({
      engine: health.engine,
      label: helpAskEngineLabel(health.engine),
      askable: (HELP_ASK_ENGINES as readonly string[]).includes(health.engine),
      model: null,
    }));
  return {
    id: runner.id,
    name: runner.displayName || runner.name,
    online: runnerIsOnline(runner, now),
    supported: (runner.capabilities ?? []).includes(HELP_ASK_V1),
    engines,
  };
}

function rememberedOf(preferences: Prisma.JsonValue | null | undefined): HelpAskChoices['remembered'] {
  const helpAsk = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as { helpAsk?: unknown }).helpAsk
    : undefined;
  if (!helpAsk || typeof helpAsk !== 'object') return null;
  const { runnerId, engine } = helpAsk as Record<string, unknown>;
  return typeof runnerId === 'string' && typeof engine === 'string' ? { runnerId, engine } : null;
}

@Injectable()
export class HelpAsk {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
  ) {}

  /** GET /api/help/ask/choices: every machine of the person's, online ones first, and the pick remembered. */
  async choices(ownerId: string): Promise<HelpAskChoices> {
    const [runners, user] = await Promise.all([
      this.prisma.runner.findMany({ where: { ownerId }, select: RUNNER_SELECT, orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
      this.prisma.user.findUnique({ where: { id: ownerId }, select: { preferences: true } }),
    ]);
    const now = Date.now();
    const machines = runners.map((runner) => machineOf(runner, now));
    machines.sort((a, b) => Number(b.online) - Number(a.online));
    return { machines, remembered: rememberedOf(user?.preferences) };
  }

  /**
   * POST /api/help/ask: `{ content, runnerId, engine, model?, page? }`. The machine has to be the person's, online,
   * and on a runner that starts an Ask read-only (HELP_ASK_V1); the engine one an Ask runs on, signed in there.
   * Each refusal says what to do, and nothing is made or remembered.
   */
  async create(ownerId: string, body: unknown, credential?: AuthCredential): Promise<{ sessionId: string }> {
    const input = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof input.content !== 'string' || input.content.trim() === '') {
      throw new BadRequestException('content is the question, and it has to say something');
    }
    if (typeof input.runnerId !== 'string' || input.runnerId === '') {
      throw new BadRequestException('runnerId names the machine the question runs on');
    }
    if (typeof input.engine !== 'string' || !(HELP_ASK_ENGINES as readonly string[]).includes(input.engine)) {
      throw new BadRequestException(`engine must be one an Ask runs on read-only: ${HELP_ASK_ENGINES.join(', ')}`);
    }
    if (input.model !== undefined && input.model !== null && typeof input.model !== 'string') {
      throw new BadRequestException('model must be a string');
    }
    const page = readHelpAskPage(input.page);
    const runner = await this.prisma.runner.findFirst({ where: { id: input.runnerId, ownerId }, select: RUNNER_SELECT });
    if (!runner) throw new NotFoundException('no such machine');
    const machine = machineOf(runner, Date.now());
    if (!machine.online) {
      throw new ConflictException({
        code: 'HELP_ASK_MACHINE_OFFLINE',
        message: `${machine.name} is offline, so it cannot answer now. Pick a machine that is online.`,
      });
    }
    if (!machine.supported) {
      throw new ConflictException({
        code: 'HELP_ASK_RUNNER_UPGRADE',
        message: `${machine.name} runs an Orbit runner too old to answer questions read-only. Update it, or pick another machine.`,
      });
    }
    const content = input.content;
    const dto: CreateSessionDto = {
      prompt: content,
      title: helpAskTitle(content),
      assignedRunnerId: runner.id,
      engine: input.engine,
      // What the session reads as; the runner starts an Ask in its own read-only set whatever this says (help_ask.go).
      permissionMode: PermissionMode.DONT_ASK,
      ...(typeof input.model === 'string' && input.model !== '' ? { model: input.model } : {}),
    } as CreateSessionDto;
    const session = await this.sessions.create(ownerId, dto, {
      credential,
      noWorktree: true,
      helpAsk: { page },
    });
    // Remembered once the Ask is made: one statement that merges the key over the preferences as they stand.
    await this.prisma.$executeRaw`
      UPDATE "user"
         SET "preferences" = COALESCE("preferences", '{}'::jsonb)
               || jsonb_build_object('helpAsk', jsonb_build_object('runnerId', ${runner.id}::text, 'engine', ${input.engine}::text))
       WHERE "id" = ${ownerId}::uuid`;
    return { sessionId: session.id };
  }

  /** GET /api/help/ask/sessions (board 02 ④): the person's Asks not in Trash, newest first. */
  async list(ownerId: string): Promise<HelpAskList> {
    const rows = await this.prisma.session.findMany({
      where: { ownerId, helpAsk: { not: Prisma.DbNull }, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HELP_ASK_LIST_LIMIT,
      select: {
        id: true,
        title: true,
        // Where the turn stands (session-turn-state.ts), and with it what "released by a failure" reads
        // (common/session-release.ts).
        ...TURN_STATE_SELECT,
        endReason: true,
        lastTurnOutcome: true,
        engineTurnActive: true,
        costUsd: true,
        createdAt: true,
        helpAsk: true,
        engine: true,
        model: true,
        assignedRunner: { select: { name: true, displayName: true } },
        helpAskAdminRequest: { select: { admin: { select: { name: true } } } },
      },
    });
    return {
      questions: rows.map((row): HelpAskRow => ({
        sessionId: row.id,
        title: row.title,
        origin: helpAskMarkerOf(row.helpAsk)?.page?.label ?? null,
        // Sent to an admin, it is with them — unless a follow-up is being answered right now.
        outcome: row.helpAskAdminRequest && helpAskOutcome(row) !== 'working' ? 'with-admin' : helpAskOutcome(row),
        sentTo: row.helpAskAdminRequest?.admin.name ?? null,
        costUsd: row.costUsd,
        createdAt: row.createdAt.toISOString(),
        runner: row.assignedRunner ? row.assignedRunner.displayName || row.assignedRunner.name : null,
        engine: row.engine,
        model: row.model,
      })),
    };
  }

  // ── Still stuck (board 02 ② right frame, side note 5) ─────────────────────────────────────────────────────────

  /** One of the caller's Asks, not in Trash, or the 404 of an Ask that is not there. */
  private async ownAsk(ownerId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId, helpAsk: { not: Prisma.DbNull }, deletedAt: null },
      select: {
        id: true,
        title: true,
        engine: true,
        model: true,
        assignedRunner: { select: { name: true, displayName: true, version: true, capabilities: true, ...RUNNER_BEATS } },
        helpAskAdminRequest: { select: { createdAt: true, taskId: true, admin: { select: { name: true } } } },
      },
    });
    if (!session) throw new NotFoundException('no such question');
    return session;
  }

  /**
   * The admin Ask your admin sends to: the instance's longest-standing enabled administrator other than the caller —
   * none when the caller is an administrator (they are who a question goes to), or when there is no other.
   */
  private async adminFor(ownerId: string): Promise<{ id: string; name: string } | null> {
    const caller = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { role: true } });
    if (!caller || caller.role === 'ADMIN') return null;
    return this.prisma.user.findFirst({
      where: { role: 'ADMIN', disabledAt: null, id: { not: ownerId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
  }

  /** GET /api/help/ask/:id/stuck: who Ask your admin sends to, whether it was sent, and what a report carries. */
  async stuck(ownerId: string, sessionId: string): Promise<HelpAskStuck> {
    const [session, admin, workspaces] = await Promise.all([
      this.ownAsk(ownerId, sessionId),
      this.adminFor(ownerId),
      this.prisma.workspace.findMany({ where: { ownerId }, select: { name: true, workDir: true, repoUrl: true } }),
    ]);
    const runner = session.assignedRunner;
    const sent = session.helpAskAdminRequest;
    return {
      admin: admin ? { name: admin.name } : null,
      sentToAdmin: sent ? { adminName: sent.admin.name, at: sent.createdAt.toISOString() } : null,
      report: {
        repository: releaseRepository(),
        machine: runner
          ? {
              name: runner.displayName || runner.name,
              runnerVersion: runner.version,
              os: runnerOs(runner.capabilities),
              lastHeartbeatAt: runnerLastBeatAt(runner)?.toISOString() ?? null,
            }
          : null,
        privateNames: privateNamesOf(workspaces),
      },
    };
  }

  /**
   * POST /api/help/ask/:id/admin `{ exchanges: [{ question, answer }] }`: Still stuck → Ask your admin. An ordinary
   * task in the admin's own task list — theirs, in no workspace, held until they start it — carrying the question, the
   * answer and a link to the Ask; made through TasksService.create, so it is announced to the admin as every new task
   * is. Once per Ask: asked again, it answers with the task already sent. Refused to an administrator, and when the
   * instance has no other.
   */
  async askAdmin(ownerId: string, sessionId: string, body: unknown): Promise<HelpAskAdminResult> {
    const exchanges = readExchanges(body);
    const session = await this.ownAsk(ownerId, sessionId);
    const already = session.helpAskAdminRequest;
    if (already) {
      return { taskId: already.taskId ?? '', adminName: already.admin.name, at: already.createdAt.toISOString() };
    }
    const admin = await this.adminFor(ownerId);
    if (!admin) {
      throw new ForbiddenException({
        code: 'HELP_ASK_NO_ADMIN',
        message: 'There is no other admin on this Orbit to send the question to.',
      });
    }
    const asker = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { name: true, email: true } });
    const runner = session.assignedRunner;
    const dto = {
      title: helpAskTitle(`Help: ${session.title}`),
      description: adminTaskDescription({
        asker,
        link: `${publicOrigin()}/help/questions/${uuidToBase62(session.id)}`,
        machine: runner ? runner.displayName || runner.name : null,
        engine: session.engine ? helpAskEngineLabel(session.engine) : null,
        exchanges,
      }),
      completionCriterion: 'OWNER_CONFIRMED',
      acceptanceCriteria: `${asker.name} has an answer, or knows what to do next.`,
      autoRunWhenReady: false,
      idempotencyKey: `help-ask-admin:${session.id}`,
    } as CreateTaskDto;
    const task = (await this.tasks.create(admin.id, dto, { type: CreatorType.USER, id: ownerId })) as { id: string };
    // Keyed by the Ask: a second press that raced this one finds the row and writes nothing.
    await this.prisma.helpAskAdminRequest.createMany({
      data: [{ sessionId: session.id, ownerId, adminId: admin.id, taskId: task.id }],
      skipDuplicates: true,
    });
    const row = await this.prisma.helpAskAdminRequest.findUniqueOrThrow({
      where: { sessionId: session.id },
      select: { taskId: true, createdAt: true, admin: { select: { name: true } } },
    });
    return { taskId: row.taskId ?? '', adminName: row.admin.name, at: row.createdAt.toISOString() };
  }
}

/** How many exchanges, and how many characters of each, an admin's task carries. */
const ADMIN_EXCHANGES = 20;
const ADMIN_QUESTION_CHARS = 4_000;
const ADMIN_ANSWER_CHARS = 8_000;

function readExchanges(body: unknown): { question: string; answer: string }[] {
  const list = body && typeof body === 'object' && !Array.isArray(body) ? (body as { exchanges?: unknown }).exchanges : undefined;
  if (!Array.isArray(list) || list.length === 0 || list.length > ADMIN_EXCHANGES) {
    throw new BadRequestException(`exchanges must be the conversation: 1 to ${ADMIN_EXCHANGES} { question, answer }`);
  }
  return list.map((item, i) => {
    const { question, answer } = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof question !== 'string' || question.trim() === '' || question.length > ADMIN_QUESTION_CHARS) {
      throw new BadRequestException(`exchanges[${i}].question must say something, in at most ${ADMIN_QUESTION_CHARS} characters`);
    }
    if (typeof answer !== 'string' || answer.length > ADMIN_ANSWER_CHARS) {
      throw new BadRequestException(`exchanges[${i}].answer must be text of at most ${ADMIN_ANSWER_CHARS} characters`);
    }
    return { question: question.trim(), answer: answer.trim() };
  });
}

/** The admin's task, in their words: who is stuck, where the Ask is, and the conversation. */
export function adminTaskDescription(input: {
  asker: { name: string; email: string };
  link: string;
  machine: string | null;
  engine: string | null;
  exchanges: { question: string; answer: string }[];
}): string {
  const ranOn = [input.machine, input.engine].filter(Boolean).join(' · ');
  const lines = [
    `${input.asker.name} (${input.asker.email}) asked Orbit's help, is still stuck, and sent you the conversation.`,
    '',
    `Ask: ${input.link} (it opens in ${input.asker.name}'s account)`,
    ...(ranOn ? [`Answered on: ${ranOn}`] : []),
  ];
  input.exchanges.forEach((ex, i) => {
    const n = input.exchanges.length > 1 ? ` ${i + 1}` : '';
    lines.push('', `## Question${n}`, '', ex.question, '', `## Answer${n}`, '', ex.answer || '(no answer)');
  });
  return lines.join('\n');
}

/** `owner/repo` on GitHub the instance's release came from: ORBIT_RELEASE_REPOSITORY, else Orbit's own. */
export function releaseRepository(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.ORBIT_RELEASE_REPOSITORY?.trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$|\/+$/gu, '');
  return named && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(named) ? named : ORBIT_RELEASE_REPOSITORY_DEFAULT;
}

function publicOrigin(): string {
  return (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/u, '');
}

/**
 * The words that name the person's code, for a GitHub report to leave out: each workspace's name, its folder's name,
 * and its repository as `owner/repo` and `repo`. Shorter than three characters is not a name a report could be
 * told by, and would cut ordinary words.
 */
export function privateNamesOf(workspaces: { name: string; workDir: string | null; repoUrl: string | null }[]): string[] {
  const names = new Set<string>();
  const add = (value: string | null | undefined) => {
    const v = value?.trim();
    if (v && v.length >= 3) names.add(v);
  };
  for (const ws of workspaces) {
    add(ws.name);
    add(ws.workDir?.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop());
    const repo = ws.repoUrl?.trim().replace(/\.git$/u, '').match(/[:/]([^/:]+)\/([^/:]+)$/u);
    if (repo) {
      add(`${repo[1]}/${repo[2]}`);
      add(repo[2]);
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}
