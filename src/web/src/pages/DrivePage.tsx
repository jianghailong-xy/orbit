import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import {
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EllipsisOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderFilled,
  Html5Outlined,
  LinkOutlined,
  RightOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import Markdown from '../components/Markdown';
import { DriveChatHost } from '../components/drive/DriveChatHost';
import { DriveWriterName } from '../components/drive/DriveWriterName';
import { DriveMoveDialog } from '../components/drive/DriveMoveDialog';
import { DriveShareDialog } from '../components/drive/DriveShareDialog';
import { DriveUploadTray } from '../components/drive/DriveUploadTray';
import { DriveTrash } from '../components/drive/DriveTrash';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Menu, type MenuItem } from '../components/ui/Menu';
import {
  createDriveFolder,
  driveBlob,
  downloadDriveFile,
  driveEntryQuery,
  driveFolderQuery,
  driveSearchQuery,
  useSettled,
  driveShareLinksQuery,
  driveVersionsQuery,
  formatSize,
  formatWhen,
  isHtml,
  isMarkdown,
  isPdf,
  isText,
  messageOf,
  PDF_PREVIEW_BYTES,
  PICTURE_PREVIEW_BYTES,
  pictureType,
  renameDriveEntry,
  restoreDriveGroup,
  restoreDriveVersion,
  TEXT_PREVIEW_BYTES,
  trashDriveEntry,
  type DriveEntry,
  type DriveShareLink,
} from '../lib/drive';
import { useDriveSyncs } from '../lib/driveSyncs';
import { addUploads, useDriveUploads, type UploadRequest } from '../lib/driveUploads';
import { showToast } from '../lib/toastStore';
import { useToast } from '../lib/toast';
import { userFileUrl } from '../lib/userFile';
import './DrivePage.css';

// ── drag and drop ──────────────────────────────────────────────────────────────────────────────

interface DroppedFile {
  file: File;
  relativePath: string | null;
}

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (done: (file: File) => void, failed: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (done: (entries: FsEntry[]) => void, failed: (error: unknown) => void) => void };
};

async function walk(entry: FsEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    out.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : null });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  // readEntries answers in batches until an empty one.
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, path, out);
  }
}

/** What a drop holds: its files, and the files of its folders with their paths in them (D3). */
async function droppedFiles(data: DataTransfer): Promise<DroppedFile[]> {
  const entries = [...(data.items ?? [])]
    .map((item) => (item.kind === 'file' ? (item.webkitGetAsEntry?.() as FsEntry | null) : null))
    .filter((entry): entry is FsEntry => entry != null);
  if (entries.length === 0) return [...(data.files ?? [])].map((file) => ({ file, relativePath: null }));
  const out: DroppedFile[] = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}

let dropSequence = 0;

/** Queue a drop or a pick into `folder`. Each dropped folder is its own drop, so it gets one top folder (choice d). */
function upload(files: DroppedFile[], folder: { id: string; name: string }): void {
  const dropKeys = new Map<string, string>();
  const requests: UploadRequest[] = files.map(({ file, relativePath }) => {
    let dropKey: string | null = null;
    if (relativePath) {
      const top = relativePath.split('/')[0];
      if (!dropKeys.has(top)) dropKeys.set(top, `drop-${Date.now().toString(36)}-${(dropSequence += 1)}`);
      dropKey = dropKeys.get(top)!;
    }
    return { file, parentId: folder.id, parentName: folder.name, relativePath, dropKey };
  });
  addUploads(requests);
}

// ── the tree ───────────────────────────────────────────────────────────────────────────────────

function TreeFolder({
  folder,
  depth,
  current,
  open,
  toggle,
  onOpen,
  onDropFiles,
}: {
  folder: { id: string; name: string; root?: boolean };
  depth: number;
  current: string;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
  onOpen: (id: string | null) => void;
  onDropFiles: (event: DragEvent, folder: { id: string; name: string }) => void;
}) {
  const isOpen = open.has(folder.id);
  const listing = useQuery({ ...driveFolderQuery(folder.root ? null : folder.id), enabled: isOpen });
  const [over, setOver] = useState(false);
  return (
    <>
      <div
        role="treeitem"
        aria-selected={current === folder.id}
        aria-expanded={isOpen}
        tabIndex={0}
        className={`files-tree-row${current === folder.id ? ' active' : ''}${over ? ' drop-over' : ''}`}
        data-row-focus=""
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onOpen(folder.root ? null : folder.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen(folder.root ? null : folder.id);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          setOver(false);
          onDropFiles(event, folder);
        }}
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
          {isOpen ? <DownOutlined /> : <RightOutlined />}
        </button>
        <FolderFilled className="files-folder-icon" aria-hidden="true" />
        <span className="files-tree-name">{folder.name}</span>
      </div>
      {isOpen &&
        listing.data?.entries
          .filter((entry) => entry.kind === 'FOLDER')
          .map((child) => (
            <TreeFolder
              key={child.id}
              folder={child}
              depth={depth + 1}
              current={current}
              open={open}
              toggle={toggle}
              onOpen={onOpen}
              onDropFiles={onDropFiles}
            />
          ))}
    </>
  );
}

