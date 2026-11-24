import '../../pages/DrivePage.css';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatSize } from '../../lib/drive';
import { useDriveSync, syncRunning, type DriveSync } from '../../lib/driveSyncs';
import { durationText, rateText, timeLeftText } from '../../lib/driveTransfer';

/** Failed paths the card shows before "Show all". */
const FAILED_SHOWN = 5;

const count = (n: number) => n.toLocaleString();
const files = (n: number) => `${count(n)} ${n === 1 ? 'file' : 'files'}`;

function Bar({ fraction, tone, indeterminate, label }: { fraction: number; tone?: 'ok' | 'off' | 'bad'; indeterminate?: boolean; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      className={`drive-xfer-bar${tone ? ` is-${tone}` : ''}${indeterminate ? ' is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : percent}
    >
      <span style={indeterminate ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

function took(sync: DriveSync): string {
  return sync.endedAt ? ` in ${durationText(Date.parse(sync.endedAt) - Date.parse(sync.startedAt))}` : '';
}

/**
 * An agent's drive_sync (or documents_sync) call as its sync's card (board docs/mocks/drive-sync-card): the same live numbers as the
 * Drive tray, kept current after the agent's turn ends, since the sync runs in the background. A sync that ends
 * cleanly folds to one line; failures, a stop and a failed sync stay open.
 */
export function DriveSyncCard({ syncId }: { syncId: string }) {
  const sync = useDriveSync(syncId);
  const navigate = useNavigate();
  const running = sync ? syncRunning(sync) : false;
  const clean = !!sync && sync.status === 'DONE' && sync.failedCount === 0;
  const [open, setOpen] = useState(!clean);
  const [allFailed, setAllFailed] = useState(false);
  // One that ends cleanly while it is watched folds to its line, as one that ended before the page opened.
  const wasClean = useRef(clean);
  useEffect(() => {
    if (clean && !wasClean.current) setOpen(false);
    wasClean.current = clean;
  }, [clean]);

  if (!sync) {
    return (
      <div className="drive-xfer-fold">
        <span className="drive-xfer-muted">Syncing to Drive…</span>
      </div>
    );
  }
  const openFolder = sync.destEntryId
    ? () => navigate(`/drive?${new URLSearchParams({ folder: sync.destEntryId! })}`)
    : null;
  const folderLink = (
    <button type="button" className="drive-xfer-link" onClick={openFolder ?? undefined} disabled={!openFolder}>
      {sync.destPath}
    </button>
  );

  if (clean && !open) {
    const nothing = sync.filesDone === 0;
    return (
      <div className="drive-xfer-fold drive-sync">
        <span className="drive-xfer-tick" aria-hidden="true">
          ✓
        </span>
        <button type="button" className="drive-xfer-fold-open" aria-expanded={false} onClick={() => setOpen(true)}>
          {nothing ? 'Already up to date:' : `Synced ${files(sync.filesDone)} to`}
        </button>
        {folderLink}
        <span className="drive-xfer-muted">
          {nothing
            ? ` · ${count(sync.filesSame)} files checked${took(sync)}`
            : ` · ${formatSize(sync.bytesSent)}${took(sync)}${sync.filesSame ? ` · ${count(sync.filesSame)} already the same` : ''}`}
          {sync.filesDeleted ? ` · ${count(sync.filesDeleted)} moved to Trash` : ''}
        </span>
      </div>
    );
  }

  const failed = sync.status === 'FAILED';
  const stopped = sync.status === 'STOPPED';
  const title = running
    ? 'Syncing to Drive'
    : failed
      ? 'Sync failed'
      : stopped
        ? 'Sync stopped'
        : sync.failedCount
          ? `Synced ${count(sync.filesDone)} of ${count(sync.filesTotal ?? sync.filesDone + sync.failedCount)} files`
          : `Synced ${files(sync.filesDone)}`;
  const icon = running ? '⟳' : clean ? '✓' : stopped ? '■' : '!';
  const iconTone = running || stopped ? '' : clean ? ' is-ok' : ' is-bad';
  const fraction = sync.bytesTotal ? sync.bytesSent / sync.bytesTotal : 0;
  const shown = allFailed ? sync.failed : sync.failed.slice(0, FAILED_SHOWN);
  const more = sync.failedCount - shown.length;

  return (
    <section className={`drive-xfer drive-sync${sync.failedCount || failed ? ' has-failed' : ''}`} aria-label="Sync to Drive">
      <header className="drive-xfer-head">
        <span className={`drive-xfer-icon${iconTone}`} aria-hidden="true">
          {icon}
        </span>
        <span className="drive-xfer-title">{title}</span>
        <span className="drive-xfer-folder">{sync.destPath}</span>
        {running && <span className="drive-sync-chip">Background</span>}
        <span className="drive-xfer-actions">
          {openFolder && (
            <button type="button" onClick={openFolder}>
              Open folder
            </button>
          )}
          {clean && (
            <button type="button" aria-expanded onClick={() => setOpen(false)}>
              Hide
            </button>
          )}
        </span>
      </header>
      {failed && sync.error ? (
        <div className="drive-sync-error">{sync.error}</div>
      ) : (
        <div className="drive-xfer-sum">
          {sync.status === 'CHECKING' ? (
            <>
              <Bar fraction={0} indeterminate label="Checking files" />
              <div className="drive-xfer-stats">
                <span>
                  <b>Checking files…</b> {count(sync.filesSeen)} so far
                </span>
              </div>
            </>
          ) : (
            <>
              <Bar
                fraction={clean || (!running && !stopped) ? 1 : fraction}
                tone={clean ? 'ok' : stopped ? 'off' : running ? undefined : 'ok'}
                label="Synced"
              />
              <div className="drive-xfer-stats">
                <span>
                  {running || stopped ? (
                    <>
                      <b>
                        {count(sync.filesDone)} of {count(sync.filesTotal ?? 0)} files
                      </b>
                      {stopped ? ' synced' : ''} · {formatSize(sync.bytesSent)} of {formatSize(sync.bytesTotal ?? 0)}
                    </>
                  ) : (
                    <>
                      {sync.failedCount ? <b>{count(sync.failedCount)} failed</b> : <b>{files(sync.filesDone)}</b>} ·{' '}
                      {formatSize(sync.bytesSent)}
                      {took(sync)}
                    </>
                  )}
                </span>
                {running && sync.rate ? (
                  <span className="drive-xfer-pace">
                    {[rateText(sync.rate), sync.bytesTotal ? timeLeftText(sync.bytesTotal - sync.bytesSent, sync.rate) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                ) : (
                  !running &&
                  sync.filesSame > 0 && <span className="drive-xfer-pace">{count(sync.filesSame)} already the same</span>
                )}
              </div>
              {running && sync.currentPath && (
                <div className="drive-sync-current">
                  ↑ <span>{sync.currentPath}</span>
                </div>
              )}
            </>
          )}
          {(running || sync.status === 'CHECKING') && (
            <div className="drive-sync-meta">
              {sync.filesSame > 0 && (
                <span>
                  <b>{count(sync.filesSame)}</b> already the same
                </span>
              )}
              <span>
                from <b>{sync.sourceName}/</b>
              </span>
            </div>
          )}
        </div>
      )}
      {sync.failed.length > 0 && (
        <ul className="drive-xfer-list">
          {shown.map((f) => (
            <li key={f.path} className="drive-xfer-row is-failed" title={f.path}>
              <span className="drive-xfer-mark" aria-hidden="true">
                ✕
              </span>
              <span className="drive-xfer-name">{f.path}</span>
              <span className="drive-xfer-size">{f.error}</span>
            </li>
          ))}
          {more > 0 && (
            <li className="drive-xfer-more">
              {allFailed || shown.length === sync.failed.length ? (
                <span className="drive-xfer-muted">and {count(more)} more</span>
              ) : (
                <button type="button" onClick={() => setAllFailed(true)}>
                  Show all {count(sync.failedCount)}
                </button>
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
