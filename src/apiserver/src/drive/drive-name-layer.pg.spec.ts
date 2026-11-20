/**
 * The drive's name layer (docs/orbit-files-drive-technical-design.md §1, §3, §5.4; migration 1327; drive/drive.service.ts),
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with chunks kept on a files directory of this
 * run's through the chunk door:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-name-layer.pg.spec.ts
 *
 *   (1)  an overwrite makes a version and puts the previous one in Trash, in a VERSION group the owner restores;
 *   (2)  an append makes no version: the current version grows in place; a tail that moved is answered 409 with the tail
 *        as it is; an append onto a base overwritten meanwhile becomes an overwrite of base plus appended bytes;
 *   (3)  a created file's handle fills its empty first version with CONTINUE; a retried commit id applies nothing twice;
 *        a chunk the account does not hold is refused;
 *   (4)  an `rm -rf` of a folder as the mount sends it (leaves first, then the folders bottom-up, one burst key) is ONE
 *        Trash group whose top item is the folder, and restoring it brings back the whole tree with its ids and names;
 *   (5)  the owner's delete of a folder is one group that restores whole;
 *   (6)  a restore whose name a live entry took gets the first free suffix, files `a (2).txt`, folders `dir (2)`; a
 *        restore whose folder is in Trash makes the folder again;
 *   (7)  nothing in Trash is listed or reached by a path; only the owner's Trash reads show it;
 *   (8)  last-writer fields: the owner, and an agent's session only when it is the owner's and on the runner it came from;
 *   (9)  a folder cannot move into itself; an owner rename onto a taken name is refused; a door rename onto a file
 *        moves the source, keeping its id, into the target's place and puts the target in Trash whole; a write into a
 *        folder in Trash is refused;
 *   (10) the change feed answers every change, and its look-back delivers a row whose transaction committed after a higher
 *        seq was read; `drive.changed` is announced after each committed change;
 *   (11) delete for good and Empty Trash remove the rows, chunk rows included;
 *   (12) another account's entry, version and group are not found, and its chunks cannot be named;
 *   (13) the retention sweep's step 0 prunes commit answers and feed rows older than a day;
 *   (14) handles are bound to entry ids (§3.1): an editor's save (`open a.tmp; write; rename a.tmp a.txt; close`)
 *        commits after the rename and its bytes are a.txt's; the a.txt it replaced is restored from Trash; a commit,
 *        CONTINUE or OVERWRITE, to an entry in Trash (deleted, or replaced by a rename) lands in it and it stays in Trash.
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

import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { FileRetentionSweep } from '../files/file-retention-sweep';
import { FilesService } from '../files/files.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DriveChunksService } from './drive-chunks.service';
import {
  DRIVE_CHUNK_NOT_HELD,
  DRIVE_ENTRY_NOT_FOUND,
  DRIVE_MOVE_INTO_ITSELF,
  DRIVE_NAME_TAKEN,
  DRIVE_PARENT_GONE,
  DRIVE_TAIL_MOVED,
  DRIVE_TRASH_GROUP_NOT_FOUND,
  DRIVE_VERSION_NOT_FOUND,
  DriveService,
  type DriveCommitInput,
  type DriveWriter,
} from './drive.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function refusedWith(promise: Promise<unknown>, status: number, code: string): Promise<HttpException> {
  let caught: HttpException | undefined;
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpException, `an HttpException, not ${String(error)}`);
    assert.equal(error.getStatus(), status);
    assert.equal((error.getResponse() as { code: string }).code, code);
    caught = error;
    return true;
  });
  return caught!;
}

test('Orbit Files drive: the name layer — versions, append, Trash groups, restore with suffixes, the change feed', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-names-'));
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const files = new FilesService(db as never, { dir, storage: 'local' });
  const chunks = new DriveChunksService(db as never, files);
  const announced: Array<{ ownerId: string; seq: number }> = [];
  const realtime = { publishDriveChanged: (ownerId: string, seq: number) => announced.push({ ownerId, seq }) };
  const drive = new DriveService(db as never, realtime as never);

  const accountOf = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await accountOf('drive-names-owner');
  const stranger = await accountOf('drive-names-stranger');

  /** Bytes sent through the chunk door into a staging of `who`'s, one chunk per part: what a writer names in a commit. */
  const send = async (who: string, parts: Array<string | Buffer>, firstIdx = 0) => {
    const staging = await chunks.openStaging(who, { source: 'TOOL' });
    const refs = [];
    for (const [i, part] of parts.entries()) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      await chunks.putChunk(who, staging.id, firstIdx + i, sha256(bytes), Readable.from([bytes]));
      refs.push({ idx: firstIdx + i, sha256: sha256(bytes), size: bytes.length });
    }
    return { stagingId: staging.id, chunks: refs };
  };
  const commit = async (who: string, input: Omit<DriveCommitInput, 'commitId' | 'writer' | 'chunks' | 'stagingId'> & { parts: Array<string | Buffer>; firstIdx?: number; commitId?: string; writer?: DriveWriter }) => {
    const sent = await send(who, input.parts, input.firstIdx ?? 0);
    return drive.commit(who, {
      commitId: input.commitId ?? randomUUID(),
      entryId: input.entryId,
      handleId: input.handleId,
      mode: input.mode,
      baseVersionId: input.baseVersionId,
      baseSize: input.baseSize,
      replaceTail: input.replaceTail,
      chunks: sent.chunks,
      stagingId: sent.stagingId,
      writer: input.writer ?? { kind: 'AGENT' },
    });
  };
  /** A version's bytes, chunk after chunk from the store. */
  const bytesOf = async (versionId: string) => {
    const rows = await db.driveVersionChunk.findMany({ where: { versionId }, orderBy: { idx: 'asc' } });
    const parts: Buffer[] = [];
    let offset = 0;
    for (const row of rows) {
      assert.equal(Number(row.offset), offset, `chunk ${row.idx} sits where the ones before it end`);
      offset += row.sizeBytes;
      const stream = await files.storeOf('local')!.open(row.sha256);
      for await (const part of stream!) parts.push(part as Buffer);
    }
    return Buffer.concat(parts).toString();
  };
  const textOf = async (entryId: string) => bytesOf((await db.driveEntry.findUniqueOrThrow({ where: { id: entryId } })).currentVersionId!);
  /** A file with content, as a writer makes one: created with an empty first version, then filled by its handle. */
  const fileWith = async (parentId: string | null, name: string, text: string, who = owner) => {
    const handleId = randomUUID();
    const entry = await drive.createFile(who, { parentId, name, handleId, writer: { kind: 'AGENT' } });
    await commit(who, { entryId: entry.id, handleId, mode: 'CONTINUE', baseVersionId: entry.currentVersionId, parts: [text] });
    return entry.id;
  };
  const versionsOf = (entryId: string) => db.driveVersion.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } });
  const names = async (parentId?: string) => (await drive.list(owner, { parentId })).entries.map((e) => e.name);

  const root = await drive.ensureRoot(owner);
  assert.equal(root.parentId, null);
  assert.equal(root.name, '');
  assert.equal((await drive.ensureRoot(owner)).id, root.id, 'one root per account');

  await t.test('(3) a created file is filled by its handle with CONTINUE; a retried commit id applies nothing twice; a chunk not held is refused', async () => {
    const handleId = randomUUID();
    const entry = await drive.createFile(owner, { name: 'notes.txt', handleId, writer: { kind: 'AGENT' } });
    assert.equal(entry.sizeBytes, 0);
    const first = await versionsOf(entry.id);
    assert.equal(first.length, 1, 'an empty first version, at once');
    const commitId = randomUUID();
    const once = await commit(owner, { entryId: entry.id, handleId, mode: 'CONTINUE', baseVersionId: entry.currentVersionId, parts: ['hello ', 'world'], commitId });
    assert.equal(once.newVersion, false, 'the handle continues the version it is writing');
    assert.equal(once.versionId, entry.currentVersionId);
    assert.equal(await textOf(entry.id), 'hello world');
    const again = await commit(owner, { entryId: entry.id, handleId, mode: 'OVERWRITE', baseVersionId: entry.currentVersionId, parts: ['something else'], commitId });
    assert.equal(again.replayed, true, 'answered as the first');
    assert.deepEqual({ ...again, replayed: false }, { ...once, replayed: false });
    assert.equal(await textOf(entry.id), 'hello world', 'and applied nothing');
    assert.equal((await versionsOf(entry.id)).length, 1);
    assert.equal((await db.driveEntry.findUniqueOrThrow({ where: { id: entry.id } })).sizeBytes, 11n);

    const foreign = Buffer.from(`stranger's own content ${RUN}`);
    await send(stranger, [foreign]);
    await refusedWith(drive.commit(owner, {
      commitId: randomUUID(), entryId: entry.id, mode: 'OVERWRITE', chunks: [{ idx: 0, sha256: sha256(foreign), size: foreign.length }],
      writer: { kind: 'OWNER' },
    }), 409, DRIVE_CHUNK_NOT_HELD);
    assert.equal(await textOf(entry.id), 'hello world', 'content another account stored is never named on its sha256 alone');
  });

  await t.test('(1) an overwrite makes a version and puts the previous one in Trash, which the owner restores', async () => {
    const id = await fileWith(null, 'report.md', 'draft one');
    const before = await db.driveEntry.findUniqueOrThrow({ where: { id } });
    const answer = await commit(owner, { entryId: id, handleId: randomUUID(), mode: 'OVERWRITE', baseVersionId: before.currentVersionId, parts: ['draft two'] });
    assert.equal(answer.newVersion, true);
    assert.equal(answer.replacedVersionId, before.currentVersionId);
    assert.equal(await textOf(id), 'draft two');
    const versions = await versionsOf(id);
    assert.equal(versions.length, 2, 'the overwrite kept the previous version');
    const replaced = versions.find((v) => v.id === before.currentVersionId)!;
    assert.notEqual(replaced.replacedAt, null);
    assert.equal(replaced.trashGroupId, answer.trashGroupId);
    const group = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: answer.trashGroupId! } });
    assert.equal(group.kind, 'VERSION');
    assert.equal(group.folderPath, '/');
    assert.equal(group.itemCount, 1);
    const trash = await drive.trash(owner);
    const listed = trash.groups.find((g) => g.id === group.id);
    assert.ok(listed, 'the replaced version is listed in Trash');
    assert.equal(listed.version?.id, replaced.id);
    assert.equal(listed.version?.entry.name, 'report.md');

    // The owner restores it from Trash: it is current again, and what replaced it is in Trash in its turn.
    await drive.restoreGroup(owner, group.id);
    assert.equal(await textOf(id), 'draft one');
    assert.equal(await db.driveTrashGroup.findUnique({ where: { id: group.id } }), null, 'the group is gone from Trash');
    const after = await versionsOf(id);
    assert.equal(after.length, 2);
    const nowReplaced = after.find((v) => v.id === answer.versionId)!;
    assert.notEqual(nowReplaced.trashGroupId, null, 'the overwriting version went to Trash in its turn');
    assert.equal((await drive.versions(owner, id)).versions.filter((v) => v.current).length, 1);

    // Restored as a copy instead: a new file beside it, named by the suffix rule; the chosen version stays in Trash.
    const copy = await drive.restoreVersion(owner, nowReplaced.id, 'COPY');
    assert.equal(copy.name, 'report (2).md');
    assert.equal(await textOf(copy.id), 'draft two');
    assert.notEqual((await db.driveVersion.findUniqueOrThrow({ where: { id: nowReplaced.id } })).trashGroupId, null);
  });

  await t.test('(2) an append makes no version; a moved tail is answered with the tail; an append onto an overwritten base is an overwrite', async () => {
    const id = await fileWith(null, 'build.log', 'line 1\n');
    const entry = await db.driveEntry.findUniqueOrThrow({ where: { id } });
    const v = entry.currentVersionId!;
    const groupsBefore = await db.driveTrashGroup.count({ where: { ownerId: owner } });

    // A small tail is replaced by itself plus the appended bytes, as the daemon builds it.
    const tail = await db.driveVersionChunk.findFirstOrThrow({ where: { versionId: v }, orderBy: { idx: 'desc' } });
    const one = await commit(owner, {
      entryId: id, mode: 'APPEND', baseVersionId: v, replaceTail: { idx: tail.idx, oldSha256: tail.sha256 }, firstIdx: tail.idx, parts: ['line 1\nline 2\n'],
    });
    assert.equal(one.newVersion, false);
    assert.equal(one.versionId, v);
    // Appended bytes as chunks of their own after the end.
    const two = await commit(owner, { entryId: id, mode: 'APPEND', baseVersionId: v, baseSize: 14, firstIdx: 1, parts: ['line 3\n', 'line 4\n'] });
    assert.equal(two.newVersion, false);
    assert.equal(await textOf(id), 'line 1\nline 2\nline 3\nline 4\n');
    assert.equal((await versionsOf(id)).length, 1, 'no version for an append');
    assert.equal(await db.driveTrashGroup.count({ where: { ownerId: owner } }), groupsBefore, 'and nothing in Trash');
    const grown = await db.driveEntry.findUniqueOrThrow({ where: { id } });
    assert.equal(grown.sizeBytes, 28n);
    assert.ok(grown.seq > entry.seq, 'seq moves on an append too: it is the cache key');

    // Another appender came first: answered with the tail as it is, and nothing applied.
    const moved = await refusedWith(
      commit(owner, { entryId: id, mode: 'APPEND', baseVersionId: v, baseSize: 14, firstIdx: 1, parts: ['late\n'] }),
      409, DRIVE_TAIL_MOVED,
    );
    const body = moved.getResponse() as { tail: { idx: number }; sizeBytes: number };
    assert.equal(body.sizeBytes, 28);
    assert.equal(body.tail.idx, 2);
    assert.equal(await textOf(id), 'line 1\nline 2\nline 3\nline 4\n');

    // Overwritten meanwhile: the append lands as an overwrite of the base plus the appended bytes, the newer content in Trash.
    const over = await commit(owner, { entryId: id, mode: 'OVERWRITE', baseVersionId: v, parts: ['rewritten\n'] });
    const late = await commit(owner, { entryId: id, mode: 'APPEND', baseVersionId: v, baseSize: 28, firstIdx: 3, parts: ['line 5\n'] });
    assert.equal(late.newVersion, true);
    assert.equal(await textOf(id), 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'last write wins');
    const kept = await db.driveVersion.findUniqueOrThrow({ where: { id: over.versionId } });
    assert.notEqual(kept.trashGroupId, null, 'and the content it replaced is in Trash: nothing is lost');
  });

  await t.test('(4) an rm -rf through the mount is one Trash group that restores whole', async () => {
    const project = await drive.createFolder(owner, { name: 'Project' });
    const out = await drive.createFolder(owner, { parentId: project.id, name: 'out' });
    const deep = await drive.createFolder(owner, { parentId: out.id, name: 'deep' });
    const a = await fileWith(out.id, 'a.txt', 'A');
    const b = await fileWith(out.id, 'b.txt', 'B');
    const c = await fileWith(deep.id, 'c.txt', 'C');
    const agent: DriveWriter = { kind: 'AGENT' };
    const burstKey = `mount-${RUN}-1`;
    // As the kernel sends `rm -rf out`: the leaves first, then the folders bottom-up.
    const answers = [];
    for (const id of [c, a, b, deep.id, out.id]) answers.push(await drive.moveToTrash(owner, id, { writer: agent, burstKey }));
    const groupIds = new Set(answers.map((x) => x.trashGroupId));
    assert.equal(groupIds.size, 1, 'one group for the whole rm -rf');
    const groupId = answers[0].trashGroupId;
    const group = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: groupId } });
    assert.equal(group.itemCount, 5, 'out, deep and the three files');
    assert.equal(group.folderId, project.id, 'deleted from the folder out was in');
    assert.equal(group.folderPath, '/Project');
    const tops = await db.driveEntry.findMany({ where: { trashGroupId: groupId, trashTop: true } });
    assert.deepEqual(tops.map((e) => e.id), [out.id], 'the folder is the group\'s one top-level item');
    const listed = (await drive.trash(owner)).groups.find((g) => g.id === groupId)!;
    assert.deepEqual(listed.items.map((i) => i.name), ['out']);
    assert.equal(listed.itemCount, 5);
    assert.deepEqual((await drive.trashGroup(owner, groupId, { parentId: out.id })).entries.map((e) => e.name), ['a.txt', 'b.txt', 'deep']);
    assert.deepEqual(await names(project.id), [], 'nothing of it is live');

    // A delete with the same key after the window opens a group of its own.
    const later = await fileWith(project.id, 'later.txt', 'L');
    await db.driveTrashGroup.update({ where: { id: groupId }, data: { lastAddedAt: new Date(Date.now() - 11_000) } });
    const separate = await drive.moveToTrash(owner, later, { writer: agent, burstKey });
    assert.notEqual(separate.trashGroupId, groupId);

    // The owner restores the group: the whole tree is back, same ids, same names, same content.
    const restored = await drive.restoreGroup(owner, groupId);
    assert.equal(restored.entryIds.length, 5);
    assert.deepEqual(await names(project.id), ['out']);
    assert.deepEqual(await names(out.id), ['a.txt', 'b.txt', 'deep']);
    assert.deepEqual(await names(deep.id), ['c.txt']);
    assert.equal(await textOf(c), 'C');
    assert.equal((await drive.resolve(owner, '/Project/out/deep/c.txt')).id, c);
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner, trashGroupId: groupId } }), 0);
    assert.equal(await db.driveTrashGroup.findUnique({ where: { id: groupId } }), null);
  });

  await t.test('(5) the owner\'s delete of a folder is one group, closed at once, that restores whole', async () => {
    const photos = await drive.createFolder(owner, { name: 'Photos' });
    const trip = await drive.createFolder(owner, { parentId: photos.id, name: 'Trip' });
    await fileWith(trip.id, '1.jpg', 'one');
    await fileWith(trip.id, '2.jpg', 'two');
    await fileWith(photos.id, 'cover.jpg', 'cover');
    const { trashGroupId } = await drive.moveToTrash(owner, photos.id);
    const group = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: trashGroupId } });
    assert.equal(group.kind, 'DELETE');
    assert.notEqual(group.closedAt, null);
    assert.equal(group.itemCount, 5);
    assert.equal(group.sizeBytes, 11n);
    assert.equal(group.actorKind, 'OWNER');
    assert.equal(await db.driveEntry.count({ where: { trashGroupId } }), 5, 'every descendant carries the group');
    await drive.restoreGroup(owner, trashGroupId);
    assert.deepEqual((await names(photos.id)).sort(), ['Trip', 'cover.jpg'].sort());
    assert.deepEqual(await names(trip.id), ['1.jpg', '2.jpg']);
  });

  await t.test('(6) a restore whose name was taken gets a suffix; a restore whose folder is in Trash makes it again', async () => {
    const docs = await drive.createFolder(owner, { name: 'Docs' });
    const old = await fileWith(docs.id, 'a.txt', 'old');
    const { trashGroupId: g1 } = await drive.moveToTrash(owner, old);
    const fresh = await fileWith(docs.id, 'a.txt', 'new');
    await drive.restoreGroup(owner, g1);
    assert.deepEqual(await names(docs.id), ['a (2).txt', 'a.txt']);
    assert.equal((await db.driveEntry.findUniqueOrThrow({ where: { id: old } })).name, 'a (2).txt');
    assert.equal(await textOf(old), 'old');
    assert.equal(await textOf(fresh), 'new', 'the live file was not overwritten');

    // A folder: `dir (2)`, the suffix at the end. A file with no extension likewise.
    const dirA = await drive.createFolder(owner, { parentId: docs.id, name: 'v1.0' });
    await fileWith(dirA.id, 'README', 'r');
    const { trashGroupId: g2 } = await drive.moveToTrash(owner, dirA.id);
    await drive.createFolder(owner, { parentId: docs.id, name: 'v1.0' });
    await drive.restoreGroup(owner, g2);
    assert.ok((await names(docs.id)).includes('v1.0 (2)'), 'a folder gets the suffix at the end, not before its dot');
    assert.deepEqual(await names(dirA.id), ['README']);

    // The owner's new folder whose name is taken gets the suffix too (board choice d).
    assert.equal((await drive.createFolder(owner, { parentId: docs.id, name: 'v1.0' })).name, 'v1.0 (3)');

    // The file's own folder is in Trash: the folder is made again, live, and the file goes there.
    const inner = await drive.createFolder(owner, { parentId: docs.id, name: 'inner' });
    const kept = await fileWith(inner.id, 'kept.txt', 'k');
    const { trashGroupId: gFile } = await drive.moveToTrash(owner, kept);
    const { trashGroupId: gFolder } = await drive.moveToTrash(owner, inner.id);
    assert.notEqual(gFile, gFolder);
    await drive.restoreGroup(owner, gFile);
    const remade = await drive.resolve(owner, '/Docs/inner');
    assert.notEqual(remade.id, inner.id, 'a new folder, the old one still in Trash');
    assert.equal((await drive.resolve(owner, '/Docs/inner/kept.txt')).id, kept);
    assert.notEqual((await db.driveEntry.findUniqueOrThrow({ where: { id: inner.id } })).trashedAt, null);
    // Restoring the folder later finds its name taken by the one made again.
    await drive.restoreGroup(owner, gFolder);
    assert.ok((await names(docs.id)).includes('inner (2)'));
  });

  await t.test('(7) nothing in Trash is listed or reached by a path', async () => {
    const box = await drive.createFolder(owner, { name: 'Box' });
    const gone = await fileWith(box.id, 'gone.txt', 'g');
    await drive.moveToTrash(owner, gone);
    assert.deepEqual(await names(box.id), []);
    await refusedWith(drive.resolve(owner, '/Box/gone.txt'), 404, DRIVE_ENTRY_NOT_FOUND);
    const { trashGroupId } = await drive.moveToTrash(owner, box.id);
    assert.ok(!(await names()).includes('Box'));
    await refusedWith(drive.resolve(owner, '/Box'), 404, DRIVE_ENTRY_NOT_FOUND);
    await refusedWith(drive.list(owner, { parentId: box.id }), 404, DRIVE_ENTRY_NOT_FOUND);
    // The owner's own read of an entry still says where it is, and that it is in Trash.
    const seen = await drive.get(owner, box.id);
    assert.equal(seen.trashGroupId, trashGroupId);
    assert.equal(seen.path, '/Box');
  });

  await t.test('(8) last-writer fields: the owner, and an agent\'s session only when it is the owner\'s on that runner', async () => {
    const runnerId = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: owner, name: `drive-runner-${RUN}`, tokenHash: sha256(Buffer.from(`drive-${RUN}`)) } });
    const workspace = await db.workspace.create({ data: { ownerId: owner, runnerId, name: `drive-ws-${RUN}`, enabled: true } });
    const session = await db.session.create({
      data: {
        title: 'drive writer', prompt: 'drive writer', ownerId: owner, creatorId: owner, workspaceId: workspace.id,
        assignedRunnerId: runnerId, status: 'AWAITING_INPUT', startedAt: new Date(),
      },
    });
    const id = await fileWith(null, 'attributed.txt', 'x');
    const entry = await db.driveEntry.findUniqueOrThrow({ where: { id } });
    await commit(owner, { entryId: id, mode: 'OVERWRITE', baseVersionId: entry.currentVersionId, parts: ['y'], writer: { kind: 'AGENT', sessionId: session.id, runnerId } });
    let row = await db.driveEntry.findUniqueOrThrow({ where: { id }, include: { currentVersion: true } });
    assert.equal(row.lastWriterKind, 'AGENT');
    assert.equal(row.lastWriterSessionId, session.id);
    assert.equal(row.lastWriterRunnerId, runnerId);
    assert.equal(row.currentVersion!.writerSessionId, session.id, 'a commit sets them on the version too');
    // A session not on the runner the write came through is dropped: "an agent on Orbit Cloud".
    await commit(owner, { entryId: id, mode: 'OVERWRITE', baseVersionId: row.currentVersionId, parts: ['z'], writer: { kind: 'AGENT', sessionId: session.id, runnerId: randomUUID() } });
    row = await db.driveEntry.findUniqueOrThrow({ where: { id }, include: { currentVersion: true } });
    assert.equal(row.lastWriterSessionId, null);
    // The owner's rename is the owner's.
    await drive.rename(owner, id, { name: 'renamed.txt' });
    row = await db.driveEntry.findUniqueOrThrow({ where: { id }, include: { currentVersion: true } });
    assert.equal(row.lastWriterKind, 'OWNER');
    assert.equal(row.lastWriterSessionId, null);
    assert.ok(row.lastWrittenAt.getTime() >= row.createdAt.getTime());
  });

  await t.test('(9) moves into itself, taken names and writes into Trash are refused; a door rename onto a file takes its place and puts it in Trash', async () => {
    const top = await drive.createFolder(owner, { name: 'Top' });
    const mid = await drive.createFolder(owner, { parentId: top.id, name: 'Mid' });
    await refusedWith(drive.rename(owner, top.id, { parentId: mid.id }), 409, DRIVE_MOVE_INTO_ITSELF);
    await refusedWith(drive.rename(owner, top.id, { parentId: top.id }), 409, DRIVE_MOVE_INTO_ITSELF);
    const x = await fileWith(top.id, 'x.txt', 'x');
    const y = await fileWith(top.id, 'y.txt', 'y');
    await refusedWith(drive.rename(owner, x, { name: 'y.txt' }), 409, DRIVE_NAME_TAKEN);
    const moved = await drive.rename(owner, x, { parentId: mid.id });
    assert.equal(moved.parentId, mid.id);
    // A save by write-then-replace: the source keeps its id and takes the target's place; the target goes to Trash whole.
    const tmp = await fileWith(top.id, '.y.txt.swp', 'y edited');
    const onto = await drive.rename(owner, tmp, { name: 'y.txt', replace: true, writer: { kind: 'AGENT' } });
    assert.equal(onto.id, tmp);
    assert.equal((await drive.resolve(owner, '/Top/y.txt')).id, tmp);
    assert.equal(await textOf(tmp), 'y edited');
    const replaced = await db.driveEntry.findUniqueOrThrow({ where: { id: y } });
    assert.notEqual(replaced.trashGroupId, null, 'the replaced file is in Trash, not deleted');
    assert.equal(replaced.trashTop, true);
    assert.equal(await textOf(y), 'y', 'with its content');
    // A folder in Trash takes no new entries.
    await drive.moveToTrash(owner, mid.id);
    await refusedWith(drive.createFolder(owner, { parentId: mid.id, name: 'late' }), 404, DRIVE_PARENT_GONE);
    await refusedWith(drive.createFile(owner, { parentId: mid.id, name: 'late.txt' }), 404, DRIVE_PARENT_GONE);
    await refusedWith(drive.rename(owner, tmp, { parentId: mid.id }), 404, DRIVE_PARENT_GONE);
  });

  await t.test('(14) an editor\'s save commits after its rename into the new path; the replaced file restores; a commit into Trash stays there', async () => {
    const work = await drive.createFolder(owner, { name: 'Editor' });
    const original = await fileWith(work.id, 'a.txt', 'the original');
    const originalVersion = (await db.driveEntry.findUniqueOrThrow({ where: { id: original } })).currentVersionId!;
    // A handle that has the original open too, and will commit after it is replaced.
    const otherHandle = randomUUID();
    await db.driveVersion.update({ where: { id: originalVersion }, data: { handleId: otherHandle } });

    // open a.tmp; write; rename a.tmp a.txt; close: the close's commit comes after the rename.
    const handle = randomUUID();
    const tmp = await drive.createFile(owner, { parentId: work.id, name: 'a.tmp', handleId: handle, writer: { kind: 'AGENT' } });
    const renamed = await drive.rename(owner, tmp.id, { name: 'a.txt', replace: true, writer: { kind: 'AGENT' } });
    assert.equal(renamed.id, tmp.id, 'the source keeps its id');
    const closed = await commit(owner, { entryId: tmp.id, handleId: handle, mode: 'CONTINUE', baseVersionId: tmp.currentVersionId, parts: ['the edited text'] });
    assert.equal(closed.newVersion, false, 'the handle filled the version it was writing');
    const atPath = await drive.resolve(owner, '/Editor/a.txt');
    assert.equal(atPath.id, tmp.id);
    assert.equal(await textOf(atPath.id), 'the edited text', 'the bytes are under the new path');
    assert.deepEqual(await names(work.id), ['a.txt'], 'and a.tmp is gone from the folder');

    // The handle still open on the replaced file commits into it, in Trash: not lost, and not back at its old path.
    const replaced = await db.driveEntry.findUniqueOrThrow({ where: { id: original } });
    assert.notEqual(replaced.trashedAt, null);
    const late = await commit(owner, { entryId: original, handleId: otherHandle, mode: 'CONTINUE', baseVersionId: originalVersion, parts: ['the original, finished'] });
    assert.equal(late.newVersion, false);
    assert.equal(await textOf(original), 'the original, finished');
    const stillTrashed = await db.driveEntry.findUniqueOrThrow({ where: { id: original } });
    assert.notEqual(stillTrashed.trashedAt, null, 'it stays in Trash');
    assert.equal(stillTrashed.trashGroupId, replaced.trashGroupId);
    assert.equal((await drive.resolve(owner, '/Editor/a.txt')).id, tmp.id, 'the live a.txt is still the saved one');

    // The owner restores the replaced file from Trash: back beside the saved one, with a suffix, and its own content.
    const listed = (await drive.trash(owner)).groups.find((g) => g.id === replaced.trashGroupId)!;
    assert.deepEqual(listed.items.map((i) => i.id), [original]);
    await drive.restoreGroup(owner, replaced.trashGroupId!);
    assert.deepEqual((await names(work.id)).sort(), ['a (2).txt', 'a.txt']);
    assert.equal((await drive.resolve(owner, '/Editor/a (2).txt')).id, original);
    assert.equal(await textOf(original), 'the original, finished');

    // A commit to a deleted file lands in it in Trash, CONTINUE and OVERWRITE alike, and never brings it back.
    const h = randomUUID();
    const doomed = await drive.createFile(owner, { parentId: work.id, name: 'doomed.log', handleId: h, writer: { kind: 'AGENT' } });
    const { trashGroupId } = await drive.moveToTrash(owner, doomed.id, { writer: { kind: 'AGENT' }, burstKey: `mount-${RUN}-14` });
    await commit(owner, { entryId: doomed.id, handleId: h, mode: 'CONTINUE', baseVersionId: doomed.currentVersionId, parts: ['written after unlink'] });
    assert.equal(await textOf(doomed.id), 'written after unlink');
    const after = await db.driveEntry.findUniqueOrThrow({ where: { id: doomed.id } });
    await commit(owner, { entryId: doomed.id, mode: 'OVERWRITE', baseVersionId: after.currentVersionId, parts: ['overwritten in Trash'] });
    assert.equal(await textOf(doomed.id), 'overwritten in Trash');
    const finalRow = await db.driveEntry.findUniqueOrThrow({ where: { id: doomed.id } });
    assert.notEqual(finalRow.trashedAt, null, 'still in Trash');
    assert.equal(finalRow.trashGroupId, trashGroupId);
    assert.equal(finalRow.parentId, work.id, 'and still at its original place in Trash');
    assert.ok(!(await names(work.id)).includes('doomed.log'), 'not listed');
    await refusedWith(drive.resolve(owner, '/Editor/doomed.log'), 404, DRIVE_ENTRY_NOT_FOUND);
    // Restored, it comes back with what was written to it in Trash.
    await drive.restoreGroup(owner, trashGroupId);
    assert.equal(await textOf((await drive.resolve(owner, '/Editor/doomed.log')).id), 'overwritten in Trash');
  });

  await t.test('(10) the change feed answers every change, and its look-back delivers a row that committed late', async () => {
    const start = await drive.changes(owner);
    assert.equal(start.changes.length, 0);
    const before = announced.length;
    const folder = await drive.createFolder(owner, { name: 'Feed' });
    const file = await fileWith(folder.id, 'f.txt', 'f');
    await drive.moveToTrash(owner, file);
    const read = await drive.changes(owner, start.cursor);
    const mine = read.changes.filter((c) => c.entryId === folder.id || c.entryId === file);
    assert.deepEqual(mine.map((c) => [c.entryId === folder.id ? 'folder' : 'file', c.op]), [
      ['folder', 'UPSERT'], ['file', 'UPSERT'], ['file', 'UPSERT'], ['file', 'REMOVE'],
    ]);
    assert.ok(announced.length >= before + 4, 'each committed change was announced');
    assert.equal(announced.at(-1)!.seq, read.changes.at(-1)!.seq);
    assert.equal(announced.at(-1)!.ownerId, owner);
    assert.equal((await db.driveEntry.findUniqueOrThrow({ where: { id: file } })).seq, BigInt(mine.at(-1)!.seq));

    // A transaction takes a seq and commits after a higher one has been read.
    const slow = new Client({ connectionString: url });
    await slow.connect();
    try {
      await slow.query('BEGIN');
      const late = await slow.query<{ seq: string }>(
        `INSERT INTO "drive_change" ("owner_id", "entry_id", "parent_id", "op") VALUES ($1, $2, $3, 'UPSERT') RETURNING "seq"::text`,
        [owner, folder.id, root.id],
      );
      await drive.createFolder(owner, { name: 'After' });
      const first = await drive.changes(owner, read.cursor);
      assert.ok(!first.changes.some((c) => c.seq === Number(late.rows[0].seq)), 'not committed yet, so not seen');
      assert.ok(Number(first.cursor.split(':')[0]) > Number(late.rows[0].seq), 'the cursor is past it');
      await slow.query('COMMIT');
      const next = await drive.changes(owner, first.cursor);
      assert.ok(next.changes.some((c) => c.seq === Number(late.rows[0].seq)), 'the look-back delivers it');
    } finally {
      await slow.end();
    }
    // A cursor past the feed's end (a database restored to an earlier point) asks for a resync.
    assert.equal((await drive.changes(owner, `${Number.MAX_SAFE_INTEGER}:${Date.now()}`)).resync, true);
    assert.equal((await drive.changes(owner, `1:${Date.now() - 2 * DAY}`)).resync, true, 'and so does one older than the kept feed');
  });

  await t.test('(11) delete for good and Empty Trash remove the rows, chunk rows included', async () => {
    const tmp = await drive.createFolder(owner, { name: 'Tmp' });
    const f = await fileWith(tmp.id, 't.txt', 'tmp');
    const fVersion = (await db.driveEntry.findUniqueOrThrow({ where: { id: f } })).currentVersionId!;
    const { trashGroupId } = await drive.moveToTrash(owner, tmp.id);
    await drive.deleteGroup(owner, trashGroupId);
    assert.equal(await db.driveEntry.count({ where: { id: { in: [tmp.id, f] } } }), 0);
    assert.equal(await db.driveVersionChunk.count({ where: { versionId: fVersion } }), 0);
    assert.equal(await db.driveTrashGroup.findUnique({ where: { id: trashGroupId } }), null);

    const one = await fileWith(null, 'one-version.txt', 'v1');
    const e = await db.driveEntry.findUniqueOrThrow({ where: { id: one } });
    await commit(owner, { entryId: one, mode: 'OVERWRITE', baseVersionId: e.currentVersionId, parts: ['v2'] });
    await drive.deleteVersion(owner, e.currentVersionId!);
    assert.equal(await db.driveVersion.findUnique({ where: { id: e.currentVersionId! } }), null);
    assert.equal((await versionsOf(one)).length, 1);

    assert.ok(await db.driveTrashGroup.count({ where: { ownerId: owner } }) > 0, 'Trash holds things before it is emptied');
    await drive.emptyTrash(owner);
    assert.equal(await db.driveTrashGroup.count({ where: { ownerId: owner } }), 0);
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner, trashedAt: { not: null } } }), 0);
    assert.equal(await db.driveVersion.count({ where: { ownerId: owner, replacedAt: { not: null } } }), 0);
    assert.equal((await drive.trash(owner)).groups.length, 0);
  });

  await t.test('(12) another account\'s entry, version and group are not found', async () => {
    const id = await fileWith(null, 'private.txt', 'mine');
    const e = await db.driveEntry.findUniqueOrThrow({ where: { id } });
    await commit(owner, { entryId: id, mode: 'OVERWRITE', baseVersionId: e.currentVersionId, parts: ['mine 2'] });
    const { trashGroupId } = await drive.moveToTrash(owner, id);
    await refusedWith(drive.get(stranger, id), 404, DRIVE_ENTRY_NOT_FOUND);
    await refusedWith(drive.versions(stranger, id), 404, DRIVE_ENTRY_NOT_FOUND);
    await refusedWith(drive.rename(stranger, id, { name: 'stolen' }), 404, DRIVE_ENTRY_NOT_FOUND);
    await refusedWith(drive.moveToTrash(stranger, id), 404, DRIVE_ENTRY_NOT_FOUND);
    await refusedWith(drive.restoreGroup(stranger, trashGroupId), 404, DRIVE_TRASH_GROUP_NOT_FOUND);
    await refusedWith(drive.deleteGroup(stranger, trashGroupId), 404, DRIVE_TRASH_GROUP_NOT_FOUND);
    await refusedWith(drive.trashGroup(stranger, trashGroupId), 404, DRIVE_TRASH_GROUP_NOT_FOUND);
    await refusedWith(drive.restoreVersion(stranger, e.currentVersionId!, 'CURRENT'), 404, DRIVE_VERSION_NOT_FOUND);
    await refusedWith(drive.deleteVersion(stranger, e.currentVersionId!), 404, DRIVE_VERSION_NOT_FOUND);
    await refusedWith(drive.list(stranger, { parentId: root.id }), 404, DRIVE_ENTRY_NOT_FOUND);
    await refusedWith(drive.createFolder(stranger, { parentId: root.id, name: 'in yours' }), 404, DRIVE_PARENT_GONE);
    await refusedWith(drive.commit(stranger, {
      commitId: randomUUID(), entryId: id, mode: 'OVERWRITE', chunks: [], writer: { kind: 'OWNER' },
    }), 404, DRIVE_ENTRY_NOT_FOUND);
    assert.equal((await drive.trash(stranger)).groups.length, 0);
    assert.equal((await drive.changes(stranger, '0')).changes.length, 0, 'nor any of its changes');
    assert.notEqual((await db.driveEntry.findUniqueOrThrow({ where: { id } })).trashGroupId, null, 'and nothing moved');
  });

  await t.test('(13) the retention sweep prunes commit answers and feed rows older than a day', async () => {
    const id = await fileWith(null, 'sweep.txt', 's');
    const sweep = new FileRetentionSweep(db as never, files);
    const commits = await db.driveCommit.count({ where: { ownerId: owner } });
    const feed = await db.driveChange.count({ where: { ownerId: owner } });
    assert.ok(commits > 0 && feed > 0);
    const done = await sweep.sweep(new Date(Date.now() + DAY + 60_000));
    assert.ok(done.feedRowsRemoved >= commits + feed, `removed ${done.feedRowsRemoved}`);
    assert.equal(await db.driveCommit.count({ where: { ownerId: owner } }), 0);
    assert.equal(await db.driveChange.count({ where: { ownerId: owner } }), 0);
    assert.equal(await textOf(id), 's', 'the drive itself is untouched');
  });
});
