import { uuidToBase62 } from '@orbit/shared';

import { dispatchRefusalNextStep } from '../tasks/task-dispatch-refusal';
import { SettledCriterionReport, WakeFact } from './coordinator-wake';
import type { CriterionLandingReason } from './criterion-landing-reason';
import { criterionKeyOf } from './project-acceptance';
import type { DerivedProjectDoneReading } from './project-done-derived';

/**
 * What a coordinator is TOLD about a committed fact — in either of the two places one can be told.
 *
 * Two writers, one renderer. `buildJudgmentOpening` opens the one-shot conversation a fact wakes;
 * `buildCoordinatorDeliveryMessage` is the message the project's standing conversation is sent when
 * the fact is delivered to it instead (`coordinator-delivery.service.ts`). They differ in what the
 * reader already knows and in nothing else, so `describeWakeFact` renders the fact for both — one
 * event never gets two descriptions.
 *
 * WHY THIS IS NOT `coordinator-opening.ts`
 * ========================================
 * That one is the opening of a user-origin conversation, and it is written for a reader who will
 * answer it: with the project's Automatic switch off it says "推进靠的是跟人对话" and
 * "没有任何自动的环会替你决定什么时候动". Both are true there and false here. This session was
 * decided on by something automatic — a fact `CoordinatorWakeService` claimed — and there is
 * nobody on the other end of it. Reusing that opening would open every judgment by telling it two
 * things that are not so, which is the mistake 60dece5e removed from the OLD opening (it described
 * a §9.2 policy matrix no code enforced any more) and worth not making a second time.
 *
 * FACTS FIRST; ONE CLOSED PROTOCOL FOR PROJECT SETTLEMENT
 * ======================================================
 * Every opening says three things before it can prescribe anything:
 *
 *   1. what happened — the fact, rendered from `WakeFact` and from nothing else;
 *   2. where the full state is — the two reads, named with this project's id already in them;
 *   3. what is in reach — the tools, and the ones that are not.
 *
 * The generic events do not say what to conclude or do: the state this judgment is about is in the
 * database, not in this prompt. `PROJECT_TASKS_SETTLED` is the deliberate exception added by T7.
 * That event has a closed protocol whose ORDER is itself an invariant: code lands on main, and
 * only then is merge evidence recorded. Migration 0229 removed the acceptance judgment this used
 * to end in, so the protocol now ends at the observation rather than at a verdict.
 *
 * The one thing said about the session itself — that it is for this fact and lasts one turn — is a
 * property of the mechanism, not an instruction. It is here because a reader that assumed it could
 * ask a question and wait would be wrong about the world it is in.
 */

/** The title a judgment session is filed under, next to `coordinatorSessionTitle`'s `协调：`. */
export function judgmentSessionTitle(projectTitle: string): string {
  return `Judgment: ${projectTitle}`.slice(0, 80);
}

/**
 * The fact, in one sentence, per event.
 *
 * Rendered from the fact's own fields — `detail` is read here and only here, which is the reader
 * `coordinator-wake.ts` says it is for ("display and diagnosis, never an input to anything"). Ids
 * go out in Base62 because that is the spelling every tool this session can call takes back.
 *
 * The default arm is not dead code: `COORDINATOR_WAKE_EVENTS` is a closed set today, and a fifth
 * member added without a sentence here should open its session saying so rather than saying
 * nothing.
 */
