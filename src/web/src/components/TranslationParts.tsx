// Settings › Translation in a conversation (board docs/mocks/session-translation/01-board.png,
// frames 4–6): the foot under a translated message, its per-message Show original toggle, and the
// held and failed states. The server translates; these only draw what it wrote and call its doors.
import { DEFAULT_AGENT_LANGUAGE, type ReplyTranslation, type TranslationLanguage, type TurnTranslation } from '@orbit/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { sentToAgentLabel, TRANSLATION_COPY as COPY } from '../lib/translation';

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
  retryReply: (seq: number) => Promise<unknown>;
}

export const TranslationCtx = createContext<TranslationActions | null>(null);

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
 * The owner's message: "Show original" ↔ "Show translation" once delivered, the press alone after
 * the copy button and time (docs/mocks/translation-foot-one-line, B); the "Translating…" chip while held; and, held because the translation
 * failed (1A), "Couldn't translate, so it wasn't sent · Retry · Send as written".
 */
export function UserTranslationFoot({
  translation,
  turnId,
  flipped,
  onFlip,
}: {
  translation: TurnTranslation;
  turnId?: string;
  flipped: boolean;
  onFlip: () => void;
}) {
  const actions = useContext(TranslationCtx);
  switch (translation.state) {
    case 'TRANSLATING':
      return (
        <span className="chat-translate-foot">
          <span className="chat-translate-chip">{COPY.translating}</span>
        </span>
      );
    case 'FAILED':
      return (
        <span className="chat-translate-foot is-error">
          <span>{COPY.sendFailed}</span>
          <Sep />
          <FootAction label={COPY.retry} onPress={actions && turnId ? () => actions.retryTurn(turnId) : undefined} />
          <Sep />
          <FootAction
            label={COPY.sendAsWritten}
            onPress={actions && turnId ? () => actions.sendAsWritten(turnId) : undefined}
          />
        </span>
      );
    case 'DONE':
      // Both languages on: the English is in the bubble, so there is nothing to flip to.
      if (actions?.bilingual) {
        return <span className="chat-translate-foot is-hover">{sentToAgentLabel(actions.agentLanguage ?? DEFAULT_AGENT_LANGUAGE)}</span>;
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
 * same "Couldn't translate, so it wasn't sent · Retry · Send as written" as a held message.
 */
export function UntranslatedDecisionFoot({
  onRetry,
  onSendAsWritten,
}: {
  onRetry: () => Promise<unknown>;
  onSendAsWritten: () => Promise<unknown>;
}) {
  return (
    <span className="chat-translate-foot is-error approval-untranslated" role="alert">
      <span>{COPY.sendFailed}</span>
      <Sep />
      <FootAction label={COPY.retry} onPress={onRetry} />
      <Sep />
      <FootAction label={COPY.sendAsWritten} onPress={onSendAsWritten} />
    </span>
  );
}

/**
 * An agent reply: "Translated · Show original" ↔ "Original · Show translation"; failed (2A),
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
}: {
  translation?: ReplyTranslation;
  pending?: boolean;
  seq?: number;
  flipped: boolean;
  onFlip: () => void;
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
