import type { Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { close, createReadStream, createWriteStream, open as openWithCallback, type ReadStream, type WriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

/**
 * Where the bytes of Orbit Files are kept (docs/orbit-files-design.md §2.1, §2.10): a store addressed by
 * each content's sha256. `file_blob.storage` names the store a content is in.
 */
export type FileStorage = 'local' | 's3';

/**
 * One store. Content-addressed and write-once: a name always holds the same bytes, so storing a name
 * that is already there changes nothing, and two uploads of one content racing to store it agree.
 */
export interface FileStore {
  readonly storage: FileStorage;
  /** Whether the bytes named `sha256` are kept here. */
  has(sha256: string): Promise<boolean>;
  /**
   * Keep the file at `tempPath` — `sizeBytes` bytes whose sha256 is `sha256` — under that name. The
   * temporary file is gone afterwards, whether or not this succeeded.
   */
  put(sha256: string, tempPath: string, sizeBytes: number): Promise<void>;
  /**
   * The bytes named `sha256`, read as a stream that whoever takes it reads to the end or destroys; null when they
   * are not kept here.
   */
  open(sha256: string): Promise<Readable | null>;
  /** Let the bytes named `sha256` go (file-retention.ts is the one caller). Bytes already gone are no error. */
  remove(sha256: string): Promise<void>;
}

/** The S3-compatible bucket a deployment keeps files in (`ORBIT_FILES_BACKEND=s3`). */
export interface S3FilesConfig {
  /** The service's URL, e.g. `https://s3.eu-west-1.amazonaws.com` or `http://minio:9000`. Objects are
   *  addressed path-style, `<endpoint>/<bucket>/<key>`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface FilesConfig {
  /**
   * The files directory (ORBIT_FILES_DIR, default /var/lib/orbit/files, which Compose bind-mounts from
   * ./data/files). The local store keeps bytes in it, and every upload is written to its `tmp/` first,
   * whichever store then keeps it.
   */
  dir: string;
  /** The store new bytes go to (ORBIT_FILES_BACKEND, default `local`). */
  storage: FileStorage;
  /** Set exactly when `storage` is `s3`. */
  s3?: S3FilesConfig;
  /** The most one account may keep (ORBIT_FILES_QUOTA_BYTES). Unset: no limit, a self-hosted deployment's default. */
  quotaBytes?: number;
  /**
   * How far back a retained Postgres backup reaches: ORBIT_BASE_BACKUP_INTERVAL × (ORBIT_BASE_BACKUP_KEEP + 1), from the two
   * values the backup sidecar keeps its base backups by. A backup stays until that many newer ones have finished, and each
   * round takes a little longer than the interval (it waits for its poll, then runs), which the one more interval covers.
   * A file's bytes outlast this (`fileGraceMs`), so that restoring any retained backup finds the bytes its rows name.
   */
  backupRetentionMs?: number;
}

export const DEFAULT_FILES_DIR = '/var/lib/orbit/files';

/** ORBIT_FILES_DIR, or its default. */
export function filesDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORBIT_FILES_DIR?.trim() || DEFAULT_FILES_DIR;
}

/** A whole number above zero from the environment, or `fallback` when it is unset or blank. */
function positiveIntegerFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number;
function positiveIntegerFrom(env: NodeJS.ProcessEnv, name: string): number | undefined;
function positiveIntegerFrom(env: NodeJS.ProcessEnv, name: string, fallback?: number): number | undefined {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a whole number above zero, not "${value}"`);
  return parsed;
}

/** What the file limits read from the environment, whichever store is in use. */
function fileLimitsFrom(env: NodeJS.ProcessEnv): Pick<FilesConfig, 'quotaBytes' | 'backupRetentionMs'> {
  // The sidecar's own defaults (scripts/pg-backup.sh), so that the two agree when neither is set.
  const interval = positiveIntegerFrom(env, 'ORBIT_BASE_BACKUP_INTERVAL', 86_400);
  const keep = positiveIntegerFrom(env, 'ORBIT_BASE_BACKUP_KEEP', 2);
  const quotaBytes = positiveIntegerFrom(env, 'ORBIT_FILES_QUOTA_BYTES');
  return { ...(quotaBytes ? { quotaBytes } : {}), backupRetentionMs: interval * (keep + 1) * 1000 };
}

/** Where uploads are written while they arrive: inside the files directory, so that keeping one in the
 *  local store is a rename on the same filesystem. */
export function uploadTempDir(dir: string): string {
  return path.join(dir, 'tmp');
}

/**
 * The deployment's files configuration, read from the environment. Throws on a configuration that cannot
 * work — an unknown backend, or `s3` without its bucket and credentials — so that the server refuses to
 * start rather than refusing every upload.
 */
export function filesConfigFrom(env: NodeJS.ProcessEnv = process.env): FilesConfig {
  const dir = filesDirFrom(env);
  const limits = fileLimitsFrom(env);
  const backend = env.ORBIT_FILES_BACKEND?.trim() || 'local';
  if (backend === 'local') return { dir, storage: 'local', ...limits };
  if (backend !== 's3') {
    throw new Error(`ORBIT_FILES_BACKEND must be local or s3, not "${backend}"`);
  }
  const s3 = {
    endpoint: env.ORBIT_FILES_S3_ENDPOINT?.trim() ?? '',
    bucket: env.ORBIT_FILES_S3_BUCKET?.trim() ?? '',
    accessKeyId: env.ORBIT_FILES_S3_ACCESS_KEY_ID?.trim() ?? '',
    secretAccessKey: env.ORBIT_FILES_S3_SECRET_ACCESS_KEY?.trim() ?? '',
    region: env.ORBIT_FILES_S3_REGION?.trim() || 'us-east-1',
  };
  const missing = Object.entries({
    ORBIT_FILES_S3_ENDPOINT: s3.endpoint,
    ORBIT_FILES_S3_BUCKET: s3.bucket,
    ORBIT_FILES_S3_ACCESS_KEY_ID: s3.accessKeyId,
    ORBIT_FILES_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`ORBIT_FILES_BACKEND=s3 needs ${missing.join(', ')}`);
  }
  if (!/^https?:\/\//.test(s3.endpoint)) {
    throw new Error(`ORBIT_FILES_S3_ENDPOINT must be an http:// or https:// URL, not "${s3.endpoint}"`);
  }
  return { dir, storage: 's3', s3, ...limits };
}

