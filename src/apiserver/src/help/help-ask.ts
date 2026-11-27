import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { CreatorType, Prisma } from '@prisma/client';
import {
  ORBIT_RELEASE_REPOSITORY_DEFAULT,
  uuidToBase62,
  type HelpAskAdminResult,
  type HelpAskConversation,
  type HelpAskList,
  type HelpAskMessage,
  type HelpAskRow,
  type HelpAskStatus,
  type HelpAskStuck,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTaskDto } from '../tasks/dto';
import { TasksService } from '../tasks/tasks.service';
import {
  askDeepSeek,
  HELP_ASK_ANSWER_TIMEOUT_MS,
  HelpAskAnswerFailed,
  helpAskCanAnswer,
  helpAskContextPrompt,
  helpAskLibraryPrompt,
} from './help-ask-answer';
import { readMachines, readQuota, readSessions, readTasks } from './help-ask-reads';
import { helpAskTitle, readHelpAskPage } from './help-ask-marker';
import { HelpLibrary } from './help-library';

/**
 * The help center's Ask (docs/mocks/help-center board 02 §1–§4): a conversation answered by the server on its own
 * DeepSeek key, kept in `help_ask_conversation` (migration 1668). The person only sends questions; nothing runs on
 * their machines and nothing is changed.
 *
 * A question is written with the Ask `working`, and answered off the request: the server reads the account (the four
 * reads of help-ask-reads.ts), asks DeepSeek with every article the person may read and the conversation so far, and
 * appends the answer — or the reason there is none — setting the Ask `answered` or `failed`. The clients read the Ask
 * again until it is not working. An answer the process did not live to write reads as failed once
 * HELP_ASK_STALE_MS has passed, and the person can ask again.
 *
 * Asks made before 1668 are sessions (`session.help_ask`); they are not listed here.
 */

/** How many questions Your questions lists. */
export const HELP_ASK_LIST_LIMIT = 100;
/** The longest question, and the most messages an Ask holds (twenty questions and their answers). */
export const HELP_ASK_QUESTION_CHARS = 4_000;
export const HELP_ASK_MAX_MESSAGES = 40;
/** A working Ask not written to for this long lost its answer: the process that was waiting on it ended. */
export const HELP_ASK_STALE_MS = HELP_ASK_ANSWER_TIMEOUT_MS + 30_000;

const STALE_ERROR = 'The answer did not arrive. Ask again.';

const CONVERSATION_SELECT = {
  id: true,
  title: true,
  page: true,
  messages: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  sentToAdminAt: true,
  adminTaskId: true,
  admin: { select: { name: true } },
} satisfies Prisma.HelpAskConversationSelect;

type ConversationRow = Prisma.HelpAskConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>;

function messagesOf(value: Prisma.JsonValue): HelpAskMessage[] {
  return Array.isArray(value) ? (value as unknown as HelpAskMessage[]) : [];
}

/** Where an Ask stands, with a working one the process stopped waiting on read as failed. */
function statusOf(row: Pick<ConversationRow, 'status' | 'updatedAt'>, now: number): HelpAskStatus {
  if (row.status === 'working' && now - row.updatedAt.getTime() > HELP_ASK_STALE_MS) return 'failed';
  return row.status as HelpAskStatus;
}

function readQuestion(body: unknown): string {
  const content = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { content?: unknown }).content : undefined;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new BadRequestException('content is the question, and it has to say something');
  }
  if (content.length > HELP_ASK_QUESTION_CHARS) {
    throw new BadRequestException(`content must be at most ${HELP_ASK_QUESTION_CHARS} characters`);
  }
  return content.trim();
}

function noKey(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'HELP_ASK_NO_KEY',
    message: 'Ask is not available: this Orbit server has no DeepSeek key. An admin sets DEEPSEEK_API_KEY on the server.',
  });
}

