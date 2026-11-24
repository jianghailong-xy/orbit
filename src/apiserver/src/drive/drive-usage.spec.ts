import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthUser } from '../common/current-user.decorator';
import { filesConfigFrom } from '../files/file-store';
import { FilesService } from '../files/files.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DriveController } from './drive.controller';

const s3Env = {
  ORBIT_DRIVE_BACKEND: 's3',
  ORBIT_DRIVE_S3_ENDPOINT: 'http://minio:9000',
  ORBIT_DRIVE_S3_BUCKET: 'orbit',
  ORBIT_DRIVE_S3_ACCESS_KEY_ID: 'key',
  ORBIT_DRIVE_S3_SECRET_ACCESS_KEY: 'secret',
};
const user = { userId: '954995fd-cffe-475e-83f3-a41624f6e623' } as AuthUser;
const accountUsage = { totalBytes: 30, driveBytes: 20, trashBytes: 2, otherBytes: 10 };

function usageRoute(quota?: string, storeBytes: number | null = null) {
  const aggregate = test.mock.fn(async (_args: unknown) => ({ _sum: { sizeBytes: storeBytes } }));
  const prisma = {
    $queryRaw: async () => [{ drive: 20n, trash: 2n, other: 10n }],
    fileBlob: { aggregate },
  } as unknown as PrismaService;
  const files = new FilesService(prisma, filesConfigFrom({ ...s3Env, ORBIT_DRIVE_STORE_QUOTA_BYTES: quota }));
  const controller = new DriveController(null!, null!, null!, null!, null!, files, null!);
  return { usage: () => controller.usage(user), aggregate };
}

test('drive usage omits store fields and skips the store query when quota is unset', async () => {
  const { usage, aggregate } = usageRoute();
  assert.deepEqual(await usage(), accountUsage);
  assert.equal(aggregate.mock.callCount(), 0);
});

test('drive usage reports S3 store bytes and warns starting at 80%', async () => {
  for (const [bytes, nearQuota] of [[null, false], [799, false], [800, true], [830, true], [1000, true]] as const) {
    const { usage, aggregate } = usageRoute('1000', bytes);
    assert.deepEqual(await usage(), { ...accountUsage, storeUsedBytes: bytes ?? 0, storeQuotaBytes: 1000, nearQuota });
    assert.deepEqual(aggregate.mock.calls[0]?.arguments, [{
      where: { storage: 's3', bytesDeletedAt: null },
      _sum: { sizeBytes: true },
    }]);
  }
});

test('drive usage shares a store read and refreshes only on a request after cache expiry', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { usage, aggregate } = usageRoute('1000', 800);
  await Promise.all([usage(), usage()]);
  now += 179_999;
  await usage();
  assert.equal(aggregate.mock.callCount(), 1);
  now += 1;
  assert.equal(aggregate.mock.callCount(), 1);
  await usage();
  assert.equal(aggregate.mock.callCount(), 2);
});
