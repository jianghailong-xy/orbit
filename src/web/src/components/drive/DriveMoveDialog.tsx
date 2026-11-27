import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownOutlined, FolderFilled, FolderAddOutlined, RightOutlined } from '@ant-design/icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { createDriveFolder, driveFolderQuery, messageOf, moveDriveEntry, type DriveEntry } from '../../lib/drive';
import { useToast } from '../../lib/toast';

interface Pick {
  id: string;
  name: string;
}

/** One folder of the picker and, opened, the folders in it. */
function PickerFolder({
  folder,
  depth,
  moving,
  picked,
  onPick,
  open,
  toggle,
}: {
  folder: Pick & { root?: boolean };
  depth: number;
  moving: DriveEntry;
  picked: string | null;
  onPick: (folder: Pick) => void;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  const isOpen = open.has(folder.id);
  const listing = useQuery({ ...driveFolderQuery(folder.root ? null : folder.id), enabled: isOpen });
  const here = moving.parentId === folder.id;
  // A folder cannot go into itself.
  const itself = moving.id === folder.id;
  const disabled = here || itself;
  return (
    <>
      <div
        role="treeitem"
        aria-selected={picked === folder.id}
        aria-disabled={disabled || undefined}
        aria-expanded={isOpen}
        className={`files-picker-row${picked === folder.id ? ' picked' : ''}${disabled ? ' disabled' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => !disabled && onPick(folder)}
      >
        <button
          type="button"
          className="files-tree-toggle"
          aria-label={isOpen ? `Close ${folder.name}` : `Open ${folder.name}`}
          onClick={(event) => {
            event.stopPropagation();
            toggle(folder.id);
          }}
        >
          {itself ? null : isOpen ? <DownOutlined /> : <RightOutlined />}
        </button>
        <FolderFilled className="files-folder-icon" aria-hidden="true" />
        <span>{folder.name}</span>
        {here && <span className="files-picker-note">(here now)</span>}
      </div>
      {isOpen &&
        !itself &&
        listing.data?.entries
          .filter((entry) => entry.kind === 'FOLDER')
          .map((child) => (
            <PickerFolder
              key={child.id}
              folder={child}
              depth={depth + 1}
              moving={moving}
              picked={picked}
              onPick={onPick}
              open={open}
              toggle={toggle}
            />
          ))}
    </>
  );
}

/**
 * Move to… (board 02-web frame 4): a folder picker over the drive's folders, the item's own folder greyed, with
 * New folder, which adds a folder under the picked one and picks it.
 */
export function DriveMoveDialog({ entry, rootId, onClose }: { entry: DriveEntry; rootId: string; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([rootId]));
  const [picked, setPicked] = useState<Pick | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const makeFolder = async () => {
    const under = picked ?? { id: rootId, name: 'Drive' };
    const name = (naming ?? '').trim();
    if (!name) return;
    try {
      const made = await createDriveFolder(under.id, name);
      await client.invalidateQueries({ queryKey: ['drive', 'folder'] });
      setOpen((was) => new Set([...was, under.id]));
      setPicked({ id: made.id, name: made.name });
      setNaming(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const move = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await moveDriveEntry(entry.id, picked.id);
      await client.invalidateQueries({ queryKey: ['drive'] });
      toast.success(`Moved to ${picked.name}`, entry.name);
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={460}
      className="files-move-dialog"
      title={`Move “${entry.name}”`}
      busy={busy}
      footer={
        <>
          {naming === null ? (
            <Button className="files-move-new-folder" icon={<FolderAddOutlined />} onClick={() => setNaming('')}>
              New folder
            </Button>
          ) : (
            <span className="files-move-naming">
              <Input
                autoFocus
                size="small"
                aria-label="New folder name"
                placeholder="Folder name"
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void makeFolder();
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setNaming(null);
                  }
                }}
              />
              <Button size="small" onClick={() => void makeFolder()}>
                Add
              </Button>
            </span>
          )}
          <span className="files-move-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked} loading={busy} onClick={() => void move()}>
            {picked ? `Move to ${picked.name}` : 'Move'}
          </Button>
        </>
      }
    >
      <div className="files-picker" role="tree" aria-label="Folders">
        <PickerFolder
          folder={{ id: rootId, name: 'Drive', root: true }}
          depth={0}
          moving={entry}
          picked={picked?.id ?? null}
          onPick={setPicked}
          open={open}
          toggle={toggle}
        />
      </div>
      {error && (
        <div className="files-dialog-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
