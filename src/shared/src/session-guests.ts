/**
 * Session guests (docs/session-guests-design.md): the owner of a session invites other Orbit accounts by email to
 * reply in it, and each guest's messages are turns of the owner's own session, sent as external sender ORBIT_GUEST.
 */

import type { SessionActivity } from './task-run-reason';

/** One person who can reply, as the owner's `GET /sessions/:id/guests` lists them. */
export interface SessionGuestPerson {
  userId: string;
  name: string;
  email: string;
  addedAt: string;
  /** The guest's messages to this session since midnight UTC. */
  messagesToday: number;
  /** Whether the guest has opened the session at least once. */
  opened: boolean;
  /** When the invitation email to this person for this session was sent; null while unsent, or never sent. */
  emailSentAt: string | null;
}

/**
 * Someone the owner has invited before, to any of their sessions, as `GET /sessions/:id/guests/suggestions` offers
 * them to the email field of People who can reply (board docs/mocks/share-links/14-guest-suggestions).
 */
export interface SessionGuestSuggestion {
  name: string;
  email: string;
  /** The owner's latest invitation of this person, to any session. */
  lastInvitedAt: string;
}

/**
 * What the guest page's root (`GET /guest-sessions/:id`) and its following read (`GET /guest-sessions/:id/events?after=`)
 * say of the owner's limits, for the guest composer's one read-only line (project 3504qZwKVUy7ccEQYo3HR, D3): the
 * session's permission mode, the same value the owner's session carries (`default`, `acceptEdits`, `auto`, `plan`,
 * ...), which the client says in words. Never the model, account, provider or cost. Absent from an older server.
 */
export interface GuestSessionLimits {
  permissionMode?: string | null;
}

/** One row of the guest's Shared with me (`GET /guest-sessions`). */
export interface GuestSessionSummary {
  id: string;
  title: string;
  ownerName: string;
  status: string;
  sessionState: string;
  lifecycleState: string;
  /** What the session is doing beyond its status (SessionActivity); absent from an older server. */
  activity?: SessionActivity | null;
  addedAt: string;
  lastTurnAt: string | null;
}
