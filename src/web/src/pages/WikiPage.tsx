import { useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownOutlined, SearchOutlined } from '@ant-design/icons';
import { OrbitLinkCardsProvider } from '../components/OrbitLinkCard';
import { statusLabel } from '../components/WorkspaceView';
import { WikiArticleRoute } from '../components/WikiArticlePage';
import { WikiBrowsePage } from '../components/WikiBrowsePage';
import { WikiCard, WikiEmpty } from '../components/WikiCards';
import { WikiContentsButton, WikiContentsProvider, WikiDirectory, type WikiDirectoryAt } from '../components/WikiDirectory';
import { WikiEntryDrawer } from '../components/WikiEntryDrawer';
import { WikiHome } from '../components/WikiHome';
import { WikiIndexPage } from '../components/WikiIndexPage';
import { WikiNewEntryButton } from '../components/WikiNewEntry';
import { WikiReviewPage } from '../components/WikiReviewPage';
import { WikiRunDrawer } from '../components/WikiRunPage';
import { WikiSettingsButton } from '../components/WikiSettingsButton';
import { WikiSettingsPage } from '../components/WikiSettingsPage';
import { openSessionSearch } from '../components/SessionSearch';
import { wikiLinkHost } from '../components/WikiSources';
import { wikiEntriesQuery, wikiEntryQuery, wikiSpaceQuery, wikiSpacesQuery } from '../lib/queries';
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
} from '../lib/wiki';
import { wikiArticlePath } from '../lib/wikiArticles';

/**
 * The Wiki's routes, and the chrome they share.
 *
 * ONE PAGE COMPONENT, because the views differ only in the body under the header: the header — the
 * space picker, the search line, the status row — belongs to the space rather than to any one view,
 * and the drawer is an OVERLAY on whatever is behind it. That is the design's own arrangement
 * (mock 03): `/wiki/:space/e/:entry` leaves the entry's topic page in place and slides the drawer
 * over it, so the page a reader came from is still there when they close it.
 *
 * A SPACE IS A CODEBASE, addressed by slug. `/wiki` is the first space rather than a space list: a
 * wiki belongs to the account, one of its spaces is what a reader means when they open the Wiki, and
 * the picker in the header is how they mean another one.
 */

export type WikiRoute = 'home' | 'topic' | 'entry' | 'review' | 'settings' | 'run' | 'browse' | 'index';

interface SpaceRow {
  id: string;
  slug: string;
  title: string;
  rootCommitSha: string | null;
  pendingOps: number;
}

