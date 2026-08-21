export interface ProjectRunnerCandidate {
  workspaceId: string;
  runnerId: string;
  available: boolean;
  capabilitiesReported: boolean;
  capabilities: readonly string[];
  position?: number | null;
}

export interface ProjectRunnerRequirement {
  capabilities: readonly string[];
  candidates: readonly ProjectRunnerCandidate[];
}

export interface ProjectRunnerResolution {
  v: 1;
  selectedWorkspaceId: string | null;
  selectedRunnerId: string | null;
  requiredCapabilities: string[];
  candidatesConsidered: Array<{
    workspaceId: string;
    runnerId: string;
    available: boolean;
    capabilitiesReported: boolean;
    missingCapabilities: string[];
  }>;
  failure: null | {
    code: 'NO_MATCHING_RUNNER';
    retryable: true;
  };
}

/**
 * Declarative runner matching only. This function has no Project, Agent, budget, approval, retry,
 * provider-fallback or Task policy input, so it cannot accidentally become a second authorizer.
 * An old runner is eligible for an empty requirement set, but cannot prove any non-empty one.
 */
export function scheduleProjectRunner(
  requirement: ProjectRunnerRequirement,
): ProjectRunnerResolution {
  const requiredCapabilities = normalizedCapabilities(requirement.capabilities);
  const candidates = [...requirement.candidates]
    .sort((left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
      || left.runnerId.localeCompare(right.runnerId)
      || left.workspaceId.localeCompare(right.workspaceId))
    .map((candidate) => {
      const reported = normalizedCapabilities(candidate.capabilities);
      const available = candidate.available;
      const missingCapabilities = requiredCapabilities.filter((capability) =>
        !candidate.capabilitiesReported || !reported.includes(capability));
      return {
        workspaceId: candidate.workspaceId,
        runnerId: candidate.runnerId,
        available,
        capabilitiesReported: candidate.capabilitiesReported,
        missingCapabilities,
      };
    });
  const selected = candidates.find((candidate) =>
    candidate.available && candidate.missingCapabilities.length === 0);
  return {
    v: 1,
    selectedWorkspaceId: selected?.workspaceId ?? null,
    selectedRunnerId: selected?.runnerId ?? null,
    requiredCapabilities,
    candidatesConsidered: candidates,
    failure: selected ? null : { code: 'NO_MATCHING_RUNNER', retryable: true },
  };
}

export function normalizedCapabilities(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}
