import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import {
  AppstoreOutlined,
  CloseOutlined,
  DownOutlined,
  HomeOutlined,
  ProfileOutlined,
  SortAscendingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { wikiArticlesQuery, wikiDocsQuery, wikiPlanQuery, wikiSpaceQuery } from '../lib/queries';
import { useWikiMaintenanceWhere } from '../lib/useWikiMaintenanceWhere';
import { wikiSpacePath } from '../lib/wiki';
import {
  WIKI_DIRECTORY_PLAN,
  wikiDocDirectoryGroups,
  wikiDocPath,
  wikiDocSectionPath,
  wikiReadsByDocs,
  type WikiDocDirectoryGroup,
} from '../lib/wikiDocs';
import { wikiPlanPath, wikiPlanPending } from '../lib/wikiPlan';
import {
  WIKI_AZ_INDEX,
  WIKI_BROWSE,
  WIKI_CONTENTS,
  WIKI_DIRECTORY_HOME,
  wikiArticlePath,
  wikiBrowsePath,
  wikiCount,
  wikiDirectoryGroups,
  wikiIndexPath,
} from '../lib/wikiArticles';

/**
 * The category directory (criterion 10, mocks 11 ③, 12 ③, 13 ①, 15 ①③; by the plan since its second
 * revision, mocks 25 ①, 23 ①, 27 ①): Home, Browse by category, the A–Z index and the Plan, then — once
 * the space has a confirmed plan — the plan's categories and documents, a document open to its sections
 * while it is the page; before one, every category's topics with their articles, as it was.
 *
 * THE PLAN ROW'S AMBER COUNT is what of the plan waits on the owner (`wikiPlanPending`): a draft to
 * confirm, one that failed, one held, the changes proposed. A document's amber dot is a document past the
 * threshold (Needs review); a grey one is not written yet.
 *
 * ONE LIST, TWO PLACES. On a desktop it is the column left of every reading page; below the app's
 * own mobile width it is the Contents drawer, opened from the page head's list button — the app
 * drawer's own shape (the ☰ on the top bar), with the directory in it instead of the app's nav. The
 * rows are the app sidebar's (`.tp-item`) a step smaller, as the mock draws them.
 *
 * WHERE THE READER IS decides two things: which row is lit, and which topic is open. A topic is open
 * while one of its articles is on the page, and then its subtopic articles are listed under it — the
 * directory never lists every subtopic of every topic, which is what Browse by category is for.
 */

/** What page the directory is beside. */
export type WikiDirectoryAt =
  | { view: 'home' }
  | { view: 'browse' }
  | { view: 'index' }
  | { view: 'topic'; topic: string; part: number }
  | { view: 'doc'; slug: string }
  | { view: 'plan' }
  // Activity (design §12.3.2) is not one of the directory's rows: beside it, none is lit.
  | { view: 'activity' };

/** The section a document's page has on screen, as it announces it (`wk-doc-section`): the directory lights it. */
export const WIKI_DOC_SECTION_EVENT = 'wk-doc-section';

function useDocSection(slug: string | null): string | null {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    setKey(null);
    if (!slug) return;
    const on = (event: Event) => {
      const detail = (event as CustomEvent<{ slug: string; key: string }>).detail;
      if (detail?.slug === slug) setKey(detail.key);
    };
    window.addEventListener(WIKI_DOC_SECTION_EVENT, on);
    return () => window.removeEventListener(WIKI_DOC_SECTION_EVENT, on);
  }, [slug]);
  return key;
}

