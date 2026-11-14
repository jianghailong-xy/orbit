import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileZipOutlined,
  LeftOutlined,
  MoreOutlined,
  PushpinFilled,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { SettingsCard, SettingsHeader, SettingsSection } from '../../components/settings';
import { Button } from '../../components/ui/Button';
import { Menu, type MenuItem } from '../../components/ui/Menu';
import { Segmented } from '../../components/ui/Segmented';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { deleteAttachmentEverywhere, fetchAttachmentObjectUrl, setAttachmentPinned } from '../../api';
import {
  storedFilesQuery,
  type StorageScope,
  type StoredFile,
  type StoredFilesOrder,
} from '../../lib/queries';
import { formatFileSize } from '../../lib/worktreeFile';
import { evidenceExpiryDate, evidenceFileExpires } from '../../lib/evidenceFiles';
import { saveUserFile } from '../../lib/userFile';
import { useToast } from '../../lib/toast';
import { encodeId } from '../../lib/idCodec';
import { weekLabel } from './StoragePage';

function fileIcon(type: string) {
  if (type.startsWith('image/')) return <FileImageOutlined />;
  if (type.startsWith('video/')) return <VideoCameraOutlined />;
  if (type === 'application/pdf') return <FilePdfOutlined />;
  if (type === 'application/zip' || type === 'application/gzip') return <FileZipOutlined />;
  if (type.startsWith('text/') || type === 'application/json') return <FileTextOutlined />;
  return <FileOutlined />;
}

const fileNameOf = (file: StoredFile): string => file.fileName ?? 'Pasted image';

/** How long the file stays, in the words the evidence card uses. */
export function storedFileKeep(file: StoredFile): string {
  if (file.expiredAt) return `Expired ${evidenceExpiryDate(file.expiredAt)}`;
  if (file.pinnedAt) return 'Pinned';
  if (file.heldBy === 'EVIDENCE') return 'Kept by evidence';
  if (file.heldBy === 'CONVERSATION') return 'Kept with its session';
  if (file.expiresAt) return evidenceFileExpires(file.expiresAt);
  return file.source === 'task-input' ? 'Kept with its task' : 'Kept with its session';
}

/** Why Delete is not offered, or null where it is. */
export function storedFileCannotDelete(file: StoredFile): string | null {
  if (file.expiredAt) return 'It has expired already.';
  if (file.heldBy === 'EVIDENCE') return 'Evidence cites it. It can go 30 days after that evidence is sent back or replaced.';
  if (file.heldBy === 'CONVERSATION') return 'It is part of a conversation, and goes when the session is deleted.';
  return null;
}

