import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from './workspaces.service';

/**
 * Creating a workspace from a git remote: what is written, what is refused before anything is
 * written, and what the two picker queries say.
 *
 * The clone itself belongs to the runner. What is testable here is the half the control plane
 * owns — the row goes in CLONING and eagerly, or the request is refused with the reason.
 */

const MB = 1024n * 1024n;
const ONLINE = { status: 'ONLINE', lastHeartbeatAt: new Date() };
const REPO = 'https://github.com/anthropics/orbit.git';

type Row = Record<string, unknown>;

interface StubOptions {
  runner?: Row | null;
  /** The workspace the disk probe finds under the repos root (null = never measured). */
  probe?: Row | null;
  /** Rows for `recentRepos`. */
  workspaceRows?: Row[];
  /** Rows for `cloneTargets`, each with its own nested `workspaces`. */
  runnerRows?: Row[];
  /** The row `get()` resolves, for the redispatch path. */
  workspace?: Row | null;
  /** How many rows the redispatch CAS matches. */
  updated?: number;
}

function stub(options: StubOptions = {}) {
  const creates: Row[] = [];
  const updates: Array<{ where: Row; data: Row }> = [];
  const prisma = {
    runner: {
      findFirst: async () =>
        options.runner === undefined ? { id: 'runner-1', ...ONLINE } : options.runner,
      findMany: async () => options.runnerRows ?? [],
    },
    workspace: {
      create: async ({ data }: { data: Row }) => {
        creates.push(data);
        return { id: 'workspace-1', ...data };
      },
      findFirst: async () => options.workspace ?? null,
      // Two reads share this method: the disk probe asks for one machine's workspaces, the recent
      // repositories ask for the owner's. Keyed on which, so a spec can seed both.
      findMany: async ({ where }: { where: Row }) =>
        where.runnerId ? (options.probe ? [options.probe] : []) : (options.workspaceRows ?? []),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        updates.push({ where, data });
        return { count: options.updated ?? 1 };
      },
    },
    user: { findUnique: async () => ({ preferences: {} }) },
    $queryRaw: async () => [],
  } as unknown as PrismaService;
  return { service: new WorkspacesService(prisma), creates, updates };
}

// ── Creating from a repo URL ──────────────────────────────────────────────────────────────────

test('a create carrying a repo URL writes the row CLONING, with no working directory yet', async () => {
  const s = stub({ runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: null } });

  const workspace = await s.service.create('owner-1', {
    name: 'orbit',
    runnerId: 'runner-1',
    repoUrl: REPO,
  });

  assert.equal(s.creates[0].provisionState, 'CLONING');
  assert.equal(s.creates[0].repoUrl, REPO);
  // The directory is written by the result, not guessed here: until the runner says where the
  // clone landed, this workspace has nowhere to run.
  assert.equal(s.creates[0].workDir, undefined);
  assert.equal((workspace as Row).provisionState, 'CLONING');
});

// The other half of the same flow: a checkout the machine already has. Nothing is dispatched, so
// none of the machine gates apply — the directory is already there.
test('a create carrying a repo URL and a directory reuses it, READY and un-dispatched', async () => {
  const s = stub({ runner: { id: 'runner-1', status: 'OFFLINE', lastHeartbeatAt: null } });

  await s.service.create('owner-1', {
    name: 'orbit',
    runnerId: 'runner-1',
    repoUrl: REPO,
    workDir: '/srv/repos/anthropics-orbit',
  });

  assert.equal(s.creates[0].provisionState, 'READY');
  assert.equal(s.creates[0].workDir, '/srv/repos/anthropics-orbit');
  assert.equal(s.creates[0].repoUrl, REPO);
});

test('a create with no repo URL is untouched by any of this', async () => {
  const s = stub();

  await s.service.create('owner-1', { name: 'hand-made', workDir: '/home/me/project' });

  assert.equal(s.creates[0].provisionState, 'READY');
  assert.equal(s.creates[0].repoUrl, undefined);
});

// ── The gates, all of them before the row exists ───────────────────────────────────────────────