export function WikiPage({ route }: { route: WikiRoute }) {
  const spaces = useQuery(wikiSpacesQuery());
  const params = useParams();
  const asked = params.space ?? null;
  const resolved = useMemo(
    () => spaces.data?.find((row) => row.slug === asked) ?? (asked ? null : (spaces.data?.[0] ?? null)),
    [spaces.data, asked],
  );

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
    return (
      <WikiFrame space={null}>
        <WikiEmpty>{WIKI_NO_SPACES}</WikiEmpty>
      </WikiFrame>
    );
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
  if (route === 'topic') {
    const topic = params.topic ?? '';
    const part = wikiPartParam(params.part);
    return (
      <WikiFrame space={space} at={{ view: 'topic', topic, part }}>
        <WikiArticleRoute spaceId={space.id} spaceSlug={space.slug} topicSlug={topic} part={part} />
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
      <HomeBody spaceId={space.id} />
    </WikiFrame>
  );
}

/** A subtopic article's number from its URL segment; anything that is not one is the topic's own article. */
function wikiPartParam(raw: string | undefined): number {
  const part = Number(raw ?? 0);
  return Number.isInteger(part) && part > 0 ? part : 0;
}

/** The home page's body: the space document with its usage window, and the two columns under it. */
function HomeBody({ spaceId }: { spaceId: string }) {
  const space = useQuery(wikiSpaceQuery(spaceId));
  if (!space.data) return <WikiEmpty>{WIKI_NO_SPACES}</WikiEmpty>;
  return <WikiHome space={space.data} />;
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
  const from = (location.state as { wikiBack?: { topic: string; part: number } } | null)?.wikiBack ?? null;
  const topic = from?.topic ?? entry.data?.topics?.[0] ?? null;
  const part = from?.part ?? 0;
  const back = topic ? wikiArticlePath(space.slug, topic, part) : wikiSpacePath(space.slug);

  return (
    // The drawer draws its sources with the conversation's own link cards, and those ask a provider
    // for what has been registered with it — so the drawer needs one of its own here, because
    // `WikiFrame` mounts its provider inside the page it draws and the drawer is a SIBLING of that
    // page rather than a child of it.
    <OrbitLinkCardsProvider stateWord={statusLabel} host={wikiLinkHost()}>
      <div className="wk-with-drawer">
        <div className="wk-drawer-bg" aria-hidden="true">
          {topic ? (
            <WikiFrame space={space} at={{ view: 'topic', topic, part }}>
              <WikiArticleRoute spaceId={space.id} spaceSlug={space.slug} topicSlug={topic} part={part} />
            </WikiFrame>
          ) : (
            <WikiFrame space={space} at={{ view: 'home' }}>
              <HomeBody spaceId={space.id} />
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
          <HomeBody spaceId={space.id} />
        </WikiFrame>
      </div>
      <button type="button" className="wk-scrim" aria-label="Close" onClick={() => navigate(back)} />
      <WikiRunDrawer spaceId={space.id} spaceSlug={space.slug} changesetId={changesetId} onClose={() => navigate(back)} />
    </div>
  );
}

/**
 * The chrome every Wiki view wears: the title row (space picker, New entry), the search line and the
 * status row. It is the project page's own title row and toolbar, which is what the design's mock
 * links and draws — the counts are the page's counts, not a new row of numbers.
 *
 * THE DIRECTORY STANDS BESIDE EVERY READING VIEW (`at`: the home, a topic's article, Browse, the
 * index — mocks 11, 13, 15): a column on a desktop, and on anything narrower the Contents drawer the
 * head's list button opens. On a phone a reading view other than the home also drops the head — its
 * crumb row carries the list button instead (mock 14 ①) — and the home's status row comes before
 * the search (mock 12 ①). Review and the settings are not reading views and keep the frame as it was.
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
  const navigate = useNavigate();
  const spaces = useQuery(wikiSpacesQuery());
  const entries = useQuery(wikiEntriesQuery(space?.id ?? null));
  const count = entries.data?.length ?? 0;

  const page = (
    <div className={`wk-page${at && at.view !== 'home' ? ' wk-page--reading' : ''}`}>
      <div className="wk-title-row">
        <h1 className="page-title">{WIKI_TITLE}</h1>
        {space && (
          <span className="wk-select" title={WIKI_SPACE_PICKER_HINT}>
            <select
              value={space.slug}
              aria-label={WIKI_SPACE_PICKER_HINT}
              onChange={(event) => navigate(wikiSpacePath(event.target.value))}
            >
              {(spaces.data ?? []).map((row) => (
                <option key={row.id} value={row.slug}>
                  {row.slug}
                </option>
              ))}
            </select>
            <DownOutlined className="ic caret" />
          </span>
        )}
        <div className="wk-actions">
          {space && at && <WikiContentsButton />}
          {space && <WikiSettingsButton spaceSlug={space.slug} />}
          {space && <WikiNewEntryButton spaceId={space.id} />}
        </div>
      </div>

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

      {space && (
        <div className="project-integration wk-status-row">
          <div className="project-integration-row">
            <span className="project-integration-facts">
              <span>
                <b>{count}</b> {WIKI_ENTRY_NOUN(count)}
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
              {/* Criterion 5's place: the maintenance run's part of this line — `Maintained 2h ago ✓ ·
                  6 to catch up` and its three other looks (mocks 11 ②, 12 ④) — goes here, after the
                  anchors, on every width. */}
            </span>
          </div>
        </div>
      )}

      {space && at ? (
        <div className={`wk-layout${at.view === 'home' ? ' home' : ''}`}>
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
