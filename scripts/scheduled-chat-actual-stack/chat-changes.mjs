// What the page chat's agent would do, through the runner's own schedule doors as the chat session: an in-envelope
// time change (a change line with Undo) and a widen (a card waiting). Run after seed.mjs.
import fs from 'node:fs';
const DIR = process.env.STACK_DIR ?? '/var/tmp/sched-chat-stack';
const state = JSON.parse(fs.readFileSync(`${DIR}/state.json`, 'utf8'));
const codex = state.schedules.find((s) => s.title === 'Codex stable check').id;
for (const body of [{ rule: { kind: 'DAILY', time: '09:00' } }, { accessLevel: 'OPEN_PR' }]) {
  const r = await fetch(`http://127.0.0.1:3757/api/runner/schedules/${codex}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.runner}`, 'x-orbit-session-id': state.chat },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(body), r.status, (await r.text()).slice(0, 300));
}
