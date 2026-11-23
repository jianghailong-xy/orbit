// Orbit Cloud's Update card (docs/managed-runner-update-now-design.md, "Clients"): the self-managed runner's card,
// driven by the managed status's `update` instead of a runner's `selfUpdate`.

import type { ManagedRunnerBuild, ManagedRunnerBusyTurn, ManagedRunnerStatus, ManagedRunnerUpdateNowRequest } from '@orbit/shared';
import { MANAGED_RUNNER_BUSY } from '@orbit/shared';
import { api, ApiError } from '../api';
import type { ManagedRunner } from './managedRunner';
import {
  MANAGED_UPDATE_AVAILABLE_BODY,
  MANAGED_UPDATE_TAG_UPDATED,
  RUNNER_UPDATE_RESTARTING_BODY,
  RUNNER_UPDATE_RESTARTING_BODY_ONE,
  RUNNER_UPDATE_TAG_AVAILABLE,
  RUNNER_UPDATE_TAG_RESTARTING,
  RUNNER_UPDATE_UNTITLED_TURN,
  managedBuildLine,
  managedBuildLineBuilt,
  managedBuildNamed,
  managedUpdateAvailableTitle,
  managedUpdateNowBodyMany,
  managedUpdateNowBodyNone,
  managedUpdateNowBodyOne,
  managedUpdateNowJobs,
  MANAGED_UPDATE_NOW_SERVICES,
  managedUpdateRestartingTitle,
  managedUpdateUpdatedTitle,
  runnerUpdateRestartingBodyMany,
  runnerUpdateTurnRunning,
} from './runnerCopy';
import { isReleaseVersion } from './runnerAttention';
import { RUNNER_UPDATE_UPDATED_HOURS, runnerUpdateTook, runnerUpdateUpdatedBody, runnerUpdateWaited } from './runnerUpdateCard';

/** `95884b154feb…` → `95884b1`. */
export const buildSha7 = (sha: string): string => sha.slice(0, 7);

