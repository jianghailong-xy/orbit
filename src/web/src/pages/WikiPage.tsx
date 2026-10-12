import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownOutlined, SearchOutlined } from '@ant-design/icons';
import { OrbitLinkCardsProvider } from '../components/OrbitLinkCard';
import { statusLabel } from '../components/WorkspaceView';
import { WikiActivityButton, WikiActivityPage } from '../components/WikiActivityPage';
import { WikiArticleRoute } from '../components/WikiArticlePage';
import { WikiBrowsePage } from '../components/WikiBrowsePage';
import { WikiDocRoute } from '../components/WikiDocPage';
import { WikiCard, WikiEmpty } from '../components/WikiCards';
import { WikiContentsButton, WikiContentsProvider, WikiDirectory, type WikiDirectoryAt } from '../components/WikiDirectory';
import { WikiEntryDrawer } from '../components/WikiEntryDrawer';
import { WikiHome, WikiHomeState } from '../components/WikiHome';
import { WikiIndexPage } from '../components/WikiIndexPage';
import { WikiMaintenanceStatus } from '../components/WikiMaintenanceStatus';
import { WikiNewEntryButton } from '../components/WikiNewEntry';
import { WikiPlanRoute } from '../components/WikiPlanPage';
import { WikiReviewPage } from '../components/WikiReviewPage';
import { WikiRunDrawer } from '../components/WikiRunPage';
import { WikiSettingsButton } from '../components/WikiSettingsButton';
import { WikiShareButton } from '../components/WikiShareButton';
import { WikiSettingsPage } from '../components/WikiSettingsPage';
import { openSessionSearch } from '../components/SessionSearch';
import { wikiLinkHost } from '../components/WikiSources';
import { wikiEntriesQuery, wikiEntryQuery, wikiHealthQuery, wikiSpacesQuery } from '../lib/queries';
import { routeId } from '../lib/idCodec';
import {
  WIKI_DISABLED_NOTE,
  WIKI_NO_SPACES,
  WIKI_NO_SUCH_SPACE,
  WIKI_SEARCH_PLACEHOLDER,
  WIKI_SEARCH_SHORTCUT,
  WIKI_SPACE_PICKER_HINT,
  WIKI_ENTRY_NOUN,
  WIKI_TITLE,
  WIKI_TO_REVIEW,
  wikiAnchorsVerified,
  wikiSpacePath,
  type WikiSpaceRow,
} from '../lib/wiki';
import { wikiArticlePath, wikiCount } from '../lib/wikiArticles';
import { wikiDocPath } from '../lib/wikiDocs';
import {
  readWikiFromWorkspace,
  readWikiLastSpace,
  wikiDefaultSpace,
  wikiSpaceNames,
  wikiSpaceOption,
  wikiWaiting,
  writeWikiLastSpace,
} from '../lib/wikiSpace';

/**
 * The Wiki's routes, and the chrome they share.
 *
 * ONE PAGE COMPONENT, because the views differ only in the body under the header: the header — the
 * space picker, the search line, the status row — belongs to the space rather than to any one view,
 * and the drawer is an OVERLAY on whatever is behind it. That is the design's own arrangement
 * (mock 03): `/wiki/:space/e/:entry` leaves the entry's topic page in place and slides the drawer
 * over it, so the page a reader came from is still there when they close it.
 *
 * A SPACE IS A CODEBASE, addressed by slug. `/wiki` is one space rather than a space list: a wiki
 * belongs to the account, one of its spaces is what a reader means when they open the Wiki — the one
 * bound to the workspace they came from, else the one they last looked at, else the one with the most
 * written (`wikiDefaultSpace`, design §12.3.4) — and the picker in the header is how they mean another.
 */

export type WikiRoute = 'home' | 'activity' | 'topic' | 'entry' | 'review' | 'settings' | 'run' | 'browse' | 'index' | 'doc' | 'plan' | 'planDoc' | 'planSection';

