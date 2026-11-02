import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_FILES_NO_FOLDER,
  citesFiles,
  evidenceExpiryDate,
  evidenceFileFacts,
  evidenceFileGroups,
  evidenceFileKind,
  evidenceFilePosition,
  evidenceFileSaveName,
  evidenceFilesAllGone,
  evidenceFilesCount,
  evidenceFilesHeadline,
  evidenceFilesOnCard,
  evidenceReportCounts,
  evidenceReportFacts,
  evidenceReportTitle,
  evidenceTestReports,
  isEvidencePicture,
  type EvidenceFile,
  type EvidenceFileList,
  type EvidenceTestReport,
} from './evidenceFiles';

const SHA = '3f9a1c07aabbccddeeff00112233445566778899aabbccddeeff001122334455';

function file(over: Partial<EvidenceFile> = {}): EvidenceFile {
  return {
    id: 'f1', name: 'chromium-dark-phone/menu-open.png', folder: 'shots', mimeType: 'image/png', sizeBytes: 214 * 1024,
    sha256: SHA, width: null, height: null, expiredAt: null, gone: false, ...over,
  };
}

function list(files: EvidenceFile[], over: Partial<EvidenceFileList> = {}): EvidenceFileList {
  return { submittedAt: '2026-11-02T06:41:00.000Z', fileCount: files.length, totalBytes: 1_887_437, files, nextOffset: null, ...over };
}

const REPORT: EvidenceTestReport = {
  format: 'playwright', total: 48, passed: 46, failed: 0, skipped: 2, durationMs: 38_000, failedNames: [], skippedNames: ['a', 'b'],
};

describe('what a card draws', () => {
  it('counts a version as citing files only by a FILE citation, resolved or not', () => {
    expect(citesFiles([{ kind: 'TOOL_CALL' }, { kind: 'COMMIT' }, { kind: 'ARTIFACT' }])).toBe(false);
    expect(citesFiles([])).toBe(false);
    expect(citesFiles([{ kind: 'FILE' }])).toBe(true);
  });

  it('reads a report off the citation that carries one', () => {
    expect(evidenceTestReports([{ kind: 'TOOL_CALL' }, { kind: 'FILE' }, { kind: 'FILE', testReport: REPORT }])).toEqual([REPORT]);
  });

  it('heads the area with the whole list, whichever page was read', () => {
    expect(evidenceFilesHeadline(list([file()], { fileCount: 9 }))).toBe('FILES · 9 · 1.8 MB');
    expect(evidenceFilesCount(list([file()], { fileCount: 9 }))).toBe('9 files · 1.8 MB');
    expect(evidenceFilesCount(list([file()], { fileCount: 1, totalBytes: 12 * 1024 }))).toBe('1 file · 12 KB');
  });

  it('draws four, pictures first, and counts the rest of the whole list', () => {
    const report = file({ id: 'report', name: 'report.json', mimeType: 'application/json' });
    const pictures = ['a', 'b', 'c', 'd', 'e'].map((id) => file({ id }));
    const onCard = evidenceFilesOnCard(list([report, ...pictures], { fileCount: 9 }));
    expect(onCard.shown.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
    expect(onCard.rest).toBe(5);
    expect(evidenceFilesOnCard(list([report, file()])).rest).toBe(0);
  });

  it('groups by the folder a path names, then by the upload, and keeps the order they first appear in', () => {
    const groups = evidenceFileGroups([
      file({ id: 'a', name: 'light/a.png' }),
      file({ id: 'b', name: 'dark/b.png' }),
      file({ id: 'c', name: 'light/c.png' }),
      file({ id: 'd', name: 'deep/er/d.png' }),
      file({ id: 'e', name: 'top.png', folder: 'shots' }),
      file({ id: 'f', name: 'report.json', folder: null }),
      file({ id: 'g', name: null, folder: null, gone: true }),
    ]);
    expect(groups.map(({ name, files }) => [name, files.map(({ id }) => id)])).toEqual([
      ['light', ['a', 'c']],
      ['dark', ['b']],
      ['deep/er', ['d']],
      ['shots', ['e']],
      [EVIDENCE_FILES_NO_FOLDER, ['f', 'g']],
    ]);
  });
});

describe('what may be drawn at all', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG; name=a'])('draws %s', (mimeType) => {
    expect(isEvidencePicture(file({ mimeType }))).toBe(true);
  });

  it.each([
    'image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/pdf', 'application/json', 'text/plain', '',
    'application/octet-stream', 'image/png, text/html',
  ])('never draws %s', (mimeType) => {
    expect(isEvidencePicture(file({ mimeType }))).toBe(false);
  });

  it('draws nothing that has lost its bytes', () => {
    expect(isEvidencePicture(file({ expiredAt: '2026-12-02T12:00:00.000Z' }))).toBe(false);
    expect(isEvidencePicture(file({ gone: true, mimeType: null }))).toBe(false);
  });

  it('names a tile with no picture by its kind, and a save by the end of its path', () => {
    expect(evidenceFileKind(file({ name: 'notes/page.html' }))).toBe('HTML');
    expect(evidenceFileKind(file({ name: 'Makefile' }))).toBe('FILE');
    expect(evidenceFileKind(file({ name: '.env' }))).toBe('FILE');
    expect(evidenceFileKind(file({ name: null, id: '34qId8VVBEGx2.9' }))).toBe('FILE');
    expect(evidenceFileSaveName(file({ name: 'a/b/report.json' }))).toBe('report.json');
    expect(evidenceFileSaveName(file({ name: null, id: 'f9' }))).toBe('f9');
  });
});

