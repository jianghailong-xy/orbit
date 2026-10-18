// Probe: where does the macOS CLI put credentials, for each AGENT_CLI_CREDENTIAL_STORE,
// and does the Keychain entry name change with HOME / CURSOR_CONFIG_DIR / XDG_CONFIG_HOME?
// Uses a DUMMY token (never a real credential); asserts nothing, prints facts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { AcpProcess, Recorder } from '/Users/long/.orbit/worktrees/5ec52a16-7b33-54df-b6c0-d3dced12cf9d/scripts/cursor-p0/lib/acp.mjs';
import { makeSlot, cursorEnv, AGENT } from '/Users/long/.orbit/worktrees/5ec52a16-7b33-54df-b6c0-d3dced12cf9d/scripts/cursor-p0/lib/env.mjs';

const base = '/Users/long/.orbit/cursor-p0/probe/runs-store';
rmSync(base, { recursive: true, force: true });
const DUMMY = 'dummy-token-not-a-credential';

function keychainEntries() {
  const r = spawnSync('security', ['dump-keychain'], { encoding: 'utf8', timeout: 30000 });
  const lines = (r.stdout ?? '').split('\n');
  const flat = [];
  let cur = null;
  for (const l of lines) {
    const sv = l.match(/"svce"<blob>=(.*)/);
    if (sv) { cur = { svce: sv[1] }; flat.push(cur); continue; }
    const ac = l.match(/"acct"<blob>=(.*)/);
    if (ac && cur && !('acct' in cur)) cur.acct = ac[1];
  }
  return flat;
}

function tree(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const visit = (p, rel) => {
    for (const name of readdirSync(p).sort()) {
      const f = join(p, name);
      const r = rel ? rel + '/' + name : name;
      try {
        const st = lstatSync(f);
        if (st.isDirectory()) { out.push(r + '/'); visit(f, r); }
        else out.push(`${r} ${st.size}`);
      } catch { out.push(r); }
    }
  };
  visit(root, '');
  return out;
}

async function runOnce(label, layout, { store, setXdg }) {
  mkdirSync(base, { recursive: true });
  const slot = makeSlot(base, label);
  const env = cursorEnv(slot, { layout, store, apiKey: null });
  if (setXdg) env.XDG_CONFIG_HOME = slot.xdgConfig;
  env.CURSOR_AUTH_TOKEN = DUMMY;
  const rec = new Recorder();
  const p = new AcpProcess({ bin: AGENT, args: ['acp'], env, cwd: slot.home, recorder: rec, label: 'probe' });
  const init = await p.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'orbit-p0-probe', version: '0' } }, 60000);
  const nw = await p.request('session/new', { cwd: slot.home, mcpServers: [] }, 180000);
  p.signal('SIGTERM');
  await p.waitExit(20000);
  const kc = keychainEntries();
  console.log(JSON.stringify({ label, store, setXdg, init: init.error ?? init.result?.protocolVersion, newSession: nw.error ? { code: nw.error.code, msg: nw.error.message } : { ok: true }, keychain: kc, slotTree: { home: tree(slot.home), config: tree(slot.config), data: tree(slot.data), xdgConfig: tree(slot.xdgConfig) }, stderr: p.stderr.slice(0, 400) }, null, 1));
}

console.log('# before');
console.log(JSON.stringify(keychainEntries(), null, 1));
writeFileSync(join(base, '..', 'keychain-before.json'), JSON.stringify(keychainEntries(), null, 1));

await runOnce('default', 'full', { store: undefined });
await runOnce('file', 'full', { store: 'file' });
await runOnce('memory', 'full', { store: 'memory' });
await runOnce('file-xdg', 'xdg', { store: 'file', setXdg: true });
await runOnce('default-xdg', 'xdg', { store: undefined, setXdg: true });
await runOnce('default-nohome-vars', 'config-data', { store: undefined });

console.log('# after');
console.log(JSON.stringify(keychainEntries(), null, 1));
writeFileSync(join(base, '..', 'keychain-after.json'), JSON.stringify(keychainEntries(), null, 1));
