import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Injectable,
  NotFoundException,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import {
  DEFAULT_AGENT_LANGUAGE,
  isTranslationLanguage,
  PROMPT_OPTIMIZATION_FAILED_CODE,
  PROMPT_OPTIMIZER_MAX_DRAFT_CHARS,
  PROMPT_OPTIMIZER_OFF_CODE,
  PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS,
  PROMPT_OPTIMIZER_TIMEOUT_MS,
  RunEventType,
  TRANSLATION_LANGUAGE_NAMES,
  TRANSLATION_LANGUAGES,
  type PromptOptimization,
  type PromptOptimizationContextUsed,
  type PromptOptimizationFailedReason,
  type PromptOptimizationRequest,
  type PromptOptimizationSegment,
  type TranslationLanguage,
} from '@orbit/shared';
import { type AuthUser, CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { IsPublicId } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeRepoUrl } from '../wiki/wiki.service';
import { WikiRetrieval } from '../wiki/wiki-retrieval';
import { deepSeekCall } from './naming';
import { estimateTokens, fitRecapActivity, RECAP_INPUT_TOKEN_BUDGET, type RecapEventRow } from './recap';
import { protectVerbatim, restoreVerbatim } from './translation';
import { translationLanguages, type TranslationLanguages } from './turn-translation';

/**
 * Prompt optimizer (docs/prompt-optimizer-design.md, @orbit/shared prompt-optimizer.ts): DeepSeek
 * improves the owner's draft in the composer before it is sent. One call per press, on the server's
 * own key — never a session's — with context the server already holds (D1 A): the session's recap,
 * its last turns, the workspace name, the project's goal and acceptance criteria, and up to three
 * wiki entries. Nothing here sends anything: the client shows the answer as a suggestion.
 *
 * Code spans and URLs in the draft are protected with protectVerbatim / restoreVerbatim, as a
 * translation's are: the model sees placeholders and every one must come back exactly once.
 */

