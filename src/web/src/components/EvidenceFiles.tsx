import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined, RightOutlined } from '@ant-design/icons';
import { fetchAttachmentObjectUrl } from '../api';
import {
  EVIDENCE_FILES_HEADING,
  EVIDENCE_FILES_LOADING,
  EVIDENCE_FILES_SHOW_MORE,
  EVIDENCE_FILES_TITLE,
  EVIDENCE_FILES_UNREAD,
  EVIDENCE_FILE_DOWNLOAD,
  EVIDENCE_FILE_DOWNLOAD_FAILED,
  EVIDENCE_FILE_EXPIRED,
  EVIDENCE_REPORT_FAILED,
  EVIDENCE_REPORT_NAMES_SHOWN,
  EVIDENCE_REPORT_SKIPPED,
  evidenceExpiryDate,
  evidenceFileDownloadName,
  evidenceFileFacts,
  evidenceFileGroups,
  evidenceFileIsGone,
  evidenceFileKind,
  evidenceFileName,
  evidenceFilePosition,
  evidenceFileSaveName,
  evidenceFilesAllGone,
  evidenceFilesCount,
  evidenceFilesHeadline,
  evidenceFilesMore,
  evidenceFilesOnCard,
  evidenceFilesShowing,
  evidenceReportFacts,
  evidenceReportCounts,
  evidenceReportFormat,
  evidenceReportList,
  evidenceReportNamesMore,
  evidenceReportTitle,
  evidenceRevisionLine,
  evidenceTestReports,
  isEvidencePicture,
  type EvidenceFile,
  type EvidenceFileCitation,
  type EvidenceFileList,
  type EvidenceTestReport,
} from '../lib/evidenceFiles';
import { evidenceFilesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useIsMobile } from '../lib/useMediaQuery';
import { saveUserFile } from '../lib/userFile';
import { refreshCardKeys } from './CardHotkey';
// Read at render, like every card's use of it, so it does not matter which module a bundle enters first.
import { decisionReceiptTime } from './EvidenceDecisionCard';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Drawer } from './ui/Drawer';
import { ImagePreview } from './ui/ImagePreview';
import './EvidenceFiles.css';

/**
 * What a version of evidence cites, on its card (docs/orbit-files-design.md §2.6): the file area under
 * the standard, the Evidence files page it opens, and the viewer a thumbnail opens.
 *
 * ONLY A RASTER IMAGE IS EVER DRAWN
 * ---------------------------------
 * Every byte here was written by whoever submitted the evidence. `isEvidencePicture` is the one test
 * for what becomes an `<img>`, and everything else, SVG and HTML included, is a tile that saves the
 * file (`saveUserFile`). Nothing here opens a file, and no object URL is made outside `lib/userFile`.
 *
 * WHAT OUTLIVES THE BYTES
 * -----------------------
 * The list and the summaries are read from rows, so an expired file keeps its name, its size, its
 * sha256 and its report here. Only its picture goes.
 */

interface FileUrls {
  urls: ReadonlyMap<string, string>;
  /** The files whose bytes did not come back, or did not draw. */
  failed: ReadonlySet<string>;
  read: (id: string) => void;
  fail: (id: string) => void;
}

/**
 * The object URLs one surface has drawn, each read once and let go with the surface: the card holds
 * its four, and the page holds what was scrolled to for as long as it is open. The route is
 * bearer-guarded, so an `<img src>` pointed straight at it would 401.
 */
function useFileUrls(): FileUrls {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const asked = useRef(new Set<string>());
  const held = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const url of held.current) URL.revokeObjectURL(url);
      held.current.clear();
      asked.current.clear();
    };
  }, []);
  const fail = useCallback((id: string): void => setFailed((previous) => new Set(previous).add(id)), []);
  const read = useCallback((id: string): void => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    fetchAttachmentObjectUrl(id).then((url) => {
      // The surface may have gone while the bytes were on their way.
      if (!live.current) {
        URL.revokeObjectURL(url);
        return;
      }
      held.current.add(url);
      setUrls((previous) => new Map(previous).set(id, url));
    }, () => fail(id));
  }, [fail]);
  return { urls, failed, read, fail };
}

/** Whether an element has been on screen. Where nothing can tell, it has: the picture is just read early. */
function useSeen(element: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !element.current) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setSeen(true);
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [element, seen]);
  return seen;
}

