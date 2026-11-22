/** Approved landing-check UI copy; native clients mirror these words. */
export const LANDING_CHECK_COPY = {
  LABEL: 'Landing check',
  CONFIRM_TITLE: 'Change project integration settings?',
  CONFIRM_ACTION: 'Confirm',
  COMMAND: 'Command',
  TIMEOUT: 'Timeout (seconds)',
  HINT: 'Runs when a task lands on the project branch.',
  INHERITS: 'Uses merge check',
  COMMAND_PLACEHOLDER: 'Leave blank to use merge check',
  INHERITS_TIMEOUT: 'Uses merge check timeout',
  TIMEOUT_PLACEHOLDER: 'Leave blank to use merge check timeout',
  TIMEOUT_HINT: 'Leave blank to use the merge check timeout.',
  MAIN: 'Not used when tasks land directly on main.',
  APPLIES: 'Applies to the next claimed landing job.',
  WAITING: 'Waiting for baseline fix',
  RESUMES: 'Landings resume automatically when this open item is resolved.',
  BASELINE_BODY: 'The project branch with the latest main fails its checks without this task.',
  HELD: 'Landings on hold',
  UPSTREAM: 'Upstream',
  TIP: 'Project tip',
  BASELINE: 'Combined baseline',
  VIEW_HELD: 'View held tasks',
} as const;
export const baselineTitle = (branch: string): string => `Baseline checks failing on ${branch}`;
export const inheritedLandingCommand = (command: string | null): string =>
  command === null ? LANDING_CHECK_COPY.INHERITS : `${LANDING_CHECK_COPY.INHERITS}: ${command}`;
export const inheritedLandingTimeout = (seconds: number | null): string =>
  seconds === null ? LANDING_CHECK_COPY.INHERITS_TIMEOUT : `${LANDING_CHECK_COPY.INHERITS_TIMEOUT}: ${seconds} seconds`;

export const baselineAttribution = (passed: boolean): string =>
  `Checked the project branch with main, without this task · ${passed ? 'passes' : 'also fails'}`;

// ── Revision 42 part two (docs/mocks/landing-measured, rulings D3–D7, D9) ─────────────────────

export type LandingCheckMode = 'MERGE_CHECK' | 'COMMAND' | 'NONE';

/** The landing check as the settings read it: `NONE` is its own value, a command is a command, and
 *  nothing set falls back to the merge check (§11 K1). */
export function landingCheckModeOf(
  view: { landingCheck?: { command: string | null } | null; landingCheckCommand: string | null },
): LandingCheckMode {
  const command = view.landingCheck ? view.landingCheck.command : view.landingCheckCommand;
  if (command === 'NONE') return 'NONE';
  return command ? 'COMMAND' : 'MERGE_CHECK';
}

export const LANDING_MODE_COPY = {
  MERGE_CHECK: 'Merge check',
  COMMAND: 'Command',
  NONE: 'No check',
  NONE_HEAD: 'No check.',
  NONE_BODY: 'Tasks land with only their own acceptance. The merge check still runs before main.',
  COMMAND_NOTE: 'Changes the coordinator makes are listed under Coordinator’s changes.',
  WHO_CAN_SET: 'Who can set it',
} as const;

/** The badge a landing check's `setBy` wears (D3, D9). */
export const LANDING_CHECK_ORIGIN_COPY = {
  OWNER: 'You',
  COORDINATOR: 'Coordinator',
  CARD: 'Approved on a card',
  START: 'Set at start',
} as const;

export const LANDING_CHECK_ORIGIN_NOTES: ReadonlyArray<{ by: keyof typeof LANDING_CHECK_ORIGIN_COPY; note: string }> = [
  { by: 'OWNER', note: 'Anything you set; the coordinator then needs a card to change it.' },
  { by: 'COORDINATOR', note: 'No card, while the merge check exists.' },
  { by: 'CARD', note: 'A change you confirmed on a card.' },
  { by: 'START', note: 'The coordinator proposed it and you pressed Start; it may still change without a card. A value you typed on the start card reads as You.' },
];

/** The Settings row that opens the coordinator’s change list (D6). */
export const changesRowLabel = (count: number): string => `${count} ${count === 1 ? 'change' : 'changes'}`;

export const CHANGES_COPY = {
  TITLE: 'Coordinator’s changes',
  INTRO: 'What the coordinator changed on its own since the project started. Revert puts the old value back and takes the field away from the coordinator: it needs a card from then on.',
  EMPTY: 'The coordinator has not changed anything on its own.',
  LANDING_CHECK: 'Landing check',
  CHECK_EXEMPT: 'Check exempt',
  USES_MERGE_CHECK: 'Uses merge check',
  NO_CHECK: 'No check',
  EXEMPT: 'exempt',
  NOT_EXEMPT: 'not exempt',
  REVERT: 'Revert',
  YOUR_CHANGE: 'Your change',
  YOUR_CHANGE_NOTHING: 'Your change · nothing to revert',
  CONFIRM_TITLE: 'Revert this change?',
  CONFIRM_CONSEQUENCE: 'The coordinator can no longer change this field without a card.',
  CANCEL: 'Cancel',
} as const;

export const revertedLine = (when: string): string =>
  `Reverted by you · ${when} · coordinator needs a card for this field`;

// ── A task's exemption (D5) ────────────────────────────────────────────────────────────────────

export const TASK_EXEMPT_COPY = {
  LABEL: 'Landing check',
  BADGE: 'Exempt',
  REMOVE: 'Remove exemption',
  SKIPPED: 'Skipped',
  MERGE_CHECK_STILL_RUNS: 'Merge check before main',
  STILL_RUNS: 'Still runs',
} as const;
export const exemptCheckReason = (reason: string): string => `Exempt: ${reason}`;

/** What a refused Revert says (the revert door's 409 codes), in a sentence instead of a generic error. */
export function revertFailureLine(code: string | undefined): string {
  switch (code) {
    case 'SETTING_CHANGE_NOT_CURRENT':
      return 'This field has changed since, so putting back the old value would undo a later change. Nothing was written.';
    case 'SETTING_CHANGE_NOT_REVERTIBLE':
      return 'Only a change the coordinator made without a card can be reverted. This one is yours or was approved on a card. Nothing was written.';
    case 'SETTING_CHANGE_ALREADY_REVERTED':
      return 'This change was already reverted. Nothing was written.';
    case 'SETTING_CHANGE_TASK_GONE':
      return 'The task this change is about is no longer in this project, so there is nothing to put back. Nothing was written.';
    default:
      return 'The revert did not go through. Nothing was written.';
  }
}
