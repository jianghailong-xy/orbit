import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { buildCoordinatorDeliveryMessage } from './coordinator-judgment-opening';
import { WakeFact } from './coordinator-wake';
import { CoordinatorWakeService, WakeAuthorizer } from './coordinator-wake.service';
import { derivedUuid } from './project-dispatch-identity';

/**
 * One committed fact becomes one MESSAGE to the coordinator conversation that already exists.
 *
 * §0 — WHY THIS IS NOT `CoordinatorJudgmentService` WITH A DIFFERENT SESSION ID
 * ============================================================================
 * That unit opens a fresh session per fact, and its own §0 argues why: a judgment does not need
 * continuity, and paying for continuity costs judgment quality, replayability, bounded cost and
 * blast radius. Every word of that stands for a JUDGMENT.
 *
 * The fact this unit exists for is not one. `wake-disposition.ts` §2.1 sends `CRITERION_UNLANDED`
 * — a criterion whose work is finished and is on nobody's default branch — to a session, and what
 * it needs done is a MERGE: an irreversible action on one branch, performed once, by whoever is
 * already coordinating this project. Opening a conversation per such fact would mean two
 * coordinators racing for one branch, each with no idea the other exists; and the project already
 * has a row naming the conversation that is doing this work (`project.coordinator_session_id`).
 * So this fact is DELIVERED to that conversation rather than spent on a new one.
 *
 * `wakePlanned` is not this either. It creates a session too — it merely fixes the id first, so a
 * process that died between the insert and the bind can recover the same row. Nothing about it
 * writes to a session that already exists.
 *
 * §1 — WHAT A MESSAGE CAN AND CANNOT BE
 * =====================================
 * Three properties of the carrier, all measured rather than assumed, and each one bounds what this
 * unit may claim:
 *
 *   1. **A message is a notification, never an interrupt.** Claude does not steer mid-turn: a
 *      conversation that is running a turn sees this after that turn ends. So nothing here may be
 *      written as though it stops what the coordinator is doing, and the message says so.
 *   2. **Context is finite and shared.** One coordinator conversation measured on 2026-09-06 was
 *      365 turns and 481k of a 1000k window. Every message spends some of that window for every
 *      later turn, so only a fact with an action attached is worth one — which is why the rule that
 *      routes here (`wake-disposition.ts` §2.1) sends exactly one event kind and records the rest.
 *   3. **A message to a conversation nobody is watching is `HUMAN_INBOX` with extra steps.** This
 *      is the honest limit of the whole change: swapping the carrier does not make delivery
 *      reliable. What makes it reliable is that the fact is still in the ledger afterwards, and
 *      that a delivery which could not be made RELEASES the key so the fact comes round again.
 *
 * §2 — WHY DELIVERY DOES NOT REVIVE A CONVERSATION THAT ENDED
 * ===========================================================
 * `SessionsService.resume` writes to a live session and REVIVES a terminal one — correct for the
 * auto-retry sweep and for Run Now, both of which are handing a run its own work back. A
 * notification is not that. Resurrecting a conversation the person ended, to tell it about a merge
 * nobody is waiting for, is the §1.3 hole with a model turn charged to it.
 *
 * So the standing conversation's state is read first, and the line is drawn at ENDED — terminal,
 * cancelling, or in Trash — which is the same line `createTurn` itself refuses on. It is
 * deliberately NOT "live" in `SessionsService.LIVE`'s sense: enqueueing a turn onto a parked
 * conversation moves it to PENDING (`statusAfterTurnEnqueued` — a queued message needs a fresh
 * runner slot), so PENDING is the ordinary state of a coordinator that has JUST been told
 * something. Refusing that state would make the second fact about a project undeliverable until a
 * runner picked up the first, which is a rule about scheduling wearing the costume of a rule about
 * liveness.
 *
 * The read is not a second opinion about permission — `resume` remains the only authority on
 * whether the turn may be written, and every refusal it gives is caught below. It is this unit's
 * own precondition, and the only way to say "do not resurrect" to a method whose job is to do both.
 *
 * §2.1 — AND A CONVERSATION THAT HAS NOT READ THE LAST ONE IS REFUSED, BY `resume`
 * ===============================================================================
 * That leaves one state this unit does not decide and cannot avoid: PENDING, which is what
 * enqueueing a turn onto a parked conversation produces. It is neither live nor terminal, so
 * `resume` reaches its revive branch and refuses `NOT_TERMINAL` — a queued message is already
 * waiting for a runner slot, and appending a second behind it is not something that path does.
 *
 * Nothing here works around that. The refusal is translated below like any other, which means the
 * key goes back: a project whose coordinator has been told one thing and has not yet read it does
 * not lose the next fact, it re-derives it. That is a real bound on how fast facts can reach one
 * conversation, and it is the correct one to have — a coordinator that has not read the first
 * message is not a coordinator that will act on the second any sooner.
 *
 * §3 — A DELIVERY THAT CANNOT BE MADE GIVES THE KEY BACK, AND NEVER THROWS AT ITS PRODUCER
 * ========================================================================================
 * The project has no coordinator conversation yet, or it ended, or its workspace will not run one:
 * none of those is a judgment about the fact and none of them should be permanent. Each releases
 * the fact's idempotency key with a code naming which one it was, so the producer that re-derives
 * the same fact after the person reopens their coordinator delivers it then.
 *
 * And none of them escapes as an exception. The caller is a post-commit delivery pass hanging off
 * a task write: a throw there would report a failure of the write that already committed, over a
 * conversation that has nothing to do with it. A fault — anything that is not one of the ordinary
 * refusals below — is still re-raised, because a fault reported as a refusal is a fault nobody
 * looks at.
 */

