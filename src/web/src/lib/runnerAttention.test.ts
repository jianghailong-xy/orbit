import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KEEP_FREE_TIERS,
  compareRunnerVersions,
  formatDiskGb,
  keepFreeLabel,
  latestRunnerVersion,
  listAttentionLine,
  runnerAttention,
  runnerDisk,
  runnerListSubtitle,
  type AttentionWorkspace,
  type RunnerAttentionInput,
  type RunnerDisk,
} from './runnerAttention';
import * as copy from './runnerCopy';

/**
 * The rule is the case file: OrbitKit runs the same runnerAttention.cases.json against its Swift
 * port, so every case asserted here is asserted there too. What the file cannot carry — the detail
 * sentences, params and actions, which only this client computes from its own copy — is checked
 * below it.
 */

interface AttentionCase {
  name: string;
  input: RunnerAttentionInput;
  expected: {
    items: Array<{ kind: string; tone: string; short: string; title: string; actionKind: string | null }>;
    listLine: string | null;
    subtitle: string;
    disk: RunnerDisk | null;
  };
}

const CASES = JSON.parse(
  readFileSync(fileURLToPath(new URL('./runnerAttention.cases.json', import.meta.url)), 'utf8'),
) as AttentionCase[];

const COPY_SOURCE = readFileSync(fileURLToPath(new URL('./runnerCopy.ts', import.meta.url)), 'utf8');

const caseNamed = (name: string): AttentionCase => {
  const found = CASES.find((c) => c.name === name);
  if (!found) throw new Error(`runnerAttention.cases.json has no case named ${JSON.stringify(name)}`);
  return found;
};

describe('runnerAttention.cases.json', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const items = runnerAttention(c.input);
      expect(
        items.map(({ kind, tone, short, title, action }) => ({
          kind,
          tone,
          short,
          title,
          actionKind: action?.kind ?? null,
        })),
      ).toEqual(c.expected.items);
      expect(listAttentionLine(items)).toBe(c.expected.listLine);
      expect(runnerListSubtitle(c.input.runner, c.input.nowMs)).toBe(c.expected.subtitle);
      expect(runnerDisk(c.input.workspaces)).toEqual(c.expected.disk);
    });
  }

  it('names every case once, so a failure at either end points at one case', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
});

