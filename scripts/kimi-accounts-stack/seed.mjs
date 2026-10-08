// Seeds the Kimi-accounts stack through its real API (fresh database): the owner, two runners and a workspace on
// each, and writes accounts.json (0600) and seed.json.
//   hpc-kimi : the checkout's runner (`orbit`), Default Kimi signed in on kimi.ai as default@kimi.ai
//   old-kimi : the same source without the kimi-account-* capabilities (`orbit-nocap`), Default on kimi.com
// Each Default is signed in the way somebody at that machine would: `kimi login` (the fake CLI) in the runner's
// own environment, before the runner starts.
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { S, call, HttpError, note, logTo, stack, until, saveSeed } from './lib.mjs';

logTo(`${S}/logs/seed.log`);
const OWNER = { email: 'owner@kimi-int.test', name: 'Kimi Int Owner', password: randomBytes(18).toString('base64url') };
let boot;
try {
  boot = await call('POST', '/auth/bootstrap', undefined, OWNER);
} catch (e) {
  if (e instanceof HttpError && e.status === 409) { console.error('already seeded'); process.exit(1); }
  throw e;
}
writeFileSync(`${S}/accounts.json`, JSON.stringify({ owner: { ...OWNER, id: boot.user.id } }, null, 2) + '\n', { mode: 0o600 });
chmodSync(`${S}/accounts.json`, 0o600);
const T = boot.accessToken;
const seed = { owner: { id: boot.user.id, email: OWNER.email }, runners: {}, workspaces: {} };

// hpc-kimi's Default is issued a 4-minute access token (every other token lives a day): it expires mid-run, and
// the runner has to refresh it — under Kimi's own lock, on the account's site — to keep reading its quota.
for (const [name, bin, region, user, ttl] of [
  ['hpc-kimi', 'orbit', 'global', 'default@kimi.ai', '240'],
  ['old-kimi', 'orbit-nocap', 'mainland-cn', 'old-default@kimi.com', ''],
]) {
  const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: name });
  note(stack('register', name, bin, enroll.token).trim());
  note(stack('default-login', name, region, user, ...(ttl ? [ttl] : [])).trim());
  note(stack('start', name).trim());
  const runner = await until(`runner ${name} online`, async () => (await call('GET', '/runners', T, undefined, { quiet: true })).find((r) => r.name === name && r.online));
  // the engine report comes a beat after the runner is online
  const kimi = await until(`runner ${name} to report Kimi signed in`, async () => {
    const r = await call('GET', `/runners/${runner.id}`, T, undefined, { quiet: true });
    return r.engines?.find((e) => e.engine === 'kimi' && e.auth === 'yes' && e.accounts?.length) ?? null;
  }, { timeoutMs: 180_000, everyMs: 2000 });
  note(`${name} engines[kimi]:`, kimi);
  seed.runners[name] = { id: runner.id, bin, defaultRegion: region, defaultUser: user };
  const ws = await call('POST', '/workspaces', T, {
    name: `${name}-ws`, description: `Sandbox repo on ${name} (fake kimi only)`, runnerId: runner.id,
    workDir: `${S}/runners/${name}/work`, enableWorktree: false, defaultMergeTarget: 'main',
  });
  seed.workspaces[name] = { id: ws.id, name: ws.name };
  saveSeed(seed);
}
note('seeded', seed);