test('a clone onto an offline machine is refused, not queued for its return', async () => {
  const s = stub({
    runner: { id: 'runner-1', status: 'OFFLINE', lastHeartbeatAt: null, reposRoot: '/srv/repos', minFreeDiskMb: null },
  });

  await assert.rejects(
    () => s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: REPO }),
    (e: unknown) => e instanceof BadRequestException && /offline/i.test(String((e as Error).message)),
  );
  assert.equal(s.creates.length, 0);
});

test('a runner too old to report a repos root is refused, and told why', async () => {
  const s = stub({ runner: { id: 'runner-1', ...ONLINE, reposRoot: null, minFreeDiskMb: null } });

  await assert.rejects(
    () => s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: REPO }),
    (e: unknown) =>
      e instanceof BadRequestException &&
      /where it keeps checkouts/i.test(String((e as Error).message)),
  );
  assert.equal(s.creates.length, 0);
});

// The floor is Runner.minFreeDiskMb and the reading is Workspace.workDirFreeBytes — the same two
// columns the auto-run dispatcher's gate uses, not a second threshold invented for clones.
test('a machine below its own free-space floor takes no clone', async () => {
  const s = stub({
    runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: 1024 },
    probe: { workDir: '/srv/repos/other-repo', workDirFreeBytes: 500n * MB, workDirProbedAt: new Date() },
  });

  await assert.rejects(
    () => s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: REPO }),
    (e: unknown) => {
      assert.ok(e instanceof BadRequestException);
      // Says how much is missing: 1024MB required, 500MB free.
      assert.match(String((e as Error).message), /549453824 bytes short/);
      return true;
    },
  );
  assert.equal(s.creates.length, 0);
});

test('the same floor with enough free space lets the clone through', async () => {
  const s = stub({
    runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: 1024 },
    probe: { workDir: '/srv/repos/other-repo', workDirFreeBytes: 4096n * MB, workDirProbedAt: new Date() },
  });

  await s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: REPO });

  assert.equal(s.creates[0].provisionState, 'CLONING');
});

// Fail-open on silence, exactly like the dispatcher's gate: a machine nobody has measured is not
// a machine known to be full.
test('a machine with a floor but no reading is not gated', async () => {
  const s = stub({
    runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: 1024 },
    probe: null,
  });

  await s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: REPO });

  assert.equal(s.creates[0].provisionState, 'CLONING');
});

// The gate reads the filesystem the clone will actually write to. A workspace living somewhere
// else on the same machine measures a different mount, and gating on it would refuse a clone on
// the strength of a number about another disk.
test('a reading from outside the repos root does not gate the clone', async () => {
  const s = stub({
    runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: 1024 },
    probe: { workDir: '/home/me/elsewhere', workDirFreeBytes: 1n, workDirProbedAt: new Date() },
  });

  await s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: REPO });

  assert.equal(s.creates[0].provisionState, 'CLONING');
});

test('a clone with no machine named is refused rather than assigned one', async () => {
  const s = stub();

  await assert.rejects(
    () => s.service.create('owner-1', { name: 'orbit', repoUrl: REPO }),
    (e: unknown) => e instanceof BadRequestException && /choose the machine/i.test(String((e as Error).message)),
  );
  assert.equal(s.creates.length, 0);
});

test('a URL no directory name can be derived from is refused before the row exists', async () => {
  const s = stub({ runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: null } });

  await assert.rejects(
    () => s.service.create('owner-1', { name: 'orbit', runnerId: 'runner-1', repoUrl: 'github.com' }),
    (e: unknown) => e instanceof BadRequestException && /derived/i.test(String((e as Error).message)),
  );
  assert.equal(s.creates.length, 0);
});

// ── Retry: the same dispatch, made again ──────────────────────────────────────────────────────

const failed = {
  id: 'workspace-1',
  repoUrl: REPO,
  runnerId: 'runner-1',
  provisionState: 'FAILED',
  provisionError: 'fatal: could not read Username',
};

