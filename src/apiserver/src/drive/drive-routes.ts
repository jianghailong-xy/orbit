/**
 * Where the owner's Documents routes answer (drive.controller.ts): /documents, and /drive as an alias of the very same
 * handlers, because runners and web bundles already deployed call /drive. Callers in this tree use /documents.
 */
export const DRIVE_ROUTE_PREFIXES = ['documents', 'drive'];

/**
 * A route list's `METHOD /documents/…` key (anything may follow the path) as every prefix answers it, so a census that
 * names each route a controller mounts names the /drive alias too, and holds it to the same decision.
 */
export const underEveryDrivePrefix = (route: string): string[] =>
  DRIVE_ROUTE_PREFIXES.map((prefix) => route.replace(' /documents/', ` /${prefix}/`));

/**
 * Where the runner Documents door answers (runner-drive.controller.ts): /runner/documents, and /runner/drive as an
 * alias of the very same handlers, because runners and mount daemons already deployed call /runner/drive. Callers in this
 * tree use /runner/documents.
 */
export const RUNNER_DRIVE_ROUTE_PREFIXES = ['runner/documents', 'runner/drive'];

/** A route list's `METHOD /runner/documents/…` key as every runner door prefix answers it (anything may follow the path). */
export const underEveryRunnerDrivePrefix = (route: string): string[] =>
  RUNNER_DRIVE_ROUTE_PREFIXES.map((prefix) => route.replace(' /runner/documents/', ` /${prefix}/`));
