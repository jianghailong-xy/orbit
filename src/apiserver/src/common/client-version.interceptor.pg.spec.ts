import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ClientVersionInterceptor } from './client-version.interceptor';

const URL = process.env.COORDINATOR_PG_URL;

// Real HTTP, JWT guard, global interceptor and Prisma writes; the route and users are fixtures.
// Run through scripts/run-pg-spec.sh so a skip cannot be mistaken for persistence evidence.
test('authenticated client headers persist Android upgrades and preserve other clients', { skip: !URL, timeout: 30_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const observer = new Client({ connectionString: URL });
  await observer.connect();
  t.after(() => observer.end());
  await verifyCoordinatorPgIdentity(observer);

  const prisma = prismaClientFor(URL);
  const userIds = [randomUUID(), randomUUID()];
  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  await prisma.user.createMany({ data: userIds.map((id) => ({
    id, email: `${id}@client-version.invalid`, name: 'Version fixture', passwordHash: 'not-a-login-credential',
  })) });
  const jwt = new JwtService({ secret: randomUUID() });

  @Controller('version-fixture')
  @UseGuards(JwtAuthGuard)
  class VersionRoute {
    @Get()
    get() { return { ok: true }; }
  }
  @Module({
    controllers: [VersionRoute],
    providers: [
      JwtAuthGuard,
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: prisma },
      { provide: APP_INTERCEPTOR, useClass: ClientVersionInterceptor },
    ],
  })
  class VersionModule {}
  const app = await NestFactory.create(VersionModule, { logger: false, abortOnError: false });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const hit = async (header: string, userId: string | null = userIds[0]) => {
    const headers: Record<string, string> = { 'X-Orbit-Client': header };
    if (userId) headers.authorization = `Bearer ${jwt.sign({ sub: userId }, { expiresIn: '1m' })}`;
    const response = await fetch(`${base}/version-fixture`, { headers });
    assert.equal(response.status, userId ? 200 : 401);
    await response.arrayBuffer();
    console.log(`HTTP ${response.status} X-Orbit-Client=${header} user=${userId ?? 'anonymous'}`);
  };
  const readVersion = async (kind: string, version: string, userId = userIds[0]) => {
    // Interceptor writes are deliberately asynchronous; wait for the database's observed value.
    const deadline = Date.now() + 5_000;
    do {
      const row = await prisma.clientVersion.findUnique({ where: { userId_kind: { userId, kind } } });
      if (row?.version === version) return row;
      await setTimeout(10);
    } while (Date.now() < deadline);
    assert.fail(`database never observed ${userId} ${kind}/${version}`);
  };

  await hit('android/0.1.114', null);
  assert.equal(await prisma.clientVersion.count({ where: { userId: { in: userIds } } }), 0);
  await hit('android/0.1.114');
  const before = await readVersion('android', '0.1.114');
  await hit('android/0.1.114');
  assert.deepEqual(await readVersion('android', '0.1.114'), before, 'unchanged version is throttled');

  for (const kind of ['web', 'ios', 'macos']) {
    await hit(`${kind}/0.1.100`);
    await readVersion(kind, '0.1.100');
  }
  await hit('android/0.1.115-test.42+fe2e1bcf9');
  await readVersion('android', '0.1.115-test.42+fe2e1bcf9');
  await hit('android/0.1.99', userIds[1]);
  await readVersion('android', '0.1.99', userIds[1]);
  await hit('android/../../etc/passwd');
  const rows = await prisma.clientVersion.findMany({ where: { userId: { in: userIds } }, orderBy: [{ userId: 'asc' }, { kind: 'asc' }] });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.filter((row) => row.userId === userIds[0]).map(({ kind, version }) => ({ kind, version })), [
    { kind: 'android', version: '0.1.115-test.42+fe2e1bcf9' },
    { kind: 'ios', version: '0.1.100' },
    { kind: 'macos', version: '0.1.100' },
    { kind: 'web', version: '0.1.100' },
  ]);
  console.log(`persisted client_version rows=${JSON.stringify(rows)}`);
});