test('a retry re-arms the row and clears the previous attempt’s stderr', async () => {
  const s = stub({
    workspace: failed,
    runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: null },
  });

  await s.service.redispatchClone('owner-1', 'workspace-1', {});

  assert.equal(s.updates[0].data.provisionState, 'CLONING');
  assert.equal(s.updates[0].data.provisionError, null);
  assert.equal(s.updates[0].data.repoUrl, REPO);
  // Only a failed clone re-arms: the CAS is what makes a double-click one dispatch.
  assert.equal(s.updates[0].where.provisionState, 'FAILED');
});

test('a retry can change the URL and the machine in the same call', async () => {
  const s = stub({
    workspace: failed,
    runner: { id: 'runner-2', ...ONLINE, reposRoot: '/data/repos', minFreeDiskMb: null },
  });

  await s.service.redispatchClone('owner-1', 'workspace-1', {
    repoUrl: 'git@github.com:anthropics/other.git',
    runnerId: 'runner-2',
  });

  assert.equal(s.updates[0].data.repoUrl, 'git@github.com:anthropics/other.git');
  assert.equal(s.updates[0].data.runnerId, 'runner-2');
});

test('a retry while one is already running is refused', async () => {
  const s = stub({
    workspace: { ...failed, provisionState: 'CLONING' },
    runner: { id: 'runner-1', ...ONLINE, reposRoot: '/srv/repos', minFreeDiskMb: null },
    updated: 0,
  });

  await assert.rejects(
    () => s.service.redispatchClone('owner-1', 'workspace-1', {}),
    (e: unknown) => e instanceof ConflictException && /already running/i.test(String((e as Error).message)),
  );
});

test('a workspace that was never made from a URL cannot be cloned again', async () => {
  const s = stub({ workspace: { id: 'workspace-1', repoUrl: null, runnerId: 'runner-1', provisionState: 'READY' } });

  await assert.rejects(
    () => s.service.redispatchClone('owner-1', 'workspace-1', {}),
    (e: unknown) => e instanceof BadRequestException && /repository URL/i.test(String((e as Error).message)),
  );
});

// ── Recent repositories ───────────────────────────────────────────────────────────────────────

test('recent repositories are distinct, and count the machines that really have one', async () => {
  const s = stub({
    workspaceRows: [
      { repoUrl: REPO, runnerId: 'runner-1', createdAt: new Date('2026-08-03'), provisionState: 'READY', workDir: '/a' },
      { repoUrl: REPO, runnerId: 'runner-2', createdAt: new Date('2026-08-02'), provisionState: 'READY', workDir: '/b' },
      // Same machine again: a second workspace on one machine is not a second machine.
      { repoUrl: REPO, runnerId: 'runner-2', createdAt: new Date('2026-08-01'), provisionState: 'READY', workDir: '/c' },
      // Cloning and failed rows are the repo you used, on no machine yet.
      { repoUrl: 'https://github.com/anthropics/tools.git', runnerId: 'runner-1', createdAt: new Date('2026-07-30'), provisionState: 'FAILED', workDir: null },
    ],
  });

  const repos = await s.service.recentRepos('owner-1');

  assert.deepEqual(repos.map((r) => r.repoUrl), [REPO, 'https://github.com/anthropics/tools.git']);
  assert.equal(repos[0].machineCount, 2);
  assert.equal(repos[0].workspaceCount, 3);
  assert.equal(repos[0].lastUsedAt, new Date('2026-08-03').toISOString());
  assert.equal(repos[1].machineCount, 0);
});

test('a workspace nobody told us the repository of is not a recent repository', async () => {
  const s = stub({ workspaceRows: [] });
  assert.deepEqual(await s.service.recentRepos('owner-1'), []);
});

// ── Machine candidates ────────────────────────────────────────────────────────────────────────

function machine(id: string, extra: Row = {}, workspaces: Row[] = []) {
  return {
    id,
    name: id,
    displayName: null,
    ...ONLINE,
    reposRoot: '/srv/repos',
    minFreeDiskMb: null,
    workspaces,
    ...extra,
  };
}

