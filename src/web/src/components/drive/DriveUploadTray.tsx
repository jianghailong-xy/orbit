import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckOutlined, WarningFilled } from '@ant-design/icons';
import { formatSize } from '../../lib/drive';
import { clearFinishedSyncs, syncRunning, type DriveSync } from '../../lib/driveSyncs';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { AppLink } from '../AppLink';
import {
  cancelUpload,
  clearFinishedUploads,
  pauseUpload,
  resumeUpload,
  type DriveUpload,
} from '../../lib/driveUploads';
import { useToast } from '../../lib/toast';

const percent = (upload: DriveUpload) => (upload.size === 0 ? 100 : Math.floor((upload.sentBytes / upload.size) * 100));

function timeLeft(upload: DriveUpload): string | null {
  if (!upload.rate) return null;
  const seconds = (upload.size - upload.sentBytes) / upload.rate;
  if (seconds < 60) return 'under a minute left';
  return `about ${Math.round(seconds / 60)} min left`;
}

/** The line under a row's bar: what it is doing, and what pressing its button will do. */
function statusLine(upload: DriveUpload): string {
  const sent = `${formatSize(upload.sentBytes)} of ${formatSize(upload.size)}`;
  switch (upload.status) {
    case 'queued':
      return `Waiting · ${formatSize(upload.size)}`;
    case 'uploading':
      return [sent, upload.rate ? `${formatSize(upload.rate)}/s` : null, timeLeft(upload)].filter(Boolean).join(' · ');
    case 'paused':
      return upload.error
        ? `Connection lost. ${sent} is kept; it goes on from there.`
        : `Paused · ${percent(upload)}%`;
    case 'needs-file':
      return 'Stopped when the page closed. Pick the same file again to go on from where it stopped.';
    case 'failed':
      return upload.error ?? "Couldn't upload";
    case 'done':
      return `Uploaded · ${formatSize(upload.size)}`;
  }
}

/** One row of the tray. */
function TrayRow({ upload }: { upload: DriveUpload }) {
  const picker = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const where = upload.relativePath ? upload.relativePath.split('/').slice(0, -1).join('/') : upload.parentName;
  return (
    <li className={`files-tray-row files-tray-${upload.status}`} data-upload={upload.name}>
      <div className="files-tray-name">
        <span className="files-tray-file">{upload.name}</span>
        <span className="files-tray-where"> → {where}</span>
        <span className="files-tray-action">
          {upload.status === 'uploading' || upload.status === 'queued' ? (
            <button type="button" onClick={() => pauseUpload(upload.key)}>
              Pause
            </button>
          ) : upload.status === 'paused' ? (
            <button type="button" onClick={() => resumeUpload(upload.key)}>
              Resume
            </button>
          ) : upload.status === 'needs-file' ? (
            <>
              <button type="button" onClick={() => picker.current?.click()}>
                Resume
              </button>
              <input
                ref={picker}
                type="file"
                hidden
                aria-label={`Pick ${upload.name} again`}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  const refused = resumeUpload(upload.key, file);
                  if (refused) toast.warning("Couldn't resume", refused);
                }}
              />
            </>
          ) : upload.status === 'failed' ? (
            <button type="button" onClick={() => cancelUpload(upload.key)}>
              Remove
            </button>
          ) : (
            <CheckOutlined aria-label="Uploaded" />
          )}
        </span>
      </div>
      {upload.status !== 'done' && upload.status !== 'failed' && (
        <div
          className="files-tray-bar"
          role="progressbar"
          aria-label={`${upload.name} uploaded`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent(upload)}
        >
          <span style={{ width: `${percent(upload)}%` }} />
        </div>
      )}
      <div className="files-tray-status">{statusLine(upload)}</div>
      {(upload.status === 'paused' || upload.status === 'needs-file') && (
        <button type="button" className="files-tray-cancel" onClick={() => cancelUpload(upload.key)}>
          Cancel upload
        </button>
      )}
    </li>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

const syncPercent = (sync: DriveSync) =>
  !sync.bytesTotal ? 0 : Math.min(100, Math.floor((sync.bytesSent / sync.bytesTotal) * 100));

