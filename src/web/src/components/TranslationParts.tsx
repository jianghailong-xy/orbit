// Settings › Translation in a conversation (board docs/mocks/session-translation/01-board.png,
// frames 4–6): the foot under a translated message, its per-message Show original toggle, and the
// held and failed states. The server translates; these only draw what it wrote and call its doors.
import {
  DEFAULT_AGENT_LANGUAGE,
  translationFailureSentence,
  type ApprovalTranslation,
  type ReplyTranslation,
  type TranslationFailureReason,
  type TranslationLanguage,
  type TurnTranslation,
} from '@orbit/shared';
import { QueryClientContext } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { meQuery, type Me } from '../lib/queries';
import {
  answerRefusedUntranslated,
  ownerLanguageTranslation,
  refusalReasonOf,
  sentToAgentLabel,
  TRANSLATION_COPY as COPY,
} from '../lib/translation';

/** What the open conversation can do about a translation, provided by WorkspaceView. `on` is the
 *  account's switch with the server able to translate: a reply streaming then is greyed (2A). */
export interface TranslationActions {
  on: boolean;
  /** "Show both languages" (02-bilingual.png): a translated message also shows its agent-language
   *  text, and its foot loses the flip. Absent = off, today's UI. */
  bilingual?: boolean;
  /** "Agents work in": the language that text is in. Absent = DEFAULT_AGENT_LANGUAGE. */
  agentLanguage?: TranslationLanguage;
  retryTurn: (turnId: string) => Promise<unknown>;
  sendAsWritten: (turnId: string) => Promise<unknown>;
  /** Withdraw a held message that failed to translate; its words go back to the composer. Absent, or
   *  `canCancelTurn` false (a session's opening prompt, which the server keeps), draws no Cancel. */
  cancelTurn?: (turnId: string) => Promise<unknown>;
  canCancelTurn?: (turnId: string) => boolean;
  retryReply: (seq: number) => Promise<unknown>;
}

export const TranslationCtx = createContext<TranslationActions | null>(null);

/** The owner-language text of the session's question cards, by the call's tool_use id
 *  (ApprovalInfo.translation): an answered question's record shows what its card showed. */
export const QuestionTranslationsCtx = createContext<ReadonlyMap<string, ApprovalTranslation>>(new Map());

/** Which messages are flipped to their original, by key. Per message and never persisted: a reload
 *  shows every one translated again (board frame 5). Held by the transcript, so the turn's copy
 *  button copies the version on screen. */
interface ShownOriginal {
  has: (key: string) => boolean;
  toggle: (key: string) => void;
}

const ShownOriginalCtx = createContext<ShownOriginal | null>(null);

export function ShownOriginalProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const value = useMemo<ShownOriginal>(() => ({ has: (key) => keys.has(key), toggle }), [keys, toggle]);
  return <ShownOriginalCtx.Provider value={value}>{children}</ShownOriginalCtx.Provider>;
}

/** Whether this message shows its original, and the flip. Outside a transcript (a queued row) the
 *  state is the component's own. */
export function useShownOriginal(key: string): [boolean, () => void] {
  const shared = useContext(ShownOriginalCtx);
  const [local, setLocal] = useState(false);
  if (shared) return [shared.has(key), () => shared.toggle(key)];
  return [local, () => setLocal((v) => !v)];
}

export const userTranslationKey = (seq: number, turnId?: string) => `user:${turnId ?? seq}`;
export const replyTranslationKey = (seq: number) => `reply:${seq}`;
/** "Show both languages": a reply whose original the owner hid, leaving the translation alone. */
export const replyOriginalHiddenKey = (seq: number) => `reply-hidden:${seq}`;
/** "Show both languages": the owner's message whose English they hid, leaving what they wrote. */
export const userOriginalHiddenKey = (seq: number, turnId?: string) => `user-hidden:${turnId ?? seq}`;

