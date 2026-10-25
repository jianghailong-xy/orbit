// P0b follow-up (macOS): the CLI's default credential store under a FOREIGN HOME is unstable
// (contract §18.4, three modes: fast file fallback / 30 s keychain timeout / both). With the
// owner's real key available, repeat default-store session/new under a foreign HOME and record
// which mode each repetition takes: duration, whether a `security` child ran, whether auth.json
// was written, and the CLI's stderr. A GUI SecurityAgent dialog may appear; the probe kills
// SecurityAgent between repetitions to dismiss it. Results go to $P0_ROOT/probe/ (scratch); the
// printed summary is redacted (the key is registered with the Redactor, never printed).
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { AcpProcess, Recorder } from '../lib/acp.mjs';
import { makeSlot, AGENT, P0_ROOT, readApiKey } from '../lib/env.mjs';
import { Redactor } from '../lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const key = readApiKey();
if (!key) { console.error('no Cursor API key at the configured key file'); process.exit(2); }
const red = new Redactor().secret(key, 'CURSOR_API_KEY').path(join(here, '..', '..'), '<SCRIPTS>').path(P0_ROOT, '<P0_ROOT>');

const base = join(P0_ROOT, 'probe', 'keychain-default-mode');
const rec = new Recorder();

async function oneRun(label, extra = {}) {
  const slot = makeSlot(join(base, 'runs'), label.replace(/\W+/g, '-'));
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_OPEN_BROWSER: '1',
    HOME: slot.home, CURSOR_CONFIG_DIR: slot.config, CURSOR_DATA_DIR: slot.data, CURSOR_API_KEY: key, ...extra };
  const p = new AcpProcess({ bin: AGENT, args: ['acp'], env, cwd: slot.home, recorder: rec, label });
  const secs = [];
  const sampler = setInterval(() => {
    const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 });
    for (const l of (r.stdout ?? '').split('\n')) {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m && Number(m[2]) === p.pid && /security/.test(m[3])) secs.push(m[3].replace(/-w \S+/, '-w <REDACTED>').trim().slice(0, 90));
    }
  }, 300);
  const t0 = Date.now();
  await p.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'orbit-p0-probe', version: '0' } }, 60000);
  const nw = await p.request('session/new', { cwd: slot.home, mcpServers: [] }, 45000);
  const ms = Date.now() - t0;
  clearInterval(sampler);
  const authJson = existsSync(join(slot.home, '.cursor', 'auth.json'));
  p.signal('SIGTERM');
  await p.waitExit(15000);
  spawnSync('/usr/bin/killall', ['SecurityAgent'], { timeout: 8000, stdio: 'ignore' }); // dismiss any dialog this run raised
  return { label, ms, newOk: !!nw.result, newErr: nw.error ? { code: nw.error.code, message: nw.error.message } : null,
    securityChildren: [...new Set(secs)], authJsonWritten: authJson,
    stderr: p.stderr.split('\n').filter(Boolean).slice(-4).map(l => l.slice(0, 140)) };
}

mkdirSync(base, { recursive: true });
const results = [];
for (const [label, extra] of [['foreign-home', {}], ['foreign-home-2', {}], ['foreign-home-3', {}], ['foreign-home+ASSUME_SSH', { CURSOR_ASSUME_SSH: '1' }]]) {
  results.push(await oneRun(label, extra));
}
// Whatever the runs wrote to the real login keychain, take it back out (the dialog-killed writes
// normally land nothing; this is the belt-and-braces pass before touching the real keychain again).
for (const svce of ['cursor-access-token', 'cursor-refresh-token', 'cursor-api-key', 'cursor-bedrock-access-key', 'cursor-bedrock-secret-key', 'cursor-bedrock-session-token']) {
  spawnSync('/usr/bin/security', ['delete-generic-password', '-a', 'cursor-user', '-s', svce], { timeout: 15000, stdio: 'ignore' });
}
const summary = red.value({ at: new Date().toISOString(), cli: AGENT, runs: results });
console.log(JSON.stringify(summary, null, 1));
writeFileSync(join(base, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
