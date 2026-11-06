import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { WikiDocSectionVersionView, WikiDocSentenceRow } from '@orbit/shared';
import { wikiDocVersionsQuery } from '../lib/queries';
import { wikiMonthDayTime } from '../lib/wikiDocs';
import {
  WIKI_SEE_CHANGES_FAILED,
  WIKI_SEE_CHANGES_NONE,
  WIKI_SEE_CHANGES_SAME,
  wikiEarlierChanges,
  wikiSeeChangesCause,
  wikiSeeChangesTitle,
} from '../lib/wikiChat';

/** The versions See changes shows after the one it opens on (comment design §12.2: at most four more). */
const EARLIER_SHOWN = 4;

/**
 * See changes (design §8.4, board 42 ③; comment design §12.2, board 36 ⑥): one section's write, sentence by sentence —
 * a sentence it removed struck through, one it added shaded, the ones it kept left out — under the line that says why
 * the section was written and how many sentences that changed, with the versions before it folded under Earlier changes.
 *
 * THE COMPARISON IS THE SERVER'S (`docs.versions.compare`, `wikiDocSentenceDiff`): each kept version comes with its rows
 * against the text that replaced it, so nothing here diffs anything. `versionId` opens on the write a chat card's
 * rewrite kept; without one it opens on the newest. The chat's card, the document page's Updated and Activity's Docs
 * rows all draw this one component.
 */
export function WikiSeeChanges({
  spaceId,
  doc,
  sectionKey,
  where,
  versionId = null,
  unchanged = false,
  title = true,
}: {
  spaceId: string;
  doc: string;
  sectionKey: string;
  /** `3.1 §3`. */
  where: string;
  versionId?: string | null;
  /** A write that left the section as it was and kept no version (a card's `same` section): nothing to read. */
  unchanged?: boolean;
  /** Draw `See changes · 3.1 §3` over it: a card in the chat does, a popover under its own heading does not. */
  title?: boolean;
}) {
  const kept = !(unchanged && versionId === null);
  const read = useQuery({ ...wikiDocVersionsQuery(spaceId, doc, sectionKey), enabled: kept });
  const [older, setOlder] = useState(false);
  const versions = read.data?.versions ?? [];
  const at = versionId ? versions.findIndex((version) => version.id === versionId) : 0;
  const current = at >= 0 ? (versions[at] ?? null) : null;
  const earlier = current ? versions.slice(at + 1, at + 1 + EARLIER_SHOWN) : [];

  return (
    <div className="wk-see" data-section={`${doc}#${sectionKey}`}>
      {title && <div className="wk-see-h">{wikiSeeChangesTitle(where)}</div>}
      {!kept ? (
        <div className="wk-see-none">{WIKI_SEE_CHANGES_SAME}</div>
      ) : read.isError ? (
        <div className="wk-see-none">{WIKI_SEE_CHANGES_FAILED}</div>
      ) : !read.data ? (
        <div className="wk-see-none" aria-busy="true" />
      ) : !current ? (
        <div className="wk-see-none">{WIKI_SEE_CHANGES_NONE}</div>
      ) : (
        <>
          <WikiSeeChangesVersion version={current} />
          {earlier.length > 0 && (
            <button type="button" className="wk-see-older" aria-expanded={older} onClick={() => setOlder((open) => !open)}>
              {older ? <DownOutlined className="ic" /> : <RightOutlined className="ic" />}
              {wikiEarlierChanges(earlier.length)}
            </button>
          )}
          {older && earlier.map((version) => <WikiSeeChangesVersion key={version.id} version={version} earlier />)}
        </>
      )}
    </div>
  );
}

function WikiSeeChangesVersion({ version, earlier = false }: { version: WikiDocSectionVersionView; earlier?: boolean }) {
  // When it was written, as the document page says when a section was: `Nov 6, 10:47`, in the reader's zone.
  const when = wikiMonthDayTime(version.at);
  return (
    <div className={`wk-see-v${earlier ? ' earlier' : ''}`} data-version={version.id}>
      <div className="wk-see-cause">
        {wikiSeeChangesCause(version)}
        {when ? ` · ${when}` : ''}
      </div>
      <WikiSentenceRows rows={version.rows} />
    </div>
  );
}

/** The rows a write changed: removed struck through, added shaded, in the comparison's order; the rest left out. */
export function WikiSentenceRows({ rows }: { rows: readonly WikiDocSentenceRow[] }) {
  const changed = rows.filter((row) => row.op !== 'same');
  if (changed.length === 0) return <div className="wk-see-none">{WIKI_SEE_CHANGES_SAME}</div>;
  return (
    <div className="wk-see-rows">
      {changed.map((row, index) => (
        <div key={index} className={row.op === 'added' ? 'wk-see-ins' : 'wk-see-del'} data-op={row.op}>
          {row.text}
        </div>
      ))}
    </div>
  );
}
