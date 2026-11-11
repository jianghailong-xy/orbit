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
