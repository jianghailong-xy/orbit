import { UnprocessableEntityException } from '@nestjs/common';
import {
  RunEventType,
  TRANSLATED_ORBIT_CARDS,
  TRANSLATION_FAILED_CODE,
  type ApprovalTranslation,
  type NormalizedRunEvent,
  type OwnerWordsTranslation,
  type QuestionAnswers,
  type ReplyTranslation,
  type TranslatedQuestion,
  type TranslatedTaskBody,
  type TranslationEventPayload,
  type TranslationFailedBody,
} from '@orbit/shared';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { cardTranslationSettled } from './card-translation-wait';
import { translate, TranslationFailed } from './translation';
import { logOwnerTranslationFailure, type TranslationLanguages } from './turn-translation';

/**
 * Settings › Translation, what the agent says (task A2, decisions 2A and 3A; wire shapes in @orbit/shared
 * translation.ts). The owner's own messages are A1's (turn-translation.ts).
 *
 *  - Agent replies and Suggested replies. Once the ingest has stored an `assistant` text block or a
 *    `prompt_suggestion` (RunnerApiController.announceIngest), an owner with translation on gets it translated
 *    here, in the background, on a bounded queue. run_event seq is the runner's, so nothing here takes one: the
 *    result is written into the translated event's OWN payload under `translation` — which is how every replay
 *    path already carries it — and announced live as a seq-0 RunEventType.TRANSLATION naming the event by `of`.
 *    The run_event payload is not what the seq-conflict check compares (run-event-seq-conflicts.ts), so a batch
 *    the runner sends again is still the same event.
 *  - Approval cards. What a card shows the owner is translated after it is published, kept beside its input in
 *    approval.translation (0550), and the card published again with it.
 *  - Answers. A decision's options come back to the card's original words (`agentDecision`), and the owner's own
 *    words are translated into the account's agent language, refused whole when that fails (1A).
 *
 * Every translation runs between the two languages `translationLanguages` reads (turn-translation.ts): replies and
 * cards from the agent's language into the owner's, answers the other way. When the two are the same that read is
 * null, and nothing here runs — as with translation off.
 *
 * Best-effort like the recap and the suggestion pass: nothing here may fail the ingest or the card that started
 * it, and a lost job (a restart) only leaves the agent's own words on screen — a reply with no `translation` key, which a
 * client draws as it is.
 */

/** The fields of the client this needs; a Prisma client or transaction double. */
export interface TranslationDb {
  runEvent: {
    findUnique(args: {
      where: { sessionId_seq: { sessionId: string; seq: number } };
      select: { type: true; payload: true; turnId: true };
    }): PromiseLike<{ type: string; payload: unknown; turnId: string | null } | null>;
    update(args: {
      where: { sessionId_seq: { sessionId: string; seq: number } };
      data: { payload: never };
      select: { seq: true };
    }): PromiseLike<unknown>;
  };
  approval: {
    findFirst(args: { where: { id: string; sessionId: string; status: 'PENDING' } }): PromiseLike<
      { id: string; toolName: string; input: unknown; toolUseId: string | null; backgroundJobId: string | null; coordinatorFallback?: string | null } | null
    >;
    updateMany(args: { where: { id: string; sessionId: string; status: 'PENDING' }; data: { translation: never } }): PromiseLike<{ count: number }>;
  };
}

export interface TranslationDeps {
  db: TranslationDb;
  publish(sessionId: string, event: NormalizedRunEvent): void;
  /** Builds the card an approval row raises (realtime.service approvalRequestEvent), with its translation. */
  approvalEvent(approval: { id: string; toolName: string; input: unknown; toolUseId: string | null; backgroundJobId: string | null; coordinatorFallback?: string | null; translation: ApprovalTranslation }): NormalizedRunEvent;
}

/** The text of an event that is translated, or null for every other: the workspace's own prose reply (an
 *  `assistant` block that is not a sub-agent's report, `parentToolUseId`) and a prompt suggestion. Never a
 *  tool_use, tool_result, thinking block, output or anything else. */
