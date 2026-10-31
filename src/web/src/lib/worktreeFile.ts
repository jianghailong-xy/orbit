import { ApiError } from '../api';

/** A file the diff drawer can draw: the formats every browser decodes. The extension is all there is
 *  before the bytes are read, and it decides whether they are read at all — anything else (an
 *  archive, a font, a PDF, HEIC that only Safari draws) is offered as a download instead. */
export function isDrawableImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path);
}

/** Why a worktree file can't be shown, and whether reading it again can help. */
export interface WorktreeFileFailure {
  title: string;
  detail: string;
  canRetry: boolean;
}

// The native clients' words (OrbitKit WorktreeFileFailure, Android's twin), so one file reads the same
// on every client.
export const FILE_DELETED: WorktreeFileFailure = {
  title: 'File deleted',
  detail: 'This file is no longer in the current worktree.',
  canRetry: false,
};

export const IMAGE_UNREADABLE: WorktreeFileFailure = {
  title: "Couldn't preview image",
  detail: 'The image may be incomplete or damaged. Try reading the file again.',
  canRetry: true,
};

/** A failed read of GET /sessions/:id/worktree-file, by the status the server answered. */
export function worktreeFileFailure(error: unknown): WorktreeFileFailure {
  switch (error instanceof ApiError ? error.status : 0) {
    case 404:
      return {
        title: 'File not found',
        detail: 'The file may have moved or been removed from the current worktree.',
        canRetry: true,
      };
    case 413:
      return {
        title: 'File too large',
        detail: 'This file exceeds the download limit. Open it on the runner instead.',
        canRetry: false,
      };
    case 503:
      return {
        title: 'Runner unavailable',
        detail: 'The runner is offline or cannot read this file right now. Try again when it is connected.',
        canRetry: true,
      };
    case 504:
      return {
        title: 'File request timed out',
        detail: 'The runner did not return this file in time. Try again.',
        canRetry: true,
      };
    case 400:
    case 403:
      return { title: 'File unavailable', detail: (error as ApiError).message, canRetry: false };
    default:
      return {
        title: "Couldn't load file",
        detail: error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.',
        canRetry: true,
      };
  }
}

/** "412 KB", "3.4 MB": a file's size as the preview's head states it. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
