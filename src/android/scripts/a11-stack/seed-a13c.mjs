// A13c on the A11 stack (RunnerStackDeviceTest): three runners that report Antigravity through the real runner API (register +
// heartbeat), so the real server sanitizes what they say and GET /runners serves it to the app. No Google account is signed in:
// the engine health a signed-in runner would report is sent as such. Run from the checkout with the stack's environment
// (A11_STACK_DIR, A11_STACK_API_PORT); scripts/management-stack-device-test.sh does.
//   node seed-a13c.mjs run         — register (once) and heartbeat every 20 s until killed
//   node seed-a13c.mjs dump [file] — what GET /runners now says of them (owner's token), as JSON
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { S, call, login } from './lib.mjs';
const state = `${S}/a13c-runners.json`;
const H = 3600e3, D = 24 * H;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const buckets = (left, weekly, fiveHour) => ['gemini-weekly', 'gemini-5h', '3p-weekly', '3p-5h'].map((id, i) => ({
  id, window: id.endsWith('5h') ? '5h' : 'weekly', remainingFraction: left[i], resetTime: id.endsWith('5h') ? fiveHour : weekly }));

const runners = {
  // Linux, Google sign-in relayed, accounts kept apart: Default + Work, each with its own buckets; Claude with a login
  // about to lapse and an added account whose quota rides a FLAT plan-usage payload (A13-6).
  'a13c-agy': {
    hostname: 'agy-host', os: 'linux',
    caps: ['antigravity-google-login/v1', 'antigravity-account-login/v1', 'antigravity-account-remove/v1', 'claude-account-remove/v1'],
    providers: 'claude,codex,kimi,antigravity',
    engines: () => [
      { engine: 'claude', installed: true, version: '2.1.292 (Claude Code)', auth: 'yes', accounts: [
        { id: 'default', auth: 'yes', home: '/home/ci/.claude', loginExpiresAt: iso(47 * H) },
        { id: '1fda3f43', name: 'Work', auth: 'yes', home: '/home/ci/.orbit/claude-accounts/1fda3f43' }] },
      { engine: 'codex', installed: true, version: 'codex-cli 0.158.0', auth: 'no' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
      { engine: 'antigravity', installed: true, version: '1.3.0', auth: 'yes', authSource: 'google', accounts: [
        { id: 'default', auth: 'yes', home: '/home/ci/.orbit/antigravity/google' },
        { id: '5c2e91a0', name: 'Work', auth: 'yes', home: '/home/ci/.orbit/antigravity-accounts/5c2e91a0' }],
        planUsage: { provider: 'antigravity', fetchedAt: iso(0), buckets: buckets([1, 1, 0.98, 1], iso(4 * D), iso(3 * H)),
          accounts: { '5c2e91a0': { provider: 'antigravity', fetchedAt: iso(0), buckets: buckets([0.61, 0.04, 1, 1], iso(3 * D), iso(2 * H)) } } } }],
    planUsage: () => ({ provider: 'claude', fetchedAt: iso(0), fiveHour: { utilization: 84, resetsAt: iso(H) }, sevenDay: { utilization: 77, resetsAt: iso(2 * D) },
      accounts: { '1fda3f43': { provider: 'claude', fiveHour: { utilization: 0, resetsAt: iso(4 * H) }, sevenDay: { utilization: 41, resetsAt: iso(5 * D) } } } }),
  },
  // macOS: Google sign-in not supported there; Antigravity runs on the runner's own GEMINI_API_KEY.
  'a13c-mac': {
    hostname: 'mac-host', os: 'darwin', caps: ['antigravity-google-login/v1'], providers: 'claude,antigravity',
    engines: () => [
      { engine: 'claude', installed: true, version: '2.1.292 (Claude Code)', auth: 'yes' },
      { engine: 'antigravity', installed: true, version: '1.3.0', auth: 'yes', authSource: 'env_key', accounts: [
        { id: 'default', auth: 'no', home: '/Users/ci/.orbit/antigravity/google' }] }],
  },
  // A runner too old to relay Google sign-in (no antigravity-google-login/v1).
  'a13c-old': {
    hostname: 'old-host', os: 'linux', caps: [], providers: 'claude,antigravity',
    engines: () => [{ engine: 'claude', installed: true, version: '2.1.200 (Claude Code)', auth: 'yes' },
      { engine: 'antigravity', installed: true, version: '1.2.16', auth: 'no' }],
  },
};

const mode = process.argv[2];
const owner = await login('owner');
if (mode === 'dump') {
  const all = await call('GET', '/runners', owner);
  const mine = all.filter((r) => r.name in runners);
  writeFileSync(process.argv[3] ?? '/dev/stdout', JSON.stringify(mine, null, 2) + '\n');
  process.exit(0);
}
const known = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {};
for (const [name, r] of Object.entries(runners)) {
  if (known[name]) continue;
  const enroll = await call('POST', '/runners/enrollment-tokens', owner, { label: name });
  known[name] = await call('POST', '/runner/register', undefined, { enrollmentToken: enroll.token, name, hostname: r.hostname, version: '0.1.230', maxConcurrent: 4 });
  console.log(`registered ${name} ${known[name].runnerId}`);
}
writeFileSync(state, JSON.stringify(known, null, 2));
for (;;) {
  for (const [name, r] of Object.entries(runners)) {
    const body = { status: 'ONLINE', idleCapacity: 4, version: '0.1.230', runsAsRoot: false, engines: r.engines(), ...(r.planUsage ? { planUsage: r.planUsage() } : {}) };
    await call('POST', '/runner/heartbeat', known[name].runnerToken, body, {
      'x-orbit-runner-capabilities': r.caps.join(','), 'x-orbit-runner-os': r.os, 'x-orbit-supported-providers': r.providers });
  }
  console.log(`${new Date().toISOString()} heartbeat ${Object.keys(runners).join(' ')}`);
  await new Promise((done) => setTimeout(done, 20_000));
}
