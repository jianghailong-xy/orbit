import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { formatFileSize, isDrawableImage, worktreeFileFailure } from './worktreeFile';

describe('isDrawableImage', () => {
  it('takes the formats every browser draws, in any letter case', () => {
    for (const path of ['a.png', 'docs/b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif', 'g.bmp', 'favicon.ico']) {
      expect(isDrawableImage(path), path).toBe(true);
    }
  });

  it('leaves everything else to a download, including pictures only some browsers draw', () => {
    for (const path of ['font.woff2', 'dist.zip', 'spec.pdf', 'photo.heic', 'scan.tiff', 'png', 'a.png.zip', 'Makefile']) {
      expect(isDrawableImage(path), path).toBe(false);
    }
  });
});

describe('worktreeFileFailure', () => {
  const failure = (status: number, message = 'from the server') => worktreeFileFailure(new ApiError(message, status));

  it("says what each answer of the worktree-file route means, in the native clients' words", () => {
    expect(failure(404)).toEqual({
      title: 'File not found',
      detail: 'The file may have moved or been removed from the current worktree.',
      canRetry: true,
    });
    expect(failure(413)).toMatchObject({ title: 'File too large', canRetry: false });
    expect(failure(503)).toMatchObject({ title: 'Runner unavailable', canRetry: true });
    expect(failure(504)).toMatchObject({ title: 'File request timed out', canRetry: true });
  });

  it("passes on the server's own words for a refusal, which reading again cannot change", () => {
    expect(failure(403, 'This token cannot read sessions.')).toEqual({
      title: 'File unavailable',
      detail: 'This token cannot read sessions.',
      canRetry: false,
    });
    expect(failure(400)).toMatchObject({ title: 'File unavailable', canRetry: false });
  });

  it('offers to try again after anything else, a dropped connection included', () => {
    expect(failure(502, 'The runner could not read this file. Please try again.')).toEqual({
      title: "Couldn't load file",
      detail: 'The runner could not read this file. Please try again.',
      canRetry: true,
    });
    expect(worktreeFileFailure(new TypeError('Failed to fetch'))).toMatchObject({
      title: "Couldn't load file",
      detail: 'Failed to fetch',
      canRetry: true,
    });
  });
});

describe('formatFileSize', () => {
  it('states bytes, then whole kilobytes, then megabytes to one place', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(88_064)).toBe('86 KB');
    expect(formatFileSize(2_256_476)).toBe('2.2 MB');
  });
});
