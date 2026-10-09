import type { WikiMaintenanceHealth, WikiSpaceHealth } from '@orbit/shared';
import { wikiCount } from './wikiArticles';
import { WIKI_VIEW_RUN } from './wikiReviewMode';

/**
 * The maintenance part of the Wiki home's status line (criterion 5, mocks 11 ② and 12 ④): where the
 * space's maintenance run stands, in one of its looks — off, maintained, maintaining now, behind, failing
 * (contracts/wiki.contract.json `maintenance.health`). The server decides the look; this says it.
 *
 * ONE SENTENCE ON BOTH CLIENTS. OrbitKit's `WikiHealthLogic` builds the same parts from the same read, and
 * both are held to `src/shared/src/wiki-health.fixture.json` (`lib/wikiHealth.test.ts` here,
 * `WikiHealthCopyParityTests` there), which also looks every constant below up by its declaration.
 */

export const WIKI_MAINTENANCE_OFF = 'Maintenance off';
export const WIKI_MAINTENANCE_SET_UP = 'Set up';
export const WIKI_MAINTENANCE_ON = 'Maintenance on';
export const WIKI_MAINTENANCE_BEHIND = 'Maintenance behind';
export const WIKI_DAILY_LIMIT_REACHED = 'daily limit reached';
export const WIKI_REVIEW_QUEUE_FULL = 'review queue full';
export const wikiMaintained = (ago: string): string => `Maintained ${ago}`;
export const wikiMaintainingNow = (ago: string): string => `Maintaining now · started ${ago}`;
export const wikiToCatchUp = (count: number): string => `${wikiCount(count)} to catch up`;
export const wikiBehindBy = (count: number, lag: string): string => `${wikiCount(count)} to catch up, oldest ${lag}`;
export const wikiLastRun = (ago: string): string => `last run ${ago}`;
export const wikiLastSuccess = (ago: string): string => `last success ${ago}`;
export const wikiMaintenanceFailed = (count: number): string =>
  count === 1 ? 'Maintenance failed' : `Maintenance failed ${count} times`;

/**
 * Why the server's runs do not move, said after the maintenance part while the server executes the account's
 * wiki (design §2.2, mock 35 ⑥; contract `maintenance.health.serverReasons`): one of them, the first that holds in
 * this order — the worker, the model's configuration, its key, its reachability, then the runner the repository is
 * read through. Amber is what comes back by itself; red is what somebody has to set right.
 */
export const WIKI_REASON_WORKER = 'wiki worker not running';
export const WIKI_REASON_UNCONFIGURED = 'System model not configured';
export const WIKI_REASON_KEY_REFUSED = 'System model refused the key';
export const WIKI_REASON_UNREACHABLE = 'System model unreachable';
export const WIKI_REASON_RUNNER_OFFLINE = 'Waiting for the runner to come online';
export const WIKI_REASON_RUNNER_UPGRADE = 'Upgrade the runner to read the repository';

/** One part of the line: its words, how it is coloured and marked, and where it leads when it is a link. */
export interface WikiStatusPart {
  text: string;
  /** muted: grey; warn: amber, a run that waits; error: red, a run that broke (the session list's dots). */
  tone: 'plain' | 'muted' | 'warn' | 'error';
  /** check: a green ✓ after it; dot: a coloured dot before it; spin: a spinner before it. */
  mark: 'none' | 'check' | 'dot' | 'spin';
  /** settings: the space's Wiki settings; run: the run that ended last — its session, or its row on Activity. */
  link: 'none' | 'settings' | 'run';
  strong: boolean;
}

