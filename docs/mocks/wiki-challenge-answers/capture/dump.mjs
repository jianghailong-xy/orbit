// Record the stack's own answers for the iOS stub: what Review, the spaces and the four entries read now.
// usage: node dump.mjs <out-dir>
import fs from 'node:fs';
import { call, state } from './api.mjs';
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const st = state();
const put = (name, body) => fs.writeFileSync(`${out}/${name}.json`, JSON.stringify(body, null, 1));
put('users-me', await call('GET', '/users/me'));
put('wiki-spaces', await call('GET', '/wiki/spaces'));
put('wiki-space', await call('GET', `/wiki/spaces/${st.spaceId}`));
put('wiki-review', await call('GET', '/wiki/review'));
put('wiki-review-space', await call('GET', `/wiki/review?space=${st.spaceId}`));
put('wiki-space-entries', await call('GET', `/wiki/spaces/${st.spaceId}/entries`));
for (const [prod, id] of Object.entries(st.entryIds)) put(`wiki-entry-${prod}`, await call('GET', `/wiki/entries/${id}`));
put('ids', { spaceId: st.spaceId, entryIds: st.entryIds, sessionId: st.sessionId, changeset: st.changeset_toolu_012CKdwtMgVJxjCQ3SVYyAwk });
console.log(fs.readdirSync(out).join(' '));
