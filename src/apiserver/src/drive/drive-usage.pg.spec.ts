/**
 * Files → Storage's total (docs/drive-technical-design.md §2.5; files/files.service.ts#driveUsage), over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-usage.pg.spec.ts
 *
 *   (1) total = drive + other, with each content counted once: bytes that an attachment and a drive chunk both hold are
 *       the drive's, and two attachments of the same bytes are one;
 *   (2) the drive's share includes what only Trash holds, and says so in `trashBytes`;
 *   (3) the attachment quota's own count (`usage`) does not move with drive bytes, so a large drive refuses no attachment;
 *   (4) another account's usage is its own: nothing of this one's is in it.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { FilesService } from '../files/files.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DriveChunksService } from './drive-chunks.service';
import { DriveService } from './drive.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('Documents drive: usage — total = drive + other storage, each content once', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-usage-'));
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const files = new FilesService(db as never, { dir, storage: 'local' });
  const chunks = new DriveChunksService(db as never, files);
  const drive = new DriveService(db as never);
  const account = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await account('usage-owner');
  const stranger = await account('usage-stranger');
  const bytesOf = (label: string, size: number) => Buffer.from(`${label}-${RUN}-`.padEnd(size, 'x'));

  /** A file with these bytes as its one chunk, as a writer makes it. */
  const fileWith = async (who: string, name: string, bytes: Buffer) => {
    const handleId = randomUUID();
    const entry = await drive.createFile(who, { name, handleId, writer: { kind: 'AGENT' } });
    const staging = await chunks.openStaging(who, { source: 'TOOL' });
    await chunks.putChunk(who, staging.id, 0, sha256(bytes), Readable.from([bytes]));
    await drive.commit(who, {
      commitId: randomUUID(), entryId: entry.id, handleId, mode: 'CONTINUE', baseVersionId: entry.currentVersionId,
      chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }], stagingId: staging.id, writer: { kind: 'AGENT' },
    });
    return entry.id;
  };
  /** An attachment row naming these bytes, whose blob is kept already or is made here. */
  const attachment = async (who: string, bytes: Buffer) => {
    const sha = sha256(bytes);
    await db.fileBlob.upsert({ where: { sha256: sha }, create: { sha256: sha, sizeBytes: bytes.length, storage: 'local' }, update: {} });
    await db.attachment.create({ data: { ownerId: who, mimeType: 'application/octet-stream', sizeBytes: bytes.length, fileName: 'a.bin', sha256: sha } });
  };

  const kept = bytesOf('kept', 1000);
  const replaced = bytesOf('replaced', 300);
  const trashed = bytesOf('trashed', 200);
  const alsoDrive = bytesOf('also-drive', 500);
  const attachmentOnly = bytesOf('attachment-only', 70);

  await fileWith(owner, 'kept.bin', kept);
  const entryId = await fileWith(owner, 'replaced.bin', replaced);
  // An overwrite puts the replaced version in Trash.
  const staging = await chunks.openStaging(owner, { source: 'TOOL' });
  const next = bytesOf('replacement', 40);
  await chunks.putChunk(owner, staging.id, 0, sha256(next), Readable.from([next]));
  await drive.commit(owner, {
    commitId: randomUUID(), entryId, mode: 'OVERWRITE', chunks: [{ idx: 0, sha256: sha256(next), size: next.length }],
    stagingId: staging.id, writer: { kind: 'AGENT' },
  });
  await drive.moveToTrash(owner, await fileWith(owner, 'trashed.bin', trashed));
  await fileWith(owner, 'also.bin', alsoDrive);
  await attachment(owner, alsoDrive);
  await attachment(owner, attachmentOnly);
  await attachment(owner, attachmentOnly);

  await t.test('(1) total = drive + other, each content once', async () => {
    const usage = await files.driveUsage(owner);
    assert.equal(usage.driveBytes, kept.length + replaced.length + next.length + trashed.length + alsoDrive.length);
    assert.equal(usage.otherBytes, attachmentOnly.length, 'bytes a drive row names are the drive\'s, and the same bytes twice are one');
    assert.equal(usage.totalBytes, usage.driveBytes + usage.otherBytes);
  });

  await t.test('(2) the drive\'s share includes what only Trash holds', async () => {
    const usage = await files.driveUsage(owner);
    assert.equal(usage.trashBytes, replaced.length + trashed.length);
  });

  await t.test('(3) the attachment count is the attachments\' alone, so the quota is untouched by the drive', async () => {
    const usage = await files.usage(owner);
    assert.equal(usage.totalBytes, alsoDrive.length + attachmentOnly.length);
  });

  await t.test('(4) another account sees none of it', async () => {
    assert.deepEqual(await files.driveUsage(stranger), { totalBytes: 0, driveBytes: 0, trashBytes: 0, otherBytes: 0 });
    await fileWith(stranger, 'theirs.bin', bytesOf('theirs', 40));
    assert.equal((await files.driveUsage(stranger)).totalBytes, 40);
    assert.equal((await files.driveUsage(owner)).driveBytes, kept.length + replaced.length + next.length + trashed.length + alsoDrive.length);
  });
});
