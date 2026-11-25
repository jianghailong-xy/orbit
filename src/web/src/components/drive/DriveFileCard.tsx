import '../../pages/DrivePage.css';
import { FileOutlined, FolderOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { driveEntryQuery, formatSize } from '../../lib/drive';
import { ApiError } from '../../api';

export const DRIVE_LINK_PREFIX = 'orbit-drive:';
/** The scheme while Drive was called Drive, which stored transcripts carry and which still draws the same card. */
const LEGACY_DRIVE_LINK_PREFIX = 'orbit-document:';

/** The entry id in an `orbit-drive:<id>` or `orbit-document:<id>` link (design §4.5), or null when `href` is not one. */
export function driveIdFromHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  const prefix = [DRIVE_LINK_PREFIX, LEGACY_DRIVE_LINK_PREFIX].find((p) => trimmed.toLowerCase().startsWith(p));
  if (!prefix) return null;
  return trimmed.slice(prefix.length).trim().split(/\s+/, 1)[0] || null;
}

/** The folder a path sits in, as the board's card writes it: `Files › Orbit UI migration`. */
function folderTrail(path: string | undefined): string {
  const parts = (path ?? '').split('/').filter(Boolean);
  return ['Drive', ...parts.slice(0, -1)].join(' › ');
}

/**
 * A reply's `orbit-drive:<id>` (or `orbit-document:<id>`) link drawn as that drive file (board 02-web frame 8): name, folder and size, read live so a
 * later overwrite shows, and a click opens it on the Files page. A file that went to Trash or is gone says so instead.
 */
export function DriveFileCard({ id, label }: { id: string; label?: string }) {
  const entry = useQuery(driveEntryQuery(id));
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
  // A folder (what drive_sync's summary links) opens itself and has no size of its own.
  const folder = file.kind === 'FOLDER';
  const to = folder
    ? `/drive?${new URLSearchParams({ folder: file.id })}`
    : `/drive?${new URLSearchParams({ ...(file.parentId ? { folder: file.parentId } : {}), file: file.id })}`;
  return (
    <Link className="drive-file-card" to={to}>
      {folder ? <FolderOutlined aria-hidden="true" /> : <FileOutlined aria-hidden="true" />}
      <span className="drive-file-text">
        <span className="drive-file-name">{file.name}</span>
        <span className="drive-file-sub">
          {folder ? folderTrail(file.path) : `${folderTrail(file.path)} · ${formatSize(file.sizeBytes)}`}
        </span>
      </span>
    </Link>
  );
}
