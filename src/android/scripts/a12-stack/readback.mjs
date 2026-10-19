// The seeded objects as the server holds them now, read with each account's own token, as one JSON document on
// stdout: node readback.mjs [label]. Read-only toward the stack. The device script runs it after every journey.
import { readSeed, request, login } from './lib.mjs';

const label = process.argv[2] ?? 'readback';
const seed = readSeed();
if (!seed.wiki?.space) {
  console.error('no seed.json: run setup.sh reset first');
  process.exit(2);
}
const owner = await login('owner');
const other = await login('other');
const get = async (token, path) => {
  const { status, body } = await request('GET', path, token);
  return { path: `GET /api${path}`, status, body };
};
const space = seed.wiki.space.id;
const entries = Object.fromEntries(await Promise.all(Object.entries(seed.wiki.entries)
  .map(async ([key, e]) => [key, await get(owner, `/wiki/entries/${e.id}?include=history`)])));
const out = {
  label,
  at: new Date().toISOString(),
  sourceSha: seed.sourceSha,
  owner: {
    space: await get(owner, `/wiki/spaces/${space}`),
    review: await get(owner, `/wiki/review?space=${space}`),
    search: await get(owner, `/wiki/search?q=${encodeURIComponent('readback')}&space=${space}`),
    entries,
    proposalEntry: await get(owner, `/wiki/entries/${seed.wiki.proposals.fresh.entryId}`),
    changesets: {
      fresh: await get(owner, `/wiki/changesets/${seed.wiki.proposals.fresh.changesetId}`),
      stale: await get(owner, `/wiki/changesets/${seed.wiki.proposals.stale.changesetId}`),
      run: await get(owner, `/wiki/changesets/${seed.wiki.run.changesetId}`),
    },
    runEntry: await get(owner, `/wiki/entries/${seed.wiki.run.entryId}`),
    watch: await get(owner, `/watches/${seed.watch.id}`),
    task: await get(owner, `/tasks/${seed.task.id}`),
  },
  other: {
    ownersSpace: await get(other, `/wiki/spaces/${space}`),
    ownersEntry: await get(other, `/wiki/entries/${seed.wiki.entries.edit.id}`),
    ownersSearchEntry: await get(other, `/wiki/entries/${seed.wiki.entries.search.id}`),
    ownersWatch: await get(other, `/watches/${seed.watch.id}`),
    ownSpaces: await get(other, '/wiki/spaces'),
  },
};
console.log(JSON.stringify(out, null, 1));
