import { CaretDownOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { GuestSessionSummary } from '@orbit/shared';
import { listGuestSessions } from '../api';
import { encodeId } from '../lib/idCodec';
import { sessionStateWord } from '../lib/sessionState';
import { titleFirstLine } from '../lib/title';

export const guestSessionsQueryKey = ['guest-sessions'] as const;
/** How often Shared with me is read again: a session can be shared with you, or stop being, at any time. */
const SHARED_WITH_ME_POLL_MS = 60_000;

/** The guest page of a session shared with you (docs/session-guests-design.md §4). */
export const guestSessionPath = (id: string) => `/g/${encodeId(id)}`;

/** How long ago, in the list's shortest words: `2m`, `1h`, `2d`. */
function ago(at: string | null, now = Date.now()): string {
  if (!at) return '';
  const min = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return 'now';
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (24 * 60))}d`;
}

/**
 * Shared with me: the sidebar's last group, the sessions other people invited you to reply in (§4; board
 * docs/mocks/share-links/10-session-guests-3). Each row is the session's title, who shared it and how it stands;
 * a press opens its guest page. Nothing of the owner's workspaces or projects is listed. No group while there is none.
 */
export function SharedWithMeGroup({ onOpen }: { onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: guestSessionsQueryKey,
    meta: { entities: ['session'] },
    queryFn: listGuestSessions,
    refetchInterval: SHARED_WITH_ME_POLL_MS,
  });
  const sessions = q.data?.sessions ?? [];
  if (sessions.length === 0) return null;
  return (
    <>
      <div className="tp-divider" />
      <div className="tp-group tp-group-shared-with-me">
      <div className="tp-group-head" onClick={() => setOpen((o) => !o)}>
        <span className="tp-group-name">Shared with me</span>
        <span className="tp-count">{sessions.length}</span>
        <CaretDownOutlined className={`tp-caret ${open ? '' : 'collapsed'}`} />
      </div>
      {open &&
        sessions.map((s) => (
          <GuestSessionRow key={s.id} session={s} onOpen={() => onOpen(guestSessionPath(s.id))} />
        ))}
      </div>
    </>
  );
}

function GuestSessionRow({ session: s, onOpen }: { session: GuestSessionSummary; onOpen: () => void }) {
  return (
    <div
      className="tp-item tp-guest-session"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        onOpen();
      }}
      role="link"
      tabIndex={0}
    >
      <span className="tp-guest-session-top">
        <span className="tp-label">{titleFirstLine(s.title)}</span>
        <span className="tp-guest-session-time">{ago(s.lastTurnAt ?? s.addedAt)}</span>
      </span>
      <span className="tp-guest-session-sub">
        {s.ownerName} · {sessionStateWord(s)}
      </span>
    </div>
  );
}
