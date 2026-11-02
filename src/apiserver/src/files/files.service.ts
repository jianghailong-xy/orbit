import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  StreamableFile,
} from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, statfs } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { sessionJudgesEvidence } from '../tasks/task-evidence-decision';
import { citedFileIds, storedEvidenceEnvelope, type EvidenceCheck } from '../tasks/task-evidence-envelope';
import {
  LocalFileStore,
  filesConfigFrom,
  removeTempFile,
  uploadTempDir,
  writeHashedTempFile,
  type FileStorage,
  type FileStore,
  type FilesConfig,
  type HashedTempFile,
} from './file-store';
import { refuseCredentialIn } from './file-secret-scan';
import type { FileUpload } from './file-upload-storage';
import { IMAGE_HEADER_BYTES, imageSizeOf, type ImageSize } from './image-size';
import { S3FileStore } from './s3-file-store';
import { parseTestReport, type TestReportSummary, type TEST_REPORT_UPLOAD } from './test-report';
import { attachmentDisposition, inlineType } from './user-file-response';

/** A FilesConfig to use instead of the environment's; nothing provides one but a spec. */
export const FILES_CONFIG = Symbol('FILES_CONFIG');

/** An attachment's bytes, ready to be answered with. */
export interface OpenedFile {
  /** A stream from the file store, or the bytes of a row from before Orbit Files. */
  content: Readable | Buffer;
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
}

/**
 * `attachment.retention` of a row `file_upload` wrote (§2.8): an upload that expires unless evidence references it.
 * A reply's image and a person's upload come through doors of their own and stay NULL, which follows their session or
 * task; this is what tells the retention rules the two apart.
 */
export const FILE_UPLOAD_RETENTION = 'file_upload';

/** The type of a folder bundle's manifest. It only says how to read the bytes: what makes a row a bundle is `fileBundleId`. */
export const FILE_BUNDLE_MIME_TYPE = 'application/vnd.orbit.file-bundle+json';

/** How long a label may be. */
export const MAX_FILE_LABEL_CHARS = 200;

/**
 * How many files one folder bundle holds. Far above an evidence directory's p90 of 142, and low enough that a mistaken
 * `node_modules` is refused at once instead of being uploaded for an hour. `src/runner-go/file_tools.go` says the same
 * number, to refuse before anything is sent.
 */
export const MAX_BUNDLE_FILES = 1000;

/** How long a file's path in its bundle may be. */
export const MAX_BUNDLE_PATH_CHARS = 1024;

/** How many rows one `file_list` answers: a row per upload, so a folder of any size is one of them. */
const FILE_LIST_LIMIT = 200;

/**
 * How many files one page of `evidenceFiles` holds: a whole folder, so most versions are one read. A version cites at most
 * 50 things and each can be a folder of 1000, so the whole list can be 50,000 files, and only a page of it is answered at a
 * time. The largest page, with every path and label at its limit, measures 1.7 MB of JSON.
 */
export const EVIDENCE_FILES_PAGE = MAX_BUNDLE_FILES;

/** The largest revision a `bigint` column holds. */
const MAX_REVISION = 9_223_372_036_854_775_807n;

/** What `file_upload` says of a file it was told is a test report and could not read as one. */
export const NOT_A_TEST_REPORT = 'Not a Playwright JSON or JUnit XML report, so this was kept as a plain file, with no test summary.';

/** One file as the agents' doors describe it (`file_upload`, `file_fetch`, `file_list`). */
export interface FileView {
  id: string;
  /** `bundle` on a folder bundle's manifest, whose bytes say which files are in it. */
  kind: 'file' | 'bundle';
  /** What it is called: for a file in a bundle, its path in the folder. Null on a pasted image. */
  name: string | null;
  label: string | null;
  mimeType: string;
  sizeBytes: number;
  /** Null on a row from before Orbit Files, until its bytes are moved. */
  sha256: string | null;
  sessionId: string | null;
  taskId: string | null;
  /** The bundle a file is in; on a bundle's manifest, its own id. */
  fileBundleId: string | null;
  /** What `file_upload --as test-report` read out of this file; null on every other file. */
  testReport: TestReportSummary | null;
  createdAt: Date;
}