/** The project records no standing coordinator conversation; nobody has opened one yet. */
export const DELIVERY_NO_COORDINATOR_SESSION = 'DELIVERY_NO_COORDINATOR_SESSION';

/**
 * There is a conversation of record and it will not take this message: ended, cancelling, in
 * Trash, deleted outright, still holding a message it has not read (§2.1), or refused by
 * `sessions.resume` for any other reason that is a state of the world rather than a fault.
 *
 * One code for all of them, for the reason `JUDGMENT_LANDING_UNAVAILABLE` is one code: what the
 * producer does about every one of them is identical — the key is back, re-derive the fact later —
 * and the conversation's own row is where a reader finds out which of them it was. It is a
 * different code from the one above because those two are NOT the same thing to do about: nobody
 * has opened a coordinator here, against the one that exists being busy or over.
 */
export const DELIVERY_COORDINATOR_SESSION_UNAVAILABLE = 'DELIVERY_COORDINATOR_SESSION_UNAVAILABLE';

/** The project went away between the claim and the delivery. The FK cascade is racing us; it wins. */
export const DELIVERY_PROJECT_GONE = 'DELIVERY_PROJECT_GONE';

export type CoordinatorDeliveryOutcome =
  /** This delivery handed the fact to the standing conversation. Exactly one delivery ever does. */
  | {
      outcome: 'DELIVERED';
      wakeId: string;
      idempotencyKey: string;
      /** The standing conversation. Never a session this call created — it creates none. */
      sessionId: string;
      /** The turn the message is, keyed by the fact so a re-send collapses onto it. */
      clientTurnId: string;
    }
  /** Somebody else holds the fact. `CoordinatorWakeService.claim`'s answer, passed through. */
  | { outcome: 'ALREADY_AWAKE'; idempotencyKey: string }
  /**
   * The wake was won and had already reached its terminal by the time this call bound it.
   *
   * No `sessionId`, for the reason `ALREADY_OPEN` carries none: reading the winner back would be
   * the unlocked read the compare-and-set exists to avoid.
   */
  | { outcome: 'ALREADY_DELIVERED'; wakeId: string; idempotencyKey: string }
  /** The key was given back. The same fact may be delivered again. */
  | { outcome: 'REFUSED'; wakeId: string; idempotencyKey: string; refusalCode: string };

/** What a delivered wake row records about the message it carried. */
export interface WakeDeliveryRecord {
  /** The `conversation_turn` this delivery wrote, by the key it wrote it under. */
  clientTurnId: string;
}

/**
 * The turn key one FACT's message is written under, derived and never minted.
 *
 * A random key per attempt would make "the same fact said this once" a property of the wake ledger
 * alone. Derived from the fact's own identity it is a property of the conversation's table too:
 * `(session_id, client_turn_id)` is unique, and `createTurn` replays a committed turn for a repeat
 * of the same payload rather than writing a second one. That closes the one window 0174's index
 * cannot — between the message being written and the wake row being bound.
 *
 * A uuid, because that is what every other writer of this column supplies and what its dto says it
 * is; namespaced, so it can never collide with a run's turn on the same conversation.
 */
export function coordinatorDeliveryTurnId(wakeIdempotencyKey: string): string {
  return derivedUuid(`coordinator-wake-delivery:v1:${wakeIdempotencyKey}`);
}

