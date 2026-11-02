import { UnprocessableEntityException } from '@nestjs/common';
import { open } from 'node:fs/promises';
import { findIssuedCredential } from '../common/secret-redaction';
import type { FileUpload } from './file-upload-storage';

/**
 * The refusal's code. `src/runner-go/file_tools.go` says the same word: a file of a folder refused with it is listed, and
 * the rest go on.
 */
export const FILE_HOLDS_SECRET = 'FILE_HOLDS_SECRET';

/** How much of a file one read takes. */
export const SCAN_READ_BYTES = 256 * 1024;

/**
 * What each read keeps of the bytes before it, so that a credential cut by a read is seen whole in the next. The longest
 * shape is a JSON web token's first two parts, which travel in a header, and servers refuse headers well under this.
 */
export const SCAN_OVERLAP_BYTES = 64 * 1024;

/** How far into a file a NUL byte says it is binary: git's test, over git's length. */
const BINARY_TEST_BYTES = 8000;

function lineBreaksIn(bytes: Buffer): number {
  let count = 0;
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count += 1;
  return count;
}

/**
 * What looks like a credential in the file at `filePath`, and the line it is on; null when there is none, or the file is
 * binary. The bytes say which it is, because a client chooses an upload's type, and a `.ts` file can arrive as video.
 *
 * Text goes through the one buffer below, a read at a time, so a 25 MiB file holds no more memory than a small one.
 * Reading it as latin1 gives a character per byte, so a read cannot cut a character, and every shape is ASCII.
 */
export async function findCredentialInFile(filePath: string): Promise<{ kind: string; line: number } | null> {
  const handle = await open(filePath, 'r');
  try {
    const window = Buffer.allocUnsafe(SCAN_OVERLAP_BYTES + SCAN_READ_BYTES);
    let held = 0;
    let lineBreaksBefore = 0;
    for (let first = true; ; first = false) {
      const { bytesRead } = await handle.read(window, held, SCAN_READ_BYTES);
      if (bytesRead === 0) return null;
      held += bytesRead;
      if (first && window.subarray(0, Math.min(held, BINARY_TEST_BYTES)).includes(0)) return null;
      const found = findIssuedCredential(window.toString('latin1', 0, held));
      if (found) return { kind: found.kind, line: lineBreaksBefore + lineBreaksIn(window.subarray(0, found.index)) + 1 };
      const dropped = Math.max(0, held - SCAN_OVERLAP_BYTES);
      lineBreaksBefore += lineBreaksIn(window.subarray(0, dropped));
      window.copy(window, 0, dropped, held);
      held -= dropped;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Refuses an upload that holds a credential (docs/orbit-files-design.md §2.9). The file is refused as it is and never
 * edited, because a kept file is the one its agent saw and its sha256 names. The route's cleanup removes the temporary
 * file, so nothing of it stays. The answer says what the credential looks like and where, and never repeats it.
 */
export async function refuseCredentialIn(upload: Pick<FileUpload, 'path' | 'originalname'>): Promise<void> {
  const found = await findCredentialInFile(upload.path);
  if (!found) return;
  throw new UnprocessableEntityException({
    code: FILE_HOLDS_SECRET,
    message: `${upload.originalname} holds what looks like ${found.kind} on line ${found.line}, so it was not kept. `
      + 'Orbit does not edit a file it keeps: take the credential out of the file and upload it again. Do not commit the file instead.',
  });
}