export function WikiDirectory({ spaceId, spaceSlug, at }: { spaceId: string; spaceSlug: string; at: WikiDirectoryAt }) {
  const directory = useQuery(wikiArticlesQuery(spaceId));
  const docs = useQuery(wikiDocsQuery(spaceId));
  const plan = useQuery(wikiPlanQuery(spaceId));
  const space = useQuery(wikiSpaceQuery(spaceId));
  const maintenance = useWikiMaintenanceWhere(space.data);
  const byDocs = wikiReadsByDocs(docs.data);
  const groups = useMemo(() => (directory.data && !byDocs ? wikiDirectoryGroups(directory.data) : []), [directory.data, byDocs]);
  const docGroups = useMemo(() => (docs.data && byDocs ? wikiDocDirectoryGroups(docs.data) : []), [docs.data, byDocs]);
  const pending = plan.data ? wikiPlanPending(plan.data, maintenance.runnerOnline) : 0;
  const topic = at.view === 'topic' ? at.topic : null;
  const part = at.view === 'topic' ? at.part : 0;
  const openDoc = at.view === 'doc' ? at.slug : null;
  const section = useDocSection(openDoc);

  return (
    <nav className="wk-toc" aria-label={WIKI_CONTENTS}>
      <Link className={`wk-toc-item${at.view === 'home' ? ' active' : ''}`} to={wikiSpacePath(spaceSlug)}>
        <span className="tp-ico">
          <HomeOutlined />
        </span>
        <span className="lb">{WIKI_DIRECTORY_HOME}</span>
      </Link>
      <Link className={`wk-toc-item${at.view === 'browse' ? ' active' : ''}`} to={wikiBrowsePath(spaceSlug)}>
        <span className="tp-ico">
          <AppstoreOutlined />
        </span>
        <span className="lb">{WIKI_BROWSE}</span>
      </Link>
      <Link className={`wk-toc-item${at.view === 'index' ? ' active' : ''}`} to={wikiIndexPath(spaceSlug)}>
        <span className="tp-ico">
          <SortAscendingOutlined />
        </span>
        <span className="lb">{WIKI_AZ_INDEX}</span>
      </Link>
      <Link className={`wk-toc-item plan${at.view === 'plan' ? ' active' : ''}`} to={wikiPlanPath(spaceSlug)}>
        <span className="tp-ico">
          <ProfileOutlined />
        </span>
        <span className="lb">{WIKI_DIRECTORY_PLAN}</span>
        {pending > 0 && <span className="tp-count needs-you">{pending}</span>}
      </Link>
      <div className="wk-toc-sep" />
      {docGroups.map((group) => (
        <WikiDocGroupRows key={group.key} group={group} spaceSlug={spaceSlug} openDoc={openDoc} section={section} />
      ))}
      {groups.map((group) => (
        <div className="wk-toc-group" key={group.key}>
          <div className="wk-toc-cat">{group.title}</div>
          {group.topics.map((row) => {
            const open = row.slug === topic;
            return (
              <div key={row.slug}>
                <Link
                  className={`wk-toc-item${open && part === 0 ? ' active' : open ? ' open' : ''}`}
                  to={wikiArticlePath(spaceSlug, row.slug)}
                  aria-current={open && part === 0 ? 'page' : undefined}
                >
                  <span className="lb">{row.title}</span>
                  {row.count !== null && <span className="n">{wikiCount(row.count)}</span>}
                  {open && row.parts.length > 0 && <DownOutlined className="caret" />}
                </Link>
                {open &&
                  row.parts.map((sub) => (
                    <Link
                      key={sub.part}
                      className={`wk-toc-item sub${sub.part === part ? ' active' : ''}`}
                      to={wikiArticlePath(spaceSlug, row.slug, sub.part)}
                      aria-current={sub.part === part ? 'page' : undefined}
                    >
                      <span className="lb">{sub.title}</span>
                    </Link>
                  ))}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** One category of the plan: its documents, the open one with its sections under it. */
function WikiDocGroupRows({
  group,
  spaceSlug,
  openDoc,
  section,
}: {
  group: WikiDocDirectoryGroup;
  spaceSlug: string;
  openDoc: string | null;
  section: string | null;
}) {
  return (
    <div className="wk-toc-group">
      <div className="wk-toc-cat">{group.title}</div>
      {group.docs.map((doc) => {
        const open = doc.slug === openDoc;
        return (
          <div key={doc.slug}>
            <Link
              className={`wk-toc-item doc${open ? ' active' : ''}${doc.written ? '' : ' todo'}`}
              to={wikiDocPath(spaceSlug, doc.slug)}
              aria-current={open ? 'page' : undefined}
            >
              <span className="no">{doc.number}</span>
              <span className="lb">{doc.title}</span>
              {doc.needsReview && <span className="st" aria-label="Needs review" />}
            </Link>
            {open &&
              doc.sections.map((row) => (
                <Link
                  key={row.key}
                  className={`wk-toc-item sec${section === row.key ? ' active' : ''}${row.written ? '' : ' todo'}`}
                  to={wikiDocSectionPath(spaceSlug, doc.slug, row.key)}
                >
                  <span className="no">{row.number}</span>
                  <span className="lb">{row.title}</span>
                </Link>
              ))}
          </div>
        );
      })}
    </div>
  );
}

// ── The phone's Contents drawer ────────────────────────────────────────────────────────────────

const ContentsContext = createContext<(() => void) | null>(null);

/**
 * The drawer and the one way to open it, for every page under a Wiki frame. The page head's list
 * button and a reading page's crumb row both open this same drawer; it closes itself when the reader
 * goes anywhere, the way the app drawer does.
 */
export function WikiContentsProvider({
  spaceId,
  spaceSlug,
  at,
  children,
}: {
  spaceId: string;
  spaceSlug: string;
  at: WikiDirectoryAt;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <ContentsContext.Provider value={() => setOpen(true)}>
      {children}
      {open && (
        <>
          <div className="wk-contents-backdrop" onClick={() => setOpen(false)} />
          <aside className="wk-contents" role="dialog" aria-label={WIKI_CONTENTS}>
            <div className="wk-contents-h">
              <b>{WIKI_CONTENTS}</b>
              <button type="button" className="wk-contents-x" aria-label="Close" onClick={() => setOpen(false)}>
                <CloseOutlined />
              </button>
            </div>
            <div className="wk-contents-body">
              <WikiDirectory spaceId={spaceId} spaceSlug={spaceSlug} at={at} />
            </div>
          </aside>
        </>
      )}
    </ContentsContext.Provider>
  );
}

/**
 * The list button that opens the Contents drawer: the head's icon buttons' own shape (Settings' gear
 * beside it), shown only where there is no directory column (`.wk-contents-btn` in index.css).
 */
export function WikiContentsButton() {
  const open = useContext(ContentsContext);
  if (!open) return null;
  return <Button className="wk-contents-btn" icon={<UnorderedListOutlined />} aria-label={WIKI_CONTENTS} onClick={open} />;
}
