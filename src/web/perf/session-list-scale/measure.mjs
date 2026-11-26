// Before/after of the web session list on 1,500 Open sessions (docs/session-list-scale-design.md §5 T4).
// For each of two commits it builds the apiserver and the web app, starts the real apiserver on a copy of one
// seeded PostgreSQL database, serves the web build with src/web/nginx.conf (plus the gateway's gzip settings),
// and drives it with Chromium. See README.md.
//
//   node src/web/perf/session-list-scale/measure.mjs \
//     --before <rev> --after <rev> --work <scratch dir> --out <results dir> [--runs 10] [--frames 20]
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { measureLoad, measureWatchFrames } from './browser.mjs';
import { report } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { values: args } = parseArgs({
  options: {
    before: { type: 'string' }, after: { type: 'string' }, work: { type: 'string' }, out: { type: 'string' },
    runs: { type: 'string', default: '10' }, frames: { type: 'string', default: '20' },
  },
});
for (const name of ['before', 'after', 'work', 'out']) if (!args[name]) throw new Error(`--${name} is required`);
const work = resolve(args.work);
const out = resolve(args.out);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

const sh = (cmd, argv, options = {}) => execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...options }).toString().trim();
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = () => new Promise((done) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
});

const builds = ['before', 'after'].map((label) => ({
  label, rev: sh('git', ['-C', repo, 'rev-parse', `${args[label]}^{commit}`]), tree: join(work, label),
}));

/** A detached checkout of the build's commit with its own apiserver build and two web builds: the one that
 *  ships, and the same one with React's profiling renderer, which is what can say how long a commit took. */
function prepare(build) {
  const { tree, rev } = build;
  const done = join(work, `${build.label}.built`);
  if (existsSync(done) && readFileSync(done, 'utf8') === rev) return log(`${build.label}: reusing the build of ${rev}`);
  if (!existsSync(tree)) sh('git', ['-C', repo, 'worktree', 'add', '--detach', tree, rev]);
  else sh('git', ['-C', tree, 'checkout', '--detach', rev]);
  const step = (name, cmd, argv, cwd = tree) => {
    log(`${build.label}: ${name}`);
    const file = join(out, `${build.label}-${name}.log`);
    const fd = openSync(file, 'w');
    execFileSync(cmd, argv, { cwd, stdio: ['ignore', fd, fd] });
  };
  step('overlay', 'bash', ['scripts/worktree-overlay.sh']);
  step('shared', 'npm', ['run', 'build', '-w', '@orbit/shared']);
  step('apiserver', 'npm', ['run', 'build', '-w', '@orbit/apiserver']);
  step('web', 'npm', ['run', 'build', '-w', '@orbit/web']);
  const web = join(tree, 'src/web');
  copyFileSync(join(here, 'profiling.vite.config.mjs'), join(web, 'perf-profiling.vite.config.mjs'));
  const vite = createRequire(join(web, 'package.json')).resolve('vite/package.json');
  step('web-profiling', 'node', [join(dirname(vite), 'bin/vite.js'), 'build', '--config', 'perf-profiling.vite.config.mjs'], web);
  writeFileSync(done, rev);
}

