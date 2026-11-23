import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { folderNameOf, freeWorkspaceName, newFolderWorkDirOn, readNewWorkspace } from './new-workspace';
import { SessionsService } from './sessions.service';

/**
 * POST /sessions `newWorkspace` read from the request (docs/first-workspace-contract.md §3.1, §3.2): one folder on one
 * machine, and the workspace's name and directory made from it. first-workspace.pg.spec.ts drives the same over HTTP.
 */

const RUNNER = '0190a0b0-0000-7000-8000-0000000000aa';

test('a folder already on the machine, or a new one under its reposRoot, on the machine the request names', () => {
  assert.deepEqual(readNewWorkspace({ workDir: '  /home/orbit/code/app  ' }, { assignedRunnerId: RUNNER }),
    { runnerId: RUNNER, workDir: '/home/orbit/code/app' });
  assert.deepEqual(readNewWorkspace({ newFolder: 'my-app_2.0' }, { assignedRunnerId: RUNNER }), { runnerId: RUNNER, newFolder: 'my-app_2.0' });
});

test('anything else is a 400, before any machine is looked at', () => {
  const refused: Array<[unknown, Record<string, unknown>]> = [
    ['app', { assignedRunnerId: RUNNER }],
    [['app'], { assignedRunnerId: RUNNER }],
    [{}, { assignedRunnerId: RUNNER }],
    [{ workDir: '/a', newFolder: 'b' }, { assignedRunnerId: RUNNER }],
    [{ workDir: '/a' }, { assignedRunnerId: RUNNER, workspaceId: RUNNER }],
    [{ workDir: '/a' }, { assignedRunnerId: RUNNER, agentId: RUNNER }],
    [{ workDir: '/a' }, {}],
    [{ workDir: '/a' }, { assignedRunnerId: 7 }],
    [{ workDir: '   ' }, { assignedRunnerId: RUNNER }],
    [{ workDir: 42 }, { assignedRunnerId: RUNNER }],
    [{ workDir: `/${'x'.repeat(4096)}` }, { assignedRunnerId: RUNNER }],
    ...['', '.', '..', 'a/b', 'a\\b', '~', 'my app', 'x'.repeat(65), 'café'].map(
      (newFolder): [unknown, Record<string, unknown>] => [{ newFolder }, { assignedRunnerId: RUNNER }],
    ),
    [{ newFolder: null }, { assignedRunnerId: RUNNER }],
  ];
  for (const [value, body] of refused) {
    assert.throws(() => readNewWorkspace(value, body), BadRequestException, JSON.stringify([value, body]));
  }
  assert.doesNotThrow(() => readNewWorkspace({ newFolder: 'x'.repeat(64) }, { assignedRunnerId: RUNNER }));
  assert.doesNotThrow(() => readNewWorkspace({ newFolder: '...' }, { assignedRunnerId: RUNNER }), 'only . and .. are refused');
});

test('the name is the folder\'s', () => {
  assert.equal(folderNameOf('/home/orbit/code/app'), 'app');
  assert.equal(folderNameOf('/home/orbit/code/app/'), 'app');
  assert.equal(folderNameOf('~/notes'), 'notes');
  assert.equal(folderNameOf('C:\\Users\\orbit\\api'), 'api');
  assert.equal(folderNameOf('/'), '/', 'a path with no last segment names itself');
});

test('a new folder goes where every client\'s setup card shows it: new-folder-root.fixture.json', () => {
  const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/new-folder-root.fixture.json'), 'utf8')) as {
    cases: { name: string; runner: { managed: boolean; up: boolean; reposRoot: string | null; capabilities: string[] }; path: string | null }[];
  };
  for (const c of fixture.cases) {
    // The fixture's [] is a runner that has not reported; the server reads that from capabilitiesReportedAt.
    const runner = {
      reposRoot: c.runner.reposRoot,
      capabilities: c.runner.capabilities,
      capabilitiesReportedAt: c.runner.capabilities.length ? new Date() : null,
      managedRunner: c.runner.managed ? { id: 'managed' } : null,
      // `up` as the runner list reads it: heard from just now, or never.
      status: c.runner.up ? 'ONLINE' : 'OFFLINE',
      lastHeartbeatAt: c.runner.up ? new Date() : null,
    };
    if (c.path === null) assert.throws(() => newFolderWorkDirOn(runner, 'app'), /NEW_FOLDER_UNSUPPORTED|cannot make|too old/, c.name);
    else assert.equal(newFolderWorkDirOn(runner, 'app'), c.path, c.name);
  }
});

test('a name the account already has gets " 2", " 3", …: the smallest one free', () => {
  assert.equal(freeWorkspaceName('app', []), 'app');
  assert.equal(freeWorkspaceName('app', ['app-api', 'apps']), 'app', 'only the name itself is a clash');
  assert.equal(freeWorkspaceName('app', ['app']), 'app 2');
  assert.equal(freeWorkspaceName('app', ['app', 'app 2']), 'app 3');
  assert.equal(freeWorkspaceName('app', ['app', 'app 3']), 'app 2');
  assert.equal(freeWorkspaceName('app', ['App']), 'app', 'names are compared as they are written');
});