const FILE_VIEW_SELECT = {
  id: true,
  fileName: true,
  label: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  sessionId: true,
  taskId: true,
  fileBundleId: true,
  testReportSummary: true,
  createdAt: true,
} as const satisfies Prisma.AttachmentSelect;

type FileViewRow = Prisma.AttachmentGetPayload<{ select: typeof FILE_VIEW_SELECT }>;

function fileView({ fileName, testReportSummary, ...row }: FileViewRow): FileView {
  return {
    ...row,
    kind: row.fileBundleId === row.id ? 'bundle' : 'file',
    name: fileName,
    testReport: testReportSummary as unknown as TestReportSummary | null,
  };
}

const EVIDENCE_FILE_SELECT = { ...FILE_VIEW_SELECT, expiredAt: true } as const satisfies Prisma.AttachmentSelect;

type EvidenceFileRow = Prisma.AttachmentGetPayload<{ select: typeof EVIDENCE_FILE_SELECT }>;

/**
 * One file of a version of evidence, as an evidence card reads it: `FileView`, and what a card wants beside it. The id is
 * the public id, the one the citation's `ref` holds, and `name` is a file of a folder's path in that folder.
 *
 * When `gone` is true the cited row itself no longer exists, as when its session was deleted. All that is left is what the
 * version recorded: `id`, `sha256` and the image's size. Everything the row held is null.
 */
export interface EvidenceFileView extends Omit<FileView, 'mimeType' | 'sizeBytes' | 'createdAt'> {
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: Date | null;
  /** The folder it was uploaded in; null on a file cited by itself. */
  folder: string | null;
  /** An image's size in pixels, known only for an image cited by itself. */
  width: number | null;
  height: number | null;
  /** When its bytes expired (§2.8). The row stays, so everything else here still reads. */
  expiredAt: Date | null;
  gone: boolean;
}

/** One page of a version's files. `fileCount` and `totalBytes` are the whole list's, whichever page this is. */
export interface EvidenceFileList {
  revision: string;
  submittedAt: Date;
  fileCount: number;
  totalBytes: number;
  files: EvidenceFileView[];
  /** The `offset` of the next page, or null when this is the last. */
  nextOffset: number | null;
}

/** A cited row, or a folder's rows, in the order of the version's citations. */
type EvidenceFileSection =
  | { fileCount: 1; totalBytes: number; file: EvidenceFileView }
  | { fileCount: number; totalBytes: number; folder: EvidenceFileRow };

/** A folder bundle's manifest: what its bytes are (docs/orbit-files-design.md §2.2). Ids are public ids. */
export interface FileBundleManifest {
  kind: 'orbit-file-bundle';
  version: 1;
  name: string;
  label: string | null;
  fileCount: number;
  totalBytes: number;
  /** By path, each with the bytes it was bundled with: a reference to the manifest's sha256 binds all of them. */
  files: { path: string; id: string; sha256: string; sizeBytes: number; mimeType: string }[];
}

/** Refuses a path that could not be written back under a folder: absolute, climbing out of it, or naming nothing. */
function assertBundlePath(filePath: string): void {
  // eslint-disable-next-line no-control-regex
  const refused = /[\\\x00-\x1f\x7f]/.test(filePath) || filePath.split('/').some((part) => ['', '.', '..'].includes(part));
  if (refused) throw new BadRequestException(`a bundle's paths are relative, with / between their parts: ${JSON.stringify(filePath)}`);
}