/** Whether the turn's copy button reads a reply's original, for TurnFoot. */
export function useReplyShownOriginal(seq: number | undefined): boolean {
  const shared = useContext(ShownOriginalCtx);
  const bilingual = useContext(TranslationCtx)?.bilingual === true;
  return !bilingual && seq !== undefined && !!shared?.has(replyTranslationKey(seq));
}

/** A link-styled action at the foot; disabled while its request is out. */
function FootAction({ label, onPress }: { label: string; onPress?: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="chat-translate-action"
      disabled={busy || !onPress}
      onClick={() => {
        if (!onPress) return;
        setBusy(true);
        void onPress().finally(() => setBusy(false));
      }}
    >
      {label}
    </button>
  );
}

const Sep = () => <span className="chat-translate-sep">·</span>;

/**
 * The owner's message: "Show original" ↔ "Show translation" once delivered (with both languages on,
 * "Sent to the agent in English · Hide original" ↔ "· Show both"), the press alone after
 * the copy button and time (docs/mocks/translation-foot-one-line, B); the "Translating…" chip while held; and, held because the translation
 * failed (1A), "Couldn't translate, so it wasn't sent · Retry · Send as written · Cancel" — the first sentence saying why
 * when the turn carries `failureReason` (docs/ux/translation-failure-policy.html, frames 4B and 7).
 */
export function UserTranslationFoot({
  translation,
  turnId,
  flipped,
  onFlip,
  originalHidden = false,
  onHideOriginal,
}: {
  translation: TurnTranslation;
  turnId?: string;
  flipped: boolean;
  onFlip: () => void;
  /** "Show both languages": whether the English under their words is hidden, and its toggle. */
  originalHidden?: boolean;
  onHideOriginal?: () => void;
}) {
  const actions = useContext(TranslationCtx);
  switch (translation.state) {
    case 'TRANSLATING':
      return (
        <span className="chat-translate-foot">
          <span className="chat-translate-chip">{COPY.translating}</span>
        </span>
      );
    case 'FAILED': {
      const cancelTurn = actions?.cancelTurn;
      return (
        <span className="chat-translate-foot is-error">
          <span>{translationFailureSentence('message', translation.failureReason, translation.httpStatus)}</span>
          <Sep />
          <FootAction label={COPY.retry} onPress={actions && turnId ? () => actions.retryTurn(turnId) : undefined} />
          <Sep />
          <FootAction
            label={COPY.sendAsWritten}
            onPress={actions && turnId ? () => actions.sendAsWritten(turnId) : undefined}
          />
          {cancelTurn && turnId && actions?.canCancelTurn?.(turnId) && (
            <>
              <Sep />
              <FootAction label={COPY.cancel} onPress={() => cancelTurn(turnId)} />
            </>
          )}
        </span>
      );
    }
    case 'DONE':
      // Both languages on: the English is in the bubble, so there is nothing to flip to.
      if (actions?.bilingual) {
        return (
          <span className="chat-translate-foot is-hover">
            {sentToAgentLabel(actions.agentLanguage ?? DEFAULT_AGENT_LANGUAGE)}
            {onHideOriginal && (
              <>
                <Sep />
                <button type="button" className="chat-translate-action" onClick={onHideOriginal}>
                  {originalHidden ? COPY.showBoth : COPY.hideOriginal}
                </button>
              </>
            )}
          </span>
        );
      }
      return (
        <span className="chat-translate-foot is-hover">
          <button type="button" className="chat-translate-action" onClick={onFlip}>
            {flipped ? COPY.showTranslation : COPY.showOriginal}
          </button>
        </span>
      );
    default:
      return null;
  }
}

/**
 * An approval card whose answer the server could not translate, so nothing was recorded (1A): the
 * same "Couldn't translate, so it wasn't sent · Retry · Send as written" as a held message; with the refusal's
 * `failureReason`, the first sentence says why and names "your answer" (policy board frame 5).
 */
