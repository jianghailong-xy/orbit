import { CanActivate, Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * The Drive switch: whether this server offers the Drive (docs/drive-technical-design.md).
 * Off by default, so a self-deployed server has no Drive until its operator turns it on; Orbit's hosted service
 * sets it. Read from the environment, so a change takes effect when the apiserver restarts. Shaped after
 * managed-runners/managed-runner-gate.ts.
 *
 *   (ORBIT_DOCUMENTS_ENABLED, then ORBIT_FILES_ENABLED, are read while ORBIT_DRIVE_ENABLED is unset or blank)
 *   ORBIT_DRIVE_ENABLED absent, empty or `false`   off
 *   ORBIT_DRIVE_ENABLED=true                        on
 *   anything else, `1`, `yes` and `on` included         off, and one warning in the log
 *
 * Off, the server meets a client the way one without the drive would:
 *   - every route of the owner's door (`/api/drive/*`), the download links and the runner door (`/api/runner/drive/*`)
 *     answers 404 DOCUMENTS_DISABLED before it reads anything (`DriveEnabledGuard`);
 *   - a drive file cannot be shared, and a share link made while it was on reads as one naming nothing;
 *   - `GET /api/auth/capabilities` says `documents.enabled: false`, so the clients show no Documents entry;
 *   - sessions are claimed with `documentsDisabled`, which a runner that knows it spawns without the drive tools.
 * Nothing is deleted: what the drive holds is there again when the switch is turned back on.
 */
export const DRIVE_ENABLED_ENV = 'ORBIT_DRIVE_ENABLED';

/** The switch's names before the drive was renamed back to Drive, newest first; read while the newer ones are unset or blank. */
const LEGACY_ENABLED_ENVS = ['ORBIT_DOCUMENTS_ENABLED', 'ORBIT_FILES_ENABLED'];

/** The name the switch is read by: ORBIT_DRIVE_ENABLED, else the first older name that is not blank. */
export function driveEnabledEnvName(env: NodeJS.ProcessEnv): string {
  return [DRIVE_ENABLED_ENV, ...LEGACY_ENABLED_ENVS].find((name) => env[name]?.trim()) ?? DRIVE_ENABLED_ENV;
}

/** The refusal code of a Drive request while the switch is off: 404, as a server without the drive. */
export const DOCUMENTS_DISABLED = 'DOCUMENTS_DISABLED';

export interface DriveSwitch {
  readonly enabled: boolean;
  /** What the environment said that could not be taken as written, or null. */
  readonly problem: string | null;
}

/** The table above, as a pure function of the variable's value. */
export function readDriveSwitch(value: string | undefined, name: string = DRIVE_ENABLED_ENV): DriveSwitch {
  const said = (value ?? '').trim().toLowerCase();
  if (said === 'true') return { enabled: true, problem: null };
  if (said === '' || said === 'false') return { enabled: false, problem: null };
  return {
    enabled: false,
    problem: `${name}=${JSON.stringify(value)} is neither true nor false: Drive is off`,
  };
}

const log = new Logger('Drive');
let announced: string | undefined;

/** Whether this process offers Drive, from its environment; a problem with the value is logged once. */
export function documentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const name = driveEnabledEnvName(env);
  const read = readDriveSwitch(env[name], name);
  if (read.problem && read.problem !== announced) {
    announced = read.problem;
    log.warn(read.problem);
  }
  return read.enabled;
}

/** The refusal of a Drive request while the switch is off: the 404 of a server without the drive, with the reason. */
export function documentsDisabledError(): NotFoundException {
  return new NotFoundException({
    code: DOCUMENTS_DISABLED,
    message: `Drive is not enabled on this Orbit server (${DRIVE_ENABLED_ENV}), so nothing was read or written.`,
  });
}

/**
 * What a claimed session carries about Drive: nothing while it is on — the payload every runner has always
 * received — and `documentsDisabled` otherwise, which tells a runner that knows the flag to spawn the session without
 * the drive tools.
 */
export function documentsClaimFields(env: NodeJS.ProcessEnv = process.env): { documentsDisabled?: true } {
  return documentsEnabled(env) ? {} : { documentsDisabled: true };
}

/**
 * The drive's doors, closed while the switch is off. Listed after the door's own credential guard, so a request that
 * is not authenticated is still that guard's 401 and says nothing about the switch. On the class, not on a route, so
 * every route the controller has, and every one added later, is behind it.
 */
@Injectable()
export class DriveEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (documentsEnabled()) return true;
    throw documentsDisabledError();
  }
}