/**
 * Orbit Files' storage layer (docs/orbit-files-design.md §2.1): an attachment row describes a file, and
 * its bytes are kept once per content in a file store — the files directory, or an S3-compatible bucket —
 * under their sha256, with a `file_blob` row saying which. Every attachment upload is kept here; every read
 * of an attachment's bytes comes through `open`, which serves a row from before Orbit Files from its own
 * `data` column until the copy of old attachments reaches it (attachment-migration.ts). What agents keep with
 * `file_upload` and find with `file_list` is the same rows, with the doors at the end of this class.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  readonly config: FilesConfig;
  private readonly local: LocalFileStore;
  private readonly s3: S3FileStore | null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(FILES_CONFIG) config?: FilesConfig,
  ) {
    this.config = config ?? filesConfigFrom();
    this.local = new LocalFileStore(this.config.dir);
    this.s3 = this.config.s3 ? new S3FileStore(this.config.s3) : null;
  }

  /** The store new bytes go to. */
  private get target(): FileStore {
    return this.s3 ?? this.local;
  }

  private storeOf(storage: string): FileStore | null {
    if (storage === 'local') return this.local;
    if (storage === 's3') return this.s3;
    return null;
  }

  /**
   * Keep a hashed temporary file's bytes and return their sha256. When the same bytes are already kept,
   * the file is dropped and nothing is written but the file_blob row's `lastReferencedAt`; otherwise it
   * moves into the store new bytes go to. Either way the temporary file is gone afterwards, and the
   * file_blob row exists before the caller writes a row that names it.
   */
  async store(file: HashedTempFile): Promise<string> {
    const { sha256, size } = file;
    const known = await this.prisma.fileBlob.findUnique({ where: { sha256 }, select: { storage: true } });
    const holder = known ? this.storeOf(known.storage) : null;
    let storage: FileStorage;
    if (holder && (await holder.has(sha256))) {
      await removeTempFile(file.path);
      storage = holder.storage;
    } else {
      // New bytes, or bytes whose row outlived them (a files directory restored older than the database):
      // kept again, where new bytes go.
      await this.target.put(sha256, file.path, size);
      storage = this.target.storage;
    }
    const now = new Date();
    await this.prisma.fileBlob.upsert({
      where: { sha256 },
      create: { sha256, sizeBytes: size, storage, lastReferencedAt: now },
      update: { storage, lastReferencedAt: now },
    });
    return sha256;
  }

  /** Keep bytes a caller already holds (each caller's are bounded by MAX_UPLOAD_BYTES). */
  async storeBytes(data: Uint8Array): Promise<string> {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const temp = await writeHashedTempFile(Readable.from([bytes]), uploadTempDir(this.config.dir));
    try {
      return await this.store(temp);
    } finally {
      await removeTempFile(temp.path);
    }
  }

  /** A new attachment row for an upload the route has accepted: the bytes kept, then the row naming them. */
  async createAttachment(
    upload: FileUpload,
    scope: {
      ownerId: string;
      sessionId?: string | null;
      taskId?: string | null;
      label?: string | null;
      retention?: string | null;
      testReport?: TestReportSummary | null;
    },
  ): Promise<{ id: string }> {
    const sha256 = await this.store(upload);
    return this.prisma.attachment.create({
      data: {
        ownerId: scope.ownerId,
        sessionId: scope.sessionId ?? null,
        taskId: scope.taskId ?? null,
        mimeType: upload.mimetype,
        sizeBytes: upload.size,
        fileName: upload.originalname || null,
        sha256,
        label: scope.label ?? null,
        retention: scope.retention ?? null,
        testReportSummary: (scope.testReport ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true },
    });
  }

  /**
   * The bytes of the attachment row `where` finds — `where` says whose it may be, which is the caller's
   * to decide — or null when it finds none. From the store the row's sha256 names, or, for a row whose bytes
   * are not in one, from its `data`.
   */
  async open(where: Prisma.AttachmentWhereInput): Promise<OpenedFile | null> {
    const row = await this.prisma.attachment.findFirst({
      where,
      select: {
        id: true,
        mimeType: true,
        fileName: true,
        sha256: true,
        blob: { select: { storage: true, sizeBytes: true } },
      },
    });
    if (!row) return null;
    const { mimeType, fileName } = row;
    let storeFailure: unknown;
    if (row.sha256 && row.blob) {
      try {
        const content = await this.storeOf(row.blob.storage)?.open(row.sha256);
        if (content) return { content, mimeType, fileName, sizeBytes: row.blob.sizeBytes };
      } catch (error) {
        // A row the copy has reached is not left to a store that fails while its bytes are still in `data`.
        storeFailure = error;
      }
    }
    const legacy = await this.prisma.attachment.findUnique({ where: { id: row.id }, select: { data: true, sha256: true } });
    if (legacy?.data) {
      const data = Buffer.from(legacy.data);
      return { content: data, mimeType, fileName, sizeBytes: data.length };
    }
    // Copied and cleared since `row` was read (attachment-migration.ts): the row names its bytes now.
    if (legacy?.sha256 && !row.sha256) return this.open({ id: row.id });
    if (storeFailure) throw storeFailure;
    this.logger.error(
      `attachment ${row.id} names bytes ${row.sha256} that the ${row.blob?.storage ?? 'configured'} file store does not hold`,
    );
    throw new NotFoundException('attachment bytes are missing');
  }

  /** The whole of an attachment's bytes, for a caller that hands them on in one piece. */
  async read(where: Prisma.AttachmentWhereInput): Promise<{ data: Buffer; mimeType: string } | null> {
    const file = await this.open(where);
    if (!file) return null;
    if (Buffer.isBuffer(file.content)) return { data: file.content, mimeType: file.mimeType };
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(chunk as Buffer);
    return { data: Buffer.concat(chunks), mimeType: file.mimeType };
  }

  /** The first `limit` bytes of an attachment, and no more of it than that is read: a stream leaves off at the `break`. */
  private async head(where: Prisma.AttachmentWhereInput, limit: number): Promise<Buffer> {
    const file = await this.open(where);
    if (!file) return Buffer.alloc(0);
    if (Buffer.isBuffer(file.content)) return file.content.subarray(0, limit);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of file.content) {
      chunks.push(chunk as Buffer);
      length += (chunk as Buffer).length;
      if (length >= limit) break;
    }
    return Buffer.concat(chunks).subarray(0, limit);
  }

  /** The room left on the disk under the files directory. */
  async freeBytes(): Promise<number> {
    await mkdir(this.config.dir, { recursive: true });
    const { bavail, bsize } = await statfs(this.config.dir);
    return bavail * bsize;
  }

  /**
   * What the store `blob` names really holds under its name, read back to the last byte: what the clear checks before it
   * lets a row's `data` go. Null when it holds nothing there, or when this deployment has no such store. The bytes pass
   * through in the store's own chunks, so a file of any size takes the same memory.
   */
  async readBack(blob: { sha256: string; storage: string }): Promise<{ sha256: string; sizeBytes: number } | null> {
    const content = await this.storeOf(blob.storage)?.open(blob.sha256);
    if (!content) return null;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of content) {
      hash.update(chunk as Buffer);
      sizeBytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), sizeBytes };
  }

  /**
   * What citing these files as evidence takes from the file store (§2.4), before the transaction that saves it, which holds
   * the task's lock: a row from before Orbit Files gets the sha256 the citation binds, and an image's header says how big
   * it is, which is kept on the citation so that no later read of it has to come here. Keyed by file. The citation
   * itself is judged in that transaction, so this reads the owner's rows whether or not it will hold.
   */
  async prepareCitedFiles(ownerId: string, ids: string[]): Promise<Map<string, ImageSize>> {
    const images = new Map<string, ImageSize>();
    if (ids.length === 0) return images;
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true, sha256: true, mimeType: true },
    });
    for (const row of rows) {
      await this.referenceOf(row);
      if (!row.mimeType.startsWith('image/')) continue;
      const size = imageSizeOf(await this.head({ id: row.id }, IMAGE_HEADER_BYTES));
      if (size) images.set(row.id, size);
    }
    return images;
  }

  /**
   * The sha256 a copy of the attachment row `row` names, so that a copy is a row and never the bytes again:
   * the row's own, or — for a row whose bytes are still in `data` — that of those bytes once they are kept,
   * written onto the row so that the next copy reads it there. The copy of old attachments is this, a row at a time
   * (attachment-migration.ts). `data` stays: only the clear takes it.
   */
  async referenceOf(row: { id: string; sha256: string | null }): Promise<string> {
    if (row.sha256) return row.sha256;
    const legacy = await this.prisma.attachment.findUnique({ where: { id: row.id }, select: { data: true, sha256: true } });
    if (!legacy) throw new NotFoundException('attachment not found');
    if (legacy.sha256) return legacy.sha256;
    // attachment_bytes_present: a row that names no bytes in the store has them in `data`.
    const sha256 = await this.storeBytes(legacy.data as Uint8Array);
    await this.prisma.attachment.updateMany({ where: { id: row.id, sha256: null }, data: { sha256 } });
    return sha256;
  }

  /**
   * A file an agent keeps (`file_upload`). It is always a row of the session that uploaded it, which is what lets that
   * session fetch it and what makes it its task's: `listFiles` finds it through `session.taskId`, and a row of the
   * task's own would be a template that every later run gets in its prompt (migration 0241,
   * tasks.service.ts#copyTaskAttachments). So `taskId` can only say which task the session believes it is running, and
   * anything else is refused before a row is written.
   *
   * `as` asks for a test report's summary, read here because the temporary file is gone once `store` has kept it. The
   * upload never depends on it: a file that is no report is kept all the same, and the answer's `note` says so.
   */
  async uploadFile(
    upload: FileUpload,
    session: { id: string; ownerId: string; taskId: string | null },
    options: { taskId?: string; label?: string; as?: typeof TEST_REPORT_UPLOAD },
  ): Promise<FileView & { note?: string }> {
    await refuseCredentialIn(upload);
    if (options.taskId !== undefined && options.taskId !== session.taskId) {
      throw new BadRequestException(
        'taskId has to be the task this session is running, or left out: a file stays with the session that uploads it, '
          + "and counts as that session's task. To give a file to another task as an input, use task_create's attachmentIds.",
      );
    }
    const testReport = options.as ? parseTestReport(await readFile(upload.path, 'utf8')) : null;
    const { id } = await this.createAttachment(upload, {
      ownerId: session.ownerId,
      sessionId: session.id,
      label: options.label?.trim() || null,
      retention: FILE_UPLOAD_RETENTION,
      testReport,
    });
    const view = fileView(await this.prisma.attachment.findUniqueOrThrow({ where: { id }, select: FILE_VIEW_SELECT }));
    return options.as && !testReport ? { ...view, note: NOT_A_TEST_REPORT } : view;
  }

  /**
   * Which row a session may read as `fileId` (§2.7), as the `where` for `open` and `describeFile`: a file of its own, or one
   * an evidence revision cites when that task's evidence is this session's to judge (`sessionJudgesEvidence`). Anything
   * else comes to the first, which finds nothing, so that a file a session may not read is a file that is not there.
   *
   * A bundle's files name the revision too, so a judge given the manifest can fetch what it lists. Nothing of another
   * account's is found: every read here is under this session's owner.
   */
  async readableInSession(
    session: { id: string; ownerId: string; taskId: string | null },
    fileId: string,
  ): Promise<Prisma.AttachmentWhereInput> {
    const ownerId = session.ownerId;
    const cited = await this.prisma.attachment.findFirst({
      where: { id: fileId, ownerId, evidenceId: { not: null } },
      select: { evidenceId: true },
    });
    const evidence = cited && await this.prisma.taskCompletionEvidence.findFirst({
      where: { id: cited.evidenceId!, ownerId },
      select: { taskId: true },
    });
    return evidence && (await sessionJudgesEvidence(this.prisma, { ownerId, taskId: evidence.taskId }, session))
      ? { id: fileId, ownerId }
      : { id: fileId, sessionId: session.id };
  }

  /** The row `where` finds, as an agent is told of it; null when it finds none. `where` says whose it may be. */
  async describeFile(where: Prisma.AttachmentWhereInput): Promise<FileView | null> {
    const row = await this.prisma.attachment.findFirst({ where, select: FILE_VIEW_SELECT });
    return row && fileView(row);
  }

  /**
   * The owner's files of one task, one session or one evidence version, newest first (`file_list`). A task's are its
   * inputs and what the sessions that ran it kept with `file_upload`: not everything in those sessions, because every
   * run holds its own copy of each input (tasks.service.ts#copyTaskAttachments), under another id, and one input would
   * be listed once per run. A bundle is one row, not its files: its manifest lists them, and a folder of any size does
   * not crowd out everything else. An id that names nothing of the owner's is refused rather than answered empty, so
   * that a mistyped id is not read as "no files".
   *
   * An evidence version's are what it cites, read off the version itself because `attachment.evidence_id` names only the
   * newest version citing a file. A file of a bundle cited by itself is listed, being what the version says.
   */
  async listFiles(
    ownerId: string,
    filter: { taskId?: string; sessionId?: string; evidenceId?: string },
  ): Promise<{ files: FileView[]; truncated: boolean }> {
    const { taskId, sessionId, evidenceId } = filter;
    if ([taskId, sessionId, evidenceId].filter((id) => id !== undefined).length !== 1) {
      throw new BadRequestException('name exactly one of taskId, sessionId or evidenceId');
    }
    let scope: Prisma.AttachmentWhereInput;
    if (taskId) {
      const task = await this.prisma.task.findFirst({ where: { id: taskId, ownerId }, select: { id: true } });
      if (!task) throw new NotFoundException('task not found');
      scope = { OR: [{ taskId }, { retention: FILE_UPLOAD_RETENTION, session: { taskId, deletedAt: null } }] };
    } else if (sessionId) {
      const session = await this.prisma.session.findFirst({ where: { id: sessionId, ownerId, deletedAt: null }, select: { id: true } });
      if (!session) throw new NotFoundException('session not found');
      scope = { sessionId };
    } else {
      const version = await this.prisma.taskCompletionEvidence.findFirst({ where: { id: evidenceId, ownerId }, select: { evidence: true } });
      if (!version) throw new NotFoundException('evidence not found');
      scope = { id: { in: citedFileIds(storedEvidenceEnvelope(version.evidence)?.checks ?? []) } };
    }
    const rows = await this.prisma.attachment.findMany({
      where: {
        AND: [
          scope,
          { ownerId },
          evidenceId ? {} : { OR: [{ fileBundleId: null }, { fileBundleId: { equals: this.prisma.attachment.fields.id } }] },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FILE_LIST_LIMIT + 1,
      select: FILE_VIEW_SELECT,
    });
    return { files: rows.slice(0, FILE_LIST_LIMIT).map(fileView), truncated: rows.length > FILE_LIST_LIMIT };
  }

  /**
   * The files one version of a task's evidence cites, for the card that shows them (§2.6): each cited file and each file of
   * a cited folder, in the order the version cites them, and a folder's by path. A file cited twice, or cited beside its
   * folder, is one entry. A task of another account is the same 404 as a task that does not exist.
   *
   * Everything here is read from rows and none of it from the store, a folder's manifest included: expiry takes the bytes
   * and leaves the rows (§2.8), so an expired file reads as it always did. `listFiles` answers the agents' doors, which want
   * a folder as one row; a card wants what is in it.
   */
  async evidenceFiles(ownerId: string, taskId: string, revision: string, offset = 0): Promise<EvidenceFileList> {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, ownerId }, select: { id: true } });
    if (!task) throw new NotFoundException('task not found');
    const number = /^[1-9]\d{0,18}$/.test(revision) ? BigInt(revision) : null;
    const version = number === null || number > MAX_REVISION
      ? null
      : await this.prisma.taskCompletionEvidence.findFirst({
        where: { taskId, ownerId, revision: number },
        select: { revision: true, submittedAt: true, evidence: true },
      });
    if (!version) throw new NotFoundException('evidence not found');
    const checks = new Map((storedEvidenceEnvelope(version.evidence)?.checks ?? []).flatMap((check) => {
      const [id] = citedFileIds([check]);
      return id ? [[id, check] as const] : [];
    }));
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: [...checks.keys()] }, ownerId },
      select: EVIDENCE_FILE_SELECT,
    });
    const found = new Map(rows.map((row) => [row.id, row]));
    const folders = rows.filter((row) => row.fileBundleId === row.id);
    const held = new Map(await Promise.all(folders.map(async (folder) => {
      const { _count, _sum } = await this.prisma.attachment.aggregate({
        where: membersOf(ownerId, folder),
        _count: { _all: true },
        _sum: { sizeBytes: true },
      });
      return [folder.id, { fileCount: _count._all, totalBytes: _sum.sizeBytes ?? 0 }] as const;
    })));
    const sections = [...checks].flatMap(([id, check]): EvidenceFileSection[] => {
      const row = found.get(id);
      if (!row) return [{ fileCount: 1, totalBytes: 0, file: goneFile(check) }];
      if (row.fileBundleId !== null && row.fileBundleId !== id && held.has(row.fileBundleId)) return [];
      const folder = held.get(id);
      return folder ? [{ ...folder, folder: row }] : [{ fileCount: 1, totalBytes: row.sizeBytes, file: evidenceFile(row, null, check) }];
    });
    const files: EvidenceFileView[] = [];
    let skip = offset;
    for (const section of sections) {
      if (files.length === EVIDENCE_FILES_PAGE) break;
      if (skip >= section.fileCount) {
        skip -= section.fileCount;
      } else if ('file' in section) {
        files.push(section.file);
        skip = 0;
      } else {
        const members = await this.prisma.attachment.findMany({
          where: membersOf(ownerId, section.folder),
          orderBy: [{ fileName: 'asc' }, { id: 'asc' }],
          skip,
          take: EVIDENCE_FILES_PAGE - files.length,
          select: EVIDENCE_FILE_SELECT,
        });
        for (const member of members) files.push(evidenceFile(member, section.folder, checks.get(member.id)));
        skip = 0;
      }
    }
    const fileCount = sections.reduce((sum, section) => sum + section.fileCount, 0);
    const next = offset + files.length;
    return {
      revision: version.revision.toString(),
      submittedAt: version.submittedAt,
      fileCount,
      totalBytes: sections.reduce((sum, section) => sum + section.totalBytes, 0),
      files,
      nextOffset: files.length > 0 && next < fileCount ? next : null,
    };
  }

  /**
   * A folder bundle (§2.2): a manifest, kept like any file, that says which path of the folder each of these uploaded
   * files is. All or nothing: the manifest's row and the files' claim on it commit together, and a file already in a
   * bundle, or claimed by another bundle meanwhile, refuses the whole of it. Only a session's own `file_upload`s can be
   * bundled, and a row is a bundle only because this wrote `file_bundle_id = id`, which no request can: a client chooses
   * its upload's type and name, so neither could say so.
   */
  async createBundle(
    session: { id: string; ownerId: string },
    input: { name: string; label?: string; files: { path: string; id: string }[] },
  ): Promise<FileView> {
    const { ownerId, id: sessionId } = session;
    for (const { path } of input.files) assertBundlePath(path);
    if (new Set(input.files.map((file) => file.path)).size !== input.files.length) {
      throw new BadRequestException('a bundle holds one file at each path');
    }
    if (new Set(input.files.map((file) => file.id)).size !== input.files.length) {
      throw new BadRequestException('a bundle holds each file once');
    }
    const rows = await this.prisma.attachment.findMany({
      where: {
        id: { in: input.files.map((file) => file.id) },
        ownerId,
        sessionId,
        turnId: null,
        fileBundleId: null,
        retention: FILE_UPLOAD_RETENTION,
      },
      select: { id: true, sha256: true, sizeBytes: true, mimeType: true },
    });
    const uploaded = new Map(rows.map((row) => [row.id, row]));
    const label = input.label?.trim() || null;
    const manifest: FileBundleManifest = {
      kind: 'orbit-file-bundle',
      version: 1,
      name: input.name,
      label,
      fileCount: input.files.length,
      totalBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      files: input.files
        .map(({ path, id }) => {
          const row = uploaded.get(id);
          // By path, which is the caller's own word: an id here would tell one account's id from one that names nothing.
          if (!row?.sha256) throw new NotFoundException(`not a file this session uploaded and has not bundled: ${JSON.stringify(path)}`);
          return { path, id: uuidToBase62(id), sha256: row.sha256, sizeBytes: row.sizeBytes, mimeType: row.mimeType };
        })
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const sha256 = await this.storeBytes(bytes);
    const id = randomUUID();
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await tx.attachment.create({
          data: {
            id,
            ownerId,
            sessionId,
            mimeType: FILE_BUNDLE_MIME_TYPE,
            sizeBytes: bytes.length,
            fileName: `${input.name}.json`,
            sha256,
            label,
            retention: FILE_UPLOAD_RETENTION,
            fileBundleId: id,
          },
        });
        const claimed = await tx.$executeRaw`
          UPDATE attachment AS a
          SET file_bundle_id = ${id}::uuid, file_name = f.path
          FROM unnest(${input.files.map((file) => file.id)}::uuid[], ${input.files.map((file) => file.path)}::text[]) AS f(id, path)
          WHERE a.id = f.id AND a.session_id = ${sessionId}::uuid AND a.owner_id = ${ownerId}::uuid AND a.file_bundle_id IS NULL`;
        if (claimed !== input.files.length) throw new ConflictException('a file of this bundle is already in another bundle');
      },
      loggedRetry(this.logger, 'files.createBundle'),
    );
    return fileView(await this.prisma.attachment.findUniqueOrThrow({ where: { id }, select: FILE_VIEW_SELECT }));
  }
}