type SpaceRow = WikiSpaceRow;

export function WikiPage({ route }: { route: WikiRoute }) {
  const spaces = useQuery(wikiSpacesQuery());
  const params = useParams();
  const asked = params.space ?? null;
  // Where the reader came from and what they last looked at are read once per answer of the list, so
  // the space this page opens does not move under them when it records itself as the last one.
  const resolved = useMemo(
    () =>
      asked
        ? (spaces.data?.find((row) => row.slug === asked) ?? null)
        : wikiDefaultSpace(spaces.data ?? [], { workspaceId: readWikiFromWorkspace(), lastSlug: readWikiLastSpace() }),
    [spaces.data, asked],
  );
  // Review's own route asks across every space, so it is no look at the space `/wiki` would open.
  const looked = route === 'review' && !asked ? null : (resolved?.slug ?? null);
  useEffect(() => {
    if (looked) writeWikiLastSpace(looked);
  }, [looked]);

  // The server has not switched the wiki on for this account (WIKI_DISABLED): every route below it
  // would be refused, so the page says why instead of drawing a wiki with nothing in it.
  if (spaces.data === null) {
    return (
      <WikiFrame space={null}>
        <WikiEmpty>{WIKI_DISABLED_NOTE}</WikiEmpty>
      </WikiFrame>
    );
  }
  // Review's own route carries no space and asks across every one of them, which is a different
  // question from the one its /wiki/:space/review sibling asks (see `wikiReviewQuery`).
  if (route === 'review' && !asked) {
    return (
      <WikiFrame space={null}>
        <WikiReviewPage spaceSlug={null} />
      </WikiFrame>
    );
  }
  if (spaces.isSuccess && !resolved) {
    return (
      <WikiFrame space={null}>
        <WikiCard title={WIKI_TITLE}>
          <WikiEmpty>{asked ? WIKI_NO_SUCH_SPACE : WIKI_NO_SPACES}</WikiEmpty>
        </WikiCard>
      </WikiFrame>
    );
  }
  if (!resolved) {
    // Still reading the list (a page opened by its address, before the drawer read it): nothing is known
    // yet, so nothing is said — not that there is no space.
    return <WikiFrame space={null}>{spaces.isPending ? null : <WikiEmpty>{WIKI_NO_SPACES}</WikiEmpty>}</WikiFrame>;
  }

  const space: SpaceRow = resolved;
  // The space's own settings are a page of their own, the app's Settings page for one space (mock 19):
  // no search line or status row over them.
  if (route === 'settings') return <WikiSettingsPage space={resolved} />;
  if (route === 'run') return <RunRoute space={space} runParam={params.run ?? ''} />;
  if (route === 'review') {
    return (
      <WikiFrame space={space}>
        <WikiReviewPage spaceSlug={space.slug} />
      </WikiFrame>
    );
  }
  // What the home said besides its content (design §12.3.2): the status row moves under its title.
  if (route === 'activity') {
    return (
      <WikiFrame space={space} at={{ view: 'activity' }}>
        <WikiActivityPage key={space.slug} space={space} spaces={spaces.data ?? [space]} status={<WikiStatusRow space={space} />} />
      </WikiFrame>
    );
  }
  if (route === 'topic') {
    const topic = params.topic ?? '';
    const part = wikiPartParam(params.part);
    return (
      <WikiFrame space={space} at={{ view: 'topic', topic, part }}>
        <WikiArticleRoute spaceId={space.id} spaceSlug={space.slug} topicSlug={topic} part={part} />
      </WikiFrame>
    );
  }
  // A document of the confirmed plan (mocks 23–24), and the plan itself (mocks 21–22) with a phone's page
  // for one of its documents and one of their sections.
  if (route === 'doc') {
    const slug = params.doc ?? '';
    return (
      <WikiFrame space={space} at={{ view: 'doc', slug }}>
        <WikiDocRoute spaceId={space.id} spaceSlug={space.slug} slug={slug} />
      </WikiFrame>
    );
  }
  if (route === 'plan' || route === 'planDoc' || route === 'planSection') {
    const section = Number(params.section ?? 0);
    return (
      <WikiFrame space={space} at={{ view: 'plan' }}>
        <WikiPlanRoute
          spaceId={space.id}
          spaceSlug={space.slug}
          docSlug={route === 'plan' ? null : (params.doc ?? null)}
          section={route === 'planSection' && Number.isInteger(section) && section > 0 ? section : null}
        />
      </WikiFrame>
    );
  }
  if (route === 'browse') {
    return (
      <WikiFrame space={space} at={{ view: 'browse' }}>
        <WikiBrowsePage spaceId={space.id} spaceSlug={space.slug} />
      </WikiFrame>
    );
  }
  if (route === 'index') {
    return (
      <WikiFrame space={space} at={{ view: 'index' }}>
        <WikiIndexPage spaceId={space.id} spaceSlug={space.slug} />
      </WikiFrame>
    );
  }
  if (route === 'entry') {
    return <EntryRoute space={space} entryParam={params.entry ?? ''} />;
  }
  return (
    <WikiFrame space={space} at={{ view: 'home' }}>
      <WikiHome space={space} />
    </WikiFrame>
  );
}