export function describeWakeFact(fact: WakeFact): string {
  const detail = (fact.detail ?? {}) as Record<string, unknown>;
  switch (fact.event) {
    case 'ATTEMPT_ENDED_UNSETTLED':
      return (
        `A session of task ${uuidToBase62(fact.subjectId)} ended, and the task’s status at that moment was ` +
        `${String(detail.taskStatus ?? 'unknown')} — not a terminal state.`
      );
    case 'ATTEMPT_BUDGET_SPENT':
      return (
        `An attempt at task ${uuidToBase62(fact.subjectId)} used up the attempt budget for ` +
        `${String(detail.dimension ?? 'one of its dimensions')}.`
      );
    case 'PROJECT_TASKS_SETTLED':
      return (
        `All ${String(detail.taskCount ?? 'the')} tasks in this project have reached a terminal state `
        + '(DONE or CANCELLED).'
      );
    case 'PROJECT_ACCEPTANCE_LANDED':
      return (
        `All ${String(detail.taskCount ?? 'the')} tasks in this project have reached a terminal state, `
        + `and every one of the ${settledCriteriaOf(fact).length} acceptance criteria it states is satisfied `
        + 'and has a merge receipt proving its work is on the default branch.'
      );
    case 'CRITERION_READY':
      return (
        `All ${String(detail.taskCount ?? 'the')} tasks serving acceptance criterion ` +
        `${String(detail.criterionKey ?? fact.subjectId)} are DONE.`
      );
    case 'CRITERION_UNLANDED':
      return (
        `All ${String(detail.taskCount ?? 'the')} tasks serving acceptance criterion ` +
        `${String(detail.criterionKey ?? fact.subjectId)} are DONE, but no merge receipt proves that their ` +
        `work is already on the default branch (landing: ${String(detail.landing ?? 'unknown')}).`
      );
    case 'PROJECT_BLOCKER_RAISED': {
      const paths = Array.isArray(detail.paths)
        ? detail.paths.filter((path): path is string => typeof path === 'string')
        : [];
      const pathText = paths.length > 0 ? `, involving ${paths.join(', ')}` : '';
      return (
        `Task “${String(detail.taskTitle ?? uuidToBase62(fact.subjectId))}” raised `
        + `project blocker ${String(detail.blockerKind ?? 'UNKNOWN')}${pathText}; `
        + 'it needs the account owner’s ruling.'
      );
    }
    case 'COMPLETION_EVIDENCE_REVISED':
      // The title is there when the fact is delivered to be decided (`CompletionEvidenceProducer`);
      // a fact that was only recorded carries the id alone. A revision a confirmed move handed over
      // names the project it came from (`completionEvidenceRevisedFact`'s `movedFromProjectId`).
      return (
        (typeof detail.title === 'string'
          ? `Task “${detail.title}” (${uuidToBase62(fact.subjectId)})`
          : `Task ${uuidToBase62(fact.subjectId)}`)
        + (typeof detail.movedFromProjectId === 'string'
          ? ` moved from project ${uuidToBase62(detail.movedFromProjectId)} into this project, confirmed by the `
            + `account owner, carrying revision ${String(detail.evidenceRevision ?? 'unknown')} of its completion `
            + 'evidence, not yet decided: this revision is now this project’s to decide, and the original project '
            + 'can no longer decide it.'
          : ` submitted revision ${String(detail.evidenceRevision ?? 'unknown')} of its completion evidence.`)
      );
    case 'COMPLETION_ACK_STALE':
      {
        const binding = detail.binding && typeof detail.binding === 'object'
          && !Array.isArray(detail.binding)
          ? detail.binding as Record<string, unknown>
          : {};
        const structuredReason = detail.reason && typeof detail.reason === 'object'
          && !Array.isArray(detail.reason)
          ? detail.reason as Record<string, unknown>
          : null;
        const reason = typeof detail.reason === 'string'
          ? detail.reason
          : String(structuredReason?.message ?? 'completion ACK stale');
      return (
        `The completion result of task ${uuidToBase62(fact.subjectId)} is persisted, but the control plane `
        + `still has not acknowledged turn ${String(binding.turnId ?? detail.turnId ?? 'unknown')}; canonical `
        + `obligation ${String(detail.obligationId ?? 'unknown')} / revision `
        + `${String(detail.obligationRevision ?? detail.bindingDigest ?? 'unknown')} `
        + `is the project coordinator’s responsibility, and the reason is ${reason}.`
      );
      }
    case 'CRITERIA_DECISION_PENDING':
      return (
        'This project received an edit that would loosen its acceptance criteria. It did not take effect — '
        + 'not one word of the criteria on record changed — but was held as a pending proposal '
        + `(proposal ${String(detail.intentId ?? fact.subjectId)}, `
        + `content digest ${String(detail.actionDigest ?? 'unknown').slice(0, 16)}…) for the account owner `
        + 'to decide.'
      );
    case 'TASK_DISPATCH_REFUSED': {
      const base = typeof detail.baseSha === 'string' ? detail.baseSha : null;
      const missing = Array.isArray(detail.missing)
        ? (detail.missing as Array<{ sha?: unknown; taskId?: unknown }>)
        : [];
      const named = missing.map((commit) => (
        typeof commit.taskId === 'string'
          ? `${String(commit.sha).slice(0, 10)}, which prerequisite ${uuidToBase62(commit.taskId)} landed`
          : `commit ${String(commit.sha).slice(0, 10)}`
      ));
      return (
        `A start of task ${uuidToBase62(fact.subjectId)} “${String(detail.taskTitle ?? '')}” was refused by `
        + `the runner before it got going: ${String(detail.code ?? 'unknown')}.`
        + (base ? ` It was pinned to ${base.slice(0, 10)}` : '')
        + (base && named.length > 0 ? `, a commit that does not contain ${named.join('; ')}` : '')
        + (base ? '.' : '')
        + ' The start did not become a run: no engine was started, and the task’s status was not changed.'
      );
    }
    case 'DEPENDENT_READY':
      return (
        `Task “${String(detail.title ?? '')}” (${uuidToBase62(fact.subjectId)}) can start now: `
        + 'its prerequisites are all done and landed on this project’s integration line (or never had code '
        + 'to land). But it has autoRunWhenReady=false, so the platform will not start it by itself — until '
        + 'somebody starts it, it stays where it is.'
      );
    case 'PROJECT_SETTLED_UNMERGED': {
      const commits = unmergedCommitsOf(fact);
      const short = commits.map((sha) => sha.slice(0, 10));
      return (
        `This project has settled (DONE), but ${String(detail.taskCount ?? 'some')} pieces of work on its `
        + 'integration line have not been merged back into the default branch: '
        + `${short.length > 0 ? short.join(', ') : '(the commit list is below)'}. `
        + 'The landing jobs these commits belong to had reached a terminal state before the session wrote its '
        + 'last commit, so no promotion candidate ever named them — and after settlement no write will come '
        + 'along to rediscover them.'
      );
    }
    default:
      return `${fact.event} happened; its subject is ${fact.subjectType} ${fact.subjectId}.`;
  }
}

/** The commits a `PROJECT_SETTLED_UNMERGED` fact names, in the order its `detail` carries them. */
function unmergedCommitsOf(fact: WakeFact): string[] {
  const detail = (fact.detail ?? {}) as Record<string, unknown>;
  return Array.isArray(detail.commits) ? detail.commits.map((sha) => String(sha)) : [];
}

/**
 * T7's settlement-only action protocol.
 *
 * It is conditional rather than part of every judgment opening: an attempt-budget wake has no
 * reason to look at the target branch, while a project-settled wake exists specifically because
 * the old system stopped after the last task and never looked again.
 *
 * Migration 0229 removed the project acceptance judgment, so this protocol no longer ends in a
 * verdict. It ends where the evidence ends: has the work actually landed on main, and is that
 * recorded. Whether the project's stated criteria HOLD is a question nothing in Orbit answers now,
 * and the prompt says so rather than sending a session looking for a tool that is not there.
 *
 * It no longer tells the session to file a "merge into main" task (project closing, D5). On
 * 2026-10-01 it did, in the gap between the work landing on the project branch and that branch
 * reaching main, and the task it filed was hung on a criterion that was already met. Getting work
 * into main is the platform's landing jobs and the standing coordinator's, such a task serves no
 * criterion, and a judgment may only open work that names one — so it opens none. A settled
 * project's judgment is not even opened while a landing is in flight
 * (`project-tasks-settled.producer.ts` §4), and the server refuses its `task_create` if one starts
 * after it was (`TASK_LANDING_IN_FLIGHT`).
 */
