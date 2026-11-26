import { useDriveSaidOff } from '../../lib/driveSwitch';
import '../../pages/DrivePage.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { driveEntryQuery, formatSize } from '../../lib/drive';
import {
  durationText,
  filesText,
  rateText,
  summarizeDriveTransfer,
  timeLeftText,
  transferRate,
  type DriveTransferFile,
  type DriveTransferKind,
} from '../../lib/driveTransfer';
import { driveIdFromHref } from './DriveFileCard';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from '../ui/Tooltip';

/** Rows a long transfer shows before "Show all". */
const ROWS_SHOWN = 8;
/** How long with no new byte before the card says the transfer is not moving. */
const STALL_MS = 20_000;

const WORDS = {
  put: { going: 'Uploading', went: 'Uploaded', title: 'Uploading to Drive', arrow: '↑', couldnt: "Couldn't upload" },
  get: { going: 'Downloading', went: 'Downloaded', title: 'Downloading from Drive', arrow: '↓', couldnt: "Couldn't download" },
} as const;

const baseName = (p: string) => p.split('/').pop() || p;

/** A link to a file the transfer put in Drive: its folder opens with it selected. */
function DriveEntryLink({ link, children }: { link?: string; children: ReactNode }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const driveOff = useDriveSaidOff();
  const id = !driveOff ? driveIdFromHref(link) : null;
  if (!id) return <>{children}</>;
  const open = async () => {
    try {
      const entry = await client.fetchQuery(driveEntryQuery(id));
      navigate(`/drive?${new URLSearchParams({ ...(entry?.parentId ? { folder: entry.parentId } : {}), file: id })}`);
    } catch {
      navigate(`/drive?${new URLSearchParams({ file: id })}`);
    }
  };
  return (
    <button type="button" className="drive-xfer-link" onClick={() => void open()}>
      {children}
    </button>
  );
}

/** Bytes per second and how long since the last new byte, from the counts this card has seen. */
function useTransferPace(bytes: number, moving: boolean) {
  const samples = useRef<{ at: number; bytes: number }[]>([]);
  const changedAt = useRef(Date.now());
  // Re-draws the card each second while it moves, so the speed falls and a stall shows when no count arrives.
  const [, setTick] = useState(0);
  useEffect(() => {
    const at = Date.now();
    const last = samples.current[samples.current.length - 1];
    if (last && last.bytes === bytes) return;
    changedAt.current = at;
    samples.current = [...samples.current.filter((s) => at - s.at <= 10_000), { at, bytes }];
  }, [bytes]);
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [moving]);
  // The count this draw shows, at this moment: a new one is not among the samples until its effect runs, and a
  // quiet second counts as no bytes, so the speed falls when the transfer slows.
  const now = Date.now();
  const last = samples.current[samples.current.length - 1];
  const fresh = !last || last.bytes !== bytes;
  const rate = transferRate([...samples.current.filter((s) => s.at < now), { at: now, bytes }]);
  return { rate, stalledMs: moving && !fresh ? now - changedAt.current : 0 };
}

