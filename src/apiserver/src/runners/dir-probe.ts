import type { DirProbe, DirProbeAnswer, RunnerDirProbeResult } from '@orbit/shared';

/**
 * The directory probe relay's reading of what it stores and what it is sent (docs/first-workspace-contract.md §2):
 * "what is at this path on this machine?", asked while a folder for a machine's first workspace is being chosen.
 */

/** The longest path the relay takes, asked or answered: PATH_MAX on Linux. */
export const DIR_PROBE_MAX_PATH = 4096;

/** The relay's one slot, as the runner row holds it (runner.dir_probe_*, migration 0457). */
export interface DirProbeSlot {
  dirProbeStatus: string | null;
  dirProbePath: string | null;
  dirProbeResult: unknown;
}

/**
 * GET /runners/:id/dir-probe's answer about `path` (§2.2). The stored answer is returned only when it is about this
 * path, checked at both ends — the question the slot holds, and the path the answer itself names — the way the Claude
 * history relay's read is: someone choosing a folder asks about several in a row, and an answer arriving late about one
 * they moved on from must read as nothing yet, not as the verdict on the one in the field now. Asked again about the
 * same path, the last answer shows while the new one is on its way.
 */
export function dirProbeAnswerOf(slot: DirProbeSlot, path: string): DirProbeAnswer {
  const current = !!path && (slot.dirProbePath ?? '').trim() === path;
  const stored = storedAnswer(slot.dirProbeResult);
  const status = !current
    ? 'idle'
    : slot.dirProbeStatus === 'done'
      ? 'done'
      : slot.dirProbeStatus === 'pending' || slot.dirProbeStatus === 'probing'
        ? 'pending'
        : 'idle';
  return { path, status, result: current && stored?.path === path ? stored.result : null };
}

/** What `dir_probe_result` holds, or null for anything that is not the shape readDirProbeResult writes. */
function storedAnswer(value: unknown): RunnerDirProbeResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { path, result } = value as Record<string, unknown>;
  if (typeof path !== 'string' || !result || typeof result !== 'object' || Array.isArray(result)) return null;
  return { path, result: result as DirProbe };
}

/**
 * A runner's answer (POST /runner/dir-probe-result, §2.4), re-read rather than trusted: it crosses the runner boundary,
 * which nothing validates on the way in, and a client renders it. Null when it names no path it answers, or carries no
 * result. A flag that is not `true` reads false, strings are trimmed and capped, and a byte count that is not a finite
 * non-negative number reads as unknown — never as zero, which a client would read as a full disk.
 */
export function readDirProbeResult(body: unknown): RunnerDirProbeResult | null {
  const { path: asked, result } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const path = typeof asked === 'string' ? asked.trim() : '';
  if (!path || path.length > DIR_PROBE_MAX_PATH) return null;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const found = result as Record<string, unknown>;
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
  const error = text(found.error, 500);
  const freeBytes = found.freeBytes;
  return {
    path,
    result: {
      // The runner's expanded, absolute path; the path asked about when it names none.
      path: text(found.path, DIR_PROBE_MAX_PATH) ?? path,
      exists: found.exists === true,
      isDir: found.isDir === true,
      isGit: found.isGit === true,
      branch: text(found.branch, 255) ?? null,
      isHome: found.isHome === true,
      freeBytes: typeof freeBytes === 'number' && Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.floor(freeBytes) : null,
      ...(error ? { error } : {}),
    },
  };
}
