/**
 * The mount daemon's finish line (docs/drive-technical-design.md §5.9): every shell operation of the list,
 * run as uid 10001 through a real FUSE mount made the way the privileged parent makes it (src/drive-mount), against
 * the production apiserver (`node build/main.js`) over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates:
 *
 *   sudo RUN_PG_SPEC_TIMEOUT=7200 bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-mount.pg.e2e.ts
 *
 * Needs root (it mounts, as the CSI plugin does), a usable /dev/fuse, Go (it builds src/drive-mount unless
 * DRIVE_MOUNT_BIN names a binary) and the shell tools the rows use. Not in CI's pg roster, which takes *.pg.spec only.
 *
 *   - Runner A is a Cloud runner: a managed-runner mapping, its generation's mount credential, the instance headers,
 *     and the /proc attribution helper (§5.8) for processes in a cgroup named after its Pod UID. Runner B is a second
 *     runner of the same account (an account has one Cloud runner, so B is self-registered and its daemon presents the
 *     runner credential, which the door also takes). Each daemon reaches the apiserver through a fault proxy that can
 *     refuse connections, hold them unanswered, or drop a commit's answer after the door applied it.
 *   - `$F` is `~/Drive`, a symlink to `<root>/drive` as on a runner, so the rows give `$F/` where §5.9 does. The mounts
 *     sit outside /tmp, where vim's default backupskip would change row 20.
 *   - "Trash" is the owner's Trash as the owner routes list it (a personal access token holding `files`).
 *   - DRIVE_MOUNT_E2E_SCALE=full runs the sizes §5.9 names (5 GiB, 5 × 900 MiB with a 1 GiB spool, a 3 GiB zip member,
 *     100,000-file folders, 3 × 400 MiB unsent) and holds the timing budgets; by default smaller sizes run the same
 *     paths and the times are reported. DRIVE_MOUNT_E2E_ROWS=1,2,3 runs only those rows (setup always runs).
 *   - DRIVE_MOUNT_E2E_REPORT names a file for the row-by-row table.
 *
 * Not here: row 55 (the wiring task), 59 (the engine's Plan mode, §7), 60 (the door task),
 * 61 (the runner's entrypoint, runner-go). Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, lchownSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { issueDriveMountCredential } from './drive-mount-credential';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FULL = process.env.DRIVE_MOUNT_E2E_SCALE === 'full';
const ONLY = (process.env.DRIVE_MOUNT_E2E_ROWS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const E2E_ROOT = process.env.DRIVE_MOUNT_E2E_ROOT ?? '/var/lib/orbit-drive-e2e';
const AGENT_UID = 10001;
const MiB = 1 << 20;

const usable = (() => {
  if (process.getuid?.() !== 0) return 'not root: the test mounts, as the privileged parent does';
  try {
    statSync('/dev/fuse');
  } catch {
    return 'no /dev/fuse';
  }
  return '';
})();

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// ── the row-by-row table ───────────────────────────────────────────────────────────────────────

interface RowResult {
  row: string;
  what: string;
  outcome: 'PASS' | 'FAIL';
  detail: string[];
  ms: number;
}
const results: RowResult[] = [];

function table(): string {
  const lines = ['| # | Row | Result | What happened |', '|---|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.row} | ${r.what.replace(/\|/g, '\\|')} | ${r.outcome} | ${r.detail.join('; ').replace(/\|/g, '\\|').replace(/\n/g, ' ')} (${(r.ms / 1000).toFixed(1)} s) |`);
  }
  return lines.join('\n');
}

// ── a proxy that can make the server unreachable ─────────────────────────────────────────────────

type ProxyMode = 'pass' | 'refuse' | 'blackhole';

/** Between a daemon and the apiserver: passes, refuses connections, holds them unanswered, or drops a commit's answer. */
class FaultProxy {
  mode: ProxyMode = 'pass';
  /** The next commits this many answers are dropped after the door applied them (§5.9 row 50). */
  dropCommitAnswers = 0;
  dropped = 0;
  commits = 0;
  port = 0;
  private sockets = new Set<net.Socket>();
  private server!: http.Server;

