import '../../pages/DrivePage.css';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckOutlined, FileOutlined, FolderFilled, RightOutlined } from '@ant-design/icons';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { driveFolderQuery, driveSearchQuery, formatSize, messageOf, useSettled } from '../../lib/drive';

/** Where the drive is mounted for an agent (design §4.5): a file's path in a message is this plus its place in Files. */
export const DRIVE_MOUNT = '/home/orbit/Drive';

interface Crumb {
  id: string | null;
  name: string;
}

/** The project's folder name under Files (D22): no `/`, at most 60 characters. */
export const projectFolderName = (title: string): string => title.replace(/\//g, '-').trim().slice(0, 60);

export interface PickedDriveFile {
  id: string;
  name: string;
  path: string;
}

/**
 * Add from Files (board 02-web frame 8): the popover over the composer. It opens on the session's project folder when
 * there is one (D22) and on the drive's root otherwise, browses it, and hands back the files picked with their
 * paths. Nothing is uploaded again; a Cloud agent reads the path from its mount.
 */
export function DriveFilePicker({
  projectFolder,
  onClose,
  onPick,
}: {
  projectFolder?: { id: string; title: string } | null;
  onClose: () => void;
  onPick: (files: PickedDriveFile[]) => void;
}) {
  const [moved, setMoved] = useState<Crumb[] | null>(null);
  const [picked, setPicked] = useState<ReadonlyMap<string, PickedDriveFile>>(new Map());
  const [search, setSearch] = useState('');
  const root = useQuery(driveFolderQuery(null));
  // The project's folder is looked for by its name, with the short id suffix a clash adds; none found: the root.
  const wanted = projectFolder ? projectFolderName(projectFolder.title) : null;
  const projectCrumb: Crumb | null =
    wanted && root.data
      ? (root.data.entries.find((e) => e.kind === 'FOLDER' && e.name === wanted) ??
        root.data.entries.find((e) => e.kind === 'FOLDER' && e.name.startsWith(`${wanted}-`) && projectFolder!.id.startsWith(e.name.slice(wanted.length + 1))) ??
        null)
      : null;
  const trail: Crumb[] = moved ?? [{ id: null, name: 'Drive' }, ...(projectCrumb ? [{ id: projectCrumb.id, name: projectCrumb.name }] : [])];
  const here = trail[trail.length - 1]!;
  const listing = useQuery({ ...driveFolderQuery(here.id), enabled: root.isSuccess || root.isError });
  const folderPath = [DRIVE_MOUNT, ...trail.slice(1).map((c) => c.name)].join('/');
  // A search looks through the whole drive; its results carry the folder each file is in.
  const needle = useSettled(search.trim());
  const searching = search.trim() !== '';
  const found = useQuery({ ...driveSearchQuery(needle), enabled: needle !== '' });
  const listed = listing.data?.entries ?? [];
  const entries = searching ? (found.data?.entries ?? []).filter((e) => e.kind === 'FILE') : listed;
  const source = searching ? found : listing;

  const toggle = (name: string, id: string, path: string) =>
    setPicked((was) => {
      const next = new Map(was);
      if (next.has(id)) next.delete(id);
      else next.set(id, { id, name, path });
      return next;
    });

  return (
    <div className="drive-picker" aria-label="Add from Files" role="dialog">
      <div className="drive-picker-head">
        <b>Add from Files</b>
        <Input size="small" aria-label="Search Files" placeholder="Search all of Files" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <nav className="drive-picker-crumbs" aria-label="Folder">
        {trail.map((crumb, i) => (
          <button
            key={crumb.id ?? 'root'}
            type="button"
            disabled={i === trail.length - 1}
            onClick={() => {
              setMoved(trail.slice(0, i + 1));
              setSearch('');
            }}
          >
            {crumb.name}
          </button>
        ))}
      </nav>
      <div className="drive-picker-list" role="listbox" aria-label="Drive" aria-multiselectable="true">
        {source.isError && <div role="alert">{messageOf(source.error)}</div>}
        {(searching ? needle !== search.trim() || found.isPending : listing.isPending) && <div>Loading…</div>}
        {source.data && !(searching && needle !== search.trim()) && entries.length === 0 && (
          <div>{searching ? 'Nothing matches.' : 'This folder is empty.'}</div>
        )}
        {entries.map((entry) =>
          entry.kind === 'FOLDER' ? (
            <div
              key={entry.id}
              role="option"
              aria-selected={false}
              className="drive-picker-row"
              onClick={() => {
                setMoved([...trail, { id: entry.id, name: entry.name }]);
                setSearch('');
              }}
            >
              <FolderFilled aria-hidden="true" />
              <span className="drive-picker-name">{entry.name}</span>
              <RightOutlined aria-hidden="true" />
            </div>
          ) : (
            <div
              key={entry.id}
              role="option"
              aria-selected={picked.has(entry.id)}
              className={`drive-picker-row${picked.has(entry.id) ? ' picked' : ''}`}
              onClick={() => toggle(entry.name, entry.id, searching ? `${DRIVE_MOUNT}${entry.path ?? `/${entry.name}`}` : `${folderPath}/${entry.name}`)}
            >
              {picked.has(entry.id) ? <CheckOutlined aria-hidden="true" /> : <FileOutlined aria-hidden="true" />}
              <span className="drive-picker-name">
                {entry.name}
                {searching && <span className="drive-picker-folder"> · {entry.folderPath === '/' ? 'Drive' : `Drive${entry.folderPath}`}</span>}
              </span>
              <span className="drive-picker-size">{formatSize(entry.sizeBytes)}</span>
            </div>
          ),
        )}
      </div>
      <div className="drive-picker-foot">
        <span>Puts the file's path in your message; nothing is uploaded again.</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={picked.size === 0} onClick={() => onPick([...picked.values()])}>
          {picked.size ? `Add ${picked.size}` : 'Add'}
        </Button>
      </div>
    </div>
  );
}
