/**
 * For a spec that is about what a turn does once a runner has it, and so drives `RunnerApiController.dequeueTurn`
 * directly without a supervisor's takeover and activation in front of it. Importing this makes `null` in the generation's
 * place mean "under the session's lease, whichever that is", a real one, made here when the session has none that is
 * live (sessionLease).
 *
 * The route itself takes no such call: GET /runner/sessions/:id/inbox refuses a fetch that names no generation, and
 * `dequeueTurn` holds every generation to the row. inbox-lease-generation.spec.ts is where that fence is tried.
 */
import { randomUUID } from 'node:crypto';

import { RunnerApiController } from '../runner-api/runner-api.controller';

type TransactionClient = {
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};
type Prisma = { $transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> };

/**
 * The session's lease generation, made as above when it has no live one: what an inbox fetch over HTTP names. A live
 * generation is the session's current one, registered under the session's current lease owner and not retired. One is
 * made under that owner, whoever it is: none, a process's, or the sentinel a terminal resume leaves for the next
 * process (newTerminalResumeHandoffOwner), as an activation under it would.
 */
export async function sessionLease(prisma: Prisma, sessionId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ generation: string | null; owner: string | null; live: boolean }>>`
      SELECT s."inbox_lease_generation" AS "generation", s."inbox_lease_owner"::text AS "owner",
             EXISTS (SELECT 1 FROM "inbox_lease_generation" g
                      WHERE g."generation" = s."inbox_lease_generation" AND g."session_id" = s.id
                        AND g."lease_owner" IS NOT DISTINCT FROM s."inbox_lease_owner" AND g."retired_at" IS NULL) AS "live"
        FROM "session" s WHERE s.id = ${sessionId}::uuid FOR UPDATE OF s
    `;
    if (!row) return randomUUID(); // no such session: dequeueTurn says so
    if (row.generation && row.live) return row.generation;
    const generation = randomUUID();
    // What the database asks of a transaction that writes a lease (migrations 0080, 0367, 0377, 0414, 0426).
    await tx.$executeRaw`SELECT set_config('orbit.runner_supports_opencode', '1', true), set_config('orbit.runner_supports_antigravity', '1', true), set_config('orbit.runner_supports_dsh', '1', true), set_config('orbit.runner_supports_cursor', '1', true), set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.$executeRaw`UPDATE "session" SET "inbox_lease_generation" = ${generation}::uuid WHERE id = ${sessionId}::uuid`;
    await tx.$executeRaw`
      INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner")
      VALUES (${generation}::uuid, ${sessionId}::uuid, ${row.owner}::uuid)
    `;
    return generation;
  });
}

const proto = RunnerApiController.prototype as unknown as {
  dequeueTurn(this: { prisma: Prisma }, sessionId: string, runnerId: string, generation: string | null, ...rest: unknown[]): Promise<unknown>;
};
const dequeueTurn = proto.dequeueTurn;
proto.dequeueTurn = async function dequeueUnderLease(sessionId, runnerId, generation, ...rest) {
  return dequeueTurn.call(this, sessionId, runnerId, generation ?? (await sessionLease(this.prisma, sessionId)), ...rest);
};
