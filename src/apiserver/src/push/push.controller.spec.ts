import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PushController } from './push.controller';
import { ValidationPipe } from '@nestjs/common';
import { RegisterDeviceTokenDto, UnregisterDeviceTokenDto } from './dto';
import type { AuthUser } from '../common/current-user.decorator';

const user: AuthUser = { userId: 'u1', email: 'a@b.c' };

function makePrisma() {
  const calls: { upsert: any[]; deleteMany: any[] } = { upsert: [], deleteMany: [] };
  const prisma = {
    calls,
    $transaction: async (work: (tx: any) => Promise<any>) => work(prisma),
    deviceToken: {
      findUnique: async () => null,
      upsert: async (args: any) => {
        calls.upsert.push(args);
        return {};
      },
      deleteMany: async (args: any) => {
        calls.deleteMany.push(args);
        return { count: 1 };
      },
    },
  };
  return prisma;
}

test('register upserts by token and scopes create/update to the current user', async () => {
  const prisma = makePrisma();
  const ctrl = new PushController(prisma as any);
  const res = await ctrl.register(user, {
    token: 'abc',
    bundleId: 'io.orbitd.app',
    environment: 'production',
  } as any);
  assert.deepEqual(res, { ok: true });
  const call = prisma.calls.upsert[0];
  assert.equal(call.where.token, 'abc');
  assert.equal(call.create.userId, 'u1');
  assert.equal(call.create.token, 'abc');
  assert.equal(call.create.environment, 'production');
  assert.equal(call.update.userId, 'u1');
});

test('register defaults platform=ios and environment=production when omitted', async () => {
  const prisma = makePrisma();
  const ctrl = new PushController(prisma as any);
  await ctrl.register(user, { token: 'abc', bundleId: 'io.orbitd.app' } as any);
  const call = prisma.calls.upsert[0];
  assert.equal(call.create.platform, 'ios');
  assert.equal(call.create.environment, 'production');
});

test('unregister deletes only the caller’s matching token', async () => {
  const prisma = makePrisma();
  const ctrl = new PushController(prisma as any);
  const res = await ctrl.unregister(user, { token: 'abc' } as any);
  assert.deepEqual(res, { ok: true });
  const call = prisma.calls.deleteMany[0];
  assert.equal(call.where.token, 'abc');
  assert.equal(call.where.userId, 'u1');
  assert.equal(call.where.platform, 'ios');
});

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const android = {
  platform: 'android', token: 'opaque-fcm:token', bundleId: 'io.orbitd.android',
  installationId: '40000000-0000-4000-8000-000000000001',
};

test('HTTP DTO accepts FCM tokens, requires Android install identity and rejects unknown platforms', async () => {
  const parse = (value: unknown) => pipe.transform(value, { type: 'body', metatype: RegisterDeviceTokenDto });
  assert.equal((await parse(android)).token, android.token);
  assert.equal((await parse({ token: 'abc', bundleId: 'io.orbitd.app' })).platform, undefined);
  for (const value of [
    { ...android, platform: 'huawei' }, { ...android, installationId: undefined },
    { ...android, installationId: null }, { ...android, installationId: 'not-a-uuid' },
    { ...android, token: '' }, { ...android, token: 'x'.repeat(4097) },
  ]) await assert.rejects(parse(value));
});

test('Android cannot register against the APNs sandbox environment', async () => {
  const ctrl = new PushController(makePrisma() as any);
  await assert.rejects(ctrl.register(user, { ...android, environment: 'sandbox' }), /environment=production/);
});

test('Android logout is binding-scoped and the HTTP DTO requires its key', async () => {
  const dto = { platform: 'android', token: android.token, registrationKey: android.installationId };
  await pipe.transform(dto, { type: 'body', metatype: UnregisterDeviceTokenDto });
  await assert.rejects(pipe.transform({ platform: 'android', token: android.token },
    { type: 'body', metatype: UnregisterDeviceTokenDto }));
  const prisma = makePrisma();
  await new PushController(prisma as any).unregister(user, dto);
  assert.deepEqual(prisma.calls.deleteMany[0].where, {
    userId: 'u1', platform: 'android', token: android.token, id: dto.registrationKey,
  });
});