test('candidates mark each of the four states the picker has to render', async () => {
  const s = stub({
    runnerRows: [
      machine('fine'),
      machine('offline', { status: 'OFFLINE', lastHeartbeatAt: null }),
      machine('ancient', { reposRoot: null }),
      machine('full', { minFreeDiskMb: 1024 }, [
        {
          id: 'w-full',
          name: 'something',
          workDir: '/srv/repos/other-repo',
          repoUrl: null,
          provisionState: 'READY',
          workDirFreeBytes: 100n * MB,
          workDirProbedAt: new Date(),
        },
      ]),
      machine('has-it', {}, [
        {
          id: 'w-1',
          name: 'orbit',
          workDir: '/srv/repos/anthropics-orbit',
          repoUrl: 'git@github.com:anthropics/orbit.git',
          provisionState: 'READY',
          workDirFreeBytes: null,
          workDirProbedAt: null,
        },
      ]),
    ],
  });

  const byName = new Map((await s.service.cloneTargets('owner-1', REPO)).map((c) => [c.name, c]));

  assert.equal(byName.get('fine')?.eligible, true);
  assert.equal(byName.get('fine')?.ineligibleReason, null);
  assert.equal(byName.get('fine')?.targetDir, '/srv/repos/anthropics-orbit');

  assert.equal(byName.get('offline')?.eligible, false);
  assert.equal(byName.get('offline')?.ineligibleReason, 'OFFLINE');

  assert.equal(byName.get('ancient')?.eligible, false);
  assert.equal(byName.get('ancient')?.ineligibleReason, 'NO_REPOS_ROOT');
  // Nowhere to put a clone means no path to show, rather than one made up.
  assert.equal(byName.get('ancient')?.targetDir, null);

  assert.equal(byName.get('full')?.eligible, false);
  assert.equal(byName.get('full')?.ineligibleReason, 'DISK_SHORT');
  assert.equal(byName.get('full')?.shortfallBytes, 924n * MB);

  // Matched on what the remote IS: the workspace holds the ssh spelling, the query asked https.
  assert.deepEqual(byName.get('has-it')?.existingCheckout, {
    workspaceId: 'w-1',
    name: 'orbit',
    workDir: '/srv/repos/anthropics-orbit',
  });
  assert.equal(byName.get('has-it')?.eligible, true);
});

test('the machines that already have the repository come first', async () => {
  const s = stub({
    runnerRows: [
      machine('offline', { status: 'OFFLINE', lastHeartbeatAt: null }),
      machine('empty'),
      machine('has-it', {}, [
        {
          id: 'w-1',
          name: 'orbit',
          workDir: '/srv/repos/anthropics-orbit',
          repoUrl: REPO,
          provisionState: 'READY',
          workDirFreeBytes: null,
          workDirProbedAt: null,
        },
      ]),
    ],
  });

  const order = (await s.service.cloneTargets('owner-1', REPO)).map((c) => c.name);

  assert.deepEqual(order, ['has-it', 'empty', 'offline']);
});

// Whether a remote resolves is git's answer on the runner. This endpoint answers about machines,
// so an unusable URL must not empty the picker.
test('a URL nothing can be derived from still lists every machine', async () => {
  const s = stub({ runnerRows: [machine('fine')] });

  const [candidate] = await s.service.cloneTargets('owner-1', 'github.com');

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.targetDir, null);
  assert.equal(candidate.existingCheckout, null);
});

test('with no URL at all the question is only which machines can clone', async () => {
  const s = stub({ runnerRows: [machine('fine'), machine('ancient', { reposRoot: null })] });

  const candidates = await s.service.cloneTargets('owner-1');

  assert.deepEqual(candidates.map((c) => c.eligible), [true, false]);
  assert.deepEqual(candidates.map((c) => c.existingCheckout), [null, null]);
});

// A checkout still cloning is not one to reuse — there is no directory there yet.
test('an in-flight clone is not offered as an existing checkout', async () => {
  const s = stub({
    runnerRows: [
      machine('cloning', {}, [
        {
          id: 'w-1',
          name: 'orbit',
          workDir: null,
          repoUrl: REPO,
          provisionState: 'CLONING',
          workDirFreeBytes: null,
          workDirProbedAt: null,
        },
      ]),
    ],
  });

  assert.equal((await s.service.cloneTargets('owner-1', REPO))[0].existingCheckout, null);
});