/** What fills a tile: the picture, the grey that takes its place once it has expired, or the file's kind. */
function TileFace({ file, files }: { file: EvidenceFile; files: FileUrls }): JSX.Element {
  if (evidenceFileIsGone(file)) {
    return (
      <span className="evidence-tile-expired">
        {EVIDENCE_FILE_EXPIRED}
        {file.expiredAt === null ? null : (
          <>
            <br />
            {evidenceExpiryDate(file.expiredAt)}
          </>
        )}
      </span>
    );
  }
  if (!isEvidencePicture(file) || files.failed.has(file.id)) {
    return <span className="evidence-tile-kind">{evidenceFileKind(file)}</span>;
  }
  const url = files.urls.get(file.id);
  return url
    ? <img className="evidence-tile-img" src={url} alt="" onError={() => files.fail(file.id)} />
    : <span className="evidence-tile-empty" />;
}

function ReportMark({ report, quiet }: { report: EvidenceTestReport; quiet: boolean }): JSX.Element {
  return report.failed > 0
    ? <CloseCircleFilled className="evidence-report-mark is-failed" aria-hidden />
    : <CheckCircleFilled className={`evidence-report-mark${quiet ? ' is-quiet' : ' is-passed'}`} aria-hidden />;
}

/** The report's line on the card, with the failed cases it can name. The page has the rest. */
function ReportLine({ report, quiet }: { report: EvidenceTestReport; quiet: boolean }): JSX.Element {
  const names = report.failedNames.slice(0, EVIDENCE_REPORT_NAMES_SHOWN);
  const rest = report.failed - names.length;
  return (
    <span className="evidence-report-line">
      <ReportMark report={report} quiet={quiet} />
      <span className="evidence-report-text">
        <b>{evidenceReportFormat(report)}</b>
        {` · ${evidenceReportCounts(report)}`}
      </span>
      {names.map((name, k) => (
        <span key={k} className="evidence-report-name" title={name}>{name}</span>
      ))}
      {names.length > 0 && rest > 0 ? (
        <span className="evidence-report-name">{evidenceReportNamesMore(rest)}</span>
      ) : null}
    </span>
  );
}

/**
 * The file area: a heading, up to four thumbnails and what a report said. One button, because what it
 * does is one thing: a thumbnail opens the viewer on the page, where the whole set can be paged.
 */