const started = { containers: [], processes: [] };
function cleanup() {
  for (const child of started.processes) child.kill('SIGKILL');
  for (const name of started.containers) {
    try { sh('docker', ['rm', '-f', '-v', name]); } catch { /* already gone */ }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const tag = `slsperf-${process.pid}`;
const secrets = { jwt: randomBytes(32).toString('base64'), provider: randomBytes(32).toString('base64') };
const account = { email: 'owner@session-list-scale.invalid', password: randomBytes(12).toString('hex'), name: 'Scale owner' };

async function startPostgres() {
  const name = `${tag}-pg`;
  started.containers.push(name);
  sh('docker', ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=orbit', '-e', 'POSTGRES_PASSWORD=orbit', '-e', 'POSTGRES_DB=seed',
    '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', 'postgres:16-alpine']);
  const port = sh('docker', ['port', name, '5432/tcp']).split(':').at(-1);
  for (let i = 0; ; i += 1) {
    // Over TCP: the image's init server answers on the socket before the real one listens.
    try { sh('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'orbit']); break; } catch (error) { if (i > 120) throw error; await sleep(500); }
  }
  const url = (db) => `postgresql://orbit:orbit@127.0.0.1:${port}/${db}?schema=public`;
  const psql = (sql, db = 'seed') => sh('docker', ['exec', name, 'psql', '-h', '127.0.0.1', '-U', 'orbit', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  return { url, psql };
}

async function startApiserver(build, databaseUrl, name) {
  const port = await freePort();
  const files = join(work, `files-${name}`);
  mkdirSync(files, { recursive: true });
  const fd = openSync(join(out, `${name}-apiserver.log`), 'w');
  const child = spawn('node', ['dist/main.js'], {
    cwd: join(build.tree, 'src/apiserver'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DATABASE_URL: databaseUrl, PORT: String(port),
      JWT_SECRET: secrets.jwt, PROVIDER_SECRET_KEY: secrets.provider, ORBIT_FILES_DIR: files,
    },
    stdio: ['ignore', fd, fd],
  });
  started.processes.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i += 1) {
    if (child.exitCode !== null) throw new Error(`${name}: the apiserver exited with ${child.exitCode}`);
    try { if ((await fetch(`${base}/api/auth/setup-status`)).ok) break; } catch { /* not listening yet */ }
    if (i > 240) throw new Error(`${name}: the apiserver did not answer`);
    await sleep(500);
  }
  return { base, port, stop: () => new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); }) };
}

/** nginx as the web image runs it (src/web/nginx.conf), with the compression the gateway in front of it does. */
async function startWeb(build, dist, apiPort, name) {
  const port = await freePort();
  const dir = join(work, `nginx-${name}`);
  mkdirSync(dir, { recursive: true });
  const conf = readFileSync(join(build.tree, 'src/web/nginx.conf'), 'utf8')
    .replaceAll('apiserver:3000', `127.0.0.1:${apiPort}`)
    .replace(/^\s*listen\s+\[::\]:80;\n/m, '')
    .replace(/^(\s*)listen 80;/m, `$1listen 127.0.0.1:${port};`);
  const gzip = readFileSync(join(build.tree, 'gateway/nginx.conf'), 'utf8').match(/^ *gzip on;[\s\S]*?gzip_types[\s\S]*?;/m)[0];
  writeFileSync(join(dir, 'default.conf'), conf);
  writeFileSync(join(dir, '00-gzip.conf'), gzip);
  const container = `${tag}-web-${name}`;
  started.containers.push(container);
  sh('docker', ['run', '-d', '--name', container, '--network', 'host', '-v', `${dir}:/etc/nginx/conf.d:ro`,
    '-v', `${join(build.tree, 'src/web', dist)}:/usr/share/nginx/html:ro`, 'nginx:alpine']);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return base; } catch { /* starting */ }
    if (i > 60) throw new Error(`${name}: nginx did not answer\n${sh('docker', ['logs', container])}`);
    await sleep(250);
  }
}

async function signIn(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!res.ok) throw new Error(`sign-in answered ${res.status}: ${await res.text()}`);
  return res.json();
}