export function translatableText(type: string, payload: unknown): string | null {
  if (type !== RunEventType.ASSISTANT && type !== RunEventType.PROMPT_SUGGESTION) return null;
  const p = payload as { text?: unknown; parentToolUseId?: unknown } | null;
  if (!p || typeof p.text !== 'string' || !p.text.trim()) return null;
  if (type === RunEventType.ASSISTANT && p.parentToolUseId) return null;
  return p.text;
}

/** How many translations of replies and cards run at once on one apiserver; the rest wait in memory. */
export const REPLY_TRANSLATION_CONCURRENCY = 4;
const queue = new AsyncWorkQueue(REPLY_TRANSLATION_CONCURRENCY);
const inFlight = new Set<Promise<unknown>>();

function track(run: Promise<unknown>): void {
  const settled: Promise<unknown> = run.catch(() => undefined).finally(() => inFlight.delete(settled));
  inFlight.add(settled);
}

/** Run `job` on the same bounded queue as replies and cards, tracked by `replyTranslationsSettled`. Returns at once;
 *  `job` must catch what it can fail with (a rejection is swallowed). For card-translation.ts. */
export function queueTranslation(job: () => Promise<unknown>): void {
  track(queue.run(job));
}

/** Resolves once every translation this process has started so far has settled. For specs. */
export async function replyTranslationsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/**
 * After an ingest committed: queue a translation for each translatable event among `events` (what the batch
 * stored), when the owner's translation is on (`langs`, translationLanguages). Returns at once.
 */
export function translateStoredEvents(
  deps: TranslationDeps,
  sessionId: string,
  langs: TranslationLanguages | null,
  events: ReadonlyArray<{ seq: number; type: string; payload?: unknown }>,
): void {
  if (!langs) return;
  for (const event of events) {
    if (translatableText(event.type, event.payload) === null) continue;
    track(queue.run(() => translateEvent(deps, sessionId, event.seq, langs)));
  }
}

/** Queue one event's translation again (Retry). The caller has checked the owner and the event. */
export function retranslateEvent(deps: TranslationDeps, sessionId: string, seq: number, langs: TranslationLanguages): void {
  track(queue.run(() => translateEvent(deps, sessionId, seq, langs, { again: true })));
}

/**
 * One event's translation, from the agent's language into the owner's (`langs`): written into its payload as
 * `translation` and published as a TRANSLATION. An event already translated into the owner's language is left alone unless `again` (the same batch sent twice must not
 * translate twice). Null when there is nothing to translate.
 */
export async function translateEvent(
  deps: TranslationDeps,
  sessionId: string,
  seq: number,
  langs: TranslationLanguages,
  opts: { again?: boolean } = {},
): Promise<ReplyTranslation | null> {
  const lang = langs.owner;
  const where = { sessionId_seq: { sessionId, seq } };
  const row = await deps.db.runEvent.findUnique({ where, select: { type: true, payload: true, turnId: true } });
  if (!row) return null;
  const text = translatableText(row.type, row.payload);
  if (text === null) return null;
  const payload = row.payload as Record<string, unknown>;
  const prior = payload.translation as ReplyTranslation | undefined;
  if (!opts.again && prior?.lang === lang && typeof prior.text === 'string') return prior;
  let result: ReplyTranslation;
  try {
    result = { lang, text: await translate(text, langs.agent, lang) };
  } catch {
    result = { lang, failed: true };
  }
  // Read again: a translation written meanwhile (a Retry racing the first pass) that succeeded is not
  // overwritten by a failure.
  const now = await deps.db.runEvent.findUnique({ where, select: { type: true, payload: true, turnId: true } });
  if (!now) return null;
  const current = (now.payload as Record<string, unknown>).translation as ReplyTranslation | undefined;
  if (result.failed && current?.lang === lang && typeof current.text === 'string') return current;
  await deps.db.runEvent.update({
    where,
    data: { payload: { ...(now.payload as Record<string, unknown>), translation: result } as never },
    select: { seq: true },
  });
  const live: TranslationEventPayload = { of: seq, ...result };
  deps.publish(sessionId, {
    seq: 0,
    type: RunEventType.TRANSLATION,
    payload: { ...live },
    turnId: now.turnId ?? undefined,
    ts: new Date().toISOString(),
  });
  return result;
}

