/**
 * An engine-update run's report (`orbit engine-update`, src/runner-go/engineupdate.go) as the runner
 * stores it in the engine relay's message: one line per engine. These read its failed lines the way
 * the runner's own `updateRunFailed` (src/runner-go/engineinstall.go) does, so the machine page, the
 * Fix with an agent button and the agent's first message agree on what failed.
 */

/** Whether one line of the report is a failure. */
export function engineUpdateLineFailed(line: string): boolean {
  return line.includes('update failed') || line.includes('timed out') || line.includes('does not run');
}

/** The report's failed lines, trimmed; empty when nothing failed. */
export function engineUpdateFailedLines(message: string | null | undefined): string[] {
  return (message ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && engineUpdateLineFailed(line));
}
