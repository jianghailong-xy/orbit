import { useRef } from 'react';
import { cancelUpload, pauseUpload, resumeUpload, type DriveUpload } from '../../lib/driveUploads';
import { useToast } from '../../lib/toast';

/** What a pending row of the list says about its upload, at the list's scale. */
export function pendingStatus(upload: DriveUpload): string {
  const percent = upload.size ? Math.floor((upload.sentBytes / upload.size) * 100) : 0;
  switch (upload.status) {
    case 'queued':
    case 'uploading':
      return `Uploading · ${percent}%`;
    case 'paused':
      return upload.error ? `Connection lost · ${percent}%` : `Paused · ${percent}%`;
    case 'needs-file':
      return `Stopped · ${percent}%`;
    case 'failed':
      return upload.error ?? "Couldn't upload";
    case 'done':
      return 'Uploaded';
  }
}

/**
 * The controls of a pending row: Pause while it goes, Resume when paused, Choose file again when the page was reloaded and
 * the file must be picked once more, Retry when it failed, and Cancel. Uploads are resumable: a dropped connection or a
 * closed tab pauses rather than fails.
 */
export function DrivePendingActions({ upload }: { upload: DriveUpload }) {
  const picker = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { key, status } = upload;
  return (
    <span className="files-pending-actions">
      {(status === 'uploading' || status === 'queued') && (
        <button type="button" onClick={() => pauseUpload(key)}>Pause</button>
      )}
      {status === 'paused' && <button type="button" onClick={() => resumeUpload(key)}>Resume</button>}
      {status === 'needs-file' && (
        <>
          <button type="button" onClick={() => picker.current?.click()}>Choose file again</button>
          <input
            ref={picker}
            type="file"
            hidden
            aria-label={`Pick ${upload.name} again`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const refused = resumeUpload(key, file);
              if (refused) toast.warning("Couldn't resume", refused);
            }}
          />
        </>
      )}
      {status === 'failed' && <button type="button" onClick={() => resumeUpload(key)}>Retry</button>}
      <button type="button" onClick={() => cancelUpload(key)}>Cancel</button>
    </span>
  );
}
