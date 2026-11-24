import { useRef, useState } from 'react';
import { CheckOutlined } from '@ant-design/icons';
import { formatSize } from '../../lib/documents';
import {
  cancelUpload,
  clearFinishedUploads,
  pauseUpload,
  resumeUpload,
  type DocumentsUpload,
} from '../../lib/documentsUploads';
import { useToast } from '../../lib/toast';

const percent = (upload: DocumentsUpload) => (upload.size === 0 ? 100 : Math.floor((upload.sentBytes / upload.size) * 100));

function timeLeft(upload: DocumentsUpload): string | null {
  if (!upload.rate) return null;
  const seconds = (upload.size - upload.sentBytes) / upload.rate;
  if (seconds < 60) return 'under a minute left';
  return `about ${Math.round(seconds / 60)} min left`;
}

/** The line under a row's bar: what it is doing, and what pressing its button will do. */
function statusLine(upload: DocumentsUpload): string {
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
function TrayRow({ upload }: { upload: DocumentsUpload }) {
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

/**
 * The upload tray (board 02-web frame 3): every upload in one corner, as it goes. Large files go up in parts, so there is
 * no size limit (D12); a dropped connection or a closed tab pauses rather than fails.
 */
export function DocumentsUploadTray({ uploads }: { uploads: DocumentsUpload[] }) {
  const [hidden, setHidden] = useState(false);
  if (uploads.length === 0) return null;
  const done = uploads.filter((u) => u.status === 'done').length;
  const total = uploads.reduce((sum, u) => sum + u.size, 0);
  const sent = uploads.reduce((sum, u) => sum + (u.status === 'done' ? u.size : u.sentBytes), 0);
  const allDone = done === uploads.length;
  return (
    <section className="files-tray" aria-label="Uploads">
      <header className="files-tray-head">
        <span>
          {allDone
            ? `Uploaded ${done} ${done === 1 ? 'file' : 'files'}`
            : `Uploading ${Math.min(done + 1, uploads.length)} of ${uploads.length} · ${formatSize(sent)} of ${formatSize(total)}`}
        </span>
        <span className="files-tray-head-actions">
          {done > 0 && (
            <button type="button" onClick={clearFinishedUploads}>
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
          {uploads.map((upload) => (
            <TrayRow key={upload.key} upload={upload} />
          ))}
        </ul>
      )}
    </section>
  );
}
