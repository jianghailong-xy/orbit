import { checkDuration } from './checkDuration';
import { isRasterImage } from './userFile';
import { formatFileSize } from './worktreeFile';

/**
 * What an evidence card says about the files a version of evidence cites (docs/orbit-files-design.md
 * §2.5, §2.6): the words, and the reading of the rows those words come from. The components in
 * `EvidenceFiles.tsx` draw this and decide nothing about it.
 *
 * The native clients keep the same copy, so every word is a declaration or a template literal here,
 * in one file their copy parity tests can read.
 */

/** The file area's small heading. */
export const EVIDENCE_FILES_HEADING = 'FILES';
/** The page the file area opens. */
export const EVIDENCE_FILES_TITLE = 'Evidence files';
/** After the heading, ahead of the date, once every file has expired. */
export const EVIDENCE_FILES_EXPIRED = 'EXPIRED';
/** On the grey tile that takes an expired file's picture, ahead of the date. */
export const EVIDENCE_FILE_EXPIRED = 'Expired';
/** The group of the files that were not uploaded in a folder. */
export const EVIDENCE_FILES_NO_FOLDER = 'Files';
/** The viewer's button, and the verb on a tile that can only be saved. */
export const EVIDENCE_FILE_DOWNLOAD = 'Download';
/** Under a list with more files than the page holds. */
export const EVIDENCE_FILES_SHOW_MORE = 'Show more';
/** What a save that failed says. */
export const EVIDENCE_FILE_DOWNLOAD_FAILED = "Couldn't download the file";
/** What the area says while the list is read, and when it could not be. */
export const EVIDENCE_FILES_LOADING = 'Reading…';
export const EVIDENCE_FILES_UNREAD = 'The files could not be read just now.';
/** What presses a file's pin, either way (§2.8). */
export const EVIDENCE_FILE_PIN = 'Pin';
export const EVIDENCE_FILE_UNPIN = 'Unpin';
/** What a pinned file says of how long it stays, where one with a date says when it expires. */
export const EVIDENCE_FILE_PINNED = 'Pinned';
/** What a press that did not go through says. */
export const EVIDENCE_FILE_PIN_FAILED = "Couldn't pin the file";
export const EVIDENCE_FILE_UNPIN_FAILED = "Couldn't unpin the file";
/** The two lists a test report opens into. */
export const EVIDENCE_REPORT_FAILED = 'Failed';
export const EVIDENCE_REPORT_SKIPPED = 'Skipped';
/** How many thumbnails the card draws before it counts the rest. */
export const EVIDENCE_FILES_SHOWN = 4;
/** How many failed cases the card names; the page names the rest. */
export const EVIDENCE_REPORT_NAMES_SHOWN = 3;

/** `+5`, on the tile after the last thumbnail. */
export const evidenceFilesMore = (rest: number): string => `+${rest}`;
/** `3 of 8`, in the viewer. */
export const evidenceFilePosition = (position: number, total: number): string => `${position} of ${total}`;
/** `Download report.html`: what a tile that can only be saved is called. */
export const evidenceFileDownloadName = (name: string): string => `${EVIDENCE_FILE_DOWNLOAD} ${name}`;
/** `2 more`, under the failed names the card shows. */
export const evidenceReportNamesMore = (rest: number): string => `${rest} more`;
/** `Revision 2`, ahead of when it was submitted. */
export const evidenceRevisionLine = (revision: string): string => `Revision ${revision}`;

/** What `file_upload --as test-report` kept of a report (apiserver files/test-report.ts). */
export interface EvidenceTestReport {
  format: 'playwright' | 'junit';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  /** At most twenty of each, so a count may be more than its list. */
  failedNames: string[];
  skippedNames: string[];
}

/**
 * One file of a version of evidence, as `GET /tasks/:taskId/evidence/:revision/files` lists it (apiserver
 * files/files.service.ts). Read from rows, so an expired file reads as it always did. When `gone` is true the row itself no
 * longer exists: only the id, the sha256 and an image's size are left, which the version recorded.
 */
export interface EvidenceFile {
  id: string;
  /** Its path in the folder it was uploaded in, or its own name. Null on a pasted image, and when gone. */
  name: string | null;
  /** The folder it was uploaded in; null on a file cited by itself. */
  folder: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  /** Known only for an image cited by itself. */
  width: number | null;
  height: number | null;
  /** When its bytes expired. */
  expiredAt: string | null;
  gone: boolean;
  /** When it expires, while nothing holds it. Null while evidence does, and on a file that never expires. */
  expiresAt?: string | null;
  /** When it was pinned, which keeps it past `expiresAt`. */
  pinnedAt?: string | null;
  /** Whether it can be pinned: what `file_upload` kept, while its bytes remain. A server older than this field offers no pin. */
  pinnable?: boolean;
}