// ── the preview pane ───────────────────────────────────────────────────────────────────────────

function EntryIcon({ entry }: { entry: Pick<DriveEntry, 'kind' | 'name'> }) {
  if (entry.kind === 'FOLDER') return <FolderFilled className="files-folder-icon" aria-hidden="true" />;
  if (pictureType(entry.name)) return <FileImageOutlined className="files-file-icon picture" aria-hidden="true" />;
  if (isMarkdown(entry.name)) return <FileMarkdownOutlined className="files-file-icon" aria-hidden="true" />;
  if (isPdf(entry.name)) return <FilePdfOutlined className="files-file-icon" aria-hidden="true" />;
  if (isHtml(entry.name)) return <Html5Outlined className="files-file-icon" aria-hidden="true" />;
  if (isText(entry.name)) return <FileTextOutlined className="files-file-icon" aria-hidden="true" />;
  return <FileOutlined className="files-file-icon" aria-hidden="true" />;
}

/**
 * A URL for a file's whole bytes labelled as `type` (the content route is login-only, so no `<img src>` or frame can
 * point at it): null while it loads, 'failed' when it could not be read.
 */
function useFileUrl(file: DriveEntry, type: string): string | null | 'failed' {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    let stale = false;
    setUrl(null);
    setFailed(false);
    void driveBlob('entries', file.id)
      .then((blob) => userFileUrl(new Blob([blob], { type })))
      .then((next) => {
        made = next;
        if (stale) URL.revokeObjectURL(next);
        else setUrl(next);
      })
      .catch(() => !stale && setFailed(true));
    return () => {
      stale = true;
      if (made?.startsWith('blob:')) URL.revokeObjectURL(made);
    };
  }, [file.id, type, file.currentVersionId, file.seq]);
  return failed ? 'failed' : url;
}

/** A picture drawn from its bytes. */
function PicturePreview({ file }: { file: DriveEntry }) {
  const url = useFileUrl(file, pictureType(file.name)!);
  if (url === 'failed') return <div className="files-preview-none">Couldn't load the preview.</div>;
  if (!url) return <div className="files-preview-loading">Loading preview…</div>;
  return <img className="files-preview-picture" src={url} alt={file.name} />;
}

/** A PDF in the browser's own viewer, in a frame of the pane (nginx.conf's frame-src admits the blob: URL). */
function PdfPreview({ file }: { file: DriveEntry }) {
  const url = useFileUrl(file, 'application/pdf');
  if (url === 'failed') return <div className="files-preview-none">Couldn't load the preview.</div>;
  if (!url) return <div className="files-preview-loading">Loading preview…</div>;
  return <iframe className="files-preview-pdf" src={url} title={file.name} />;
}

/** What a preview cut at `TEXT_PREVIEW_BYTES` says under itself. */
function CutNote({ file }: { file: DriveEntry }) {
  if (file.sizeBytes <= TEXT_PREVIEW_BYTES) return null;
  return (
    <div className="files-preview-note">
      Showing the first {formatSize(TEXT_PREVIEW_BYTES)} of {formatSize(file.sizeBytes)}.
    </div>
  );
}

/** Plain text or code as it is written. */
function TextPreview({ file }: { file: DriveEntry }) {
  const text = useFileText(file);
  if (text.isError) return <div className="files-preview-none">Couldn't load the preview.</div>;
  if (text.data === undefined) return <div className="files-preview-loading">Loading preview…</div>;
  return (
    <>
      <pre className="files-preview-text">{text.data}</pre>
      <CutNote file={file} />
    </>
  );
}