describe('the viewer’s line', () => {
  it('says what is known of a file, and no more', () => {
    expect(evidenceFilePosition(3, 8)).toBe('3 of 8');
    expect(evidenceFileFacts(file(), { width: 780, height: 1688 })).toBe('214 KB · 780 × 1688 · sha256 3f9a1c07');
    expect(evidenceFileFacts(file())).toBe('214 KB · sha256 3f9a1c07');
    expect(evidenceFileFacts(file({ sizeBytes: null, gone: true }), { width: null, height: null })).toBe('sha256 3f9a1c07');
  });
});

describe('expiry', () => {
  const NOW = new Date('2026-12-20T12:00:00.000Z');
  const expired = (expiredAt: string, over: Partial<EvidenceFile> = {}) => file({ expiredAt, ...over });

  it('dates it in English, with the year only when it is not this one', () => {
    expect(evidenceExpiryDate('2026-12-02T12:00:00.000Z', NOW)).toBe('Dec 2');
    expect(evidenceExpiryDate('2025-12-02T12:00:00.000Z', NOW)).toBe('Dec 2, 2025');
  });

  it('heads the area EXPIRED only once all of them have, by the last date', () => {
    const all = list([expired('2026-12-01T12:00:00.000Z'), expired('2026-12-02T12:00:00.000Z')], { fileCount: 9 });
    expect(evidenceFilesHeadline(all, NOW)).toBe('FILES · 9 · 1.8 MB · EXPIRED DEC 2');
    expect(evidenceFilesHeadline(list([expired('2026-12-01T12:00:00.000Z'), file()]), NOW)).toBe('FILES · 2 · 1.8 MB');
  });

  it('counts a row that went, which took its date with it', () => {
    const went = file({ gone: true, name: null, mimeType: null, sizeBytes: null });
    expect(evidenceFilesHeadline(list([went], { totalBytes: 0 }), NOW)).toBe('FILES · 1 · EXPIRED');
    expect(evidenceFilesCount(list([went], { totalBytes: 0 }))).toBe('1 file');
    expect(evidenceFilesHeadline(list([went, expired('2026-12-02T12:00:00.000Z')]), NOW)).toBe('FILES · 2 · 1.8 MB · EXPIRED DEC 2');
  });

  it('does not say it of a list it has not read to the end', () => {
    const page = list([expired('2026-12-02T12:00:00.000Z')], { fileCount: 3000, nextOffset: 1000 });
    expect(evidenceFilesAllGone(page)).toBe(false);
    expect(evidenceFilesHeadline(page, NOW)).toBe('FILES · 3000 · 1.8 MB');
  });
});

describe('a report', () => {
  it('reads as the design spells it', () => {
    expect(evidenceReportCounts(REPORT)).toBe('46 passed · 0 failed · 2 skipped');
    expect(evidenceReportFacts(REPORT)).toBe('46 passed · 0 failed · 2 skipped · 38s');
    expect(evidenceReportFacts({ ...REPORT, durationMs: null })).toBe('46 passed · 0 failed · 2 skipped');
    expect(evidenceReportTitle(REPORT)).toBe('Playwright report');
    expect(evidenceReportTitle({ ...REPORT, format: 'junit' })).toBe('JUnit report');
  });
});