const part = (text: string, shape: Partial<Omit<WikiStatusPart, 'text'>> = {}): WikiStatusPart => ({
  text,
  tone: 'plain',
  mark: 'none',
  link: 'none',
  strong: false,
  ...shape,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4m ago", "2h ago", "1d ago", "3w ago": when a run did something, as the line says it. */
export function wikiAgo(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return `${Math.floor(diff / (7 * DAY))}w ago`;
}

/**
 * How old the oldest fact waiting is: hours up to three days — the line turns amber past 24 of them, so
 * "26h" reads against that — and days after that.
 */
export function wikiLag(seconds: number): string {
  const ms = Math.max(0, seconds) * 1000;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < 3 * DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** The maintenance part of the line, in the space's look (contract `maintenance.health.look`). */
export function wikiMaintenanceParts(health: WikiMaintenanceHealth, now: number): WikiStatusPart[] {
  const catchUp = part(wikiToCatchUp(health.backlog));
  switch (health.look) {
    case 'off':
      return [part(WIKI_MAINTENANCE_OFF, { tone: 'muted' }), part(WIKI_MAINTENANCE_SET_UP, { link: 'settings' })];
    case 'running':
      return [
        part(wikiMaintainingNow(wikiAgo(health.running?.startedAt ?? '', now)), { mark: 'spin' }),
        catchUp,
      ];
    case 'behind': {
      const parts = [
        part(WIKI_MAINTENANCE_BEHIND, { tone: 'warn', mark: 'dot', strong: true }),
        part(wikiBehindBy(health.backlog, wikiLag(health.lagSeconds)), { tone: 'warn' }),
      ];
      if (health.lastRunAt) parts.push(part(wikiLastRun(wikiAgo(health.lastRunAt, now))));
      if (health.dailyLimitReached) parts.push(part(WIKI_DAILY_LIMIT_REACHED));
      else if (health.held?.reason === 'review_queue_full') parts.push(part(WIKI_REVIEW_QUEUE_FULL));
      return parts;
    }
    case 'failing': {
      const parts = [part(wikiMaintenanceFailed(health.consecutiveFailures), { tone: 'error', mark: 'dot', strong: true })];
      if (health.lastOkAt) parts.push(part(wikiLastSuccess(wikiAgo(health.lastOkAt, now))));
      parts.push(catchUp);
      if (health.lastRun?.sessionId || health.lastRun?.jobId) parts.push(part(WIKI_VIEW_RUN, { link: 'run' }));
      return parts;
    }
    case 'ok':
    default:
      return [
        health.lastOkAt ? part(wikiMaintained(wikiAgo(health.lastOkAt, now)), { mark: 'check' }) : part(WIKI_MAINTENANCE_ON),
        catchUp,
      ];
  }
}

/** The server's reason, when there is one to say (see `WIKI_REASON_*`); null under runner and while nothing holds. */
export function wikiServerReason(health: Pick<WikiSpaceHealth, 'executor' | 'systemModel' | 'repo' | 'maintenance'>): WikiStatusPart | null {
  if (!health.executor?.serverExecutes) return null;
  const reason = (text: string, tone: 'warn' | 'error') => part(text, { tone, mark: 'dot', strong: true });
  switch (health.systemModel?.state) {
    case 'worker_not_running':
      return reason(WIKI_REASON_WORKER, 'error');
    case 'unconfigured':
      return reason(WIKI_REASON_UNCONFIGURED, 'error');
    case 'auth_failed':
      return reason(WIKI_REASON_KEY_REFUSED, 'error');
    case 'down':
      return reason(WIKI_REASON_UNREACHABLE, 'warn');
    default:
      break;
  }
  // The runner matters to a space whose maintenance reads the repository, or that has a read of it waiting.
  const repo = health.repo;
  if (!repo || !(health.maintenance.enabled || repo.pending > 0)) return null;
  if (repo.look === 'runner_offline') return reason(WIKI_REASON_RUNNER_OFFLINE, 'warn');
  if (repo.look === 'runner_upgrade') return reason(WIKI_REASON_RUNNER_UPGRADE, 'warn');
  return null;
}

/** The status line's whole maintenance part: the look's parts, and the server's reason before their links. */
export function wikiStatusParts(health: WikiSpaceHealth, now: number): WikiStatusPart[] {
  const parts = wikiMaintenanceParts(health.maintenance, now);
  const reason = wikiServerReason(health);
  if (!reason) return parts;
  const link = parts.findIndex((one) => one.link !== 'none');
  return link < 0 ? [...parts, reason] : [...parts.slice(0, link), reason, ...parts.slice(link)];
}

/** The parts as one line of text: `●` before a dot, `✓` after a check, ` · ` between. */
export function wikiStatusText(parts: readonly WikiStatusPart[]): string {
  return parts
    .map((one) => `${one.mark === 'dot' ? '● ' : ''}${one.text}${one.mark === 'check' ? ' ✓' : ''}`)
    .join(' · ');
}
