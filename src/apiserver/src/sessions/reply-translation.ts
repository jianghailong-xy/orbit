import { UnprocessableEntityException } from '@nestjs/common';
import {
  AGENT_LANGUAGE,
  RunEventType,
  TRANSLATION_FAILED_CODE,
  type ApprovalTranslation,
  type NormalizedRunEvent,
  type QuestionAnswers,
  type ReplyTranslation,
  type TranslatedQuestion,
  type TranslationEventPayload,
  type TranslationLanguage,
} from '@orbit/shared';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { translate, TranslationFailed } from './translation';

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
 *  - Answers. A decision's options come back to their original English (`englishDecision`), and the owner's own
 *    words are translated into English, refused whole when that fails (1A).
 *
 * Best-effort like the recap and the suggestion pass: nothing here may fail the ingest or the card that started
 * it, and a lost job (a restart) only leaves the English on screen — a reply with no `translation` key, which a
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

/** Resolves once every translation this process has started so far has settled. For specs. */
export async function replyTranslationsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/**
 * After an ingest committed: queue a translation for each translatable event among `events` (what the batch
 * stored), when the owner's translation is on (`lang`, ownerTranslationLanguage). Returns at once.
 */
export function translateStoredEvents(
  deps: TranslationDeps,
  sessionId: string,
  lang: TranslationLanguage | null,
  events: ReadonlyArray<{ seq: number; type: string; payload?: unknown }>,
): void {
  if (!lang) return;
  for (const event of events) {
    if (translatableText(event.type, event.payload) === null) continue;
    track(queue.run(() => translateEvent(deps, sessionId, event.seq, lang)));
  }
}

/** Queue one event's translation again (Retry). The caller has checked the owner and the event. */
export function retranslateEvent(deps: TranslationDeps, sessionId: string, seq: number, lang: TranslationLanguage): void {
  track(queue.run(() => translateEvent(deps, sessionId, seq, lang, { again: true })));
}

/**
 * One event's translation: written into its payload as `translation` and published as a TRANSLATION. An
 * event already translated into `lang` is left alone unless `again` (the same batch sent twice must not
 * translate twice). Null when there is nothing to translate.
 */
export async function translateEvent(
  deps: TranslationDeps,
  sessionId: string,
  seq: number,
  lang: TranslationLanguage,
  opts: { again?: boolean } = {},
): Promise<ReplyTranslation | null> {
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
    result = { lang, text: await translate(text, AGENT_LANGUAGE, lang) };
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

/** Whether a card's input shows the owner anything translatable. */
export function cardHasText(input: unknown): boolean {
  const i = input as { description?: unknown; plan?: unknown; questions?: unknown } | null;
  return Boolean(str(i?.description) || str(i?.plan) || (Array.isArray(i?.questions) && i.questions.length > 0));
}

/** Translate what a card shows. Throws TranslationFailed when any piece fails: a card is shown whole in one
 *  language or the other, never half. */
export async function translateCard(input: unknown, lang: TranslationLanguage): Promise<ApprovalTranslation> {
  const i = input as { description?: unknown; plan?: unknown; questions?: unknown } | null;
  const into = (text: string) => translate(text, AGENT_LANGUAGE, lang);
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
  };
}

/** After a card was published to the owner: translate it, store it, publish it again. Returns at once. */
export function translateApprovalCard(
  deps: TranslationDeps,
  sessionId: string,
  approvalId: string,
  input: unknown,
  lang: TranslationLanguage | null,
): void {
  if (!lang || !cardHasText(input)) return;
  track(queue.run(() => translateCardNow(deps, sessionId, approvalId, lang)));
}

export async function translateCardNow(
  deps: TranslationDeps,
  sessionId: string,
  approvalId: string,
  lang: TranslationLanguage,
): Promise<ApprovalTranslation | null> {
  const where = { id: approvalId, sessionId, status: 'PENDING' as const };
  const card = await deps.db.approval.findFirst({ where });
  if (!card) return null;
  let translation: ApprovalTranslation;
  try {
    translation = await translateCard(card.input, lang);
  } catch {
    translation = { lang, failed: true };
  }
  // Only a card still asking: an answered one is off every screen.
  const written = await deps.db.approval.updateMany({ where, data: { translation: translation as never } });
  if (written.count > 0) deps.publish(sessionId, deps.approvalEvent({ ...card, translation }));
  return translation;
}

// ── answers ────────────────────────────────────────────────────────────────────────────────────────

/** The refusal of a decision whose words could not be translated: nothing was recorded (1A). */
export function decisionNotTranslated(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: TRANSLATION_FAILED_CODE,
    message: "Couldn't translate, so it wasn't sent.",
  });
}

/**
 * A decision as the engine reads it: every question and option the owner answered with in their language
 * mapped back to the card's original English, and their own words (a typed answer, `message`) translated into
 * English when translation is on (`lang`) and they did not ask to send as written. Throws
 * decisionNotTranslated when a translation fails. With no stored translation and translation off, the
 * decision comes back exactly as it was given.
 */
export async function englishDecision(
  input: unknown,
  translation: ApprovalTranslation | null | undefined,
  dto: { message?: string; answers?: QuestionAnswers; sendAsWritten?: boolean },
  lang: TranslationLanguage | null,
): Promise<{ message?: string; answers?: QuestionAnswers }> {
  const freeText = lang && dto.sendAsWritten !== true ? lang : null;
  const toEnglish = async (text: string): Promise<string> => {
    if (!freeText || !text.trim()) return text;
    try {
      return await translate(text, freeText, AGENT_LANGUAGE);
    } catch (error) {
      if (error instanceof TranslationFailed) throw decisionNotTranslated();
      throw error;
    }
  };
  const message = dto.message === undefined ? undefined : await toEnglish(dto.message);
  if (!dto.answers || typeof dto.answers !== 'object') return { message, answers: dto.answers };
  const questions = (input as { questions?: CardQuestion[] } | null)?.questions;
  const originals = Array.isArray(questions) ? questions : [];
  const shown = translation?.questions ?? [];
  const answers: QuestionAnswers = {};
  for (const [key, labels] of Object.entries(dto.answers)) {
    let index = originals.findIndex((q) => q?.question === key);
    if (index < 0) index = shown.findIndex((q) => q.question === key);
    const question = index >= 0 ? originals[index] : undefined;
    const englishKey = typeof question?.question === 'string' ? question.question : key;
    const options = Array.isArray(question?.options) ? question.options : [];
    const shownOptions = index >= 0 ? (shown[index]?.options ?? []) : [];
    answers[englishKey] = await Promise.all(
      (Array.isArray(labels) ? labels : []).map(async (label) => {
        if (options.some((o) => o?.label === label)) return label;
        const at = shownOptions.findIndex((o) => o.label === label);
        if (at >= 0 && typeof options[at]?.label === 'string') return options[at].label as string;
        // Not one of the options: the owner's own words (the card's "Other").
        return typeof label === 'string' ? toEnglish(label) : label;
      }),
    );
  }
  return { message, answers };
}
