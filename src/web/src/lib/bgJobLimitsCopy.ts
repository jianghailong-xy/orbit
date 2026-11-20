// What the Machine page's Capacity card says about the background job limits (Runner.bgJobCpus /
// bgJobMemoryMb). Kept apart from runnerCopy.ts, whose shape (constants and single-template functions)
// the OrbitKit parity test reads as text: these sentences branch, and the native clients add their own
// counterparts with the rows themselves.

/** Background job limits (Runner.bgJobCpus / bgJobMemoryMb): each Select's title and its Off. */
export const RUNNER_JOB_CPU = 'Job CPU';
export const RUNNER_JOB_MEMORY = 'Job Memory';
export const RUNNER_JOB_LIMIT_OFF = 'Off';
export function runnerJobCpus(cpus: number): string {
  return cpus === 1 ? '1 CPU' : `${cpus} CPUs`;
}
export function runnerJobMemory(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}
/** Under Capacity, when the machine can limit background jobs. */
export const RUNNER_JOB_LIMITS_FOOTER =
  'Job CPU and Job Memory limit each background job an agent starts from now on; past its memory a job is ' +
  'stopped. A job under limits takes no Max Concurrent slot: together, limited jobs get a tenth of the CPU ' +
  'sessions get when the machine is busy, and at most half its memory.';
/** In place of that footer when the machine cannot limit background jobs, by the reason its runner gave. */
export const RUNNER_JOB_LIMITS_OLD = 'Update the runner to limit background jobs on this machine.';
export function runnerJobLimitsUnavailable(reason: 'os' | 'cgroup' | 'delegate' | 'controllers' | 'unknown'): string {
  switch (reason) {
    case 'os':
      return 'Background job limits need Linux; this machine runs another system.';
    case 'cgroup':
      return 'Background job limits need the runner to run as a systemd service with cgroup v2; it does not here.';
    case 'delegate':
      return "Background job limits need the runner's service reinstalled: run `orbit register` on the machine, then restart it.";
    case 'controllers':
      return "Background job limits need the CPU and memory controllers, which this machine's cgroup does not offer.";
    default:
      return 'This machine cannot limit background jobs.';
  }
}
