/**
 * One-file share links (docs/drive-technical-design.md §9; migration 1340; share-links.service.ts putDriveFile),
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, through the real controllers' methods:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/share-links/share-links-drive-file.pg.spec.ts
 *
 *   (1) the owner shares a file: the link is pinned to the version shared; a planted key comes back as a warning naming the
 *       shape and line, never the key, and the link is created all the same;
 *   (2) the public door serves the pinned bytes with Range; an agent overwriting the file changes nothing a visitor gets
 *       until the owner shares again ("Share this version"), which moves the same link and scans again;
 *   (3) the file in Trash answers as an ended link; restored, it opens again; deleted for good, the link goes with it;
 *   (4) GET /share-links without `kind` does not list it, naming DRIVE_FILE does;
 *   (5) another account can neither share the file nor see its link, and the constraints refuse a link with two roots,
 *       a version without a file, and another account's file;
 *   (6) a save renamed onto a shared file (§3.2) keeps the link live on the file, serving the version it pinned, which
 *       is in Trash now; "Share this version" moves it to the saved content.
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

import { HttpException, NotFoundException, type StreamableFile } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { DriveChunksService } from '../drive/drive-chunks.service';
import { DriveContentService } from '../drive/drive-content.service';
import { DriveService } from '../drive/drive.service';
import { issued } from '../files/file-secret-samples.spec';
import { FilesService } from '../files/files.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { SharedController } from '../shared/shared.controller';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

// These specs share drive files, which Drive must be on for (drive/drive-switch.ts).
process.env.ORBIT_DRIVE_ENABLED = 'true';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('one-file share links: pinned to the version shared, warn on a planted key, served by the public door', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-share-drive-'));
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const files = new FilesService(db as never, { dir, storage: 'local' });
  const chunks = new DriveChunksService(db as never, files);
  const drive = new DriveService(db as never, undefined);
  const content = new DriveContentService(db as never, files);
  const links = new ShareLinksService(db as never);
  const owners = new ShareLinksController(links, drive, content);
  const door = new SharedController(links, null as never, null as never, null as never, content);

  const accountOf = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await accountOf('share-drive-owner');
  const stranger = await accountOf('share-drive-stranger');
  const as = (userId: string) => ({ userId, email: '', credential: { kind: 'LOGIN' } }) as never;

  const send = async (who: string, text: string) => {
    const bytes = Buffer.from(text);
    const staging = await chunks.openStaging(who, { source: 'TOOL' });
    await chunks.putChunk(who, staging.id, 0, sha256(bytes), Readable.from([bytes]));
    return { stagingId: staging.id, chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }] };
  };
  const fileWith = async (who: string, name: string, text: string) => {
    const handleId = randomUUID();
    const entry = await drive.createFile(who, { name, handleId, writer: { kind: 'AGENT' } });
    await drive.commit(who, { commitId: randomUUID(), entryId: entry.id, handleId, mode: 'CONTINUE', baseVersionId: entry.currentVersionId, ...(await send(who, text)), writer: { kind: 'AGENT' } });
    return entry.id;
  };
  const overwrite = async (who: string, entryId: string, text: string) => {
    const row = await db.driveEntry.findUniqueOrThrow({ where: { id: entryId } });
    await drive.commit(who, { commitId: randomUUID(), entryId, mode: 'OVERWRITE', baseVersionId: row.currentVersionId, ...(await send(who, text)), writer: { kind: 'AGENT' } });
  };
  const response = () => {
    const headers: Record<string, string> = {};
    return { headers, status: 200, res: { setHeader: (k: string, v: string) => void (headers[k] = v), status(code: number) { this.code = code; return this; }, code: 200, once: () => undefined } };
  };
  const read = async (file: StreamableFile) => {
    const parts: Buffer[] = [];
    for await (const part of file.getStream()) parts.push(part as Buffer);
    return Buffer.concat(parts).toString();
  };
  const KEY = issued('ghp_', 36);

  const entryId = await fileWith(owner, 'report.txt', `line one\nTOKEN=${KEY}\n`);
  const first = await db.driveEntry.findUniqueOrThrow({ where: { id: entryId } });
  let token = '';
  let linkId = '';

  await t.test('(1) the owner shares a file: pinned to its version, the planted key is a warning and the link is made', async () => {
    const answer = await owners.shareDriveFile(as(owner), { kind: 'DRIVE_FILE', driveEntryId: entryId });
    assert.equal(answer.link.kind, 'DRIVE_FILE');
    assert.equal(answer.link.state, 'ACTIVE');
    assert.equal(answer.warnings.length, 1);
    assert.equal(answer.warnings[0].line, 2);
    assert.ok(answer.warnings[0].kind.length > 0);
    assert.ok(!JSON.stringify(answer).includes(KEY), 'the key is never repeated');
    const row = await db.shareLink.findUniqueOrThrow({ where: { id: answer.link.id } });
    assert.equal(row.driveEntryId, entryId);
    assert.equal(row.driveVersionId, first.currentVersionId);
    token = answer.link.token;
    linkId = answer.link.id;
    const again = await owners.shareDriveFile(as(owner), { kind: 'DRIVE_FILE', driveEntryId: entryId });
    assert.equal(again.link.id, linkId, 'sharing again opens no second link');
  });

  await t.test('(2) the door serves the pinned version; an overwrite changes nothing until the owner shares it again', async () => {
    const page = await door.get(token) as { kind: string; root: { name: string; sizeBytes: number } };
    assert.equal(page.kind, 'DRIVE_FILE');
    assert.equal(page.root.name, 'report.txt');
    const whole = response();
    assert.equal(await read(await door.content(token, undefined, whole.res as never)), `line one\nTOKEN=${KEY}\n`);
    const part = response();
    assert.equal(await read(await door.content(token, 'bytes=0-3', part.res as never)), 'line');
    assert.equal(part.res.code, 206);
    assert.equal(part.headers['Content-Range'], `bytes 0-3/${page.root.sizeBytes}`);

    await overwrite(owner, entryId, 'rewritten by an agent\n');
    const after = response();
    assert.equal(await read(await door.content(token, undefined, after.res as never)), `line one\nTOKEN=${KEY}\n`, 'still the version shared');
    const listed = (await links.list(owner, ['DRIVE_FILE'])).links[0];
    assert.equal((listed.root as { pinnedIsCurrent: boolean }).pinnedIsCurrent, false);

    const moved = await owners.shareDriveFile(as(owner), { kind: 'DRIVE_FILE', driveEntryId: entryId });
    assert.equal(moved.link.id, linkId, 'the same link, moved');
    assert.equal(moved.link.token, token);
    assert.deepEqual(moved.warnings, [], 'scanned again: the new version holds no key');
    assert.equal(await read(await door.content(token, undefined, response().res as never)), 'rewritten by an agent\n');
  });

  await t.test('(3) Trash pauses the link, restore opens it, delete for good takes it', async () => {
    const trashed = await drive.moveToTrash(owner, entryId);
    await assert.rejects(door.content(token, undefined, response().res as never), NotFoundException);
    await assert.rejects(door.get(token), NotFoundException);
    await drive.restoreGroup(owner, (trashed as { trashGroupId: string }).trashGroupId);
    assert.equal(await read(await door.content(token, undefined, response().res as never)), 'rewritten by an agent\n');
    const trashedAgain = await drive.moveToTrash(owner, entryId);
    await drive.deleteGroup(owner, (trashedAgain as { trashGroupId: string }).trashGroupId);
    assert.equal(await db.shareLink.count({ where: { id: linkId } }), 0);
  });

  await t.test('(4) the list without kind does not carry it; naming DRIVE_FILE does', async () => {
    const id = await fileWith(owner, 'listed.txt', 'plain\n');
    const shared = await owners.shareDriveFile(as(owner), { kind: 'DRIVE_FILE', driveEntryId: id });
    assert.deepEqual((await links.list(owner)).links.filter((l) => l.kind === 'DRIVE_FILE'), []);
    assert.deepEqual((await links.list(owner, ['SESSION', 'TASK', 'PROJECT', 'WIKI'])).links, []);
    assert.deepEqual((await links.list(owner, ['DRIVE_FILE'])).links.map((l) => l.id), [shared.link.id]);
    assert.deepEqual((await links.list(stranger, ['DRIVE_FILE'])).links, []);
  });

  await t.test('(5) another account cannot share the file; the constraints refuse what they are for', async () => {
    const id = await fileWith(owner, 'private.txt', 'mine\n');
    await assert.rejects(owners.shareDriveFile(as(stranger), { kind: 'DRIVE_FILE', driveEntryId: id }), HttpException);
    assert.equal(await db.shareLink.count({ where: { driveEntryId: id } }), 0);
    const version = (await db.driveEntry.findUniqueOrThrow({ where: { id } })).currentVersionId!;
    const bad = (data: Record<string, unknown>) =>
      assert.rejects(db.shareLink.create({ data: { token: randomUUID(), include: {}, ...data } as never }));
    await bad({ ownerId: stranger, driveEntryId: id, driveVersionId: version }); // not the stranger's file
    await bad({ ownerId: owner, driveEntryId: id }); // a file without its version
    await bad({ ownerId: owner, driveVersionId: version }); // a version without its file
    const task = await db.task.create({ data: { ownerId: owner, title: 'x', creatorType: 'USER', creatorId: owner, completionCriterion: 'EVIDENCE_JUDGMENT' } as never });
    await bad({ ownerId: owner, driveEntryId: id, driveVersionId: version, taskId: task.id }); // two roots
  });

  await t.test('(6) a save renamed onto a shared file keeps the link on it, serving the version it pinned, until the owner moves it', async () => {
    const shared = await fileWith(owner, 'saved.txt', 'as shared\n');
    const pinned = (await db.driveEntry.findUniqueOrThrow({ where: { id: shared } })).currentVersionId!;
    const link = await owners.shareDriveFile(as(owner), { kind: 'DRIVE_FILE', driveEntryId: shared });
    // An editor's write-then-os.replace save (§3.2): the target keeps its id, the shared version goes to Trash as a version.
    const tmp = await fileWith(owner, 'saved.txt.tmp', 'as saved since\n');
    const renamed = await drive.rename(owner, tmp, { name: 'saved.txt', replace: true, writer: { kind: 'AGENT' } });
    assert.equal(renamed.id, shared, 'the file keeps its entry id');
    const row = await db.shareLink.findUniqueOrThrow({ where: { id: link.link.id } });
    assert.equal(row.revokedAt, null, 'the link is still live');
    assert.equal(row.driveEntryId, shared, 'on the same file');
    assert.equal(row.driveVersionId, pinned, 'pinned to the version shared');
    assert.notEqual((await db.driveVersion.findUniqueOrThrow({ where: { id: pinned } })).trashGroupId, null, 'which is in Trash now');
    const page = await door.get(link.link.token) as { kind: string; root: { name: string; sizeBytes: number } };
    assert.equal(page.root.name, 'saved.txt');
    assert.equal(page.root.sizeBytes, 'as shared\n'.length);
    assert.equal(await read(await door.content(link.link.token, undefined, response().res as never)), 'as shared\n', 'it serves the version it pinned');
    const listed = (await links.list(owner, ['DRIVE_FILE'])).links.find((l) => l.id === link.link.id)!;
    assert.equal((listed.root as { pinnedIsCurrent: boolean }).pinnedIsCurrent, false, 'shown as an earlier version');
    // Share this version: the same link moves to the content the save wrote.
    const moved = await owners.shareDriveFile(as(owner), { kind: 'DRIVE_FILE', driveEntryId: shared });
    assert.equal(moved.link.id, link.link.id);
    assert.equal(await read(await door.content(link.link.token, undefined, response().res as never)), 'as saved since\n');
  });
});
