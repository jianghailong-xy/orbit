import { CaretDownOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useMatch } from 'react-router-dom';
import type { GuestSessionSummary } from '@orbit/shared';
import { listGuestSessions } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import { sessionStateWord } from '../lib/sessionState';
import { titleFirstLine } from '../lib/title';

export const guestSessionsQueryKey = ['guest-sessions'] as const;
/** How often Shared with me is read again: a session can be shared with you, or stop being, at any time. */
const SHARED_WITH_ME_POLL_MS = 60_000;

/**
 * Where a session shared with you opens: the same `/sessions/<id>` its owner opens, which draws the guest view for
 * you (board docs/mocks/share-links/11-guest-one-link, D8).
 */
export const guestSessionPath = (id: string) => `/sessions/${encodeId(id)}`;

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
 * a press opens it, and the row of the one open now is highlighted. Nothing of the owner's workspaces or projects is
 * listed. No group while there is none.
 */
export function SharedWithMeGroup({ onOpen }: { onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: guestSessionsQueryKey,
    queryFn: listGuestSessions,
    refetchInterval: SHARED_WITH_ME_POLL_MS,
  });
  const sessions = q.data?.sessions ?? [];
  const openId = routeId(useMatch('/sessions/:id')?.params.id ?? '');
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
          <GuestSessionRow
            key={s.id}
            session={s}
            active={openId != null && routeId(s.id) === openId}
            onOpen={() => onOpen(guestSessionPath(s.id))}
          />
        ))}
      </div>
    </>
  );
}

function GuestSessionRow({
  session: s,
  active,
  onOpen,
}: {
  session: GuestSessionSummary;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`tp-item tp-guest-session${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
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