  constructor(private readonly target: number) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 120_000;
    this.server.headersTimeout = 0;
    this.server.requestTimeout = 0;
    this.server.on('connection', (socket) => {
      if (this.mode === 'refuse') {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  set(mode: ProxyMode): void {
    this.mode = mode;
    if (mode !== 'pass') for (const s of this.sockets) s.destroy();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.mode === 'refuse') {
      req.socket.destroy();
      return;
    }
    if (this.mode === 'blackhole') return; // never answered
    const isCommit = req.method === 'POST' && /^\/api\/runner\/(documents|drive)\/commit/.test(req.url ?? '');
    if (isCommit) this.commits += 1;
    const up = http.request(
      { host: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        if (isCommit && this.dropCommitAnswers > 0 && answer.statusCode === 200) {
          this.dropCommitAnswers -= 1;
          this.dropped += 1;
          answer.resume();
          answer.on('end', () => req.socket.destroy());
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    up.on('error', () => req.socket.destroy());
    req.pipe(up);
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ── a web server for curl and wget (row 12) ──────────────────────────────────────────────────────

async function fileServer(files: Record<string, Buffer>, cut?: { path: string; at: number }): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
    if (range && Number(range[1]) >= body.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
      return;
    }
    if (range) {
      const from = Number(range[1]);
      res.writeHead(206, { 'Content-Length': body.length - from, 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}`, 'Accept-Ranges': 'bytes' });
      res.end(body.subarray(from));
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
    if (cut && cut.path === req.url) {
      // The first whole download of it is cut short, for `wget -c` to resume.
      const at = cut.at;
      cut = undefined;
      res.write(body.subarray(0, at), () => res.socket?.destroy());
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as net.AddressInfo).port, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ── runners ──────────────────────────────────────────────────────────────────────────────────────

interface Runner {
  name: 'a' | 'b';
  id: string;
  dir: string;
  root: string; // /run/orbit-drive
  drive: string; // /run/orbit-drive/drive
  home: string; // /home/orbit
  F: string; // ~/Drive
  spool: string;
  tokenFile: string;
  proxy: FaultProxy;
  podUid?: string;
  cgroup?: string;
  args: string[];
  parent?: ChildProcess;
  log: string;
}

interface Shell {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

let scriptCount = 0;

function mountpoints(): Array<{ point: string; type: string }> {
  return readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map((line) => {
    const [left, right] = line.split(' - ');
    return { point: left.split(' ')[4], type: (right ?? '').split(' ')[0] };
  });
}

function mounted(point: string): boolean {
  return mountpoints().some((m) => m.point === point && m.type === 'fuse.orbit-drive');
}

test('Drive: the mount daemon passes the shell-operation list (§5.9)', {
  skip: !URL ? 'no COORDINATOR_PG_URL' : usable || false,
  concurrency: 1,
  timeout: 4 * 60 * 60 * 1000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
  } finally {
    await sql.end();
  }
  const db: PrismaClient = prismaClientFor(url);
  t.after(() => db.$disconnect().catch(() => undefined));

  const runDir = path.join(E2E_ROOT, RUN);
  mkdirSync(runDir, { recursive: true });
  chmodSync(E2E_ROOT, 0o755);
  chmodSync(runDir, 0o755);
  const scripts = path.join(runDir, 'scripts');
  mkdirSync(scripts, { recursive: true, mode: 0o755 });
  const filesDir = path.join(runDir, 'store');
  mkdirSync(filesDir, { recursive: true });

  // ── the daemon ──
  let bin = process.env.DRIVE_MOUNT_BIN ?? '';
  if (!bin) {
    bin = path.join(runDir, 'orbit-drive-mount');
    const built = spawnSync('go', ['build', '-o', bin, '.'], {
      cwd: path.join(REPO, 'src', 'drive-mount'), env: { ...process.env, CGO_ENABLED: '0' }, encoding: 'utf8',
    });
    assert.equal(built.status, 0, `go build: ${built.stderr}`);
  }
  chmodSync(path.dirname(bin), 0o755);

  // ── the account ──
  const owner = randomUUID();
  await db.user.create({ data: { id: owner, email: `drive-mount-${RUN}@drive-mount.invalid`, name: 'drive owner', passwordHash: 'x' } });
  const runnerRow = async (name: string) => {
    const id = randomUUID();
    const token = `runner-${randomUUID()}`;
    await db.runner.create({ data: { id, ownerId: owner, name: `${name}-${RUN}`, tokenHash: sha256(Buffer.from(token)) } });
    return { id, token };
  };
  const ra = await runnerRow('cloud-a');
  const rb = await runnerRow('second-b');
  const podUid = randomUUID();
  const mapping = await db.managedRunner.create({
    data: {
      ownerId: owner, runnerId: ra.id, clusterKey: 'drive-mount-e2e', namespace: 'orbit', pvcName: `mr-data-${ra.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  const credential = await issueDriveMountCredential(db as never, { ownerId: owner, runnerId: ra.id, generation: 1 });
  const sessionOnA = randomUUID();
  const secondSession = randomUUID();
  for (const [id, title] of [[sessionOnA, 'writes the report'], [secondSession, 'reads what the owner uploaded']]) {
    await db.session.create({ data: { id, ownerId: owner, creatorId: owner, title, prompt: title, assignedRunnerId: ra.id } });
  }
  const pat = (await new PatService(db as unknown as PrismaService).issue(owner, {
    name: 'drive', scopes: ['drive'], expiresInDays: 1, createdVia: 'WEB', workspaceIds: [],
  })).token;

  const server: Apiserver = await startApiserver(url, `drive-mount-${RUN}`, { ORBIT_DRIVE_DIR: filesDir });
  t.after(() => server.stop());

  // ── owner routes ──
  const api = async (method: string, route: string, body?: unknown) => call(server, method, `/api${route}`, pat, body);
  const rawApi = (method: string, route: string, body?: Buffer, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.port, method, path: `/api${route}`,
        headers: { authorization: `Bearer ${pat}`, ...(body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {}), ...headers },
      }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (p: Buffer) => parts.push(p));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  const resolveEntry = async (drivePath: string) => {
    const reply = await api('GET', `/drive/resolve?path=${encodeURIComponent(drivePath)}`);
    if (reply.status === 404) return null;
    assert.equal(reply.status, 200, `resolve ${drivePath}: ${reply.text}`);
    return reply.json as { id: string; kind: string; name: string; sizeBytes: number; mtime: string; lastWriter: { kind: string; sessionId: string | null; runnerId: string | null }; parentId: string };
  };
  const mustEntry = async (drivePath: string) => {
    const e = await resolveEntry(drivePath);
    assert.ok(e, `${drivePath} is in the drive`);
    return e;
  };
  const content = async (drivePath: string) => {
    const e = await mustEntry(drivePath);
    const reply = await rawApi('GET', `/drive/entries/${e.id}/content`);
    assert.equal(reply.status, 200, `content of ${drivePath}`);
    return reply.body;
  };
  const versions = async (id: string) => {
    const reply = await api('GET', `/drive/entries/${id}/versions`);
    assert.equal(reply.status, 200, reply.text);
    return reply.json.versions as Array<{ id: string; current: boolean; sizeBytes: number; trashGroupId: string | null }>;
  };
  type Group = { id: string; kind: string; itemCount: number; folderPath: string; items: Array<{ id: string; name: string }>; version: null | { id: string; sizeBytes: number; entry: { id: string; name: string } } };
  const trash = async (): Promise<Group[]> => {
    const groups: Group[] = [];
    let cursor = '';
    for (;;) {
      const reply = await api('GET', `/drive/trash?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(reply.status, 200, reply.text);
      groups.push(...reply.json.groups);
      if (!reply.json.nextCursor) return groups;
      cursor = reply.json.nextCursor;
    }
  };
  const newGroups = async (before: Group[]) => {
    const seen = new Set(before.map((g) => g.id));
    return (await trash()).filter((g) => !seen.has(g.id));
  };
  const groupEntries = async (groupId: string, parentId?: string) => {
    const reply = await api('GET', `/drive/trash/groups/${groupId}?limit=1000${parentId ? `&parentId=${parentId}` : ''}`);
    assert.equal(reply.status, 200, reply.text);
    return reply.json.entries as Array<{ id: string; name: string; kind: string }>;
  };
  const trashedContent = async (entryId: string) => {
    const vs = await versions(entryId);
    const current = vs.find((v) => v.current)!;
    const reply = await rawApi('GET', `/drive/versions/${current.id}/content`);
    assert.equal(reply.status, 200);
    return reply.body;
  };
  const versionContent = async (versionId: string) => {
    const reply = await rawApi('GET', `/drive/versions/${versionId}/content`);
    assert.equal(reply.status, 200, `content of version ${versionId}`);
    return reply.body;
  };
  /** A folder made on the Files page: no mount has listed it, so none holds a listing the SQL seeding would bypass. */
  const ownerFolder = async (name: string) => {
    const made = await api('POST', '/drive/folders', { name });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.name, name);
    return made.json as { id: string };
  };
  const ownerUpload = async (parentPath: string, name: string, bytes: Buffer) => {
    const parent = parentPath === '/' ? null : await mustEntry(parentPath);
    const opened = await api('POST', '/drive/uploads', { ...(parent ? { parentId: parent.id } : {}), name, size: bytes.length });
    assert.equal(opened.status, 201, opened.text);
    const chunk = opened.json.chunkSize as number;
    for (let i = 0, idx = 0; i < bytes.length || (i === 0 && bytes.length === 0); i += chunk, idx += 1) {
      const part = bytes.subarray(i, i + chunk);
      if (!part.length) break;
      const put = await rawApi('PUT', `/drive/uploads/${opened.json.id}/chunks/${idx}`, part, { 'x-orbit-chunk-sha256': sha256(part) });
      assert.equal(put.status, 200, put.body.toString());
    }
    const done = await api('POST', `/drive/uploads/${opened.json.id}/complete`);
    assert.equal(done.status, 200, done.text);
    return done.json;
  };

  // ── the mounts ──
  const cgroupBase = (() => {
    const own = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? '';
    return path.join('/sys/fs/cgroup', own);
  })();
  const makeRunner = async (name: 'a' | 'b', id: string, token: string, extra: string[], pod?: string): Promise<Runner> => {
    const dir = path.join(runDir, name);
    const home = path.join(dir, 'home', 'orbit');
    mkdirSync(home, { recursive: true });
    chownSync(home, AGENT_UID, AGENT_UID);
    const root = path.join(dir, 'run', 'orbit-drive');
    const proxy = new FaultProxy(server.port);
    await proxy.start();
    t.after(() => proxy.stop());
    const tokenFile = path.join(dir, 'token');
    writeFileSync(tokenFile, token, { mode: 0o600 });
    let cgroup: string | undefined;
    if (pod) {
      // The runner Pod's cgroup, as the kubelet names it: only its processes are attributed (§5.8).
      cgroup = path.join(cgroupBase, `drive-e2e-pod${pod}`);
      try {
        mkdirSync(cgroup);
        const made = cgroup;
        t.after(() => {
          try {
            rmdirSync(made);
          } catch {
            // a process still in it
          }
        });
      } catch (error) {
        cgroup = undefined;
        t.diagnostic(`no pod cgroup (${(error as Error).message}): attribution is checked without it`);
      }
    }
    const r: Runner = {
      name, id, dir, root, drive: path.join(root, 'drive'), home, F: path.join(home, 'Drive'), spool: path.join(dir, 'spool'),
      tokenFile, proxy, podUid: pod, cgroup, args: extra, log: '',
    };
    // ~/Drive is a symlink to the drive, as the runner's entrypoint makes it (§6.1).
    spawnSync('ln', ['-sfn', r.drive, r.F]);
    lchownSync(r.F, AGENT_UID, AGENT_UID);
    return r;
  };
  const startParent = async (r: Runner) => {
    const args = ['mount', '--root', r.root, '--spool', r.spool, '--server', `http://127.0.0.1:${r.proxy.port}`, '--token-file', r.tokenFile,
      '--watchdog=10s', ...r.args];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (b: Buffer) => {
      r.log = (r.log + b.toString('utf8')).slice(-200_000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    r.parent = child;
    // Never a synchronous call into the mount from here: the proxies the daemons talk through share this event loop.
    const answers = () => readdir(r.drive).then(() => true, () => false);
    const deadline = Date.now() + 30_000;
    while (!mounted(r.drive) || !(await answers())) {
      if (child.exitCode !== null) assert.fail(`runner ${r.name}'s parent exited: ${r.log}`);
      if (Date.now() > deadline) assert.fail(`runner ${r.name} did not mount: ${r.log}`);
      await sleep(200);
    }
  };
  const a = await makeRunner('a', ra.id, credential.token,
    ['--generation=1', `--pod-uid=${podUid}`, `--attribute-cgroup=${podUid}`, '--close-wait=30s'], podUid);
  const b = await makeRunner('b', rb.id, rb.token, [
    '--attribute-cgroup=-', '--close-wait=30s',
    `--spool-limit=${FULL ? '1GiB' : '96MiB'}`, `--unsent-limit=${FULL ? '1GiB' : '64MiB'}`,
  ]);
  t.after(async () => {
    for (const r of [a, b]) {
      if (r.parent && r.parent.exitCode === null) {
        r.parent.kill('SIGTERM');
        await Promise.race([new Promise((resolve) => r.parent!.once('exit', resolve)), sleep(90_000)]);
        if (r.parent.exitCode === null) r.parent.kill('SIGKILL');
      }
      for (const m of mountpoints().filter((m) => m.point.startsWith(r.dir))) spawnSync('umount', ['-l', m.point]);
    }
    if (!mountpoints().some((m) => m.point.startsWith(runDir)) && process.env.DRIVE_MOUNT_E2E_KEEP !== '1') {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  await startParent(a);
  await startParent(b);

  /** A script run as uid 10001 on a runner, with HOME, F and, inside the runner's Pod cgroup, a session. */
  const sh = async (r: Runner, script: string, opts: { session?: string; outsidePod?: boolean; timeoutMs?: number } = {}): Promise<Shell> => {
    scriptCount += 1;
    const file = path.join(scripts, `${scriptCount}.sh`);
    writeFileSync(file, `cd "$HOME"\n${script}\n`, { mode: 0o644 });
    const procs = r.cgroup && !opts.outsidePod ? path.join(r.cgroup, 'cgroup.procs') : '/dev/null';
    const started = Date.now();
    const child = spawn('bash', [
      '-c', 'echo $$ > "$0"; exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all env -i HOME="$1" F="$2" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ORBIT_SESSION_ID="$3" bash "$4"',
      procs, r.home, r.F, opts.session ?? '', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    const timeout = opts.timeoutMs ?? 300_000;
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    return { code, out, err, ms: Date.now() - started };
  };
  const rootSh = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const errorsLog = (r: Runner) => (existsSync(path.join(r.root, 'errors.log')) ? readFileSync(path.join(r.root, 'errors.log'), 'utf8') : '');
  /** What the daemon wrote to errors.log since mark (errorsLog's length then), on one line for a row's table cell. */
  const loggedSince = (r: Runner, mark: number) => errorsLog(r).slice(mark).trim().split('\n').filter(Boolean).join(' / ') || 'no lines';
  const status = (r: Runner) => JSON.parse(readFileSync(path.join(r.root, 'status.json'), 'utf8')) as {
    connected: boolean; since: string | null; uncommittedHandles: number; unsentFiles: number; fenced?: string; spoolBytes: number; spoolPeakBytes: number;
  };
  const waitFor = async (what: string, check: () => Promise<boolean> | boolean, ms: number, every = 200) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms`);
      await sleep(every);
    }
  };
  const ok = (s: Shell, what: string) => {
    assert.equal(s.code, 0, `${what} exited ${s.code}\nstdout: ${s.out}\nstderr: ${s.err}`);
    return s;
  };

  const row = async (n: string, what: string, fn: (detail: string[]) => Promise<void>) => {
    if (ONLY.length && !ONLY.includes(n.replace(/[a-z]$/, '')) && !ONLY.includes(n)) return;
    await t.test(`row ${n}: ${what}`, async () => {
      const detail: string[] = [];
      const started = Date.now();
      try {
        await fn(detail);
        results.push({ row: n, what, outcome: 'PASS', detail, ms: Date.now() - started });
      } catch (error) {
        const why = (error as Error).message.split('\n').map((l) => l.trim()).filter(Boolean).join(' / ').slice(0, 800);
        results.push({ row: n, what, outcome: 'FAIL', detail: [...detail, `FAILED: ${why}`], ms: Date.now() - started });
        t.diagnostic(`row ${n}: runner a's log tail:\n${a.log.slice(-3000)}\nrunner b's log tail:\n${b.log.slice(-1500)}`);
        throw error;
      } finally {
        // Whatever a row did to the network, the next one starts with both daemons reaching the server.
        for (const r of [a, b]) {
          r.proxy.set('pass');
          r.proxy.dropCommitAnswers = 0;
        }
        for (const r of [a, b]) {
          if (r.parent?.exitCode === null && existsSync(path.join(r.root, 'status.json'))) {
            await waitFor(`runner ${r.name} connected again`, () => status(r).connected || status(r).fenced !== undefined, 30_000).catch(() => undefined);
          }
        }
      }
    });
  };

  // ═══ Everyday writes ═══════════════════════════════════════════════════════════════════════════

  await row('1', 'echo hi > $F/a.txt; cat $F/a.txt', async (d) => {
    const s = ok(await sh(a, 'echo hi > $F/r1-a.txt; cat $F/r1-a.txt', { session: sessionOnA }), 'echo and cat');
    assert.equal(s.out, 'hi\n');
    const e = await mustEntry('/r1-a.txt');
    assert.equal(e.sizeBytes, 3);
    assert.equal(e.lastWriter.kind, 'AGENT');
    assert.equal(toUuid(e.lastWriter.runnerId!), a.id, 'written through runner A');
    assert.equal(toUuid(e.lastWriter.sessionId!), sessionOnA, 'and by the session whose process wrote it (§5.8)');
    // What the Files page lists (FilesPage.tsx reads GET /drive/entries; DriveWriterName shows "Agent in <session>").
    const page = await api('GET', '/drive/entries');
    assert.equal(page.status, 200, page.text);
    const listed = (page.json.entries as Array<{ name: string; sizeBytes: number; lastWriter: { kind: string; sessionId: string | null } }>)
      .find((x) => x.name === 'r1-a.txt')!;
    assert.equal(listed.sizeBytes, 3);
    assert.equal(toUuid(listed.lastWriter.sessionId!), sessionOnA);
    d.push(`the Files page's listing has r1-a.txt, 3 bytes, last writer AGENT through runner A in session ${sessionOnA.slice(0, 8)} ("writes the report", from /proc of the writing process), which the page shows as "Agent in writes the report"`);
    // A process outside the runner's Pod is attributed to no session, whatever its environment says.
    ok(await sh(a, 'echo hi > $F/r1-outside.txt', { session: sessionOnA, outsidePod: true }), 'outside the pod');
    const outside = await mustEntry('/r1-outside.txt');
    assert.equal(outside.lastWriter.sessionId, null);
    assert.equal(toUuid(outside.lastWriter.runnerId!), a.id);
    d.push('a writer outside the Pod cgroup: runner only, no session');
  });

  await row('2', 'echo bye > $F/a.txt', async (d) => {
    ok(await sh(a, 'echo hi > $F/a.txt && echo bye > $F/a.txt'), 'overwrite');
    assert.equal((await content('/a.txt')).toString(), 'bye\n');
    const e = await mustEntry('/a.txt');
    const vs = await versions(e.id);
    assert.equal(vs.length, 2);
    const old = vs.find((v) => !v.current)!;
    assert.ok(old.trashGroupId, 'the hi version is in Trash');
    const g = (await trash()).find((x) => x.id === old.trashGroupId)!;
    assert.equal(g.kind, 'VERSION');
    assert.equal(g.version!.entry.name, 'a.txt');
    assert.equal(g.version!.sizeBytes, 3);
    d.push('content bye; the 3-byte version hi is in Trash as a VERSION group of a.txt');
  });

  await row('3', 'echo more >> $F/a.txt (×3)', async (d) => {
    const before = await trash();
    ok(await sh(a, 'for i in 1 2 3; do echo more >> $F/a.txt; done'), 'appends');
    assert.equal((await content('/a.txt')).toString(), 'bye\nmore\nmore\nmore\n');
    assert.equal((await versions((await mustEntry('/a.txt')).id)).length, 2, 'no new version');
    assert.deepEqual(await newGroups(before), [], 'nothing new in Trash');
    d.push('bye + three more lines; still 2 versions, no Trash group');
  });

  await row('4', 'two processes append 1,000 lines each to $F/log at once', async (d) => {
    const s = ok(await sh(a, `
      ( for i in $(seq 1 1000); do echo "A line $i"; done >> $F/log ) &
      ( for i in $(seq 1 1000); do echo "B line $i"; done >> $F/log ) &
      wait`), 'appenders');
    const text = (await content('/log')).toString();
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 2000);
    assert.equal(new Set(lines).size, 2000, 'none twice');
    assert.ok(lines.every((l) => /^[AB] line \d+$/.test(l)), 'none torn');
    assert.equal((await versions((await mustEntry('/log')).id)).length, 1, 'no version');
    d.push(`2,000 distinct whole lines, one version (${s.ms} ms)`);
  });

  await row('5', 'runners A and B each append 1,000 lines to $F/shared.log at once', async (d) => {
    ok(await sh(a, 'echo start > $F/shared.log'), 'start');
    await waitFor('B sees shared.log', async () => (await sh(b, 'test -f $F/shared.log')).code === 0, 30_000, 500);
    const lineCount = FULL ? 1000 : 300;
    const [sa, sb] = await Promise.all([
      sh(a, `for i in $(seq 1 ${lineCount}); do echo "A $i" >> $F/shared.log || exit 1; done`, { timeoutMs: 900_000 }),
      sh(b, `for i in $(seq 1 ${lineCount}); do echo "B $i" >> $F/shared.log || exit 1; done`, { timeoutMs: 900_000 }),
    ]);
    ok(sa, 'A appends');
    ok(sb, 'B appends');
    const lines = (await content('/shared.log')).toString().trimEnd().split('\n');
    assert.equal(lines.length, 2 * lineCount + 1);
    assert.equal(new Set(lines).size, lines.length, 'none lost or doubled');
    assert.equal((await versions((await mustEntry('/shared.log')).id)).length, 1, 'no version');
    d.push(`${2 * lineCount} lines, each \`>>\` its own open/commit on two mounts, every one kept once (the TAIL_MOVED rebuild), one version (${sa.ms} / ${sb.ms} ms)`);
  });

  await row('6', 'cp ~/big.bin $F/ then sha256sum both', async (d) => {
    const size = FULL ? 5 * 1024 : 256;
    const mark = errorsLog(a).length;
    const s = ok(await sh(a, `
      head -c ${size}M /dev/urandom > ~/big.bin
      before=$(du -sk ~ | cut -f1)
      start=$(date +%s.%N); cp ~/big.bin $F/; rc=$?; end=$(date +%s.%N)
      echo "cp rc=$rc seconds=$(echo "$end - $start" | bc)"
      sha256sum ~/big.bin $F/big.bin | cut -d' ' -f1 | uniq | wc -l
      after=$(du -sk ~ | cut -f1); echo "home grew KiB=$((after - before))"
    `, { timeoutMs: 3_600_000 }), 'cp and sha256sum');
    d.push(`stderr ${s.err.trim() || 'empty'}; errors.log during the row: ${loggedSince(a, mark)}`);
    assert.match(s.out, /cp rc=0/, `${s.out}${s.err}errors.log: ${errorsLog(a).slice(-3000)}`);
    assert.match(s.out, /\n1\n/, 'the two hashes are one');
    const st = status(a);
    assert.ok(st.spoolPeakBytes <= 4 * 1024 * MiB + 64 * MiB, `spool peak ${st.spoolPeakBytes}`);
    const grew = Number(/home grew KiB=(-?\d+)/.exec(s.out)![1]);
    assert.ok(grew < 1024, 'the runner volume holds no copy');
    d.push(`${size} MiB: same sha256; ${s.out.match(/seconds=([\d.]+)/)![1]} s for cp incl. the commit; spool peak ${(st.spoolPeakBytes / MiB).toFixed(0)} MiB (limit 4 GiB); runner home grew ${grew} KiB`);
    ok(await sh(a, 'rm -f ~/big.bin'), 'cleanup');
  });

  await row('7', 'five parallel cp into $F/ with the spool limited', async (d) => {
    const size = FULL ? 900 : 64;
    const limit = FULL ? '1 GiB' : '96 MiB';
    const mark = errorsLog(b).length;
    const s = ok(await sh(b, `
      for i in 1 2 3 4 5; do head -c ${size}M /dev/urandom > ~/p$i.bin; done
      for i in 1 2 3 4 5; do ( timeout 3000 cp ~/p$i.bin $F/p$i.bin; echo "cp$i rc=$?" ) & done; wait
      for i in 1 2 3 4 5; do test "$(sha256sum < ~/p$i.bin)" = "$(sha256sum < $F/p$i.bin)" && echo "hash$i ok"; done
      rm -f ~/p?.bin
    `, { timeoutMs: 3_600_000 }), 'parallel cp');
    d.push(`stderr ${s.err.trim() || 'empty'}; errors.log during the row: ${loggedSince(b, mark)}`);
    for (let i = 1; i <= 5; i += 1) {
      assert.match(s.out, new RegExp(`cp${i} rc=0`), `${s.out}${s.err}errors.log: ${errorsLog(b).slice(-3000)}`);
      assert.match(s.out, new RegExp(`hash${i} ok`));
    }
    const st = status(b);
    d.push(`5 × ${size} MiB with the spool at ${limit}: all finished with right hashes in ${(s.ms / 1000).toFixed(0)} s; spool peak ${(st.spoolPeakBytes / MiB).toFixed(0)} MiB`);
    assert.ok(st.spoolPeakBytes <= (FULL ? 1024 : 96) * MiB + 5 * 8 * MiB, 'within the limit, by one chunk per writer at most');
  });

  await row('8', 'cp $F/a.txt $F/b.txt; cp -r ~/dir $F/ (1,000 files, 100 folders)', async (d) => {
    const mark = errorsLog(a).length;
    // Its own a.txt: run alone (DRIVE_MOUNT_E2E_ROWS), the row has no row 2 before it to make one.
    ok(await sh(a, 'test -f $F/a.txt || echo bye > $F/a.txt; cp $F/a.txt $F/b.txt && cmp $F/a.txt $F/b.txt'), 'cp');
    ok(await sh(a, 'for j in $(seq 1 100); do mkdir -p ~/dir/d$j; for k in $(seq 1 10); do echo "file $j $k" > ~/dir/d$j/f$k; done; done'), 'make dir');
    const s = await sh(a, 'cp -r ~/dir $F/ && diff -r ~/dir $F/dir && echo identical');
    d.push(`cp -r exit ${s.code}, stderr ${s.err.trim() || 'empty'}; errors.log during the row: ${loggedSince(a, mark)}`);
    ok(s, 'cp -r');
    assert.match(s.out, /identical/);
    d.push(`trees identical; cp -r of 1,000 files in ${(s.ms / 1000).toFixed(1)} s (${(s.ms / 1000).toFixed(0)} ms per file)`);
    if (FULL) assert.ok(s.ms < 120_000, 'cp -r of 1,000 small files within the budget (tar x of 2,000 in 2 min, §5.5)');
  });

  await row('5.5', 'create-write-close of a 4 KiB file, 200 times (§5.5 budget)', async (d) => {
    const s = ok(await sh(a, `mkdir -p $F/lat55 && head -c 4096 /dev/urandom > ~/k4 && python3 -c "
import shutil, time
ms = []
for i in range(200):
    t = time.monotonic(); shutil.copyfile('$HOME/k4', '$F/lat55/f%d' % i); ms.append((time.monotonic() - t) * 1000)
ms.sort(); print('%.1f %.1f' % (ms[100], ms[190]))"`), 'latency');
    const [p50, p95] = s.out.trim().split(' ').map(Number);
    d.push(`p50 ${p50} ms, p95 ${p95} ms on this host (§5.5's production budget: ≤ 60 ms p50, ≤ 250 ms p95); a new file is three door requests in sequence, create at the open and chunk and commit at the close, the staging opening while it is written`);
    if (FULL) assert.ok(p95 <= 250, `p95 ${p95} ms`);
  });

  await row('9', 'cp -p ~/x $F/ (mode 0644)', async (d) => {
    const s = ok(await sh(a, "echo x > ~/x && chmod 644 ~/x && touch -d '2021-03-04 05:06:07.250' ~/x && cp -p ~/x $F/ && stat -c %Y.%y ~/x $F/x"), 'cp -p');
    const [mine, theirs] = s.out.trim().split('\n');
    assert.equal(theirs.slice(0, 10), mine.slice(0, 10), 'mtime preserved');
    d.push(`exit 0; mtime ${theirs.split('.')[1].slice(0, 23)} kept (the drive keeps milliseconds)`);
  });

  await row('10', 'cp -p ~/script.sh $F/ and cp -a ~/dir $F/ with an executable in dir', async (d) => {
    const s = await sh(a, `
      printf '#!/bin/sh\\necho ok\\n' > ~/script.sh; chmod 755 ~/script.sh
      cp -p ~/script.sh $F/; echo "cp-p rc=$?"
      mkdir -p ~/dexe; echo plain > ~/dexe/plain.txt; cp ~/script.sh ~/dexe/run.sh
      cp -a ~/dexe $F/; echo "cp-a rc=$?"
      cmp ~/script.sh $F/script.sh && cmp ~/dexe/run.sh $F/dexe/run.sh && cmp ~/dexe/plain.txt $F/dexe/plain.txt && echo copied`);
    assert.match(s.out, /cp-p rc=1/);
    assert.match(s.out, /cp-a rc=1/);
    assert.match(s.out, /copied/);
    assert.match(s.err, /preserving permissions for .*script\.sh.*Operation not permitted/);
    assert.match(errorsLog(a), /EPERM chmod \/home\/orbit\/Drive\/script\.sh to 0755: the drive keeps no modes/);
    d.push('contents copied; cp printed "preserving permissions … Operation not permitted", exit 1 both; errors.log has the chmod line');
  });

  await row('11', 'install -m755 ~/tool $F/tool', async (d) => {
    const s = await sh(a, 'printf "#!/bin/sh\\n" > ~/tool; install -m755 ~/tool $F/tool; echo "rc=$?"; cmp ~/tool $F/tool && echo copied');
    assert.match(s.out, /rc=1/);
    assert.match(s.out, /copied/);
    assert.match(s.err, /install: .*Operation not permitted/);
    d.push(`content copied; ${s.err.trim().split('\n').pop()}, exit 1`);
  });

  await row('12', 'tee; curl -o; wget -c interrupted and resumed', async (d) => {
    const page = Buffer.from(`<html>${'x'.repeat(5000)}</html>\n`);
    const big = randomBytes(3 * MiB + 12345);
    const web = await fileServer({ '/page.html': page, '/dl12.bin': big }, { path: '/dl12.bin', at: 1 * MiB + 777 });
    try {
      const s = await sh(a, `
        echo x | tee $F/t.txt >/dev/null; echo "tee rc=$?"
        curl -sS -o $F/page.html http://127.0.0.1:${web.port}/page.html; echo "curl rc=$?"
        cd $F && wget -q --tries=1 --read-timeout=5 http://127.0.0.1:${web.port}/dl12.bin; echo "wget1 rc=$?"; stat -c %s $F/dl12.bin
        cd $F && wget -q -c --tries=1 http://127.0.0.1:${web.port}/dl12.bin; echo "wget2 rc=$?"
        sha256sum < $F/dl12.bin`);
      assert.match(s.out, /tee rc=0/);
      assert.match(s.out, /curl rc=0/);
      assert.match(s.out, new RegExp(`wget1 rc=[1-9]\\d*\\n${1 * MiB + 777}\\n`), 'the first download was cut short');
      assert.match(s.out, /wget2 rc=0/);
      assert.equal(s.out.trim().split('\n').pop()!.split(' ')[0], sha256(big), 'the final hash is the source\'s');
      assert.equal((await content('/t.txt')).toString(), 'x\n');
      assert.deepEqual(await content('/page.html'), page);
      assert.equal((await versions((await mustEntry('/dl12.bin')).id)).length, 1, 'wget -c resumed by appending: no version');
      d.push(`tee, curl -o: exit 0; wget cut at ${1 * MiB + 777} bytes (rc ${/wget1 rc=(\d+)/.exec(s.out)![1]}), wget -c resumed by appending: exit 0, one version, hash matches`);
    } finally {
      await web.stop();
    }
  });

  await row('13', 'truncate -s 1G $F/sparse; a 1-byte write at 100 MiB; dd into the closed sparse', async (d) => {
    const s = await sh(a, `
      truncate -s 1G $F/sparse; echo "truncate rc=$?"; stat -c %s $F/sparse
      python3 -c "f=open('$F/holes','wb'); f.seek(100*1024*1024); f.write(b'Z'); f.close()"; echo "python rc=$?"
      stat -c %s $F/holes; tail -c 1 $F/holes; echo; head -c 104857600 $F/holes | tr -d '\\0' | wc -c
      dd if=/dev/urandom of=$F/sparse bs=1M count=1 seek=512 conv=notrunc 2>&1; echo "dd rc=$?"`);
    assert.match(s.out, /truncate rc=0\n1073741824\n/);
    assert.match(s.out, /python rc=0\n104857601\nZ\n0\n/);
    assert.match(s.out, /Operation not supported/);
    assert.match(s.out, /dd rc=1/);
    const sparse = await mustEntry('/sparse');
    const m = await db.driveVersionChunk.findMany({ where: { versionId: (await db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(sparse.id) } })).currentVersionId! } });
    assert.equal(m.length, 128);
    assert.equal(new Set(m.map((c) => c.sha256)).size, 1, 'one shared all-zero chunk');
    d.push('truncate: 1 GiB of 128 chunks naming one all-zero blob; holes: 100 MiB of zeros then Z; dd into the closed sparse: "Operation not supported", exit 1');
  });

  // ═══ Moves, renames, editors ═══════════════════════════════════════════════════════════════════

  await row('14', 'mv $F/a.txt $F/sub/c.txt', async (d) => {
    const before = await trash();
    const id = (await mustEntry('/a.txt')).id;
    ok(await sh(a, 'mkdir -p $F/sub && mv $F/a.txt $F/sub/c.txt'), 'mv');
    assert.equal((await mustEntry('/sub/c.txt')).id, id, 'the same entry');
    assert.equal(await resolveEntry('/a.txt'), null);
    assert.deepEqual(await newGroups(before), [], 'no Trash item');
    d.push('exit 0; same entry id at /sub/c.txt; no Trash item');
  });

  await row('15', 'mv $F/new.txt $F/b.txt (onto an existing file)', async (d) => {
    ok(await sh(a, 'echo old > $F/b.txt && echo new > $F/new.txt'), 'setup');
    const before = await trash();
    const newId = (await mustEntry('/new.txt')).id;
    const oldId = (await mustEntry('/b.txt')).id;
    const oldVersion = (await versions(oldId)).find((v) => v.current)!.id;
    ok(await sh(a, 'mv $F/new.txt $F/b.txt && cat $F/b.txt'), 'mv onto');
    assert.equal((await content('/b.txt')).toString(), 'new\n', "b.txt's current version has new.txt's content");
    assert.equal((await mustEntry('/b.txt')).id, oldId, 'b.txt keeps its entry id');
    assert.equal(await resolveEntry('/new.txt'), null, 'new.txt is gone');
    const added = await newGroups(before);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'VERSION', 'the previous b.txt is in Trash as a version');
    assert.equal(added[0].version?.id, oldVersion);
    assert.equal(added[0].version?.entry.id, oldId);
    assert.equal((await versionContent(oldVersion)).toString(), 'old\n');
    assert.ok(!added.some((g) => g.items.some((i) => i.id === newId || i.name === 'new.txt')), 'new.txt is not in Trash');
    d.push(`exit 0; b.txt keeps its entry (${oldId.slice(0, 6)}…) and holds new.txt's content; its previous content is in Trash as one VERSION group; new.txt gone, not in Trash (§3.2)`);
  });

  await row('16', 'rename of an open file', async (d) => {
    const before = await trash();
    ok(await sh(a, 'exec 3> $F/a.tmp; echo x >&3; mv $F/a.tmp $F/a.out; echo y >&3; exec 3>&-'), 'rename while open');
    assert.equal((await content('/a.out')).toString(), 'x\ny\n');
    assert.equal(await resolveEntry('/a.tmp'), null);
    const added = await newGroups(before);
    assert.ok(!added.some((g) => g.items.some((i) => i.name === 'a.tmp')), 'no a.tmp in Trash');
    d.push('exit 0; a.out holds x\\ny; no a.tmp live or in Trash');
  });

  await row('17', 'unlink of an open file', async (d) => {
    const before = await trash();
    ok(await sh(a, 'exec 3> $F/gone; echo x >&3; rm $F/gone; echo y >&3; exec 3>&-'), 'unlink while open');
    assert.equal(await resolveEntry('/gone'), null, 'no live gone');
    const g = (await newGroups(before)).find((x) => x.items.some((i) => i.name === 'gone'));
    assert.ok(g, 'Trash holds gone');
    assert.equal((await trashedContent(g.items[0].id)).toString(), 'x\ny\n');
    d.push('exit 0; no live gone; Trash holds gone with x\\ny (the close committed into Trash)');
  });

  await row('18', 'mv ~/file $F/ and mv $F/file ~/', async (d) => {
    const before = await trash();
    ok(await sh(a, 'echo in > ~/file18 && mv ~/file18 $F/ && test ! -e ~/file18 && cat $F/file18 && echo out > $F/file18b && mv $F/file18b ~/ && cat ~/file18b'), 'mv across');
    assert.equal((await content('/file18')).toString(), 'in\n');
    assert.ok((await newGroups(before)).some((g) => g.items.some((i) => i.name === 'file18b')), 'the moved-out file is in Trash');
    d.push('exit 0 both (EXDEV: mv copied and removed); the moved-out file18b is in Trash');
  });

  await row('19', 'mv $F/dir $F/full/ onto a non-empty folder; mv $F/p $F/p/q', async (d) => {
    const s = await sh(a, `
      mkdir -p $F/d19/x $F/full/d19 && echo k > $F/full/d19/keep
      mv $F/d19 $F/full/; echo "rc1=$?"
      mkdir -p $F/p19; mv $F/p19 $F/p19/q; echo "rc2=$?"`);
    assert.match(s.out, /rc1=1/);
    assert.match(s.out, /rc2=1/);
    assert.match(s.err, /Directory not empty/);
    assert.match(s.err, /subdirectory of itself/);
    d.push('"Directory not empty", exit 1; EINVAL, which mv prints as "cannot move … to a subdirectory of itself", exit 1');
  });

  await row('20', 'editor saves: vim (defaults and backupcopy=yes), python os.replace, sed -i', async (d) => {
    ok(await sh(a, 'printf "line x\\n" > $F/v20.txt; printf "line x\\n" > $F/p20.txt; printf "line x\\n" > $F/s20.txt'), 'setup');
    const ids = { v: (await mustEntry('/v20.txt')).id, p: (await mustEntry('/p20.txt')).id, s: (await mustEntry('/s20.txt')).id };
    /** The VERSION group a save added for entry `id`, holding `previous`. */
    const versionOf = async (groups: Group[], id: string, previous: string) => {
      const g = groups.filter((x) => x.kind === 'VERSION' && x.version?.entry.id === id);
      assert.equal(g.length, 1, `one version of ${id} in Trash`);
      assert.equal((await versionContent(g[0].version!.id)).toString(), previous);
    };
    // (a) vim's default save renames v20.txt to v20.txt~ (a move to a free name), writes a new v20.txt and removes the
    // backup: no rename onto a file, so §3.2 does not apply and v20.txt is a new entry (§5.9 row 20 (a)).
    const beforeVim = await trash();
    ok(await sh(a, 'vim --not-a-term -u DEFAULTS -i NONE -c "s/x/y/" -c wq $F/v20.txt </dev/null >/dev/null 2>&1'), 'vim');
    assert.equal((await content('/v20.txt')).toString(), 'line y\n');
    const vimGroups = await newGroups(beforeVim);
    const vimNow = (await mustEntry('/v20.txt')).id;
    assert.notEqual(vimNow, ids.v, 'a new entry, as §5.9 row 20 (a) says');
    const backup = vimGroups.flatMap((g) => g.items).find((i) => i.name === 'v20.txt~');
    assert.ok(backup, 'the previous content is in Trash as v20.txt~');
    assert.equal(backup.id, ids.v, 'the old entry, moved to the backup name');
    assert.equal((await trashedContent(backup.id)).toString(), 'line x\n');
    const vimItems = vimGroups.flatMap((g) => g.items.map((i) => i.name)).sort();
    d.push(`(a) vim: content line y, exit 0; v20.txt is a new entry; Trash gained ${vimGroups.length} group(s): ${vimItems.join(', ')}`);

    const beforeVimCopy = await trash();
    ok(await sh(a, `
      vim --not-a-term -u DEFAULTS -i NONE -c "set backupcopy=yes" -c "s/y/z/" -c wq $F/v20.txt </dev/null > ~/vim20-copy.log 2>&1 ||
        { rc=$?; cat ~/vim20-copy.log >&2; exit "$rc"; }
    `), 'vim backupcopy=yes');
    assert.equal((await content('/v20.txt')).toString(), 'line z\n');
    assert.equal((await mustEntry('/v20.txt')).id, vimNow, 'v20.txt keeps its entry id');
    await versionOf(await newGroups(beforeVimCopy), vimNow, 'line y\n');
    d.push('(a) vim backupcopy=yes: content line z, exit 0; v20.txt keeps its entry id; the previous content is a version in Trash');

    // (b) python writing p20.tmp then os.replace onto p20.txt (§3.2).
    const beforePy = await trash();
    ok(await sh(a, `python3 -c "import os; open('$F/p20.tmp','w').write('line y\\\\n'); os.replace('$F/p20.tmp','$F/p20.txt')"`), 'os.replace');
    assert.equal((await content('/p20.txt')).toString(), 'line y\n');
    assert.equal((await mustEntry('/p20.txt')).id, ids.p, 'p20.txt keeps its entry id');
    assert.equal(await resolveEntry('/p20.tmp'), null);
    const pyGroups = await newGroups(beforePy);
    await versionOf(pyGroups, ids.p, 'line x\n');
    assert.ok(!pyGroups.some((g) => g.items.some((i) => i.name === 'p20.tmp')), 'p20.tmp is not in Trash');
    d.push('(b) os.replace: content line y, exit 0; p20.txt keeps its entry id; the previous content is a version in Trash; p20.tmp gone, not in Trash');
    // (c) sed -i writes a temporary file beside s20.txt and renames it onto s20.txt (§3.2).
    const beforeSed = await trash();
    ok(await sh(a, 'sed -i s/x/y/ $F/s20.txt'), 'sed -i');
    assert.equal((await content('/s20.txt')).toString(), 'line y\n');
    assert.equal((await mustEntry('/s20.txt')).id, ids.s, 's20.txt keeps its entry id');
    const sedGroups = await newGroups(beforeSed);
    await versionOf(sedGroups, ids.s, 'line x\n');
    assert.deepEqual(sedGroups.filter((g) => g.kind !== 'VERSION'), [], "sed's temporary file is not in Trash");
    d.push('(c) sed -i: content line y, exit 0; s20.txt keeps its entry id; the previous content is a version in Trash; no temporary file in Trash');
  });

  await row('21', ': > $F/a.txt and truncate -s 0 $F/a.txt', async (d) => {
    ok(await sh(a, 'echo content > $F/t21.txt && : > $F/t21.txt && stat -c %s $F/t21.txt && echo again > $F/t21.txt && truncate -s 0 $F/t21.txt'), 'empty it');
    assert.equal((await content('/t21.txt')).length, 0);
    const vs = await versions((await mustEntry('/t21.txt')).id);
    assert.deepEqual(vs.filter((v) => !v.current).map((v) => v.sizeBytes).sort(), [0, 6, 8], 'each previous content is a version in Trash');
    assert.ok(vs.filter((v) => !v.current).every((v) => v.trashGroupId));
    d.push('exit 0 both; empty file; the previous versions (8, 0 and 6 bytes) are in Trash');
  });

  // ═══ Archives and sync ═══════════════════════════════════════════════════════════════════════

  const tarCount = FULL ? 2000 : 300;
  await row('22', `tar -C $F/ -xzf ~/src.tgz with ${tarCount} files, none executable`, async (d) => {
    ok(await sh(a, `
      mkdir -p ~/src22 && cd ~/src22 && for i in $(seq 1 ${tarCount}); do mkdir -p d$((i % 40)); echo "content $i" > d$((i % 40))/f$i; touch -d "2022-0$((i % 9 + 1))-1$((i % 9)) 10:0$((i % 10)):00" d$((i % 40))/f$i; done
      tar -C ~/src22 -czf ~/src.tgz .`), 'archive');
    const s = ok(await sh(a, 'mkdir -p $F/x22 && tar -C $F/x22/ -xzf ~/src.tgz'), 'tar x');
    const cmp = ok(await sh(a, 'diff -r ~/src22 $F/x22 && echo same; cd ~/src22 && find . -type f -printf "%T@ %p\\n" | sort > ~/m1; cd $F/x22 && find . -type f -printf "%T@ %p\\n" | sort > ~/m2; cmp ~/m1 ~/m2 && echo mtimes'), 'compare');
    assert.match(cmp.out, /same/);
    assert.match(cmp.out, /mtimes/);
    d.push(`exit 0; ${tarCount} files' contents and mtimes match; ${(s.ms / 1000).toFixed(1)} s`);
    if (FULL) assert.ok(s.ms < 120_000, 'tar x of 2,000 small files ≤ 2 minutes (§5.5)');
  });

  await row('23', 'the same with some executable files', async (d) => {
    ok(await sh(a, 'mkdir -p ~/src23 && echo a > ~/src23/plain && printf "#!/bin/sh\\n" > ~/src23/run.sh && chmod 755 ~/src23/run.sh && tar -C ~/src23 -czf ~/src23.tgz .'), 'archive');
    const s = await sh(a, `mkdir -p $F/x23 && tar -C $F/x23/ -xzf ~/src23.tgz; echo "rc=$?"; diff -r ~/src23 $F/x23 && echo same; stat -c %a $F/x23/run.sh
      mkdir -p $F/x23p && tar -C $F/x23p/ -xpzf ~/src23.tgz; echo "rc-p=$?"; diff -r ~/src23 $F/x23p && echo same-p`);
    // GNU tar run by a user (not root) chmods a regular file only when asked (-p, --same-permissions): it creates it
    // with the archive's mode and takes that as done, so the executable bit the drive cannot keep is dropped silently.
    // GNU tar creates a file with the mode it is to have and, having created it, takes that mode as set: it chmods a
    // regular file neither as a user nor with -p. The executable bit the drive cannot keep goes without tar seeing a
    // refusal, so §5.9's "Cannot change mode … exits 2" cannot happen; errors.log names each such file instead.
    assert.match(s.out, /rc=0\nsame\n644\nrc-p=0\nsame-p/);
    assert.match(errorsLog(a), /INFO create \/home\/orbit\/Drive\/x23\/run\.sh with mode 0755: the drive keeps no modes: the file is 0644 and cannot be executed/);
    d.push('every file\'s content matches; tar -x and tar -xp both exit 0 and run.sh shows 0644: GNU tar takes the mode it created a file with as set and chmods no regular file, so it meets no refusal (§5.9\'s "Cannot change mode … exit 2" does not happen with GNU tar 1.35); errors.log says run.sh was created executable and is kept 0644');
  });

  await row('24', 'tar -C $F/ -czf ~/out.tgz . and tar -tzf', async (d) => {
    const s = ok(await sh(a, 'tar -C $F/x22 -czf ~/out.tgz . && tar -tzf ~/out.tgz | grep -c "/f[0-9]*$"'), 'tar c');
    assert.equal(Number(s.out.trim()), tarCount);
    d.push(`exit 0; lists all ${tarCount} files`);
  });

  await row('25', 'rsync -rt ~/dir/ $F/dir/, then again', async (d) => {
    const first = ok(await sh(a, 'rsync -rt --stats ~/src22/ $F/r25/ | grep "files transferred"'), 'rsync 1');
    const second = ok(await sh(a, 'rsync -rt --stats ~/src22/ $F/r25/ | grep "files transferred"'), 'rsync 2');
    assert.match(second.out, /Number of regular files transferred: 0/);
    d.push(`exit 0 both; first: ${first.out.trim()}; second: ${second.out.trim()}`);
  });

  await row('26', 'rsync -a with 0644 files and 0755 folders; then with one 0755 file', async (d) => {
    const s1 = await sh(a, 'mkdir -p ~/src26/sub && echo a > ~/src26/a && echo b > ~/src26/sub/b && chmod 644 ~/src26/a ~/src26/sub/b && chmod 755 ~/src26 ~/src26/sub && rsync -a ~/src26/ $F/r26/; echo "rc=$?"');
    assert.match(s1.out, /rc=0/);
    const s2 = await sh(a, 'printf "#!/bin/sh\\n" > ~/src26/x.sh && chmod 755 ~/src26/x.sh && rsync -a ~/src26/ $F/r26/; echo "rc=$?"; cmp ~/src26/x.sh $F/r26/x.sh && echo copied');
    assert.match(s2.out, /rc=23/);
    assert.match(s2.out, /copied/);
    assert.match(s2.err, /x\.sh.*Operation not permitted|Operation not permitted.*x\.sh/);
    d.push('first: exit 0; second: content copied, exit 23 naming x.sh and "Operation not permitted"');
  });

  await row('27', 'zip -r and unzip -t in $F/; unzip -d $F/x ~/in.zip', async (d) => {
    const s = ok(await sh(a, 'cd $F/ && zip -qr out.zip x22 && unzip -tq out.zip && cd ~/src22 && zip -qr ~/in.zip . && unzip -q -d $F/x27 ~/in.zip && diff -r ~/src22 $F/x27 && echo extracted'), 'zip');
    assert.match(s.out, /No errors detected/);
    assert.match(s.out, /extracted/);
    d.push('exit 0 each; unzip -t: no errors; the extracted tree matches');
  });

  await row('28', 'zip of a folder whose largest member is large', async (d) => {
    const size = FULL ? 3 * 1024 : 128;
    const s = ok(await sh(a, `mkdir -p ~/z28 && head -c ${size}M /dev/urandom > ~/z28/big && echo small > ~/z28/small && cd ~ && zip -q -r -0 $F/z28.zip z28 && unzip -tq $F/z28.zip && rm -rf ~/z28`, { timeoutMs: 3_600_000 }), 'zip');
    assert.match(s.out, /No errors detected/);
    d.push(`a ${size} MiB member: exit 0 (zip seeks back to patch headers; writes anywhere in a new file are taken); unzip -t ok; ${(s.ms / 1000).toFixed(0)} s`);
  });

  // ═══ Deletes, Trash and folders ═══════════════════════════════════════════════════════════════

  await row('29', 'rm $F/a.txt; rm -rf $F/dir (500 entries); restore', async (d) => {
    ok(await sh(a, `echo a > $F/a29.txt; mkdir -p ~/dir29; for j in $(seq 1 9); do mkdir -p ~/dir29/s$j; for k in $(seq 1 50); do echo $j$k > ~/dir29/s$j/f$k; done; done; for k in $(seq 1 40); do echo $k > ~/dir29/top$k; done; cp -r ~/dir29 $F/`), 'setup');
    const before = await trash();
    ok(await sh(a, 'rm $F/a29.txt; sleep 3; rm -rf $F/dir29'), 'rm');
    const added = await newGroups(before);
    const dirGroup = added.find((g) => g.items.some((i) => i.name === 'dir29'))!;
    assert.ok(added.some((g) => g.items.some((i) => i.name === 'a29.txt')), 'a29.txt is in Trash');
    assert.equal(added.filter((g) => g.items.some((i) => i.name === 'dir29' || i.name.startsWith('top') || i.name.startsWith('s'))).length, 1, 'one group for the rm -rf');
    assert.equal(dirGroup.itemCount, 500);
    assert.equal(dirGroup.folderPath, '/');
    const restored = await api('POST', `/drive/trash/groups/${dirGroup.id}/restore`);
    assert.ok(restored.status === 200 || restored.status === 201, restored.text);
    await waitFor('the restored tree on the mount', async () => (await sh(a, 'test "$(find $F/dir29/ -type f | wc -l)" = 490')).code === 0, 30_000, 500);
    ok(await sh(a, 'diff -r ~/dir29 $F/dir29'), 'the tree is back');
    d.push('exit 0; Trash: a29.txt, and one group "dir29, 500 items" from /; restoring it brought the tree back, seen by the mount');
  });

  const seedTree = async (folder: string, folders: number, perFolder: number) => {
    // A folder of empty files written straight into the name layer: setup, not the row.
    const parent = await mustEntry(folder);
    const pid = toUuid(parent.id);
    await db.$executeRawUnsafe(`
      WITH f AS (
        INSERT INTO "drive_entry" ("id","owner_id","parent_id","kind","name","last_writer_kind")
        SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'FOLDER', 'd' || lpad(i::text, 5, '0'), 'OWNER' FROM generate_series(1, $3) i
        RETURNING "id"
      ), e AS (
        SELECT gen_random_uuid() AS "id", gen_random_uuid() AS "vid", f."id" AS "parent", j FROM f, generate_series(1, $4) j
      ), ins AS (
        INSERT INTO "drive_entry" ("id","owner_id","parent_id","kind","name","current_version_id","last_writer_kind")
        SELECT e."id", $1::uuid, e."parent", 'FILE', 'f' || lpad(j::text, 6, '0'), e."vid", 'OWNER' FROM e
        RETURNING "id", "current_version_id"
      )
      INSERT INTO "drive_version" ("id","owner_id","entry_id","writer_kind") SELECT "current_version_id", $1::uuid, "id", 'OWNER' FROM ins`,
    owner, pid, folders, perFolder);
  };
  const seedFlat = async (folder: string, count: number) => {
    const parent = await mustEntry(folder);
    await db.$executeRawUnsafe(`
      WITH e AS (SELECT gen_random_uuid() AS "id", gen_random_uuid() AS "vid", j FROM generate_series(1, $3) j),
      ins AS (
        INSERT INTO "drive_entry" ("id","owner_id","parent_id","kind","name","current_version_id","last_writer_kind")
        SELECT e."id", $1::uuid, $2::uuid, 'FILE', 'f' || (j - 1), e."vid", 'OWNER' FROM e RETURNING "id", "current_version_id"
      )
      INSERT INTO "drive_version" ("id","owner_id","entry_id","writer_kind") SELECT "current_version_id", $1::uuid, "id", 'OWNER' FROM ins`,
    owner, toUuid(parent.id), count);
  };

  const hugeFolders = FULL ? 1000 : 50;
  await row('30', `rm -rf $F/huge (${hugeFolders * 100} files in ${hugeFolders} folders)`, async (d) => {
    await ownerFolder('huge30');
    await seedTree('/huge30', hugeFolders, 100);
    await waitFor('A sees huge30', async () => (await sh(a, 'test -d $F/huge30')).code === 0, 30_000, 500);
    const before = await trash();
    const s = await sh(a, 'rm -rf $F/huge30/; echo "rc=$?"', { timeoutMs: 60 * 60_000 });
    assert.match(s.out, /rc=0/);
    const added = await newGroups(before);
    assert.equal(added.length, 1, `one group, not ${added.length}`);
    assert.equal(added[0].itemCount, hugeFolders * 101 + 1);
    const restore = await api('POST', `/drive/trash/groups/${added[0].id}/restore`);
    assert.ok(restore.status === 200 || restore.status === 201, restore.text.slice(0, 300));
    const back = await db.driveEntry.count({ where: { ownerId: owner, kind: 'FILE', trashedAt: null, parent: { parentId: toUuid((await mustEntry('/huge30')).id) } } });
    assert.equal(back, hugeFolders * 100);
    d.push(`exit 0 in ${(s.ms / 1000).toFixed(0)} s (${(s.ms / (hugeFolders * 101)).toFixed(1)} ms per delete); one group of ${added[0].itemCount} items; restoring it brought back ${back} files`);
    if (FULL) assert.ok(s.ms < 15 * 60_000, 'within 15 minutes');
  });

  await row('31', 'restore a.txt after a new a.txt was written', async (d) => {
    ok(await sh(a, 'echo first > $F/a31.txt'), 'write');
    const before = await trash();
    ok(await sh(a, 'rm $F/a31.txt && echo second > $F/a31.txt'), 'rm and write again');
    const g = (await newGroups(before)).find((x) => x.items.some((i) => i.name === 'a31.txt'))!;
    const restored = await api('POST', `/drive/trash/groups/${g.id}/restore`);
    assert.ok(restored.status === 200 || restored.status === 201, restored.text);
    assert.equal((await content('/a31 (2).txt')).toString(), 'first\n');
    assert.equal((await content('/a31.txt')).toString(), 'second\n');
    await waitFor('the mount sees a31 (2).txt', async () => (await sh(a, 'test "$(cat "$F/a31 (2).txt")" = first')).code === 0, 30_000, 500);
    d.push('the restored file is a31 (2).txt, and the mount reads it');
  });

  await row('32', 'concurrent: owner and session move folders into each other; owner trashes r while a session creates r/s/new.txt', async (d) => {
    let moveOutcomes = '';
    const stagger = [0, 30, 60, 120, 240, 0, 45, 90, 180, 360];
    for (let i = 0; i < stagger.length; i += 1) {
      ok(await sh(a, `mkdir -p $F/p32-${i} $F/q32-${i} && ls $F/p32-${i}/ $F/q32-${i}/`), 'setup');
      const p = await mustEntry(`/p32-${i}`);
      const q = await mustEntry(`/q32-${i}`);
      // Started apart by a little more each time, so either side gets there first.
      const [web, mount] = await Promise.all([
        sleep(stagger[i]).then(() => api('PATCH', `/drive/entries/${p.id}`, { parentId: q.id })),
        sh(a, `mv $F/q32-${i} $F/p32-${i}/ 2>&1; echo "rc=$?"`),
      ]);
      const webOk = web.status === 200;
      const mountOk = /rc=0/.test(mount.out);
      // No folder is inside itself.
      const chain: string[] = [];
      for (const id of [toUuid(p.id), toUuid(q.id)]) {
        const seen = new Set<string>();
        for (let cur: string | null = id; cur; ) {
          assert.ok(!seen.has(cur), 'a cycle');
          seen.add(cur);
          const entry: { name: string; parentId: string | null } = await db.driveEntry.findUniqueOrThrow({ where: { id: cur } });
          chain.push(entry.name || '/');
          cur = entry.parentId;
        }
      }
      const said = `web ${web.status} ${web.text.slice(0, 200)}; mount ${mount.out.trim()} ${mount.err.trim()}; parents ${chain.join(' < ')}`;
      assert.ok(!(webOk && mountOk), `not both: ${said}`);
      assert.ok(webOk || mountOk, `one of them: ${said}`);
      moveOutcomes += `${webOk ? 'web' : 'mount'} first, the other refused (${webOk ? (/: ([^:\n]+)\nrc=/.exec(mount.out)?.[1] ?? mount.out.trim()) : `${web.status} ${web.json?.code}`}); `;
    }
    let trashOutcomes = '';
    for (let i = 0; i < stagger.length; i += 1) {
      ok(await sh(a, `mkdir -p $F/r32-${i}/s && ls $F/r32-${i}/s/`), 'setup');
      const r = await mustEntry(`/r32-${i}`);
      const [web, mount] = await Promise.all([
        sleep(stagger[i]).then(() => api('DELETE', `/drive/entries/${r.id}`)),
        sh(a, `echo n > $F/r32-${i}/s/new.txt 2>&1; echo "rc=$?"`),
      ]);
      assert.equal(web.status, 200, web.text);
      const rows = await db.driveEntry.findMany({ where: { ownerId: owner, name: 'new.txt', parent: { name: 's', parent: { id: toUuid(r.id) } } } });
      for (const row of rows) assert.ok(row.trashedAt, 'never a live new.txt under a trashed r');
      trashOutcomes += rows.length ? 'created first, in Trash with r; ' : `open refused (${(/: ([^:\n]+)\nrc=/.exec(mount.out)?.[1] ?? mount.out.trim())}); `;
    }
    d.push(`moves ×${stagger.length}: ${moveOutcomes}no folder inside itself`);
    d.push(`trash vs create ×${stagger.length}: ${trashOutcomes}never a live new.txt under a trashed r`);
  });

  await row('33', 'mkdir -p $F/p/q/r; rmdir $F/p/q/r; rmdir $F/p', async (d) => {
    const s = await sh(a, 'mkdir -p $F/p33/q/r; echo "rc1=$?"; rmdir $F/p33/q/r; echo "rc2=$?"; rmdir $F/p33; echo "rc3=$?"');
    assert.match(s.out, /rc1=0\nrc2=0\nrc3=1/);
    assert.match(s.err, /Directory not empty/);
    d.push('exit 0, exit 0, then "Directory not empty"');
  });

  const bigCount = FULL ? 100_000 : 10_000;
  await row('34', `a folder of ${bigCount} files: ls | wc -l; ls -l of one`, async (d) => {
    await ownerFolder('big34');
    await seedFlat('/big34', bigCount);
    await waitFor('B sees big34', async () => (await sh(b, 'test -d $F/big34')).code === 0, 30_000, 500);
    const s = ok(await sh(b, 'start=$(date +%s%N); n=$(ls $F/big34/ | wc -l); end=$(date +%s%N); echo "$n $(( (end - start) / 1000000 ))"'), 'ls');
    const [n, ms] = s.out.trim().split(' ').map(Number);
    assert.equal(n, bigCount);
    const one = ok(await sh(a, `start=$(date +%s%N); ls -l $F/big34/f${bigCount - 1} >/dev/null; end=$(date +%s%N); echo $(( (end - start) / 1000000 ))`), 'ls -l');
    const oneMs = Number(one.out.trim());
    d.push(`ls | wc -l: ${n} in ${(ms / 1000).toFixed(1)} s cold (pages of 1,000); ls -l of f${bigCount - 1}: ${oneMs} ms`);
    if (FULL) {
      assert.ok(ms < 30_000, 'under 30 s cold');
      assert.ok(oneMs < 1000, 'under 1 s');
    }
  });

  await row('35', 'ls -la $F/ (with the slash), and $F without it', async (d) => {
    const s = ok(await sh(a, 'echo f > $F/r35.txt && mkdir -p $F/r35dir && ls -la $F/ | head -12; echo ---; ls -la $F; echo ---; stat -c "%u %g %A" $F/r35.txt $F/r35dir; ls -a $F/ | grep -ci trash || true'), 'ls');
    const [listing, link, stats] = s.out.split('---\n');
    assert.match(listing, /^drwxr-xr-x .* 10001 10001 .* \.$/m);
    assert.match(link, /^l.* -> .*\/drive$/m, 'without the slash: the symlink');
    assert.match(stats, /^10001 10001 -rw-r--r--\n10001 10001 drwxr-xr-x\n0\n$/);
    d.push('uid/gid 10001 (orbit in the runner image), files -rw-r--r--, folders drwxr-xr-x, no Trash folder; ls -la $F shows the symlink');
    // $F and $F/: a command that does not follow a symlink given as its argument sees the link without the slash.
    const both = ok(await sh(a, 'echo g > $F/r35dir/g.txt; find $F | wc -l; find $F/ -maxdepth 1 | wc -l; cat $F/r35.txt >/dev/null && cat $F/r35dir/g.txt >/dev/null && echo cat-both; ls -ld $F | cut -c1; ls -ld $F/ | cut -c1'), '$F and $F/');
    const [linkOnly, listed, cats, linkType, dirType] = both.out.trim().split('\n');
    assert.equal(linkOnly, '1', 'find $F: the link alone');
    assert.ok(Number(listed) > 2, 'find $F/: the drive');
    assert.equal(cats, 'cat-both');
    assert.deepEqual([linkType, dirType], ['l', 'd']);
    d.push(`find $F lists the link alone, find $F/ the drive (${listed} at depth 1); paths below either spelling work`);
  });

  const findFolders = FULL ? 2000 : 400;
  await row('36', `find $F/ | wc -l and grep -r over ${findFolders * 5} entries in ${findFolders} folders`, async (d) => {
    // Through the door, as a drive tool would write them, so every file has its own content; read cold on runner B.
    await ownerFolder('tree36');
    const doorAs = (method: string, route: string, body?: unknown) => call(server, method, `/api/runner/drive${route}`, rb.token, body);
    const work: Array<() => Promise<void>> = [];
    for (let i = 0; i < findFolders; i += 1) {
      work.push(async () => {
        const folder = `/tree36/g${i % 40}/d${i}`;
        assert.equal((await doorAs('POST', '/mkdir', { path: folder, parents: true })).status, 201);
        for (let k = 0; k < 4; k += 1) {
          const bytes = Buffer.from(`file ${i} ${k}${i % 97 === 0 && k === 0 ? ' needle' : ''}\n`);
          const handleId = randomUUID();
          const created = await doorAs('POST', '/create', { path: `${folder}/f${k}`, handleId });
          assert.equal(created.status, 201, created.text);
          const staging = await doorAs('POST', '/stagings', { entryId: created.json.id });
          const put = await new Promise<number>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: server.port, method: 'PUT', path: `/api/runner/drive/stagings/${staging.json.id}/chunks/0`, headers: { authorization: `Bearer ${rb.token}`, 'x-orbit-chunk-sha256': sha256(bytes), 'content-length': String(bytes.length) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
            req.on('error', reject);
            req.end(bytes);
          });
          assert.equal(put, 200);
          const commit = await doorAs('POST', '/commit', { commitId: randomUUID(), entryId: created.json.id, mode: 'CONTINUE', baseVersionId: created.json.currentVersionId, handleId, stagingId: staging.json.id, chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }] });
          assert.equal(commit.status, 200, commit.text);
        }
      });
    }
    const lanes = 16;
    await Promise.all(Array.from({ length: lanes }, async (_, lane) => {
      for (let i = lane; i < work.length; i += lanes) await work[i]();
    }));
    await waitFor('A and B see tree36', async () => (await sh(a, 'test -d $F/tree36')).code === 0 && (await sh(b, 'test -d $F/tree36')).code === 0, 30_000, 500);
    const entries = 40 + findFolders * 5 + 1;
    const cold = ok(await sh(b, 's=$(date +%s%N); n=$(find $F/tree36/ | wc -l); e=$(date +%s%N); echo "$n $(( (e - s) / 1000000 ))"'), 'find cold');
    const [n, coldMs] = cold.out.trim().split(' ').map(Number);
    assert.equal(n, entries);
    const warm = ok(await sh(b, 's=$(date +%s%N); find $F/tree36/ >/dev/null; e=$(date +%s%N); echo $(( (e - s) / 1000000 ))'), 'find warm');
    const grep = ok(await sh(a, 's=$(date +%s%N); n=$(grep -rl needle $F/tree36/ | wc -l); e=$(date +%s%N); echo "$n $(( (e - s) / 1000000 ))"'), 'grep cold');
    const [hits, grepMs] = grep.out.trim().split(' ').map(Number);
    assert.equal(hits, Math.ceil(findFolders / 97));
    d.push(`find: ${n} entries, ${(coldMs / 1000).toFixed(1)} s cold, ${(Number(warm.out) / 1000).toFixed(2)} s warm; grep -r: ${hits} hits, ${(grepMs / 1000).toFixed(1)} s cold`);
    if (FULL) {
      assert.ok(coldMs < 15_000, 'find cold under 15 s');
      assert.ok(Number(warm.out) < 2_000, 'find warm under 2 s');
      assert.ok(grepMs < 60_000, 'grep cold under 60 s');
    }
  });

  await row('37', 'du -sh $F/; df -h $F/', async (d) => {
    const s = ok(await sh(a, 'du -sb $F/sub/; du -sh $F/ | cut -f1; df -B1 --output=used,avail $F/ | tail -1; df -h $F/ | tail -1'), 'du df');
    const lines = s.out.trim().split('\n');
    const used = Number(lines[2].trim().split(/\s+/)[0]);
    const avail = Number(lines[2].trim().split(/\s+/)[1]);
    const live = await db.driveEntry.aggregate({ where: { ownerId: owner, kind: 'FILE', trashedAt: null }, _sum: { sizeBytes: true } });
    const liveBytes = Number(live._sum.sizeBytes ?? 0);
    assert.ok(Math.abs(used - liveBytes) <= 4096 * 2 + liveBytes * 0.01, `df used ${used} vs drive ${liveBytes}`);
    assert.ok(avail >= 2 ** 49, 'a large free figure');
    d.push(`du -sh: ${lines[1]}; df -h: ${lines[3].replace(/\s+/g, ' ')} (used = the account's drive bytes, free 1 PiB)`);
  });

  // ═══ Refusals ════════════════════════════════════════════════════════════════════════════════════

  await row('38', 'ln $F/a $F/b; ln -s a $F/l; mkfifo $F/p', async (d) => {
    const s = await sh(a, 'echo a > $F/a38; ln $F/a38 $F/b38; echo "rc1=$?"; ln -s a38 $F/l38; echo "rc2=$?"; mkfifo $F/p38; echo "rc3=$?"');
    assert.match(s.out, /rc1=1\nrc2=1\nrc3=1/);
    assert.equal((s.err.match(/Operation not permitted/g) ?? []).length, 3);
    assert.match(errorsLog(a), /EPERM link .*b38: the drive has no hard links/);
    d.push('"Operation not permitted", exit 1, each; errors.log says why');
  });

  await row('39', 'chmod +x $F/a.txt; chmod 644 $F/a.txt', async (d) => {
    const s = await sh(a, 'echo t > $F/m39; chmod +x $F/m39; echo "rc1=$?"; chmod 644 $F/m39; echo "rc2=$?"; chmod 600 $F/m39; echo "rc3=$?"; chmod 664 $F/m39; echo "rc4=$?"; stat -c %a $F/m39');
    assert.match(s.out, /rc1=1\nrc2=0\nrc3=0\nrc4=1\n644/);
    assert.match(s.err, /Operation not permitted/);
    d.push('first: "Operation not permitted"; second: exit 0. Also: 0600 (the owner\'s own bits, which rsync -a sets on its temporary files) is a no-op, 0664 is refused; the mode stays 0644');
  });

  await row('40', 'flock $F/a.txt true; sqlite create table', async (d) => {
    const s = await sh(a, `echo t > $F/l40; flock $F/l40 true; echo "flock rc=$?"
      python3 -c "import sqlite3; c=sqlite3.connect('$F/x40.db'); c.execute('create table t(a)'); c.commit()"; echo "sqlite rc=$?"`);
    assert.match(s.err, /No locks available/);
    assert.match(s.out, /flock rc=(1|71)\b/);
    assert.match(s.out, /sqlite rc=[1-9]/);
    assert.match(errorsLog(a), /ENOLCK fcntl lock \/home\/orbit\/Drive\/x40\.db: the drive has no file locks/);
    d.push(`flock: "No locks available", exit ${/flock rc=(\d+)/.exec(s.out)![1]} (util-linux exits EX_OSERR for ENOLCK); sqlite (the sqlite3 CLI is not on this host, so Python's sqlite3, the same library): "${(/sqlite3\.\w+: ([^\n]+)/.exec(s.err) ?? ['', 'fails'])[1]}", exit ≠ 0; errors.log says the drive has no file locks`);
  });

  await row('41', 'git init $F/repo && git commit --allow-empty', async (d) => {
    const s = await sh(a, 'timeout 30 git init -q $F/repo41 && timeout 30 git -C $F/repo41 -c user.email=e@x -c user.name=e commit -q --allow-empty -m x; echo "rc=$?"; git -C $F/repo41 log --oneline | wc -l; git -C $F/repo41 config core.fileMode', { timeoutMs: 70_000 });
    assert.match(s.out, /rc=0\n1\nfalse/);
    assert.ok(s.ms < 60_000);
    assert.doesNotMatch(s.err, /Input\/output error/);
    d.push(`both succeeded in ${(s.ms / 1000).toFixed(1)} s: git took the refused chmod probe as core.fileMode=false and fell back from hard links to renames; no hang, no I/O error`);
  });

  await row('42', 'dd if=/dev/zero of=$F/a.txt bs=1 count=1 seek=2 conv=notrunc', async (d) => {
    const s = await sh(a, 'printf "hello\\n" > $F/h42; dd if=/dev/zero of=$F/h42 bs=1 count=1 seek=2 conv=notrunc; echo "rc=$?"');
    assert.match(s.out, /rc=1/);
    assert.match(s.err, /Operation not supported/);
    assert.equal((await content('/h42')).toString(), 'hello\n', 'unchanged');
    d.push('"Operation not supported", exit 1; h42 unchanged');
  });

  await row('43', 'Python mmap ACCESS_WRITE on r+b; a read-only mmap on rb', async (d) => {
    const s = ok(await sh(a, `printf "hello\\n" > $F/m43; python3 -c "
import mmap
f = open('$F/m43', 'r+b')
try:
    mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_WRITE); print('mapped')
except OSError as e:
    print('OSError:', e)
f.close()"; python3 -c "
import mmap
g = open('$F/m43', 'rb'); m = mmap.mmap(g.fileno(), 0, access=mmap.ACCESS_READ); print('read', m[:5])"`), 'mmap');
    assert.match(s.out, /OSError: \[Errno 19\] No such device/);
    assert.match(s.out, /read b'hello'/);
    d.push('OSError: [Errno 19] No such device; the read-only mmap of rb works');
  });

  await row('44', "printf '#!/bin/sh\\necho ok' > $F/s.sh; $F/s.sh; bash $F/s.sh", async (d) => {
    const s = await sh(a, 'printf "#!/bin/sh\\necho ok" > $F/s44.sh; $F/s44.sh; echo "rc=$?"; bash $F/s44.sh');
    assert.match(s.err, /Permission denied/);
    assert.match(s.out, /rc=126\nok/);
    d.push('first: "Permission denied" (noexec); bash s.sh prints ok');
  });

  await row('45', 'touch -d 2020-01-01 $F/a.txt; stat -c %y', async (d) => {
    const s = ok(await sh(a, 'echo t > $F/t45; touch -d 2020-01-01 $F/t45; stat -c %y $F/t45'), 'touch');
    assert.match(s.out, /^2020-01-01 /);
    assert.equal(new Date((await mustEntry('/t45')).mtime).getUTCFullYear() <= 2020, true);
    d.push(`shows ${s.out.trim()}, and the server keeps it`);
  });

  await row('46', 'a name of 256 bytes; a name of invalid UTF-8', async (d) => {
    const s = await sh(a, `touch $F/${'n'.repeat(256)}; echo "rc1=$?"; touch $F/$'bad\\xff'; echo "rc2=$?"`);
    assert.match(s.out, /rc1=1\nrc2=1/);
    assert.match(s.err, /File name too long/);
    assert.match(s.err, /Invalid argument/);
    d.push('"File name too long"; "Invalid argument"');
  });

  await row('46b', 'the rest of §5.6: RENAME_EXCHANGE, xattrs, fallocate', async (d) => {
    const s = await sh(a, `echo x > $F/x46; echo y > $F/y46
      mv --exchange $F/x46 $F/y46; echo "exchange rc=$?"
      python3 -c "
import ctypes, errno, os
libc = ctypes.CDLL(None, use_errno=True)
r = libc.renameat2(-100, b'$F/x46', -100, b'$F/y46', 2)
print('renameat2', r, errno.errorcode[ctypes.get_errno()])"
      python3 -c "
import os, errno
for name, call in [('setxattr', lambda: os.setxattr('$F/x46', 'user.k', b'v')), ('getxattr', lambda: os.getxattr('$F/x46', 'user.k')),
                   ('fallocate', lambda: os.posix_fallocate(os.open('$F/x46', os.O_WRONLY), 0, 4096))]:
    try:
        call(); print(name, 'ok')
    except OSError as e:
        print(name, errno.errorcode[e.errno])
print('listxattr', os.listxattr('$F/x46'))"`);
    assert.match(s.out, /exchange rc=1/);
    assert.match(s.out, /renameat2 -1 EINVAL/);
    assert.match(s.out, /setxattr (ENOTSUP|EOPNOTSUPP)\ngetxattr ENODATA\nfallocate (ENOTSUP|EOPNOTSUPP)\nlistxattr \[\]/);
    assert.equal((await content('/x46')).toString(), 'x\n', 'nothing swapped');
    const log = errorsLog(a);
    assert.match(log, /EINVAL rename .*x46.*RENAME_EXCHANGE/);
    assert.match(log, /ENOTSUP setxattr .*x46 user\.k: the drive keeps no extended attributes/);
    assert.match(log, /EOPNOTSUPP fallocate .*x46/);
    d.push(`renameat2(RENAME_EXCHANGE): EINVAL ("Invalid argument"), which mv --exchange words "${(/mv: [^\n]*: ([^\n]+)/.exec(s.err) ?? ['', '?'])[1]}"; nothing swapped; setxattr ENOTSUP, getxattr ENODATA, listxattr empty; fallocate EOPNOTSUPP; each refusal in errors.log`);
  });

  // ═══ Sharing state, outages, failures ══════════════════════════════════════════════════════════

  await row('47', 'write on runner A, read on runner B; the owner renames on the web', async (d) => {
    const started = Date.now();
    ok(await sh(a, 'echo first > $F/r47.txt'), 'write on A');
    let seen = 0;
    await waitFor('B reads it', async () => {
      const s = await sh(b, 'cat $F/r47.txt 2>/dev/null');
      if (s.out === 'first\n') seen = Date.now() - started;
      return seen > 0;
    }, 30_000, 100);
    ok(await sh(a, 'echo second > $F/r47.txt'), 'overwrite on A');
    const again = Date.now();
    let changed = 0;
    await waitFor('B reads the new content', async () => {
      const s = await sh(b, 'cat $F/r47.txt');
      if (s.out === 'second\n') changed = Date.now() - again;
      return changed > 0;
    }, 30_000, 100);
    const e = await mustEntry('/r47.txt');
    assert.equal((await api('PATCH', `/drive/entries/${e.id}`, { name: 'r47-renamed.txt' })).status, 200);
    const renamed = Date.now();
    let moved = 0;
    await waitFor('A sees the rename', async () => {
      const s = await sh(a, 'ls $F/ | grep -c "^r47"; cat $F/r47-renamed.txt');
      if (/^1\nsecond\n$/.test(s.out)) moved = Date.now() - renamed;
      return moved > 0;
    }, 30_000, 100);
    d.push(`B read A's new file after ${seen} ms and its overwrite after ${changed} ms (the change feed); A saw the owner's rename after ${moved} ms, no remount`);
  });

  await row('owner', 'a file the owner uploads on the Files page is readable from a second session\'s mount', async (d) => {
    const bytes = Buffer.concat([Buffer.from('uploaded by the owner\n'), randomBytes(9 * MiB)]);
    ok(await sh(a, 'mkdir -p $F/uploads && ls $F/uploads/'), 'the folder is listed on A first');
    const started = Date.now();
    await ownerUpload('/uploads', 'from-the-page.bin', bytes);
    let seen = 0;
    await waitFor('the second session reads it', async () => {
      const s = await sh(a, 'sha256sum < $F/uploads/from-the-page.bin 2>/dev/null', { session: secondSession });
      if (s.out.startsWith(sha256(bytes))) seen = Date.now() - started;
      return seen > 0;
    }, 30_000, 200);
    const onB = ok(await sh(b, 'sha256sum < $F/uploads/from-the-page.bin'), 'and on runner B');
    assert.ok(onB.out.startsWith(sha256(bytes)));
    d.push(`a ${(bytes.length / MiB).toFixed(1)} MiB upload (2 chunks) read whole by a second session on runner A ${seen} ms after it completed, and on runner B`);
  });

  await row('48', 'server unreachable: cached and uncached cat, ls, echo >, echo >>', async (d) => {
    ok(await sh(a, 'mkdir -p $F/off48 && echo cached > $F/off48/cached.txt && echo "x" > $F/off48/app.txt && cat $F/off48/cached.txt && ls $F/off48/'), 'warm the cache');
    await ownerUpload('/off48', 'uncached.txt', Buffer.from('never read on A\n'));
    await waitFor('A lists the uncached file', async () => (await sh(a, 'ls $F/off48/ | grep -q uncached.txt')).code === 0, 30_000, 200);
    for (const mode of ['refuse', 'blackhole'] as const) {
      // Read while online, as an agent would have: a reconnect drops the metadata cache (§5.4), the chunks stay.
      ok(await sh(a, 'cat $F/off48/cached.txt && ls $F/off48/ >/dev/null'), 'warm the cache');
      a.proxy.set(mode);
      const reads = await sh(a, `
        cat $F/off48/cached.txt; echo "cached rc=$?"
        ls $F/off48/ | tr '\\n' ' '; echo "ls rc=$?"
        s=$(date +%s%N); cat $F/off48/uncached.txt; echo "uncached rc=$? ms=$(( ($(date +%s%N) - s) / 1000000 ))"`, { timeoutMs: 120_000 });
      assert.match(reads.out, /cached\ncached rc=0/);
      assert.match(reads.out, /cached\.txt .*ls rc=0/);
      assert.match(reads.out, /uncached rc=1 ms=\d+/);
      const uncachedMs = Number(/uncached rc=1 ms=(\d+)/.exec(reads.out)![1]);
      assert.ok(uncachedMs <= 10_000, `uncached cat failed after ${uncachedMs} ms`);
      assert.match(reads.err, /uncached\.txt: Input\/output error/);
      // The daemon is offline once it has met the outage (three failures in 10 s, or a request past its deadline with
      // nothing answered while it waited).
      const cut = Date.now();
      await waitFor('status.json says offline', () => status(a).connected === false, 30_000, 100);
      const noticed = Date.now() - cut;
      const writes = await sh(a, `
        echo x > $F/off48/n-${mode}; echo "create rc=$?"
        echo x >> $F/off48/app.txt; echo "append rc=$?"`, { timeoutMs: 60_000 });
      assert.match(writes.err, new RegExp(`n-${mode}: Input/output error`));
      assert.match(writes.err, /write error: Input\/output error/);
      assert.match(writes.out, /create rc=1\nappend rc=1/);
      d.push(`${mode === 'refuse' ? 'connections refused' : 'connections held unanswered'}: cached cat and ls work; uncached cat "Input/output error" after ${uncachedMs} ms; status.json connected=false (since ${status(a).since}, ${noticed} ms after the uncached read); then echo > fails at open, echo >> at write ("write error: Input/output error")`);
      a.proxy.set('pass');
      await waitFor('back online', () => status(a).connected === true, 30_000);
    }
    assert.equal((await content('/off48/app.txt')).toString(), 'x\n', 'the failed appends committed nothing');
  });

  await row('49', 'a writer with uncommitted bytes when the server goes away, then returns', async (d) => {
    const unsent = path.join(a.root, 'unsent');
    const writer = sh(a, `python3 -c "
import time
f = open('$F/w49.txt', 'w'); f.write('kept bytes\\n'); f.flush()
time.sleep(3)
t = time.time()
try:
    f.close(); print('closed')
except OSError as e:
    print('close failed:', e, 'after %.1f s' % (time.time() - t))
"`, { timeoutMs: 120_000 });
    await sleep(1_000);
    a.proxy.set('refuse');
    const s = await writer;
    assert.match(s.out, /close failed: \[Errno 5\] Input\/output error after (\d+\.\d) s/);
    const waited = Number(/after (\d+\.\d) s/.exec(s.out)![1]);
    assert.ok(waited <= 35, `close waited ${waited} s`);
    const saved = spawnSync('ls', [unsent], { encoding: 'utf8' }).stdout.trim().split('\n').filter((f) => f.endsWith('w49.txt'));
    assert.equal(saved.length, 1, 'unsent/ holds its bytes');
    assert.equal(readFileSync(path.join(unsent, saved[0]), 'utf8'), 'kept bytes\n');
    assert.match(errorsLog(a), new RegExp(`EIO close /home/orbit/Drive/w49\\.txt: .*kept in /run/orbit-drive/unsent/${saved[0].replace(/[.]/g, '\\.')}`));
    a.proxy.set('pass');
    await waitFor('back online', () => status(a).connected === true, 30_000);
    ok(await sh(a, 'echo after > $F/after49.txt && cat $F/after49.txt'), 'reads and writes work without a remount');
    await sleep(2_000);
    assert.ok(existsSync(path.join(unsent, saved[0])), 'the unsent file stays: its commit never applied');
    d.push(`close failed "Input/output error" after ${waited} s; unsent/${saved[0]} holds the bytes and errors.log names it; back online, reads and writes work without a remount; the file stays`);

    // The same, but the commit did apply and only its answer was lost: the file is removed once the server answers.
    const writer2 = sh(a, `python3 -c "
import time
f = open('$F/w49b.txt', 'w'); f.write('applied after all\\n'); f.flush(); time.sleep(3)
try:
    f.close(); print('closed')
except OSError as e:
    print('close failed:', e)
"`, { timeoutMs: 120_000 });
    await sleep(1_000);
    a.proxy.dropCommitAnswers = 1;
    const commitsBefore = a.proxy.commits;
    await waitFor('the commit was sent and its answer dropped', () => a.proxy.dropped >= 1 && a.proxy.commits > commitsBefore, 20_000, 50);
    a.proxy.set('refuse');
    const s2 = await writer2;
    assert.match(s2.out, /close failed/);
    const saved2 = spawnSync('ls', [unsent], { encoding: 'utf8' }).stdout.trim().split('\n').filter((f) => f.endsWith('w49b.txt'));
    assert.equal(saved2.length, 1);
    a.proxy.set('pass');
    await waitFor('the unsent file whose commit applied is removed', () => !existsSync(path.join(unsent, saved2[0])), 90_000, 500);
    assert.match(errorsLog(a), new RegExp(`unsent/${saved2[0].replace(/[.]/g, '\\.')}: removed: its commit .* did apply`));
    assert.equal((await content('/w49b.txt')).toString(), 'applied after all\n');
    d.push('a close whose commit applied but whose answer was lost: unsent/ kept it until the server answered, then it was removed and errors.log says the commit did apply');
    a.proxy.dropped = 0;
  });

  await row('50', 'a commit whose answer is lost, retried', async (d) => {
    a.proxy.dropCommitAnswers = 1;
    a.proxy.dropped = 0;
    ok(await sh(a, 'echo once > $F/r50.txt'), 'write');
    assert.equal(a.proxy.dropped, 1, 'the first answer was dropped');
    const e = await mustEntry('/r50.txt');
    assert.equal((await versions(e.id)).length, 1, 'one version, not two');
    ok(await sh(a, 'echo base > $F/r50.log'), 'log');
    a.proxy.dropCommitAnswers = 1;
    ok(await sh(a, 'echo line >> $F/r50.log'), 'append');
    assert.equal(a.proxy.dropped, 2);
    assert.equal((await content('/r50.log')).toString(), 'base\nline\n', 'the line once');
    d.push('applied once: a lost answer was retried with the same commitId and answered from the stored result; one version; an append\'s line appears once');
  });

  await row('51', 'unsent/ past its limit', async (d) => {
    const limit = FULL ? 1024 : 64;
    const each = FULL ? 400 : 30;
    const unsent = path.join(b.root, 'unsent');
    const writers = [1, 2, 3].map((i) => sh(b, `python3 -c "
import os, time
f = open('$F/u51-${i}.bin', 'wb'); f.write(os.urandom(${each} * 1024 * 1024)); f.flush(); time.sleep(${i * 3} + 8)
try:
    f.close()
except OSError as e:
    print('close failed', e)
"`, { timeoutMs: 600_000 }));
    await sleep(6_000);
    b.proxy.set('refuse');
    const outs = await Promise.all(writers);
    for (const o of outs) assert.match(o.out, /close failed/);
    const files = spawnSync('ls', [unsent], { encoding: 'utf8' }).stdout.trim().split('\n').filter((f) => /u51-\d\.bin$/.test(f));
    const log = errorsLog(b);
    const removed = (log.match(/unsent\/\S*u51-\d\.bin: removed \(\d+ bytes\) to keep unsent\/ under/g) ?? []).length;
    assert.ok(removed >= 1, 'the oldest went first, logged');
    assert.ok(files.length < 3);
    assert.ok(files.every((f) => !/u51-1\.bin$/.test(f)), 'the oldest is the one removed');
    b.proxy.set('pass');
    await waitFor('back online', () => status(b).connected === true, 30_000);
    d.push(`3 × ${each} MiB unsent with unsent/ capped at ${limit} MiB: ${removed} removed, oldest first, each removal in errors.log; ${files.length} kept`);
  });

  await row('52', 'a process holds $F/long.log open, writes one line, then sleeps', async (d) => {
    const holder = sh(a, `python3 -c "
import time
f = open('$F/long52.log', 'w'); f.write('one line\\n'); f.flush(); time.sleep(70); f.close()"`, { timeoutMs: 180_000 });
    const started = Date.now();
    let onServer = 0;
    await waitFor('the line is on the server', async () => {
      const e = await resolveEntry('/long52.log');
      if (e && e.sizeBytes === 9) onServer = Date.now() - started;
      return onServer > 0;
    }, 45_000, 500);
    const onB = ok(await sh(b, 'cat $F/long52.log'), 'B reads it');
    assert.equal(onB.out, 'one line\n');
    await waitFor('nothing uncommitted', () => status(a).uncommittedHandles === 0, 10_000);
    const stagings = await db.driveStaging.findMany({ where: { entryId: toUuid((await mustEntry('/long52.log')).id) } });
    assert.ok(stagings.every((s) => !s.dirty), 'no staging holds the runner awake (§8.1)');
    await holder;
    d.push(`the line was on the server ${(onServer / 1000).toFixed(1)} s after the write (periodic commit, 30 s idle) while the handle stayed open; runner B read it; no dirty staging, status.json uncommittedHandles 0, so the runner may sleep`);
  });

  await row('53', 'daemon SIGKILLed', async (d) => {
    ok(await sh(a, 'echo held > $F/r53.txt'), 'a file');
    // A descriptor opened before the kill is the dead connection's: what reads it fails at once. A path looked up
    // after it reaches the new mount, which the parent puts over the dead one.
    const run = sh(a, `exec 3< $F/r53.txt
      sleep 2
      s=$(date +%s%N); cat <&3 2>&1; echo "held rc=$? ms=$(( ($(date +%s%N) - s) / 1000000 ))"
      for i in $(seq 1 150); do if cat $F/r53.txt >/dev/null 2>&1; then echo "back ms=$(( ($(date +%s%N) - s) / 1000000 ))"; break; fi; sleep 0.1; done`, { timeoutMs: 60_000 });
    await sleep(800);
    const pid = Number(rootSh(`pgrep -u 65532 -f "serve.*--state-dir=${a.root}" | head -1`).stdout.trim());
    assert.ok(pid > 0);
    const killed = Date.now();
    process.kill(pid, 'SIGKILL');
    const s = await run;
    assert.match(s.out, /Transport endpoint is not connected\nheld rc=1 ms=\d+/, `${s.out}${s.err}`);
    const failedMs = Number(/held rc=1 ms=(\d+)/.exec(s.out)![1]);
    assert.ok(failedMs < 1_000, 'at once');
    const backMs = Number(/back ms=(\d+)/.exec(s.out)?.[1] ?? NaN);
    assert.ok(backMs <= 15_000, `back after ${backMs} ms`);
    assert.ok(Date.now() - killed < 30_000);
    d.push(`a read of a descriptor opened before the kill failed "Transport endpoint is not connected" in ${failedMs} ms; a new lookup read the file ${backMs} ms after that, on the mount the parent put over the dead one, no runner restart`);
  });

  await row('54', 'daemon SIGSTOPped', async (d) => {
    const pid = Number(rootSh(`pgrep -u 65532 -f "serve.*--state-dir=${a.root}" | head -1`).stdout.trim());
    process.kill(pid, 'SIGSTOP');
    const s = await sh(a, 's=$(date +%s%N); stat $F/zz-never 2>&1 | tail -1; echo "ms=$(( ($(date +%s%N) - s) / 1000000 ))"', { timeoutMs: 60_000 });
    const blocked = Number(/ms=(\d+)/.exec(s.out)![1]);
    assert.ok(blocked <= 20_000, `blocked ${blocked} ms`);
    assert.match(s.out, /Software caused connection abort|Transport endpoint is not connected/);
    await waitFor('the drive is back', async () => (await sh(a, 'ls $F/b.txt')).code === 0, 15_000, 100);
    d.push(`a call blocked ${(blocked / 1000).toFixed(1)} s until the watchdog aborted the connection: the call in flight got "${/Software caused connection abort|Transport endpoint is not connected/.exec(s.out)![0]}" (the kernel's errno for requests in flight on an abort; later calls get "Transport endpoint is not connected"); recovered as in 53`);
  });

  // Row 56 (docs/drive-technical-design.md §5.9, §7.2): for each engine's own sandbox, a process started
  // under it writes and reads ~/Drive, the daemon is SIGKILLed, the parent remounts, and the SAME process writes and reads
  // again. Cursor's is bwrap with the parent bound (cursor_sandbox.go wrap); Codex's is `codex sandbox`, whose writable
  // roots are the ones codexSandboxPolicy names. Claude Code, OpenCode, Antigravity, Kimi and DSH run no OS sandbox of
  // their own on Linux (their grants are launch arguments and permission rules), so their process is a plain one.
  await row('56', 'each engine\'s sandbox keeps ~/Drive across a remount', async (d) => {
    const probe = (name: string) => `n=${name}
      echo "before-$n" > "$F/e56-$n.txt" && echo "before write ok" && cat "$F/e56-$n.txt" && echo "before read ok" || echo "before FAILED"
      sleep 3
      s=$(date +%s%N); rc=1
      for i in $(seq 1 600); do
        if echo "after-$n" > "$F/e56-$n.txt" 2>/dev/null && [ "$(cat "$F/e56-$n.txt" 2>/dev/null)" = "after-$n" ]; then rc=0; break; fi
        sleep 0.1
      done
      echo "after rc=$rc ms=$(( ($(date +%s%N) - s) / 1000000 ))"
      echo "dotfiles: $(ls -A "$F/" | grep '^[.]' | tr '\n' ' ')"`;
    const bwrap = (binds: string[]) => `exec bwrap --die-with-parent --new-session --unshare-user --unshare-pid --unshare-ipc --unshare-uts --ro-bind / / --dev /dev --proc /proc ${binds.map((b) => `--bind ${b} ${b}`).join(' ')} -- bash "$P"`;
    // SIGKILL: the parent puts a new daemon on the same connection. SIGSTOP: the watchdog aborts the connection and the
    // parent mounts a new one over the dead one (row 54), the case a bind of drive/ itself cannot follow (§7.2).
    type Probe = { name: string; signal: 'SIGKILL' | 'SIGSTOP'; wrap: (script: string) => string; expectAfter: 'ok' | 'stale' | 'observe' };
    const codexWrap = (x: string) => `P='${x}'; cd /tmp; exec codex sandbox -c sandbox_mode=workspace-write -c 'sandbox_workspace_write.writable_roots=["${a.drive}"]' -- bash "$P"`;
    const cases: Probe[] = [];
    for (const signal of ['SIGKILL', 'SIGSTOP'] as const) {
      cases.push(
        { name: `cursor-bwrap-parent-${signal}`, signal, expectAfter: 'ok', wrap: (x) => `P='${x}'; ${bwrap([a.root])}` },
        { name: `codex-sandbox-${signal}`, signal, expectAfter: 'ok', wrap: codexWrap },
        { name: `plain-engine-process-${signal}`, signal, expectAfter: 'ok', wrap: (x) => `P='${x}'; exec bash "$P"` },
        { name: `control-bwrap-of-drive-itself-${signal}`, signal, expectAfter: signal === 'SIGSTOP' ? 'observe' : 'observe', wrap: (x) => `P='${x}'; ${bwrap([a.drive])}` },
      );
    }
    for (const c of cases) {
      const script = path.join(scripts, `probe56-${c.name}.sh`);
      writeFileSync(script, probe(c.name), { mode: 0o644 });
      const run = sh(a, c.wrap(script), { timeoutMs: 150_000 });
      await sleep(1_200);
      const pid = Number(rootSh(`pgrep -u 65532 -f "serve.*--state-dir=${a.root}" | head -1`).stdout.trim());
      assert.ok(pid > 0, 'a daemon to disturb');
      process.kill(pid, c.signal);
      const r = await run;
      const text = `${r.out}${r.err}`;
      assert.match(text, /before write ok[\s\S]*before read ok/, `${c.name}: before\n${text}`);
      const after = /after rc=(\d+) ms=(\d+)/.exec(r.out);
      assert.ok(after, `${c.name}: no verdict\n${text}`);
      if (c.expectAfter === 'ok') assert.equal(after![1], '0', `${c.name}: after the remount\n${text}`);
      d.push(`${c.name} (${/dotfiles:.*/.exec(r.out)?.[0] ?? 'dotfiles: ?'}): wrote and read before; after the ${c.signal === 'SIGKILL' ? 'kill and replacement' : 'abort and remount'} ${after![1] === '0' ? `wrote and read again (${after![2]} ms)` : 'could not (its mount is dead)'}${c.expectAfter === 'observe' ? ' [control, not asserted]' : ''}`);
      await waitFor('the drive is back', async () => (await sh(a, 'ls $F/')).code === 0, 40_000, 200);
      if (c.signal === 'SIGSTOP') rootSh(`kill -KILL ${pid} 2>/dev/null; true`);
    }
  });

  await row('57', 'umount, fusermount3 -u, mount -o remount,ro from the agent', async (d) => {
    const s = await sh(a, 'echo f > $F/r57.txt; umount $F/; echo "rc1=$?"; fusermount3 -u $F/; echo "rc2=$?"; mount -o remount,ro $F/; echo "rc3=$?"; cat $F/r57.txt && echo f >> $F/r57.txt && echo still-mounted-and-writable');
    assert.match(s.out, /rc1=[1-9]\d*\nrc2=[1-9]\d*\nrc3=[1-9]\d*\nf\nstill-mounted-and-writable/, `${s.out}\n${s.err}`);
    assert.ok(mounted(a.drive));
    assert.match(s.err, /must be superuser|Operation not permitted|not permitted/);
    d.push(`refused: ${s.err.trim().split('\n').map((l) => l.replace(/\/\S+/g, '…')).join(' / ')}; the drive is still mounted`);
  });

  await row('58', 'a superseded generation\'s daemon writes', async (d) => {
    ok(await sh(a, 'echo before > $F/r58.txt'), 'write');
    const versionsBefore = await db.driveVersion.count({ where: { ownerId: owner } });
    await db.managedRunner.update({ where: { id: mapping.id }, data: { generation: 2, podUid: randomUUID() } });
    // The daemon learns it at its next request: the change feed polls every 15 s at most.
    await waitFor('the daemon is fenced', () => /instance was replaced/.test(errorsLog(a)) || status(a).fenced !== undefined, 40_000, 500);
    const s = await sh(a, 'echo x >> $F/r58.txt; echo "rc=$?"');
    assert.match(s.err, /Input\/output error|Transport endpoint is not connected/);
    assert.match(errorsLog(a), /the runner instance was replaced|instance was replaced/);
    assert.equal(await db.driveVersion.count({ where: { ownerId: owner } }), versionsBefore, 'nothing committed');
    assert.equal((await content('/r58.txt')).toString(), 'before\n');
    d.push(`write failed (${/Input\/output error|Transport endpoint is not connected/.exec(s.err)![0]}); errors.log: "${/[^\n]*instance was replaced[^\n]*/.exec(errorsLog(a))![0].slice(21, 140)}…"; nothing committed; the daemon left and the parent did not mount again`);
  });

  t.diagnostic(`\n${table()}\n`);
  if (process.env.DRIVE_MOUNT_E2E_REPORT) writeFileSync(process.env.DRIVE_MOUNT_E2E_REPORT, `${table()}\n`);
});
