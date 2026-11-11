import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIKI_MAINTENANCE_LOOKS, WIKI_REPO_TIERS, type WikiSpaceHealth } from '@orbit/shared';
import {
  WIKI_REPO_FIX,
  wikiAgo,
  wikiLag,
  wikiMaintenanceParts,
  wikiRepoParts,
  wikiServerReason,
  wikiStatusParts,
  wikiStatusText,
  type WikiStatusPart,
} from './wikiHealth';

/**
 * The status line's maintenance part, proved against `src/shared/src/wiki-health.fixture.json` — the file
 * OrbitKit's `WikiHealthCopyParityTests` reads too, so the web and iOS say one sentence for one read.
 */

interface Fixture {
  now: string;
  cases: Array<{
    name: string;
    health: WikiSpaceHealth;
    parts: WikiStatusPart[];
    text: string;
    narrowParts: WikiStatusPart[];
    narrowText: string;
    line: string;
  }>;
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
      const parts = wikiStatusParts(one.health, now);
      expect(parts).toEqual(one.parts);
      expect(wikiStatusText(parts)).toBe(one.text);
      // A phone's line: the repository's short words, and the whole line under the title ends with it.
      const narrow = wikiStatusParts(one.health, now, true);
      expect(narrow).toEqual(one.narrowParts);
      expect(wikiStatusText(narrow)).toBe(one.narrowText);
      expect(one.line.endsWith(` · ${one.narrowText}`)).toBe(true);
      // A read with no server half says exactly what the look says (runner, or an older control plane).
      if (!one.health.executor?.serverExecutes) expect(parts).toEqual(wikiMaintenanceParts(one.health.maintenance, now));
    });
  }

  it('covers every look the contract names', () => {
    const looks = new Set(shared.cases.map((one) => one.health.maintenance.look));
    expect([...looks].sort()).toEqual([...WIKI_MAINTENANCE_LOOKS].sort());
  });

  it('covers every repository tier the contract names', () => {
    const tiers = new Set(shared.cases.map((one) => one.health.repo?.tier).filter(Boolean));
    expect([...tiers].sort()).toEqual([...WIKI_REPO_TIERS].sort());
  });

  it('links Set up only while maintenance is off, and View run only to a run that named its session or its job', () => {
    for (const one of shared.cases) {
      const repo = new Set(wikiRepoParts(one.health, false).map((part) => part.text));
      const links = wikiStatusParts(one.health, now).filter((part) => part.link !== 'none' && !repo.has(part.text));
      const look = one.health.maintenance.look;
      const lastRun = one.health.maintenance.lastRun;
      if (look === 'off') expect(links.map((part) => part.link)).toEqual(['settings']);
      else if (look === 'failing' && (lastRun?.sessionId || lastRun?.jobId)) expect(links.map((part) => part.link)).toEqual(['run']);
      else expect(links).toEqual([]);
    }
  });

  it('says one server reason, after the look and before its links, and only while the server runs the wiki', () => {
    const reasons = shared.cases.map((one) => wikiServerReason(one.health)?.text ?? null).filter((text): text is string => text !== null);
    expect(reasons).toEqual([
      'Waiting for the runner to come online',
      'System model unreachable',
      'System model refused the key',
      'System model not configured',
      'wiki worker not running',
      'Upgrade the runner to read the repository',
    ]);
    for (const one of shared.cases) {
      const parts = wikiStatusParts(one.health, now);
      const at = parts.findIndex((part) => part.text === wikiServerReason(one.health)?.text);
      const link = parts.findIndex((part) => part.link !== 'none');
      if (at >= 0 && link >= 0) expect(at).toBe(link - 1);
    }
    // A read that does not say the server executes the account's wiki says none, whatever the runner is doing.
    const offline = shared.cases.find((one) => one.health.repo?.look === 'runner_offline' && one.health.maintenance.enabled)!;
    expect(wikiServerReason(offline.health)?.text).toBe('Waiting for the runner to come online');
    expect(wikiServerReason({ ...offline.health, executor: undefined })).toBeNull();
  });
});

describe('the repository’s part of the line (design §7.2, mock 44 ⑤)', () => {
  const byTier = (tier: string) => shared.cases.find((one) => one.health.repo?.tier === tier && one.health.maintenance.look === 'ok')!;

  it('says nothing on git', () => {
    const git = byTier('git');
    expect(wikiRepoParts(git.health, false)).toEqual([]);
    expect(wikiStatusParts(git.health, now)).toEqual(wikiMaintenanceParts(git.health.maintenance, now));
  });

  it('says the folder in grey, leading to Settings, its cost in the hint', () => {
    const [folder] = wikiRepoParts(byTier('folder').health, false);
    expect(folder).toEqual({
      text: 'Reading the folder, not git', tone: 'muted', mark: 'none', link: 'settings', strong: false,
      hint: 'Commit anchors are not checked: ~/work/app is not a git checkout.',
    });
    expect(wikiRepoParts(byTier('folder').health, true).map((part) => part.text)).toEqual(['Reading the folder']);
  });

  it('says why code checks wait in amber, a folder somebody has to set right in red, and Fix in Settings last', () => {
    const sessions = wikiStatusParts(byTier('sessions').health, now);
    expect(sessions.at(-2)).toMatchObject({ text: 'Code checks paused: ~/work/app was not found on MacBook', tone: 'warn', mark: 'dot' });
    expect(sessions.at(-1)).toMatchObject({ text: WIKI_REPO_FIX, link: 'settings' });
    const wrong = wikiStatusParts(byTier('wrong_repository').health, now);
    expect(wrong.at(-2)).toMatchObject({ text: "~/work/app is a clone of github.com/x/y, not this wiki's repository", tone: 'error' });
    const refused = shared.cases.find((one) => one.health.repo?.reason === 'fetch_refused')!;
    expect(wikiRepoParts(refused.health, false)[0]).toMatchObject({ tone: 'error' });
    // Fix in Settings goes after the look's own link: View run stays where the look puts it.
    const failing = shared.cases.find((one) => one.health.repo?.tier === 'sessions' && one.health.maintenance.look === 'failing')!;
    expect(wikiStatusParts(failing.health, now).map((part) => part.text).slice(-3))
      .toEqual(['Code checks paused: ~/work/app was not found on MacBook', 'View run', WIKI_REPO_FIX]);
  });

  it('says the short words alone on a phone, and nothing while maintenance is off', () => {
    expect(wikiRepoParts(byTier('sessions').health, true).map((part) => part.text)).toEqual(['Code checks paused']);
    expect(wikiRepoParts(byTier('wrong_repository').health, true).map((part) => part.text)).toEqual(['Wrong folder']);
    const off = byTier('sessions').health;
    expect(wikiRepoParts({ ...off, maintenance: { ...off.maintenance, enabled: false } }, false)).toEqual([]);
  });

  it('says the offline runner once: as the reason the code checks wait, not again as the server’s reason', () => {
    const offline = shared.cases.find((one) => one.health.repo?.tier === 'sessions' && one.health.repo.reason === 'runner_offline')!;
    expect(wikiServerReason(offline.health)).toBeNull();
    expect(wikiStatusText(wikiStatusParts(offline.health, now)).match(/Waiting for the runner to come online/gu)).toHaveLength(1);
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
