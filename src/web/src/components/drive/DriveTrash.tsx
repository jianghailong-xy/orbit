import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DeleteOutlined, EllipsisOutlined, FileOutlined, FolderFilled, LeftOutlined } from '@ant-design/icons';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Menu } from '../ui/Menu';
import {
  deleteDriveGroup,
  driveEntryQuery,
  driveShareLinksQuery,
  driveTrashQuery,
  emptyDriveTrash,
  formatSize,
  formatWhen,
  groupEndsALink,
  messageOf,
  restoreDriveGroup,
  restoreDriveItem,
  restoreDriveVersion,
  type DriveEntry,
  type DriveTrashGroup,
} from '../../lib/drive';
import { useToast } from '../../lib/toast';
import { DriveWriterName } from './DriveWriterName';

/** Said in the confirmation of a delete for good that ends a link (§9). */
export const ENDS_A_SHARE_LINK = 'This ends a share link.';

/** "Orbit UI migration": the folder a group was deleted from, by its last name; the drive's root is "Drive". */
const folderLabel = (path: string) => path.split('/').filter(Boolean).pop() ?? 'Drive';

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/**
 * Trash (board 02-web frame 6, D6 and D11 owner only): grouped by the folder things were deleted from and when (rule 3),
 * so what one `rm -rf` removed is one group, with Restore all. A replaced file's earlier version is its own group, and
 * restores as the current version or as a copy (choice c). Each group can be deleted for good; when that would end a
 * share link, the question says so.
 */