/** A subtopic article's number from its URL segment; anything that is not one is the topic's own article. */
function wikiPartParam(raw: string | undefined): number {
  const part = Number(raw ?? 0);
  return Number.isInteger(part) && part > 0 ? part : 0;
}

/**
 * `/wiki/:space/e/:entry`: the entry's own first topic stays behind the drawer.
 *
 * Its FIRST topic, because that is the page a reader would have come from and where its title and
 * facts were read. An entry filed under nothing has no such page, so the drawer opens over the
 * space's home instead of over a topic that does not exist.
 *
 * AN ENTRY OPENED FROM AN ARTICLE'S FOOTNOTE keeps that article behind it instead: the footnote says
 * where it came from (`state.wikiBack`), and closing the drawer returns to the sentence the reader
 * was on rather than to whichever topic the entry names first.
 */
function EntryRoute({ space, entryParam }: { space: SpaceRow; entryParam: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const entryId = routeId(entryParam) ?? entryParam;
  const entry = useQuery(wikiEntryQuery(entryId));
  const from = (location.state as { wikiBack?: { topic?: string; part?: number; doc?: string } } | null)?.wikiBack ?? null;
  // An entry opened from a document's footnote or its entries keeps that document behind it.
  const doc = from?.doc ?? null;
  const topic = doc ? null : (from?.topic ?? entry.data?.topics?.[0] ?? null);
  const part = from?.part ?? 0;
  const back = doc ? wikiDocPath(space.slug, doc) : topic ? wikiArticlePath(space.slug, topic, part) : wikiSpacePath(space.slug);

  return (
    // The drawer draws its sources with the conversation's own link cards, and those ask a provider
    // for what has been registered with it — so the drawer needs one of its own here, because
    // `WikiFrame` mounts its provider inside the page it draws and the drawer is a SIBLING of that
    // page rather than a child of it.
    <OrbitLinkCardsProvider stateWord={statusLabel} host={wikiLinkHost()}>
      <div className="wk-with-drawer">
        <div className="wk-drawer-bg" aria-hidden="true">
          {doc ? (
            <WikiFrame space={space} at={{ view: 'doc', slug: doc }}>
              <WikiDocRoute spaceId={space.id} spaceSlug={space.slug} slug={doc} />
            </WikiFrame>
          ) : topic ? (
            <WikiFrame space={space} at={{ view: 'topic', topic, part }}>
              <WikiArticleRoute spaceId={space.id} spaceSlug={space.slug} topicSlug={topic} part={part} />
            </WikiFrame>
          ) : (
            <WikiFrame space={space} at={{ view: 'home' }}>
              <WikiHome space={space} />
            </WikiFrame>
          )}
        </div>
        <button type="button" className="wk-scrim" aria-label="Close" onClick={() => navigate(back)} />
        <WikiEntryDrawer entryId={entryId} spaceSlug={space.slug} onClose={() => navigate(back)} />
      </div>
    </OrbitLinkCardsProvider>
  );
}

/**
 * `/wiki/:space/run/:run`: one run as a drawer over the space's home, the way an entry's drawer
 * stands over the page it was opened from (mock 17 ⑧).
 */
function RunRoute({ space, runParam }: { space: SpaceRow; runParam: string }) {
  const navigate = useNavigate();
  const changesetId = routeId(runParam) ?? runParam;
  const back = wikiSpacePath(space.slug);
  return (
    <div className="wk-with-drawer">
      <div className="wk-drawer-bg" aria-hidden="true">
        <WikiFrame space={space} at={{ view: 'home' }}>
          <WikiHome space={space} />
        </WikiFrame>
      </div>
      <button type="button" className="wk-scrim" aria-label="Close" onClick={() => navigate(back)} />
      <WikiRunDrawer spaceSlug={space.slug} changesetId={changesetId} onClose={() => navigate(back)} />
    </div>
  );
}

/**
 * The chrome every Wiki view wears: the title row (the space, Contents, Activity, Settings, Share, New entry),
 * the search line and the status row. It is the project page's own title row and toolbar, which is
 * what the design's mock links and draws — the counts are the page's counts, not a new row of numbers.
 *
 * THE HOME HAS NO STATUS ROW (design §12.3.1): the line under its head says what the space holds
 * (`WikiHomeState`, mocks 30 ③ and 33 ①), and how the space is kept is Activity's.
 *
 * THE DIRECTORY STANDS BESIDE EVERY READING VIEW (`at`: the home, a topic's article, Browse, the
 * index — mocks 11, 13, 15): a column on a desktop, and on anything narrower the Contents drawer the
 * head's list button opens. On a phone a reading view other than the home also drops the head — its
 * crumb row carries the list button instead (mock 14 ①). Review and the settings are not reading
 * views and keep the frame as it was.
 *
 * ACTIVITY (design §12.3.2) stands beside the directory too, with none of its rows lit, under the home's
 * head and its line, and takes the status row under its own title (mock 33 ④ ⑤); a phone draws it
 * under its own head instead of this one (mock 31 ②), as Review's mock does (09).
 */
function WikiFrame({
  space,
  at = null,
  children,
}: {
  space: SpaceRow | null;
  at?: WikiDirectoryAt | null;
  children: React.ReactNode;
}) {
  const spaces = useQuery(wikiSpacesQuery());
  const rows = spaces.data ?? (space ? [space] : []);
  const activity = at?.view === 'activity';
  const home = at?.view === 'home';

  const page = (
    <div className={`wk-page${at && !home && !activity ? ' wk-page--reading' : ''}${activity ? ' wk-page--activity' : ''}`}>
      <div className="wk-title-row">
        <h1 className="page-title">{WIKI_TITLE}</h1>
        {space && <WikiHeadSpace space={space} spaces={rows} />}
        <div className="wk-actions">
          {space && at && <WikiContentsButton />}
          {space && <WikiActivityButton spaceSlug={space.slug} waiting={wikiWaiting(rows)} on={activity} />}
          {space && <WikiSettingsButton spaceSlug={space.slug} />}
          {space && <WikiShareButton spaceId={space.id} spaceSlug={space.slug} />}
          {space && <WikiNewEntryButton spaceId={space.id} />}
        </div>
      </div>

      {space && (home || activity) && <WikiHomeState spaceId={space.id} />}

      {space && (
        <div className="wk-search" role="search">
          {/* The palette's own search: ⌘K answers entries in its Wiki group, so this line opens it. */}
          <button type="button" className="wk-search-open" onClick={openSessionSearch}>
            <SearchOutlined className="ic" />
            <span className="grow">{WIKI_SEARCH_PLACEHOLDER}</span>
            <kbd className="wk-kbd">{WIKI_SEARCH_SHORTCUT}</kbd>
          </button>
        </div>
      )}

      {!home && !activity && <WikiStatusRow space={space} />}

      {space && at ? (
        <div className={`wk-layout${home ? ' home' : ''}`}>
          <div className="wk-dir-col">
            <WikiDirectory spaceId={space.id} spaceSlug={space.slug} at={at} />
          </div>
          <div className="wk-main">{children}</div>
        </div>
      ) : (
        <div className="wk-body">{children}</div>
      )}
    </div>
  );

  return (
    <OrbitLinkCardsProvider stateWord={statusLabel} host={wikiLinkHost()}>
      {space && at ? (
        <WikiContentsProvider spaceId={space.id} spaceSlug={space.slug} at={at}>
          {page}
        </WikiContentsProvider>
      ) : (
        page
      )}
    </OrbitLinkCardsProvider>
  );
}

/**
 * The head's space (design §12.3.4, mock 31 ④): with one space, its name as a label with nothing to
 * choose; with more, the native select — closed, the name alone; open, every space with what waits in
 * it. The name is the repository's (`wikiSpaceNames`), not the slug.
 */
function WikiHeadSpace({ space, spaces }: { space: SpaceRow; spaces: readonly SpaceRow[] }) {
  const navigate = useNavigate();
  const names = useMemo(() => wikiSpaceNames(spaces), [spaces]);
  const name = names.get(space.id) ?? space.title;
  if (spaces.length < 2) {
    return (
      <span className="wk-space-tag" title={WIKI_SPACE_PICKER_HINT}>
        {name}
      </span>
    );
  }
  return (
    <span className="wk-select" title={WIKI_SPACE_PICKER_HINT}>
      <span className="v">{name}</span>
      <select value={space.slug} aria-label={WIKI_SPACE_PICKER_HINT} onChange={(event) => navigate(wikiSpacePath(event.target.value))}>
        {spaces.map((row) => (
          <option key={row.id} value={row.slug}>
            {wikiSpaceOption(names.get(row.id) ?? row.title, row)}
          </option>
        ))}
      </select>
      <DownOutlined className="ic caret" />
    </span>
  );
}

/** The status row: what the space holds, how fresh its anchors are, and where maintenance stands. */
function WikiStatusRow({ space }: { space: SpaceRow | null }) {
  const entries = useQuery(wikiEntriesQuery(space?.id ?? null));
  // The status line's health (criterion 5): every active entry of the space — the entry list stops at
  // 200, so its length is the count only until the health read is in — and where maintenance stands.
  const health = useQuery(wikiHealthQuery(space?.id ?? null));
  const count = health.data?.entries ?? entries.data?.length ?? 0;
  return (
    <>
      {space && (
        <div className="project-integration wk-status-row">
          <div className="project-integration-row">
            <span className="project-integration-facts">
              <span>
                <b>{wikiCount(count)}</b> {WIKI_ENTRY_NOUN(count)}
              </span>
              {/* The phone's amber banner says this one (mock 12 ①), so its status line leaves it out. */}
              <span className="wk-status-review">
                <span className="wk-sep">·</span>
                <span className={space.pendingOps > 0 ? 'wk-warn-text' : ''}>
                  <b>{space.pendingOps}</b> {WIKI_TO_REVIEW}
                </span>
              </span>
              {space.rootCommitSha && (
                <>
                  <span className="wk-sep">·</span>
                  <span>{wikiAnchorsVerified(space.rootCommitSha.slice(0, 7), '')}</span>
                </>
              )}
              {/* The maintenance run's part of this line, after the anchors, on every width (mocks 11 ②,
                  12 ④): `Maintained 2h ago ✓ · 6 to catch up` and its other looks. */}
              {health.data && <WikiMaintenanceStatus health={health.data} spaceSlug={space.slug} />}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
