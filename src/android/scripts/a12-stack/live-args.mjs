// The instrumentation arguments of WikiWatchLiveTest, one token per line (`-e`, name, value, …), from the stack's
// seed.json and accounts.json: node live-args.mjs [server]. The passwords are in them, so the caller keeps them
// off disk and out of its evidence (live.sh reads them with mapfile).
import { readFileSync } from 'node:fs';
import { accountsFile, readSeed } from './lib.mjs';

const server = process.argv[2] ?? 'http://127.0.0.1:3712';
const seed = readSeed();
const accounts = JSON.parse(readFileSync(accountsFile, 'utf8'));
if (!seed.wiki?.proposals || !seed.watch?.id) {
  console.error('seed.json is incomplete: run setup.sh reset');
  process.exit(2);
}
const args = {
  a12Server: server,
  a12OwnerEmail: accounts.owner.email,
  a12OwnerPassword: accounts.owner.password,
  a12OtherEmail: accounts.other.email,
  a12OtherPassword: accounts.other.password,
  a12Space: seed.wiki.space.id,
  a12SpaceSlug: seed.wiki.space.slug,
  a12SearchEntry: seed.wiki.entries.search.id,
  a12SearchQuery: 'readback',
  a12FreshChangeset: seed.wiki.proposals.fresh.changesetId,
  a12FreshOp: seed.wiki.proposals.fresh.opId,
  a12FreshEntry: seed.wiki.proposals.fresh.entryId,
  a12StaleChangeset: seed.wiki.proposals.stale.changesetId,
  a12StaleOp: seed.wiki.proposals.stale.opId,
  a12StaleEntry: seed.wiki.proposals.stale.entryId,
  a12EditEntry: seed.wiki.entries.edit.id,
  a12Watch: seed.watch.id,
  a12Task: seed.task.id,
  a12RunChangeset: seed.wiki.run.changesetId,
  a12RunEntry: seed.wiki.run.entryId,
};
for (const [name, value] of Object.entries(args)) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9@.:/_-]+$/.test(value)) {
    console.error(`${name} is not a plain token, which an \`adb shell am instrument\` line cannot carry safely`);
    process.exit(2);
  }
  console.log('-e');
  console.log(name);
  console.log(value);
}