/** The grey line under a file: where it is, when it came, how long it stays, and whether other places keep it too. */
export function storedFileFacts(file: StoredFile, kind: StorageScope['kind']): string {
  const added = `Added ${new Date(file.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const also = file.alsoIn > 0 ? `Also in ${file.alsoIn} other ${file.alsoIn === 1 ? 'place' : 'places'}` : null;
  return [kind === 'tasks' ? null : file.taskTitle, file.sessionTitle, added, storedFileKeep(file), also]
    .filter(Boolean)
    .join(' · ');
}

/** What the delete's confirmation says it does. */
export function storedFileDeleteDescription(file: StoredFile): string {
  const frees = `frees ${formatFileSize(file.sizeBytes)}`;
  const where = file.alsoIn === 0
    ? `This ${frees}.`
    : `It goes from here and from ${file.alsoIn === 1 ? 'the other place that keeps it' : `the ${file.alsoIn} other places that keep it`}, which ${frees}.`;
  return `${where} Where it was shown, Orbit says it was deleted.`;
}

function FileRow({
  file,
  kind,
  onDelete,
  onPin,
  onDownload,
  onSession,
}: {
  file: StoredFile;
  kind: StorageScope['kind'];
  onDelete: (file: StoredFile) => void;
  onPin: (file: StoredFile) => void;
  onDownload: (file: StoredFile) => void;
  onSession: (sessionId: string) => void;
}) {
  const name = fileNameOf(file);
  const blocked = storedFileCannotDelete(file);
  const sessionId = file.sessionId;
  const items: MenuItem[] = [
    ...(file.expiredAt ? [] : [{ key: 'download', label: 'Download', onSelect: () => onDownload(file) }]),
    ...(file.source === 'upload' && !file.expiredAt && file.heldBy !== 'EVIDENCE'
      ? [{ key: 'pin', label: file.pinnedAt ? 'Unpin' : 'Pin', onSelect: () => onPin(file) }]
      : []),
    ...(sessionId ? [{ key: 'session', label: 'Go to session', onSelect: () => onSession(sessionId) }] : []),
    { type: 'separator', key: 'separator' },
    {
      key: 'delete',
      label: blocked ? <span className="storage-menu-blocked">Delete…<span className="storage-menu-why">{blocked}</span></span> : 'Delete…',
      textValue: 'Delete',
      danger: blocked === null,
      disabled: blocked !== null,
      onSelect: () => onDelete(file),
    },
  ];
  return (
    <div className="settings-row storage-file-row" data-file-id={file.id}>
      <span className="storage-file-icon">{fileIcon(file.mimeType)}</span>
      <div className="settings-row-text">
        <div className="settings-row-title storage-file-name">
          <span className="storage-file-name-text" title={name}>{name}</span>
          {file.pinnedAt && <PushpinFilled className="storage-file-pin" aria-label="Pinned" />}
        </div>
        {file.label && <div className="settings-row-description storage-file-label">{file.label}</div>}
        <div className="storage-file-facts">{storedFileFacts(file, kind)}</div>
      </div>
      <div className="settings-row-control storage-file-control">
        <span className="settings-storage-size">{formatFileSize(file.sizeBytes)}</span>
        <Menu
          align="end"
          items={items}
          trigger={<Button size="small" variant="text" icon={<MoreOutlined />} aria-label={`More for ${name}`} />}
        />
      </div>
    </div>
  );
}

/** Settings → Storage → one project, task or week: the files its row counts, each once, largest first. */
export function StorageFilesPage() {
  const params = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const kind: StorageScope['kind'] = params.kind === 'tasks' || params.kind === 'weeks' ? params.kind : 'projects';
  const scope: StorageScope = { kind, id: params.id ?? '' };
  const [order, setOrder] = useState<StoredFilesOrder>('size');
  const { data, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery(storedFilesQuery(scope, order));
  const [confirm, holder] = useConfirm();
  const first = data?.pages[0];
  const files = data?.pages.flatMap((page) => page.files) ?? [];
  // Everything Storage shows of these files: the list in either order, the rankings and the totals.
  const refresh = () => qc.invalidateQueries({ queryKey: ['attachments', 'usage'] });
  const remove = (file: StoredFile) => {
    void confirm({
      title: `Delete ${fileNameOf(file)}?`,
      description: storedFileDeleteDescription(file),
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        await deleteAttachmentEverywhere(file.id);
        await refresh();
      },
    });
  };
  const pin = (file: StoredFile) => {
    setAttachmentPinned(file.id, !file.pinnedAt)
      .then(refresh)
      .catch((error: Error) => toast.error(file.pinnedAt ? "Couldn't unpin the file" : "Couldn't pin the file", error.message));
  };
  const download = (file: StoredFile) => {
    fetchAttachmentObjectUrl(file.id)
      .then((url) => saveUserFile(url, fileNameOf(file)))
      .catch((error: Error) => toast.error("Couldn't download the file", error.message));
  };
  const title = first ? (kind === 'weeks' ? `Week of ${weekLabel(first.title)}` : first.title) : isError ? 'Storage' : '…';
  return (
    <div className="settings-page storage-files-page">
      <button type="button" className="settings-back storage-files-back" onClick={() => navigate('/settings/storage')}>
        <LeftOutlined />
        <span>Storage</span>
      </button>
      <SettingsHeader
        title={title}
        description={
          first
            ? `${formatFileSize(first.totalBytes)} · ${first.fileCount.toLocaleString('en-US')} ${first.fileCount === 1 ? 'file' : 'files'}`
            : isError
              ? 'Could not read these files.'
              : undefined
        }
      />
      {first && first.fileCount > 0 && (
        <SettingsSection
          title="Files"
          action={
            <Segmented
              size="small"
              value={order}
              onValueChange={setOrder}
              aria-label="Order"
              options={[
                { value: 'size', label: 'Largest' },
                { value: 'newest', label: 'Newest' },
              ]}
            />
          }
        >
          <SettingsCard>
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                kind={kind}
                onDelete={remove}
                onPin={pin}
                onDownload={download}
                onSession={(id) => navigate(`/sessions/${encodeId(id)}`)}
              />
            ))}
          </SettingsCard>
          {hasNextPage && (
            <div className="storage-files-more">
              <Button size="small" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                Show more
              </Button>
            </div>
          )}
        </SettingsSection>
      )}
      {first && first.fileCount === 0 && <p className="storage-files-empty">Nothing here is kept any more.</p>}
      {holder}
    </div>
  );
}