/** What a press of the pin answers, either way: the three dates it may have moved. */
export type EvidenceFilePinAnswer = Pick<EvidenceFile, 'expiresAt' | 'expiredAt' | 'pinnedAt'>;

/** A read of a file whose bytes have gone (410), and when they expired. A server older than the date says only that they went. */
export class ExpiredAttachmentError extends Error {
  constructor(public readonly expiredAt: string | null) {
    super('attachment expired');
    this.name = 'ExpiredAttachmentError';
  }
}

/** A page of a version's files. The count and the size are the whole list's, whichever page it is. */
export interface EvidenceFilePage {
  revision: string;
  submittedAt: string;
  fileCount: number;
  totalBytes: number;
  files: EvidenceFile[];
  /** The offset of the next page, or null when this is the last. */
  nextOffset: number | null;
}

/** The pages read so far of a version's files, as one. */
export type EvidenceFileList = Omit<EvidenceFilePage, 'revision'>;

/** A citation as an evidence card reads one: only a FILE citation of a report carries the last field. */
export interface EvidenceFileCitation {
  kind: string;
  testReport?: EvidenceTestReport;
}

/** Whether this version cites a file. With none, the card is what it has always been. A FILE citation is
 *  refused unless it resolves, so one that has stopped resolving is a file that went, and still gets its tile. */
export function citesFiles(citations: readonly EvidenceFileCitation[]): boolean {
  return citations.some((citation) => citation.kind === 'FILE');
}

/** The summaries of the reports this version cites, read off the citations: they outlive the files. */
export function evidenceTestReports(citations: readonly EvidenceFileCitation[]): EvidenceTestReport[] {
  return citations.flatMap((citation) => (citation.testReport ? [citation.testReport] : []));
}

/** What a file is called where one name is needed. */
export function evidenceFileName(file: Pick<EvidenceFile, 'name' | 'id'>): string {
  return file.name ?? file.id;
}

/** What a saved file is called: the path's last part. */
export function evidenceFileSaveName(file: Pick<EvidenceFile, 'name' | 'id'>): string {
  return evidenceFileName(file).split('/').at(-1) as string;
}

/** Whether a file has lost its bytes: it expired, or its row went with them. */
export function evidenceFileIsGone(file: Pick<EvidenceFile, 'gone' | 'expiredAt'>): boolean {
  return file.gone || file.expiredAt !== null;
}

/** Whether this file is drawn as a picture. Only a raster image is, and only while it has its bytes. */
export function isEvidencePicture(file: Pick<EvidenceFile, 'gone' | 'expiredAt' | 'mimeType'>): boolean {
  return !evidenceFileIsGone(file) && file.mimeType !== null && isRasterImage(file.mimeType);
}

/** The label on a tile with no picture: `HTML`, `JSON`, `FILE`. */
export function evidenceFileKind(file: Pick<EvidenceFile, 'name' | 'id'>): string {
  const name = file.name === null ? '' : evidenceFileSaveName(file);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
}

/** The thumbnails the card draws: pictures first, so a report does not take a picture's place. */
export function evidenceFilesOnCard(list: Pick<EvidenceFileList, 'files' | 'fileCount'>): { shown: EvidenceFile[]; rest: number } {
  const shown = [
    ...list.files.filter(isEvidencePicture),
    ...list.files.filter((file) => !isEvidencePicture(file)),
  ].slice(0, EVIDENCE_FILES_SHOWN);
  return { shown, rest: list.fileCount - shown.length };
}

/** The files, by the folder they were uploaded in and in the order those first appear. */
export function evidenceFileGroups(files: readonly EvidenceFile[]): { name: string; files: EvidenceFile[] }[] {
  const groups = new Map<string, EvidenceFile[]>();
  for (const file of files) {
    const path = evidenceFileName(file);
    const slash = path.lastIndexOf('/');
    const name = slash > 0 ? path.slice(0, slash) : file.folder ?? EVIDENCE_FILES_NO_FOLDER;
    const group = groups.get(name);
    if (group) group.push(file);
    else groups.set(name, [file]);
  }
  return [...groups].map(([name, grouped]) => ({ name, files: grouped }));
}

/** `Dec 2`, with the year when it is not this one. In English whatever the browser reads, as all copy is. */
export function evidenceExpiryDate(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  const year = date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const };
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year });
}

/** Whether the server offers this file a pin. */
export function evidenceFileCanPin(file: Pick<EvidenceFile, 'pinnable'>): boolean {
  return file.pinnable === true;
}

/** Whether this file is pinned. */
export function evidenceFileIsPinned(file: Pick<EvidenceFile, 'pinnedAt'>): boolean {
  return file.pinnedAt != null;
}

/** `Expires Dec 2`. */
export const evidenceFileExpires = (at: string, now?: Date): string => `Expires ${evidenceExpiryDate(at, now)}`;