/**
 * `open`, answering with a plain descriptor. The streams here stand on one rather than on a FileHandle, which may
 * not be left to be collected: a descriptor can be given back when it is (closedWhenDropped).
 */
const openDescriptor = promisify(openWithCallback);

const droppedStreams = new FinalizationRegistry<number>((fd) => close(fd, () => undefined));

/**
 * `stream`, on the descriptor `fd`, with the descriptor given back if the stream is ever dropped unfinished. Every
 * ending anyone meant closes a stream by itself (for a download, streamable()), so this is only what stands behind an
 * ending nobody thought of: what that costs is one descriptor, until the stream is collected.
 */
function closedWhenDropped<S extends ReadStream | WriteStream>(stream: S, fd: number): S {
  droppedStreams.register(stream, fd, stream);
  stream.once('close', () => droppedStreams.unregister(stream));
  return stream;
}

/** A file written under the temporary directory, with its length and sha256 as they were written. */
export interface HashedTempFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Write `source` to a new file in `dir`, hashing the bytes as they pass: the one read of an upload, so it
 * is never held in memory whole. `onPath` is told the file's path before the first byte is written, for a
 * caller that must be able to remove it while it is still being written. The data is flushed to disk
 * before this resolves; on failure the file is removed.
 */
export async function writeHashedTempFile(
  source: Readable,
  dir: string,
  onPath?: (tempPath: string) => void,
): Promise<HashedTempFile> {
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `upload-${randomUUID()}`);
  // Opened before anything is written, so that the file a failure removes is never one still being created.
  const fd = await openDescriptor(tempPath, 'wx');
  onPath?.(tempPath);
  const hash = createHash('sha256');
  let size = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, hashing, closedWhenDropped(createWriteStream(tempPath, { fd, flush: true }), fd));
  } catch (error) {
    await removeTempFile(tempPath);
    throw error;
  }
  return { path: tempPath, size, sha256: hash.digest('hex') };
}

/** Remove a file; one that is already gone is no error. */
export async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** How long a temporary file goes unwritten before a start removes it: far longer than an upload takes, on any apiserver. */
const STALE_TEMP_FILE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the regular files in the temporary directory `dir` that have not been written for a day: what a process killed
 * while writing one leaves, because its cleanup died with it and nothing else ever names that file. An upload under way
 * on another apiserver sharing the volume has written more recently than that. A link or a directory stays as it is, and
 * none is followed, `dir` itself included.
 *
 * It never throws, so a start goes on whatever it finds here. What it could not do, it logs.
 */
export async function removeStaleTempFiles(dir: string, log: Pick<Logger, 'log' | 'warn'>): Promise<void> {
  let names: string[];
  try {
    if (!(await lstat(dir)).isDirectory()) throw new Error('it is a link, or not a directory');
    names = await readdir(dir);
  } catch (error) {
    // No upload has made it yet.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`temporary files: could not read ${dir}: ${messageOf(error)}`);
    return;
  }
  const writtenBefore = Date.now() - STALE_TEMP_FILE_MS;
  const removed = { files: 0, bytes: 0 };
  const failures: unknown[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.mtimeMs >= writtenBefore) continue;
      await removeTempFile(file);
      removed.files += 1;
      removed.bytes += entry.size;
    } catch (error) {
      // Gone since the directory was read: its upload ended, or another apiserver removed it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
    }
  }
  if (removed.files > 0) log.log(`temporary files: removed ${removed.files} (${removed.bytes} bytes) not written for a day from ${dir}`);
  if (failures.length > 0) log.warn(`temporary files: could not remove ${failures.length} from ${dir}: ${messageOf(failures[0])}`);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The files directory as a store: `<dir>/<sha256[0:2]>/<sha256>`. */
export class LocalFileStore implements FileStore {
  readonly storage = 'local' as const;

  constructor(private readonly dir: string) {}

  pathOf(sha256: string): string {
    return path.join(this.dir, sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(sha256))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async put(sha256: string, tempPath: string): Promise<void> {
    const target = this.pathOf(sha256);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      // Atomic: a reader sees no file or the whole of it. The same content stored twice at once is two
      // renames of identical bytes onto one name, and either one may win.
      await rename(tempPath, target);
    } catch (error) {
      await removeTempFile(tempPath);
      throw error;
    }
    // The rename is on disk before the row that names these bytes is written.
    const directory = await open(path.dirname(target), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async open(sha256: string): Promise<Readable | null> {
    const file = this.pathOf(sha256);
    let fd: number;
    try {
      fd = await openDescriptor(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return closedWhenDropped(createReadStream(file, { fd }), fd);
  }

  async remove(sha256: string): Promise<void> {
    await removeTempFile(this.pathOf(sha256));
  }
}
