import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { buildCoordinatorDeliveryMessage } from './coordinator-judgment-opening';
import { WakeFact, wakeIdempotencyKey } from './coordinator-wake';
import { CoordinatorWakeService, WakeAuthorizer } from './coordinator-wake.service';
import { derivedUuid } from './project-dispatch-identity';
import { readDerivedProjectDoneReading } from './project-done-derived';
import { SESSION_ENDING_SELECT, sessionHasEnded } from './project-open-item';

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

/**
 * What one MESSAGE to the standing conversation did, with nothing said about a ledger row.
 *
 * The refusal codes are the same three above and mean the same three things; what is missing is
 * the wake. `send` below turns this into a `CoordinatorDeliveryOutcome` by releasing or binding
 * the key it holds.
 */
type CoordinatorMessageOutcome =
  /** The message is on the conversation, under the key derived from the fact. */
  | { outcome: 'SENT'; sessionId: string; clientTurnId: string }
  /** Nothing was written. Which state of the world it was is the code. */
  | { outcome: 'REFUSED'; refusalCode: string };

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
   * Deliver one committed fact as a QUEUED turn on the standing conversation — contract §0.3 G6's
   * carrier, which `deliver` above predates.
   *
   * WHY A SECOND DOOR RATHER THAN A CHANGE TO THE FIRST
   * ===================================================
   * `deliver` goes through `resume`, and §2.1 says what that costs: a conversation that has been
   * told something and has not read it yet is PENDING, and `resume` refuses PENDING. For the facts
   * already on that door the refusal is survivable — they are re-derived by the next task write or
   * receipt in the project. For `DEPENDENT_READY` it is the whole incident: the receipt that makes a
   * dependent startable is the same receipt that has just told the coordinator about the landing,
   * so the conversation is PENDING at exactly the moment this fact arrives, and nothing re-derives
   * it afterwards. Changing `deliver` would move every fact already delivered through it onto a
   * different carrier; this door is used by the fact that needs it and leaves them where they are.
   *
   * WHAT G6 GIVES (contract §4.4 X-D3, X-D6)
   * =======================================
   *   * busy is not a refusal: `createTurn` with `NEXT_TURN` queues the message behind the turn
   *     that is running and behind any message not yet read, and `turnComplete` hands it to the
   *     engine when that turn ends. The conversation reads it on the committed fact of its own turn
   *     ending, which is what "delivered when the session is busy" means here;
   *   * a conversation that has ended is never revived: the check is `sessionHasEnded`, the same
   *     reading the exception items make, taken inside the transaction that writes the turn, so a
   *     conversation that ends between the read and the write refuses rather than being written to;
   *   * the ledger row is bound DELIVERED in that same transaction (`participateSendTransaction`),
   *     so a turn exists exactly when the wake says it was delivered.
   *
   * A delivery that cannot be made — no conversation, or one that has ended — releases the key with
   * the code that says which, exactly as `deliver` does. The fact is then the owner's in the only
   * sense the rows support: the task it names is on the project's Ready-to-run list, which is read
   * from the same predicate the fact was derived from, with the Run control beside it; and because
   * the key is back, the next time the same release is derived — a receipt reported again, the
   * same work promoted upstream — it reaches whichever conversation the project has by then.
   */
  async queue(fact: WakeFact, authorize: WakeAuthorizer): Promise<CoordinatorDeliveryOutcome> {
    const claimed = await this.wakes.claim(fact, authorize);
    if (claimed.outcome !== 'WOKEN') return claimed;
    return this.enqueue(fact, claimed.wakeId, claimed.idempotencyKey);
  }

  /** `queue`'s half after the claim: the turn and the bind, in one transaction. */
  private async enqueue(
    fact: WakeFact,
    wakeId: string,
    idempotencyKey: string,
  ): Promise<CoordinatorDeliveryOutcome> {
    const clientTurnId = coordinatorDeliveryTurnId(idempotencyKey);
    let sessionId: string;
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: fact.projectId },
        select: { ownerId: true, title: true, coordinatorSessionId: true },
      });
      if (!project) return this.refuse(wakeId, idempotencyKey, DELIVERY_PROJECT_GONE);
      if (!project.coordinatorSessionId) {
        return this.refuse(wakeId, idempotencyKey, DELIVERY_NO_COORDINATOR_SESSION);
      }
      sessionId = project.coordinatorSessionId;
      await this.sessions.createTurn(project.ownerId, sessionId, {
        clientTurnId,
        content: await this.render(fact, project),
        intent: 'NEXT_TURN',
      }, {
        participateSendTransaction: (tx) => bindQueuedDelivery(tx, wakeId, sessionId, clientTurnId),
      });
    } catch (e) {
      // The same four ordinary refusals `message` translates, `SessionNotSendable` among the
      // Conflicts: the conversation is gone, ended, its workspace cannot run it, or the key names a
      // turn written with another body. Anything else is a fault, re-raised with the key given back.
      if (
        e instanceof NotFoundException
        || e instanceof ConflictException
        || e instanceof ForbiddenException
        || e instanceof BadRequestException
      ) {
        return this.refuse(wakeId, idempotencyKey, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
      }
      await this.wakes.release(wakeId, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
      throw e;
    }
    // `createTurn` replays a turn already written under this key without running the hook, and the
    // only writer of that turn is a delivery of this same fact. Bound here too, so a replay cannot
    // leave the key CLAIMED for ever; a no-op when the hook already bound it.
    await this.prisma.projectCoordinatorWake.updateMany({
      where: { id: wakeId, status: 'CLAIMED' },
      data: { status: 'DELIVERED', sessionId, delivery: { clientTurnId } satisfies WakeDeliveryRecord },
    });
    return { outcome: 'DELIVERED', wakeId, idempotencyKey, sessionId, clientTurnId };
  }

  /**
   * Put one fact's message on the project's standing conversation, and touch no ledger row.
   *
   * Everything §2, §2.1 and §3 say about the carrier is decided here, because this is where the
   * conversation is read and written: a project with no coordinator, one whose coordinator ended
   * or is in Trash, and every ordinary refusal `resume` gives come back as a code rather than as
   * an exception. What is deliberately NOT here is the wake: `send` below holds a claimed key and
   * releases or binds it around this call.
   *
   * `send` is its one caller. Until 2026-09-10 the evidence ledger's door was a second, telling this
   * conversation about every completion evidence revision; that door now tells nobody, and this
   * stopped being public with it.
   */
  private async message(fact: WakeFact): Promise<CoordinatorMessageOutcome> {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { id: true, ownerId: true, title: true, coordinatorSessionId: true },
    });
    if (!project) return { outcome: 'REFUSED', refusalCode: DELIVERY_PROJECT_GONE };
    if (!project.coordinatorSessionId) {
      return { outcome: 'REFUSED', refusalCode: DELIVERY_NO_COORDINATOR_SESSION };
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
      return { outcome: 'REFUSED', refusalCode: DELIVERY_COORDINATOR_SESSION_UNAVAILABLE };
    }

    // The fact's own identity, spent as the turn's idempotency key. `createTurn` holds
    // `(session_id, client_turn_id)` unique and replays the committed turn for a repeat of the
    // same payload, so "the same fact does not say the same thing twice" is a database rule here
    // as well as in 0174's index — which matters for the one window 0174 cannot cover, between
    // this send and the bind in `send`.
    const clientTurnId = coordinatorDeliveryTurnId(wakeIdempotencyKey(fact));
    try {
      await this.sessions.resume(project.ownerId, standing.id, {
        clientTurnId,
        content: await this.render(fact, project),
      });
    } catch (e) {
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
        return { outcome: 'REFUSED', refusalCode: DELIVERY_COORDINATOR_SESSION_UNAVAILABLE };
      }
      throw e;
    }
    return { outcome: 'SENT', sessionId: standing.id, clientTurnId };
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
    let sent: CoordinatorMessageOutcome;
    try {
      sent = await this.message(fact);
    } catch (e) {
      // §3. The key goes back BEFORE anything is decided about the error, so every path out of
      // here — and this one only re-raises, because `message` has already translated every
      // refusal that is a state of the world — has already released it.
      await this.wakes.release(wakeId, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
      throw e;
    }
    if (sent.outcome === 'REFUSED') return this.refuse(wakeId, idempotencyKey, sent.refusalCode);
    const { sessionId, clientTurnId } = sent;

    // One statement: the row lock and the write, with the status this call read as the condition.
    // `updateMany` rather than `update`, because "no row matched" must be an answer rather than an
    // exception. `delivery` is written HERE and not at claim time — `detail` is written by the
    // INSERT that claims the key, which runs before authorization, so nothing that exists only
    // once a wake is permitted can go in it. What this delivery handed over is exactly that.
    const bound = await this.prisma.projectCoordinatorWake.updateMany({
      where: { id: wakeId, status: 'CLAIMED' },
      data: {
        status: 'DELIVERED',
        sessionId,
        delivery: { clientTurnId } satisfies WakeDeliveryRecord,
      },
    });
    if (bound.count === 0) return { outcome: 'ALREADY_DELIVERED', wakeId, idempotencyKey };
    return { outcome: 'DELIVERED', wakeId, idempotencyKey, sessionId, clientTurnId };
  }

  /**
   * The words one fact is delivered as, for both carriers.
   *
   * `PROJECT_ACCEPTANCE_LANDED` asks the owner to confirm the standard set only while there is a
   * confirmation to give, and says DONE only when the projection does — so the projection, and the
   * standing it is folded from, are read here: after the claim, as the message is written, off the
   * client this service already holds, and from the same batch `project-done-derived.ts` stores the
   * column from. Not by the producer: it changes what the message says and nothing about which fact
   * it is or whether it is delivered. Every other fact renders from itself.
   */
  private async render(
    fact: WakeFact,
    project: { ownerId: string; title: string },
  ): Promise<string> {
    const reading = fact.event === 'PROJECT_ACCEPTANCE_LANDED'
      ? await readDerivedProjectDoneReading(this.prisma, project.ownerId, fact.projectId)
      : null;
    return buildCoordinatorDeliveryMessage(fact, project.title, reading);
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

/**
 * `queue`'s ledger half, run inside the transaction that writes the turn (contract §0.3 G6).
 *
 * The conversation is re-read here, under the Session lock `createTurn` already holds, because the
 * read `queue` made before it is not one the turn can be written on: a conversation that ended in
 * between must refuse rather than be written to, and throwing here is what rolls the turn back.
 * `SessionNotSendable` is what `createTurn` itself throws for the narrower case, so the caller
 * translates both the same way.
 *
 * Then the wake is bound, with the status it was claimed in as the condition. It is the only
 * holder of this claim, so a miss would mean the row moved under a delivery that owns it — nothing
 * does that — and the turn is still the fact's own (its key is derived from the fact).
 */
async function bindQueuedDelivery(
  tx: Prisma.TransactionClient,
  wakeId: string,
  sessionId: string,
  clientTurnId: string,
): Promise<void> {
  const conversation = await tx.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: SESSION_ENDING_SELECT,
  });
  if (sessionHasEnded(conversation)) {
    throw new SessionNotSendable('the coordinator conversation has ended');
  }
  await tx.projectCoordinatorWake.updateMany({
    where: { id: wakeId, status: 'CLAIMED' },
    data: { status: 'DELIVERED', sessionId, delivery: { clientTurnId } satisfies WakeDeliveryRecord },
  });
}
