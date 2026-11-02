import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
  /** The bytes named `sha256`, read as a stream; null when they are not kept here. */
  open(sha256: string): Promise<Readable | null>;
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
}

export const DEFAULT_FILES_DIR = '/var/lib/orbit/files';

/** ORBIT_FILES_DIR, or its default. */
export function filesDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORBIT_FILES_DIR?.trim() || DEFAULT_FILES_DIR;
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
  const backend = env.ORBIT_FILES_BACKEND?.trim() || 'local';
  if (backend === 'local') return { dir, storage: 'local' };
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
  return { dir, storage: 's3', s3 };
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
  const handle = await open(tempPath, 'wx');
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
    await pipeline(source, hashing, handle.createWriteStream({ flush: true }));
  } catch (error) {
    await removeTempFile(tempPath);
    throw error;
  }
  return { path: tempPath, size, sha256: hash.digest('hex') };
}

/** Remove a temporary file; one that is already gone is no error. */
export async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
    try {
      const handle = await open(this.pathOf(sha256), 'r');
      return handle.createReadStream();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
