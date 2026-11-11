import type { WikiSpaceHealth } from '@orbit/shared';
import { WIKI_REPO_FOLDER_SHORT, WIKI_REPO_PAUSED, WIKI_REPO_WRONG_SHORT, wikiAgo } from './wikiHealth';

/**
 * The repository's part of the Settings maintenance card (docs/wiki-repo-tiers-design.md §7.3, mock 44 ⑤ right column,
 * contract `maintenance.run.card`): what the last run read, when it was checked, and the ways to set it right —
 * `Check again and run now`, `Change workspace…`, and on a folder that shared too few files with the last snapshot,
 * `Use this folder`. The same words on iOS (`WikiRepoCardLogic`) and Android (`WikiRepoCardLogic`), all three held to
 * `src/shared/src/wiki-repo-card.fixture.json`.
 */
export const WIKI_CHECK_AND_RUN = 'Check again and run now';
export const WIKI_CHANGE_WORKSPACE = 'Change workspace…';
export const WIKI_USE_FOLDER = 'Use this folder';
export const WIKI_DAILY_LIMIT_HIT = 'Daily limit reached';
export const WIKI_RUN_UNDER_WAY = 'A run is under way';
export const WIKI_LAST_RUN_FAILED = 'Last run failed';
export const WIKI_LAST_RUN_FAILED_LINE = 'The last run failed';
export const WIKI_USE_FOLDER_TITLE = 'Use this folder?';
export const WIKI_USE_FOLDER_NOTE =
  'The next run keeps this folder\'s snapshot even though it shares few files with the last one, and later runs compare with it.';
export const WIKI_RUN_STARTED = 'Maintenance run started';
export const WIKI_RUN_REFUSED = "Couldn't start the run";
export const WIKI_PROBE_CHECKING = 'Checking the folder…';
export const WIKI_PROBE_FAILED = 'Could not check the folder';
export const WIKI_FOLDER_READING = 'Folder, not git · commit anchors off';

export type WikiRepoCardTone = 'muted' | 'warn' | 'error';

export interface WikiRepoCard {
  /** The tag beside the card's title. */
  tag: { text: string; tone: WikiRepoCardTone };
  /** What was read and when: `~/work/app was not found on MacBook · checked 2h ago`. */
  line: string;
  /** Check again and run now may be pressed; when it may not, `blocked` says why under it. */
  canRun: boolean;
  blocked: string | null;
  /** Use this folder is offered: the last read was refused for path_overlap. */
  useFolder: boolean;
}

/**
 * The card's repository part, or null when there is nothing to set right: maintenance on, and either the repository read
 * less than git (a tier other than git), or the last run failed.
 */
export function wikiRepoCard(health: Pick<WikiSpaceHealth, 'repo' | 'maintenance'>, now: number): WikiRepoCard | null {
  const { repo, maintenance } = health;
  if (!maintenance.enabled) return null;
  const tier = repo?.tier ?? null;
  const failed = maintenance.lastRun?.outcome === 'failed';
  if ((tier === null || tier === 'git') && !failed) return null;
  const tag: WikiRepoCard['tag'] = tier === 'folder'
    ? { text: WIKI_REPO_FOLDER_SHORT, tone: 'muted' }
    : tier === 'sessions'
      ? { text: WIKI_REPO_PAUSED, tone: repo?.reason === 'fetch_refused' ? 'error' : 'warn' }
      : tier === 'wrong_repository'
        ? { text: WIKI_REPO_WRONG_SHORT, tone: 'error' }
        : { text: WIKI_LAST_RUN_FAILED, tone: 'error' };
  const said = tier === 'folder'
    ? WIKI_FOLDER_READING
    : tier === 'sessions' || tier === 'wrong_repository'
      ? (repo?.detail ?? tag.text)
      : WIKI_LAST_RUN_FAILED_LINE;
  const when = repo?.checkedAt ?? maintenance.lastRun?.endedAt ?? null;
  const line = when ? `${said} · checked ${wikiAgo(when, now)}` : said;
  const blocked = maintenance.running ? WIKI_RUN_UNDER_WAY : maintenance.dailyLimitReached ? WIKI_DAILY_LIMIT_HIT : null;
  return { tag, line, canRun: blocked === null, blocked, useFolder: repo?.reason === 'path_overlap' };
}
