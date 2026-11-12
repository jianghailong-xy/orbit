// Posting the owner's answer to an approval card, for every view that draws the cards.
import { TRANSLATION_FAILED_CODE } from '@orbit/shared';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { ApiError, decideApproval, listApprovals, type ApprovalInfo, type PermissionRule } from '../api';

/** A decision as it was pressed: what Retry and Send as written post again. */
export interface HeldDecision {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string[]>;
  message?: string;
  rememberRules?: PermissionRule[];
  startAfterCreate?: boolean;
}

/** The refusal of a decision whose owner's words could not be translated: nothing was recorded (1A). */
export function refusedUntranslated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 422 && err.code === TRANSLATION_FAILED_CODE;
}

/**
 * Allow/deny a pending approval: drop it at once (the approval_resolved SSE also removes it) and
 * re-fetch to resync on failure. A decision refused 422 TRANSLATION_FAILED is held by approval id,
 * so the card that comes back keeps the answer and offers Retry / Send as written (Settings ›
 * Translation, 1A) — the same as iOS/macOS (`untranslatedDecisions`) and Android.
 */
export function useApprovalDecisions(
  sessionId: string | null | undefined,
  setApprovals: Dispatch<SetStateAction<ApprovalInfo[]>>,
) {
  const [untranslated, setUntranslated] = useState<Record<string, HeldDecision>>({});
  const decide = async (
    approvalId: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    message?: string,
    rememberRules?: PermissionRule[],
    startAfterCreate?: boolean,
    sendAsWritten?: boolean,
  ): Promise<void> => {
    if (!sessionId) return;
    setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
    try {
      await decideApproval(sessionId, approvalId, behavior, message, answers, rememberRules, startAfterCreate, sendAsWritten);
      setUntranslated((prev) => {
        if (!(approvalId in prev)) return prev;
        const rest = { ...prev };
        delete rest[approvalId];
        return rest;
      });
    } catch (err) {
      if (refusedUntranslated(err)) {
        setUntranslated((prev) => ({ ...prev, [approvalId]: { behavior, answers, message, rememberRules, startAfterCreate } }));
      }
      listApprovals(sessionId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };
  return { decide, untranslated };
}
