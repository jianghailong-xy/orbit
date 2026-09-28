import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIKI_MAINTENANCE_LOOKS, type WikiSpaceHealth } from '@orbit/shared';
import { wikiAgo, wikiLag, wikiMaintenanceParts, wikiStatusText, type WikiStatusPart } from './wikiHealth';

/**
 * The status line's maintenance part, proved against `src/shared/src/wiki-health.fixture.json` — the file
 * OrbitKit's `WikiHealthCopyParityTests` reads too, so the web and iOS say one sentence for one read.
 */

interface Fixture {
  now: string;
  cases: Array<{ name: string; health: WikiSpaceHealth; parts: WikiStatusPart[]; text: string; line: string }>;
}

function fixture(): Fixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-health.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-health.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-health.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const shared = fixture();
const now = Date.parse(shared.now);

describe('the status line says the fixture’s words for every look', () => {
  for (const one of shared.cases) {
    it(one.name, () => {
      const parts = wikiMaintenanceParts(one.health.maintenance, now);
      expect(parts).toEqual(one.parts);
      expect(wikiStatusText(parts)).toBe(one.text);
    });
  }

  it('covers every look the contract names', () => {
    const looks = new Set(shared.cases.map((one) => one.health.maintenance.look));
    expect([...looks].sort()).toEqual([...WIKI_MAINTENANCE_LOOKS].sort());
  });

  it('links Set up only while maintenance is off, and View run only to a run that named its session', () => {
    for (const one of shared.cases) {
      const links = wikiMaintenanceParts(one.health.maintenance, now).filter((part) => part.link !== 'none');
      const look = one.health.maintenance.look;
      if (look === 'off') expect(links.map((part) => part.link)).toEqual(['settings']);
      else if (look === 'failing' && one.health.maintenance.lastRun?.sessionId) expect(links.map((part) => part.link)).toEqual(['run']);
      else expect(links).toEqual([]);
    }
  });
});

describe('the line’s times', () => {
  it('says when a run did something the way the line reads it', () => {
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect(wikiAgo(at(0.5), now)).toBe('just now');
    expect(wikiAgo(at(4), now)).toBe('4m ago');
    expect(wikiAgo(at(125), now)).toBe('2h ago');
    expect(wikiAgo(at(25 * 60), now)).toBe('1d ago');
    expect(wikiAgo(at(15 * 24 * 60), now)).toBe('2w ago');
    // A clock a little ahead of the server's, or a time that cannot be read, is no time ago at all.
    expect(wikiAgo(at(-3), now)).toBe('just now');
    expect(wikiAgo('', now)).toBe('just now');
  });

  it('reads the oldest fact in hours up to three days, so 26h stands against the day that makes it amber', () => {
    expect(wikiLag(40 * 60)).toBe('40m');
    expect(wikiLag(26 * 3600)).toBe('26h');
    expect(wikiLag(71 * 3600 + 59 * 60)).toBe('71h');
    expect(wikiLag(72 * 3600)).toBe('3d');
    expect(wikiLag(14 * 86_400)).toBe('14d');
  });
});
