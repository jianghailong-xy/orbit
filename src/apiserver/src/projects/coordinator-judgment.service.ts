import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { SessionDispatchOrigin, SessionRunSource } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { buildJudgmentOpening, judgmentSessionTitle } from './coordinator-judgment-opening';
import { WakeFact } from './coordinator-wake';
import { CoordinatorWakeService, WakeAuthorizer } from './coordinator-wake.service';

/**
 * Unit T3: one committed fact becomes one judgment session, and then nothing.
 *
 * §0 — WHY ONE SESSION PER FACT, AND NOT ONE SESSION STEERED
 * ==========================================================
 * The version of this that was removed in 2026-08-24 did not fail because its loop was too eager.
 * It failed because ONE conversation was steered three hundred times: every turn looked busy, the
 * context filled with its own earlier reasoning, and it never crossed a single line in
 * `attempt-budget.ts` §0 — there was no line to cross, because a budget is spent per attempt and
 * the whole thing was one attempt that never ended.
 *
 * A project's state is in the database — task statuses, acceptance criteria, the ledger — and not
 * in a conversation's context. So a judgment does not need continuity, and paying for continuity
 * buys four specific losses: judgment quality decays with context noise, the decision cannot be
 * replayed, cost is unbounded, and one bad turn poisons every later one. Opening a session per
 * fact gives all four back. A session that ends is the budget.
 *
 * §1 — THIS IS NOT THE CONVERSATION A PERSON OPENS
 * ================================================
 * `POST /projects/:id/coordinator` (`ProjectsService.coordinator`, restored by 60dece5e) is a
 * person opening a long-lived conversation to drive a project by hand. Nothing here touches it:
 * this path never reads or writes `project.coordinator_session_id`, never rotates a generation,
 * never lands in a workspace of its own choosing. The two share the facts in the database and
 * share no context.
 *
 * What tells them apart in `session_list` is `dispatch_origin`: the person's conversation is
 * created by `sessions.create({ source: 'user' })` and takes the `USER` default, a judgment is
 * `PROJECT_COORDINATOR`. That enum member has existed since 0122 and has had no live writer since
 * the loop was removed — 0164 dropped the five guards over it and 0165 the three CHECKs, on the
 * stated grounds that "no new PROJECT_COORDINATOR session can be created". This is what creates
 * them again, and it is a deliberately smaller claim than the one those guards enforced: back then
 * the value meant "dispatched by the control loop, carrying a frozen policy snapshot and an
 * action". Here it means only "opened by a wake rather than by a person", which is exactly what a
 * caller trying to tell the two apart is asking.
 *
 * §2 — AT MOST ONE JUDGMENT SESSION PER WAKE, DECIDED BY THE DATABASE
 * ==================================================================
 * Not by "check whether one is running, then open one if not". An unlocked read used to exclude is
 * not safe — two deliveries both read "none running" and both open one — and it is the shape this
 * project's own instructions forbid. Three database facts make it impossible instead, and none of
 * them is a read:
 *
 *   1. 0173's partial unique index on `idempotency_key` picks ONE winner per fact, so only one
 *      delivery ever reaches `open` at all;
 *   2. the compare-and-set below (`WHERE id = ? AND status = 'CLAIMED'`) takes the row lock and
 *      lets exactly one writer move that wake to `SESSION_OPENED`, so even a caller that reached
 *      `open` twice with one wake binds once;
 *   3. `SESSION_OPENED` is INSIDE 0173's index (its predicate is `<> 'REFUSED'`), so the fact goes
 *      on holding its key afterwards and can never claim a second session.
 *
 * §3 — A WAKE THAT CANNOT OPEN GIVES THE KEY BACK
 * ===============================================
 * The half `project_action` got wrong, restated for this layer. A workspace that is disabled, a
 * runner that is unbound, a project with nowhere to be coordinated from: none of those is a
 * judgment about the fact, and none of them should be permanent. Each releases the key, so the
 * producer that re-derives the same fact after the workspace comes back wakes on it. The refusal
 * and its code stay on the row either way — "it silently did nothing" is not a state this ledger
 * can be in.
 */