/** The rows of a folder's files: every one is a row of the session that bundled them, and the manifest is not one of them. */
function membersOf(ownerId: string, folder: EvidenceFileRow): Prisma.AttachmentWhereInput {
  return { ownerId, sessionId: folder.sessionId, fileBundleId: folder.id, id: { not: folder.id } };
}

/** A row as `evidenceFiles` answers it. A manifest's name is the folder's with `.json` after it (`createBundle`). */
function evidenceFile(
  { expiredAt, ...row }: EvidenceFileRow,
  folder: EvidenceFileRow | null,
  check?: Pick<EvidenceCheck, 'width' | 'height'>,
): EvidenceFileView {
  return {
    ...fileView(row),
    id: uuidToBase62(row.id),
    folder: folder?.fileName?.replace(/\.json$/, '') ?? null,
    width: check?.width ?? null,
    height: check?.height ?? null,
    expiredAt,
    gone: false,
  };
}

/** A cited row that no longer exists, from what the version itself recorded of it. */
function goneFile({ ref, sha256, width, height }: EvidenceCheck): EvidenceFileView {
  return {
    id: ref,
    kind: 'file',
    name: null,
    label: null,
    mimeType: null,
    sizeBytes: null,
    sha256: sha256 ?? null,
    sessionId: null,
    taskId: null,
    fileBundleId: null,
    testReport: null,
    createdAt: null,
    folder: null,
    width: width ?? null,
    height: height ?? null,
    expiredAt: null,
    gone: true,
  };
}

/**
 * An opened file as a download route answers it: typed and sized, inline only when its type may be shown
 * (UserFileResponseInterceptor) and otherwise saved under its own name. With the route's response, a
 * stream from the store is ended when the response closes, or at once if it has closed already, while the
 * row was read and the store opened: a client that leaves early, at any point, does not hold a file or a
 * connection to the bucket open.
 */
export function streamable(file: OpenedFile, response?: Pick<Response, 'once' | 'destroyed'>): StreamableFile {
  const { content } = file;
  const disposition = inlineType(file.mimeType) ? 'inline' : attachmentDisposition(file.fileName ?? 'attachment');
  const options = { type: file.mimeType, disposition, length: file.sizeBytes };
  if (Buffer.isBuffer(content)) return new StreamableFile(content, options);
  if (response?.destroyed) content.destroy();
  else response?.once('close', () => content.destroy());
  return new StreamableFile(content, options);
}
