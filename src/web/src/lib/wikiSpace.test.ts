import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiSpaceRow } from './wiki';
import {
  WIKI_FROM_WORKSPACE_KEY,
  WIKI_LAST_SPACE_KEY,
  readWikiFromWorkspace,
  readWikiLastSpace,
  wikiDefaultSpace,
  wikiProposalsBanner,
  wikiProposalsWaiting,
  wikiSpaceNames,
  wikiSpaceOption,
  wikiWaiting,
  writeWikiFromWorkspace,
  writeWikiLastSpace,
} from './wikiSpace';

/**
 * The spaces' names, which one `/wiki` opens, and what waits on the owner across them, proved against
 * `src/shared/src/wiki-space.fixture.json` — the cases OrbitKit's space logic is held to as well (I1), so
 * the web and iOS name a space, open a space and count what waits by one rule.
 */

type Row = Pick<WikiSpaceRow, 'id' | 'title' | 'repoUrlNorm' | 'pendingOps' | 'planWaiting'>;

interface Fixture {
  names: Array<{ name: string; spaces: Array<Pick<WikiSpaceRow, 'id' | 'title' | 'repoUrlNorm'>>; names: Record<string, string> }>;
  defaults: Array<{
    name: string;
    spaces: Array<Pick<WikiSpaceRow, 'slug' | 'workspaceIds' | 'docs'>>;
    workspaceId: string | null;
    lastSlug: string | null;
    opens: string | null;
  }>;
  waiting: Array<{
    name: string;
    spaces: Row[];
    current: string;
    waiting: number;
    proposals: number;
    banner: string | null;
    options: string[];
  }>;
}

function fixture(): Fixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-space.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-space.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-space.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const shared = fixture();

describe('a space’s name', () => {
  for (const one of shared.names) {
    it(one.name, () => {
      expect(Object.fromEntries(wikiSpaceNames(one.spaces))).toEqual(one.names);
    });
  }
});

describe('the space /wiki opens: the workspace’s, the last looked at, the most written', () => {
  for (const one of shared.defaults) {
    it(one.name, () => {
      const opened = wikiDefaultSpace(one.spaces, { workspaceId: one.workspaceId, lastSlug: one.lastSlug });
      expect(opened?.slug ?? null).toBe(one.opens);
    });
  }

  it('covers each step of the rule, and the tie', () => {
    const names = shared.defaults.map((one) => one.name).join('\n');
    for (const step of ['workspace', 'last looked at', 'most documents written', 'first']) expect(names).toContain(step);
  });
});

describe('what waits on the owner', () => {
  for (const one of shared.waiting) {
    it(one.name, () => {
      const names = wikiSpaceNames(one.spaces);
      expect(wikiWaiting(one.spaces)).toBe(one.waiting);
      expect(wikiProposalsWaiting(one.spaces)).toBe(one.proposals);
      expect(wikiProposalsBanner(one.spaces, one.current, names)).toBe(one.banner);
      expect(one.spaces.map((space) => wikiSpaceOption(names.get(space.id)!, space))).toEqual(one.options);
    });
  }

  it('counts every proposal and every thing a plan waits on, and the first banner the proposals alone', () => {
    // At least two spaces, one of them with its plan waiting — the case criterion 4 names.
    const both = shared.waiting.filter((one) => one.spaces.length > 1 && one.spaces.some((space) => (space.planWaiting ?? 0) > 0));
    expect(both.length).toBeGreaterThan(0);
    for (const one of both) {
      expect(one.waiting).toBe(one.spaces.reduce((sum, space) => sum + space.pendingOps + (space.planWaiting ?? 0), 0));
      expect(one.proposals).toBe(one.spaces.reduce((sum, space) => sum + space.pendingOps, 0));
      expect(one.waiting).toBeGreaterThan(one.proposals);
    }
  });
});

describe('where the reader came from and what they last looked at', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
      key: () => null,
      get length() {
        return items.size;
      },
    };
  }

  it('keeps the last space in the browser, and the workspace for this tab alone', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    expect(readWikiLastSpace()).toBeNull();
    writeWikiLastSpace('wikova');
    expect(local.getItem(WIKI_LAST_SPACE_KEY)).toBe('wikova');
    expect(readWikiLastSpace()).toBe('wikova');

    writeWikiFromWorkspace('ws-orbit-develop');
    expect(session.getItem(WIKI_FROM_WORKSPACE_KEY)).toBe('ws-orbit-develop');
    expect(readWikiFromWorkspace()).toBe('ws-orbit-develop');
    // A page with no workspace (the Projects or Tasks list) clears it: the last look decides then.
    writeWikiFromWorkspace(null);
    expect(readWikiFromWorkspace()).toBeNull();
  });

  it('answers nothing, and throws nothing, in a browser with storage turned off', () => {
    const off = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('localStorage', off);
    vi.stubGlobal('sessionStorage', off);
    expect(() => writeWikiLastSpace('orbit')).not.toThrow();
    expect(() => writeWikiFromWorkspace('ws')).not.toThrow();
    expect(readWikiLastSpace()).toBeNull();
    expect(readWikiFromWorkspace()).toBeNull();
  });
});
