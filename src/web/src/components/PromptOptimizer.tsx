import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TRANSLATION_LANGUAGE_NAMES,
  type PromptOptimization,
  type PromptOptimizationContextUsed,
  type PromptOptimizationRequest,
} from '@orbit/shared';
import { optimizePrompt, type OptimizedSend } from '../api';
import { meQuery } from '../lib/queries';
import { translationLanguageOf } from '../lib/translation';
import { showToast } from '../lib/toastStore';

/**
 * The composer's prompt optimizer (docs/prompt-optimizer-design.md, board
 * docs/mocks/prompt-optimizer/01-board.png, frames 2–6): ✦ Optimize beside Send, a suggestion card above
 * the composer, and nothing in the box changes until the owner presses Use or Edit, then use.
 */

/** Where a draft's context comes from: a session supplies its own; a new draft names its workspace. */
export type PromptOptimizerTarget = Omit<PromptOptimizationRequest, 'draft'> & {
  /** What Use just put in the box, or null when the owner's own text is back (Undo). The send compares
   *  against it (D2): unedited, it goes as optimizedSendOf says. */
  onInserted: (inserted: OptimizedInsert | null) => void;
};

/** What Use put in the box: the owner-language reading copy with the optimizer's agent-language prompt as
 *  its translation when Translation is on (D2), or the prompt alone. */
export interface OptimizedInsert {
  text: string;
  translation?: string;
}

/** The body fields a send of the unedited inserted text carries: its ready translation, or "send as written". */
export const optimizedSendOf = (inserted: OptimizedInsert): OptimizedSend =>
  inserted.translation !== undefined ? { optimizedTranslation: inserted.translation } : { skipTranslation: true };

/** D2: with Translation on the box gets the owner's language, and the agent the optimizer's own prompt. */
const insertOf = (result: PromptOptimization): OptimizedInsert =>
  result.gloss ? { text: result.gloss, translation: result.text } : { text: result.text };

type OptimizerState =
  | { kind: 'idle' }
  | { kind: 'busy'; draft: string }
  | { kind: 'card'; draft: string; result: PromptOptimization; flipped: boolean }
  | { kind: 'failed'; draft: string };

export const OPTIMIZE_SHORTCUT = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform)
  ? '⌘⇧O'
  : 'Ctrl⇧O';

/** A draft the optimizer has nothing to do with: only a `/command`. */
const onlyCommand = (draft: string): boolean => /^\/\S*$/.test(draft);

function usedLabel(used: PromptOptimizationContextUsed): string {
  switch (used.kind) {
    case 'TURNS':
      return `this session's last ${used.count} ${used.count === 1 ? 'turn' : 'turns'}`;
    case 'RECAP':
      return 'session recap';
    case 'PROJECT':
      return `project "${used.title}" goal`;
    case 'WIKI':
      return `${used.count} wiki ${used.count === 1 ? 'entry' : 'entries'}`;
    case 'WORKSPACE':
      return `workspace ${used.name}`;
  }
}

