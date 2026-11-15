import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  HELP_ASK_ENGINES,
  HELP_ASK_V1,
  helpAskEngineLabel,
  PermissionMode,
  type HelpAskChoices,
  type HelpAskList,
  type HelpAskMachine,
  type HelpAskRow,
  type RunnerEngineHealth,
} from '@orbit/shared';
import type { AuthCredential } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import type { CreateSessionDto } from '../sessions/dto';
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
        status: true,
        engineTurnActive: true,
        costUsd: true,
        createdAt: true,
        helpAsk: true,
        engine: true,
        model: true,
        assignedRunner: { select: { name: true, displayName: true } },
      },
    });
    return {
      questions: rows.map((row): HelpAskRow => ({
        sessionId: row.id,
        title: row.title,
        origin: helpAskMarkerOf(row.helpAsk)?.page?.label ?? null,
        outcome: helpAskOutcome(row),
        costUsd: row.costUsd,
        createdAt: row.createdAt.toISOString(),
        runner: row.assignedRunner ? row.assignedRunner.displayName || row.assignedRunner.name : null,
        engine: row.engine,
        model: row.model,
      })),
    };
  }
}
