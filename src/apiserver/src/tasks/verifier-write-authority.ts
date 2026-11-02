import { toUuid } from '@orbit/shared';

/**
 * Who may write the verification relation.
 *
 * `verifiesTaskId` says how a task is settled and, since a verifier reads the files its subject's evidence cites
 * (`sessionJudgesEvidence`), who reads those files too. So it is written by those who answer for the work as a whole: the
 * account owner, the project's coordinator and its judgment sessions. A run answers for its own task, and a task's own run
 * keeps what it had: a verifier writes its own verdict.
 *
 * A run may therefore not make another task a verifier, nor write any field of another task that is one. Any field rather
 * than a list of them: no flow has a run edit another task's check, and a verifier's instructions, standard, engine and
 * verdict each decide what its answer is worth. An ordinary sibling is still a run's to edit, and a conversation of no task
 * is the scope contract's question, as it was.
 *
 * A run does file a verifier of its own on the owner's yes: the MCP tools and the CLI raise a card before they write. That
 * card is the authority, so the door that files one checks for it, as the delete routes do (`requireDeleteApproval`).
 */

export const VERIFIER_WRITE_FROM_RUN_REFUSED_CODE = 'VERIFIER_WRITE_FROM_RUN_REFUSED';
export const VERIFIER_WRITE_FROM_RUN_REFUSED_ACTION = 'ASK_THE_COORDINATOR_OR_THE_OWNER';

export const VERIFIER_CREATE_NEEDS_OWNER_CARD_CODE = 'VERIFIER_CREATE_NEEDS_OWNER_CARD';
export const VERIFIER_CREATE_NEEDS_OWNER_CARD_ACTION = 'ASK_THROUGH_TASK_CREATE';

/** The tool names runner-go files the two create cards under (`askBeforeTaskCreate`, `askBeforeBatch`). */
export const TASK_CREATE_CARD_TOOL = 'orbit_task_create';
export const TASK_BATCH_CARD_TOOL = 'orbit_task_batch';

export function verifierWriteFromRunRefusalBody() {
  return {
    code: VERIFIER_WRITE_FROM_RUN_REFUSED_CODE,
    kind: 'REFUSAL',
    requiredAction: VERIFIER_WRITE_FROM_RUN_REFUSED_ACTION,
    message:
      'this session is a run of another task, and a run may not make a task a verifier or change any field of a task '
      + 'that is one. Nothing was written. The account owner can make this edit, and so can the project\'s coordinator '
      + 'or a judgment session when the task is in a project; a verifier\'s own run writes its own verdict. Ask one of them.',
  };
}

export function verifierCreateNeedsOwnerCardBody() {
  return {
    code: VERIFIER_CREATE_NEEDS_OWNER_CARD_CODE,
    kind: 'REFUSAL',
    requiredAction: VERIFIER_CREATE_NEEDS_OWNER_CARD_ACTION,
    message:
      'a run files a verification task only on the account owner\'s yes, and no answered confirmation card in this '
      + 'conversation covers this one. Nothing was written. task_create and task_create_batch (orbit task create, orbit '
      + 'task create-batch) put the card in front of them; the project\'s coordinator can also file it.',
  };
}

/**
 * Every verifier a create names, each as what makes it that verifier: the subject it checks and what it is called, which
 * is what the owner read on the card. Card and request are both read through this, the card as the asker sent it and the
 * request as the DTO left it, so an id counts the same in either spelling.
 */
export function verifiersNamedBy(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (isRecord(item.verification)) return [JSON.stringify(['pair', item.title, item.verification.title])];
    if (typeof item.verifiesTaskId === 'string') {
      return [JSON.stringify(['task', uuidOrAsSpelled(item.verifiesTaskId), item.title])];
    }
    if (typeof item.verifiesRef === 'string') return [JSON.stringify(['ref', item.verifiesRef, item.title])];
    return [];
  });
}

/** Whether one card, with its stored input, names every verifier this create names. */
export function cardCoversVerifiers(toolName: string, input: unknown, verifiers: readonly string[]): boolean {
  const items = toolName === TASK_BATCH_CARD_TOOL
    ? (isRecord(input) && Array.isArray(input.tasks) ? input.tasks : [])
    : [input];
  const named = new Set(verifiersNamedBy(items));
  return verifiers.every((verifier) => named.has(verifier));
}

function uuidOrAsSpelled(id: string): string {
  try {
    return toUuid(id);
  } catch {
    return id;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
