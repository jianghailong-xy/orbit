import { RunEventType } from '@orbit/shared';

/**
 * Whether a batch carries its runner's report that Codex's sandbox cannot start there: the
 * transcript notice an Orbit Cloud runner sends when its sandbox probe failed and Codex Auto runs
 * with the sandbox off (runner-go codex_cloud_sandbox.go, `sandboxUnavailable: true`). A runner
 * whose probe passed sends nothing, so the absence of a report changes nothing.
 */
export function reportsCodexSandboxUnavailable(
  events: ReadonlyArray<{ type: string; payload?: unknown }>,
): boolean {
  return events.some(
    (e) =>
      e.type === RunEventType.SYSTEM &&
      (e.payload as { sandboxUnavailable?: unknown } | null | undefined)?.sandboxUnavailable === true,
  );
}
