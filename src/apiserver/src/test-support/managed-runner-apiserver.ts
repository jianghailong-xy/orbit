import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { call, type Apiserver } from '../auth/pat-test-apiserver';

/**
 * The production apiserver for the managed runner pg specs: `node build/main.js` with a scrubbed
 * environment — nothing inherited but PATH, so no ORBIT_* or provider variable, no KUBECONFIG and
 * no in-cluster variable unless a case sets one — scratch HOME, ORBIT_HOME, CODEX_HOME and
 * CLAUDE_CONFIG_DIR, and the tripwire below preloaded.
 */

/** build/test-support → build/main.js. */
const MAIN = path.resolve(__dirname, '..', 'main.js');
const API_DIR = path.resolve(__dirname, '..', '..');

/**
 * Preloaded with `--require`. Records, one line each, to $MANAGED_RUNNER_TRIPWIRE_LOG:
 *   - any construction or use of the Kubernetes client: its factory, its class, its HTTPS
 *     transport and its watch stream, replaced on the real module as it loads;
 *   - any attempt to read a kubeconfig or in-cluster credential path, whether or not it exists, or
 *     anything under $MANAGED_RUNNER_TRIPWIRE_DECOYS (a case's decoy profile and kubeconfig);
 *   - any timer created by managed runner code.
 * And to <log>.armed, that it was preloaded and that it found and armed the real client module —
 * an empty log from a tripwire that never loaded would prove nothing.
 */
export const MANAGED_RUNNER_TRIPWIRE = String.raw`'use strict';
const fs = require('fs');
const Module = require('module');
const LOG = process.env.MANAGED_RUNNER_TRIPWIRE_LOG;
const append = fs.appendFileSync;
const trip = (what) => append(LOG, what + '\n');
const armed = (what) => append(LOG + '.armed', what + '\n');
armed('preload ' + process.pid);

const KUBE = /(^|[\\/])\.kube([\\/]|$)|kubeconfig|[\\/]var[\\/]run[\\/]secrets[\\/]kubernetes\.io/i;
// And anything under a directory a case names: its decoy profile and kubeconfig.
const DECOYS = process.env.MANAGED_RUNNER_TRIPWIRE_DECOYS || '';
const watched = (said) => KUBE.test(said) || (DECOYS !== '' && said.startsWith(DECOYS));
const watch = (owner, name, label) => {
  const original = owner[name];
  if (typeof original !== 'function') return;
  owner[name] = function (target, ...rest) {
    const said = typeof target === 'string' ? target : target instanceof URL ? target.pathname : '';
    if (said && watched(said)) trip(label + '.' + name + ' ' + said);
    return original.call(this, target, ...rest);
  };
};
for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'existsSync', 'statSync', 'stat', 'lstatSync', 'accessSync', 'access', 'createReadStream', 'readdirSync'])
  watch(fs, name, 'fs');
for (const name of ['readFile', 'open', 'stat', 'access', 'readdir']) watch(fs.promises, name, 'fs.promises');

const load = Module._load;
Module._load = function (request, parent, isMain) {
  const exported = load.apply(this, arguments);
  if (/(^|[\\/])kube-http-client(\.js)?$/.test(request) && exported && !exported.__orbitTripwire) {
    exported.__orbitTripwire = true;
    exported.kubeClientFromProfile = () => { trip('kubeClientFromProfile'); throw new Error('tripwire: Kubernetes client constructed'); };
    exported.KubeHttpClient = new Proxy(exported.KubeHttpClient, { construct() { trip('new KubeHttpClient'); throw new Error('tripwire'); } });
    exported.httpsTransport.request = () => { trip('Kubernetes request'); throw new Error('tripwire'); };
    exported.httpsTransport.stream = () => { trip('Kubernetes watch'); throw new Error('tripwire'); };
    armed('kube-http-client ' + request);
  }
  return exported;
};

for (const name of ['setTimeout', 'setInterval']) {
  const original = global[name];
  global[name] = function (...args) {
    const frame = (new Error().stack || '').split('\n').slice(2).find((l) => /managed-runners[\\/][^\\/]+\.js/.test(l));
    if (frame) trip(name + ' ' + frame.trim());
    return original.apply(this, args);
  };
}
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface ScrubbedApiserver extends Apiserver {
  /** What the tripwire recorded: must be empty. */
  tripped(): string;
  /** What the tripwire recorded about itself: that it loaded, and armed the client module. */
  armed(): string;
}

/**
 * Boot the production apiserver under `scratch/label` with only `env` (and PATH): its own scratch
 * homes and tripwire log. Resolves once it answers.
 */
export async function bootScrubbedApiserver(
  scratch: string,
  label: string,
  env: { DATABASE_URL: string; JWT_SECRET: string } & NodeJS.ProcessEnv,
): Promise<ScrubbedApiserver> {
  const dir = path.join(scratch, label);
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const preload = path.join(dir, 'tripwire.cjs');
  writeFileSync(preload, MANAGED_RUNNER_TRIPWIRE);
  const tripLog = path.join(dir, 'tripwire.log');
  writeFileSync(tripLog, '');
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, [MAIN], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH,
      NO_COLOR: '1',
      PORT: String(port),
      CORS_ORIGINS: 'http://127.0.0.1',
      HOME: home,
      ORBIT_HOME: path.join(home, '.orbit'),
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      TMPDIR: dir,
      NODE_OPTIONS: `--require ${preload}`,
      MANAGED_RUNNER_TRIPWIRE_LOG: tripLog,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => void (log = (log + chunk.toString('utf8')).slice(-400_000));
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const server: ScrubbedApiserver = {
    port,
    child,
    output: () => log,
    tripped: () => readFileSync(tripLog, 'utf8'),
    armed: () => readFileSync(`${tripLog}.armed`, 'utf8'),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`the apiserver exited ${child.exitCode} before answering:\n${log.slice(-6_000)}`);
    const reply = await call(server, 'GET', '/api/auth/setup-status').catch(() => null);
    if (reply?.status === 200) return server;
    if (Date.now() > deadline) assert.fail(`the apiserver did not answer within 150s:\n${log.slice(-6_000)}`);
    await sleep(250);
  }
}

/** The checks every scrubbed boot ends with: armed on the real module, and nothing tripped. */
export function assertTripwireQuiet(server: ScrubbedApiserver, label: string): void {
  assert.match(server.armed(), /^preload \d+$/m, `${label}: the tripwire was preloaded`);
  assert.match(server.armed(), /^kube-http-client /m, `${label}: and armed on the real Kubernetes client module`);
  assert.equal(server.tripped(), '', `${label}: no Kubernetes client, kubeconfig read or managed timer`);
}