/** Whether the server can optimize at all: it holds a DeepSeek key. */
export function promptOptimizerAvailable(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

/** Why an optimization did not happen (the 422's `reason`). Its message is English and safe to show. */
export class PromptOptimizationFailed extends Error {
  constructor(readonly reason: PromptOptimizationFailedReason, message: string) {
    super(message);
    this.name = 'PromptOptimizationFailed';
  }
}

/** How many optimizations run at once on one apiserver; the rest wait their turn in memory. */
export const PROMPT_OPTIMIZER_CONCURRENCY = 4;
export const promptOptimizerQueue = new AsyncWorkQueue(PROMPT_OPTIMIZER_CONCURRENCY);

/** The most wiki entries one optimization reads (D1 A). */
export const PROMPT_OPTIMIZER_WIKI_ENTRIES = 3;

/** How many of the session's newest user and assistant events are read before they are fitted. */
export const TURN_EVENTS_READ = 200;

/** What the server found to tell the model, each part present only when it was there. */
export interface PromptOptimizerContext {
  recap?: string;
  /** The last turns, rendered oldest first, and how many lines they are. */
  turns?: { text: string; count: number };
  workspaceName?: string;
  project?: { title: string; goal: string | null; criteria: string[] };
  wiki?: Array<{ title: string; summary: string }>;
  /** What the draft answers, from the client (`replyingTo`), when it answers a card. */
  replyingTo?: string;
}

/** The sources the card draws as "Used: …" chips: exactly the parts of `context` that are present. */
export function contextUsedOf(context: PromptOptimizerContext): PromptOptimizationContextUsed[] {
  const used: PromptOptimizationContextUsed[] = [];
  if (context.turns) used.push({ kind: 'TURNS', count: context.turns.count });
  if (context.recap) used.push({ kind: 'RECAP' });
  if (context.project) used.push({ kind: 'PROJECT', title: context.project.title });
  if (context.wiki?.length) used.push({ kind: 'WIKI', count: context.wiki.length });
  if (context.workspaceName) used.push({ kind: 'WORKSPACE', name: context.workspaceName });
  return used;
}

function languageName(code: TranslationLanguage): string {
  return TRANSLATION_LANGUAGE_NAMES[code];
}

/**
 * Who the prompt is written for. Absent: the owner's composer. `guest`: a person the owner invited to reply
 * (project 3504qZwKVUy7ccEQYo3HR, D2): a collaborator writing to the owner's agent, whose gloss is in their own
 * language (`languages.owner` then names the guest's language, not the owner's). `writeIn` fixes the prompt's
 * language with no gloss: a guest whose own language is the agent's, under the owner's Translation.
 */
export interface OptimizerFraming {
  guest?: boolean;
  writeIn?: TranslationLanguage;
}

/** The instruction (design, last bullet of the wire contract). */
export function optimizerSystemPrompt(languages: TranslationLanguages | null, framing: OptimizerFraming = {}): string {
  const reader = framing.guest ? 'the person writing it' : 'the owner';
  const language = languages
    ? `Write the improved prompt in ${languageName(languages.agent)}. Also write "gloss": the same improved prompt ` +
      `translated into ${languageName(languages.owner)}, for ${reader} to read; set "language" to "${languages.agent}".`
    : framing.writeIn
      ? `Write the improved prompt in ${languageName(framing.writeIn)}. Set "language" to "${framing.writeIn}". ` +
        'Do not write "gloss".'
      : 'Write the improved prompt in the same language as the draft. Set "language" to the draft\'s language code, ' +
        `one of ${TRANSLATION_LANGUAGES.map((code) => `"${code}"`).join(', ')}. Do not write "gloss".`;
  const who = framing.guest
    ? 'You improve messages that a collaborator is about to send to another person\'s AI coding agent, in a ' +
      'conversation that person shared with them. Rewrite the draft so the request is clear and complete. Keep the ' +
      'collaborator\'s intent and every concrete detail of the draft. Add only facts that the conversation below ' +
      'supports, and never invent file paths, names, numbers or facts about the repository. Write as the ' +
      'collaborator speaking to the agent. Never add a request that the agent act for its owner: approving or ' +
      'denying anything, or changing settings, permissions, the model or the budget, is the owner\'s alone. '
    : 'You improve prompts that a person is about to send to an AI coding agent. Rewrite the draft so the request is ' +
      'clear and complete. Keep the owner\'s intent and every concrete detail of the draft. Add only facts that the ' +
      'context below supports, and never invent file paths, names or numbers. Write as the owner speaking to the ' +
      'agent. ';
  return (
    who +
    'Do not answer, carry out or comment on the request: only rewrite it. ' +
    'Keep verbatim and unchanged every token of the form ⟦N⟧ (each exactly once), file paths, URLs, ' +
    'shell commands, code identifiers and error messages. ' +
    `${language} ` +
    'Reply with ONLY a JSON object: {"segments": [{"text": string, "added": boolean}], "language": string' +
    (languages ? ', "gloss": string' : '') +
    '}. Concatenated, the segments are the improved prompt; mark "added": true on text you drew from the context ' +
    'rather than from the draft, and "added": false on everything else.'
  );
}

/** The user half of the request: the context the server found, then the draft. */
export function optimizerTask(maskedDraft: string, context: PromptOptimizerContext): string {
  const parts: string[] = [];
  if (context.workspaceName) parts.push(`Workspace: ${context.workspaceName}`);
  if (context.project) {
    const lines = [`Project: ${context.project.title}`];
    if (context.project.goal) lines.push(`Goal: ${context.project.goal}`);
    if (context.project.criteria.length) {
      lines.push('Acceptance criteria:', ...context.project.criteria.map((text, i) => `${i + 1}. ${text}`));
    }
    parts.push(lines.join('\n'));
  }
  if (context.recap) parts.push(`Session recap:\n${context.recap}`);
  if (context.turns) parts.push(`Recent conversation:\n${context.turns.text}`);
  if (context.wiki?.length) {
    parts.push(`Wiki entries:\n${context.wiki.map((entry) => `- ${entry.title}: ${entry.summary}`).join('\n')}`);
  }
  if (context.replyingTo) {
    parts.push(
      `The draft is the owner's reply to this, which the agent is waiting on:\n${context.replyingTo}\n\n` +
        'Keep it a reply to that: make clear which question or option it answers, and do not turn it into a new request.',
    );
  }
  parts.push(`Draft:\n${maskedDraft}`);
  return parts.join('\n\n');
}

/** Room for the answer: the prompt, perhaps longer than the draft, and its gloss beside it. */
function maxTokensFor(draft: string, gloss: boolean): number {
  return Math.min(8192, Math.max(512, Math.ceil(draft.length * 2 * (gloss ? 2 : 1)) + 256));
}

const PLACEHOLDER_RE = /⟦(\d+)⟧/g;

/** The segments with every placeholder put back, checked across all of them as one text. */
function restoreSegments(segments: PromptOptimizationSegment[], spans: readonly string[]): PromptOptimizationSegment[] {
  try {
    restoreVerbatim(segments.map((segment) => segment.text).join(''), spans);
  } catch {
    throw new PromptOptimizationFailed('MALFORMED', 'The optimizer changed the code or links in the draft.');
  }
  return segments.map((segment) => ({
    text: segment.text.replace(PLACEHOLDER_RE, (_match, digits: string) => spans[Number(digits)]),
    added: segment.added,
  }));
}

/** The model's JSON, read strictly: anything else is MALFORMED. */
function parseOptimization(
  content: string,
  spans: readonly string[],
  languages: TranslationLanguages | null,
  writeIn?: TranslationLanguage,
): Omit<PromptOptimization, 'contextUsed'> {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new PromptOptimizationFailed('MALFORMED', 'The optimizer did not answer in the expected form.');
  }
  const reply = (data ?? {}) as { segments?: unknown; language?: unknown; gloss?: unknown };
  const raw = Array.isArray(reply.segments) ? reply.segments : [];
  if (!raw.every((s) => !!s && typeof (s as { text?: unknown }).text === 'string')) {
    throw new PromptOptimizationFailed('MALFORMED', 'The optimizer did not answer in the expected form.');
  }
  const segments = (raw as Array<{ text: string; added?: unknown }>)
    .filter((s) => s.text.length > 0)
    .map((s) => ({ text: s.text, added: s.added === true }));
  if (!segments.some((s) => s.text.trim())) {
    throw new PromptOptimizationFailed('MALFORMED', 'The optimizer returned no prompt.');
  }
  const restored = restoreSegments(segments, spans);
  const text = restored.map((segment) => segment.text).join('');
  if (languages) {
    const gloss = typeof reply.gloss === 'string' ? reply.gloss.trim() : '';
    if (!gloss) throw new PromptOptimizationFailed('MALFORMED', 'The optimizer returned no reading copy.');
    let restoredGloss: string;
    try {
      restoredGloss = restoreVerbatim(gloss, spans);
    } catch {
      throw new PromptOptimizationFailed('MALFORMED', 'The optimizer changed the code or links in the reading copy.');
    }
    return { segments: restored, text, language: languages.agent, gloss: restoredGloss };
  }
  if (writeIn) return { segments: restored, text, language: writeIn };
  // The draft's own language. A code outside TRANSLATION_LANGUAGES reads as the default agent language.
  const language = isTranslationLanguage(reply.language) ? reply.language : DEFAULT_AGENT_LANGUAGE;
  return { segments: restored, text, language };
}

