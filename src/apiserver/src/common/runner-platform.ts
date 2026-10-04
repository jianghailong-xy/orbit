/** The operating system a runner process names on every request (src/runner-go/transport.go): Go's
 *  runtime.GOOS — `linux`, `darwin`, `windows`. Absent from a runner older than the header. */
export const RUNNER_OS_HEADER = 'x-orbit-runner-os';

/** How that OS is kept in Runner.capabilities, beside the protocol and `provider:` declarations. */
const OS_PREFIX = 'os:';

/** An OS name as GOOS spells one. Anything else is not a claim about the machine. */
const OS_NAME = /^[a-z0-9]{1,32}$/;

/**
 * Replace the OS declaration with what this heartbeat's header says, as the provider declarations
 * are replaced: the snapshot belongs to the process sending it, so a header that is absent — an
 * older runner — or not an OS name clears it rather than leaving the last one standing.
 */
export function withRunnerOs(capabilities: readonly string[], header?: string | string[]): string[] {
  const value = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase() ?? '';
  return [
    ...capabilities.filter((capability) => !capability.startsWith(OS_PREFIX)),
    ...(OS_NAME.test(value) ? [`${OS_PREFIX}${value}`] : []),
  ];
}

/** The operating system a runner last reported, or null for one that has not said. */
export function runnerOs(capabilities?: readonly string[]): string | null {
  const declared = capabilities?.find((capability) => capability.startsWith(OS_PREFIX));
  return declared ? declared.slice(OS_PREFIX.length) : null;
}
