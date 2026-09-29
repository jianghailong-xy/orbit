/**
 * In an Automatic project an agent does not hand a task back to the account owner.
 *
 * OWNER_CONFIRMED is settled by the account owner pressing Confirm done in the app and by nobody
 * else, a coordinator included (`task-owner-confirmation.ts`). That is the right shape for the few
 * results that genuinely need them — a deploy, a DROP or a destroyed dataset, something checked on
 * their own device or account — and the wrong one for everything else in a project whose owner
 * switched Automatic on (`project.coordinatorEnabled`), which is the owner saying the coordinator
 * settles the work from here. Any session could declare it anyway: from 2026-09-14 to 2026-09-29
 * agents filed 35 OWNER_CONFIRMED tasks in Automatic projects, the owner confirmed every one of
 * them by hand, and about ten needed the owner at all. One field pulled the owner back into the
 * loop they had just stepped out of.
 *
 * WHERE THE OWNER'S SAY COMES IN INSTEAD
 * --------------------------------------
 * Through the ruler. A project's acceptance criteria are the owner's — editing and confirming them
 * are the HUMAN_ONLY rows of `coordinator-authority.ts` — so a criterion whose `verificationMethod`
 * starts with `OWNER_CONFIRMED` is the owner saying "this result I judge myself", and work serving
 * that criterion may declare OWNER_CONFIRMED. Work serving a criterion that says no such thing, or
 * serving none, is the coordinator's to settle: EVIDENCE_JUDGMENT, decided with
 * `task_evidence_decide`, or EXECUTABLE. A trade-off only the owner can make is a question
 * (`ask_owner`), and a release or an irreversible step is authorised in advance the same way;
 * neither needs the task itself to wait on the owner.
 *
 * WHO IT BINDS
 * ------------
 * A write that carries an acting session — the runner-injected `X-Orbit-Session-Id`, which the
 * service receives as `creatorSessionId` on a create and `actingSessionId` on an update — whatever
 * that session's role. The owner in the app, over the user API or in their own terminal carries
 * none and is not asked: the rule is about an agent speaking for the owner. As everywhere else,
 * a request without the header is not proof that a person made it.
 *
 * WHAT IT JUDGES
 * --------------
 * The task as the write LEAVES it — its criterion, its project, the criterion it serves — the way
 * the criterion-change door judges the merged declaration rather than the fields as spelled. A
 * create is always judged; an update only when it moves one of those three, so rows that already
 * exist are not rewritten and stay editable: a run reporting FAILED, a rename, or re-declaring the
 * criterion key a task already serves declares nothing new.
 */

export const OWNER_CONFIRMATION_NOT_DELEGATED_CODE = 'OWNER_CONFIRMATION_NOT_DELEGATED';
export const OWNER_CONFIRMATION_NOT_DELEGATED_ACTION = 'DECLARE_A_CRITERION_THE_COORDINATOR_SETTLES';

/** How a project criterion's `verificationMethod` begins when it asks for the owner's own say. */
export const OWNER_CONFIRMED_VERIFICATION_PREFIX = 'OWNER_CONFIRMED';

/** Whether a criterion asks the account owner to confirm the work serving it. */
export function criterionAsksForOwnerConfirmation(
  verificationMethod: string | null | undefined,
): boolean {
  return (verificationMethod ?? '').trimStart().startsWith(OWNER_CONFIRMED_VERIFICATION_PREFIX);
}

/**
 * The refusal, in the shape the task doors beside it answer with.
 *
 * `servedCriterionKey` is the criterion the task would serve, or null when it serves none of the
 * project's; `itemIndex` is the batch item, or null on a single create or an update.
 */
export function ownerConfirmationNotDelegatedBody(
  servedCriterionKey: string | null,
  itemIndex: number | null,
) {
  const served = servedCriterionKey
    ? `the project criterion it serves (${servedCriterionKey}) does not ask for that: its `
      + 'verificationMethod does not start with OWNER_CONFIRMED'
    : 'it serves none of the project’s acceptance criteria';
  return {
    code: OWNER_CONFIRMATION_NOT_DELEGATED_CODE,
    kind: 'REFUSAL',
    requiredAction: OWNER_CONFIRMATION_NOT_DELEGATED_ACTION,
    itemIndex,
    message:
      'This project is Automatic (coordinatorEnabled), so whether its tasks are done is settled by '
      + 'its coordinator, not by the account owner confirming each one. A session cannot declare '
      + `OWNER_CONFIRMED here unless the criterion the task serves asks for the owner, and ${served}. `
      + 'Nothing was written. Declare EVIDENCE_JUDGMENT instead, which the coordinator decides on the '
      + 'submitted evidence with task_evidence_decide, or EXECUTABLE. A trade-off only the owner can '
      + 'make is a question for ask_owner, and a release or an irreversible step (a deploy, a DROP, '
      + 'destroying data) needs their authorisation in advance through ask_owner. If the owner '
      + 'genuinely has to judge this result in person, propose changing the verificationMethod of '
      + 'the project criterion this work serves (criterionKey) so that it starts with '
      + 'OWNER_CONFIRMED: that rewrites the project’s acceptance criteria, so it is held as a '
      + 'proposal for the owner to decide, and work serving the criterion may declare '
      + 'OWNER_CONFIRMED once they accept it.',
  } as const;
}
