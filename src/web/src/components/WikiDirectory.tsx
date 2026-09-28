import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import {
  AppstoreOutlined,
  CloseOutlined,
  DownOutlined,
  HomeOutlined,
  SortAscendingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { wikiArticlesQuery } from '../lib/queries';
import { wikiSpacePath } from '../lib/wiki';
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
 * The category directory (criterion 10, mocks 11 ③, 12 ③, 13 ①, 15 ①③): Home, Browse by category and
 * the A–Z index, then every category's topics with the entries each one's article was written from.
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
  | { view: 'topic'; topic: string; part: number };

export function WikiDirectory({ spaceId, spaceSlug, at }: { spaceId: string; spaceSlug: string; at: WikiDirectoryAt }) {
  const directory = useQuery(wikiArticlesQuery(spaceId));
  const groups = useMemo(() => (directory.data ? wikiDirectoryGroups(directory.data) : []), [directory.data]);
  const topic = at.view === 'topic' ? at.topic : null;
  const part = at.view === 'topic' ? at.part : 0;

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
      <div className="wk-toc-sep" />
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
