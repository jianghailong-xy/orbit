import { BadRequestException } from '@nestjs/common';
import { BG_JOB_TAIL_MAX_BYTES, BG_JOB_TAIL_MAX_LINES } from '@orbit/shared';

/**
 * The bounds of GET /sessions/:id/background/jobs/:jobId/tail, kept here whatever the runner sent: the runner already
 * reads at most this much (src/runner-go/background_owner_tail.go), and the route holds to it all the same.
 */

/** Terminal colour codes, as runner-go's stripANSI and src/web/src/lib/ansi.ts match them: ESC-prefixed CSI only. */
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** `?lines=N`: absent reads as BG_JOB_TAIL_MAX_LINES, more than that is capped to it, anything but a whole N ≥ 1 is a 400. */
export function parseTailLines(raw: string | undefined): number {
  if (raw === undefined || raw === '') return BG_JOB_TAIL_MAX_LINES;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    throw new BadRequestException({ code: 'INVALID_TAIL_LINES', message: 'lines must be a whole number of at least 1.' });
  }
  return Math.min(n, BG_JOB_TAIL_MAX_LINES);
}

/**
 * The runner's text as the route answers it: split into lines (a final newline ends the last line), without colour
 * codes or NUL bytes, the last maxLines of them, and as many of those as fit in maxBytes of UTF-8 (a last line longer
 * than that keeps its end). `cut` says lines or bytes were left out here.
 */
export function boundTailLines(
  text: string,
  maxLines: number,
  maxBytes: number = BG_JOB_TAIL_MAX_BYTES,
): { lines: string[]; cut: boolean } {
  const clean = text.replace(ANSI_CSI, '').replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (clean === '') return { lines: [], cut: false };
  let lines = clean.split('\n');
  let cut = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    cut = true;
  }
  // Each line costs its bytes and a newline between it and the next.
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, -1);
  while (bytes > maxBytes && lines.length > 1) {
    bytes -= Buffer.byteLength(lines[0], 'utf8') + 1;
    lines = lines.slice(1);
    cut = true;
  }
  if (bytes > maxBytes) {
    // One line longer than the cap: keep its end, cut on a character boundary.
    const buf = Buffer.from(lines[0], 'utf8');
    lines = [buf.subarray(buf.length - maxBytes).toString('utf8').replace(/^\uFFFD+/, '')];
    cut = true;
  }
  return { lines, cut };
}
