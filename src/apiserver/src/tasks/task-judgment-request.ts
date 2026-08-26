import type { TaskCompletionCriterionValue } from './task-completion-criterion';

/** N6 scans this declaration and requires the concrete exit below to stay registered. */
export const OPEN_JUDGMENT_REQUEST_SIGNAL_CODE = 'OPEN_JUDGMENT_REQUEST';

export type JudgmentRecipientType =
  | 'SYSTEM_EXECUTABLE_EVALUATOR'
  | 'VERIFIER_TASK'
  | 'ACCOUNT_OWNER';

export interface JudgmentRouteContext {
  ownerId: string;
  sourceSessionId: string;
  /** VERIFICATION uses this as the deterministic id of its independent verifier Task. */
  requestId: string;
}

export interface JudgmentRoute {
  kind: TaskCompletionCriterionValue;
  recipientType: JudgmentRecipientType;
  recipientId: string;
}

/**
 * Select exactly one peer consumer from the declared criterion.
 *
 * There is intentionally no default and no ordered list to try: an unavailable executable
 * evaluator remains an EXECUTABLE request, and an unavailable verifier remains VERIFICATION.
 * Neither silently becomes a HUMAN_SIGNOFF request.
 */
export function routeTaskJudgment(
  kind: TaskCompletionCriterionValue,
  context: JudgmentRouteContext,
): JudgmentRoute {
  switch (kind) {
    case 'EXECUTABLE':
      return {
        kind,
        recipientType: 'SYSTEM_EXECUTABLE_EVALUATOR',
        recipientId: context.sourceSessionId,
      };
    case 'VERIFICATION':
      return {
        kind,
        recipientType: 'VERIFIER_TASK',
        recipientId: context.requestId,
      };
    case 'HUMAN_SIGNOFF':
      return {
        kind,
        recipientType: 'ACCOUNT_OWNER',
        recipientId: context.ownerId,
      };
  }
}