export function settledAcceptanceProtocol(projectId: string): string {
  return (
    '\n\nThis PROJECT_TASKS_SETTLED fact calls for checking the evidence on main. Act in the order below; '
    + 'the order is a hard constraint, not advice:\n'
    + `1. First read this project’s stated acceptance criteria with project_get (projectId: ${projectId}), `
    + 'and the landingReason of each criterion in derivedDone.\n'
    + '2. Confirm that the implementation has really landed on main, and that the behaviour on main satisfies '
    + 'what is being accepted. A task marked DONE only says that some work branch is finished; it does not '
    + 'prove that main contains it. While the work is not on main yet, first see whether the platform is '
    + 'landing it: landingReason is IN_FLIGHT, or the project has a '
    + 'LAND_TASK, CHECK_PROMOTION or LAND_PROMOTION queued or running — then open nothing and end this turn; '
    + 'the platform derives the landing again once the job ends (until then the server also refuses your task_create: '
    + 'TASK_LANDING_IN_FLIGHT).\n'
    + '3. Open no “merge into main” task: getting work into main is for the platform’s landing jobs and the '
    + 'project’s coordinator session. Such a task serves no acceptance criterion and may not carry a '
    + 'criterionKey, while every task a judgment session opens must carry one — so open none of them. '
    + 'For work that is not in flight and really is not on main (landingReason ON_PROJECT_BRANCH, NO_RECEIPT, '
    + 'NOTHING_TO_LAND or CODELESS), write what you checked, criterion by criterion, in a task_comment on the '
    + 'tasks concerned to escalate it to a person, then end this turn. '
    + 'Only when an acceptance criterion really still lacks work — not a merge — open an ordinary task with '
    + 'task_create, carrying the criterionKey it serves.\n'
    + '4. When you have verified that the work is merged into main, the evidence must come in this order: '
    + 'merge into main → record main’s current content as evidence with project_merge_evidence.\n'
    + '5. Stop there. **Nothing in Orbit judges these acceptance criteria**: 0229 removed the project acceptance '
    + 'judgment, and its runs, per-criterion verdicts, conclusion events and DONE gate no longer exist. Write '
    + 'what you checked, criterion by criterion, and the evidence in a task_comment for the account owner, and '
    + 'do not look for a tool that submits a verdict — there is none.\n'
    + '6. You cannot change the acceptance criteria: the ruler belongs to the account owner’s channel. You '
    + 'cannot write status with project_update either; the server refuses the whole request with '
    + 'PROJECT_STATUS_NOT_SESSION_WRITABLE — whether it is written is the account owner’s decision, and you '
    + 'hand in the evidence.\n\n'
    + 'The order once more: a landing in flight ends this turn → open no “merge into main” task → '
    + 'merge into main → project_merge_evidence → hand in the evidence, criterion by criterion, in a task_comment.'
  );
}

/**
 * The message a judgment session opens on.
 *
 * `title` and the fact are the ONLY project state in here. Everything else about the project —
 * its goal, its acceptance criteria, its instructions, where each task stands — is a read this
 * session makes for itself, and the prompt says which read. Copying any of it in would freeze it
 * at the moment the fact was claimed, which is before this session runs.
 */
export function buildJudgmentOpening(fact: WakeFact, projectTitle: string): string {
  const projectId = uuidToBase62(fact.projectId);
  return (
    `You are a one-off judgment session for project “${projectTitle}” (id: ${projectId}).\n\n`
    + `What happened: ${describeWakeFact(fact)}\n\n`
    + 'This session was opened for that one fact above, and it has only this one turn: it does not carry on '
    + 'from the context of an earlier judgment, and nobody will send it further messages. '
    + 'The project’s state is in the database, not in this conversation — apart from the fact above, this '
    + 'opening message carries none of the project’s state.\n\n'
    + `Where to read the full state: project_get (projectId: ${projectId}) gives this project’s goal, `
    + 'acceptance criteria, instructions and status; '
    + `task_list (projectId: ${projectId}) gives each of its tasks’ status, acceptance criteria and `
    + 'dependencies; task_get gives one task’s full description and comment history.\n\n'
    + 'The tools in reach: to read — project_get, task_list, task_get, session_list, session_get; '
    + 'to write — task_create, task_update, task_comment, task_start, project_update, project_merge_evidence.\n\n'
    + 'Writing has three boundaries, and the server refuses what crosses them (they are not advice): '
    + '① an ordinary new task must say with criterionKey which acceptance criterion it serves (the key of each '
    + 'criterion in project_get), and is held to this project’s budget of how many tasks may be opened a day; '
    + 'only when the server has bound this session to an ACTIVE canonical remediation obligation can that '
    + 'revision stand as an orthogonal scope reason that does not fake a criterionKey, and it then runs under '
    + 'a capacity limit of its own; '
    + '② you cannot change the acceptance criteria — the ruler belongs to the account owner’s channel; '
    + '③ 0229 removed the project acceptance judgment: nothing judges these criteria, and no tool can submit '
    + 'a verdict. You cannot write status with project_update either: a request that carries a session and '
    + 'writes that field is refused whole (PROJECT_STATUS_NOT_SESSION_WRITABLE); DONE is the account owner’s '
    + 'decision, and you hand in the evidence. '
    + 'These three are judgment-role separation and action-specific traceability, not a cryptographic proof '
    + 'of human presence; write what you found and what is still missing in a task_comment, and the account '
    + 'owner will read it.\n\n'
    + 'Do not go looking for tools you were not given: listing or deleting projects and directing a runner '
    + 'directly are not in your hands.'
    + (fact.event === 'PROJECT_TASKS_SETTLED' ? settledAcceptanceProtocol(projectId) : '')
    + '\n\n'
    + 'The same project also has a coordinator session that a person opened, which stays open and is driven '
    + 'by a person. It reads the same facts in the database as this judgment does, but shares no context with '
    + 'it; this judgment does not touch it, and it does not touch this judgment.'
  );
}

/** The roster the two project-scoped facts carry, read out of `detail` and trusted for nothing else. */
function settledCriteriaOf(fact: WakeFact): SettledCriterionReport[] {
  const criteria = (fact.detail ?? {}).criteria;
  return Array.isArray(criteria) ? criteria as SettledCriterionReport[] : [];
}

/**
 * One line per criterion the projection is holding back: the clauses it trips, then the
 * satisfaction lane's unmet codes, named by the words the roster carries for it when it has them.
 */
