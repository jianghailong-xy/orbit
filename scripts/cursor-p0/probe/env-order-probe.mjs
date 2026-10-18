// Probe: the macOS default credential store's behavior is UNSTABLE in headless/foreign-HOME runs
// (measured 2026-10-17 on orbit-macos, macOS 27.0.1, pinned CLI). The same variable set can yield:
//   mode 1: initialize ~0.4-1.4 s, no `security` child, token persisted to $HOME/.cursor/auth.json
//   mode 2: initialize stalls ~30 s (keychain save timeout), "Cursor couldn't save your
//           credentials / The keychain item is stuck" on stderr, nothing persisted
//   mode 3: the 30 s stall and warning, AND auth.json written anyway
// No stable trigger was found (variable set, environ order, HOME path and dialog state were all
// controlled). See contract §18.4. Uses a DUMMY token (never a real credential).
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { AcpProcess, Recorder } from '../lib/acp.mjs';
import { AGENT } from '../lib/env.mjs';

const DUMMY = 'dummy-token-not-a-credential';
const base = '/tmp/cursor-p0-env-order-probe';

async function run(tag, env) {
  rmSync(`${base}/${tag}/.cursor`, { recursive: true, force: true });
  mkdirSync(`${base}/${tag}`, { recursive: true });
  const rec = new Recorder();
  const p = new AcpProcess({ bin: AGENT, args: ['acp'], env, cwd: env.HOME, recorder: rec, label: tag });
  const t0 = Date.now();
  const init = await p.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'probe', version: '0' } }, 90000);
  const ms = Date.now() - t0;
  p.signal('SIGTERM');
  await p.waitExit(20000);
  const auth = existsSync(`${env.HOME}/.cursor/auth.json`);
  console.log(JSON.stringify({ tag, initMs: ms, initOk: !!init.result, authJsonWritten: auth, keychainTimeoutWarning: /couldn't save/.test(p.stderr), stderrTail: p.stderr.trim().slice(-140) }));
}

for (let i = 1; i <= 4; i++) {
  const home = `${base}/run-${i}-home`;
  mkdirSync(home, { recursive: true });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_OPEN_BROWSER: '1', CURSOR_AUTH_TOKEN: DUMMY, HOME: home };
  await run(`run-${i}`, env);
}