try {
  for (const build of builds) prepare(build);
  // One database serves both builds only if they agree on its schema.
  sh('git', ['-C', repo, 'diff', '--quiet', builds[0].rev, builds[1].rev, '--', 'src/apiserver/prisma']);

  log('postgres: migrate and seed');
  const pg = await startPostgres();
  const [before] = builds;
  const api = join(before.tree, 'src/apiserver');
  const prisma = createRequire(join(api, 'package.json')).resolve('prisma/package.json');
  sh('node', [join(dirname(prisma), 'build/index.js'), 'migrate', 'deploy'], { cwd: api, env: { ...process.env, DATABASE_URL: pg.url('seed') } });
  const seeding = await startApiserver(before, pg.url('seed'), 'seed');
  const bootstrap = await fetch(`${seeding.base}/api/auth/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
  });
  if (!bootstrap.ok) throw new Error(`bootstrap answered ${bootstrap.status}: ${await bootstrap.text()}`);
  await seeding.stop();
  sh('node', [join(here, 'seed.mjs'), before.tree, pg.url('seed'), account.email, join(out, 'seed.json')]);
  const facts = JSON.parse(readFileSync(join(out, 'seed.json'), 'utf8'));
  log(`seeded ${JSON.stringify(facts.seed)}`);
  for (const build of builds) pg.psql(`CREATE DATABASE ${build.label} TEMPLATE seed`, 'postgres');

  for (const build of builds) {
    const server = await startApiserver(build, pg.url(build.label), build.label);
    build.web = await startWeb(build, 'dist', server.port, build.label);
    build.profiling = await startWeb(build, 'dist-profiling', server.port, `${build.label}-profiling`);
  }
  // The seeded runner stays online, as a connected one would.
  const beat = () => {
    for (const build of builds) {
      pg.psql(`INSERT INTO runner_presence (runner_id, last_beat_at, link_state) SELECT id, now() AT TIME ZONE 'utc', 'HTTP' FROM runner
        ON CONFLICT (runner_id) DO UPDATE SET last_beat_at = EXCLUDED.last_beat_at`, build.label);
    }
  };
  beat();
  const heartbeat = setInterval(beat, 15_000);

  const { chromium } = createRequire(join(builds[1].tree, 'src/web/package.json'))('@playwright/test');
  const browser = await chromium.launch();
  const results = {
    measuredAt: new Date().toISOString(), seed: facts.seed, chromium: browser.version(), node: process.version,
    builds: Object.fromEntries(builds.map((b) => [b.label, { rev: b.rev, loads: [], frames: {} }])),
  };
  const save = () => writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));

  // One untimed load of each first, so neither build pays for a cold database or server.
  for (const build of builds) await measureLoad(browser, build.web, await signIn(build.web), facts, { scroll: false });
  for (let run = 0; run < Number(args.runs); run += 1) {
    // Alternating, and in turn first, so a change in the host's load falls on both builds alike.
    for (const build of run % 2 ? [...builds].reverse() : builds) {
      const load = await measureLoad(browser, build.web, await signIn(build.web), facts, { scroll: run < 3 });
      results.builds[build.label].loads.push({ ...load, loadavg: loadavg()[0] });
      log(`run ${run + 1} ${build.label}: list interactive ${Math.round(load.interactiveMs)} ms, ${load.listBytes.wire} B on the wire, ${load.mounted.rows} rows`);
      save();
    }
  }
  for (const kind of ['web', 'profiling']) {
    for (const round of [0, 1]) {
      for (const build of round ? [...builds].reverse() : builds) {
        const frames = await measureWatchFrames(browser, build[kind], await signIn(build[kind]), facts, {
          frames: Math.ceil(Number(args.frames) / 2), profiling: kind === 'profiling',
        });
        const held = (results.builds[build.label].frames[kind] ??= { observer: frames.observer, frames: [], rowProbe: [] });
        held.frames.push(...frames.frames.map((f) => ({ ...f, loadavg: loadavg()[0] })));
        held.rowProbe.push(...frames.rowProbe);
        log(`watch frames ${kind} ${build.label}: ${frames.frames.length} measured`);
        save();
      }
    }
  }
  clearInterval(heartbeat);
  await browser.close();
  // The seed is still what was measured: nothing the apiserver does in the background moved a session out of it.
  for (const build of builds) {
    results.builds[build.label].sessionsAfterwards = JSON.parse(pg.psql(
      `SELECT json_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM session GROUP BY status) s`, build.label));
  }
  save();
  const table = report(results, facts);
  writeFileSync(join(out, 'table.md'), table);
  console.log(table);
} finally {
  cleanup();
}
process.exit(0);