function renderWithheldCriteria(fact: WakeFact, reading: DerivedProjectDoneReading): string {
  const texts = new Map(settledCriteriaOf(fact).map((criterion) => [criterion.key, criterion.text]));
  const unmet = new Map(reading.satisfaction.map((row) => [
    row.definitionId, row.unmet.map((reason) => reason.clause),
  ]));
  return reading.derived.criteria
    .filter((criterion) => criterion.withheld.length > 0)
    .map((criterion) => {
      const key = criterionKeyOf(criterion.definitionId);
      const text = texts.get(key);
      const codes = unmet.get(criterion.definitionId) ?? [];
      return (
        `- ${text ? `“${text}” (key ${key})` : `key ${key}`}: ${criterion.withheld.join(', ')}`
        + `; unmet: ${codes.length > 0 ? codes.join(', ') : 'none'}`
      );
    })
    .join('\n');
}

/** One line per criterion, then one per criterion for the work that served it. */
function renderSettledCriteria(criteria: readonly SettledCriterionReport[]): string {
  return criteria
    .map((criterion, index) => {
      const serving = criterion.serving
        .map((task) => `${task.title} (${uuidToBase62(task.taskId)}, ${task.status})`)
        .join(', ');
      return (
        `${index + 1}. ${criterion.text}\n`
        + `   Satisfied: ${criterion.satisfied ? 'yes' : 'no'}; landing: ${criterion.landing}; `
        + `tasks serving it: ${serving || 'none'}`
      );
    })
    .join('\n');
}

/**
 * The message the project's STANDING coordinator conversation is sent.
 *
 * WHY THIS IS NOT `buildJudgmentOpening`
 * ======================================
 * That one opens a conversation, and everything it says is calibrated for a reader with no
 * context: who it is, what it may not do, where every read lives, that nobody will answer it. This
 * reader has all of that already — it is the conversation a person opened to drive this project,
 * it has been reading these same tables for however long it has been running, and it was told the
 * rules on its own first turn. Repeating them would spend the one resource this carrier is chosen
 * to save.
 *
 * WHAT IT SAYS INSTEAD, AND WHY EACH LINE EARNS ITS PLACE
 * ======================================================
 * A coordinator conversation measured on 2026-09-06 was 365 turns and 481k of a 1000k context
 * window, so a message here is charged to every turn that comes after it, for the rest of that
 * conversation's life. Four lines survive that test:
 *
 *   1. the fact, rendered by `describeWakeFact` and from nothing else — the same renderer the
 *      judgment opening uses, so one event never gets two descriptions;
 *   2. the merge order, which is a hard constraint rather than advice and is the whole reason this
 *      fact is worth interrupting anybody about. It is `settledAcceptanceProtocol`'s order, said in
 *      one line rather than five: the reader already knows the tools;
 *   3. where to read the rest, because nothing else about the project is copied in here — the
 *      state is in the database, and this message is not a snapshot of it;
 *   4. that this is a NOTIFICATION. Claude does not steer mid-turn, so a conversation that was
 *      running when this arrived reads it afterwards, by which time its own reads are newer than
 *      anything this message could have carried. A reader that assumed otherwise would act on a
 *      world that has moved.
 *
 * AND WHY THE SECOND LINE IS NOT THE SAME FOR EVERY FACT
 * ======================================================
 * Lines 1, 3 and 4 are properties of the carrier and are the same for every fact delivered here.
 * Line 2 is not: it is the ACTION, and the merge order above is the action `CRITERION_UNLANDED`
 * calls for. The one other fact delivered here calls for a different one — and so does
 * `TASK_DISPATCH_REFUSED`, whose action is the refusal's own next step, the sentence the task's
 * comment gives (`dispatchRefusalNextStep`), so the two cannot advise differently.
 *
 * `DEPENDENT_READY`'s action is a decision rather than an order: whether to `task_start` a task
 * that can now start and will not start by itself. The line names the task and the two calls, and
 * says the one thing the reader cannot find out for itself — that nobody else is going to start
 * it — without saying what to conclude.
 *
 * AND WHY THAT ONE CARRIES A SNAPSHOT THE MERGE CARD REFUSES TO
 * =============================================================
 * `PROJECT_ACCEPTANCE_LANDED` — every task terminal and every stated criterion satisfied AND on
 * the default branch — is the one message here that copies project state into itself: every
 * criterion's words, its two dimensions, and the work that served it. Line 3's rule is not being
 * broken so much as met head on — the question this card asks is "do THESE N conditions, together,
 * express the goal", and a question about a set that does not carry the set is one its reader
 * cannot answer without going to fetch what it is being asked about. So the roster is in the card
 * and the card says out loud
 * that it is the snapshot at the moment the fact became true; everything else is still a read.
 *
 * What it must NOT do is answer. `CONFIRM_ACCEPTANCE_CRITERIA` is HUMAN_ONLY
 * (`coordinator-authority.ts`), so the action line here is to put the list in front of the account
 * owner rather than to conclude anything from it — and in particular not to write `project.status`,
 * which this card cannot write and nobody writes by hand any more. r2's `refuseProjectStatusWrite`
 * refuses the whole request when it carries an acting session, which every delivery of this card
 * does; and `project-done-derived.ts` projects `DONE` from criteria that are satisfied and landed
 * onto the owner's confirmation of the standard set as it stands. So the line about `status` names
 * the refusal and the projection rather than an absence of a guard: a reader told the field is
 * merely unauthorized spends a turn on a 403, and one told a person writes it goes looking for a
 * writer that does not exist.
 *
 * AND WHEN THE OWNER HAS ALREADY CONFIRMED, THERE IS NOTHING TO ASK
 * ================================================================
 * The confirmation can be on record, naming the version that stands, before the last receipt
 * lands. Then that receipt is the last input the projection needed: the project goes DONE on the
 * same edge that sends this message, and no client draws a card, because
 * `settlementHeldOnConfirmation` holds one only for an OPEN project whose standing can still be
 * answered. On 2026-09-25 (project 34JNIW4b31ujSVqEG784v) the message asked anyway, and a
 * coordinator doing what it said would have sent the owner looking for a card that was not there.
 *
 * So `reading` — the projection and the standing it was folded from, read by the delivery as it
 * writes these words — decides the text, and a confirmation is not taken for DONE. The fact is
 * derived from the serving tasks' STATUSES; the projection also asks whether each settled by its
 * own declared criterion, on the revision of the criterion that stands, and by a session that did
 * not write that criterion. So:
 *
 *   * DONE — says when the owner confirmed and that nothing is left to do, and carries no roster:
 *     the roster is in the card for the question, and there is no question;
 *   * CONFIRMED and still held back — says the confirmation is not what is missing, names what is
 *     (`withheld`, and each held criterion's clauses and unmet codes), and where to read the rest.
 *     It says neither DONE, which it is not, nor "confirm", which is done;
 *   * not confirmed, or confirmed about criteria that have since been edited — reads exactly as it
 *     always has.
 *
 * WHAT IS NOT DELIVERED HERE ANY MORE
 * ===================================
 * Until 2026-09-10 two more facts had a branch here: `COMPLETION_EVIDENCE_REVISED`, whose message
 * told the turn to ask the account owner through `AskUserQuestion`, and
 * `CRITERIA_DECISION_PENDING`, whose message relayed a held loosening's diff. Both were treated as
 * questions only the account owner may answer, so the turn that carried them could only pass them
 * on. Both became cards the clients draw from the pending reads, with buttons that reach the
 * decision doors directly. The held loosening is still delivered to nobody.
 *
 * AND WHAT CAME BACK, AS SOMETHING ELSE (2026-09-29)
 * ==================================================
 * `COMPLETION_EVIDENCE_REVISED` has a branch again, in an Automatic project only, and it is not a
 * relay: deciding evidence is COORDINATOR_BOUNDED (`coordinator-authority.ts`), so the message
 * asks this conversation to read the evidence and decide it itself — CONFIRM, or SEND_BACK with a
 * note saying what the next revision must show — and says the one thing it cannot see from where
 * it sits: that the owner's card is held back only for the project's `exceptionEscalationSeconds`,
 * after which the owner is asked. The criterion the evidence quotes is copied in, as its own
 * words: it is the standard the decision binds to, and the reader has no other place to find the
 * version this revision was measured against.
 *
 * AND A PROJECT THAT LOOKS FINISHED (2026-10-01)
 * ==============================================
 * `PROJECT_TASKS_SETTLED` is delivered here too, in one case only: every criterion met, nothing
 * running, open or landing, and the projection still withholding DONE (`project-looks-finished.ts`).
 * It is the one other message that copies project state in — each criterion Orbit cannot prove, by
 * its words and its landing reason, and the projection's counts — for the card's reason: what it
 * asks is a choice about those criteria. The choice is the coordinator's to make and the record is
 * the owner's: request done (`project_request_done`) or go and do the work, and if neither, the owner
 * is asked once the project's `exceptionEscalationSeconds` have run out (`buildLooksFinishedMessage`).
 */
