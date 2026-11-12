// Settings › Translation in a conversation (board docs/mocks/session-translation/01-board.png,
// frames 4–6): the foot under a translated message, its per-message Show original toggle, and the
// held and failed states. The server translates; these only draw what it wrote and call its doors.
import type { ReplyTranslation, TurnTranslation } from '@orbit/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { TRANSLATION_COPY as COPY } from '../lib/translation';

/** What the open conversation can do about a translation, provided by WorkspaceView. `on` is the
 *  account's switch with the server able to translate: a reply streaming then is greyed (2A). */
export interface TranslationActions {
  on: boolean;
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
  return seq !== undefined && !!shared?.has(replyTranslationKey(seq));
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
 * The owner's message: "Translated · Show original" ↔ "Sent to the agent in English · Show
 * translation" once delivered; the "Translating…" chip while held; and, held because the translation
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
      return (
        <span className="chat-translate-foot">
          <span>{flipped ? COPY.sentInEnglish : COPY.translated}</span>
          <Sep />
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
 * An agent reply: "Translated · Show original" ↔ "Original · Show translation"; failed (2A),
 * "Couldn't translate this reply · Retry"; still to be translated, the chip "Translates when the
 * reply is done".
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
  if (translation?.text !== undefined) {
    return (
      <div className="chat-translate-foot is-reply">
        <span>{flipped ? COPY.original : COPY.translated}</span>
        <Sep />
        <button type="button" className="chat-translate-action" onClick={onFlip}>
          {flipped ? COPY.showTranslation : COPY.showOriginal}
        </button>
      </div>
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