/**
 * A web page drawn in a frame with every sandbox permission off: it runs no script, has no origin (so it reaches
 * neither the login nor this page), submits no form and navigates nowhere.
 */
function HtmlPreview({ file }: { file: DriveEntry }) {
  const text = useFileText(file);
  if (text.isError) return <div className="files-preview-none">Couldn't load the preview.</div>;
  if (text.data === undefined) return <div className="files-preview-loading">Loading preview…</div>;
  return (
    <>
      <iframe className="files-preview-page" sandbox="" srcDoc={text.data} title={file.name} />
      <CutNote file={file} />
    </>
  );
}

/** The start of a text file: `TEXT_PREVIEW_BYTES` read with a Range. */
function useFileText(file: DriveEntry) {
  return useQuery({
    queryKey: ['drive', 'preview-text', file.id, file.currentVersionId, file.seq],
    meta: { entities: ['drive'] },
    queryFn: async () => (await driveBlob('entries', file.id, TEXT_PREVIEW_BYTES)).text(),
  });
}

function MarkdownPreview({ file }: { file: DriveEntry }) {
  const text = useFileText(file);
  if (text.isError) return <div className="files-preview-none">Couldn't load the preview.</div>;
  if (text.data === undefined) return <div className="files-preview-loading">Loading preview…</div>;
  return (
    <div className="files-preview-markdown markdown-body">
      <Markdown remarkPlugins={[remarkGfm]}>{text.data}</Markdown>
    </div>
  );
}

function Preview({ file }: { file: DriveEntry }) {
  if (pictureType(file.name) && file.sizeBytes <= PICTURE_PREVIEW_BYTES) return <PicturePreview file={file} />;
  if (isMarkdown(file.name)) return <MarkdownPreview file={file} />;
  if (isPdf(file.name)) {
    if (file.sizeBytes > PDF_PREVIEW_BYTES) {
      return <div className="files-preview-none">Too large to preview ({formatSize(file.sizeBytes)}). Download it to open.</div>;
    }
    return <PdfPreview file={file} />;
  }
  if (isHtml(file.name)) return <HtmlPreview file={file} />;
  if (isText(file.name)) return <TextPreview file={file} />;
  return null;
}

/** Download a file (or one version) through the browser's own download; a failure is said in a toast. */
async function download(toast: ReturnType<typeof useToast>, fileId: string, name: string, versionId?: string): Promise<void> {
  try {
    await downloadDriveFile(fileId, versionId);
  } catch (error) {
    toast.error(`Couldn't download ${name}`, messageOf(error));
  }
}

