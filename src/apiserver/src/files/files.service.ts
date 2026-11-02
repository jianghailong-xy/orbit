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
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
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
import type { FileUpload } from './file-upload-storage';
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
 * `data` column until those rows are moved. What agents keep with `file_upload` and find with `file_list` is the same
 * rows, with the doors at the end of this class.
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
    if (row.sha256 && row.blob) {
      const content = await this.storeOf(row.blob.storage)?.open(row.sha256);
      if (content) return { content, mimeType, fileName, sizeBytes: row.blob.sizeBytes };
    }
    const legacy = await this.prisma.attachment.findUnique({ where: { id: row.id }, select: { data: true } });
    if (legacy?.data) {
      const data = Buffer.from(legacy.data);
      return { content: data, mimeType, fileName, sizeBytes: data.length };
    }
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

  /**
   * The sha256 a copy of the attachment row `row` names, so that a copy is a row and never the bytes again:
   * the row's own, or — for a row whose bytes are still in `data` — that of those bytes once they are kept,
   * written onto the row so that the next copy reads it there.
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
      const evidence = await this.prisma.taskCompletionEvidence.findFirst({ where: { id: evidenceId, ownerId }, select: { id: true } });
      if (!evidence) throw new NotFoundException('evidence not found');
      scope = { evidenceId };
    }
    const rows = await this.prisma.attachment.findMany({
      where: {
        AND: [
          scope,
          { ownerId },
          { OR: [{ fileBundleId: null }, { fileBundleId: { equals: this.prisma.attachment.fields.id } }] },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FILE_LIST_LIMIT + 1,
      select: FILE_VIEW_SELECT,
    });
    return { files: rows.slice(0, FILE_LIST_LIMIT).map(fileView), truncated: rows.length > FILE_LIST_LIMIT };
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

/**
 * An opened file as a download route answers it: typed and sized, inline only when its type may be shown
 * (UserFileResponseInterceptor) and otherwise saved under its own name. With the route's response, a
 * stream from the store is ended when the response closes, so a client that leaves early does not hold a
 * file or a connection to the bucket open.
 */
export function streamable(file: OpenedFile, response?: Pick<Response, 'once'>): StreamableFile {
  const { content } = file;
  const disposition = inlineType(file.mimeType) ? 'inline' : attachmentDisposition(file.fileName ?? 'attachment');
  const options = { type: file.mimeType, disposition, length: file.sizeBytes };
  if (Buffer.isBuffer(content)) return new StreamableFile(content, options);
  response?.once('close', () => content.destroy());
  return new StreamableFile(content, options);
}
