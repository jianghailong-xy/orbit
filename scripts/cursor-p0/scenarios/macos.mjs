// darwin-only scenarios (P0b): Keychain entry names and their invariance, quarantine attributes on
// the launch path, and keychain behavior in a launchd session (the way a runner service runs).
// `security` resolves the user's keychain via $HOME: with a foreign HOME (D4 option A's account
// home) keychain writes prompt a GUI dialog or hang headless, and the CLI's own startup probe
// turns that into "Your macOS login keychain is locked" (exit 1) when it believes it is in an SSH
// session (darwin + likelySshSession + default store, keychain-check.ts).
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, chmodSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sleep, REAL_CURSOR_DIRS } from '../lib/harness.mjs';
import { AGENT, CLI_DIR, VERSION, P0_ROOT } from '../lib/env.mjs';

const NODE = process.execPath;

// Relative path lists of the runner user's real Cursor dirs (which entries exist, not their content).
function realCursorPathList() {
  const out = {};
  for (const dir of REAL_CURSOR_DIRS) {
    const paths = [];
    const collect = (d, rel) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d).sort()) {
        const f = join(d, name), r = rel ? rel + '/' + name : name;
        paths.push(r);
        try { if (lstatSync(f).isDirectory()) collect(f, r); } catch {}
      }
    };
    collect(dir, '');
    out[dir] = paths;
  }
  return out;
}

// Delete every path under the real Cursor dirs that is not in `before` (deepest first) — the undo
// for a real-HOME run's writes (agent-cli-state.json, synced skills, ai-tracking db, …).
function restoreRealCursorState(before) {
  for (const dir of REAL_CURSOR_DIRS) {
    const keep = new Set(before[dir] ?? []);
    const removed = [];
    const collect = (d, rel) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d)) {
        const f = join(d, name), r = rel ? rel + '/' + name : name;
        try { if (lstatSync(f).isDirectory()) collect(f, r); } catch {}
        if (!keep.has(r)) removed.push(f);
      }
    };
    collect(dir, '');
    for (const f of removed.sort((a, b) => b.length - a.length)) {
      try { lstatSync(f).isDirectory() ? rmSync(f, { recursive: true, force: true }) : rmSync(f, { force: true }); } catch {}
    }
    if (existsSync(dir) && readdirSync(dir).length === 0) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