export function usePromptOptimizer({
  target,
  text,
  setText,
  taRef,
  shellMode,
  disabled,
  resetKey,
}: {
  target: PromptOptimizerTarget | undefined;
  text: string;
  setText: (text: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  shellMode: boolean;
  disabled: boolean;
  /** The conversation the composer is on: a new one drops whatever the old one was showing. */
  resetKey: string | null;
}) {
  const me = useQuery(meQuery());
  const on = !!target && me.data?.promptOptimizerAvailable === true && me.data?.preferences?.promptOptimizer !== false;
  const [state, setState] = useState<OptimizerState>({ kind: 'idle' });
  // The press now in flight; a cancel or a newer press makes its answer nobody's.
  const inFlight = useRef<AbortController | null>(null);
  // What Use replaced, while the box still holds what it put there (⌘Z and the toast's Undo).
  const undo = useRef<{ previous: string; inserted: string } | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const targetRef = useRef(target);
  targetRef.current = target;

  const cancel = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);
  useEffect(() => {
    cancel();
    undo.current = null;
    setState({ kind: 'idle' });
  }, [resetKey, cancel]);
  useEffect(() => cancel, [cancel]);

  const trimmed = text.trim();
  const busy = state.kind === 'busy';
  const buttonShown = on && !disabled && (busy || (trimmed !== '' && !shellMode && !onlyCommand(trimmed)));

  const start = useCallback(() => {
    const t = targetRef.current;
    const draft = textRef.current.trim();
    if (!t || !draft) return;
    cancel();
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ kind: 'busy', draft });
    const { onInserted: _onInserted, ...where } = t;
    optimizePrompt({ draft, ...where }, controller.signal).then(
      (result) => {
        if (inFlight.current !== controller) return;
        inFlight.current = null;
        setState({ kind: 'card', draft, result, flipped: false });
      },
      () => {
        if (inFlight.current !== controller) return;
        inFlight.current = null;
        setState({ kind: 'failed', draft });
      },
    );
  }, [cancel]);

  /** The button and the shortcut: optimize, or cancel the one under way. */
  const press = useCallback(() => {
    if (inFlight.current) {
      cancel();
      setState({ kind: 'idle' });
      return;
    }
    start();
  }, [cancel, start]);

  const dismiss = useCallback(() => setState({ kind: 'idle' }), []);

  const restore = useCallback(() => {
    const held = undo.current;
    if (!held || textRef.current !== held.inserted) return false;
    undo.current = null;
    setText(held.previous);
    targetRef.current?.onInserted(null);
    setTimeout(() => taRef.current?.focus(), 0);
    return true;
  }, [setText, taRef]);

  const use = useCallback(
    (edit: boolean) => {
      if (state.kind !== 'card') return;
      const insert = insertOf(state.result);
      const inserted = insert.text;
      undo.current = { previous: textRef.current, inserted };
      setText(inserted);
      targetRef.current?.onInserted(insert);
      setState({ kind: 'idle' });
      showToast({
        message: 'Draft replaced with the optimized prompt',
        tone: 'neutral',
        icon: 'undo',
        key: 'prompt-optimizer-use',
        action: { label: 'Undo', ariaLabel: 'Undo: put your draft back', onClick: () => void restore() },
      });
      setTimeout(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        if (edit) ta.selectionStart = ta.selectionEnd = ta.value.length;
      }, 0);
    },
    [state, setText, restore, taRef],
  );

  /** The composer box's keys, read before its own: the shortcut, ⌘Z after Use, and Esc on the card.
   *  True when the key was the optimizer's. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && !e.altKey && (e.code === 'KeyO' || e.key.toLowerCase() === 'o')) {
      if (!buttonShown) return false;
      e.preventDefault();
      press();
      return true;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && undo.current) {
      if (textRef.current !== undo.current.inserted) {
        undo.current = null;
        return false;
      }
      e.preventDefault();
      restore();
      return true;
    }
    if (e.key === 'Escape' && (state.kind === 'card' || state.kind === 'failed')) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return true;
    }
    return false;
  };

  const language = translationLanguageOf(me.data);
  return {
    on,
    state,
    busy,
    buttonShown,
    press,
    onKeyDown,
    card:
      state.kind === 'card' || state.kind === 'failed' ? (
        <PromptOptimizerCard
          state={state}
          earlier={state.draft !== trimmed}
          glossLanguage={TRANSLATION_LANGUAGE_NAMES[language]}
          onUse={() => use(false)}
          onEditUse={() => use(true)}
          onTryAgain={start}
          onDismiss={dismiss}
          onFlip={() => setState((s) => (s.kind === 'card' ? { ...s, flipped: !s.flipped } : s))}
        />
      ) : null,
  };
}

/** Frame 4 (the suggestion) and frame 6 (the failure), above the composer. */
function PromptOptimizerCard({
  state,
  earlier,
  glossLanguage,
  onUse,
  onEditUse,
  onTryAgain,
  onDismiss,
  onFlip,
}: {
  state: Extract<OptimizerState, { kind: 'card' } | { kind: 'failed' }>;
  earlier: boolean;
  glossLanguage: string;
  onUse: () => void;
  onEditUse: () => void;
  onTryAgain: () => void;
  onDismiss: () => void;
  onFlip: () => void;
}) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    }
  };
  if (state.kind === 'failed') {
    return (
      <div className="composer-optimize-failed" role="alert" onKeyDown={onKeyDown}>
        <span>Couldn't optimize this draft.</span>
        <button type="button" className="composer-optimize-link" onClick={onTryAgain}>
          Try again
        </button>
        <button type="button" className="composer-optimized-close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
    );
  }
  // D2: with a reading copy (Translation on) the card opens in the owner's language, as Use inserts it;
  // the link flips to the prompt the agent receives.
  const { result, flipped } = state;
  const glossShown = !flipped && !!result.gloss;
  return (
    <div className="composer-optimized" role="region" aria-label="Optimized prompt" onKeyDown={onKeyDown}>
      <div className="composer-optimized-head">
        <span className="composer-optimized-title">✦ Optimized prompt</span>
        {earlier && <span className="composer-optimized-earlier">Based on an earlier draft</span>}
        {result.gloss && (
          <button type="button" className="composer-optimize-link" onClick={onFlip}>
            {glossShown ? `Show in ${TRANSLATION_LANGUAGE_NAMES[result.language] ?? result.language}` : `Show in ${glossLanguage}`}
          </button>
        )}
        <button type="button" className="composer-optimized-close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
      <div className="composer-optimized-text">
        {glossShown
          ? result.gloss
          : result.segments.map((segment, i) =>
              segment.added ? (
                <mark key={i} className="composer-optimized-added">
                  {segment.text}
                </mark>
              ) : (
                <span key={i}>{segment.text}</span>
              ),
            )}
      </div>
      {result.contextUsed.length > 0 && (
        <div className="composer-optimized-used">
          <span className="composer-optimized-used-label">Used:</span>
          {result.contextUsed.map((used, i) => (
            <span key={i} className="composer-optimized-chip">
              {usedLabel(used)}
            </span>
          ))}
        </div>
      )}
      {result.gloss && (
        <div className="composer-optimized-agent-note">
          The agent receives the {TRANSLATION_LANGUAGE_NAMES[result.language] ?? result.language} version.
        </div>
      )}
      <div className="composer-optimized-actions">
        <button type="button" className="composer-optimized-use" onClick={onUse}>
          Use
        </button>
        <button type="button" className="composer-optimized-edit" onClick={onEditUse}>
          Edit, then use
        </button>
        <button type="button" className="composer-optimized-retry" onClick={onTryAgain}>
          Try again
        </button>
        <span className="composer-optimized-hint">Esc dismisses · your draft is kept</span>
      </div>
    </div>
  );
}
