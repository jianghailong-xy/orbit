/**
 * An agent's transfers to and from Drive (`drive_put` / `drive_get`, `documents_put` / `documents_get` while Drive was
 * called Drive), as the chat's transfer card draws them
 * (DriveTransferCard, board docs/mocks/agent-drive-transfer).
 *
 * While a call runs, the runner sends its bytes as the call's live `tool_output`, one sentence restating the whole
 * count: "Uploaded 3355443 of 11954323 bytes" (runner-go drive_progress.go, driveProgressLine). The durable
 * tool_result replaces it when the call ends, so a finished card is drawn from results alone.
 */
import { formatSize } from './drive';

export type DriveTransferKind = 'put' | 'get';

const TOOLS: Record<string, DriveTransferKind> = {
  mcp__orbit__drive_put: 'put',
  mcp__orbit__drive_get: 'get',
  // Their names while Drive was called Drive, which stored transcripts carry.
  mcp__orbit__documents_put: 'put',
  mcp__orbit__documents_get: 'get',
};

export function driveTransferKind(toolName: string): DriveTransferKind | null {
  return TOOLS[toolName] ?? null;
}

const PROGRESS_LINE = /^(Uploaded|Downloaded) (\d+) of (\d+) bytes$/;

/** The bytes a progress line counts, or null when the text is not one. Keep in sync with driveProgressLine. */
export function parseDriveProgress(content: unknown): { sent: number; size: number } | null {
  if (typeof content !== 'string') return null;
  const match = PROGRESS_LINE.exec(content);
  if (!match) return null;
  const sent = Number(match[2]);
  const size = Number(match[3]);
  if (!Number.isSafeInteger(sent) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { sent: Math.min(sent, size), size };
}

/** A drive path as the owner reads it: `~/Drive/a`, `/home/orbit/Drive/a` and the mount's `/run/orbit-drive/drive/a`
 * (or `/run/orbit-documents/drive/a` and `/run/orbit-files/drive/a` in an older Pod) are `/a`. */
export function driveDisplayPath(raw: unknown): string {
  let p = typeof raw === 'string' ? raw.trim() : '';
  for (const prefix of ['~/Drive', '/home/orbit/Drive', '/run/orbit-drive/drive', '/run/orbit-documents/drive', '/run/orbit-files/drive']) {
    if (p === prefix || p.startsWith(`${prefix}/`)) p = p.slice(prefix.length);
  }
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+/g, '/');
}

export type DriveFileStatus = 'waiting' | 'running' | 'done' | 'failed' | 'stopped';

export type DriveTransferFile = {
  id: string;
  /** The file's drive path. */
  path: string;
  status: DriveFileStatus;
  /** Bytes moved so far; for a finished file, its size. */
  sent: number;
  /** Null until the call has said how big the file is. */
  size: number | null;
  /** `orbit-drive:<id>` (`orbit-document:<id>` while Drive was called Drive) once an upload is in. */
  link?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

/** What one call's input, result and live line say about its file. */
export function driveTransferFile(input: {
  id: string;
  toolInput: unknown;
  result?: { text: string; isError?: boolean };
  progress: unknown;
  live: boolean;
  ts?: string;
  resultTs?: string;
}): DriveTransferFile {
  const toolInput = (input.toolInput ?? {}) as Record<string, unknown>;
  const file: DriveTransferFile = {
    id: input.id,
    path: driveDisplayPath(toolInput.path),
    status: 'waiting',
    sent: 0,
    size: null,
    startedAt: timeOf(input.ts),
    endedAt: timeOf(input.resultTs),
  };
  if (input.result) {
    const parsed = parseAnswer(input.result.text);
    // A runner that answers with a receipt puts the call's own answer under `entity`, and says a refusal in `error`.
    const refused = parsed.receiptVersion !== undefined && parsed.ok === false;
    if (input.result.isError || refused) {
      const said = (parsed.error as { message?: unknown } | undefined)?.message;
      return { ...file, status: 'failed', error: typeof said === 'string' && said ? said : firstLine(input.result.text) };
    }
    const answer =
      parsed.receiptVersion !== undefined && parsed.entity && typeof parsed.entity === 'object'
        ? (parsed.entity as Record<string, unknown>)
        : parsed;
    const size = typeof answer.sizeBytes === 'number' ? answer.sizeBytes : null;
    return {
      ...file,
      status: 'done',
      sent: size ?? 0,
      size,
      ...(typeof answer.link === 'string' && /^orbit-(?:document|drive):/.test(answer.link) ? { link: answer.link } : {}),
    };
  }
  const progress = parseDriveProgress(input.progress);
  // A call with no result in a session that is no longer running was cut off.
  if (progress) return { ...file, status: input.live ? 'running' : 'stopped', sent: progress.sent, size: progress.size };
  return { ...file, status: input.live ? 'waiting' : 'stopped' };
}

function timeOf(ts?: string): number | undefined {
  if (!ts) return undefined;
  const at = Date.parse(ts);
  return Number.isFinite(at) ? at : undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() || "Couldn't transfer this file";
}

function parseAnswer(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // An answer that is not JSON names no size: the row shows the file without one.
  }
  return {};
}