describe('the four runners of 2026-09-29, as the project states them', () => {
  const real = (runner: string) => {
    const found = CASES.filter((c) => c.name.startsWith('real ') && c.input.runner.name === runner);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const kinds = (c: AttentionCase) => c.expected.items.map((item) => item.kind);
  const claudeSignedOut = (c: AttentionCase) =>
    c.input.runner.engines?.some((e) => e.engine === 'claude' && e.installed && e.auth === 'no');

  it('wikova: its Claude weekly limit, then its disk', () => {
    const wikova = real('wikova');
    expect(kinds(wikova)).toEqual(['quotaNearLimit', 'diskLow']);
    expect(wikova.expected.listLine).toBe('Claude weekly limit 98% · Disk 95% full');
  });

  it('workstation and workstation-gpu: nothing, though Claude is signed out on both', () => {
    for (const name of ['workstation', 'workstation-gpu']) {
      const c = real(name);
      expect(claudeSignedOut(c), name).toBe(true);
      expect(c.input.workspaces.some((w) => w.lastProvider === 'claude'), name).toBe(false);
      expect(kinds(c), name).toEqual([]);
      expect(c.expected.listLine, name).toBeNull();
    }
  });

  it('longdeMac-mini.local: offline and can’t update itself, its row says only offline, and its failing Claude update waits', () => {
    const mac = real('longdeMac-mini.local');
    expect(kinds(mac)).toEqual(['offline', 'cannotSelfUpdate']);
    expect(mac.expected.listLine).toBeNull();
    expect(mac.expected.subtitle).toBe('Offline · last seen 14d ago · v0.1.155');
    expect(mac.input.runner.engines?.find((e) => e.engine === 'claude')?.update?.status).toBe('failed');
    // The same machine online raises that update, which is what makes "offline" the reason here.
    expect(kinds(caseNamed('the Mac mini back online: its failing Claude update is raised after it can’t update itself'))).toEqual([
      'cannotSelfUpdate',
      'engineNotUpdating',
    ]);
  });
});

describe('listAttentionLine', () => {
  it('writes no line for items that say the runner is offline, whatever else they hold', () => {
    const [offline] = runnerAttention(caseNamed('offline for 5 hours').input);
    const online = runnerAttention(
      caseNamed('everything at once: most severe first, and the list line shows the first two').input,
    );
    expect(offline.kind).toBe('offline');
    expect(listAttentionLine(online)).toBe('Claude signed out · app checkout stuck in a rebase');
    expect(listAttentionLine([offline, ...online])).toBeNull();
    expect(listAttentionLine([...online, offline])).toBeNull();
    expect(listAttentionLine([offline])).toBeNull();
  });
});

describe('what an item says beyond the case file', () => {
  const itemsOf = (name: string) => runnerAttention(caseNamed(name).input);

  it('uses the available account’s own window and reset when every account is near its limit', () => {
    const [quota] = itemsOf(
      'all Claude accounts near their limits: the account with most room supplies its own fullest window',
    );
    expect(quota.params).toEqual({
      engine: 'claude',
      window: '5-hour limit',
      percent: 94,
      resetsAt: '2026-09-29T03:00:00Z',
      workspaces: ['app'],
    });
  });

  it('wikova: the quota names the workspace that spends it and keeps the reset time raw', () => {
    const [quota, disk] = itemsOf('real wikova: Claude weekly 98% and a 95% full disk');
    expect(quota.detail).toBe(
      'wikova-develop runs on this machine’s Claude login — its sessions pause if the limit runs out.',
    );
    expect(quota.action).toBeUndefined();
    expect(quota.params).toEqual({
      engine: 'claude',
      window: 'weekly limit',
      percent: 98,
      resetsAt: '2026-10-02T03:59:59Z',
      workspaces: ['wikova-develop'],
    });
    expect(disk.detail).toBe(
      '9.4 GB free of 197 GB. No reserve is set, so task runs keep landing here until the disk fills.',
    );
    expect(disk.action).toEqual({ kind: 'setReserve' });
    expect(disk.params).toEqual({
      freeBytes: 10087419904,
      totalBytes: 211157901312,
      usedPercent: 95,
      reserveMb: null,
    });
  });

  it('the Mac mini: how to wake it, and the command that updates it', () => {
    const [offline, cannotUpdate] = itemsOf(
      'real longdeMac-mini.local: offline 14 days and can’t update itself; its failing Claude update is not raised while offline',
    );
    expect(offline.detail).toBe('Start the runner on that machine — it reconnects within 30 seconds.');
    expect(offline.action).toBeUndefined();
    expect(offline.params).toEqual({ lastSeenAt: '2026-09-14T14:25:09Z', sessions: 0 });
    expect(cannotUpdate.detail).toBe(
      'It runs as a regular user, so it can’t replace its own binary — still on 0.1.155, latest is ' +
        '0.1.197. On that machine, run sudo orbit upgrade.',
    );
    expect(cannotUpdate.action).toEqual({ kind: 'copyCommand', command: 'sudo orbit upgrade' });
    expect(cannotUpdate.params).toEqual({ version: '0.1.155', latest: '0.1.197' });
  });

  it('an offline runner counts the sessions waiting on it', () => {
    const input = caseNamed('offline for 5 hours').input;
    const detail = (activeSessions: number) =>
      runnerAttention({ ...input, runner: { ...input.runner, activeSessions } })[0].detail;
    expect(detail(1)).toBe(
      'Its 1 session waits until it checks in again. Start the runner on that machine — it reconnects within 30 seconds.',
    );
    expect(detail(3)).toBe(
      'Its 3 sessions wait until it checks in again. Start the runner on that machine — it reconnects within 30 seconds.',
    );
  });

  it('a signed-out login names every workspace it stops, and offers that engine’s sign-in', () => {
    const input = caseNamed('Claude signed out and a workspace runs on claude: raised').input;
    const on = (...names: string[]) =>
      runnerAttention({
        ...input,
        workspaces: names.map((name): AttentionWorkspace => ({ id: `ws-${name}`, name, lastProvider: 'claude' })),
      })[0];
    expect(on('app').detail).toBe(
      'app runs on this machine’s Claude login — its sessions fail until you sign in again.',
    );
    expect(on('app', 'docs').detail).toBe(
      'app and docs run on this machine’s Claude login — their sessions fail until you sign in again.',
    );
    expect(on('app', 'docs', 'site').detail).toBe(
      'app and 2 more run on this machine’s Claude login — their sessions fail until you sign in again.',
    );
    expect(on('app').action).toEqual({ kind: 'signIn', engine: 'claude' });
    expect(on('app', 'docs').params).toEqual({ engine: 'claude', workspaces: ['app', 'docs'] });
  });

  it('a stuck checkout repairs through the first workspace in it', () => {
    const [orbit] = itemsOf('two workspaces in one stuck checkout are one item, named after the first');
    expect(orbit.detail).toBe(
      'Nothing can merge into it until it’s cleaned up. Repair saves everything it holds to an ' +
        'orbit/rescue-… branch, then returns it to its last commit.',
    );
    expect(orbit.action).toEqual({ kind: 'repair', workspaceId: 'ws-orbit' });
    expect(orbit.params).toEqual({
      workspaceId: 'ws-orbit',
      workspaces: ['orbit', 'orbit-docs'],
      root: '/srv/orbit',
      state: 'merge',
      branch: null,
    });
  });

  it('a disk under Keep Free says so', () => {
    const [disk] = itemsOf('Keep Free 50 GB and 40 GB free: raised, though 20% of the disk is free');
    expect(disk.detail).toBe(
      '40 GB free of 200 GB, under the 50 GB it keeps free — task runs stop being sent here until space frees up.',
    );
    expect(disk.params.reserveMb).toBe(51200);
  });

  it('an engine that stopped updating says how far behind it is, and updates that engine', () => {
    const [claude] = itemsOf('Claude Code 12 days behind: raised, whether or not a workspace runs on it');
    expect(claude.detail).toBe(
      '12d behind 2.1.290. Orbit retries every 30 min — Update Engines Now tries again right away.',
    );
    expect(claude.action).toEqual({ kind: 'updateEngines', engine: 'claude' });
    expect(claude.params).toEqual({ engine: 'claude', note: '12d behind 2.1.290', latest: '2.1.290' });
    const [opencode] = itemsOf('OpenCode never updated: raised under its own name');
    expect(opencode.detail).toBe(
      'Never updated. Orbit retries every 30 min — Update Engines Now tries again right away.',
    );
  });
});

describe('runnerDisk', () => {
  it('reads the byte counts the API sends as strings, and plain numbers', () => {
    expect(runnerDisk([{ id: 'a', name: 'a', workDirFreeBytes: '1073741824', workDirTotalBytes: 10737418240 }])).toEqual({
      freeBytes: 1073741824,
      totalBytes: 10737418240,
      usedPercent: 90,
    });
  });

  it('ignores readings it cannot trust', () => {
    const reading = (free: unknown, total: unknown): AttentionWorkspace =>
      ({ id: 'a', name: 'a', workDirFreeBytes: free, workDirTotalBytes: total }) as AttentionWorkspace;
    expect(runnerDisk([])).toBeNull();
    expect(runnerDisk([reading('abc', '100'), reading('-5', '100'), reading('1.5', '100')])).toBeNull();
    expect(runnerDisk([reading(0, 0), reading(null, '100'), reading('5', null)])).toBeNull();
  });

  it('never reports more than 100% used', () => {
    expect(runnerDisk([{ id: 'a', name: 'a', workDirFreeBytes: 0, workDirTotalBytes: 3 }])?.usedPercent).toBe(100);
  });
});

describe('formatDiskGb', () => {
  const GIB = 1024 ** 3;

  it('counts 1024³ bytes to the GB, whole from 10 GB up and one decimal below', () => {
    expect(formatDiskGb(211157901312)).toBe('197');
    expect(formatDiskGb(10087419904)).toBe('9.4');
    expect(formatDiskGb(10 * GIB)).toBe('10');
    expect(formatDiskGb(GIB)).toBe('1.0');
    expect(formatDiskGb(0)).toBe('0.0');
    expect(formatDiskGb(Math.round(9.94 * GIB))).toBe('9.9');
    expect(formatDiskGb(Math.round(10.5 * GIB))).toBe('11');
  });

  it('writes a value that rounds up to 10 the way 10 GB and more are written', () => {
    expect(formatDiskGb(Math.round(9.96 * GIB))).toBe('10');
  });
});

describe('Keep Free', () => {
  it('offers Off, 10, 20 and 50 GB, written as minFreeDiskMb', () => {
    expect(KEEP_FREE_TIERS).toEqual([
      { mb: null, label: 'Off' },
      { mb: 10240, label: '10 GB' },
      { mb: 20480, label: '20 GB' },
      { mb: 51200, label: '50 GB' },
    ]);
  });

  it('shows a floor set to something else as it is', () => {
    expect(keepFreeLabel(null)).toBe('Off');
    expect(keepFreeLabel(undefined)).toBe('Off');
    expect(keepFreeLabel(0)).toBe('Off');
    expect(keepFreeLabel(20480)).toBe('20 GB');
    expect(keepFreeLabel(15000)).toBe('15 GB');
    expect(keepFreeLabel(5000)).toBe('4.9 GB');
  });
});

describe('runner versions', () => {
  it('compares segment by segment as numbers', () => {
    expect(compareRunnerVersions('0.1.197', '0.1.155')).toBeGreaterThan(0);
    expect(compareRunnerVersions('0.1.155', '0.1.197')).toBeLessThan(0);
    expect(compareRunnerVersions('0.1.100', '0.1.99')).toBeGreaterThan(0);
    expect(compareRunnerVersions('0.2', '0.1.300')).toBeGreaterThan(0);
    expect(compareRunnerVersions('0.1.197', '0.1.197')).toBe(0);
    expect(compareRunnerVersions('1.0', '1.0.0')).toBe(0);
    expect(compareRunnerVersions('v0.1.197', '0.1.197')).toBe(0);
  });

  it('takes the latest of the published release and what the account’s runners run', () => {
    const fleet = [{ version: '0.1.197' }, { version: '0.1.194' }, { version: '0.1.155' }, { version: null }];
    expect(latestRunnerVersion('0.1.197', fleet)).toBe('0.1.197');
    expect(latestRunnerVersion(null, fleet)).toBe('0.1.197');
    expect(latestRunnerVersion('0.1.198', fleet)).toBe('0.1.198');
    expect(latestRunnerVersion('0.1.190', [{ version: '0.1.194' }])).toBe('0.1.194');
    expect(latestRunnerVersion(undefined, [])).toBeNull();
    expect(latestRunnerVersion('', [{ version: null }])).toBeNull();
  });
});

describe('runnerCopy', () => {
  it('fills in every sentence with values the way the mocks read', () => {
    expect(copy.runnerOfflineLastSeen('14d ago')).toBe('Offline · last seen 14d ago');
    expect(copy.runnerVersionTag('0.1.197')).toBe('v0.1.197');
    expect(copy.runnerRunningOf(4, 12)).toBe('4 of 12 running');
    expect(copy.runnerSlots(4, 12)).toBe('4/12');
    expect(copy.runnerGb('9.4')).toBe('9.4 GB');
    expect(copy.runnerDiskUsed('186', '197')).toBe('186 of 197 GB used');
    expect(copy.runnerEnginesChecked('6 min ago')).toBe('Checked 6 min ago');
    expect(copy.runnerEnginesReported('Sep 14')).toBe('Reported Sep 14');
    expect(copy.runnerEngineAccountsSignedIn(2)).toBe('2 accounts signed in');
    expect(copy.runnerEngineUpdateFailed('2.1.270', 'Sep 13')).toBe('Update to 2.1.270 failed Sep 13');
    expect(copy.runnerWorkspaceRunning(4)).toBe('4 running');
    expect(copy.runnerInstallCommandUnix('https://orbitd.io')).toBe(
      'curl -fsSL https://orbitd.io/install.sh | bash',
    );
    expect(copy.runnerInstallCommandWindows('https://orbitd.io')).toBe('irm https://orbitd.io/install.ps1 | iex');
    expect(copy.runnerNamesTwo('orbit', 'site')).toBe('orbit and site');
    expect(copy.runnerNamesMore('orbit', 2)).toBe('orbit and 2 more');
    expect(copy.attentionOfflineFor(14, copy.RUNNER_UNIT_DAYS)).toBe('Offline for 14 days');
    expect(copy.attentionOfflineSessionsWait(3)).toBe('Its 3 sessions wait until it checks in again.');
    expect(copy.attentionSignedOutShort('Claude')).toBe('Claude signed out');
    expect(copy.attentionSignedOutTitle('Claude')).toBe('Claude is signed out');
    expect(copy.attentionSignedOutDetail('wikova-develop', 'Claude')).toBe(
      'wikova-develop runs on this machine’s Claude login — its sessions fail until you sign in again.',
    );
    expect(copy.attentionSignedOutDetailMany('orbit and site', 'Codex')).toBe(
      'orbit and site run on this machine’s Codex login — their sessions fail until you sign in again.',
    );
    expect(copy.attentionCheckoutStuck('orbit', copy.RUNNER_GIT_MERGE)).toBe('orbit checkout stuck in a merge');
    expect(copy.attentionQuotaShort('Claude', copy.RUNNER_QUOTA_WEEKLY, 98)).toBe('Claude weekly limit 98%');
    expect(copy.attentionQuotaTitle('Claude', copy.RUNNER_QUOTA_WEEKLY, 98)).toBe('Claude weekly limit at 98%');
    expect(copy.attentionQuotaResets('Thu, Oct 2 at 11:59 AM')).toBe('Resets Thu, Oct 2 at 11:59 AM.');
    expect(copy.attentionQuotaDetail('wikova-develop', 'Claude')).toBe(
      'wikova-develop runs on this machine’s Claude login — its sessions pause if the limit runs out.',
    );
    expect(copy.attentionQuotaDetailMany('orbit and site', 'Claude')).toBe(
      'orbit and site run on this machine’s Claude login — their sessions pause if the limit runs out.',
    );
    expect(copy.attentionDiskFull(94)).toBe('Disk 94% full');
    expect(copy.attentionDiskNoReserve('11', '197')).toBe(
      '11 GB free of 197 GB. No reserve is set, so task runs keep landing here until the disk fills.',
    );
    expect(copy.attentionDiskBelowReserve('9.4', '197', '10')).toBe(
      '9.4 GB free of 197 GB, under the 10 GB it keeps free — task runs stop being sent here until space frees up.',
    );
    expect(copy.attentionCantUpdateItselfDetail('0.1.155', '0.1.197', copy.RUNNER_UPGRADE_COMMAND)).toBe(
      'It runs as a regular user, so it can’t replace its own binary — still on 0.1.155, latest is 0.1.197. ' +
        'On that machine, run sudo orbit upgrade.',
    );
    expect(copy.attentionEngineUpdateFailed('Claude Code')).toBe('Claude Code update failed');
    expect(copy.attentionEngineUpdateDetail('18d behind 2.1.270')).toBe(
      '18d behind 2.1.270. Orbit retries every 30 min — Update Engines Now tries again right away.',
    );
  });

  it('says the sentences the project names, word for word', () => {
    expect([
      copy.RUNNER_NEEDS_ATTENTION,
      copy.RUNNER_CAPACITY,
      copy.RUNNER_ENGINES,
      copy.RUNNER_WORKSPACES,
      copy.RUNNER_ABOUT,
    ]).toEqual(['Needs Attention', 'Capacity', 'Engines', 'Workspaces', 'About This Runner']);
    expect([
      copy.RUNNER_SET_A_RESERVE,
      copy.RUNNER_COPY_COMMAND,
      copy.RUNNER_SIGN_IN,
      copy.RUNNER_REPAIR,
      copy.RUNNER_UPDATE_ENGINES_NOW,
      copy.RUNNER_REFRESH_MODEL_LISTS,
      copy.RUNNER_ROTATE_TOKEN,
      copy.RUNNER_REMOVE,
      copy.RUNNER_ADD,
    ]).toEqual([
      'Set a Reserve…',
      'Copy Command',
      'Sign In',
      'Repair',
      'Update Engines Now',
      'Refresh Model Lists',
      'Rotate Token…',
      'Remove Runner',
      'Add Runner',
    ]);
    expect(copy.RUNNER_VERSION_LATEST).toBe('Latest');
    expect(copy.RUNNER_VERSION_INSTALLS_WHEN_IDLE).toBe('installs when no turn is running');
    expect(copy.RUNNER_ROOT_NO_BYPASS).toBe('Runs as root, so sessions here can’t use Bypass permissions.');
    expect(copy.RUNNER_WORKSPACES_FOOTER).toBe(
      'Tap a workspace to open its sessions. Add or change workspaces on the web.',
    );
  });

  // OrbitKit's parity test reads runnerCopy.ts as text, so the file's shape is part of the contract.
  it('declares each fixed sentence as one quoted constant', () => {
    const declared = COPY_SOURCE.match(/^export const /gm)?.length ?? 0;
    const quoted = [
      ...COPY_SOURCE.matchAll(/^export const [A-Z0-9_]+ =\s*'[^'\n]*'(?:\s*\+\s*'[^'\n]*')*;$/gm),
    ];
    expect(declared).toBeGreaterThan(0);
    expect(quoted).toHaveLength(declared);
  });

  it('writes each sentence with values as one template of its own parameters', () => {
    const declared = COPY_SOURCE.match(/^export function /gm)?.length ?? 0;
    const templates = [
      ...COPY_SOURCE.matchAll(
        /^export function \w+\(([^)]*)\): string \{\n {2}return `([^`]*)`;\n\}$/gm,
      ),
    ];
    expect(declared).toBeGreaterThan(0);
    expect(templates).toHaveLength(declared);
    for (const [, params, template] of templates) {
      const names = params.split(',').map((p) => p.split(':')[0].trim());
      for (const [, used] of template.matchAll(/\$\{([^}]*)\}/g)) {
        expect(names, `\${${used}} in \`${template}\``).toContain(used);
      }
    }
  });
});