/** The live TRANSLATION for an event whose payload holds one, as a replica that reads it back builds it. */
export function translationEventOf(row: { seq: number; payload: unknown; turnId: string | null }): NormalizedRunEvent | null {
  const translation = (row.payload as { translation?: ReplyTranslation } | null)?.translation;
  if (!translation) return null;
  return {
    seq: 0,
    type: RunEventType.TRANSLATION,
    payload: { ...({ of: row.seq, ...translation } satisfies TranslationEventPayload) },
    turnId: row.turnId ?? undefined,
    ts: new Date().toISOString(),
  };
}

// ── approval cards ─────────────────────────────────────────────────────────────────────────────────

type CardQuestion = { question?: unknown; header?: unknown; options?: Array<{ label?: unknown; description?: unknown }> };

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

/** The agent-written fields an Orbit card (TRANSLATED_ORBIT_CARDS) shows beyond `description`, by tool. */
type OrbitCardInput = {
  title?: unknown;
  acceptanceCriteria?: unknown;
  tasks?: unknown;
  goal?: unknown;
  instructions?: unknown;
  acceptanceCriteriaItems?: unknown;
  reason?: unknown;
  note?: unknown;
};

const isOrbitCard = (toolName: string | null | undefined): boolean =>
  (TRANSLATED_ORBIT_CARDS as readonly string[]).includes(toolName ?? '');

const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})) : [];

/** Whether a card's input shows the owner anything translatable. `toolName` names the card: Orbit's own
 *  create, blocker and DAG-change cards show more of their input than a tool card's `description`. */
export function cardHasText(input: unknown, toolName?: string | null): boolean {
  const i = input as { description?: unknown; plan?: unknown; questions?: unknown } | null;
  if (str(i?.description) || str(i?.plan) || (Array.isArray(i?.questions) && i.questions.length > 0)) return true;
  if (!isOrbitCard(toolName)) return false;
  const o = (input ?? {}) as OrbitCardInput;
  return Boolean(
    str(o.title) ||
      str(o.acceptanceCriteria) ||
      str(o.goal) ||
      str(o.instructions) ||
      str(o.reason) ||
      str(o.note) ||
      records(o.tasks).some((t) => str(t.title) || str(t.description) || str(t.acceptanceCriteria)) ||
      records(o.acceptanceCriteriaItems).some((c) => str(c.text) || str(c.verificationMethod)),
  );
}

/** How many of one card's pieces are sent to the translator at once: a batch of fifty tasks is up to a
 *  hundred and fifty pieces, and firing them together would trip the provider's rate limit. */
const CARD_PIECES_AT_ONCE = 6;

/** `fn` over `items` in order, at most CARD_PIECES_AT_ONCE at a time. */
export async function mapBounded<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CARD_PIECES_AT_ONCE, items.length) }, worker));
  return out;
}

/** Translate what a card shows, from the agent's language into the owner's. Throws TranslationFailed when any
 *  piece fails: a card is shown whole in one language or the other, never half. */
