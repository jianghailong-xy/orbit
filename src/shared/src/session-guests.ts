/**
 * Session guests (docs/session-guests-design.md): the owner of a session invites other Orbit accounts by email to
 * reply in it, and each guest's messages are turns of the owner's own session, sent as external sender ORBIT_GUEST.
 */

import type { SessionPhase, SessionTurnOutcome, SessionWaitingOn } from './session-phase';
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
  /** The three-state field and the facts beside it (session-phase.ts, contracts/session-state.contract.json).
   *  Absent from an older control plane. */
  phase?: SessionPhase;
  released?: boolean;
  lastTurnOutcome?: SessionTurnOutcome | null;
  waitingOn?: SessionWaitingOn | null;
  endReason?: string | null;
  workFinished?: boolean;
  /** Runner-hosted jobs and shells still running, the other input of the Background mark (SessionBackgroundFields);
   *  absent from an older server. */
  runningBgCount?: number;
  addedAt: string;
  lastTurnAt: string | null;
}