export function UntranslatedDecisionFoot({
  onRetry,
  onSendAsWritten,
  failureReason,
  httpStatus,
}: {
  onRetry: () => Promise<unknown>;
  onSendAsWritten: () => Promise<unknown>;
  failureReason?: TranslationFailureReason;
  httpStatus?: number;
}) {
  return (
    <span className="chat-translate-foot is-error approval-untranslated" role="alert">
      <span>{translationFailureSentence('answer', failureReason, httpStatus)}</span>
      <Sep />
      <FootAction label={COPY.retry} onPress={onRetry} />
      <Sep />
      <FootAction label={COPY.sendAsWritten} onPress={onSendAsWritten} />
    </span>
  );
}

/**
 * An agent reply: "Translated · Show original" ↔ "Original · Show translation", or with both
 * languages on "Translated · Hide original" ↔ "Translated · Show both"; failed (2A),
 * "Couldn't translate this reply · Retry"; still to be translated, the chip "Translates when the
 * reply is done". The flip is drawn at the end of the reply's last line, shown on hover, and always
 * while the original is on screen (docs/mocks/translation-reply-hover): the transcript hands it to
 * the reply's markdown as its tail.
 */
export function ReplyTranslationFoot({
  translation,
  pending,
  seq,
  flipped,
  onFlip,
  originalHidden = false,
  onHideOriginal,
}: {
  translation?: ReplyTranslation;
  pending?: boolean;
  seq?: number;
  flipped: boolean;
  onFlip: () => void;
  /** "Show both languages": whether the original under the translation is hidden, and its toggle. */
  originalHidden?: boolean;
  onHideOriginal?: () => void;
}) {
  const actions = useContext(TranslationCtx);
  if (translation?.failed) {
    return (
      <div className="chat-translate-foot is-reply is-error">
        <span>{COPY.replyFailed}</span>
        <Sep />
        <FootAction label={COPY.retry} onPress={actions && seq !== undefined ? () => actions.retryReply(seq) : undefined} />
      </div>
    );
  }
  if (translation?.text !== undefined && actions?.bilingual) {
    return (
      <div className="chat-translate-foot is-reply">
        <span>{COPY.translated}</span>
        {onHideOriginal && (
          <>
            <Sep />
            <button type="button" className="chat-translate-action" onClick={onHideOriginal}>
              {originalHidden ? COPY.showBoth : COPY.hideOriginal}
            </button>
          </>
        )}
      </div>
    );
  }
  if (translation?.text !== undefined) {
    return (
      <span className={flipped ? 'chat-translate-foot is-reply is-tail is-flipped' : 'chat-translate-foot is-reply is-tail'}>
        <span>{flipped ? COPY.original : COPY.translated}</span>
        <Sep />
        <button type="button" className="chat-translate-action" onClick={onFlip}>
          {flipped ? COPY.showTranslation : COPY.showOriginal}
        </button>
      </span>
    );
  }
  if (pending) {
    return (
      <div className="chat-translate-foot is-reply">
        <span className="chat-translate-chip">{COPY.replyPending}</span>
      </div>
    );
  }
  return null;
}

/**
 * One of Orbit's own cards drawn in the owner's language (board 04-owner-cards.html, mark A): one
 * flip for the whole card, "Translated · Show original" ↔ "Original · Show translation", under its
 * body. The card is wholly one language or the other, never half.
 */
export function CardTranslationFoot({ flipped, onFlip }: { flipped: boolean; onFlip: () => void }) {
  return (
    <div className="chat-translate-foot is-card">
      <span>{flipped ? COPY.original : COPY.translated}</span>
      <Sep />
      <button type="button" className="chat-translate-action" onClick={onFlip}>
        {flipped ? COPY.showTranslation : COPY.showOriginal}
      </button>
    </div>
  );
}