export function DriveTrash() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, holder] = useConfirm();
  const trash = useQuery(driveTrashQuery());
  const links = useQuery(driveShareLinksQuery());
  // A shared file in Trash has a paused link; which group it went in is its own entry's.
  const paused = (links.data ?? []).filter((link) => link.state === 'PAUSED');
  const pausedEntries = useQueries({ queries: paused.map((link) => driveEntryQuery(link.root.id)) });
  const trashGroupOf = new Map(paused.map((link, i) => [link.root.id, pausedEntries[i]?.data?.trashGroupId ?? null]));
  const groups = trash.data ?? [];
  const total = groups.reduce((sum, g) => sum + g.itemCount, 0);
  const bytes = groups.reduce((sum, g) => sum + g.sizeBytes, 0);
  const refresh = () => client.invalidateQueries({ queryKey: ['drive'] });

  const restore = async (group: DriveTrashGroup) => {
    try {
      const { entryIds } = await restoreDriveGroup(group.id);
      await refresh();
      toast.success(`Restored ${items(entryIds.length || group.itemCount)}`, `To ${folderLabel(group.folderPath)}`);
    } catch (error) {
      toast.error("Couldn't restore", messageOf(error));
    }
  };

  // One item back without the rest (rule 3): a file out of an agent's `rm -rf`.
  const restoreOne = async (group: DriveTrashGroup, item: DriveEntry) => {
    try {
      await restoreDriveItem(group.id, item.id);
      await refresh();
      toast.success(`Restored ${item.name}`, `To ${folderLabel(group.folderPath)}`);
    } catch (error) {
      toast.error(`Couldn't restore ${item.name}`, messageOf(error));
    }
  };

  const restoreVersion = async (group: DriveTrashGroup, as: 'CURRENT' | 'COPY') => {
    try {
      const entry = await restoreDriveVersion(group.version!.id, as);
      await refresh();
      toast.success(as === 'CURRENT' ? 'Restored as the current version' : 'Restored as a copy', entry.name);
    } catch (error) {
      toast.error("Couldn't restore the version", messageOf(error));
    }
  };

  const deleteForGood = (group: DriveTrashGroup) => {
    const endsLink = groupEndsALink(group, links.data ?? [], trashGroupOf);
    void confirm({
      title: 'Delete for good?',
      description: (
        <div className="files-confirm-lines">
          <div>
            {group.version
              ? `This earlier version of ${group.version.entry.name} is deleted for good.`
              : `${items(group.itemCount)} from ${folderLabel(group.folderPath)} are deleted for good.`}{' '}
            This can't be undone.
          </div>
          {endsLink && <div className="files-ends-link">{ENDS_A_SHARE_LINK}</div>}
        </div>
      ),
      confirmText: 'Delete for good',
      cancelText: 'Cancel',
      danger: true,
      onConfirm: async () => {
        await deleteDriveGroup(group.id);
        await refresh();
      },
    });
  };

  const empty = () => {
    const endsLink = groups.some((group) => groupEndsALink(group, links.data ?? [], trashGroupOf));
    void confirm({
      title: 'Empty Trash?',
      description: (
        <div className="files-confirm-lines">
          <div>
            {items(total)} ({formatSize(bytes)}) are deleted for good. This can't be undone.
          </div>
          {endsLink && <div className="files-ends-link">{ENDS_A_SHARE_LINK}</div>}
        </div>
      ),
      confirmText: 'Empty Trash',
      cancelText: 'Cancel',
      danger: true,
      onConfirm: async () => {
        await emptyDriveTrash();
        await refresh();
      },
    });
  };

  const groupMenu = (group: DriveTrashGroup) => (
    <Menu
      items={[{ key: 'delete', label: 'Delete for good…', danger: true, onSelect: () => deleteForGood(group) }]}
      trigger={
        <button type="button" className="files-row-more" aria-label={`More for the group from ${folderLabel(group.folderPath)}`}>
          <EllipsisOutlined />
        </button>
      }
    />
  );

  return (
    <div className="files-page files-trash">
      <header className="files-head">
        <h1>
          Trash{' '}
          <span className="files-trash-count">
            {items(total)} · {formatSize(bytes)}
          </span>
        </h1>
        <div className="files-head-actions">
          <Button icon={<LeftOutlined />} onClick={() => navigate('/drive')}>
            Drive
          </Button>
          <Button danger icon={<DeleteOutlined />} disabled={groups.length === 0} onClick={empty}>
            Empty Trash…
          </Button>
        </div>
      </header>
      {trash.isError && (
        <div className="files-empty" role="alert">
          Couldn't read Trash: {messageOf(trash.error)}
        </div>
      )}
      {trash.data && groups.length === 0 && <div className="files-empty">Trash is empty.</div>}
      <div className="files-trash-groups">
        {groups.map((group) =>
          group.version ? (
            <section key={group.id} className="files-trash-group" aria-label={`Replaced in ${folderLabel(group.folderPath)}`}>
              <header className="files-trash-group-head">
                <span>
                  <strong>From {folderLabel(group.folderPath)}</strong> · replaced {formatWhen(group.createdAt)}
                </span>
                {groupMenu(group)}
              </header>
              <div className="files-trash-item">
                <FileOutlined className="files-file-icon" aria-hidden="true" />
                <span className="files-name">{group.version.entry.name}</span>
                <span className="files-trash-detail">
                  earlier version, written {formatWhen(group.version.createdAt)} by{' '}
                  <DriveWriterName writer={group.version.writer} /> · replaced by <DriveWriterName writer={group.actor} />
                </span>
                <span className="files-trash-size">{formatSize(group.version.sizeBytes)}</span>
                <Button size="small" onClick={() => void restoreVersion(group, 'CURRENT')}>
                  Restore as current
                </Button>
                <Button size="small" onClick={() => void restoreVersion(group, 'COPY')}>
                  Restore as a copy
                </Button>
              </div>
            </section>
          ) : (
            <section key={group.id} className="files-trash-group" aria-label={`Deleted from ${folderLabel(group.folderPath)}`}>
              <header className="files-trash-group-head">
                <span>
                  <strong>From {folderLabel(group.folderPath)}</strong> · deleted {formatWhen(group.createdAt)} by{' '}
                  <DriveWriterName writer={group.actor} /> · {items(group.itemCount)} · {formatSize(group.sizeBytes)}
                </span>
                <span className="files-trash-group-actions">
                  <Button size="small" onClick={() => void restore(group)}>
                    Restore all
                  </Button>
                  {groupMenu(group)}
                </span>
              </header>
              {group.items.map((item) => (
                <div key={item.id} className="files-trash-item" data-entry={item.name}>
                  {item.kind === 'FOLDER' ? (
                    <FolderFilled className="files-folder-icon" aria-hidden="true" />
                  ) : (
                    <FileOutlined className="files-file-icon" aria-hidden="true" />
                  )}
                  <span className="files-name">{item.name}</span>
                  <span className="files-trash-size">{item.kind === 'FILE' ? formatSize(item.sizeBytes) : ''}</span>
                  <Button size="small" aria-label={`Restore ${item.name}`} onClick={() => void restoreOne(group, item)}>
                    Restore
                  </Button>
                </div>
              ))}
            </section>
          ),
        )}
      </div>
      <p className="files-trash-foot">
        Only you see Trash; agents do not. Everything here counts toward Storage until you empty it. A restore whose name is
        taken gets a suffix.
      </p>
      {holder}
    </div>
  );
}
