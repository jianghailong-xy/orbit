// Seeds the throwaway stack through the server's own HTTP doors only: the owner (bootstrap), a runner (enrollment
// token + /runner/register; no heartbeat: the daemon's calls are taken only over the runner link, 426 over HTTPS, so the
// runner stays offline and nothing claims a session), two workspaces, a session, four
// schedules (the session's schedule_create card over /runner/schedules, then the owner's Create on the card), two
// paused, and the page chat (POST /api/schedules/chat). Writes $STACK_DIR/state.json (tokens, ids, mode 0600) and $STACK_DIR/payloads/seed-*.json.
import fs from 'node:fs';
const API = 'http://127.0.0.1:3757/api';
const DIR = process.env.STACK_DIR ?? '/var/tmp/sched-chat-stack';
fs.mkdirSync(`${DIR}/payloads`, { recursive: true });
async function call(method, path, { token, runner, session, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (runner) headers.authorization = `Bearer ${runner}`;
  if (session) headers['x-orbit-session-id'] = session;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  console.log(`${method} ${path} -> ${r.status}`);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 400)}`);
  return json;
}
const save = (name, value) => fs.writeFileSync(`${DIR}/payloads/${name}.json`, JSON.stringify(value, null, 2));

const auth = await call('POST', '/auth/bootstrap', { body: { email: 'owner@orbit.test', name: 'Stack Owner', password: 'orbit-stack-pass-1' } });
const token = auth.accessToken;
const enroll = await call('POST', '/runners/enrollment-tokens', { token, body: {} });
const reg = await call('POST', '/runner/register', { body: { enrollmentToken: enroll.token, name: 'dev-box', hostname: 'dev-box', version: '0.1.261' } });
const runner = reg.runnerToken;
const runnerId = reg.runnerId;
const wsApi = await call('POST', '/workspaces', { token, body: { name: 'apiserver', runnerId, workDir: '/srv/orbit' } });
const wsWeb = await call('POST', '/workspaces', { token, body: { name: 'web', runnerId, workDir: '/srv/orbit-web' } });
const session = await call('POST', '/sessions', { token, body: { workspaceId: wsApi.id, prompt: 'Set up the nightly checks.' } });
const sessionId = session.id ?? session.session?.id;

const tz = 'Asia/Shanghai';
const specs = [
  { title: 'Codex stable check', rule: { kind: 'DAILY', time: '06:00' }, accessLevel: 'CHECK_ONLY' },
  { title: 'Nightly dependency audit', rule: { kind: 'DAILY', time: '07:00' }, accessLevel: 'OPEN_PR' },
  { title: 'Changelog watch (docs)', rule: { kind: 'DAILY', time: '09:00' }, accessLevel: 'CHECK_ONLY' },
  { title: 'Changelog watch (API)', rule: { kind: 'DAILY', time: '23:46' }, accessLevel: 'CHECK_ONLY' },
];
const schedules = [];
for (const s of specs) {
  const card = await call('POST', '/runner/schedules', {
    runner, session: sessionId,
    body: { intent: `Every day: ${s.title}`, title: s.title, prompt: `Run the ${s.title.toLowerCase()} and report what changed.`, rule: s.rule, timezone: tz, accessLevel: s.accessLevel, runLimitMinutes: 30 },
  });
  save(`seed-create-${schedules.length}`, card);
  const requestId = card.requestId ?? card.request?.id ?? card.card?.id ?? card.id;
  const allowed = await call('POST', `/schedule-requests/${requestId}/allow`, { token, body: {} });
  const id = allowed.schedule?.id ?? allowed.scheduleId ?? allowed.id;
  schedules.push({ id, title: s.title });
}
for (const s of schedules.slice(2)) await call('POST', `/schedules/${s.id}/pause`, { token, body: {} });

const opened = await call('POST', '/schedules/chat', { token, body: { workspaceId: wsApi.id, text: 'What runs tomorrow?' } });
save('seed-post-schedules-chat', opened);
const read = await call('GET', `/schedules/chat?timezone=${encodeURIComponent(tz)}`, { token });
save('seed-get-schedules-chat', read);
fs.writeFileSync(`${DIR}/state.json`, JSON.stringify({ token, refreshToken: auth.refreshToken, runner, runnerId, workspaces: { apiserver: wsApi.id, web: wsWeb.id }, sessionId, schedules, chat: opened.sessionId }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ runnerId, workspaces: [wsApi.id, wsWeb.id], schedules, chat: opened }, null, 2));
