import { useEffect, useState, type ReactNode } from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionChangedFile } from '../api';
import { worktreeFileQuery } from '../lib/queries';
import {
  FILE_DELETED,
  IMAGE_UNREADABLE,
  formatFileSize,
  isDrawableImage,
  worktreeFileFailure,
  type WorktreeFileFailure,
} from '../lib/worktreeFile';
import { Button } from './ui/Button';
import { ImagePreview } from './ui/ImagePreview';

/**
 * A binary file in the diff drawer. Git has no patch for it, so the pane shows the file itself, read
 * from the session's worktree by its runner (GET /sessions/:id/worktree-file), as the native clients'
 * WorktreeFilePreview does: a picture is drawn, fitted to the pane and opening in the full-screen
 * viewer when pressed; anything else is offered as a download. What is read is the file as it is now,
 * not a before/after pair: a modified picture shows its current version.
 *
 * `head` is the pane head's start (file nav and path); the kind, size and Download follow it.
 */
export function WorktreeFilePreview({
  sessionId,
  file,
  head,
}: {
  sessionId: string;
  file: SessionChangedFile;
  head: ReactNode;
}) {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const kind = dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
  const deleted = (file.status || '').toUpperCase().startsWith('D');
  const image = isDrawableImage(file.path);
  const qc = useQueryClient();
  const query = worktreeFileQuery(sessionId, file.path);
  // Only a picture is read on opening: the drawer has something to draw with it. Anything else is
  // read when Download is pressed.
  const q = useQuery({ ...query, enabled: image && !deleted });
  const url = useObjectUrl(q.data);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  // Decode the bytes once more off-screen: it gives the pixel size for the head, and says when bytes
  // that came back are not a picture after all.
  useEffect(() => {
    setSize(null);
    setBroken(false);
    if (!url) return;
    let live = true;
    const probe = new Image();
    probe.onload = () => live && setSize({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => live && setBroken(true);
    probe.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  const [viewer, setViewer] = useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<WorktreeFileFailure | null>(null);
  const download = async (): Promise<void> => {
    if (q.data) return saveBlob(q.data, name);
    setSaving(true);
    setSaveFailure(null);
    try {
      saveBlob(await qc.fetchQuery(query), name);
    } catch (error) {
      setSaveFailure(worktreeFileFailure(error));
    } finally {
      setSaving(false);
    }
  };
  const bytes = q.data?.size;
  return (
    <>
      <div className="wt-diff-pane-head wt-preview-head">
        {head}
        <span className="wt-preview-meta">
          <span className="wt-preview-kind">{kind}</span>
          {size && (
            <span>
              {size.width} × {size.height}
            </span>
          )}
          {size && bytes != null && <span aria-hidden="true">·</span>}
          {bytes != null && <span>{formatFileSize(bytes)}</span>}
        </span>
        {image && !deleted && !(q.error && !q.data) && (
          <Button size="small" icon={<DownloadOutlined />} disabled={!q.data} onClick={() => void download()}>
            Download
          </Button>
        )}
      </div>
      {deleted ? (
        <FileState failure={FILE_DELETED} />
      ) : !image ? (
        <div className="wt-preview-state">
          <div className="wt-preview-state-title">No preview available</div>
          <div className="wt-preview-state-detail">
            This file can’t be previewed here. Download it to open it in another app.
          </div>
          <Button variant="primary" icon={<DownloadOutlined />} loading={saving} onClick={() => void download()}>
            Download
          </Button>
          {saveFailure && (
            <div className="wt-preview-state-error">
              {saveFailure.title}. {saveFailure.detail}
            </div>
          )}
        </div>
      ) : url && !broken ? (
        <div className="wt-preview-body">
          <button
            type="button"
            className="wt-preview-img"
            aria-label={`Open ${name}`}
            title="Open in viewer"
            onClick={(e) => {
              // The viewer grows from where the picture was pressed: a tall board's middle is often
              // off screen. Enter or Space has no pointer, so it grows from the middle.
              const r = e.currentTarget.getBoundingClientRect();
              setViewer(e.detail > 0 ? { x: e.clientX, y: e.clientY } : { x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }}
          >
            <img src={url} alt={name} />
          </button>
          <ImagePreview
            open={viewer != null}
            onClose={() => setViewer(null)}
            items={[{ src: url, alt: name }]}
            origin={viewer}
          />
        </div>
      ) : broken ? (
        <FileState failure={IMAGE_UNREADABLE} onRetry={() => void q.refetch()} />
      ) : q.error ? (
        <FileState failure={worktreeFileFailure(q.error)} onRetry={() => void q.refetch()} />
      ) : (
        <div className="wt-diff-empty">Loading file…</div>
      )}
    </>
  );
}

function FileState({ failure, onRetry }: { failure: WorktreeFileFailure; onRetry?: () => void }) {
  return (
    <div className="wt-preview-state">
      <div className="wt-preview-state-title">{failure.title}</div>
      <div className="wt-preview-state-detail">{failure.detail}</div>
      {failure.canRetry && onRetry && (
        <Button size="small" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** An object URL for the blob while it is shown, revoked when the blob changes or the pane goes. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

/** Hand the bytes to the browser as a download under the file's own name. */
function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