// svce/acct pairs of generic passwords, as `security dump-keychain` reports them (login keychain first).
// The dump prints each item as a block that starts with a `keychain:` header line; svce/acct are paired
// per block. (P0b's first version walked lines across item boundaries and mis-paired an svce with the
// next item's acct — an unrelated network-password item whose acct is the hex blob 0xE697A0… "no user
// account" looked like a cursor-api-key entry.)
function keychainGenericPairs() {
  const r = spawnSync('/usr/bin/security', ['dump-keychain'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const unq = s => (/^"(.*)"$/.test(s) ? s.slice(1, -1) : s);
  const out = [];
  for (const block of (r.stdout ?? '').split(/\n(?=keychain:)/)) {
    if (!/class: "genp"/.test(block)) continue;
    const sv = block.match(/"svce"<blob>=(.*)/);
    const ac = block.match(/"acct"<blob>=(.*)/);
    if (sv) out.push({ svce: unq(sv[1]), ...(ac ? { acct: unq(ac[1]) } : {}) });
  }
  return out;
}

const cursorPairs = pairs => pairs.filter(p => p.svce?.startsWith('cursor-')).map(p => p.svce);

function deleteCursorEntries() {
  for (const svce of ['cursor-access-token', 'cursor-refresh-token', 'cursor-api-key', 'cursor-bedrock-access-key', 'cursor-bedrock-secret-key', 'cursor-bedrock-session-token']) {
    // By service only (no -a): whatever account the CLI wrote the entry under is what gets removed.
    spawnSync('/usr/bin/security', ['delete-generic-password', '-s', svce], { timeout: 15000, stdio: 'ignore' });
  }
}

export const macos = [
  {
    // What the default (Keychain) store writes, and that the entry names are constants — the
    // credential manager is constructed with domain:"cursor" (index.js main), so every account on
    // the machine shares one entry set. Requires a valid key: session/new must succeed for the CLI
    // to save the exchanged tokens. `security` resolves the keychain via $HOME, so these runs use
    // the real HOME (a foreign HOME makes the write prompt/hang; measured below and in
    // macos-launchd-keychain) and restore the real ~/.cursor state they touched.
    name: 'macos-keychain-store', real: 0,
    async run(ctx) {
      const work = ctx.repo('work');
      const home = process.env.HOME;
      const beforeAll = keychainGenericPairs();
      const before = cursorPairs(beforeAll);
      ctx.check('no leftover cursor-* entries in the login keychain before the run', before.length === 0, before);
      const realBefore = realCursorPathList();
      const added = [];
      for (const label of ['config-A', 'config-B']) {
        const slot = ctx.slot(label);
        const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_OPEN_BROWSER: '1', HOME: home,
          CURSOR_CONFIG_DIR: slot.config, CURSOR_DATA_DIR: slot.data, CURSOR_API_KEY: ctx.key };
        if (label === 'config-B') env.XDG_CONFIG_HOME = slot.xdgConfig;
        const p = ctx.acp({ slot, cwd: work, label: `acp-${label}`, env }); // store unset = default = Keychain on macOS
        await ctx.initialize(p);
        const t0 = Date.now();
        const n = await ctx.newSession(p, work);
        ctx.note(`${label} session/new ms`, Date.now() - t0);
        ctx.check(`${label}: session/new succeeds with the default store`, !!n.result?.sessionId, n.error);
        await p.dispose();
        const allNow = keychainGenericPairs();
        const newEntries = allNow.filter(p => !beforeAll.some(b => b.svce === p.svce && b.acct === p.acct));
        added.push(newEntries.filter(p => p.svce?.startsWith('cursor-')).map(p => p.svce).sort());
        ctx.note(`${label} new keychain entries during the run`, newEntries);
        ctx.check(`${label}: the Keychain gets the three token entries (account cursor-user) and nothing else with a cursor-* name`,
          JSON.stringify(added[added.length - 1]) === '["cursor-access-token","cursor-api-key","cursor-refresh-token"]' && newEntries.filter(p => p.svce?.startsWith('cursor-')).every(p => p.acct === 'cursor-user'), newEntries);
        ctx.check(`${label}: no auth.json is written (that is the file store)`, !existsSync(join(home, '.cursor', 'auth.json')) && !existsSync(join(slot.home, '.cursor', 'auth.json')));
        ctx.check(`${label}: the status command sees the saved login`, JSON.parse(ctx.cli(slot, ['status', '--format', 'json'], { envOpts: { store: null, extra: { HOME: home } } }).stdout || 'null').isAuthenticated === true);
        ctx.note(`${label} slot tree (any other place the key could have landed)`, ctx.tree(slot.root).filter(l => /home\/\.cursor\//.test(l)));
      }
      ctx.check('the entry names do not change with CURSOR_CONFIG_DIR / XDG_CONFIG_HOME (both runs wrote the same set)', JSON.stringify(added[0]) === JSON.stringify(added[1]) && added[0].length === 3, added);
      // The flip side: `security` is keyed to $HOME, so under a foreign HOME (D4 option A's account
      // home) the keychain write would hang on a GUI dialog instead of completing.
      const foreign = ctx.slot('foreign-home');
      const r = spawnSync('/usr/bin/security', ['add-generic-password', '-a', 'p0-foreign-home-probe', '-s', 'p0-foreign-home-probe', '-w', 'probe', '-U'],
        { env: { PATH: '/usr/bin:/bin', HOME: foreign.home }, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      ctx.check('a keychain write under a foreign HOME hangs (GUI dialog) instead of completing', r.signal === 'SIGTERM' || (r.error && /timed out|ETIMEDOUT/i.test(String(r.error))), { status: r.status, signal: r.signal, err: String(r.error ?? r.stderr).slice(0, 120) });
      deleteCursorEntries();
      const after = cursorPairs(keychainGenericPairs());
      ctx.check('cleanup removed the entries the scenario created', after.length === 0, after);
      // Restore the real ~/.cursor state the real-HOME runs touched (agent-cli-state.json, synced
      // skills, the ai-tracking db): delete whatever appeared, keep whatever was there before.
      restoreRealCursorState(realBefore);
      ctx.note('keychain entries seen', { before, added, after, realCursorDirsRestored: JSON.stringify(realBefore) === JSON.stringify(realCursorPathList()) });
    },
  },
  {
    // What quarantine attributes do to the launch path. curl + tar leaves no quarantine attribute
    // (only com.apple.provenance); even stamped with one, the launch path (bash script -> Developer
    // ID signed node) still runs. A bare unsigned Mach-O under quarantine is blocked (hangs on the
    // Gatekeeper assessment that nobody can answer headless), while the same binary without the
    // attribute runs — so the runner's curl+tar install is safe by construction, but a
    // Safari-downloaded + auto-extracted copy would break the CLI's unsigned components.
    name: 'macos-quarantine', real: 0, needsKey: false,
    async run(ctx) {
      const src = join(ctx.dir, 'quarantined-cli');
      cpSync(CLI_DIR, src, { recursive: true });
      chmodSync(src, 0o755);
      spawnSync('chmod', ['-R', 'u+w', src]);
      const stamp = file => spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;69e2b4c1;Safari;7B4C1D2E-0000-0000-0000-000000000000', file]);
      const unquarantine = file => spawnSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', file]);
      const attr = f => spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', f], { encoding: 'utf8' }).stdout.trim();
      ctx.note('attributes on the curl-downloaded tarball', { tarballQuarantine: (() => { const r = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', join(P0_ROOT, 'dl', VERSION, 'agent-cli-package.tar.gz')], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })(), tarballProvenance: (() => { const r = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.provenance', join(P0_ROOT, 'dl', VERSION, 'agent-cli-package.tar.gz')], { encoding: 'utf8' }); return r.status === 0 ? 'set' : null; })() });
      // The CLI's own launch path, fully quarantined: the bash launcher and the signed node it execs.
      stamp(join(src, 'cursor-agent'));
      stamp(join(src, 'node'));
      const v = spawnSync(join(src, 'cursor-agent'), ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: join(ctx.dir, 'q-home') }, encoding: 'utf8', timeout: 60000 });
      ctx.check('the CLI runs under a stamped quarantine attribute (launcher + node are not assessed as apps)', v.status === 0 && v.stdout.trim() === VERSION, { status: v.status, signal: v.signal, out: v.stdout.trim(), err: v.stderr.trim().slice(0, 120), quarantine: attr(join(src, 'node')) });
      // A bare unsigned Mach-O: the behavior that would hit the CLI's unsigned components (cursor-agent-sea …).
      const cc = existsSync('/usr/bin/cc') ? '/usr/bin/cc' : null;
      const tiny = join(ctx.dir, 'tiny');
      const srcFile = join(ctx.dir, 'tiny.c');
      if (cc) {
        writeFileSync(srcFile, '#include <stdio.h>\nint main(void){ printf("unsigned binary ran\\n"); return 0; }\n');
        const built = spawnSync(cc, ['-o', tiny, srcFile], { encoding: 'utf8' });
        ctx.check('an unsigned bare Mach-O compiles and runs without quarantine', built.status === 0 && spawnSync(tiny, [], { encoding: 'utf8', timeout: 15000 }).stdout.includes('unsigned binary ran'));
        stamp(tiny);
        const run1 = spawnSync(tiny, [], { encoding: 'utf8', timeout: 15000 });
        ctx.check('the same binary with a stamped quarantine attribute still runs (exec-level Gatekeeper does not block bare Mach-O on macOS 27)', run1.status === 0 && run1.stdout.includes('unsigned binary ran'), { status: run1.status, signal: run1.signal });
        ctx.note('one-off observation (not reproduced)', '2026-10-17 ~01:08Z the FIRST quarantined unsigned binary executed on this machine hung for 2.5 min (state S, 0 CPU) until killed; every later attempt, with fresh UUIDs and fresh binaries, ran instantly. Consistent with a cold first assessment in syspolicyd (the machine had never assessed anything since boot).');
        unquarantine(tiny);
        ctx.check('removing the attribute also runs (the attribute is irrelevant either way)', spawnSync(tiny, [], { encoding: 'utf8', timeout: 15000 }).stdout.includes('unsigned binary ran'));
      } else {
        ctx.check('an unsigned bare Mach-O compiles and runs without quarantine', true, 'skipped: no /usr/bin/cc on this host', true);
        ctx.check('the same binary with a stamped quarantine attribute still runs (exec-level Gatekeeper does not block bare Mach-O on macOS 27)', true, 'skipped: no /usr/bin/cc on this host', true);
        ctx.check('removing the attribute also runs (the attribute is irrelevant either way)', true, 'skipped: no /usr/bin/cc on this host', true);
      }
      ctx.note('xattr state after the run', { launcher: attr(join(src, 'cursor-agent')) || null, node: attr(join(src, 'node')) || null });
    },
  },
  {
    // Keychain access from a launchd job (the way a runner service runs), Aqua login session:
    // identical to a plain shell — real HOME works, a foreign HOME prompts/hangs, and the CLI's
    // startup probe (SSH-assumed + default store) converts the hang into exit 1 "keychain locked".
    name: 'macos-launchd-keychain', real: 0, needsKey: false,
    async run(ctx) {
      const job = join(ctx.dir, 'job.sh');
      const outFile = join(ctx.dir, 'job.out');
      const node = NODE;
      writeFileSync(job, `#!/bin/bash
exec > '${outFile}' 2>&1
'${node}' -e '
const {spawnSync}=require("node:child_process");
const item="p0-launchd-probe";
for (const [name, env] of [
  ["security-add+real-HOME", {PATH:"/usr/bin:/bin", HOME:process.env.HOME}],
  ["security-add+bogus-HOME", {PATH:"/usr/bin:/bin", HOME:"${ctx.dir}/bogus-home"}],
]) {
  const t0=Date.now();
  const r=spawnSync("/usr/bin/security",["add-generic-password","-a",item,"-s",item,"-w","probe","-U"],{env,timeout:8000,stdio:["ignore","pipe","pipe"],encoding:"utf8"});
  console.log(name.padEnd(28), "exit=" + (r.signal?"signal "+r.signal:r.status), "ms=" + (Date.now()-t0));
  if (!r.signal) spawnSync("/usr/bin/security",["delete-generic-password","-a",item,"-s",item],{timeout:8000,stdio:"ignore"});
}
const CLI="${AGENT}";
for (const [name, env] of [
  ["cli-probe+real-HOME", {PATH:"/usr/bin:/bin", HOME:process.env.HOME, CURSOR_ASSUME_SSH:"1", NO_OPEN_BROWSER:"1"}],
  ["cli-probe+bogus-HOME", {PATH:"/usr/bin:/bin", HOME:"${ctx.dir}/bogus-home", CURSOR_ASSUME_SSH:"1", NO_OPEN_BROWSER:"1"}],
]) {
  const t0=Date.now();
  const r=spawnSync(CLI,["--version"],{env,timeout:15000,stdio:["ignore","pipe","pipe"],encoding:"utf8"});
  console.log(name.padEnd(28), "exit=" + (r.signal?"signal "+r.signal:r.status), "ms=" + (Date.now()-t0), "err=" + (r.stderr??"").trim().slice(0,100).replace(/\\n/g," | "));
}
'
echo "== job done"
`);
      chmodSync(job, 0o755);
      const plist = join(ctx.dir, 'job.plist');
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.orbit.p0b.${ctx.runId}.kc</string>
<key>ProgramArguments</key><array><string>${job}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`);
      mkdirSync(join(ctx.dir, 'bogus-home'), { recursive: true });
      const label = `com.orbit.p0b.${ctx.runId}.kc`;
      // The job runs the CLI with the real HOME (that is the point of the test); snapshot the real
      // ~/.cursor before and restore it after, exactly like macos-keychain-store does.
      const realBefore = realCursorPathList();
      const boot = spawnSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { encoding: 'utf8' });
      const booted = boot.status === 0;
      if (!booted) {
        ctx.check('a launchd job in the Aqua login session runs the probe', false, { bootstrapError: boot.stderr.trim() });
        return;
      }
      await sleep(20000);
      spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
      spawnSync('/usr/bin/killall', ['SecurityAgent']); // dismiss the dialog the bogus-HOME probe raised
      const out = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '(no output)';
      ctx.note('launchd job output', out);
      ctx.check('in a launchd Aqua session a keychain write with the real HOME completes', /security-add\+real-HOME\s+exit=0/.test(out));
      ctx.check('…and with a foreign HOME it hangs (the dialog appears on the GUI console)', /security-add\+bogus-HOME\s+exit=signal SIGTERM/.test(out));
      ctx.check('the CLI startup probe (SSH-assumed, default store) passes with the real HOME', /cli-probe\+real-HOME\s+exit=0/.test(out));
      ctx.check('…and with a foreign HOME the CLI exits 1 "Your macOS login keychain is locked"', /cli-probe\+bogus-HOME\s+exit=1/.test(out) && /keychain is locked/.test(out));
      restoreRealCursorState(realBefore);
      ctx.note('real cursor dirs restored', JSON.stringify(realBefore) === JSON.stringify(realCursorPathList()));
    },
  },
];