export function buildCoordinatorDeliveryMessage(
  fact: WakeFact,
  projectTitle: string,
  /** The projection and the standing it was folded from. Only `PROJECT_ACCEPTANCE_LANDED` and
   *  `PROJECT_TASKS_SETTLED` read it, and absent reads as not confirmed. */
  reading?: DerivedProjectDoneReading | null,
  /** The project's `exceptionEscalationSeconds`, which `PROJECT_TASKS_SETTLED` quotes. */
  options: { escalationSeconds?: number } = {},
): string {
  const projectId = uuidToBase62(fact.projectId);
  if (fact.event === 'PROJECT_TASKS_SETTLED' && reading) {
    return buildLooksFinishedMessage(fact, projectTitle, reading, options.escalationSeconds);
  }
  if (fact.event === 'PROJECT_ACCEPTANCE_LANDED') {
    const standing = reading?.standing;
    const confirmedAt = standing?.confirmed ? standing.confirmation?.confirmedAt : undefined;
    if (reading && confirmedAt && !reading.derived.done) {
      const held = renderWithheldCriteria(fact, reading);
      return (
        `From Orbit · project “${projectTitle}”: its acceptance criteria have all landed and this version is `
        + 'confirmed, but the project has not been projected DONE\n\n'
        + `${describeWakeFact(fact)}\n\n`
        + 'The standard set that stands now is the very version the account owner confirmed at '
        + `${confirmedAt.toISOString()} `
        + '(CONFIRM_ACCEPTANCE_CRITERIA): no confirmation is missing, there is nothing here to confirm, and no '
        + 'confirmation card will appear in this conversation.\n\n'
        + 'But the project has not been projected DONE; what holds it back is '
        + `${reading.derived.withheld.join(', ')}. `
        + 'The “every one … is satisfied” above looks only at the serving tasks’ statuses; the projection also '
        + 'asks whether each task counts as finished by the completion criterion it declared itself, whether '
        + 'what it declared is the current revision of this criterion, and whether the session that wrote this '
        + 'criterion is also producing its evidence.'
        + (held ? ` Criteria held back:\n${held}` : '')
        + '\n\n'
        + 'What is still missing, and which task it is stuck on, read for yourself: '
        + `project_get (projectId: ${projectId}) returns derivedDone, which gives withheld and each `
        + 'criterion’s answer, and unmet on each acceptance criterion gives each unmet code and the task '
        + 'holding it up; '
        + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
        + 'DONE is not a column anybody writes: once what is missing is supplied, the server projects it by '
        + 'itself. You cannot write status with project_update either: a request that carries a session and '
        + 'writes that field is refused whole (PROJECT_STATUS_NOT_SESSION_WRITABLE).\n\n'
        + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
        + 'you are reading it only after that turn ended, so go by the state you have just read from the '
        + 'database yourself.'
      );
    }
    // Confirmed, and the projection agrees: DONE.
    if (confirmedAt) {
      return (
        `From Orbit · project “${projectTitle}”: its acceptance criteria are all satisfied and landed, and it `
        + 'is recorded as DONE on the account owner’s confirmation\n\n'
        + `${describeWakeFact(fact)}\n\n`
        + 'The standard set that stands now is the very version the account owner confirmed at '
        + `${confirmedAt.toISOString()} `
        + '(CONFIRM_ACCEPTANCE_CRITERIA). The project is recorded as DONE on that confirmation, and no action is '
        + 'needed: there is nothing here to confirm, and no confirmation card will appear in this conversation — '
        + 'a confirmation card is drawn only for a version that has not been confirmed yet.\n\n'
        + 'DONE is not a column anybody writes: every criterion satisfied and LANDED, plus the account owner’s '
        + 'confirmation of this version of the standard set, and the server projects it by itself. '
        + 'You cannot write status with project_update either: a request that carries a session and writes that '
        + 'field is refused whole (PROJECT_STATUS_NOT_SESSION_WRITABLE).\n\n'
        + 'Read the full state yourself; apart from the fact above and the time of that confirmation, this '
        + 'message carries none of the project’s state: '
        + `project_get (projectId: ${projectId}) reads the goal, the acceptance criteria and status, and `
        + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
        + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
        + 'you are reading it only after that turn ended, so go by the state you have just read from the '
        + 'database yourself.'
      );
    }
    const criteria = settledCriteriaOf(fact);
    return (
      `From Orbit · project “${projectTitle}”: its acceptance criteria are all satisfied and landed — please `
      + 'confirm they express the goal you want\n\n'
      + `${describeWakeFact(fact)}\n\n`
      + `These ${criteria.length} criteria are each satisfied, with a merge receipt proving the work is on the `
      + 'default branch:\n'
      + `${renderSettledCriteria(criteria)}\n\n`
      + 'The question to answer is not “are these criteria met” — the list above already answers that. It is '
      + `the one CONFIRM_ACCEPTANCE_CRITERIA asks: taken together, do these ${criteria.length} express the goal `
      + 'that was wanted in the first place?\n\n'
      + 'That one you cannot answer; it is HUMAN_ONLY: confirmation goes only through the account owner’s '
      + 'authenticated channel, and the server refuses any call that carries an acting session. Orbit draws the '
      + 'confirmation card straight into this conversation — the same card on the web, iOS and macOS — where '
      + 'this list can be expanded and read, and its button carries the account owner’s own credential straight '
      + 'to the confirmation door, not through you. '
      + 'What you do is hand the list above to the account owner and ask the account owner to confirm on the '
      + 'confirmation card in this conversation; the confirmation binds the current version of the criteria, '
      + 'and once any criterion is changed after that, the confirmation stops counting by itself.\n\n'
      + 'You cannot write status with project_update either: a request that carries a session and writes that '
      + 'field is refused whole (PROJECT_STATUS_NOT_SESSION_WRITABLE). DONE is not a column anybody writes '
      + 'either — every criterion above satisfied and LANDED, plus the account owner’s confirmation of this '
      + 'version of the standard set, and the server projects it by itself.\n\n'
      + 'Read the full state yourself; the list above is a snapshot from the moment the fact became true: '
      + `project_get (projectId: ${projectId}) reads the goal and acceptance criteria, and `
      + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
      + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
      + 'you are reading it only after that turn ended, so go by the state you have just read from the '
      + 'database yourself.'
    );
  }
  if (fact.event === 'TASK_DISPATCH_REFUSED') {
    const detail = (fact.detail ?? {}) as { fixAction?: string; ref?: string | null };
    const taskId = uuidToBase62(fact.subjectId);
    return (
      `From Orbit · project “${projectTitle}” has a task that cannot start\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + `Next step: ${dispatchRefusalNextStep({
        fixAction: detail.fixAction ?? 'not recorded', ref: detail.ref ?? null,
      })}\n\n`
      + `The refusal is recorded on the task: dispatchRefusal in task_get (taskId: ${taskId}) holds the code, `
      + 'the fixAction, the time, which run, the ref the start used, the commit it was pinned to (none for a '
      + 'start refused while resolving) and the missing commits; the task’s comments hold the runner’s own '
      + 'words. The field is cleared once the task starts again; another refusal records it again and tells you '
      + 'again.\n\n'
      + 'Read the full state yourself; apart from the fact above, this message carries none of the project’s '
      + `state: project_get (projectId: ${projectId}) reads the goal and acceptance criteria, and `
      + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
      + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
      + 'you are reading it only after that turn ended, so go by the state you have just read from the '
      + 'database yourself.'
    );
  }
  if (fact.event === 'PROJECT_BLOCKER_RAISED') {
    const detail = (fact.detail ?? {}) as {
      blockerId?: unknown;
      blockerKind?: unknown;
      requiredAction?: unknown;
      taskTitle?: unknown;
      agentArgument?: unknown;
      criterionText?: unknown;
      paths?: unknown;
    };
    const taskId = uuidToBase62(fact.subjectId);
    const blockerId = typeof detail.blockerId === 'string'
      ? uuidToBase62(detail.blockerId)
      : uuidToBase62(fact.subjectVersion);
    const paths = Array.isArray(detail.paths)
      ? detail.paths.filter((path): path is string => typeof path === 'string')
      : [];
    const evidence = typeof detail.agentArgument === 'string' && detail.agentArgument.trim()
      ? `The agent’s own words:\n“${detail.agentArgument.trim()}”\n\n`
      : '';
    const criterion = typeof detail.criterionText === 'string' && detail.criterionText.trim()
      ? `The current criterion:\n“${detail.criterionText.trim()}”\n\n`
      : '';
    const files = paths.length > 0 ? `Files involved:\n${paths.map((path) => `- ${path}`).join('\n')}\n\n` : '';
    return (
      `From Orbit · project “${projectTitle}” has a delivery that needs the account owner’s ruling\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + `${evidence}${criterion}${files}`
      + 'This is not an ordinary failure, and not a merge you may let through on your own. First check the '
      + `context with project_get (projectId: ${projectId}) and task_get (taskId: ${taskId}); until it is `
      + 'ruled on, do not merge, and do not release the next task either.\n\n'
      + 'If you can set out a recommendation and its grounds, submit it with project_blocker_resolve '
      + `(projectId: ${projectId}, blockerId: ${blockerId}, reason saying how you recommend handling it). `
      + 'It goes to the account owner’s confirmation card first, and the blocker closes only once the account '
      + 'owner agrees; if they refuse or nobody answers the card, keep the blocker open and keep reporting it.\n\n'
      + 'The action the platform originally asked for: '
      + `${String(detail.requiredAction ?? 'Get the account owner’s decision first.')}\n\n`
      + 'This is a notification and does not interrupt the current turn; go by the project state you read afresh.'
    );
  }
  if (fact.event === 'COMPLETION_EVIDENCE_REVISED') {
    const detail = (fact.detail ?? {}) as {
      evidenceRevision?: unknown;
      criterion?: { key?: unknown; text?: unknown } | null;
      escalationSeconds?: unknown;
      waited?: { submittedAt?: unknown } | null;
    };
    const taskId = uuidToBase62(fact.subjectId);
    const revision = String(detail.evidenceRevision ?? '');
    const criterion = detail.criterion && typeof detail.criterion.text === 'string'
      ? detail.criterion
      : null;
    const escalation = typeof detail.escalationSeconds === 'number'
      ? ` (currently ${detail.escalationSeconds} seconds)`
      : '';
    // A revision that waited while this conversation was paused, handed over now that it is back
    // (`CompletionEvidenceProducer.deliverWaiting`): said in so many words, because nothing else in
    // the message tells the coordinator it is old and still nobody's.
    const waited = typeof detail.waited?.submittedAt === 'string'
      ? `This revision was submitted at ${detail.waited.submittedAt} while you were unavailable. `
        + 'It waited for you; nobody has decided it yet.\n\n'
      : '';
    return (
      `From Orbit · project “${projectTitle}” has a revision of completion evidence for you to decide\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + waited
      + (criterion
        ? `The criterion this evidence quotes (key ${String(criterion.key)}), word for word:\n`
          + `“${String(criterion.text)}”\n\n`
        : '')
      + 'This project has Automatic on: whether a task is done is yours to decide from its evidence, and it is '
      + 'not handed to the account owner first. '
      + `First read revision ${revision} of the evidence with task_evidence_list (taskId: ${taskId}) — what it `
      + 'claims it achieved (claim), which checks it cites (checks), and what it admits it did not prove (gaps); '
      + `when you need to, read the task’s description and comments with task_get (taskId: ${taskId}). `
      + `Then decide with task_evidence_decide (taskId: ${taskId}, evidenceRevision: "${revision}"): if the `
      + 'evidence is enough to prove the criterion above, decide CONFIRM, and the task becomes DONE with it; if '
      + 'it is not, decide SEND_BACK, and say in the note what the next revision of the evidence has to prove — '
      + 'the note is delivered as a platform message straight to the run session that submitted this revision, '
      + 'which fixes it and submits the next one; the task stays OPEN.\n\n'
      + `If you do not decide it, then once this project’s exceptionEscalationSeconds${escalation} have passed `
      + 'since delivery, this revision goes to the account owner to decide in the app; the account owner can '
      + 'also decide it directly at any time. A question that really needs the account owner’s call is asked '
      + 'separately with ask_owner (each one with a recommended default); “I’d like the account owner to take a '
      + 'look” is not a reason to leave it undecided.\n\n'
      + 'Read the full state yourself; apart from the fact above and the words of the criterion it quotes, this '
      + `message carries none of the project’s state: project_get (projectId: ${projectId}) reads the goal and `
      + `acceptance criteria, and task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
      + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
      + 'you are reading it only after that turn ended, so go by the state you have just read from the '
      + 'database yourself — this revision may already have been decided, or a newer one may exist.'
    );
  }
  if (fact.event === 'DEPENDENT_READY') {
    const taskId = uuidToBase62(fact.subjectId);
    return (
      `From Orbit · project “${projectTitle}” has a downstream task that can start now\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + 'Whether to start it is your judgment, and the platform will not start it for you: first look at its '
      + `description, dependencies and comments with task_get (taskId: ${taskId}), and confirm that what its `
      + 'prerequisites landed is the baseline it needs; if you decide to start it, call task_start '
      + `(taskId: ${taskId}). You may also decide not to start it yet, but this message comes only once per `
      + 'generation, and until it is started it stays where it is.\n\n'
      + 'Read the full state yourself; apart from the fact above, this message carries none of the project’s '
      + `state: project_get (projectId: ${projectId}) reads the goal and instructions, and `
      + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
      + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
      + 'you are reading it only after that turn ended, so go by the state you have just read from the '
      + 'database yourself — it may already have been started.'
    );
  }
  if (fact.event === 'PROJECT_SETTLED_UNMERGED') {
    const commits = unmergedCommitsOf(fact);
    return (
      `From Orbit · project “${projectTitle}” has settled, and work is still sitting on its integration `
      + 'line, not in main\n\n'
      + `${describeWakeFact(fact)}\n\n`
      + (commits.length > 0
        ? `Commits to land: ${commits.map((sha) => `\`${sha}\``).join(', ')}\n\n`
        : '')
      + 'The platform has not queued a promotion candidate for them, and will not: candidates are queued after '
      + 'each landing, and the landing jobs that carried these commits had reached a terminal state before the '
      + 'commits were written. So nobody is waiting for them, and nothing else will rediscover them.\n\n'
      + 'There is only one thing to do: get these commits into main. Which way is your judgment — if the whole '
      + 'project branch should be merged, the merge card is the account owner’s (the Merge card on this '
      + 'project’s page; you cannot press it for them); if only this part should be merged, or the work should '
      + 'land task by task, merge it into main and then record it with a merge receipt (merge_receipt) — the '
      + 'receipt is what proves it is “already on main”. Whichever way you go, first read the goal with '
      + 'project_get and each task’s status with task_list, then look at those commits yourself; do not act on '
      + 'the shas in this message alone.\n\n'
      + 'Read the full state yourself; apart from the fact above, this message carries none of the project’s '
      + `state: project_get (projectId: ${projectId}) reads the goal and acceptance criteria, and `
      + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
      + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
      + 'you are reading it only after that turn ended, so go by the state you have just read from the '
      + 'database yourself.'
    );
  }
  return (
    `From Orbit · project “${projectTitle}” has finished work that has not landed on main\n\n`
    + `${describeWakeFact(fact)}\n\n`
    + 'The merge order is a hard constraint, not advice: merge into main → record main’s current content as '
    + 'evidence with project_merge_evidence → then put the matching tasks in a terminal state. If the merge '
    + 'fails, stop and write the reason in a task_comment; do not retry over and over.\n\n'
    + 'Read the full state yourself; apart from the fact above, this message carries none of the project’s '
    + `state: project_get (projectId: ${projectId}) reads the goal and acceptance criteria, and `
    + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
    + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
    + 'you are reading it only after that turn ended, so go by the state you have just read from the '
    + 'database yourself.'
  );
}

/**
 * What each landing reason (`criterion-landing-reason.ts`) means, for a coordinator choosing between
 * asking for the project to be recorded done and going back to work. One sentence each, saying what
 * Orbit can and cannot see — never what to conclude.
 */
const LANDING_REASON_SENTENCES: Readonly<Record<CriterionLandingReason, string>> = {
  IN_FLIGHT: 'the platform is landing its work, or merging it into main, right now',
  ON_PROJECT_BRANCH: 'the work is on the project branch with commits of its own, but no job is merging it into main',
  NOTHING_TO_LAND:
    'its tasks ran on a branch, but the landing job found no commits of their own on it, and Orbit cannot '
    + 'prove the branch tip is already on main either — with nothing to merge, there will be no receipt',
  NO_RECEIPT: 'no receipt proves its work is on the project branch or on main: it may have been merged outside '
    + 'Orbit, or not merged yet',
  CODELESS: 'its tasks did no work on a worktree branch, so they look like they produce no code, yet they did not '
    + 'declare codeless — with no branch to land, there will never be a receipt',
};

/** The counts line, from the projection's own counts: the one place they are added up. */
function renderLandingCounts(reading: DerivedProjectDoneReading): string {
  const { counts } = reading.derived;
  const parts = [
    `${counts.criteria} acceptance ${counts.criteria === 1 ? 'criterion' : 'criteria'}`,
    `${counts.met} satisfied`,
    `${counts.onMain} on main`,
    ...(Object.entries(counts.byReason) as Array<[CriterionLandingReason, number]>)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${reason}`),
  ];
  return parts.join(' · ');
}