/** The line under a sync row's bar, or the whole outcome once it ended. */
function syncStatusLine(sync: DriveSync, details: ReactNode): ReactNode {
  switch (sync.status) {
    case 'CHECKING':
      return `Checking files… ${sync.filesSeen.toLocaleString()} so far`;
    case 'UPLOADING': {
      const left = sync.rate && sync.bytesTotal ? (sync.bytesTotal - sync.bytesSent) / sync.rate : null;
      return [
        `${sync.filesDone.toLocaleString()} of ${(sync.filesTotal ?? 0).toLocaleString()} files · ${formatSize(sync.bytesSent)} of ${formatSize(sync.bytesTotal ?? 0)}`,
        sync.rate ? `${formatSize(sync.rate)}/s` : null,
        left == null ? null : left < 60 ? 'under a minute left' : `about ${Math.round(left / 60)} min left`,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'DONE': {
      const trashed = sync.filesDeleted > 0 ? ` · ${sync.filesDeleted.toLocaleString()} moved to Trash` : '';
      if (sync.failedCount > 0) {
        return (
          <>
            {`Synced ${plural(sync.filesDone, 'file', 'files')} · ${sync.failedCount.toLocaleString()} failed${trashed} · `}
            {details}
          </>
        );
      }
      if (sync.filesDone === 0) return `Already up to date · ${plural(sync.filesSame, 'file', 'files')}${trashed}`;
      return `Synced ${plural(sync.filesDone, 'file', 'files')} · ${formatSize(sync.bytesSent)}${trashed}`;
    }
    case 'FAILED':
      return (
        <>
          {sync.error ?? "Couldn't sync"}
          {sync.failed.length > 0 && <> · {details}</>}
        </>
      );
    case 'STOPPED':
      return `Stopped · ${sync.filesDone.toLocaleString()} of ${sync.filesTotal == null ? '?' : sync.filesTotal.toLocaleString()} files synced`;
  }
}

/** What an agent's sync could not send: each path with its error, and what to do next. */
function SyncDetailsDialog({ sync, onClose }: { sync: DriveSync; onClose: () => void }) {
  const navigate = useNavigate();
  const name = folderName(sync.destPath);
  const more = sync.failedCount - sync.failed.length;
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      className="files-sync-dialog"
      title={`${sync.sourceName}/ → ${sync.destPath}`}
      footer={
        <>
          {sync.destEntryId && (
            <Button onClick={() => navigate(`/drive?folder=${encodeURIComponent(sync.destEntryId!)}`)}>{`Open ${name}`}</Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className="files-sync-summary">
        {`Synced ${plural(sync.filesDone, 'file', 'files')}`}
        {sync.session && <> from {sync.session.title}</>}
        {` at ${clock(sync.endedAt ?? sync.updatedAt)}. `}
        {sync.failedCount > 0 &&
          `${plural(sync.failedCount, 'file', 'files')} didn't upload. `}
        Ask the agent to run the sync again; it only sends what's still missing.
      </p>
      <ul className="files-sync-failed">
        {sync.failed.map((f) => (
          <li key={f.path}>
            <code>{f.path}</code>
            <span>{f.error}</span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="files-sync-more">{`and ${more.toLocaleString()} more`}</p>}
    </Dialog>
  );
}

/** One agent's directory sync (board drive-sync-tray). It has no Pause or Cancel: the agent owns the run. */
function SyncRow({ sync }: { sync: DriveSync }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const running = syncRunning(sync);
  const failed = sync.status === 'FAILED' || (sync.status === 'DONE' && sync.failedCount > 0);
  const detailsButton = (
    <button
      type="button"
      className="files-tray-link"
      onClick={(event) => {
        event.stopPropagation();
        setDetails(true);
      }}
    >
      Details
    </button>
  );
  return (
    <li
      className={`files-tray-row files-tray-sync files-tray-sync-${sync.status.toLowerCase()}${sync.destEntryId ? ' clickable' : ''}`}
      data-sync={sync.sourceName}
      onClick={() => sync.destEntryId && navigate(`/drive?folder=${encodeURIComponent(sync.destEntryId)}`)}
    >
      <div className="files-tray-name">
        <span className="files-tray-file">
          <b>{sync.sourceName}/</b>
        </span>
        <span className="files-tray-where"> → {sync.destPath.replace(/^\//, '')}</span>
        <span className="files-tray-action">
          {running ? (
            <span className="files-tray-chip">Agent sync</span>
          ) : sync.status === 'STOPPED' ? (
            'Stopped'
          ) : failed ? (
            <WarningFilled aria-label="Synced with failures" className="files-tray-warn" />
          ) : (
            <CheckOutlined aria-label="Synced" />
          )}
        </span>
      </div>
      {running && (
        <div
          className={`files-tray-bar${sync.status === 'CHECKING' ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-label={`${sync.sourceName} synced`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={sync.status === 'CHECKING' ? undefined : syncPercent(sync)}
        >
          <span style={sync.status === 'CHECKING' ? undefined : { width: `${syncPercent(sync)}%` }} />
        </div>
      )}
      {sync.status === 'STOPPED' && (
        <div className="files-tray-bar" aria-hidden="true">
          <span style={{ width: `${syncPercent(sync)}%` }} />
        </div>
      )}
      <div className="files-tray-status">{syncStatusLine(sync, detailsButton)}</div>
      {((running && sync.currentPath) || sync.session) && (
        <div className="files-tray-current">
          {running && sync.currentPath && <span className="files-tray-path">{sync.currentPath}</span>}
          {running && sync.currentPath && sync.session && ' · '}
          {sync.session && (
            <AppLink to={`/sessions/${encodeURIComponent(sync.session.id)}`} onClick={(event) => event.stopPropagation()}>
              {sync.session.title}
            </AppLink>
          )}
        </div>
      )}
      {details && <SyncDetailsDialog sync={sync} onClose={() => setDetails(false)} />}
    </li>
  );
}

/**
 * The upload tray (board 02-web frame 3): every upload in one corner, as it goes. Large files go up in parts, so there is
 * no size limit (D12); a dropped connection or a closed tab pauses rather than fails.
 */
export function DriveUploadTray({ uploads, syncs = [] }: { uploads: DriveUpload[]; syncs?: DriveSync[] }) {
  const [hidden, setHidden] = useState(false);
  if (uploads.length + syncs.length === 0) return null;
  const done = uploads.filter((u) => u.status === 'done').length + syncs.filter((s) => !syncRunning(s)).length;
  const count = uploads.length + syncs.length;
  const total = uploads.reduce((sum, u) => sum + u.size, 0) + syncs.reduce((sum, s) => sum + (s.bytesTotal ?? 0), 0);
  const sent =
    uploads.reduce((sum, u) => sum + (u.status === 'done' ? u.size : u.sentBytes), 0) +
    syncs.reduce((sum, s) => sum + s.bytesSent, 0);
  const allDone = done === count;
  const finished = done > 0;
  const finishedLabel =
    uploads.length === 0
      ? `Synced ${plural(syncs.length, 'folder', 'folders')}`
      : syncs.length === 0
        ? `Uploaded ${done} ${done === 1 ? 'file' : 'files'}`
        : `Finished ${done} of ${count}`;
  return (
    <section className="files-tray" aria-label="Uploads">
      <header className="files-tray-head">
        <span>
          {allDone
            ? finishedLabel
            : `Uploading ${Math.min(done + 1, count)} of ${count}${total > 0 ? ` · ${formatSize(sent)} of ${formatSize(total)}` : ''}`}
        </span>
        <span className="files-tray-head-actions">
          {finished && (
            <button
              type="button"
              onClick={() => {
                clearFinishedUploads();
                clearFinishedSyncs();
              }}
            >
              Clear finished
            </button>
          )}
          <button type="button" onClick={() => setHidden((h) => !h)}>
            {hidden ? 'Show' : 'Hide'}
          </button>
        </span>
      </header>
      {!hidden && (
        <ul className="files-tray-list">
          {syncs.map((sync) => (
            <SyncRow key={sync.id} sync={sync} />
          ))}
          {uploads.map((upload) => (
            <TrayRow key={upload.key} upload={upload} />
          ))}
        </ul>
      )}
    </section>
  );
}
