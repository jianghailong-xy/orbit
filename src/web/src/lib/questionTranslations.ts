import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalTranslation } from '@orbit/shared';
import type { SessionReach } from './sessionReach';
import { listQuestionApprovals, type ApprovalInfo } from '../api';
import { LIVE_FALLBACK_MS } from './listBudget';

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

/** The one cache of a session's question translations, whoever on the page reads them. */
const translationsKey = (sessionId: string | null) => ['session-question-translations', sessionId] as const;

/**
 * Settings › Translation (3A) after the answer: the owner-language text of the session's question
 * cards, by tool_use id, so an answered question's record shows what its card showed. A card leaves
 * the live `approvals` once it is decided, so its translation is kept here as it passes, and the ones
 * decided before this view opened are read from the server. Empty while translation is off.
 *
 * A decided question's translation never changes, so it is held in one session-keyed cache and not
 * read again when the session, or the translation setting, changes back: while the session is open,
 * the live approvals add what is new. A return to the session after the safety minute reads once more,
 * since a question raised and decided while this tab was on another session passed it by.
 */
export function useQuestionTranslations(sessionId: string | null, approvals: readonly ApprovalInfo[], on: boolean): Translations {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: translationsKey(sessionId),
    // A decided question never changes and the live approvals add what is new, so no session event reads it again.
    meta: { entities: ['session'], sessionReach: 'none' satisfies SessionReach },
    // Merged over what the live approvals added while the read was out.
    queryFn: async () => {
      const cards = await listQuestionApprovals(sessionId!);
      return withCards(qc.getQueryData<Translations>(translationsKey(sessionId)) ?? NONE, cards);
    },
    enabled: on && sessionId !== null,
    staleTime: LIVE_FALLBACK_MS,
  });

  useEffect(() => {
    if (!on || !sessionId) return;
    const key = translationsKey(sessionId);
    const base = qc.getQueryData<Translations>(key) ?? NONE;
    const next = withCards(base, approvals.filter((a) => a.sessionId === sessionId));
    if (next === base) return;
    // Kept at the read's own age: what a live card adds is not a read, and must not put off the next one.
    qc.setQueryData(key, next, { updatedAt: qc.getQueryState(key)?.dataUpdatedAt ?? 0 });
  }, [qc, sessionId, approvals, on]);

  return on && sessionId !== null ? data ?? NONE : NONE;
}
