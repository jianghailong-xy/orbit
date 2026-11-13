import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WikiSpaceHealth } from '@orbit/shared';
import {
  WIKI_CHANGE_WORKSPACE,
  WIKI_CHECK_AND_RUN,
  WIKI_DAILY_LIMIT_HIT,
  WIKI_PROBE_CHECKING,
  WIKI_PROBE_FAILED,
  WIKI_RUN_REFUSED,
  WIKI_RUN_STARTED,
  WIKI_RUN_UNDER_WAY,
  WIKI_USE_FOLDER,
  WIKI_USE_FOLDER_NOTE,
  WIKI_USE_FOLDER_TITLE,
  wikiRepoCard,
  type WikiRepoCard,
} from './wikiRepoCard';

/**
 * The Settings maintenance card's repository part, proved against `src/shared/src/wiki-repo-card.fixture.json` — the file
 * OrbitKit's WikiRepoCardParityTests and Android's WikiRepoCardTest read too, so the three clients say the same words.
 */
interface Fixture {
  now: string;
  copy: Record<string, string>;
  cases: Array<{ name: string; health: WikiSpaceHealth; card: WikiRepoCard | null }>;
}

function fixture(): Fixture {
  const path = [
    resolve(process.cwd(), '../shared/src/wiki-repo-card.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-repo-card.fixture.json'),
  ].find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-repo-card.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const shared = fixture();

describe('the maintenance card says the fixture’s words for every case', () => {
  it.each(shared.cases.map((one) => [one.name, one] as const))('%s', (_name, one) => {
    expect(wikiRepoCard(one.health, Date.parse(shared.now))).toEqual(one.card);
  });

  it('names its buttons and its confirmation in the fixture’s words', () => {
    expect({
      checkAndRun: WIKI_CHECK_AND_RUN,
      changeWorkspace: WIKI_CHANGE_WORKSPACE,
      useFolder: WIKI_USE_FOLDER,
      useFolderTitle: WIKI_USE_FOLDER_TITLE,
      useFolderNote: WIKI_USE_FOLDER_NOTE,
      dailyLimit: WIKI_DAILY_LIMIT_HIT,
      runUnderWay: WIKI_RUN_UNDER_WAY,
      runStarted: WIKI_RUN_STARTED,
      runRefused: WIKI_RUN_REFUSED,
      probeChecking: WIKI_PROBE_CHECKING,
      probeFailed: WIKI_PROBE_FAILED,
    }).toEqual(shared.copy);
  });
});