@Injectable()
export class CoordinatorDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wakes: CoordinatorWakeService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Deliver one committed fact to the project's standing coordinator conversation.
   *
   * The composition is the public surface for the reason `CoordinatorJudgmentService.wake` gives:
   * a caller handed the claim and the send separately could hold a won key and never spend it,
   * which is the one wedge the database's own rules cannot prevent.
   */
  async deliver(fact: WakeFact, authorize: WakeAuthorizer): Promise<CoordinatorDeliveryOutcome> {
    const claimed = await this.wakes.claim(fact, authorize);
    if (claimed.outcome !== 'WOKEN') return claimed;
    return this.send(fact, claimed.wakeId, claimed.idempotencyKey);
  }

  /**
   * Write the message, then bind the row — in that order, and the order is the house pattern.
   *
   * Binding first would name a turn before one existed, so a send that failed would leave a ledger
   * row claiming a delivery nobody could find. Sending first can in principle write the message and
   * lose the bind; that costs nothing here, because the turn's key is a function of the FACT, so
   * the delivery that wins writes the same turn rather than a second one.
   */
  private async send(
    fact: WakeFact,
    wakeId: string,
    idempotencyKey: string,
  ): Promise<CoordinatorDeliveryOutcome> {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { id: true, ownerId: true, title: true, coordinatorSessionId: true },
    });
    if (!project) return this.refuse(wakeId, idempotencyKey, DELIVERY_PROJECT_GONE);
    if (!project.coordinatorSessionId) {
      return this.refuse(wakeId, idempotencyKey, DELIVERY_NO_COORDINATOR_SESSION);
    }

    // §2. Not ended, which is the line, and it is read on the standing conversation itself rather
    // than derived from the project: the pointer outlives the conversation's usefulness, since the
    // row goes on naming it after it ends.
    const standing = await this.prisma.session.findFirst({
      where: { id: project.coordinatorSessionId, ownerId: project.ownerId, deletedAt: null },
      select: { id: true, status: true, cancelRequestedAt: true },
    });
    if (
      !standing
      || standing.cancelRequestedAt !== null
      || SessionsService.TERMINAL.includes(standing.status)
    ) {
      return this.refuse(wakeId, idempotencyKey, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
    }

    // The fact's own identity, spent as the turn's idempotency key. `createTurn` holds
    // `(session_id, client_turn_id)` unique and replays the committed turn for a repeat of the
    // same payload, so "the same fact does not say the same thing twice" is a database rule here
    // as well as in 0174's index — which matters for the one window 0174 cannot cover, between
    // this send and the bind below.
    const clientTurnId = coordinatorDeliveryTurnId(idempotencyKey);
    try {
      await this.sessions.resume(project.ownerId, standing.id, {
        clientTurnId,
        content: buildCoordinatorDeliveryMessage(fact, project.title),
      });
    } catch (e) {
      // §3. The key goes back BEFORE anything is decided about the error, so every path out of
      // here — translated or re-thrown — has already released it.
      await this.wakes.release(wakeId, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
      // The refusals `resume` gives for an ordinary state of the world rather than a fault: the
      // conversation is gone (Not Found), it ended or is being written right now (Conflict —
      // `SessionNotSendable` is one of these), its workspace is gone or disabled (Forbidden), or
      // it runs on no runner (Bad Request). Anything else is a fault and is left alone.
      if (
        e instanceof NotFoundException
        || e instanceof ConflictException
        || e instanceof ForbiddenException
        || e instanceof BadRequestException
      ) {
        return {
          outcome: 'REFUSED',
          wakeId,
          idempotencyKey,
          refusalCode: DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
        };
      }
      throw e;
    }

    // One statement: the row lock and the write, with the status this call read as the condition.
    // `updateMany` rather than `update`, because "no row matched" must be an answer rather than an
    // exception. `delivery` is written HERE and not at claim time — `detail` is written by the
    // INSERT that claims the key, which runs before authorization, so nothing that exists only
    // once a wake is permitted can go in it. What this delivery handed over is exactly that.
    const bound = await this.prisma.projectCoordinatorWake.updateMany({
      where: { id: wakeId, status: 'CLAIMED' },
      data: {
        status: 'DELIVERED',
        sessionId: standing.id,
        delivery: { clientTurnId } satisfies WakeDeliveryRecord,
      },
    });
    if (bound.count === 0) return { outcome: 'ALREADY_DELIVERED', wakeId, idempotencyKey };
    return { outcome: 'DELIVERED', wakeId, idempotencyKey, sessionId: standing.id, clientTurnId };
  }

  private async refuse(
    wakeId: string,
    idempotencyKey: string,
    refusalCode: string,
  ): Promise<CoordinatorDeliveryOutcome> {
    await this.wakes.release(wakeId, refusalCode);
    return { outcome: 'REFUSED', wakeId, idempotencyKey, refusalCode };
  }
}