/** No workspace to open in: the project records no coordination workspace at all. */
export const JUDGMENT_NO_LANDING = 'JUDGMENT_NO_LANDING';

/**
 * There is a workspace of record and it will not run a session right now — deleted, disabled, or
 * bound to no runner. `sessions.create` is the one authority on that question (the reason
 * `ProjectsService.coordinator` does not re-derive it either), so this code is the translation of
 * its refusal rather than a second opinion formed before calling it.
 */
export const JUDGMENT_LANDING_UNAVAILABLE = 'JUDGMENT_LANDING_UNAVAILABLE';

/** The project went away between the claim and the open. The FK cascade is racing us; it wins. */
export const JUDGMENT_PROJECT_GONE = 'JUDGMENT_PROJECT_GONE';

export type JudgmentOutcome =
  /** This delivery opened the one judgment session this fact gets. */
  | { outcome: 'OPENED'; wakeId: string; idempotencyKey: string; sessionId: string }
  /** Somebody else holds the fact. `CoordinatorWakeService.claim`'s answer, passed through. */
  | { outcome: 'ALREADY_AWAKE'; idempotencyKey: string }
  /**
   * The wake was won but had already bound a session by the time this call tried to.
   *
   * No `sessionId`, for the reason `ALREADY_AWAKE` carries no `wakeId`: reading the winner back
   * would be exactly the unlocked read the compare-and-set exists to avoid, and the caller that
   * lost has nothing to do with the session it lost to.
   */
  | { outcome: 'ALREADY_OPEN'; wakeId: string; idempotencyKey: string }
  /** The key was given back. The same fact may be delivered again. */
  | { outcome: 'REFUSED'; wakeId: string; idempotencyKey: string; refusalCode: string };

@Injectable()
export class CoordinatorJudgmentService {
  private readonly logger = new Logger(CoordinatorJudgmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wakes: CoordinatorWakeService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Deliver one committed fact and, if it is this delivery's to act on, open its judgment session.
   *
   * The composition is the public surface on purpose. A caller given `claim` and `open` separately
   * could hold a won claim and never open anything, which is the one way to wedge a fact that §2's
   * three database rules cannot prevent — the key would be held by a claim nobody is acting on.
   * Here the only way to win the key is to be inside the call that spends it.
   */
  async wake(fact: WakeFact, authorize: WakeAuthorizer): Promise<JudgmentOutcome> {
    const claimed = await this.wakes.claim(fact, authorize);
    if (claimed.outcome !== 'WOKEN') return claimed;
    return this.open(fact, claimed.wakeId, claimed.idempotencyKey);
  }

  /**
   * Open the session, then bind it — in that order, and the order is the house pattern.
   *
   * `ProjectsService.coordinator` creates its session and then compare-and-swaps the pointer,
   * discarding the session if it lost, and says why a lock across the create would be worse:
   * `sessions.create` is heavy, Prisma's interactive transactions time out at five seconds, and
   * holding a row lock across one trades a rare wasted session for a rarer and far more confusing
   * failure. The same trade is made here, and the wasted session is rarer still — §2's rule 1
   * means only one delivery of a fact ever gets this far, so the CAS below is the belt to that
   * braces rather than the everyday path.
   *
   * Binding first and creating second was the alternative, and it is worse in the direction that
   * matters: the wake would name a session id before any session existed, so a create that failed
   * would leave a ledger row pointing at nothing while still holding the key — the permanent wedge
   * §3 exists to rule out.
   */
  private async open(
    fact: WakeFact,
    wakeId: string,
    idempotencyKey: string,
  ): Promise<JudgmentOutcome> {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { id: true, ownerId: true, title: true, coordinatorWorkspaceId: true },
    });
    if (!project) return this.refuse(wakeId, idempotencyKey, JUDGMENT_PROJECT_GONE);