/**
 * The message a project that LOOKS finished is delivered as: `PROJECT_TASKS_SETTLED`, sent to the
 * standing conversation instead of a judgment when every criterion is met, nothing is running or
 * queued, no item is open and nothing is landing — and the projection still withholds DONE
 * (`project-looks-finished.ts`, project closing D5).
 *
 * It names every criterion that is not on main by a receipt of its own, with the projection's
 * landing reason, because those are what Orbit cannot prove and what the coordinator has to account
 * for either way. Then it asks for one of two things — request done, or go and do the work — and
 * says what happens if it does neither: the project's `exceptionEscalationSeconds` later, the
 * account owner is shown "Record as done…". The roster is a snapshot, like the confirmation card's,
 * because the choice is about these criteria; everything else is still a read.
 */
function buildLooksFinishedMessage(
  fact: WakeFact,
  projectTitle: string,
  reading: DerivedProjectDoneReading,
  escalationSeconds: number | undefined,
): string {
  const projectId = uuidToBase62(fact.projectId);
  const texts = new Map(settledCriteriaOf(fact).map((criterion) => [criterion.key, criterion.text]));
  // The criteria holding DONE back: every one that is not LANDED, each with its reason. A LANDED one
  // with nothing to land is no gap, and shows only in the counts.
  const reasons = reading.derived.criteria
    .filter((criterion) => criterion.landing !== 'LANDED')
    .map((criterion) => {
      const key = criterionKeyOf(criterion.definitionId);
      const text = texts.get(key);
      const reason = criterion.landingReason ?? 'NO_RECEIPT';
      return (
        `- ${text ? `“${text}” (key ${key})` : `key ${key}`}: ${reason} — ${LANDING_REASON_SENTENCES[reason]}`
      );
    })
    .join('\n');
  const window = escalationSeconds !== undefined ? ` (currently ${escalationSeconds} seconds)` : '';
  return (
    `From Orbit · project “${projectTitle}” looks finished, but Orbit cannot record it Done by itself\n\n`
    + `${describeWakeFact(fact)}\n\n`
    + 'What Orbit has checked: every acceptance criterion is satisfied by the tasks serving it; no task is '
    + 'running or queued; no open item is left unhandled; no landing or merge-into-main job is in flight '
    + '(LAND_TASK, CHECK_PROMOTION, LAND_PROMOTION). '
    + `But the derivation still holds Done back (${reading.derived.withheld.join(', ')}). `
    + 'The acceptance criteria below do not count as landed yet — Orbit cannot prove their work is on main — '
    + 'with the reason for each:\n'
    + `${reasons}\n`
    + `(${renderLandingCounts(reading)})\n\n`
    + 'Choose one of two, and do it in this turn:\n'
    + '1. Request done: if you have checked main and what is live and judge that the goal is reached, call '
    + `project_request_done (projectId: ${projectId}) with a sentence or two of judgment, and a gap for each `
    + 'criterion above: the criterionKey, why Orbit cannot prove it, what you checked, and where the evidence '
    + 'is. Orbit runs its closing check first, and only if that passes does it put an “Is this project done?” '
    + 'card in front of the account owner in this conversation; recording Done is the account owner’s to do.\n'
    + '2. Go and do the work: if something really is not finished, or not in main, go and do it. A task whose '
    + 'only purpose is getting work into main serves no acceptance criterion; do not give it a criterionKey — '
    + 'hanging it on a satisfied criterion makes that criterion unsatisfied again. '
    + 'Do not patch a receipt onto a zero-commit task with merge_receipt: a receipt records only a merge that '
    + 'really happened.\n\n'
    + `If you do neither, and this project’s exceptionEscalationSeconds${window} pass after this message with `
    + 'no request to close, Record as done… appears in the account owner’s Needs you, and the account owner '
    + 'decides for themselves.\n\n'
    + 'You cannot write status with project_update (PROJECT_STATUS_NOT_SESSION_WRITABLE): Done is only derived '
    + 'by Orbit, or recorded by the account owner themselves.\n\n'
    + `Read the full state yourself: project_get (projectId: ${projectId}) returns derivedDone, which gives `
    + 'each acceptance criterion’s landingReason and these counts, and '
    + `task_list (projectId: ${projectId}) reads each task’s status and dependencies.\n\n`
    + 'This is a notification, not an interruption: the turn you were running is not interrupted by it, and '
    + 'you are reading it only after that turn ended, so go by the state you have just read from the '
    + 'database yourself.'
  );
}
