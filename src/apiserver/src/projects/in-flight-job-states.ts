import { Prisma } from '@prisma/client';

/**
 * The states in which an integration job is in flight (contract §2.1 J3, §1.6; docs/design/protected-branch-landing.md
 * §4.2): queued, claimed by a runner, or waiting for GitHub on its pull request. A `PULL_REQUEST` job holds no runner,
 * no lease and no J1 slot, and it is still the task's one landing in flight: J3's index, `readInFlightJobs`, a
 * criterion's `IN_FLIGHT` and the landing view all count it.
 *
 * Every reader that asks whether a landing is still moving asks with this list. `in-flight-job-states.spec.ts` fails
 * on a reader that spells the states out again. A leaf module on purpose: the readers include modules that
 * `project-integration-job.ts` itself imports.
 */
export const IN_FLIGHT_JOB_STATES = ['QUEUED', 'RUNNING', 'PULL_REQUEST'] as const;
export type InFlightJobState = (typeof IN_FLIGHT_JOB_STATES)[number];

export function isInFlightJobState(state: string): state is InFlightJobState {
  return (IN_FLIGHT_JOB_STATES as readonly string[]).includes(state);
}

/** The same list for raw SQL: `j."state" IN ${IN_FLIGHT_JOB_STATES_SQL}`. Constants only, so nothing is bound. */
export const IN_FLIGHT_JOB_STATES_SQL = Prisma.raw(`(${IN_FLIGHT_JOB_STATES.map((state) => `'${state}'`).join(', ')})`);

/**
 * The states in which a job is a runner's work: queued for one, or held by one. Not the in-flight list: a job waiting
 * on its pull request is in flight and no runner's — the pull request door has it — so a reader asking "is there
 * anything for this runner to do" asks with this one.
 */
export const RUNNER_JOB_STATES = ['QUEUED', 'RUNNING'] as const;
export const RUNNER_JOB_STATES_SQL = Prisma.raw(`(${RUNNER_JOB_STATES.map((state) => `'${state}'`).join(', ')})`);
