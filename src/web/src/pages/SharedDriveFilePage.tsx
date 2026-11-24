import { useEffect, useState } from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { sharedDriveFileUrl, type SharedDriveFile } from '../api';
import { PublicShell } from '../components/PublicShell';
import { LinkButton } from '../components/ui/Button';
import { formatSize, isPdf, PDF_PREVIEW_BYTES } from '../lib/drive';
import { userFileUrl } from '../lib/userFile';
import './SharedDriveFilePage.css';

/**
 * `/s/<token>` for a Drive file link (docs/drive-technical-design.md §9): the file's name and size,
 * Download, and the file itself when the browser can show it as it is — a picture, or a PDF in the browser's own
 * viewer. The bytes are the version the link was pinned to, served without a login.
 */
export function SharedDriveFilePage({ token, data }: { token: string; data: { root: SharedDriveFile } }) {
  const file = data.root;
  const url = sharedDriveFileUrl(token);
  return (
    <PublicShell
      crumbs={[{ label: file.name }]}
      live={false}
      actions={
        <LinkButton href={url} download={file.name} size="small" icon={<DownloadOutlined />}>
          Download
        </LinkButton>
      }
    >
      <div className="share-file">
        <h1 className="share-file-name">{file.name}</h1>
        <div className="share-file-size">{formatSize(file.sizeBytes)}</div>
        <FilePreview url={url} file={file} />
      </div>
    </PublicShell>
  );
}

function FilePreview({ url, file }: { url: string; file: SharedDriveFile }) {
  if (!file.preview) return <div className="share-file-none">No preview for this kind of file. Download it to open.</div>;
  if (!isPdf(file.name)) return <img className="share-file-picture" src={url} alt={file.name} />;
  if (file.sizeBytes > PDF_PREVIEW_BYTES) {
    return <div className="share-file-none">Too large to preview ({formatSize(file.sizeBytes)}). Download it to open.</div>;
  }
  return <PdfPreview url={url} name={file.name} />;
}

/**
 * A PDF in the browser's own viewer. The content route answers with `Content-Security-Policy: sandbox`, which keeps a
 * browser from showing a PDF framed straight from it, so the frame shows the same bytes from a blob: URL
 * (nginx.conf's frame-src admits it), as the Files page does.
 */
function PdfPreview({ url, name }: { url: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    let stale = false;
    void fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.blob();
      })
      .then((blob) => userFileUrl(new Blob([blob], { type: 'application/pdf' })))
      .then((next) => {
        made = next;
        if (stale) URL.revokeObjectURL(next);
        else setSrc(next);
      })
      .catch(() => !stale && setFailed(true));
    return () => {
      stale = true;
      if (made?.startsWith('blob:')) URL.revokeObjectURL(made);
    };
  }, [url]);
  if (failed) return <div className="share-file-none">Couldn't load the preview. Download it to open.</div>;
  if (!src) return <div className="share-file-none">Loading preview…</div>;
  return <iframe className="share-file-pdf" src={src} title={name} />;
}
