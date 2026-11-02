import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import fs, {
  chmodSync,
  existsSync,
  fstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { BadRequestException, Logger, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { lastValueFrom, of, throwError, type Observable } from 'rxjs';
import {
  DEFAULT_FILES_DIR,
  LocalFileStore,
  filesConfigFrom,
  removeStaleTempFiles,
  uploadTempDir,
  writeHashedTempFile,
} from './file-store';
import { FileUploadCleanupInterceptor } from './file-upload-cleanup.interceptor';
import { fileUploadStorage } from './file-upload-storage';
import { FilesService, streamable } from './files.service';
import { S3FileStore, sigV4Authorization, sigV4Encode } from './s3-file-store';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-files-spec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Signature Version 4, against the worked examples AWS publishes for S3 ─────────────────────────
// docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Examples: Signature
// Calculations": the same credentials, the same instant, the signatures printed there.
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
};
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('the S3 signature is AWS\'s own for its GET Object example', () => {
  const authorization = sigV4Authorization({
    method: 'GET',
    path: '/test.txt',
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      Range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY,
      'x-amz-date': '20130524T000000Z',
    },
    payloadSha256: EMPTY,
  }, AWS_EXAMPLE, '20130524T000000Z');
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('the S3 signature is AWS\'s own for its PUT Object example, a key that needs encoding included', () => {
  const body = Buffer.from('Welcome to Amazon S3.');
  const payload = sha256(body);
  assert.equal(payload, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const authorization = sigV4Authorization({
    method: 'PUT',
    path: `/${sigV4Encode('test$file.text')}`,
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      Date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-date': '20130524T000000Z',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      'x-amz-content-sha256': payload,
    },
    payloadSha256: payload,
  }, AWS_EXAMPLE, '20130524T000000Z');
  assert.match(authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
  assert.match(authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('a key is encoded the way the signature reads it: unreserved characters kept, the rest percent-encoded', () => {
  assert.equal(sigV4Encode('test$file.text'), 'test%24file.text');
  assert.equal(sigV4Encode("a b!'()*~-._"), 'a%20b%21%27%28%29%2A~-._');
});

/** Until `condition` holds; a test fails on one that never does. */
async function settles(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i += 1) await sleep(10);
  assert.ok(condition(), what);
}

const bucketOn = (server: net.Server) => new S3FileStore({
  endpoint: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1',
});

test('an upload the bucket refuses unread gives back its file and its connection', async (t) => {
  const dir = scratch(t);
  // Refuses on the first bytes, reads no more of them, and leaves the connection for the client to end. Having stopped
  // reading it would not see that happen, so what is asked below is the client's own agent.
  const refusal = '<Error><Code>AccessDenied</Code></Error>';
  const connections = new Set<net.Socket>();
  const refusing = net.createServer((socket) => {
    connections.add(socket);
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.pause();
      socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${refusal.length}\r\n\r\n${refusal}`);
    });
  });
  t.after(() => {
    for (const socket of connections) socket.destroy();
    refusing.close();
  });
  await once(refusing.listen(0, '127.0.0.1'), 'listening');
  const descriptors = () => readdirSync('/dev/fd').length;
  const before = descriptors();
  // Larger than a socket's buffers, so that the refusal arrives with the body still being read.
  const bytes = Buffer.alloc(32 * 1024 * 1024);
  const temp = path.join(dir, 'tmp-upload');
  writeFileSync(temp, bytes);
  await assert.rejects(bucketOn(refusing).put(sha256(bytes), temp, bytes.length), /answered 403 AccessDenied/);
  assert.deepEqual(readdirSync(dir), [], 'the temporary file is gone');
  await settles(() => Object.keys(http.globalAgent.sockets).length === 0, 'the connection is given up');
  for (const socket of connections) socket.destroy();
  await settles(() => descriptors() <= before, 'the file is closed');
});

test('an upload the bucket keeps frees its connection, however soon the bucket answers', async (t) => {
  const dir = scratch(t);
  // The read that finds the end of the file comes after the answer, as it does when the thread pool is busy.
  const read = fs.read;
  t.mock.method(fs, 'read', ((fd: number, buffer: Buffer, offset: number, length: number, position: number, done: (...result: unknown[]) => void) => {
    read(fd, buffer, offset, length, position, (error, bytesRead, into) => {
      if (bytesRead === 0) setTimeout(done, 100, error, bytesRead, into);
      else done(error, bytesRead, into);
    });
  }) as unknown as typeof fs.read);
  let connections = 0;
  const keeping = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => response.end());
  });
  keeping.on('connection', () => {
    connections += 1;
  });
  t.after(() => {
    keeping.closeAllConnections();
    keeping.close();
  });
  await once(keeping.listen(0, '127.0.0.1'), 'listening');
  const store = bucketOn(keeping);
  for (const name of ['first', 'second']) {
    const bytes = Buffer.from(name);
    const temp = path.join(dir, name);
    writeFileSync(temp, bytes);
    await store.put(sha256(bytes), temp, bytes.length);
    await sleep(150);
  }
  assert.equal(connections, 1, 'the second upload went over the connection the first one freed');
});

// ── Configuration ──────────────────────────────────────────────────────────────────────────────
test('with nothing set, files are kept in /var/lib/orbit/files', () => {
  // Two days is the backup sidecar's defaults, a day between base backups and two kept.
  const backupRetentionMs = 2 * 24 * 60 * 60 * 1000;
  assert.deepEqual(filesConfigFrom({}), { dir: DEFAULT_FILES_DIR, storage: 'local', backupRetentionMs });
  assert.equal(DEFAULT_FILES_DIR, '/var/lib/orbit/files');
  assert.deepEqual(filesConfigFrom({ ORBIT_FILES_DIR: '/srv/files' }), { dir: '/srv/files', storage: 'local', backupRetentionMs });
});

test('the quota and the backup retention are read from the environment, and a value that means nothing stops the start', () => {
  assert.equal(filesConfigFrom({ ORBIT_FILES_QUOTA_BYTES: '1048576' }).quotaBytes, 1_048_576);
  assert.equal(filesConfigFrom({ ORBIT_FILES_QUOTA_BYTES: ' ' }).quotaBytes, undefined, 'blank is what Compose passes when unset');
  assert.equal(filesConfigFrom({ ORBIT_BASE_BACKUP_INTERVAL: '3600', ORBIT_BASE_BACKUP_KEEP: '48' }).backupRetentionMs, 48 * 3_600_000);
  for (const name of ['ORBIT_FILES_QUOTA_BYTES', 'ORBIT_BASE_BACKUP_INTERVAL', 'ORBIT_BASE_BACKUP_KEEP']) {
    for (const value of ['0', '-1', '1.5', 'ten', '1e3']) {
      assert.throws(() => filesConfigFrom({ [name]: value }), new RegExp(`${name} must be a whole number above zero, not "${value.replace('.', '\.')}"`));
    }
  }
});

test('s3 takes the endpoint, bucket, key pair and region, and refuses to start without them', () => {
  assert.deepEqual(filesConfigFrom({
    ORBIT_FILES_BACKEND: 's3',
    ORBIT_FILES_S3_ENDPOINT: 'http://minio:9000',
    ORBIT_FILES_S3_BUCKET: 'orbit',
    ORBIT_FILES_S3_ACCESS_KEY_ID: 'id',
    ORBIT_FILES_S3_SECRET_ACCESS_KEY: 'secret',
  }), {
    dir: DEFAULT_FILES_DIR,
    storage: 's3',
    s3: { endpoint: 'http://minio:9000', bucket: 'orbit', accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' },
    backupRetentionMs: 2 * 24 * 60 * 60 * 1000,
  });
  assert.throws(
    () => filesConfigFrom({ ORBIT_FILES_BACKEND: 's3', ORBIT_FILES_S3_ENDPOINT: 'http://minio:9000' }),
    /ORBIT_FILES_BACKEND=s3 needs ORBIT_FILES_S3_BUCKET, ORBIT_FILES_S3_ACCESS_KEY_ID, ORBIT_FILES_S3_SECRET_ACCESS_KEY/,
  );
  assert.throws(() => filesConfigFrom({
    ORBIT_FILES_BACKEND: 's3',
    ORBIT_FILES_S3_ENDPOINT: 'minio:9000',
    ORBIT_FILES_S3_BUCKET: 'orbit',
    ORBIT_FILES_S3_ACCESS_KEY_ID: 'id',
    ORBIT_FILES_S3_SECRET_ACCESS_KEY: 'secret',
  }), /must be an http:\/\/ or https:\/\/ URL/);
  assert.throws(() => filesConfigFrom({ ORBIT_FILES_BACKEND: 'gcs' }), /must be local or s3, not "gcs"/);
});

// ── An upload, on its way to the store ────────────────────────────────────────────────────────
test('an upload is written to a temporary file and hashed as it passes, in pieces, never whole', async (t) => {
  const dir = scratch(t);
  const bytes = randomBytes(3 * 1024 * 1024 + 7);
  // In 64 KiB pieces, as a request body arrives: the writer sees no more than one at a time.
  const pieces = Readable.from(Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, i) => bytes.subarray(i * 65536, (i + 1) * 65536)));
  let announced: string | undefined;
  const written = await writeHashedTempFile(pieces, dir, (tempPath) => {
    announced = tempPath;
  });
  assert.equal(written.path, announced, 'the path is known before the first byte, for a caller that must remove it');
  assert.equal(path.dirname(written.path), dir);
  assert.deepEqual({ size: written.size, sha256: written.sha256 }, { size: bytes.length, sha256: sha256(bytes) });
  assert.ok(readFileSync(written.path).equals(bytes));
});

test('an upload that fails while it is written leaves no file behind', async (t) => {
  const dir = scratch(t);
  const source = new PassThrough();
  const writing = writeHashedTempFile(source, dir);
  source.write(randomBytes(1024));
  // The first piece reaches the disk, and then the client goes away.
  for (let i = 0; i < 200; i += 1) {
    const [name] = readdirSync(dir);
    if (name && statSync(path.join(dir, name)).size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(readdirSync(dir).length, 1, 'the upload was being written');
  source.destroy(new Error('the client went away'));
  await assert.rejects(writing, /the client went away/);
  assert.deepEqual(readdirSync(dir), []);
});

test('the routes\' multer engine hands on a file on disk with its sha256, never a buffer, and removes it on request', async (t) => {
  const dir = scratch(t);
  const engine = fileUploadStorage(() => uploadTempDir(dir));
  const bytes = randomBytes(200_000);
  const file: { stream: Readable; path?: string } = { stream: Readable.from([bytes]) };
  const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
    engine._handleFile({}, file, (error, written) => (error ? reject(error) : resolve({ ...written })));
  });
  assert.deepEqual(Object.keys(info).sort(), ['path', 'sha256', 'size']);
  assert.equal(file.path, info.path, 'multer can clean up a file whose write it aborts');
  assert.equal(path.dirname(info.path as string), path.join(dir, 'tmp'));
  assert.equal(info.sha256, sha256(bytes));
  assert.ok(readFileSync(info.path as string).equals(bytes));
  await new Promise<void>((resolve, reject) => engine._removeFile({}, { path: info.path as string }, (error) => (error ? reject(error) : resolve())));
  assert.deepEqual(readdirSync(path.join(dir, 'tmp')), []);
  // Removing one already gone is no error: multer and the route may both try.
  await new Promise<void>((resolve, reject) => engine._removeFile({}, { path: info.path as string }, (error) => (error ? reject(error) : resolve())));
});

// ── The end of an upload's request ─────────────────────────────────────────────────────────────
test('an upload\'s temporary file is gone once its request has ended, and the answer is the route\'s own', async (t) => {
  const dir = scratch(t);
  const temp = (name: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, 'bytes');
    return file;
  };
  const through = async (file: { path: string } | undefined, route: () => Observable<unknown>) => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ file }) }) } as unknown as ExecutionContext;
    return lastValueFrom(await new FileUploadCleanupInterceptor().intercept(context, { handle: route }));
  };

  const refusal = new BadRequestException('invalid id');
  await assert.rejects(through({ path: temp('refused') }, () => throwError(() => refusal)), (error) => error === refusal);
  assert.deepEqual(readdirSync(dir), [], 'a refusal removes the file');

  assert.deepEqual(await through({ path: temp('answered') }, () => of({ id: 'a' })), { id: 'a' });
  assert.deepEqual(readdirSync(dir), [], 'so does an answer that left the file where it was');

  // A kept upload's file has already moved into the store, and a request with no file has none to remove.
  assert.deepEqual(await through({ path: path.join(dir, 'kept') }, () => of({ id: 'b' })), { id: 'b' });
  assert.deepEqual(await through(undefined, () => of({ id: 'c' })), { id: 'c' });
});

// ── What a process killed during an upload leaves behind ──────────────────────────────────────
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

function writtenHoursAgo(dir: string, name: string, hours: number, bytes = 'bytes'): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  utimesSync(file, hoursAgo(hours), hoursAgo(hours));
  return file;
}

/** A files directory of the test's, with its temporary directory, and what a sweep says about it. */
function sweeping(t: { after: (fn: () => void) => void }) {
  const dir = scratch(t);
  const tempDir = uploadTempDir(dir);
  mkdirSync(tempDir);
  const said = { log: [] as string[], warn: [] as string[] };
  const log = { log: (line: string) => said.log.push(line), warn: (line: string) => said.warn.push(line) };
  return { dir, tempDir, said, log };
}

test('regular files in the temporary directory not written for a day are removed, whatever their names, and newer ones stay', async (t) => {
  const { tempDir, said, log } = sweeping(t);
  writtenHoursAgo(tempDir, 'upload-killed', 25, 'a killed upload');
  writtenHoursAgo(tempDir, 'not-an-upload', 24 * 30, 'old');
  writtenHoursAgo(tempDir, 'upload-nearly-a-day', 23);
  writtenHoursAgo(tempDir, 'upload-under-way', 0);
  await removeStaleTempFiles(tempDir, log);
  assert.deepEqual(readdirSync(tempDir).sort(), ['upload-nearly-a-day', 'upload-under-way']);
  assert.deepEqual(said, { log: [`temporary files: removed 2 (18 bytes) not written for a day from ${tempDir}`], warn: [] });

  said.log.length = 0;
  await removeStaleTempFiles(tempDir, log);
  assert.deepEqual(readdirSync(tempDir).sort(), ['upload-nearly-a-day', 'upload-under-way'], 'run again, it changes nothing');
  assert.deepEqual(said, { log: [], warn: [] }, 'and has nothing to say');
});

test('a link or a directory in the temporary directory stays as it is, and nothing is followed', async (t) => {
  const { dir, tempDir, said, log } = sweeping(t);
  const longAgo = hoursAgo(48);
  const outside = path.join(dir, 'outside');
  mkdirSync(outside);
  const outsideFile = writtenHoursAgo(outside, 'stale-but-not-a-temporary-file', 48);
  const links = { 'to-a-file': outsideFile, 'to-a-directory': outside, 'to-nothing': path.join(dir, 'nothing') };
  for (const [name, target] of Object.entries(links)) {
    symlinkSync(target, path.join(tempDir, name));
    // The link itself as old as a file that would be removed.
    lutimesSync(path.join(tempDir, name), longAgo, longAgo);
  }
  const inner = path.join(tempDir, 'a-directory');
  mkdirSync(inner);
  const innerFile = writtenHoursAgo(inner, 'stale-in-a-directory', 48);
  utimesSync(inner, longAgo, longAgo);
  const killed = writtenHoursAgo(tempDir, 'upload-killed', 48);

  await removeStaleTempFiles(tempDir, log);

  assert.equal(existsSync(killed), false, 'the regular file beside them is what goes');
  for (const [name, target] of Object.entries(links)) assert.equal(readlinkSync(path.join(tempDir, name)), target, `${name} is still that link`);
  assert.equal(readFileSync(outsideFile, 'utf8'), 'bytes', 'the file a link points at is untouched');
  assert.equal(readFileSync(innerFile, 'utf8'), 'bytes', 'and so is one in a directory');
  assert.deepEqual(said.warn, []);
});

test('a temporary directory that is itself a link is not followed, and says so', async (t) => {
  const { dir, tempDir, said, log } = sweeping(t);
  const elsewhere = path.join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  const file = writtenHoursAgo(elsewhere, 'somebody-elses', 48);
  rmSync(tempDir, { recursive: true });
  symlinkSync(elsewhere, tempDir);
  await removeStaleTempFiles(tempDir, log);
  assert.equal(existsSync(file), true);
  assert.deepEqual(said, { log: [], warn: [`temporary files: could not read ${tempDir}: it is a link, or not a directory`] });
});

test('with no temporary directory yet there is nothing to do or say, and none is made', async (t) => {
  const { tempDir, said, log } = sweeping(t);
  rmSync(tempDir, { recursive: true });
  await removeStaleTempFiles(tempDir, log);
  assert.equal(existsSync(tempDir), false);
  assert.deepEqual(said, { log: [], warn: [] });
});

/** `work` as a user that file modes bind, which root is not: where these specs run as root, nobody's. */
async function boundByFileModes<T>(work: () => Promise<T>): Promise<T> {
  const root = process.geteuid?.() === 0;
  if (root) process.seteuid!(65534);
  try {
    return await work();
  } finally {
    if (root) process.seteuid!(0);
  }
}

test('a temporary directory that cannot be read is said, thrown to nobody, and leaves its files', async (t) => {
  const { dir, tempDir, said, log } = sweeping(t);
  const stale = writtenHoursAgo(tempDir, 'upload-killed', 48);
  // Only the directory itself is what refuses.
  chmodSync(dir, 0o755);
  chmodSync(tempDir, 0o000);
  try {
    await boundByFileModes(() => removeStaleTempFiles(tempDir, log));
  } finally {
    chmodSync(tempDir, 0o700);
  }
  assert.equal(said.warn.length, 1, said.warn.join('\n'));
  assert.match(said.warn[0], new RegExp(`^temporary files: could not read ${tempDir}: EACCES`));
  assert.deepEqual(said.log, []);
  assert.equal(existsSync(stale), true);

  const notADirectory = path.join(dir, 'a-file');
  writeFileSync(notADirectory, '');
  said.warn.length = 0;
  await removeStaleTempFiles(notADirectory, log);
  assert.deepEqual(said.warn, [`temporary files: could not read ${notADirectory}: it is a link, or not a directory`]);

  said.warn.length = 0;
  await removeStaleTempFiles(path.join(notADirectory, 'tmp'), log);
  assert.match(said.warn[0], /ENOTDIR/, 'a files directory that cannot be reached either');
});

test('a file that cannot be removed is said, and the others still go', async (t) => {
  const { tempDir, said, log } = sweeping(t);
  for (const name of ['upload-a', 'upload-b', 'upload-c']) writtenHoursAgo(tempDir, name, 25);
  // Whichever it comes to first, so that the others are the ones after a failure.
  let refused = '';
  const unlink = fsPromises.unlink;
  t.mock.method(fsPromises, 'unlink', async (file: string) => {
    if (refused) return unlink(file);
    refused = file;
    throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: 'EPERM' });
  });
  await removeStaleTempFiles(tempDir, log);
  assert.deepEqual(readdirSync(tempDir), [path.basename(refused)]);
  assert.deepEqual(said, {
    log: [`temporary files: removed 2 (10 bytes) not written for a day from ${tempDir}`],
    warn: [`temporary files: could not remove 1 from ${tempDir}: EPERM: operation not permitted, unlink '${refused}'`],
  });
});

test('a file that goes while this runs, by its upload ending or to another apiserver starting at once, is no failure', async (t) => {
  const { tempDir, said, log } = sweeping(t);
  for (let i = 0; i < 40; i += 1) writtenHoursAgo(tempDir, `upload-${i}`, 25);
  const readdir = fsPromises.readdir;
  t.mock.method(fsPromises, 'readdir', async (dir: string) => [...(await readdir(dir)), 'upload-gone-since-the-listing']);
  await Promise.all([removeStaleTempFiles(tempDir, log), removeStaleTempFiles(tempDir, log)]);
  assert.deepEqual(readdirSync(tempDir), []);
  assert.deepEqual(said.warn, []);
});

for (const [storage, config] of [
  ['the local store', { storage: 'local' as const }],
  ['a bucket', { storage: 's3' as const, s3: { endpoint: 'http://127.0.0.1:9', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'r' } }],
] as const) {
  test(`a start with ${storage} removes what is stale, without waiting for it, and goes on whatever it finds`, async (t) => {
    const { dir, tempDir } = sweeping(t);
    const warnings: string[] = [];
    t.mock.method(Logger.prototype, 'log', () => undefined);
    t.mock.method(Logger.prototype, 'warn', (line: string) => {
      warnings.push(line);
    });
    const files = new FilesService({} as never, { dir, ...config });

    const stale = writtenHoursAgo(tempDir, 'upload-killed', 25);
    const fresh = writtenHoursAgo(tempDir, 'upload-under-way', 0);
    // Nothing for Nest to wait on: a disk that hangs holds up no start.
    assert.equal(files.onApplicationBootstrap(), undefined);
    for (let i = 0; i < 500 && existsSync(stale); i += 1) await sleep(10);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);

    chmodSync(dir, 0o755);
    chmodSync(tempDir, 0o000);
    try {
      await boundByFileModes(async () => {
        assert.equal(files.onApplicationBootstrap(), undefined, 'and a directory it cannot read does not stop it');
        for (let i = 0; i < 500 && warnings.length === 0; i += 1) await sleep(10);
      });
    } finally {
      chmodSync(tempDir, 0o700);
    }
    assert.match(warnings[0] ?? '', new RegExp(`^temporary files: could not read ${tempDir}: EACCES`));
  });
}

// ── The files directory as a store ─────────────────────────────────────────────────────────────
test('the local store keeps a content once at <sha256[0:2]>/<sha256>, by renaming the temporary file', async (t) => {
  const dir = scratch(t);
  const store = new LocalFileStore(dir);
  const bytes = randomBytes(4096);
  const name = sha256(bytes);
  assert.equal(await store.has(name), false);
  assert.equal(await store.open(name), null);
  for (const _ of [1, 2]) {
    const temp = path.join(dir, 'tmp-upload');
    writeFileSync(temp, bytes);
    await store.put(name, temp);
    assert.deepEqual(readdirSync(dir).sort(), [name.slice(0, 2)], 'the temporary file is gone, renamed into place');
  }
  assert.deepEqual(readdirSync(path.join(dir, name.slice(0, 2))), [name], 'stored twice, kept once');
  assert.equal(store.pathOf(name), path.join(dir, name.slice(0, 2), name));
  assert.equal(await store.has(name), true);
  const chunks: Buffer[] = [];
  for await (const chunk of (await store.open(name))!) chunks.push(chunk as Buffer);
  assert.ok(Buffer.concat(chunks).equals(bytes));
});

// ── A stream nobody finishes ───────────────────────────────────────────────────────────────────
const opened = (content: Readable) => ({ content, mimeType: 'image/png', sizeBytes: 1, fileName: 'a.png' });
const responseWith = (destroyed: boolean) => Object.assign(new EventEmitter(), { destroyed }) as unknown as EventEmitter & Pick<Response, 'once' | 'destroyed'>;

test('a stream whose response has already closed is closed at once', () => {
  const content = new PassThrough();
  streamable(opened(content), responseWith(true));
  assert.equal(content.destroyed, true);
});

test('a stream is closed when its response closes, and not before', () => {
  const content = new PassThrough();
  const response = responseWith(false);
  streamable(opened(content), response);
  assert.equal(content.destroyed, false);
  response.emit('close');
  assert.equal(content.destroyed, true);
});

test('a stored file whose response has already closed gives its descriptor back', { timeout: 10_000 }, async (t) => {
  const dir = scratch(t);
  const store = new LocalFileStore(dir);
  const bytes = randomBytes(4096);
  const temp = path.join(dir, 'tmp-upload');
  writeFileSync(temp, bytes);
  await store.put(sha256(bytes), temp);
  const content = (await store.open(sha256(bytes))) as Readable & { fd: number };
  const { fd } = content;
  assert.ok(fstatSync(fd).isFile());
  const closed = once(content, 'close');
  streamable(opened(content), responseWith(true));
  await closed;
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
});

/**
 * Run in a process of its own, which `--expose-gc` lets collect and which holds nothing else: $CASE leaves a stream
 * unreachable, collections run, and the answer is how many descriptors were open before it, with it, and after.
 */
const DROPPING = String.raw`
const { once } = require('node:events');
const { fstatSync, openSync, readdirSync } = require('node:fs');
const { PassThrough } = require('node:stream');
const { setTimeout: sleep } = require('node:timers/promises');
const { LocalFileStore, writeHashedTempFile } = require(process.env.FILE_STORE);

const { FILES_DIR, NAME } = process.env;
const open = () => new LocalFileStore(FILES_DIR).open(NAME);
const descriptors = () => readdirSync('/dev/fd').length;
let kept;
const cases = {
  async unread() {
    await open();
  },
  async 'read in part'() {
    const stream = await open();
    await once(stream, 'readable');
    stream.read(1);
  },
  async 'being written'() {
    writeHashedTempFile(new PassThrough(), FILES_DIR).catch(() => undefined);
    await sleep(100);
  },
  // Its descriptor's number goes to the next file opened, whose descriptor stays that file's.
  async 'read to the end'() {
    const stream = await open();
    const { fd } = stream;
    for await (const chunk of stream) void chunk;
    kept = openSync(new LocalFileStore(FILES_DIR).pathOf(NAME), 'r');
    if (kept !== fd) throw new Error('the next file got another number');
  },
};

(async () => {
  const before = descriptors();
  await cases[process.env.CASE]();
  const held = descriptors();
  for (let round = 0; round < 40; round += 1) {
    globalThis.gc();
    await sleep(5);
  }
  if (kept !== undefined) fstatSync(kept);
  console.log(JSON.stringify({ before, held, after: descriptors() }));
})();
`;

for (const [what, expected] of [
  ['unread', 'closed'],
  ['read in part', 'closed'],
  ['being written', 'closed'],
  ['read to the end', 'kept'],
] as const) {
  test(expected === 'closed' ? `a stream dropped ${what} gives its descriptor back` : `a stream ${what} has no claim left on its descriptor's number`, async (t) => {
    const dir = scratch(t);
    const bytes = randomBytes(256 * 1024);
    const temp = path.join(dir, 'tmp-upload');
    writeFileSync(temp, bytes);
    await new LocalFileStore(dir).put(sha256(bytes), temp);
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', DROPPING], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH, CASE: what, FILES_DIR: dir, NAME: sha256(bytes), FILE_STORE: path.join(__dirname, 'file-store.js') },
    });
    assert.equal(child.status, 0, child.stderr);
    const { before, held, after } = JSON.parse(child.stdout) as { before: number; held: number; after: number };
    assert.equal(held, before + 1, 'the stream held one descriptor');
    assert.equal(after, expected === 'closed' ? before : held);
  });
}