/**
 * The one log line this path has (rehearsal finding F9): how it ended, for whom, on which machine, and nothing the
 * message said. The folder is the only thing it quotes.
 */
test('making a workspace logs one line, success or failure, with the path and never the message', async () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const target = { runnerId: RUNNER, workDir: '/home/orbit/code/app', name: 'app', autoCreateWorkDir: false };
  const SECRET = 'the words of the first message';
  const harness = (fail?: Error) => {
    const said: { log: string[]; warn: string[] } = { log: [], warn: [] };
    const marked: string[] = [];
    const tx = {
      $executeRaw: async () => 1,
      workspace: {
        findMany: async () => [{ name: 'app' }],
        create: async ({ data }: { data: { name: string } }) => ({ id: 'workspace-id', name: data.name }),
      },
      attachment: { updateMany: async () => ({ count: 0 }) },
    };
    const self = {
      prisma: { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) },
      logger: { log: (m: string) => said.log.push(m), warn: (m: string) => said.warn.push(m), error: () => undefined },
      realtime: { markRunnerChanged: (id: string) => marked.push(id) },
    };
    const make = (SessionsService.prototype as unknown as { createInNewWorkspace: (...args: unknown[]) => Promise<unknown> }).createInNewWorkspace;
    const insertSession = async () => {
      if (fail) throw fail;
      return { id: 'session-id', prompt: SECRET, importedAt: null };
    };
    const opening = { attachmentIds: [], shell: false, attachmentsAlone: false };
    return { said, marked, run: () => make.call(self, OWNER, target, insertSession, opening) };
  };

  const made = harness();
  assert.deepEqual(await made.run(), { id: 'session-id', prompt: SECRET, importedAt: null });
  assert.deepEqual(made.marked, [RUNNER]);
  assert.deepEqual(made.said.warn, []);
  assert.equal(made.said.log.length, 1);
  const line = made.said.log[0];
  for (const part of ['workspace-id', '"app 2"', OWNER, RUNNER, '"/home/orbit/code/app"', 'session-id']) {
    assert.ok(line.includes(part), `${line} lacks ${part}`);
  }

  const refused = Object.assign(new Error(`insert failed for ${SECRET}`), { code: 'P2003' });
  const failed = harness(refused);
  await assert.rejects(failed.run(), refused);
  assert.deepEqual(failed.marked, [], 'nothing was made, so nothing is marked');
  assert.deepEqual(failed.said.log, []);
  assert.equal(failed.said.warn.length, 1);
  for (const part of ['"app"', OWNER, RUNNER, '"/home/orbit/code/app"', 'not created', 'P2003']) {
    assert.ok(failed.said.warn[0].includes(part), `${failed.said.warn[0]} lacks ${part}`);
  }
  assert.ok(!failed.said.warn[0].includes(SECRET), 'the error\'s message stays out of the line');
});


test('an unreported managed runner uses the image home; after reporting it follows the advertised folder rule', () => {
  const managed = {
    managedRunner: { id: 'managed' }, reposRoot: null, capabilities: [], capabilitiesReportedAt: null,
    status: 'OFFLINE', lastHeartbeatAt: null,
  };
  assert.equal(newFolderWorkDirOn(managed, 'app'), '/home/orbit/app');
  const reported = {
    ...managed, reposRoot: '/home/orbit/orbit-repos', capabilitiesReportedAt: new Date(),
    capabilities: ['create-workdir/v1', 'create-workdir/v2'], status: 'ONLINE', lastHeartbeatAt: new Date(),
  };
  assert.equal(newFolderWorkDirOn(reported, 'app'), '/home/orbit/app');
  assert.equal(newFolderWorkDirOn({ ...reported, capabilities: ['create-workdir/v1'] }, 'app'), '/home/orbit/orbit-repos/app');
  // Asleep since an image that declared v1 only: it wakes on the current one, so the image's home.
  const asleep = { ...reported, capabilities: ['create-workdir/v1'], status: 'OFFLINE', lastHeartbeatAt: new Date('2026-11-17T15:45:00Z') };
  assert.equal(newFolderWorkDirOn(asleep, 'app'), '/home/orbit/app');
  // A runner that declares nothing reads as one that has not reported, as every client reads it.
  assert.equal(newFolderWorkDirOn({ ...reported, capabilities: [] }, 'app'), '/home/orbit/app');
  assert.throws(() => newFolderWorkDirOn({ ...reported, capabilities: ['dir-probe/v1'] }, 'app'), /old/);
  assert.throws(() => newFolderWorkDirOn({ ...managed, managedRunner: null }, 'app'), /old/);
});
