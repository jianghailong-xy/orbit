import { useEffect, useState } from 'react';
import type { ApprovalTranslation } from '@orbit/shared';
import { listQuestionApprovals, type ApprovalInfo } from '../api';

type Translations = ReadonlyMap<string, ApprovalTranslation>;

const NONE: Translations = new Map();

/** Add each question card's translation to `into`, by its call's tool_use id. */
function withCards(into: Translations, cards: readonly ApprovalInfo[]): Translations {
  const found = cards.filter((a) => a.toolName === 'AskUserQuestion' && a.toolUseId && a.translation);
  if (found.every((a) => into.get(a.toolUseId!) === a.translation)) return into;
  const next = new Map(into);
  for (const a of found) next.set(a.toolUseId!, a.translation!);
  return next;
}

/**
 * Settings › Translation (3A) after the answer: the owner-language text of the session's question
 * cards, by tool_use id, so an answered question's record shows what its card showed. A card leaves
 * the live `approvals` once it is decided, so its translation is kept here as it passes, and the ones
 * decided before this view opened are read once from the server. Empty while translation is off.
 */
export function useQuestionTranslations(sessionId: string | null, approvals: readonly ApprovalInfo[], on: boolean): Translations {
  const [held, setHeld] = useState<{ sessionId: string | null; map: Translations }>({ sessionId, map: NONE });
  const map = held.sessionId === sessionId ? held.map : NONE;

  useEffect(() => {
    if (!on || !sessionId) return;
    let live = true;
    listQuestionApprovals(sessionId).then(
      (cards) => {
        if (live) setHeld((h) => ({ sessionId, map: withCards(h.sessionId === sessionId ? h.map : NONE, cards) }));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sessionId, on]);

  useEffect(() => {
    if (!on) return;
    setHeld((h) => {
      const base = h.sessionId === sessionId ? h.map : NONE;
      const next = withCards(base, approvals.filter((a) => a.sessionId === sessionId));
      return next === base && h.sessionId === sessionId ? h : { sessionId, map: next };
    });
  }, [sessionId, approvals, on]);

  return on ? map : NONE;
}
