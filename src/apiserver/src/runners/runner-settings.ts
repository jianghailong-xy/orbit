import type { UpdateRunnerDto } from './dto';

/** The columns a runner's settings write sets. */
export interface RunnerSettingsData {
  displayName?: string | null;
  maxConcurrent?: number;
  burstConcurrent?: number;
  minFreeDiskMb?: number | null;
}

/**
 * What a write of a runner's settings sets, from a validated `UpdateRunnerDto`: the one place those rules live, read by
 * the runner page's `PATCH /runners/:id` (RunnersService.updateRunner) and by the owner's Apply on a CHANGE card
 * (OwnerRequestsService.applyChange, docs/design/owner-request-change.md §4).
 */
export function runnerSettingsData(dto: UpdateRunnerDto): RunnerSettingsData {
  const data: RunnerSettingsData = {};
  if (dto.displayName !== undefined) {
    const trimmed = dto.displayName.trim();
    data.displayName = trimmed.length ? trimmed : null;
  }
  // The queue gates live sessions on this per claim, so a change takes effect
  // next cycle without restarting the runner.
  if (dto.maxConcurrent !== undefined) {
    data.maxConcurrent = dto.maxConcurrent;
  }
  // Extra sessions on demand: read by the next overflow claim and by the session list's Run now, so it too
  // takes effect at once. 0 turns Run now off on this machine.
  if (dto.burstConcurrent !== undefined) {
    data.burstConcurrent = dto.burstConcurrent;
  }
  // Read by the auto-run sweep against each workspace's own measured filesystem; null clears
  // the floor. Also effective next sweep — nothing to restart.
  if (dto.minFreeDiskMb !== undefined) {
    data.minFreeDiskMb = dto.minFreeDiskMb;
  }
  return data;
}
