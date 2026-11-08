/**
 * The sign-in link a runner reports, on real PostgreSQL: what runner-login-account.spec.ts can only
 * imitate with a row in memory.
 *
 *  (1) A link that is not an https page never reaches a column of the runner's row, in any spelling,
 *      from either of the two reports that carry a link, and the sign-in reads as failed.
 *  (2) The link of every engine lands on the row as its CLI printed it.
 *  (3) A sign-in ended that way starts again.
 *  (4) A refused link about a start the row has moved past leaves the row exactly as it was.
 *
 * Production code throughout: RunnersService and RunnerApiController. It only adds rows, and refuses
 * to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { ANTIGRAVITY_GOOGLE_LOGIN_V1 } from '../common/antigravity-readiness';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { RunnersService } from '../runners/runners.service';
import { CURSOR_ACCOUNT_LOGIN_V1, LOGIN_LINK_REFUSED, RunnerApiController } from './runner-api.controller';

const DATABASE = process.env.COORDINATOR_PG_URL;
const suite = DATABASE ? test : test.skip;

/** Carried by every refused link, so a column holding any part of one can be found. */
const MARK = 'not-for-the-row';

const NOT_HTTPS_LINKS = [
  `javascript:void('${MARK}')`,
  `JaVaScRiPt:void('${MARK}')`,
  ` javascript:void('${MARK}')`,
  `\tjavascript:void('${MARK}')`,
  `java\tscript:void('${MARK}')`,
  `\x01javascript:void('${MARK}')`,
  `data:text/html,${MARK}`,
  `DATA:text/html,${MARK}`,
  ` data:text/html,${MARK}`,
  `vbscript:msgbox("${MARK}")`,
  ` VBScript:msgbox("${MARK}")`,
  `http://claude.com/${MARK}`,
  `file:///${MARK}`,
  `/${MARK}`,
  `claude.com/${MARK}`,
];

const ENGINE_LINKS: Array<[string, 'awaiting_code' | 'awaiting_approval', string]> = [
  ['claude', 'awaiting_code', 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=frcAznfHKdQ3nNYn157q799r9SIaDMeJqq9HqdHD2JQ&code_challenge_method=S256&state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs'],
  ['codex', 'awaiting_approval', 'https://auth.openai.com/codex/device'],
  ['kimi', 'awaiting_approval', 'https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI'],
  ['kimi', 'awaiting_approval', 'https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86'],
  ['antigravity', 'awaiting_code', 'https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture'],
  ['cursor', 'awaiting_approval', 'https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=7d2e0c1a-0000-4000-8000-000000000001&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true'],
];

suite('the sign-in link on real PostgreSQL', { timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(DATABASE);
  const client = new Client({ connectionString: DATABASE });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(DATABASE!);
  const runners = new RunnersService(db as unknown as PrismaService);
  const api = new RunnerApiController(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const relay = api as unknown as {
    loginResult(runner: { id: string }, body: Record<string, unknown>): Promise<{ ok: boolean; applied: boolean }>;
  };
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  async function runner(): Promise<{ ownerId: string; runnerId: string }> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `login-link-${ownerId}@spec.invalid`, name: 'owner', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: 'hpc', tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE,
        maxConcurrent: 1, lastHeartbeatAt: new Date(),
        // What a start of Antigravity's and Cursor CLI's needs of the runner, before any link is reported.
        capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1, CURSOR_ACCOUNT_LOGIN_V1], capabilitiesReportedAt: new Date(),
      },
    });
    return { ownerId, runnerId };
  }
  /** Every column of the row as the database holds it, not as a client is shown it. */
  const raw = async (runnerId: string) =>
    (await client.query<{ row: string }>('SELECT row_to_json(runner)::text AS row FROM runner WHERE id = $1', [runnerId])).rows[0].row;
  const columns = async (runnerId: string) =>
    (
      await client.query<Record<string, unknown>>(
        `SELECT login_status, login_url, login_user_code, login_message, login_expires_at, login_reason
           FROM runner WHERE id = $1`,
        [runnerId],
      )
    ).rows[0];
  const attemptOf = async (runnerId: string) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runnerId } })).loginAt!.toISOString();

  await t.test('(1) a link that is not https reaches no column, and the sign-in reads as failed', async () => {
    const { ownerId, runnerId } = await runner();
    for (const status of ['awaiting_code', 'awaiting_approval']) {
      for (const url of NOT_HTTPS_LINKS) {
        const label = JSON.stringify([status, url]);
        await runners.startLogin(ownerId, runnerId, { engine: 'claude' });
        const attempt = await attemptOf(runnerId);
        assert.deepEqual(
          await relay.loginResult({ id: runnerId }, {
            status, url, attempt, userCode: `CODE-${MARK}`, message: MARK, expiresAt: '2099-01-01T00:00:00.000Z',
          }),
          { ok: true, applied: true },
          label,
        );
        assert.deepEqual(await columns(runnerId), {
          login_status: 'failed',
          login_url: null,
          login_user_code: null,
          login_message: LOGIN_LINK_REFUSED,
          login_expires_at: null,
          login_reason: null,
        }, label);
        assert.ok(!(await raw(runnerId)).includes(MARK), `no column carries it: ${label}`);
        const state = await runners.getLoginState(ownerId, runnerId);
        assert.equal(state.status, 'failed', label);
        assert.equal(state.url, null, label);
        assert.equal(state.message, LOGIN_LINK_REFUSED, label);
      }
    }
  });

  await t.test('(2) the link of every engine lands on the row as its CLI printed it', async () => {
    const { ownerId, runnerId } = await runner();
    for (const [engine, status, link] of ENGINE_LINKS) {
      await runners.startLogin(ownerId, runnerId, { engine } as never);
      const attempt = await attemptOf(runnerId);
      assert.deepEqual(await relay.loginResult({ id: runnerId }, { status, url: link, attempt }), { ok: true, applied: true }, link);
      const row = await columns(runnerId);
      assert.equal(row.login_status, status, link);
      assert.equal(row.login_url, link);
      assert.equal(row.login_message, null, link);
    }
  });

  await t.test('(3) a sign-in ended on a refused link starts again', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'claude' });
    await relay.loginResult({ id: runnerId }, { status: 'awaiting_code', url: NOT_HTTPS_LINKS[0], attempt: await attemptOf(runnerId) });
    assert.equal((await columns(runnerId)).login_status, 'failed');

    const again = await runners.startLogin(ownerId, runnerId, { engine: 'claude' });
    assert.equal(again.status, 'pending');
    assert.equal(again.message, null);
    const [, status, link] = ENGINE_LINKS[0];
    await relay.loginResult({ id: runnerId }, { status, url: link, attempt: await attemptOf(runnerId) });
    assert.equal((await columns(runnerId)).login_status, status);
    assert.equal((await columns(runnerId)).login_url, link);
  });

  await t.test('(4) a refused link about a start the row has moved past leaves the row as it was', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'claude' });
    const stale = await attemptOf(runnerId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.startLogin(ownerId, runnerId, { engine: 'claude' });
    const before = await raw(runnerId);
    assert.deepEqual(
      await relay.loginResult({ id: runnerId }, { status: 'awaiting_code', url: NOT_HTTPS_LINKS[0], attempt: stale }),
      { ok: true, applied: false },
    );
    assert.equal(await raw(runnerId), before);
  });
});