/**
 * Optimize `draft` with `context`. Resolves with the optimization; rejects with
 * PromptOptimizationFailed on anything else — a non-2xx answer, no answer, a reply cut off by its
 * token limit, an empty reply, one that is not the JSON asked for or mangled the protected spans,
 * or the 20 s timeout. The race is a hard outer bound even if a fetch implementation ignores abort.
 * The caller checks that the server has a key.
 */
export async function optimizePrompt(
  draft: string,
  context: PromptOptimizerContext,
  opts: { languages: TranslationLanguages | null; timeoutMs?: number; framing?: OptimizerFraming },
): Promise<PromptOptimization> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new ConflictException({ code: PROMPT_OPTIMIZER_OFF_CODE, message: 'This server has no DeepSeek key.' });
  const { masked, spans } = protectVerbatim(draft);
  const call = deepSeekCall(apiKey, optimizerSystemPrompt(opts.languages, opts.framing), optimizerTask(masked, context), {
    json: true,
    maxTokens: maxTokensFor(masked, opts.languages !== null),
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<PromptOptimization> => {
    let resp: Response;
    try {
      resp = await fetch(call.url, {
        method: 'POST',
        redirect: 'manual',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: controller.signal,
      });
    } catch {
      throw new PromptOptimizationFailed('NETWORK', 'The optimizer could not be reached.');
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      throw new PromptOptimizationFailed('HTTP', `The optimizer answered ${resp.status}.`);
    }
    const data = (await resp.json().catch(() => null)) as
      | { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] }
      | null;
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new PromptOptimizationFailed('TRUNCATED', 'The draft is too long to optimize.');
    }
    const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    if (!content) throw new PromptOptimizationFailed('EMPTY', 'The optimizer returned nothing.');
    return { ...parseOptimization(content, spans, opts.languages, opts.framing?.writeIn), contextUsed: contextUsedOf(context) };
  })();
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PromptOptimizationFailed('TIMEOUT', 'Optimizing took longer than 20 seconds.'));
    }, Math.max(0, opts.timeoutMs ?? PROMPT_OPTIMIZER_TIMEOUT_MS));
  });
  try {
    return await Promise.race([request, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `POST /prompt-optimizations`'s body (PromptOptimizationRequest). A class, so the global
 *  ValidationPipe decodes the ids from whichever spelling a client sends. */
export class PromptOptimizationDto implements PromptOptimizationRequest {
  @IsString() draft!: string;
  @IsOptional() @IsPublicId() sessionId?: string;
  @IsOptional() @IsPublicId() workspaceId?: string;
  @IsOptional() @IsPublicId() projectId?: string;
  @IsOptional() @IsString() replyingTo?: string;
}

@Injectable()
export class PromptOptimizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wiki: WikiRetrieval,
  ) {}

  /**
   * One optimization for `ownerId`: the switch and the key (409), the draft (400), the session,
   * workspace and project it names as the owner's own (404), then the context and one DeepSeek call
   * (422 on failure), queued behind at most PROMPT_OPTIMIZER_CONCURRENCY others.
   */
  async optimize(ownerId: string, dto: PromptOptimizationRequest, opts: { timeoutMs?: number } = {}): Promise<PromptOptimization> {
    const user = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { preferences: true } });
    const preferences = (user?.preferences ?? null) as { promptOptimizer?: unknown } | null;
    if (!promptOptimizerAvailable() || preferences?.promptOptimizer === false) {
      throw new ConflictException({ code: PROMPT_OPTIMIZER_OFF_CODE, message: 'The prompt optimizer is off for this account.' });
    }
    const draft = typeof dto.draft === 'string' ? dto.draft : '';
    if (!draft.trim()) throw new BadRequestException('The draft is empty.');
    if (draft.length > PROMPT_OPTIMIZER_MAX_DRAFT_CHARS) {
      throw new BadRequestException(`The draft is longer than ${PROMPT_OPTIMIZER_MAX_DRAFT_CHARS} characters.`);
    }
    const context = await this.gatherContext(ownerId, draft, dto);
    const languages = await translationLanguages(this.prisma, ownerId);
    try {
      return await promptOptimizerQueue.run(() => optimizePrompt(draft, context, { languages, timeoutMs: opts.timeoutMs }));
    } catch (err) {
      if (err instanceof PromptOptimizationFailed) {
        throw new UnprocessableEntityException({ code: PROMPT_OPTIMIZATION_FAILED_CODE, reason: err.reason, message: err.message });
      }
      throw err;
    }
  }

  /** D1 A: what the server holds about where the draft is going. Every id named must be the owner's. */
  async gatherContext(ownerId: string, draft: string, dto: PromptOptimizationRequest): Promise<PromptOptimizerContext> {
    const session = dto.sessionId
      ? await this.prisma.session.findFirst({
          where: { id: dto.sessionId, ownerId },
          select: {
            id: true,
            recapText: true,
            workspaceId: true,
            task: { select: { projectId: true } },
            coordinatorForProject: { select: { id: true } },
          },
        })
      : null;
    if (dto.sessionId && !session) throw new NotFoundException('session not found');
    const namedWorkspace = dto.workspaceId
      ? await this.prisma.workspace.findFirst({ where: { id: dto.workspaceId, ownerId, deletedAt: null }, select: { id: true } })
      : null;
    if (dto.workspaceId && !namedWorkspace) throw new NotFoundException('workspace not found');
    const namedProject = dto.projectId
      ? await this.prisma.project.findFirst({ where: { id: dto.projectId, ownerId }, select: { id: true } })
      : null;
    if (dto.projectId && !namedProject) throw new NotFoundException('project not found');

    // A session supplies its own workspace and project; a brand-new draft names the composer's.
    const workspaceId = session ? session.workspaceId : dto.workspaceId ?? null;
    const projectId = session
      ? session.task?.projectId ?? session.coordinatorForProject?.id ?? null
      : dto.projectId ?? null;

    const context: PromptOptimizerContext = {};
    const replyingTo = typeof dto.replyingTo === 'string' ? dto.replyingTo.trim().slice(0, PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS).trim() : '';
    if (replyingTo) context.replyingTo = replyingTo;
    if (session?.recapText?.trim()) context.recap = session.recapText.trim();
    const workspace = workspaceId
      ? await this.prisma.workspace.findFirst({
          where: { id: workspaceId, ownerId, deletedAt: null },
          select: { id: true, name: true, repoUrl: true },
        })
      : null;
    if (workspace?.name) context.workspaceName = workspace.name;
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, ownerId },
        select: {
          title: true,
          goal: true,
          acceptanceCriterionDefinitions: { orderBy: { ordinal: 'asc' }, select: { text: true } },
        },
      });
      if (project) {
        context.project = {
          title: project.title,
          goal: project.goal?.trim() || null,
          criteria: project.acceptanceCriterionDefinitions.map((c) => c.text),
        };
      }
    }
    if (workspace) {
      const wiki = await this.wikiEntries(ownerId, workspace, draft);
      if (wiki.length) context.wiki = wiki;
    }
    if (session) {
      // The turns get what the budget leaves once everything else is in.
      const budget = RECAP_INPUT_TOKEN_BUDGET
        - estimateTokens(optimizerSystemPrompt(null))
        - estimateTokens(optimizerTask(draft, context));
      const events = await this.prisma.runEvent.findMany({
        where: { sessionId: session.id, type: { in: [RunEventType.USER, RunEventType.ASSISTANT] } },
        orderBy: { seq: 'desc' },
        take: TURN_EVENTS_READ,
        select: { seq: true, type: true, payload: true },
      });
      const activity = fitRecapActivity(events.reverse() as RecapEventRow[], Math.max(0, budget));
      if (activity.text) context.turns = { text: activity.text, count: activity.text.split('\n').length };
    }
    return context;
  }

  /**
   * Up to three entries the wiki search finds for the draft in the space the workspace is in — read
   * only: a workspace is in the space a row binds it to, unless the owner left it out, else in the
   * live space on its repository. No wiki, or a search that fails, is no entries.
   */
  private async wikiEntries(
    ownerId: string,
    workspace: { id: string; repoUrl: string | null },
    draft: string,
  ): Promise<Array<{ title: string; summary: string }>> {
    try {
      const row = await this.prisma.wikiSpaceWorkspace.findFirst({
        where: { workspaceId: workspace.id, ownerId, space: { deletedAt: null } },
        select: { spaceId: true, leftOutAt: true },
      });
      if (row?.leftOutAt) return [];
      let spaceId = row?.spaceId ?? null;
      if (!spaceId && workspace.repoUrl) {
        const repoUrlNorm = normalizeRepoUrl(workspace.repoUrl);
        const space = repoUrlNorm
          ? await this.prisma.wikiSpace.findFirst({ where: { ownerId, repoUrlNorm, deletedAt: null }, select: { id: true } })
          : null;
        spaceId = space?.id ?? null;
      }
      if (!spaceId) return [];
      const found = await this.wiki.search({ ownerId, spaceId, q: draft, limit: PROMPT_OPTIMIZER_WIKI_ENTRIES });
      return found.hits.slice(0, PROMPT_OPTIMIZER_WIKI_ENTRIES).map((hit) => ({ title: hit.title, summary: hit.summary }));
    } catch {
      return [];
    }
  }
}

@UseGuards(JwtAuthGuard)
@Controller('prompt-optimizations')
export class PromptOptimizerController {
  constructor(private readonly optimizer: PromptOptimizerService) {}

  /** Optimize a composer draft (docs/prompt-optimizer-design.md, PromptOptimization). Nothing is sent. */
  // Not workspace-confinable: it reads a project's goal and criteria and the wiki, which no workspace vouches for.
  @PatScope('sessions:write', { workspaceConfinable: false })
  @Post()
  @HttpCode(200)
  optimize(@CurrentUser() user: AuthUser, @Body() dto: PromptOptimizationDto): Promise<PromptOptimization> {
    return this.optimizer.optimize(user.userId, dto);
  }
}