/** A file's replaced versions, each restorable as the current one or as a copy (board choice c). */
function EarlierVersions({ file }: { file: DriveEntry }) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const versions = useQuery(driveVersionsQuery(file.id));
  const earlier = (versions.data?.versions ?? []).filter((v) => !v.current);
  const restore = async (versionId: string, as: 'CURRENT' | 'COPY') => {
    try {
      const entry = await restoreDriveVersion(versionId, as);
      await client.invalidateQueries({ queryKey: ['drive'] });
      toast.success(as === 'CURRENT' ? 'Restored as the current version' : 'Restored as a copy', entry.name);
    } catch (error) {
      toast.error("Couldn't restore the version", messageOf(error));
    }
  };
  if (earlier.length === 0) return <dd>None</dd>;
  return (
    <dd>
      <button type="button" className="files-link-button" onClick={() => setOpen((o) => !o)}>
        {earlier.length} in Trash
      </button>
      {open && (
        <ul className="files-versions">
          {earlier.map((version) => (
            <li key={version.id}>
              <div>
                {formatWhen(version.createdAt)} · {formatSize(version.sizeBytes)} · <DriveWriterName writer={version.writer} />
              </div>
              <div className="files-version-actions">
                <Button size="small" onClick={() => void restore(version.id, 'CURRENT')}>
                  Restore as current
                </Button>
                <Button size="small" onClick={() => void restore(version.id, 'COPY')}>
                  Restore as a copy
                </Button>
                <Button
                  size="small"
                  variant="text"
                  icon={<DownloadOutlined />}
                  aria-label={`Download the version of ${formatWhen(version.createdAt)}`}
                  onClick={() => void download(toast, file.id, file.name, version.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </dd>
  );
}

function DetailsPane({
  entry,
  link,
  menu,
  onShare,
  onOpenFolder,
}: {
  entry: DriveEntry;
  link: DriveShareLink | null;
  menu: ReactNode;
  onShare: (moveToCurrent: boolean) => void;
  onOpenFolder: (id: string) => void;
}) {
  const toast = useToast();
  const detail = useQuery(driveEntryQuery(entry.id));
  const isFile = entry.kind === 'FILE';
  return (
    <aside className="files-pane" aria-label={`${entry.name} details`}>
      {isFile && <Preview file={entry} />}
      <h2 className="files-pane-name">{entry.name}</h2>
      <div className="files-pane-kind">{isFile ? formatSize(entry.sizeBytes) : 'Folder'}</div>
      <dl className="files-pane-facts">
        <dt>Last written</dt>
        <dd>{formatWhen(entry.lastWriter.at)}</dd>
        <dt>By</dt>
        <dd>
          <DriveWriterName writer={entry.lastWriter} />
        </dd>
        <dt>Path</dt>
        <dd className="files-pane-path">{detail.data?.path ? `/Drive${detail.data.path}` : '…'}</dd>
        {isFile && (
          <>
            <dt>Earlier versions</dt>
            <EarlierVersions file={entry} />
          </>
        )}
        {link && (
          <>
            <dt>Shared</dt>
            <dd className="files-pane-shared">
              {link.root.pinnedIsCurrent ? (
                'This version'
              ) : (
                <>
                  An earlier version{' '}
                  <button type="button" className="files-link-button" onClick={() => onShare(true)}>
                    Share this version
                  </button>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="files-pane-actions">
        {isFile ? (
          <>
            <Button icon={<DownloadOutlined />} onClick={() => void download(toast, entry.id, entry.name)}>
              Download
            </Button>
            <Button variant="primary" icon={<LinkOutlined />} onClick={() => onShare(false)}>
              Share link…
            </Button>
          </>
        ) : (
          <Button onClick={() => onOpenFolder(entry.id)}>Open</Button>
        )}
        {menu}
      </div>
    </aside>
  );
}

// ── the page ───────────────────────────────────────────────────────────────────────────────────

type Dialog =
  | { kind: 'move'; entry: DriveEntry }
  | { kind: 'share'; entry: DriveEntry; moveToCurrent: boolean }
  | null;

/**
 * Drive (board docs/mocks/drive/02-web): the account's drive in a wide window — the folder tree, the list with
 * who last wrote each file, and the picked file's preview and details. Trash and earlier versions are reached from in
 * here (board choice a). `/drive/trash` is its Trash. The files view hosts the Drive chat (board drive-chat 01);
 * Trash does not.
 */
export function DrivePage({ view = 'files' }: { view?: 'files' | 'trash' }) {
  if (view === 'trash') return <DriveTrash />;
  return <DriveBrowser />;
}

function DriveBrowser() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const folderId = params.get('folder');
  const selectedId = params.get('file');
  const listing = useQuery(driveFolderQuery(folderId));
  const links = useQuery(driveShareLinksQuery());
  const { uploads, completed } = useDriveUploads();
  const syncs = useDriveSyncs();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [search, setSearch] = useState('');
  const [dropOver, setDropOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Where a row menu puts focus when it closes: the name field after Rename, so the menu's own return to its ⋯ does
  // not blur the field away; otherwise (null) the ⋯ it opened from.
  const renameInput = useRef<HTMLInputElement>(null);
  const folder = listing.data?.folder ?? null;
  const rootId = useQuery(driveFolderQuery(null)).data?.folder.id ?? null;
  const here = useQuery(driveEntryQuery(folder && folder.parentId ? folder.id : null));

  // A press anywhere but the name field leaves the name as it was (Escape does too; Enter keeps the new one). Not on blur:
  // the menu Rename was picked from moves focus as it closes.
  const renamingId = renaming?.id ?? null;
  useEffect(() => {
    if (!renamingId) return;
    // Focus the field once the menu has closed and put focus where it puts it.
    const timer = setTimeout(() => renameInput.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [renamingId]);
  useEffect(() => {
    if (!renaming) return;
    const away = (event: MouseEvent) => {
      if (!renameInput.current?.contains(event.target as Node)) setRenaming(null);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [renaming]);

  // The root opens with the drive, and the open folder opens in the tree to show what is in it.
  const folderShown = folder?.id ?? null;
  useEffect(() => {
    const shown = [rootId, folderShown].filter((id): id is string => id != null);
    setOpen((was) => (shown.every((id) => was.has(id)) ? was : new Set([...was, ...shown])));
  }, [rootId, folderShown]);

  // A finished upload is in the folder now.
  const seenCompleted = useRef(completed);
  useEffect(() => {
    if (completed === seenCompleted.current) return;
    seenCompleted.current = completed;
    void client.invalidateQueries({ queryKey: ['drive'] });
  }, [client, completed]);

  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openFolder = (id: string | null) => {
    if (id && folder) setOpen((was) => new Set([...was, folder.id]));
    setParams(id ? { folder: id } : {});
  };
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('file', id);
    else next.delete('file');
    setParams(next, { replace: true });
  };

  const entries = listing.data?.entries ?? [];
  // The search box looks through the whole drive; each result names the folder it is in.
  const searching = search.trim() !== '';
  const settled = useSettled(search.trim());
  const found = useQuery({ ...driveSearchQuery(settled), enabled: settled !== '' });
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const linkOf = (entry: DriveEntry) => links.data?.find((link) => link.root.id === entry.id) ?? null;
  const folderName = folder?.parentId ? folder.name : 'Drive';

  const dropInto = (event: DragEvent, target: { id: string; name: string } | null) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    setDropOver(false);
    const into = target ?? (folder ? { id: folder.id, name: folderName } : null);
    if (!into) return;
    void droppedFiles(event.dataTransfer).then((files) => files.length > 0 && upload(files, into));
  };

  const newFolder = async (parentId: string | null) => {
    try {
      const made = await createDriveFolder(parentId, 'New folder');
      await client.invalidateQueries({ queryKey: ['drive', 'folder'] });
      setRenaming({ id: made.id, name: made.name });
    } catch (error) {
      toast.error("Couldn't make the folder", messageOf(error));
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const entry = entries.find((e) => e.id === renaming.id);
    const name = renaming.name.trim();
    setRenaming(null);
    if (!entry || !name || name === entry.name) return;
    try {
      await renameDriveEntry(entry.id, name);
      await client.invalidateQueries({ queryKey: ['drive'] });
    } catch (error) {
      toast.error(`Couldn't rename ${entry.name}`, messageOf(error));
    }
  };

  // Move to Trash asks nothing; Undo puts it back (board choice b).
  const moveToTrash = async (entry: DriveEntry) => {
    try {
      const { trashGroupId } = await trashDriveEntry(entry.id);
      if (selectedId === entry.id) select(null);
      await client.invalidateQueries({ queryKey: ['drive'] });
      showToast({
        message: 'Moved to Trash',
        subtitle: entry.name,
        tone: 'neutral',
        icon: 'trash',
        key: `drive-trash-${entry.id}`,
        action: {
          label: 'Undo',
          ariaLabel: `Undo moving ${entry.name} to Trash`,
          onClick: () =>
            void restoreDriveGroup(trashGroupId)
              .then(() => client.invalidateQueries({ queryKey: ['drive'] }))
              .catch((error: unknown) => toast.error(`Couldn't restore ${entry.name}`, messageOf(error))),
        },
      });
    } catch (error) {
      toast.error(`Couldn't move ${entry.name} to Trash`, messageOf(error));
    }
  };

  const rowMenu = (entry: DriveEntry): MenuItem[] => [
    entry.kind === 'FOLDER'
      ? { key: 'open', label: 'Open', onSelect: () => openFolder(entry.id) }
      : { key: 'open', label: 'Open', onSelect: () => select(entry.id) },
    ...(entry.kind === 'FILE'
      ? [
          { key: 'download', label: 'Download', onSelect: () => void download(toast, entry.id, entry.name) },
          {
            key: 'share',
            label: 'Share link…',
            onSelect: () => setDialog({ kind: 'share', entry, moveToCurrent: false }),
          },
        ]
      : []),
    { type: 'separator', key: 'sep-1' },
    { key: 'rename', label: 'Rename', onSelect: () => setRenaming({ id: entry.id, name: entry.name }) },
    { key: 'move', label: 'Move to…', onSelect: () => setDialog({ kind: 'move', entry }) },
    { key: 'new-folder', label: 'New folder here', onSelect: () => void newFolder(folder?.id ?? null) },
    { type: 'separator', key: 'sep-2' },
    { key: 'trash', label: 'Move to Trash', danger: true, onSelect: () => void moveToTrash(entry) },
  ];

  const moreButton = (entry: DriveEntry, className = 'files-row-more') => (
    <Menu
      items={rowMenu(entry)}
      returnFocus={renameInput}
      trigger={
        <button type="button" className={className} aria-label={`More for ${entry.name}`}>
          <EllipsisOutlined />
        </button>
      }
    />
  );

  // Rows of uploads into this folder that are still going, greyed under the folder's own (board frame 3).
  const pending = uploads.filter(
    (u) => folder && u.parentId === folder.id && !u.relativePath && u.status !== 'done',
  );

  const crumbs = (here.data?.path ?? '').split('/').filter(Boolean);

  return (
    <DriveChatHost folderId={folder?.parentId ? folder.id : null} folderName={folder ? folderName : null}>
      <div className="files-page">
        <header className="files-head">
          <h1>Drive</h1>
          <div className="files-head-actions">
            <Input
              size="small"
              aria-label="Search Files"
              placeholder="Search all of Files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button icon={<FolderAddOutlined />} onClick={() => void newFolder(folder?.id ?? null)}>
              New folder
            </Button>
            <Button variant="primary" icon={<UploadOutlined />} onClick={() => picker.current?.click()}>
              Upload
            </Button>
            <Button icon={<DeleteOutlined />} onClick={() => navigate('/drive/trash')}>
              Trash
            </Button>
            <Button icon={<DatabaseOutlined />} onClick={() => navigate('/drive/storage')}>
              Storage
            </Button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Files to upload"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                if (folder && files.length > 0) upload(files.map((file) => ({ file, relativePath: null })), { id: folder.id, name: folderName });
              }}
            />
          </div>
        </header>
        <div className="files-body">
          <nav className="files-tree" role="tree" aria-label="Folders">
            {rootId && (
              <TreeFolder
                folder={{ id: rootId, name: 'Drive', root: true }}
                depth={0}
                current={folder?.id ?? ''}
                open={open}
                toggle={toggle}
                onOpen={openFolder}
                onDropFiles={(event, target) => dropInto(event, target)}
              />
            )}
          </nav>
          <section
            className={`files-list-wrap${dropOver ? ' drop-over' : ''}`}
            aria-label={`${folderName} contents`}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              setDropOver(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropOver(false);
            }}
            onDrop={(event) => dropInto(event, null)}
          >
            <div className="files-crumbs">
              <Link to="/drive">Drive</Link>
              {crumbs.map((name, i) => (
                <span key={`${name}-${i}`}>
                  <span className="files-crumb-sep"> › </span>
                  {i === crumbs.length - 2 && folder?.parentId && folder.parentId !== rootId ? (
                    <button type="button" className="files-link-button" onClick={() => openFolder(folder.parentId)}>
                      {name}
                    </button>
                  ) : (
                    <span className={i === crumbs.length - 1 ? 'files-crumb-here' : undefined}>{name}</span>
                  )}
                </span>
              ))}
            </div>
            {searching ? (
              <div className="files-search" role="region" aria-label="Search results">
                {found.isError ? (
                  <div className="files-empty" role="alert">
                    Couldn't search: {messageOf(found.error)}
                  </div>
                ) : settled !== search.trim() || found.isPending ? (
                  <div className="files-empty">Searching…</div>
                ) : found.data.entries.length === 0 ? (
                  <div className="files-empty">Nothing matches “{settled}”.</div>
                ) : (
                  <table className="files-list">
                    <thead>
                      <tr>
                        <th className="files-col-name">Name</th>
                        <th className="files-col-writer">Folder</th>
                        <th className="files-col-size">Size</th>
                        <th className="files-col-when">Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {found.data.entries.map((entry) => (
                        <tr
                          key={entry.id}
                          data-entry={entry.name}
                          className="files-row"
                          onClick={() => {
                            const target = entry.kind === 'FOLDER' ? entry.id : entry.parentId;
                            setSearch('');
                            setParams(target ? (entry.kind === 'FOLDER' ? { folder: target } : { folder: target, file: entry.id }) : {});
                          }}
                        >
                          <td className="files-col-name">
                            <span className="files-name-cell">
                              <EntryIcon entry={entry} />
                              <span className="files-name">{entry.name}</span>
                            </span>
                          </td>
                          <td className="files-col-writer">{entry.folderPath === '/' ? 'Drive' : `Drive${entry.folderPath}`}</td>
                          <td className="files-col-size">{entry.kind === 'FILE' ? formatSize(entry.sizeBytes) : '—'}</td>
                          <td className="files-col-when">{formatWhen(entry.lastWriter.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : listing.isError ? (
              <div className="files-empty" role="alert">
                Couldn't read this folder: {messageOf(listing.error)}
              </div>
            ) : (
              <table className="files-list">
                <thead>
                  <tr>
                    <th className="files-col-name">Name</th>
                    <th className="files-col-writer">Last written by</th>
                    <th className="files-col-size">Size</th>
                    <th className="files-col-when">Modified</th>
                    <th className="files-col-more" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.id}
                      data-entry={entry.name}
                      className={`files-row${entry.id === selectedId ? ' selected' : ''}`}
                      aria-selected={entry.id === selectedId}
                      onClick={() => select(entry.id)}
                      onDoubleClick={() => entry.kind === 'FOLDER' && openFolder(entry.id)}
                    >
                      <td className="files-col-name">
                        <span className="files-name-cell">
                        <EntryIcon entry={entry} />
                        {renaming?.id === entry.id ? (
                          <Input
                            ref={renameInput}
                            autoFocus
                            size="small"
                            aria-label={`New name for ${entry.name}`}
                            value={renaming.name}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setRenaming({ id: entry.id, name: event.target.value })}
                            onFocus={(event) => {
                              const dot = entry.kind === 'FILE' ? entry.name.lastIndexOf('.') : -1;
                              event.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void commitRename();
                              if (event.key === 'Escape') setRenaming(null);
                            }}
                          />
                        ) : (
                          <span className="files-name">{entry.name}</span>
                        )}
                        {linkOf(entry) && <LinkOutlined className="files-shared-mark" aria-label="Shared" />}
                        </span>
                      </td>
                      <td className="files-col-writer">
                        <DriveWriterName writer={entry.lastWriter} />
                      </td>
                      <td className="files-col-size">{entry.kind === 'FILE' ? formatSize(entry.sizeBytes) : '—'}</td>
                      <td className="files-col-when">{formatWhen(entry.lastWriter.at)}</td>
                      <td className="files-col-more" onClick={(event) => event.stopPropagation()}>
                        {moreButton(entry)}
                      </td>
                    </tr>
                  ))}
                  {pending.map((u) => (
                    <tr key={u.key} className="files-row pending" data-entry={u.name}>
                      <td className="files-col-name">
                        <span className="files-name-cell">
                          <EntryIcon entry={{ kind: 'FILE', name: u.name }} />
                          <span className="files-name">{u.name}</span>
                        </span>
                      </td>
                      <td className="files-col-writer">
                        {u.status === 'uploading' || u.status === 'queued'
                          ? `Uploading · ${u.size ? Math.floor((u.sentBytes / u.size) * 100) : 0}%`
                          : u.status === 'failed'
                            ? "Couldn't upload"
                            : `Paused · ${u.size ? Math.floor((u.sentBytes / u.size) * 100) : 0}%`}
                      </td>
                      <td className="files-col-size">{formatSize(u.size)}</td>
                      <td className="files-col-when">—</td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {listing.data && entries.length === 0 && pending.length === 0 && (
              <div className="files-empty">Nothing here yet. Drop files or folders here, or press Upload.</div>
            )}
            {dropOver && (
              <div className="files-drop-hint" aria-hidden="true">
                <strong>Drop to upload to {folderName}</strong>
                <span>Files or folders, any size</span>
              </div>
            )}
            <DriveUploadTray uploads={uploads} syncs={syncs} />
          </section>
          {selected && (
            <DetailsPane
              entry={selected}
              link={linkOf(selected)}
              menu={moreButton(selected, 'files-pane-more')}
              onShare={(moveToCurrent) => setDialog({ kind: 'share', entry: selected, moveToCurrent })}
              onOpenFolder={openFolder}
            />
          )}
        </div>
        {dialog?.kind === 'move' && rootId && (
          <DriveMoveDialog entry={dialog.entry} rootId={rootId} onClose={() => setDialog(null)} />
        )}
        {dialog?.kind === 'share' && (
          <DriveShareDialog
            file={dialog.entry}
            existing={linkOf(dialog.entry)}
            moveToCurrent={dialog.moveToCurrent}
            onClose={() => setDialog(null)}
          />
        )}
      </div>
    </DriveChatHost>
  );
}
