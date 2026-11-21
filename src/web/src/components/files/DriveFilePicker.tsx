import '../../pages/FilesPage.css';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckOutlined, FileOutlined, FolderFilled, RightOutlined } from '@ant-design/icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { driveFolderQuery, formatSize, messageOf } from '../../lib/drive';

/** Where the drive is mounted for an agent (design §4.5): a file's path in a message is this plus its place in Files. */
export const DRIVE_MOUNT = '/home/orbit/Files';

interface Crumb {
  id: string | null;
  name: string;
}

/**
 * Add from Files (board 02-web frame 8): browse the drive, pick files, and the message gets their paths. Nothing is
 * uploaded again; a Cloud agent reads the path from its mount and any other runner gets it with the drive tools.
 */
export function DriveFilePicker({ onClose, onPick }: { onClose: () => void; onPick: (paths: string[]) => void }) {
  const [trail, setTrail] = useState<Crumb[]>([{ id: null, name: 'Files' }]);
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [search, setSearch] = useState('');
  const here = trail[trail.length - 1]!;
  const listing = useQuery(driveFolderQuery(here.id));
  const folderPath = [DRIVE_MOUNT, ...trail.slice(1).map((c) => c.name)].join('/');
  const needle = search.trim().toLowerCase();
  const entries = (listing.data?.entries ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));

  const toggle = (name: string, id: string) =>
    setPicked((was) => {
      const next = new Map(was);
      if (next.has(id)) next.delete(id);
      else next.set(id, `${folderPath}/${name}`);
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title="Add from Files"
      footer={
        <>
          <span className="files-move-spacer">Puts the file's path in your message; nothing is uploaded again.</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picked.size === 0} onClick={() => onPick([...picked.values()])}>
            {picked.size ? `Add ${picked.size}` : 'Add'}
          </Button>
        </>
      }
    >
      <Input size="small" aria-label="Search Files" placeholder="Search Files" value={search} onChange={(e) => setSearch(e.target.value)} />
      <nav className="drive-picker-crumbs" aria-label="Folder">
        {trail.map((crumb, i) => (
          <button
            key={crumb.id ?? 'root'}
            type="button"
            disabled={i === trail.length - 1}
            onClick={() => {
              setTrail(trail.slice(0, i + 1));
              setSearch('');
            }}
          >
            {crumb.name}
          </button>
        ))}
      </nav>
      <div className="drive-picker-list" role="listbox" aria-label="Files" aria-multiselectable="true">
        {listing.isError && <div role="alert">{messageOf(listing.error)}</div>}
        {listing.isPending && <div>Loading…</div>}
        {listing.data && entries.length === 0 && <div>{needle ? 'Nothing matches.' : 'This folder is empty.'}</div>}
        {entries.map((entry) =>
          entry.kind === 'FOLDER' ? (
            <div
              key={entry.id}
              role="option"
              aria-selected={false}
              className="drive-picker-row"
              onClick={() => {
                setTrail([...trail, { id: entry.id, name: entry.name }]);
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
              onClick={() => toggle(entry.name, entry.id)}
            >
              {picked.has(entry.id) ? <CheckOutlined aria-hidden="true" /> : <FileOutlined aria-hidden="true" />}
              <span className="drive-picker-name">{entry.name}</span>
              <span className="drive-picker-size">{formatSize(entry.sizeBytes)}</span>
            </div>
          ),
        )}
      </div>
    </Dialog>
  );
}