function Bar({ fraction, tone, label }: { fraction: number; tone?: 'ok' | 'warn' | 'bad' | 'off'; label: string }) {
  const percent = Math.round(fraction * 100);
  return (
    <div
      className={`drive-xfer-bar${tone ? ` is-${tone}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

function FileRow({ file, kind, folder }: { file: DriveTransferFile; kind: DriveTransferKind; folder: string }) {
  const name = baseName(file.path);
  const mark = { done: '✓', failed: '✕', running: WORDS[kind].arrow, waiting: '·', stopped: '–' }[file.status];
  const size =
    file.status === 'done'
      ? file.size !== null && formatSize(file.size)
      : file.status === 'running' && file.size !== null
        ? `${formatSize(file.sent)} of ${formatSize(file.size)}`
        : file.status === 'waiting'
          ? 'Waiting'
          : file.status === 'stopped'
            ? 'Stopped'
            : 'Failed';
  return (
    <Tooltip content={file.path.slice(folder.length - 1)} align="start" delay={TEXT_TOOLTIP_DELAY_MS}>
      <li className={`drive-xfer-row is-${file.status}`}>
        <span className="drive-xfer-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="drive-xfer-name">
          {file.status === 'done' ? <DriveEntryLink link={file.link}>{name}</DriveEntryLink> : name}
        </span>
        <span className="drive-xfer-size">{size}</span>
        {file.status === 'running' && file.size !== null && (
          <Bar fraction={file.sent / file.size} label={`${name} ${WORDS[kind].went.toLowerCase()}`} />
        )}
        {file.status === 'failed' && file.error && <span className="drive-xfer-error">{file.error}</span>}
      </li>
    </Tooltip>
  );
}

/** The rows a long transfer shows: around the file going now, or the failed ones first once it is over. */
function shownRows(files: DriveTransferFile[], all: boolean): DriveTransferFile[] {
  if (all || files.length <= ROWS_SHOWN) return files;
  const running = files.findIndex((f) => f.status === 'running' || f.status === 'waiting');
  if (running < 0) {
    const failed = files.filter((f) => f.status !== 'done');
    return [...failed, ...files.filter((f) => f.status === 'done')].slice(0, ROWS_SHOWN);
  }
  const start = Math.max(0, Math.min(running - 4, files.length - ROWS_SHOWN));
  return files.slice(start, start + ROWS_SHOWN);
}

function FileList({ files, kind, folder }: { files: DriveTransferFile[]; kind: DriveTransferKind; folder: string }) {
  const [all, setAll] = useState(false);
  const rows = shownRows(files, all);
  const hidden = files.length - rows.length;
  let lastDir: string | null = null;
  return (
    <ul className="drive-xfer-list">
      {rows.flatMap((file) => {
        const dir = file.path.slice(folder.length, file.path.length - baseName(file.path).length);
        const head =
          dir !== lastDir && dir ? (
            <li key={`dir-${file.id}`} className="drive-xfer-dir">
              {dir}
            </li>
          ) : null;
        lastDir = dir;
        return [head, <FileRow key={file.id} file={file} kind={kind} folder={folder} />];
      })}
      {hidden > 0 && (
        <li className="drive-xfer-more">
          <button type="button" onClick={() => setAll(true)}>
            Show all {files.length}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * An agent's run of drive_put or drive_get calls as one card (board docs/mocks/agent-drive-transfer): a bar, the
 * speed and the time left while it goes, and a row per file. A finished run stays a card, with its green bar and its
 * totals: the owner read folding it to one line as the card going away.
 */
export function DriveTransferCard({
  kind,
  files,
  live,
}: {
  kind: DriveTransferKind;
  files: DriveTransferFile[];
  live: boolean;
}) {
  const words = WORDS[kind];
  const summary = summarizeDriveTransfer(kind, files);
  const moving = live && !summary.finished;
  const { rate, stalledMs } = useTransferPace(summary.sentBytes, moving);
  const clean = summary.finished && summary.failed === 0 && summary.stopped === 0;
  const [showFiles, setShowFiles] = useState(true);
  const stalled = moving && summary.sentBytes > 0 && stalledMs >= STALL_MS;
  const firstLink = files.find((f) => f.link)?.link;

  if (files.length === 1) return <DriveTransferLine kind={kind} file={files[0]} rate={moving ? rate : null} />;

  const timing = summary.elapsedMs !== null ? ` in ${durationText(summary.elapsedMs)}` : '';
  const average =
    summary.elapsedMs && summary.elapsedMs >= 1000 ? rateText(summary.sentBytes / (summary.elapsedMs / 1000)) : null;

  const icon = summary.finished ? (clean ? '✓' : '!') : words.arrow;
  const title = !summary.finished
    ? words.title
    : clean
      ? `${words.went} ${filesText(summary.done)}`
      : `${words.went} ${summary.done} of ${filesText(summary.total)}`;
  const position = summary.done + summary.failed + 1;
  const counting = summary.finished
    ? [
        `${summary.done} ${kind === 'put' ? 'uploaded' : 'downloaded'}`,
        summary.failed ? `${summary.failed} failed` : null,
        summary.stopped ? `${summary.stopped} stopped` : null,
      ]
        .filter(Boolean)
        .join(', ')
    : summary.waiting > 0
      ? `${words.going} ${position} of ${summary.total}`
      : `${words.going} file ${position}`;
  const bytes = summary.finished
    ? `${formatSize(summary.sentBytes)}${timing}`
    : summary.leftBytes !== null && summary.waiting === 0
      ? `${formatSize(summary.sentBytes)} of ${formatSize(summary.sentBytes + summary.leftBytes)}`
      : `${formatSize(summary.sentBytes)} so far`;
  const pace = summary.finished
    ? average && `average ${average}`
    : stalled
      ? `No progress for ${Math.floor(stalledMs / 1000)} s`
      : rate
        ? [
            rateText(rate),
            summary.waiting === 0 && summary.leftBytes !== null ? timeLeftText(summary.leftBytes, rate) : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : null;
  const tone = summary.finished ? (clean ? 'ok' : summary.failed ? 'bad' : 'off') : stalled ? 'warn' : undefined;

  return (
    <section className={`drive-xfer${summary.failed ? ' has-failed' : ''}`} aria-label={words.title}>
      <header className="drive-xfer-head">
        <span className={`drive-xfer-icon is-${kind}${summary.finished ? (clean ? ' is-ok' : ' is-bad') : ''}`} aria-hidden="true">
          {icon}
        </span>
        <span className="drive-xfer-title">{title}</span>
        <span className="drive-xfer-folder">{summary.folder}</span>
        <span className="drive-xfer-actions">
          {summary.finished && kind === 'put' && firstLink && (
            <DriveEntryLink link={firstLink}>Show in Drive</DriveEntryLink>
          )}
          <button type="button" aria-expanded={showFiles} onClick={() => setShowFiles((v) => !v)}>
            {showFiles ? 'Hide files' : 'Show files'}
          </button>
        </span>
      </header>
      <div className="drive-xfer-sum">
        <Bar fraction={summary.finished && clean ? 1 : summary.fraction} tone={tone} label={words.title} />
        <div className="drive-xfer-stats">
          <span>
            <b>{counting}</b> · {bytes}
          </span>
          {pace && <span className={`drive-xfer-pace${stalled ? ' is-stalled' : ''}`}>{pace}</span>}
        </div>
      </div>
      {showFiles && <FileList files={files} kind={kind} folder={summary.folder} />}
    </section>
  );
}

/** One file is a line, not a card: going, done, or what stopped it. */
function DriveTransferLine({ kind, file, rate }: { kind: DriveTransferKind; file: DriveTransferFile; rate: number | null }) {
  const words = WORDS[kind];
  const name = baseName(file.path);
  if (file.status === 'failed') {
    return (
      <div className="drive-xfer-fold is-failed">
        <span aria-hidden="true">✕</span>
        <span>
          {words.couldnt} {name}: {file.error}
        </span>
      </div>
    );
  }
  if (file.status === 'done') {
    const took = file.startedAt !== undefined && file.endedAt !== undefined ? file.endedAt - file.startedAt : null;
    return (
      <div className="drive-xfer-fold">
        <span className="drive-xfer-tick" aria-hidden="true">
          ✓
        </span>
        <span>
          {words.went} <DriveEntryLink link={file.link}>{name}</DriveEntryLink>
        </span>
        <span className="drive-xfer-muted">
          {file.size !== null && ` · ${formatSize(file.size)}`}
          {took !== null && took >= 0 && ` · ${durationText(took)}`}
        </span>
      </div>
    );
  }
  if (file.status === 'stopped') {
    return (
      <div className="drive-xfer-fold">
        <span className="drive-xfer-muted">
          {words.going} {name} stopped
          {file.size !== null && ` at ${formatSize(file.sent)} of ${formatSize(file.size)}`}
        </span>
      </div>
    );
  }
  return (
    <div className="drive-xfer-fold is-going">
      <span className="drive-xfer-arrow" aria-hidden="true">
        {words.arrow}
      </span>
      <span>
        {words.going} {name}
      </span>
      {file.size !== null && (
        <>
          <span className="drive-xfer-muted">
            · {formatSize(file.sent)} of {formatSize(file.size)}
            {rate ? ` · ${rateText(rate)}` : ''}
          </span>
          <Bar fraction={file.sent / file.size} label={`${name} ${words.went.toLowerCase()}`} />
        </>
      )}
    </div>
  );
}