@Injectable()
export class HelpAsk {
  private readonly logger = new Logger(HelpAsk.name);
  /** Answers being waited on, for a spec or a shutdown to wait for. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly library: HelpLibrary,
  ) {}

  /** POST /api/help/ask: `{ content, page? }`. Writes the Ask working, starts its answer, and returns its id. */
  async create(ownerId: string, body: unknown): Promise<{ id: string }> {
    const content = readQuestion(body);
    const page = readHelpAskPage((body as { page?: unknown }).page);
    if (!helpAskCanAnswer()) throw noKey();
    const message: HelpAskMessage = { role: 'user', text: content, at: new Date().toISOString() };
    const row = await this.prisma.helpAskConversation.create({
      data: {
        ownerId,
        title: helpAskTitle(content),
        page: page ? (page as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        messages: [message] as unknown as Prisma.InputJsonValue,
        status: 'working',
      },
      select: { id: true },
    });
    this.answerLater(row.id, ownerId);
    return { id: row.id };
  }

  /**
   * POST /api/help/ask/:id/messages: a follow-up. Appended in one statement that also sets the Ask working, and only
   * while it is not already waiting on an answer (or the wait went stale) and has room.
   */
  async followUp(ownerId: string, id: string, body: unknown): Promise<HelpAskConversation> {
    const content = readQuestion(body);
    if (!helpAskCanAnswer()) throw noKey();
    const message: HelpAskMessage = { role: 'user', text: content, at: new Date().toISOString() };
    const stale = new Date(Date.now() - HELP_ASK_STALE_MS);
    const written = await this.prisma.$executeRaw`
      UPDATE "help_ask_conversation"
         SET "messages" = "messages" || jsonb_build_array(${JSON.stringify(message)}::jsonb),
             "status" = 'working',
             "updated_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
         AND ("status" <> 'working' OR "updated_at" < ${stale})
         AND jsonb_array_length("messages") < ${HELP_ASK_MAX_MESSAGES - 1}`;
    if (written === 0) {
      const row = await this.own(ownerId, id);
      if (messagesOf(row.messages).length >= HELP_ASK_MAX_MESSAGES - 1) {
        throw new ConflictException({ code: 'HELP_ASK_FULL', message: 'This Ask is as long as one can be. Start a new question.' });
      }
      throw new ConflictException({ code: 'HELP_ASK_WORKING', message: 'The last question is still being answered.' });
    }
    this.answerLater(id, ownerId);
    return this.get(ownerId, id);
  }

  /** GET /api/help/ask/:id: one of the caller's Asks. */
  async get(ownerId: string, id: string): Promise<HelpAskConversation> {
    const row = await this.own(ownerId, id);
    const status = statusOf(row, Date.now());
    const messages = messagesOf(row.messages);
    // The wait went stale with the question last: say so where the answer would be.
    if (status === 'failed' && row.status === 'working') {
      messages.push({ role: 'assistant', text: '', at: row.updatedAt.toISOString(), error: STALE_ERROR });
    }
    return {
      id: row.id,
      title: row.title,
      page: readPageOrNull(row.page),
      status,
      messages,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** GET /api/help/ask/conversations (board 02 ④): the person's Asks, newest first. */
  async list(ownerId: string): Promise<HelpAskList> {
    const rows = await this.prisma.helpAskConversation.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HELP_ASK_LIST_LIMIT,
      select: CONVERSATION_SELECT,
    });
    const now = Date.now();
    return {
      questions: rows.map((row): HelpAskRow => {
        const status = statusOf(row, now);
        return {
          id: row.id,
          title: row.title,
          origin: readPageOrNull(row.page)?.label ?? null,
          // Sent to an admin, it is with them — unless a follow-up is being answered right now.
          outcome: row.sentToAdminAt && status !== 'working' ? 'with-admin' : status,
          sentTo: row.sentToAdminAt ? row.admin?.name ?? null : null,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  /** Waits for every answer started so far. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private answerLater(id: string, ownerId: string): void {
    const run = this.answer(id, ownerId).catch((error: unknown) => {
      this.logger.error(`Ask ${id}: the answer could not be written: ${(error as Error).message}`);
    });
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** Answer the Ask's last question, and append the answer or why there is none. */
  private async answer(id: string, ownerId: string): Promise<void> {
    const [row, user] = await Promise.all([
      this.prisma.helpAskConversation.findFirst({ where: { id, ownerId }, select: { page: true, messages: true } }),
      this.prisma.user.findUnique({ where: { id: ownerId }, select: { role: true } }),
    ]);
    if (!row) return;
    let reply: HelpAskMessage;
    try {
      const admin = user?.role === 'ADMIN';
      const articles = this.library
        .index(admin)
        .articles.map((meta) => this.library.article(meta.slug, admin))
        .filter((a): a is NonNullable<typeof a> => a !== null);
      const [machines, sessions, tasks, quota] = await Promise.all([
        readMachines(this.prisma, ownerId),
        readSessions(this.prisma, ownerId),
        readTasks(this.prisma, ownerId),
        readQuota(this.prisma, ownerId),
      ]);
      const text = await askDeepSeek({
        library: helpAskLibraryPrompt(articles),
        context: helpAskContextPrompt({
          account: { machines: machines.machines, sessions: sessions.sessions, tasks: tasks.tasks, quota: quota.machines },
          page: readPageOrNull(row.page),
          now: new Date(),
        }),
        messages: messagesOf(row.messages),
      });
      reply = { role: 'assistant', text, at: new Date().toISOString() };
    } catch (error) {
      if (!(error instanceof HelpAskAnswerFailed)) this.logger.error(`Ask ${id}: ${(error as Error).message}`);
      const words = error instanceof HelpAskAnswerFailed ? error.message : 'Orbit could not answer this one. Ask again.';
      reply = { role: 'assistant', text: '', at: new Date().toISOString(), error: words };
    }
    await this.prisma.$executeRaw`
      UPDATE "help_ask_conversation"
         SET "messages" = "messages" || jsonb_build_array(${JSON.stringify(reply)}::jsonb),
             "status" = ${reply.error ? 'failed' : 'answered'},
             "updated_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${id}::uuid AND "status" = 'working'`;
  }

  // ── Still stuck (board 02 ② right frame, side note 5) ─────────────────────────────────────────────────────────

  /** One of the caller's Asks, or the 404 of an Ask that is not there. */
  private async own(ownerId: string, id: string): Promise<ConversationRow> {
    const row = await this.prisma.helpAskConversation.findFirst({ where: { id, ownerId }, select: CONVERSATION_SELECT });
    if (!row) throw new NotFoundException('no such question');
    return row;
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
  async stuck(ownerId: string, id: string): Promise<HelpAskStuck> {
    const [row, admin, workspaces] = await Promise.all([
      this.own(ownerId, id),
      this.adminFor(ownerId),
      this.prisma.workspace.findMany({ where: { ownerId }, select: { name: true, workDir: true, repoUrl: true } }),
    ]);
    return {
      admin: admin ? { name: admin.name } : null,
      sentToAdmin: row.sentToAdminAt ? { adminName: row.admin?.name ?? 'your admin', at: row.sentToAdminAt.toISOString() } : null,
      report: { repository: releaseRepository(), privateNames: privateNamesOf(workspaces) },
    };
  }

  /**
   * POST /api/help/ask/:id/admin: Still stuck → Ask your admin. An ordinary task in the admin's own task list — theirs,
   * in no workspace, held until they start it — carrying the conversation and a link to the Ask; made through
   * TasksService.create, so it is announced to the admin as every new task is. Once per Ask: asked again, it answers
   * with the task already sent. Refused to an administrator, and when the instance has no other.
   */
  async askAdmin(ownerId: string, id: string): Promise<HelpAskAdminResult> {
    const row = await this.own(ownerId, id);
    if (row.sentToAdminAt) {
      return { taskId: row.adminTaskId ?? '', adminName: row.admin?.name ?? 'your admin', at: row.sentToAdminAt.toISOString() };
    }
    const admin = await this.adminFor(ownerId);
    if (!admin) {
      throw new ForbiddenException({
        code: 'HELP_ASK_NO_ADMIN',
        message: 'There is no other admin on this Orbit to send the question to.',
      });
    }
    const asker = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { name: true, email: true } });
    const dto = {
      title: helpAskTitle(`Help: ${row.title}`),
      description: adminTaskDescription({
        asker,
        link: `${publicOrigin()}/help/questions/${uuidToBase62(row.id)}`,
        exchanges: exchangesOf(messagesOf(row.messages)),
      }),
      completionCriterion: 'OWNER_CONFIRMED',
      acceptanceCriteria: `${asker.name} has an answer, or knows what to do next.`,
      autoRunWhenReady: false,
      idempotencyKey: `help-ask-admin:${row.id}`,
    } as CreateTaskDto;
    const task = (await this.tasks.create(admin.id, dto, { type: CreatorType.USER, id: ownerId })) as { id: string };
    // Once: a second press that raced this one finds the Ask already sent and writes nothing.
    await this.prisma.helpAskConversation.updateMany({
      where: { id: row.id, ownerId, sentToAdminAt: null },
      data: { adminId: admin.id, adminTaskId: task.id, sentToAdminAt: new Date() },
    });
    const sent = await this.own(ownerId, id);
    return { taskId: sent.adminTaskId ?? '', adminName: sent.admin?.name ?? admin.name, at: (sent.sentToAdminAt ?? new Date()).toISOString() };
  }
}

function readPageOrNull(value: Prisma.JsonValue | null): ReturnType<typeof readHelpAskPage> {
  try {
    return readHelpAskPage(value);
  } catch {
    return null;
  }
}

/** How many exchanges, and how many characters of each, an admin's task carries. */
const ADMIN_EXCHANGES = 20;
const ADMIN_ANSWER_CHARS = 8_000;

/** The conversation as question-and-answer pairs, the newest ADMIN_EXCHANGES of them. */
export function exchangesOf(messages: readonly HelpAskMessage[]): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ question: m.text, answer: '' });
    else if (out.length > 0 && !m.error) out[out.length - 1].answer = m.text.slice(0, ADMIN_ANSWER_CHARS);
  }
  return out.slice(-ADMIN_EXCHANGES);
}

/** The admin's task, in their words: who is stuck, where the Ask is, and the conversation. */
export function adminTaskDescription(input: {
  asker: { name: string; email: string };
  link: string;
  exchanges: { question: string; answer: string }[];
}): string {
  const lines = [
    `${input.asker.name} (${input.asker.email}) asked Orbit's help, is still stuck, and sent you the conversation.`,
    '',
    `Ask: ${input.link} (it opens in ${input.asker.name}'s account)`,
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
