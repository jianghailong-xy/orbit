/**
 * Where the owner's Drive routes answer (drive.controller.ts): /drive, and /documents as an alias of the very same
 * handlers, because runners and web bundles deployed while Drive was called Drive call /documents. Callers in this
 * tree use /drive.
 */
export const DRIVE_ROUTE_PREFIXES = ['drive', 'documents'];

/**
 * A route list's `METHOD /drive/…` key (anything may follow the path) as every prefix answers it, so a census that
 * names each route a controller mounts names the /documents alias too, and holds it to the same decision.
 */
export const underEveryDrivePrefix = (route: string): string[] =>
  DRIVE_ROUTE_PREFIXES.map((prefix) => route.replace(' /drive/', ` /${prefix}/`));

/**
 * Where the runner drive door answers (runner-drive.controller.ts): /runner/drive, and /runner/documents as an alias of
 * the very same handlers, because runners and mount daemons deployed while Drive was called Drive call
 * /runner/documents. Callers in this tree use /runner/drive.
 */
export const RUNNER_DRIVE_ROUTE_PREFIXES = ['runner/drive', 'runner/documents'];

/** A route list's `METHOD /runner/drive/…` key as every runner door prefix answers it (anything may follow the path). */
export const underEveryRunnerDrivePrefix = (route: string): string[] =>
  RUNNER_DRIVE_ROUTE_PREFIXES.map((prefix) => route.replace(' /runner/drive/', ` /${prefix}/`));
