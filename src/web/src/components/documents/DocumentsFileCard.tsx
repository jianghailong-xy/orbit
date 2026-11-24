import '../../pages/DocumentsPage.css';
import { FileOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { documentsEntryQuery, formatSize } from '../../lib/documents';
import { ApiError } from '../../api';

export const DOCUMENTS_LINK_PREFIX = 'orbit-document:';
/** The scheme before the Documents rename, which stored transcripts carry and which still draws the same card. */
const LEGACY_DOCUMENTS_LINK_PREFIX = 'orbit-drive:';

/** The entry id in an `orbit-document:<id>` or `orbit-drive:<id>` link (design §4.5), or null when `href` is not one. */
export function documentsIdFromHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  const prefix = [DOCUMENTS_LINK_PREFIX, LEGACY_DOCUMENTS_LINK_PREFIX].find((p) => trimmed.toLowerCase().startsWith(p));
  if (!prefix) return null;
  return trimmed.slice(prefix.length).trim().split(/\s+/, 1)[0] || null;
}

/** The folder a path sits in, as the board's card writes it: `Files › Orbit UI migration`. */
function folderTrail(path: string | undefined): string {
  const parts = (path ?? '').split('/').filter(Boolean);
  return ['Documents', ...parts.slice(0, -1)].join(' › ');
}

/**
 * A reply's `orbit-document:<id>` (or `orbit-drive:<id>`) link drawn as that drive file (board 02-web frame 8): name, folder and size, read live so a
 * later overwrite shows, and a click opens it on the Files page. A file that went to Trash or is gone says so instead.
 */
export function DocumentsFileCard({ id, label }: { id: string; label?: string }) {
  const entry = useQuery(documentsEntryQuery(id));
  if (entry.isPending) {
    return <span className="drive-file-card loading">{label || 'Loading file…'}</span>;
  }
  const file = entry.data;
  if (!file || file.trashedAt) {
    const gone = file?.trashedAt ? 'In Trash' : 'No longer in Files';
    return (
      <span className="drive-file-card gone" title={entry.error instanceof ApiError ? entry.error.message : undefined}>
        <FileOutlined aria-hidden="true" />
        <span className="drive-file-text">
          <span className="drive-file-name">{file?.name ?? label ?? 'File'}</span>
          <span className="drive-file-sub">{gone}</span>
        </span>
      </span>
    );
  }
  const to = `/documents?${new URLSearchParams({ ...(file.parentId ? { folder: file.parentId } : {}), file: file.id })}`;
  return (
    <Link className="drive-file-card" to={to}>
      <FileOutlined aria-hidden="true" />
      <span className="drive-file-text">
        <span className="drive-file-name">{file.name}</span>
        <span className="drive-file-sub">
          {folderTrail(file.path)} · {formatSize(file.sizeBytes)}
        </span>
      </span>
    </Link>
  );
}
