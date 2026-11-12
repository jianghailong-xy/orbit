import { BadRequestException } from '@nestjs/common';
import type { SessionNotifyOverride, SessionSettings, SessionSettingsPatch } from '@orbit/shared';

/**
 * A session's Settings panel (docs/mocks/session-settings): its own env vars and its notification
 * overrides. Validation of `PATCH /sessions/:id/settings` and the `settings` projection the detail
 * and that PATCH both answer with.
 */

export const SESSION_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SESSION_ENV_MAX_KEYS = 100;
/** Per value, in UTF-8 bytes. */
export const SESSION_ENV_MAX_VALUE_BYTES = 32 * 1024;

const NOTIFY_VALUES: readonly SessionNotifyOverride[] = ['inherit', 'on', 'off'];

/** The Session columns a patch writes. */
export interface SessionSettingsWrite {
  env?: Record<string, string> | null;
  notifyTurnFinished?: string | null;
  notifyNeedsYou?: string | null;
  notificationsMuted?: boolean;
}

function notifyColumn(field: string, value: unknown): string | null {
  if (typeof value !== 'string' || !(NOTIFY_VALUES as readonly string[]).includes(value)) {
    throw new BadRequestException(`${field} must be one of inherit, on, off`);
  }
  return value === 'inherit' ? null : value;
}

function validEnv(value: unknown): Record<string, string> | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('env must be an object of string values, or null');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SESSION_ENV_MAX_KEYS) {
    throw new BadRequestException(`env has more than ${SESSION_ENV_MAX_KEYS} variables`);
  }
  const env: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (!SESSION_ENV_KEY.test(key)) {
      throw new BadRequestException(`env name "${key}" is not valid: use letters, digits and _, not starting with a digit`);
    }
    if (key.toUpperCase().startsWith('ORBIT_')) {
      throw new BadRequestException(`env name "${key}" is reserved: ORBIT_ variables are set by Orbit`);
    }
    if (typeof v !== 'string') throw new BadRequestException(`env value of "${key}" must be a string`);
    if (Buffer.byteLength(v, 'utf8') > SESSION_ENV_MAX_VALUE_BYTES) {
      throw new BadRequestException(`env value of "${key}" is longer than 32 KB`);
    }
    env[key] = v;
  }
  return env;
}

/** The columns a request body writes; refuses an invalid one and an empty one. */
export function parseSessionSettingsPatch(body: unknown): SessionSettingsWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('the body must be an object');
  }
  const dto = body as SessionSettingsPatch & Record<string, unknown>;
  const write: SessionSettingsWrite = {};
  if (dto.env !== undefined) write.env = validEnv(dto.env);
  if (dto.notifyTurnFinished !== undefined) write.notifyTurnFinished = notifyColumn('notifyTurnFinished', dto.notifyTurnFinished);
  if (dto.notifyNeedsYou !== undefined) write.notifyNeedsYou = notifyColumn('notifyNeedsYou', dto.notifyNeedsYou);
  if (dto.muted !== undefined) {
    if (typeof dto.muted !== 'boolean') throw new BadRequestException('muted must be true or false');
    write.notificationsMuted = dto.muted;
  }
  if (Object.keys(write).length === 0) throw new BadRequestException('nothing to update');
  return write;
}

/** A stored env (Json) as a string map: anything that is not a string value is left out. */
export function stringEnv(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Order-insensitive equality of two env maps: a PATCH that resends the same map is no change. */
export function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

function notifyOf(value: string | null | undefined): SessionNotifyOverride {
  return value === 'on' || value === 'off' ? value : 'inherit';
}

/** The `reload` a Settings restart queues (POST /sessions/:id/restart): no setting moved, only the env. */
export const RESTART_RELOAD_CONTENT = JSON.stringify({ env: true });

/**
 * Whether a queued `reload` is handed out with the session's freshly resolved env
 * (RunnerApiController.reloadProviderEnv): a provider switch, which moves the credential, and a
 * Settings restart, which re-applies the env. Every other reload runs on the env the engine has.
 */
export function reloadCarriesEnv(content: string | null | undefined): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(content ?? '{}');
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object') return false;
  const { provider, env } = payload as { provider?: unknown; env?: unknown };
  return (typeof provider === 'string' && provider !== '') || env === true;
}

/** The Session fields the projection reads. */
export interface SessionSettingsRow {
  env: unknown;
  envChangedAt: Date | null;
  envAppliedAt: Date | null;
  engineStartedAt: Date | null;
  notifyTurnFinished: string | null;
  notifyNeedsYou: string | null;
  notificationsMuted: boolean;
}

/**
 * `engineLive` is whether an engine is running for the session now. A restart is owed when the env
 * changed after the engine last started with it: `envAppliedAt` once a restart stamps it, else the
 * engine's own start.
 */
export function sessionSettingsOf(
  row: SessionSettingsRow,
  workspaceEnv: unknown,
  engineLive: boolean,
): SessionSettings {
  const appliedAt = row.envAppliedAt ?? row.engineStartedAt;
  return {
    env: stringEnv(row.env),
    workspaceEnv: stringEnv(workspaceEnv),
    notifyTurnFinished: notifyOf(row.notifyTurnFinished),
    notifyNeedsYou: notifyOf(row.notifyNeedsYou),
    muted: row.notificationsMuted === true,
    envPendingRestart: engineLive
      && row.envChangedAt != null
      && appliedAt != null
      && row.envChangedAt.getTime() > appliedAt.getTime(),
  };
}