    // Where a judgment opens is not a choice this path makes: it is the workspace the project is
    // already coordinated in. `ProjectsService.coordinatorLanding` has a branch that PICKS one for
    // a project that has never had a coordinator (`busiestAssignee`), and that branch belongs to
    // the person pressing the button — a judgment session choosing its own landing is the kind of
    // self-directed step this whole rework is removing. A project with no landing yet has not had
    // its coordinator opened once, so the fact waits for the person who does that.
    if (!project.coordinatorWorkspaceId) {
      return this.refuse(wakeId, idempotencyKey, JUDGMENT_NO_LANDING);
    }

    let session: { id: string };
    try {
      session = await this.sessions.create(
        project.ownerId,
        {
          workspaceId: project.coordinatorWorkspaceId,
          title: judgmentSessionTitle(project.title),
          prompt: buildJudgmentOpening(fact, project.title),
        },
        {
          // §1. The only two columns that say this conversation was opened by a fact and not by a
          // person, and the pair 0122 always wrote together.
          dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
          runSource: SessionRunSource.PROJECT_COORDINATOR,
        },
      );
    } catch (e) {
      // §3. The key goes back BEFORE anything is decided about the error, so that every path out
      // of here — translated or re-thrown — has already released it.
      await this.wakes.release(wakeId, JUDGMENT_LANDING_UNAVAILABLE);
      // The two refusals `sessions.create` gives for an ordinary state of the world rather than a
      // fault: the workspace is gone or disabled (Forbidden), or it runs on no runner (BadRequest).
      // `ProjectsService.coordinator` translates exactly this pair for the same reason. Anything
      // else is a fault, and a fault reported as a refusal is a fault nobody looks at.
      if (e instanceof ForbiddenException || e instanceof BadRequestException) {
        return { outcome: 'REFUSED', wakeId, idempotencyKey, refusalCode: JUDGMENT_LANDING_UNAVAILABLE };
      }
      throw e;
    }

    // §2 rule 2. One statement: the row lock and the write, with the status this call read as the
    // condition. `updateMany` rather than `update`, because "no row matched" must be an answer
    // rather than an exception — losing is a legitimate outcome here.
    const bound = await this.prisma.projectCoordinatorWake.updateMany({
      where: { id: wakeId, status: 'CLAIMED' },
      data: { status: 'SESSION_OPENED', sessionId: session.id },
    });
    if (bound.count === 0) {
      // Somebody else bound this wake first. Discard ours before returning, for the reason
      // `ProjectsService.discardLoser` gives: a live session no ledger row points at is litter that
      // looks exactly like a real judgment. `remove` rather than `end` — it ends the session on its
      // way out, so this is strictly more cleanup, and it is restorable from Trash.
      await this.discard(project.ownerId, session.id);
      return { outcome: 'ALREADY_OPEN', wakeId, idempotencyKey };
    }
    return { outcome: 'OPENED', wakeId, idempotencyKey, sessionId: session.id };
  }

  private async refuse(
    wakeId: string,
    idempotencyKey: string,
    refusalCode: string,
  ): Promise<JudgmentOutcome> {
    await this.wakes.release(wakeId, refusalCode);
    return { outcome: 'REFUSED', wakeId, idempotencyKey, refusalCode };
  }

  /**
   * Get rid of a judgment session that lost the bind.
   *
   * Re-thrown rather than swallowed, exactly as `ProjectsService.discardLoser` is: the whole point
   * of discarding is that an unreferenced live session must not exist, so a caught-and-ignored
   * failure would report a tidy outcome in precisely the case where it did not hold. The id is
   * logged first, because at that point it is the only place the orphan is named.
   */
  private async discard(ownerId: string, sessionId: string): Promise<void> {
    try {
      await this.sessions.remove(ownerId, sessionId);
    } catch (e) {
      this.logger.error(
        `lost the bind on a judgment wake and could not discard session ${sessionId} — it may ` +
          'still be live and no wake points at it',
        e instanceof Error ? e.stack : String(e),
      );
      throw e;
    }
  }
}
