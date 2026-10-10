import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { runEventPayloadMentions } from './legacy-artifact-path';

/**
 * The artifact door's transcript check, against real PostgreSQL: does any of this session's events
 * have the requested path somewhere in its payload?
 *
 * It is a gate, not a convenience — `getLegacyArtifact` serves a file only when the transcript it
 * came from mentions it — and it used to be answered in Node, by reading every event's payload of
 * the session (5125 rows, ~6.7 MB on a busy one, measured) and `JSON.stringify`ing each to look for
 * a substring. It is now one `strpos` over jsonb's own text, stopped at the first hit.
 *
 * WHAT IS PINNED HERE, AND WHY IT IS NOT THE OLD TEST EITHER WAY
 * =============================================================
 * The three things moving the answer between the database and Node could get wrong: the session is
 * still the scope (another session's mentioning event must not open this one's door), the argument
 * is a literal and not a pattern (`_` in a path must not match any character, which is what a `LIKE`
 * rewrite would do), and a path that jsonb renders the way it was written still matches itself.
 *
 * `bash scripts/run-pg-spec.sh src/apiserver/src/sessions/legacy-artifact-mention.pg.spec.ts`
 *
 * Not destructive: every row belongs to an owner this run creates.
 */

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('the mention check reads the session\'s own events, literally',
  { skip: !URL, concurrency: 1, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    const db = prismaClientFor(URL!);
    try {
      await verifyCoordinatorPgIdentity(identity);

      const ownerId = randomUUID();
      await db.user.create({
        data: { id: ownerId, email: `mention-${RUN}-${ownerId}@legacy-artifact.invalid`, name: 'mention', passwordHash: 'x' },
      });
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      await db.runner.create({
        data: {
          id: runnerId, ownerId, name: 'mention runner', tokenHash: `legacy-artifact-${runnerId}`,
          status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
        },
      });
      await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `mention ${RUN}`, enabled: true } });
      const session = async (title: string): Promise<string> => {
        const id = randomUUID();
        await db.session.create({
          data: {
            id, ownerId, creatorId: ownerId, workspaceId, title, prompt: title,
            status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
          },
        });
        return id;
      };
      const mine = await session('mine');
      const other = await session('other');

      const event = (sessionId: string, seq: number, payload: unknown): Promise<unknown> =>
        db.runEvent.create({ data: { sessionId, seq, type: 'assistant', payload: payload as never } });

      const drawn = `/root/.orbit/worktrees/${mine}/docs/mocks/card.png`;
      const percent = `/root/.orbit/worktrees/${mine}/docs/mocks/100%.png`;
      await event(mine, 1, { text: 'working' });
      await event(mine, 2, { text: `drew ${drawn} for the header` });
      await event(mine, 3, { tool: 'Write', input: { file_path: percent, content: 'x' } });
      // A mention in ANOTHER session's transcript, which must not answer for this one.
      await event(other, 1, { text: `the same ${drawn}` });

      const mentions = (sessionId: string, text: string): Promise<boolean> =>
        runEventPayloadMentions(db as unknown as PrismaService, sessionId, text);

      // A path written into a text payload and one written into a tool input, both in this session.
      assert.equal(await mentions(mine, drawn), true, 'the path drawn in this transcript');
      assert.equal(await mentions(mine, percent), true, 'the path written into a tool input');

      // The scope is the session, not the table.
      assert.equal(await mentions(mine, '/root/.orbit/worktrees/nowhere/docs/mocks/card.png'), false,
        'a path no event mentions');
      assert.equal(await mentions(other, `/root/.orbit/worktrees/${mine}/docs/mocks/nope.png`), false,
        'a path only another session mentions');

      // The argument is a literal: `_` is a character, not "any character" (a LIKE rewrite would
      // match `axb.png` here and open the door on a path the transcript never named).
      await event(mine, 4, { text: `/root/.orbit/worktrees/${mine}/docs/mocks/axb.png` });
      assert.equal(await mentions(mine, `/root/.orbit/worktrees/${mine}/docs/mocks/axb.png`), true,
        'the path as written');
      assert.equal(await mentions(mine, `/root/.orbit/worktrees/${mine}/docs/mocks/a_b.png`), false,
        'a pattern spelling of it, which must not match');
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
