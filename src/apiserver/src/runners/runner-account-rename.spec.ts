import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { RenameAccountDto } from './dto';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Renaming an account on a runner from the Providers page — Default included.
 *
 * `PATCH /runners/:id/accounts/:engine/:account` takes a name and keeps it in Orbit, beside the
 * runner's report (runner.account_names). What is checked here is everything decided before the
 * statement: which accounts can be renamed at all, whose runner it is, and when a name is stored
 * rather than taken out. The statement itself runs on PostgreSQL in runner-account-rename.pg.spec.ts.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const WORK = '3fa91c2e';
const USER = { userId: OWNER } as AuthUser;

const DEFAULT_ACCOUNT: RunnerEngineAccount = { id: 'default', home: '/home/ada/.claude', auth: 'yes' };
const WORK_ACCOUNT: RunnerEngineAccount = {
  id: WORK,
  name: 'jianghailong.rd',
  home: '/home/ada/.orbit/claude-accounts/3fa91c2e',
  auth: 'yes',
};
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, auth: 'yes', accounts: [DEFAULT_ACCOUNT, WORK_ACCOUNT] },
  { engine: 'kimi', installed: true, auth: 'yes' },
];

function harness(engines: unknown = ENGINES) {
  /** The values each statement was written with, in the order the statement names them. */
  const writes: unknown[][] = [];
  const prisma = {
    runner: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        where.id === RUNNER_ID && where.ownerId === OWNER ? { engines } : null,
    },
    $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(values);
      return 1;
    },
  } as never;
  const runners = new RunnersController(new RunnersService(prisma));
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  return {
    writes,
    /** PATCH /runners/:id/accounts/:engine/:account, from the raw JSON body on. */
    async patch(engine: string, account: string, body: Record<string, unknown>, user = USER, id = RUNNER_ID) {
      const dto = (await pipe.transform(body, { type: 'body', metatype: RenameAccountDto })) as RenameAccountDto;
      return runners.renameAccount(user, id, engine, account, dto);
    },
  };
}

test('Default is renamed like any other account, and comes back as the runner list will show it', async () => {
  const h = harness();

  assert.deepEqual(await h.patch('claude', 'default', { name: '  jianghailong.main ' }), {
    ...DEFAULT_ACCOUNT,
    name: 'jianghailong.main',
  });
  assert.deepEqual(await h.patch('claude', WORK, { name: 'Research' }), { ...WORK_ACCOUNT, name: 'Research' });
  assert.equal(h.writes.length, 2);
  assert.ok(h.writes[0].includes('jianghailong.main'), 'the trimmed name is what is stored');
  assert.ok(h.writes[1].includes('Research'));
});

test('the name an account carries anyway stores nothing of its own', async () => {
  const h = harness();

  // Default renamed "Default" is plain Default again, with no name of its own to show a mark for.
  assert.deepEqual(await h.patch('claude', 'default', { name: 'Default' }), DEFAULT_ACCOUNT);
  // An added account renamed to the name it was added under reads as its runner reports it.
  assert.deepEqual(await h.patch('claude', WORK, { name: 'jianghailong.rd' }), WORK_ACCOUNT);
  assert.equal(h.writes.length, 2, 'each still writes: it takes the key a rename before it left');
  for (const values of h.writes) {
    assert.ok(!values.includes('Default') && !values.includes('jianghailong.rd'), `stored ${JSON.stringify(values)}`);
  }
});

test('only an account of an engine that keeps accounts, by an id an account can have', async () => {
  const h = harness();
  for (const [engine, account] of [
    ['kimi', 'default'],
    ['claude', 'Default'],
    ['claude', '../default'],
    ['claude', '3FA91C2E'],
  ]) {
    await assert.rejects(h.patch(engine, account, { name: 'Main' }), BadRequestException, `${engine}/${account}`);
  }
  await assert.rejects(h.patch('opencode', 'default', { name: 'Main' }), BadRequestException);
  // Reported on the Runners page since it is installed there, but it keeps no accounts either.
  await assert.rejects(h.patch('antigravity', 'default', { name: 'Main' }), BadRequestException);
  assert.deepEqual(h.writes, []);
});

test('a name has to be one: present, not blank, and no longer than a new account’s', async () => {
  const h = harness();
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: 'x'.repeat(61) }]) {
    await assert.rejects(h.patch('claude', 'default', body), BadRequestException, JSON.stringify(body));
  }
  assert.deepEqual(await h.patch('claude', 'default', { name: 'x'.repeat(60) }), {
    ...DEFAULT_ACCOUNT,
    name: 'x'.repeat(60),
  });
});

test('somebody else’s runner, and an account this runner does not report, are not found', async () => {
  const h = harness();

  await assert.rejects(h.patch('claude', 'default', { name: 'Main' }, { userId: 'owner-2' } as AuthUser), NotFoundException);
  // A slot it does not list — removed, or never its own — and an engine it reports no accounts for.
  await assert.rejects(h.patch('claude', '0b05070e', { name: 'Main' }), NotFoundException);
  await assert.rejects(h.patch('codex', 'default', { name: 'Main' }), NotFoundException);
  await assert.rejects(harness(null).patch('claude', 'default', { name: 'Main' }), NotFoundException);
  assert.deepEqual(h.writes, []);
});