/** How long a file with its bytes stays: `Pinned`, `Expires Dec 2`, or nothing where evidence holds it or it never expires. */
export function evidenceFileKeep(file: Pick<EvidenceFile, 'gone' | 'expiredAt' | 'expiresAt' | 'pinnedAt'>, now?: Date): string | null {
  if (evidenceFileIsGone(file)) return null;
  if (evidenceFileIsPinned(file)) return EVIDENCE_FILE_PINNED;
  return file.expiresAt ? evidenceFileExpires(file.expiresAt, now) : null;
}

/** `Expired Dec 2`, on one line, or `Expired` from a server that does not say when. */
export function evidenceFileExpiredLine(at: string | null, now?: Date): string {
  return at === null ? EVIDENCE_FILE_EXPIRED : `${EVIDENCE_FILE_EXPIRED} ${evidenceExpiryDate(at, now)}`;
}

/** The file after a press of its pin, with what the server answered. */
export function evidenceFileWithPin(file: EvidenceFile, answer: EvidenceFilePinAnswer): EvidenceFile {
  return { ...file, expiresAt: answer.expiresAt, expiredAt: answer.expiredAt, pinnedAt: answer.pinnedAt };
}

/** Whether every file has lost its bytes. Only the last page can say so of the whole list. */
export function evidenceFilesAllGone(list: Pick<EvidenceFileList, 'files' | 'nextOffset'>): boolean {
  return list.nextOffset === null && list.files.length > 0 && list.files.every(evidenceFileIsGone);
}

/** The whole list's size, unless nothing that is left can say: a row that went took its size with it. */
const listSize = (list: Pick<EvidenceFileList, 'totalBytes'>): string[] =>
  list.totalBytes > 0 ? [formatFileSize(list.totalBytes)] : [];

/**
 * `FILES · 9 · 1.8 MB`, and ` · EXPIRED DEC 2` once all of them have, by the last date. One expired file of nine is its
 * own tile's news. A row that went took its date with it, so a list of those says `EXPIRED` alone.
 */
export function evidenceFilesHeadline(list: EvidenceFileList, now?: Date): string {
  const line = [EVIDENCE_FILES_HEADING, list.fileCount, ...listSize(list)].join(' · ');
  if (!evidenceFilesAllGone(list)) return line;
  const last = list.files.reduce<string | null>(
    (latest, { expiredAt }) => (expiredAt !== null && (latest === null || expiredAt > latest) ? expiredAt : latest),
    null,
  );
  return `${line} · ${EVIDENCE_FILES_EXPIRED}${last === null ? '' : ` ${evidenceExpiryDate(last, now).toUpperCase()}`}`;
}

/** `9 files · 1.8 MB`, on the version line of the page. */
export function evidenceFilesCount(list: Pick<EvidenceFileList, 'fileCount' | 'totalBytes'>): string {
  return [`${list.fileCount} ${list.fileCount === 1 ? 'file' : 'files'}`, ...listSize(list)].join(' · ');
}

/** `Showing 1000 of 3000 files`, while the list has more than the page holds. */
export const evidenceFilesShowing = (shown: number, total: number): string => `Showing ${shown} of ${total} files`;

/** `214 KB · 780 × 1688 · sha256 3f9a1c07`, with what is known. The picture's own size when the row has none. */
export function evidenceFileFacts(
  file: Pick<EvidenceFile, 'sizeBytes' | 'sha256'>,
  size: { width: number | null; height: number | null } | null = null,
): string {
  return [
    ...(file.sizeBytes === null ? [] : [formatFileSize(file.sizeBytes)]),
    ...(size?.width && size.height ? [`${size.width} × ${size.height}`] : []),
    ...(file.sha256 === null ? [] : [`sha256 ${file.sha256.slice(0, 8)}`]),
  ].join(' · ');
}

const REPORT_FORMATS: Record<EvidenceTestReport['format'], string> = { playwright: 'Playwright', junit: 'JUnit' };

/** `Playwright`, the report's own name. */
export const evidenceReportFormat = (report: EvidenceTestReport): string => REPORT_FORMATS[report.format];
/** `Playwright report`, heading the page's block. */
export const evidenceReportTitle = (report: EvidenceTestReport): string => `${evidenceReportFormat(report)} report`;
/** `46 passed · 0 failed · 2 skipped`. */
export const evidenceReportCounts = (report: EvidenceTestReport): string =>
  `${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped`;
/** `46 passed · 0 failed · 2 skipped · 38s`, with how long the run took when the report says. */
export const evidenceReportFacts = (report: EvidenceTestReport): string =>
  report.durationMs === null
    ? evidenceReportCounts(report)
    : `${evidenceReportCounts(report)} · ${checkDuration(report.durationMs)}`;
/** `Failed · 2`, heading a list whose names may stop short of its count. */
export const evidenceReportList = (word: string, count: number): string => `${word} · ${count}`;