/** `Nov 16`, or null when the build has no (readable) build time. */
export function buildDay(builtAt: string | undefined): string | null {
  const at = builtAt ? Date.parse(builtAt) : NaN;
  return Number.isNaN(at) ? null : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The release version (`0.1.261-beta.83`) when the build has one, as a self-managed runner's version reads;
 *  else `the Nov 18 build`, or `the e03e2cd build` when its build time is unknown. */
export function buildName(build: ManagedRunnerBuild): string {
  if (build.version) return build.version;
  return managedBuildNamed(buildDay(build.builtAt) ?? buildSha7(build.sha));
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What an Update Now left behind, kept on this browser for the Updated card's day. */
export interface ManagedUpdateOutcome {
  to: ManagedRunnerBuild;
  at: number;
  tookSeconds: number;
  interruptedTurns: number;
}
/** An Update Now pressed and not yet seen through. */
interface PendingUpdate {
  at: number;
  interruptedTurns: number;
  to: ManagedRunnerBuild;
}

const key = (kind: 'pending' | 'updated', runnerId: string) => `orbit.managedUpdate.${kind}.${runnerId}`;
function read<T>(kind: 'pending' | 'updated', runnerId: string): T | null {
  try {
    const text = localStorage.getItem(key(kind, runnerId));
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}
function write(kind: 'pending' | 'updated', runnerId: string, value: unknown | null): void {
  try {
    if (value === null) localStorage.removeItem(key(kind, runnerId));
    else localStorage.setItem(key(kind, runnerId), JSON.stringify(value));
  } catch {
    // Without storage the Updated card is simply not remembered.
  }
}

/** The owner pressed Update Now: remember what it interrupted and which build it goes to. */
export function notePendingUpdate(runnerId: string, interruptedTurns: number, to: ManagedRunnerBuild, now = Date.now()): void {
  write('pending', runnerId, { at: now, interruptedTurns, to });
}
/** The Update Now pressed and not yet seen through: how many turns it interrupted. Null when none is. */
export const pendingUpdateTurns = (runnerId: string): number | null => read<PendingUpdate>('pending', runnerId)?.interruptedTurns ?? null;
/** When the pending Update Now was noted; null when none is. */
export const pendingUpdateAt = (runnerId: string): number | null => read<PendingUpdate>('pending', runnerId)?.at ?? null;

/**
 * Once the runner is READY again with no `update`, a pending Update Now has finished: how long it took
 * is the time since the press. Returns the outcome it recorded, or null.
 */
export function settlePendingUpdate(runnerId: string, now = Date.now()): ManagedUpdateOutcome | null {
  const pending = read<PendingUpdate>('pending', runnerId);
  if (!pending) return null;
  const outcome: ManagedUpdateOutcome = {
    to: pending.to,
    at: now,
    tookSeconds: Math.max(1, Math.round((now - pending.at) / 1000)),
    interruptedTurns: pending.interruptedTurns,
  };
  write('updated', runnerId, outcome);
  write('pending', runnerId, null);
  return outcome;
}
/**
 * A pending Update Now the server no longer reports as in progress while a build is still available to move to: either
 * it ended unwatched before a newer build came out, or it never took. Its note is dropped with no outcome, so that it
 * neither shows Restarting nor records an Updated card it cannot time.
 */
export function dropPendingUpdate(runnerId: string): void {
  write('pending', runnerId, null);
}
export const readUpdateOutcome = (runnerId: string): ManagedUpdateOutcome | null => read<ManagedUpdateOutcome>('updated', runnerId);

export interface ManagedUpdateCard {
  phase: 'available' | 'restarting' | 'updated';
  tone: 'warn' | 'quiet' | 'done';
  title: string;
  tag: string;
  body: string;
  /** Available only: the build Update Now… moves it to, for the confirmation. */
  to?: ManagedRunnerBuild;
}

/**
 * The card the managed status calls for, or null (the runner runs the current build, or is not running).
 * Restarting comes from the server alone: its status says `updating`, which it does from the accepted Update Now until
 * the next generation is READY. A press this browser remembers never shows it: a refused or lost request, or one that
 * ended while nobody watched, would otherwise read Restarting for good.
 */
export function managedUpdateCard(
  status: ManagedRunnerStatus,
  outcome: ManagedUpdateOutcome | null,
  nowMs: number,
  interruptedTurns: number,
): ManagedUpdateCard | null {
  const update = status.update;
  if (update?.phase === 'available') {
    return {
      phase: 'available',
      tone: 'quiet',
      title: managedUpdateAvailableTitle(capitalized(buildName(update.current))),
      tag: RUNNER_UPDATE_TAG_AVAILABLE,
      body: MANAGED_UPDATE_AVAILABLE_BODY,
      to: update.current,
    };
  }
  if (update?.phase === 'updating') {
    return {
      phase: 'restarting',
      tone: 'warn',
      title: managedUpdateRestartingTitle(buildName(update.current)),
      tag: RUNNER_UPDATE_TAG_RESTARTING,
      body: !interruptedTurns
        ? RUNNER_UPDATE_RESTARTING_BODY
        : interruptedTurns === 1 ? RUNNER_UPDATE_RESTARTING_BODY_ONE : runnerUpdateRestartingBodyMany(interruptedTurns),
    };
  }
  if (outcome && nowMs - outcome.at <= RUNNER_UPDATE_UPDATED_HOURS * 3_600_000 && outcome.at - nowMs <= 60_000) {
    return {
      phase: 'updated',
      tone: 'done',
      title: managedUpdateUpdatedTitle(buildName(outcome.to)),
      tag: MANAGED_UPDATE_TAG_UPDATED,
      body: runnerUpdateUpdatedBody(runnerUpdateTook(outcome.tookSeconds), outcome.interruptedTurns),
    };
  }
  return null;
}

/**
 * About's Version: `Build 95884b1 · Nov 16`. The running build is the update's, else the runner's reported
 * `managed-<sha>`; its day is the update's, or the last Update Now's when that is the build it runs. Null when
 * the runner names no build. A runner on a release version has no build line: its version shows as a
 * self-managed runner's does (runnerVersionLine), so this returns null.
 */
export function managedVersionLine(
  managed: ManagedRunner | null,
  version: string | null,
  outcome: ManagedUpdateOutcome | null,
): string | null {
  if (managed?.status.update?.running.version || isReleaseVersion(version)) return null;
  const reported = /^managed-([0-9a-f]{7,40})$/i.exec(version ?? '')?.[1];
  const running = managed?.status.update?.running;
  const sha = running?.sha ?? reported;
  if (!sha) return null;
  const sha7 = buildSha7(sha);
  const built = running?.builtAt ?? (outcome && outcome.to.sha.startsWith(sha7) ? outcome.to.builtAt : undefined);
  const day = buildDay(built);
  return day ? managedBuildLineBuilt(sha7, day) : managedBuildLine(sha7);
}

/** The confirmation's text for the turns a 409 listed. */
export interface ManagedBusy {
  turns: Array<{ id: string; title: string; running: string | null }>;
  backgroundJobs: number;
}
export function managedBusyOf(error: unknown, nowMs: number): ManagedBusy | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== MANAGED_RUNNER_BUSY) return null;
  const body = error.body ?? {};
  const turns = Array.isArray(body.turns) ? (body.turns as ManagedRunnerBusyTurn[]) : [];
  return {
    backgroundJobs: typeof body.backgroundJobs === 'number' ? body.backgroundJobs : 0,
    turns: turns.map((turn) => ({
      id: turn.sessionId,
      title: turn.title?.trim() || RUNNER_UPDATE_UNTITLED_TURN,
      running: turn.startedAt && !Number.isNaN(Date.parse(turn.startedAt))
        ? runnerUpdateTurnRunning(runnerUpdateWaited(Math.max(0, Math.floor((nowMs - Date.parse(turn.startedAt)) / 60_000))))
        : null,
    })),
  };
}

/** POST /managed-runner/update-now. */
export function managedUpdateNow(interruptTurns: boolean): Promise<ManagedRunnerStatus> {
  const body: ManagedRunnerUpdateNowRequest = { interruptTurns };
  return api<ManagedRunnerStatus>('/managed-runner/update-now', { method: 'POST', body });
}

export function managedUpdateNowBody(build: string, turns: number): string {
  if (turns === 0) return managedUpdateNowBodyNone(build);
  return turns === 1 ? managedUpdateNowBodyOne(build) : managedUpdateNowBodyMany(build);
}
/** The amber note below the turns: the jobs that stop, or just the services when none is counted. */
export function managedUpdateNowJobsNote(jobs: number): string {
  return jobs > 0 ? managedUpdateNowJobs(jobs, jobs === 1 ? 'background job' : 'background jobs') : MANAGED_UPDATE_NOW_SERVICES;
}