export function EvidenceFilesArea({ taskId, revision, citations }: {
  taskId: string;
  revision: string;
  citations: readonly EvidenceFileCitation[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const read = useInfiniteQuery(evidenceFilesQuery(taskId, revision));
  const pages = read.data?.pages ?? [];
  const list: EvidenceFileList | null = pages[0]
    ? { ...pages[0], files: pages.flatMap((page) => page.files), nextOffset: pages.at(-1)!.nextOffset }
    : null;
  const reports = evidenceTestReports(citations);
  const urls = useFileUrls();
  const { read: readUrl } = urls;
  const onCard = list ? evidenceFilesOnCard(list) : { shown: [], rest: 0 };
  const pictures = onCard.shown.filter(isEvidencePicture).map((file) => file.id).join();
  useEffect(() => {
    if (pictures !== '') pictures.split(',').forEach(readUrl);
  }, [pictures, readUrl]);
  const quiet = list !== null && evidenceFilesAllGone(list);
  return (
    <div className="evidence-files">
      <button
        type="button"
        className="evidence-files-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="evidence-files-head">{list ? evidenceFilesHeadline(list) : EVIDENCE_FILES_HEADING}</span>
        {list ? (
          <span className="evidence-files-row">
            {onCard.shown.map((file) => (
              <span key={file.id} className="evidence-tile" title={evidenceFileName(file)}>
                <TileFace file={file} files={urls} />
              </span>
            ))}
            {onCard.rest > 0 ? (
              <span className="evidence-tile evidence-tile-more">{evidenceFilesMore(onCard.rest)}</span>
            ) : null}
          </span>
        ) : (
          <span className="evidence-files-quiet">{read.isError ? EVIDENCE_FILES_UNREAD : EVIDENCE_FILES_LOADING}</span>
        )}
        {reports.map((report, k) => <ReportLine key={k} report={report} quiet={quiet} />)}
      </button>
      <EvidenceFilesSheet
        open={open}
        onClose={() => setOpen(false)}
        revision={revision}
        list={list}
        unread={read.isError}
        reports={reports}
        quiet={quiet}
        fetchingMore={read.isFetchingNextPage}
        onMore={() => void read.fetchNextPage()}
      />
    </div>
  );
}

interface EvidenceFilesPageProps {
  revision: string;
  /** Null until the list is read. */
  list: EvidenceFileList | null;
  unread: boolean;
  reports: EvidenceTestReport[];
  quiet: boolean;
  fetchingMore: boolean;
  /** Read the list's next page. */
  onMore: () => void;
}

/** A sheet from the bottom on a narrow screen and a dialog on a wide one, as the start card opens. */
function EvidenceFilesSheet({ open, onClose, ...page }: EvidenceFilesPageProps & {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const narrow = useIsMobile();
  // Drawn only while the sheet is (the overlay mounts nothing closed), so its pictures go with it.
  const body = <EvidenceFilesPage {...page} />;
  return narrow ? (
    <Drawer open={open} onClose={onClose} title={EVIDENCE_FILES_TITLE} placement="bottom" height="92%"
      className="evidence-files-sheet">
      {body}
    </Drawer>
  ) : (
    <Dialog open={open} onClose={onClose} title={EVIDENCE_FILES_TITLE} width={720} className="evidence-files-dialog">
      {body}
    </Dialog>
  );
}

/** One report at the top of the page, opening into the cases it failed and skipped. */
function ReportBlock({ report, quiet }: { report: EvidenceTestReport; quiet: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const lists = [
    { word: EVIDENCE_REPORT_FAILED, count: report.failed, names: report.failedNames },
    { word: EVIDENCE_REPORT_SKIPPED, count: report.skipped, names: report.skippedNames },
  ].filter((list) => list.count > 0);
  const head = (
    <>
      <ReportMark report={report} quiet={quiet} />
      <span className="evidence-report-title">{evidenceReportTitle(report)}</span>
      {lists.length > 0 ? (
        <RightOutlined className={`evidence-report-caret${open ? ' is-open' : ''}`} aria-hidden />
      ) : null}
      <span className="evidence-report-facts">{evidenceReportFacts(report)}</span>
    </>
  );
  return (
    <div className="evidence-report">
      {lists.length > 0 ? (
        <button type="button" className="evidence-report-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          {head}
        </button>
      ) : (
        <div className="evidence-report-head">{head}</div>
      )}
      {open ? lists.map(({ word, count, names }) => (
        <div key={word} className="evidence-report-list">
          <div className="evidence-report-list-head">{evidenceReportList(word, count)}</div>
          <ul>
            {names.map((name, k) => <li key={k}>{name}</li>)}
          </ul>
          {/* The server keeps twenty names of each: the count is the whole of it. */}
          {count > names.length ? (
            <div className="evidence-report-list-more">{evidenceReportNamesMore(count - names.length)}</div>
          ) : null}
        </div>
      )) : null}
    </div>
  );
}

/** A tile on the page. A picture opens the viewer and any other file with bytes is saved, because neither
 *  an SVG nor a page may be opened. An expired one does neither, and says what it was. */
function PageTile({ file, files, onView, onSave }: {
  file: EvidenceFile;
  files: FileUrls;
  onView: (file: EvidenceFile, event: ReactMouseEvent<HTMLElement>) => void;
  onSave: (file: EvidenceFile) => void;
}): JSX.Element {
  const tile = useRef<HTMLDivElement>(null);
  const seen = useSeen(tile);
  const { read } = files;
  const picture = isEvidencePicture(file) && !files.failed.has(file.id);
  useEffect(() => {
    if (seen && picture) read(file.id);
  }, [seen, picture, read, file.id]);
  const name = evidenceFileName(file);
  const face = <TileFace file={file} files={files} />;
  return (
    <div ref={tile} className="evidence-page-tile">
      {evidenceFileIsGone(file) ? (
        <div className="evidence-tile">{face}</div>
      ) : (
        <button
          type="button"
          className="evidence-tile evidence-tile-press"
          aria-label={picture ? name : evidenceFileDownloadName(name)}
          title={picture ? name : evidenceFileDownloadName(name)}
          onClick={(event) => (picture ? onView(file, event) : onSave(file))}
        >
          {face}
        </button>
      )}
      {picture ? null : (
        <div className="evidence-tile-caption">
          <div className="evidence-tile-name" title={name}>{evidenceFileSaveName(file)}</div>
          <div className="evidence-tile-facts">{evidenceFileFacts(file)}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The page: which version and how much of it, what its reports said, and every file by the folder it
 * was uploaded in.
 *
 * `review-card-content` with `data-review-open` is what suspends the cards behind it (`CardHotkey.ts`).
 * Focus can rest on this page's popup, and a bare Enter there would otherwise reach the card it was
 * opened from and press `Confirm done`.
 */
function EvidenceFilesPage({ revision, list, unread, reports, quiet, fetchingMore, onMore }: EvidenceFilesPageProps): JSX.Element {
  const urls = useFileUrls();
  const toast = useToast();
  const [viewing, setViewing] = useState<{ id: string; origin: { x: number; y: number } } | null>(null);
  const suspendKeys = useCallback((): void => refreshCardKeys(), []);
  const groups = evidenceFileGroups(list?.files ?? []);
  const pictures = groups
    .flatMap((group) => group.files)
    .filter((file) => isEvidencePicture(file) && !urls.failed.has(file.id));
  // A picture that will not draw leaves the set while it is shown: the viewer closes rather than show nothing.
  const shown = pictures.find((file) => file.id === viewing?.id);
  const save = (file: EvidenceFile): void => {
    fetchAttachmentObjectUrl(file.id)
      .then((url) => saveUserFile(url, evidenceFileSaveName(file)))
      .catch((error: Error) => toast.error(EVIDENCE_FILE_DOWNLOAD_FAILED, error.message));
  };
  const view = (file: EvidenceFile, event: ReactMouseEvent<HTMLElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    setViewing({ id: file.id, origin: { x: box.left + box.width / 2, y: box.top + box.height / 2 } });
  };
  return (
    <div ref={suspendKeys} className="review-card-content evidence-files-page" data-review-open="true">
      <div className="evidence-files-version">
        <span>{evidenceRevisionLine(revision)}{list ? ` · ${decisionReceiptTime(list.submittedAt)}` : ''}</span>
        {list ? <span>{evidenceFilesCount(list)}</span> : null}
      </div>
      {reports.map((report, k) => <ReportBlock key={k} report={report} quiet={quiet} />)}
      {list ? null : (
        <div className="evidence-files-quiet">{unread ? EVIDENCE_FILES_UNREAD : EVIDENCE_FILES_LOADING}</div>
      )}
      {groups.map((group) => (
        <section key={group.name} className="evidence-files-group">
          <h3 className="evidence-files-group-head">
            {group.name} <span>{group.files.length}</span>
          </h3>
          <div className="evidence-files-grid">
            {group.files.map((file) => (
              <PageTile key={file.id} file={file} files={urls} onView={view} onSave={save} />
            ))}
          </div>
        </section>
      ))}
      {list?.nextOffset != null ? (
        <div className="evidence-files-showing">
          <span>{evidenceFilesShowing(list.files.length, list.fileCount)}</span>
          <Button size="small" loading={fetchingMore} onClick={onMore}>{EVIDENCE_FILES_SHOW_MORE}</Button>
        </div>
      ) : null}
      {viewing && shown ? (
        <EvidenceFileViewer
          pictures={pictures}
          file={shown}
          origin={viewing.origin}
          urls={urls}
          onView={(file) => setViewing({ ...viewing, id: file.id })}
          onClose={() => setViewing(null)}
          onSave={save}
        />
      ) : null}
    </div>
  );
}

/** The shown picture's own size, for a file the server has none for: a folder's rows do not record it. */
function usePictureSize(file: EvidenceFile, url: string | undefined): { width: number | null; height: number | null } {
  const [decoded, setDecoded] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!url || file.width) return undefined;
    const image = new Image();
    image.onload = () => setDecoded({ url, width: image.naturalWidth, height: image.naturalHeight });
    image.src = url;
    return () => {
      image.onload = null;
    };
  }, [url, file.width]);
  if (file.width) return file;
  return decoded && decoded.url === url ? decoded : { width: null, height: null };
}

/** The viewer, paging the pictures in the order the page shows them, and reading ahead one either way. */
function EvidenceFileViewer({ pictures, file, origin, urls, onView, onClose, onSave }: {
  pictures: EvidenceFile[];
  file: EvidenceFile;
  origin: { x: number; y: number };
  urls: FileUrls;
  onView: (file: EvidenceFile) => void;
  onClose: () => void;
  onSave: (file: EvidenceFile) => void;
}): JSX.Element {
  const { read } = urls;
  const current = pictures.indexOf(file);
  useEffect(() => {
    for (const each of pictures.slice(Math.max(0, current - 1), current + 2)) read(each.id);
  }, [pictures, current, read]);
  const size = usePictureSize(file, urls.urls.get(file.id));
  return (
    <ImagePreview
      group
      open
      items={pictures.map((each) => ({ src: urls.urls.get(each.id), alt: evidenceFileName(each) }))}
      current={current}
      onCurrentChange={(index) => onView(pictures[index])}
      onClose={onClose}
      origin={origin}
      position={evidenceFilePosition}
      caption={(
        <>
          <div className="evidence-viewer-path">{evidenceFileName(file)}</div>
          <div>{evidenceFileFacts(file, size)}</div>
        </>
      )}
      actions={[{
        key: 'download',
        label: EVIDENCE_FILE_DOWNLOAD,
        icon: <DownloadOutlined aria-hidden />,
        onClick: () => onSave(file),
      }]}
    />
  );
}