/** The folder every file sits in, as `/a/b/`; `/` when they share none. */
export function commonFolder(paths: string[]): string {
  if (paths.length === 0) return '/';
  const dirs = paths.map((p) => p.split('/').slice(1, -1));
  const shared: string[] = [];
  for (let i = 0; i < dirs[0].length; i++) {
    const part = dirs[0][i];
    if (dirs.every((d) => d[i] === part)) shared.push(part);
    else break;
  }
  return shared.length ? `/${shared.join('/')}/` : '/';
}

export type DriveTransferSummary = {
  kind: DriveTransferKind;
  folder: string;
  total: number;
  done: number;
  failed: number;
  running: DriveTransferFile | null;
  waiting: number;
  stopped: number;
  /** Bytes moved by every file so far. */
  sentBytes: number;
  /** Bytes still to move, when every file not yet done has said its size; otherwise null. */
  leftBytes: number | null;
  /** 0–1: files done, plus the running file's share. */
  fraction: number;
  finished: boolean;
  /** First start to last end, when every call carries its time. */
  elapsedMs: number | null;
};

export function summarizeDriveTransfer(kind: DriveTransferKind, files: DriveTransferFile[]): DriveTransferSummary {
  const count = (status: DriveFileStatus) => files.filter((f) => f.status === status).length;
  const running = files.find((f) => f.status === 'running') ?? null;
  const done = count('done');
  const open = files.filter((f) => f.status === 'running' || f.status === 'waiting');
  const leftBytes = open.every((f) => f.size !== null)
    ? open.reduce((sum, f) => sum + ((f.size ?? 0) - f.sent), 0)
    : null;
  const runningShare = running && running.size ? running.sent / running.size : 0;
  const starts = files.map((f) => f.startedAt);
  const ends = files.map((f) => f.endedAt);
  const elapsedMs =
    starts.every((t) => t !== undefined) && ends.every((t) => t !== undefined)
      ? Math.max(...(ends as number[])) - Math.min(...(starts as number[]))
      : null;
  return {
    kind,
    folder: commonFolder(files.map((f) => f.path)),
    total: files.length,
    done,
    failed: count('failed'),
    running,
    waiting: count('waiting'),
    stopped: count('stopped'),
    sentBytes: files.reduce((sum, f) => sum + f.sent, 0),
    leftBytes,
    // A failed file is behind the bar, not in it: a run that ends with one shows the share that went.
    fraction: files.length ? Math.min(1, (done + runningShare) / files.length) : 0,
    finished: open.length === 0,
    elapsedMs: elapsedMs !== null && elapsedMs >= 0 ? elapsedMs : null,
  };
}

/** Bytes per second over the last few seconds of samples, or null before there are two to compare. */
export function transferRate(samples: ReadonlyArray<{ at: number; bytes: number }>, windowMs = 3000): number | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const first = samples.find((s) => last.at - s.at <= windowMs) ?? samples[0];
  const span = last.at - first.at;
  if (span < 500) return null;
  return Math.max(0, (last.bytes - first.bytes) / (span / 1000));
}

/** As the Drive page's upload tray says it (DriveUploadTray). */
export function timeLeftText(leftBytes: number, rate: number): string | null {
  if (!rate) return null;
  const seconds = leftBytes / rate;
  if (seconds < 60) return 'under a minute left';
  return `about ${Math.round(seconds / 60)} min left`;
}

export function durationText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

export const rateText = (rate: number) => `${formatSize(rate)}/s`;

export function filesText(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}