/** The signed-in account as the app shell's read left it in the cache, never fetched here. */
const noSubscription = () => () => {};
function useCachedMe(): Me | undefined {
  // A card drawn outside a QueryClientProvider (a static render) reads as no account: the original.
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => (client ? client.getQueryCache().subscribe(onChange) : noSubscription()),
    [client],
  );
  const read = () => client?.getQueryData<Me>(meQuery().queryKey);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * An owner card that lives outside a session (board 04-owner-cards.html, frames 2–3; decision 4A):
 * the server's `translation` while the card is drawn translated, undefined while it is flipped to
 * the original or there is none in the owner's language, and the card's one foot.
 * Decision 4A: one language at a time, with Show both languages on too.
 */
export function useOwnerCardTranslation<T extends { lang: TranslationLanguage; failed?: true }>(
  translation: T | null | undefined,
): { shown: T | undefined; foot: ReactNode } {
  const flip = useOwnerCardFlip(translation);
  return { shown: flip.pick(translation), foot: flip.foot };
}

/**
 * A list row's `translation` when it is usable — in the owner's language, translation on, not failed —
 * and undefined otherwise. A row has no flip of its own: the card it opens offers Show original.
 */
export function useOwnerLanguageTranslation<T extends { lang: TranslationLanguage; failed?: true }>(
  translation: T | null | undefined,
): T | undefined {
  return ownerLanguageTranslation(translation, useCachedMe());
}

type AnyCardTranslation = { lang: TranslationLanguage; failed?: true } | null | undefined;

/**
 * A card whose agent-written words come in several translations (a confirmation's report, review and
 * problems): one flip for all of them, drawn while any is in the owner's language. `pick` gives a
 * translation while the card is drawn translated and undefined otherwise.
 */
export function useOwnerCardFlip(...translations: AnyCardTranslation[]): {
  pick: <T extends { lang: TranslationLanguage; failed?: true }>(t: T | null | undefined) => T | undefined;
  foot: ReactNode;
} {
  const me = useCachedMe();
  const [flipped, setFlipped] = useState(false);
  const any = translations.some((t) => ownerLanguageTranslation(t, me) !== undefined);
  return {
    pick: (t) => (any && !flipped ? ownerLanguageTranslation(t, me) : undefined),
    foot: any ? <CardTranslationFoot flipped={flipped} onFlip={() => setFlipped((v) => !v)} /> : null,
  };
}

/**
 * An owner card's answer the server refused 422 TRANSLATION_FAILED, so nothing was recorded (2A):
 * "Couldn't translate, so it wasn't sent · Retry · Send as written", each press posting the same
 * answer again, Send as written with `sendAsWritten: true`. `error` is the refusal, which says why.
 */
export function RefusedAnswerFoot({
  resend,
  error,
}: {
  resend: (sendAsWritten: boolean) => Promise<unknown>;
  error?: unknown;
}) {
  // A press that fails again is drawn by the card from its own state; nothing here rethrows.
  const press = (sendAsWritten: boolean) => () => resend(sendAsWritten).catch(() => undefined);
  return <UntranslatedDecisionFoot onRetry={press(false)} onSendAsWritten={press(true)} {...refusalReasonOf(error)} />;
}

/**
 * A send-back finished at the composer (an owner confirmation's or an evidence card's "Chat about
 * this") that the door refused 422 TRANSLATION_FAILED: the refusal with Retry and Send as written,
 * each posting the same press again. Nothing while the last press was not refused, or `when` says
 * it belongs to another conversation.
 */
export function RefusedSendBack<V extends object>({
  mutation,
  when = () => true,
}: {
  mutation: {
    isError: boolean;
    error: unknown;
    variables: V | undefined;
    mutateAsync: (press: V & { sendAsWritten?: boolean }) => Promise<unknown>;
  };
  when?: (press: V) => boolean;
}) {
  const press = mutation.variables;
  if (!mutation.isError || !press || !answerRefusedUntranslated(mutation.error) || !when(press)) return null;
  return (
    <div className="composer-translate-refused">
      <RefusedAnswerFoot resend={(sendAsWritten) => mutation.mutateAsync({ ...press, sendAsWritten })} error={mutation.error} />
    </div>
  );
}