export async function translateCard(input: unknown, langs: TranslationLanguages, toolName?: string | null): Promise<ApprovalTranslation> {
  const lang = langs.owner;
  const i = input as { description?: unknown; plan?: unknown; questions?: unknown } | null;
  const into = (text: string) => translate(text, langs.agent, lang);
  const maybe = (value: unknown) => (str(value) ? into(value as string) : Promise.resolve(undefined));
  const questions = Array.isArray(i?.questions) ? (i.questions as CardQuestion[]) : undefined;
  const [description, plan, translated] = await Promise.all([
    maybe(i?.description),
    maybe(i?.plan),
    questions
      ? Promise.all(
          questions.map(async (q): Promise<TranslatedQuestion> => {
            const [question, header, options] = await Promise.all([
              maybe(q?.question),
              maybe(q?.header),
              Promise.all(
                (Array.isArray(q?.options) ? q.options : []).map(async (o) => {
                  const [label, desc] = await Promise.all([maybe(o?.label), maybe(o?.description)]);
                  return { label: label ?? String(o?.label ?? ''), ...(desc !== undefined ? { description: desc } : {}) };
                }),
              ),
            ]);
            return { question: question ?? String(q?.question ?? ''), ...(header !== undefined ? { header } : {}), options };
          }),
        )
      : Promise.resolve(undefined),
  ]);
  return {
    lang,
    ...(description !== undefined ? { description } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(translated !== undefined ? { questions: translated } : {}),
    ...(isOrbitCard(toolName) ? await translateOrbitCard(input, maybe) : {}),
  };
}

/** The fields an Orbit card shows beyond `description` (ApprovalTranslation, board 04-owner-cards part 2),
 *  each present only when its original has text; arrays index for index with the input's. */
async function translateOrbitCard(
  input: unknown,
  maybe: (value: unknown) => Promise<string | undefined>,
): Promise<Partial<ApprovalTranslation>> {
  const o = (input ?? {}) as OrbitCardInput;
  const defined = <T extends object>(fields: T): Partial<T> =>
    Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
  const tasks = records(o.tasks);
  const items = records(o.acceptanceCriteriaItems);
  // One flat queue of pieces for the whole card, so a big batch is bounded as one.
  type Piece = { value: unknown; put: (text: string | undefined) => void };
  const out: Partial<ApprovalTranslation> = {};
  const translatedTasks: TranslatedTaskBody[] = tasks.map(() => ({}));
  const translatedItems: Array<{ text?: string; verificationMethod?: string }> = items.map(() => ({}));
  const pieces: Piece[] = [
    ...(['title', 'acceptanceCriteria', 'goal', 'instructions', 'reason', 'note'] as const).map(
      (key): Piece => ({ value: o[key], put: (text) => { if (text !== undefined) out[key] = text; } }),
    ),
    ...tasks.flatMap((t, at) =>
      (['title', 'description', 'acceptanceCriteria'] as const).map(
        (key): Piece => ({ value: t[key], put: (text) => { if (text !== undefined) translatedTasks[at][key] = text; } }),
      ),
    ),
    ...items.flatMap((c, at) =>
      (['text', 'verificationMethod'] as const).map(
        (key): Piece => ({ value: c[key], put: (text) => { if (text !== undefined) translatedItems[at][key] = text; } }),
      ),
    ),
  ];
  const results = await mapBounded(pieces.filter((p) => str(p.value)), async (p) => ({ p, text: await maybe(p.value) }));
  for (const { p, text } of results) p.put(text);
  return defined({
    ...out,
    tasks: tasks.length > 0 ? translatedTasks : undefined,
    acceptanceCriteriaItems: items.length > 0 ? translatedItems : undefined,
  });
}

/** After a card was published to the owner: translate it, store it, publish it again. Returns at once. */
export function translateApprovalCard(
  deps: TranslationDeps,
  sessionId: string,
  approvalId: string,
  input: unknown,
  langs: TranslationLanguages | null,
  toolName?: string | null,
): void {
  if (!langs || !cardHasText(input, toolName)) return;
  // The Feishu card waiting for this translation (decision 3A) reads the approval again once it was tried.
  track(queue.run(() => translateCardNow(deps, sessionId, approvalId, langs)
    .finally(() => cardTranslationSettled(`approval:${approvalId}`, langs.owner))));
}

export async function translateCardNow(
  deps: TranslationDeps,
  sessionId: string,
  approvalId: string,
  langs: TranslationLanguages,
): Promise<ApprovalTranslation | null> {
  const where = { id: approvalId, sessionId, status: 'PENDING' as const };
  const card = await deps.db.approval.findFirst({ where });
  if (!card) return null;
  let translation: ApprovalTranslation;
  try {
    translation = await translateCard(card.input, langs, card.toolName);
  } catch {
    translation = { lang: langs.owner, failed: true };
  }
  // Only a card still asking: an answered one is off every screen.
  const written = await deps.db.approval.updateMany({ where, data: { translation: translation as never } });
  if (written.count > 0) deps.publish(sessionId, deps.approvalEvent({ ...card, translation }));
  return translation;
}

// ── answers ────────────────────────────────────────────────────────────────────────────────────────

/** The refusal of a decision whose words could not be translated: nothing was recorded (1A). Says why
 *  (TranslationFailedBody): the same `failureReason` and `httpStatus` a held message's FAILED translation carries. */
export function decisionNotTranslated(error: TranslationFailed): UnprocessableEntityException {
  const body: TranslationFailedBody = {
    code: TRANSLATION_FAILED_CODE,
    message: "Couldn't translate, so it wasn't sent.",
    failureReason: error.reason,
    ...(error.reason === 'HTTP' && error.httpStatus != null ? { httpStatus: error.httpStatus } : {}),
  };
  return new UnprocessableEntityException(body);
}

/** Where the owner's words came in, for the failure's log line (logOwnerTranslationFailure). */
export interface OwnerWordsDoor {
  door: string;
  sessionId?: string | null;
}

/**
 * Words the owner typed, as an agent is to read them (OwnerWordsTranslation): translated from the owner's language
 * into the agent's when translation is on (`langs`) and they did not ask to send as written. Null when there is
 * nothing to translate — translation off, Send as written, or no words — and the words go as they are. Throws
 * decisionNotTranslated when the translation fails: the door that called this refuses the answer whole and records
 * nothing, which is why every such door calls it before its first write.
 */
export async function ownerWordsForAgent(
  text: string | null | undefined,
  langs: TranslationLanguages | null,
  sendAsWritten?: boolean,
  where: OwnerWordsDoor = { door: 'owner-words' },
): Promise<OwnerWordsTranslation | null> {
  if (!langs || sendAsWritten === true || !text?.trim()) return null;
  try {
    return { lang: langs.agent, text: await translate(text, langs.owner, langs.agent) };
  } catch (error) {
    if (error instanceof TranslationFailed) {
      logOwnerTranslationFailure(error, where);
      throw decisionNotTranslated(error);
    }
    throw error;
  }
}

/**
 * A decision as the engine reads it: every question and option the owner answered with in their language
 * mapped back to the card's original words, and their own words (a typed answer, `message`) translated from the
 * owner's language into the agent's when translation is on (`langs`) and they did not ask to send as written. Throws
 * decisionNotTranslated when a translation fails. With no stored translation and translation off, the
 * decision comes back exactly as it was given.
 */
export async function agentDecision(
  input: unknown,
  translation: ApprovalTranslation | null | undefined,
  dto: { message?: string; answers?: QuestionAnswers; sendAsWritten?: boolean },
  langs: TranslationLanguages | null,
  where: OwnerWordsDoor = { door: 'approval-decision' },
): Promise<{ message?: string; answers?: QuestionAnswers }> {
  const toAgent = async (text: string): Promise<string> =>
    (await ownerWordsForAgent(text, langs, dto.sendAsWritten, where))?.text ?? text;
  const message = dto.message === undefined ? undefined : await toAgent(dto.message);
  if (!dto.answers || typeof dto.answers !== 'object') return { message, answers: dto.answers };
  const questions = (input as { questions?: CardQuestion[] } | null)?.questions;
  const originals = Array.isArray(questions) ? questions : [];
  const shown = translation?.questions ?? [];
  const answers: QuestionAnswers = {};
  for (const [key, labels] of Object.entries(dto.answers)) {
    let index = originals.findIndex((q) => q?.question === key);
    if (index < 0) index = shown.findIndex((q) => q.question === key);
    const question = index >= 0 ? originals[index] : undefined;
    const originalKey = typeof question?.question === 'string' ? question.question : key;
    const options = Array.isArray(question?.options) ? question.options : [];
    const shownOptions = index >= 0 ? (shown[index]?.options ?? []) : [];
    answers[originalKey] = await Promise.all(
      (Array.isArray(labels) ? labels : []).map(async (label) => {
        if (options.some((o) => o?.label === label)) return label;
        const at = shownOptions.findIndex((o) => o.label === label);
        if (at >= 0 && typeof options[at]?.label === 'string') return options[at].label as string;
        // Not one of the options: the owner's own words (the card's "Other").
        return typeof label === 'string' ? toAgent(label) : label;
      }),
    );
  }
  return { message, answers };
}
