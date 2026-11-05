/**
 * The history backfill of the wiki's notes, from a shell (contracts/wiki.contract.json `maintenance.job.server.backfill`,
 * docs/wiki-memory-claims-design.md section 5), against DATABASE_URL. In Compose that is the apiserver's container:
 *
 *   docker compose exec apiserver node src/apiserver/dist/wiki/wiki-backfill.cli.js run \
 *     --space <id> --reason <why> --session <id>[:<noteId>,<noteId>] [--session ...]
 *       queues one `maintain` job over at most 20 sessions, and prints its ids; the worker runs it, and its report is on its run row
 *   docker compose exec apiserver node src/apiserver/dist/wiki/wiki-backfill.cli.js downgrade --space <id> [--apply --reason <why>]
 *       reports which live `auto` entries rest on a note with no first-hand source; only with --apply does it move them to `unreviewed`
 *
 * WHY A COMMAND AND NOT A ROUTE. This runs once, for one space, by whoever runs the deployment. A route would be a door kept
 * open for ever, with its login and its account cases to hold, for something nobody asks for twice. Whoever can run this can
 * read the database already, so it asks for no credential and reads the space's owner off the space.
 *
 * It exits 0 when it did what it was asked, 1 when it was refused or failed, and 2 when it was asked wrongly.
 */
import { parseArgs } from 'node:util';
import { toUuid } from '@orbit/shared';
import { databaseUrl, prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { requestWikiBackfill } from './wiki-maintenance-run';
import { WikiRefusalError, WikiService } from './wiki.service';

const USAGE = `usage: wiki-backfill.cli.js run --space <id> --reason <why> --session <id>[:<noteId>,<noteId>] [--session ...]
       wiki-backfill.cli.js downgrade --space <id> [--apply --reason <why>]
`;

const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

/** One `--session`: a session's id, and the notes to read as what it claimed. */
function sessionOf(spec: string): { sessionId: string; noteIds: string[] } {
  const [sessionId, notes = ''] = spec.split(':', 2);
  return { sessionId: toUuid(sessionId!), noteIds: notes.split(',').filter((id) => id !== '').map((id) => toUuid(id)) };
}

async function main(): Promise<void> {
  let command: string | undefined;
  let values: { space?: string; reason?: string; session?: string[]; apply?: boolean };
  let spaceId: string;
  let sessions: Array<{ sessionId: string; noteIds: string[] }>;
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        space: { type: 'string' },
        reason: { type: 'string' },
        session: { type: 'string', multiple: true },
        apply: { type: 'boolean' },
      },
    });
    command = parsed.positionals[0];
    values = parsed.values;
    if ((command !== 'run' && command !== 'downgrade') || parsed.positionals.length !== 1 || !values.space) throw new Error('asked wrongly');
    spaceId = toUuid(values.space);
    sessions = (values.session ?? []).map(sessionOf);
  } catch {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const prisma = prismaClientFor(databaseUrl());
  try {
    if (command === 'run') {
      const answer = await requestWikiBackfill(prisma as PrismaService, { spaceId, reason: values.reason ?? '', sessions });
      if (!answer.made) {
        process.stderr.write(`wiki-backfill: refused: ${answer.why}\n`);
        process.exitCode = 1;
        return;
      }
      say({ spaceId, jobId: answer.jobId, runId: answer.runId, sessions: sessions.length });
      return;
    }
    const space = await prisma.wikiSpace.findFirst({ where: { id: spaceId }, select: { ownerId: true } });
    if (!space) {
      process.stderr.write('wiki-backfill: refused: no such wiki space\n');
      process.exitCode = 1;
      return;
    }
    say(await new WikiService(prisma as PrismaService).downgradeNoteEntries(space.ownerId, spaceId, { apply: values.apply === true, reason: values.reason }));
  } catch (error) {
    if (!(error instanceof WikiRefusalError)) throw error;
    process.stderr.write(`wiki-backfill: refused: ${error.refusal.message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`wiki-backfill: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
