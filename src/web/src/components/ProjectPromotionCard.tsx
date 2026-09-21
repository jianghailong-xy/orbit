import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import type {
  IntegrationCheckResult,
  ProjectOpenItemRow,
  ProjectPromotionView,
} from '@orbit/shared';
import { CardActionButton, CardActions } from './CardAction';
import { blockerHeadline, type ProjectBlocker } from './ProjectBlockers';
import { FROM_ORBIT, FROM_ORBIT_TITLE } from './ProjectProgressStatus';
import { api } from '../api';
import { checkDuration } from '../lib/checkDuration';
import { encodeId } from '../lib/idCodec';
import {
  projectOpenItemsQuery,
  projectPromotionQuery,
} from '../lib/queries';
import { ago, formatSpan } from '../lib/watches';

/**
 * The card that asks the account owner to merge a project branch into main (mock 4,
 * `docs/mocks/project-progress/04-merge-to-main.html`; contract §3.3, §3.6, §7.5).
 *
 * WHY THIS IS THE ONE MERGE SOMEBODY PRESSES. Everything else on an integration line happens on its
 * own: a finished task is rebased, checked on the combined tree and landed on the project branch by
 * the platform, because each of those steps has one right answer. Merging that branch into main does
 * not — "is this ready to be on main" is a judgement, and M7 gives it to the account owner every
 * time, with no automatic branch and no setting that turns one on. So this card is not a convenience
 * over an API; it is the only door that merge has.
 *
 * WHAT IT HAS TO SAY BEFORE SOMEBODY CAN ANSWER IT. Four facts, which is why the card is a list of
 * rows rather than a sentence: which tasks would arrive on main, what was run on the combined tree
 * and what it came to, whether main has moved underneath the check, and how far the project's own
 * criteria have got — because merging into main is NOT the project finishing, and a card that let a
 * reader assume it was would be asking them to confirm something other than what happens (M8).
 *
 * FOUR STATES, ONE CARD. A asks; B says it is under way and there is nothing to do; C is the
 * receipt; D says it cannot happen yet, who is on it and when it becomes the reader's problem. They
 * are one component because they are one thing at four moments — and because the alternative, four
 * cards, is four places for the branch's name and the tasks' fate to be worded differently.
 *
 * WHAT IS DRAWN IS WHAT THE SERVER SERVES. Every row is a field of `ProjectPromotionView`, every
 * press is one of the three doors §3.4 M-F3 built, and the two facts the candidate itself does not
 * carry — who is holding a blocked one, and how far the criteria have got — are read from the item
 * and the project document rather than guessed. A row it cannot fill is left out; none is invented.
 */

/** The three presses, and the words the mock gives them. Exported because the tests press by name
 *  and both hosts should be able to say "the card with the Merge to main button". */
export const MERGE_TO_MAIN = 'Merge to main';
export const NOT_NOW = 'Not now';
export const MERGING = 'Merging…';
export const CANCEL_MERGE = 'Cancel';
export const OPEN_COORDINATOR = 'Open coordinator';

/** State C's heading, and state B's one sentence about what the reader has to do (nothing). */
export const MERGED_HEADING = '✓ Merged into main';
export const NOTHING_TO_DO =
  'nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t';
/** M8, in the card's own words: this merge is not the project finishing. */
export const CRITERIA_TAIL = 'merging does not close the project';
/** B5: what merging does to a blocker somebody was still going to decide. */
export const BLOCKERS_DECIDED_TOO = 'merging decides them too';

/** The part of the project document this card reads (M8): how far the criteria have got, and how
 *  much work the branch still has after this merge. Structural, so `ProjectDetail` satisfies it. */
export interface PromotionProjectView {
  acceptanceCriteriaItems?: Array<{ ordinal: number; satisfied?: boolean; landing?: string }>;
  tasksByStatus?: Record<string, number>;
  /** The project's open blockers, for B5's row below. */
  blockers?: { open: ProjectBlocker[] };
}

/** The states that ask or tell the reader something. `CHECKING` is the moment before the question
 *  exists, and the rest are candidates nothing is waiting on (§3.3). */
const DRAWN_STATES = ['READY', 'CONFIRMED', 'RECHECKING', 'MERGED', 'BLOCKED'] as const;

/** A branch as a person says it: `main`, not `refs/heads/main`. */
function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The heading, which is the whole of what the card is at a glance (§3.3's four states). */
export function promotionHeading(promotion: ProjectPromotionView): string {
  const source = shortRef(promotion.sourceRef);
  const upstream = shortRef(promotion.upstreamRef);
  switch (promotion.state) {
    case 'MERGED':
      return MERGED_HEADING;
    case 'CONFIRMED':
    case 'RECHECKING':
      return `Merging ${source} into ${upstream}…`;
    case 'BLOCKED':
      return `${source} can’t merge into ${upstream} yet`;
    default:
      return `Merge ${source} into ${upstream}?`;
  }
}

/** Whether a check ran and ended the way it was asked to. */
function passed(check: IntegrationCheckResult): boolean {
  return !check.timedOut && check.exitCode === check.expectedExitCode;
}

/** One check, as the mock writes it: the command and what it took, after the verdict. */
function CheckLine({ check }: { check: IntegrationCheckResult }): JSX.Element {
  return (
    <>
      {' · '}
      <span className="promotion-mono">{check.command}</span>
      {' · '}
      {checkDuration(check.durationMs)}
    </>
  );
}

/** A row of the card's body. The key column is fixed-width, so four rows read as a table. */
function Row({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <div className="criteria-decision-kv promotion-row">
      <span className="criteria-decision-k">{k}</span>
      <span className="criteria-decision-v">{children}</span>
    </div>
  );
}

/** M8: how many of the project's stated criteria this branch has met, from the project document
 *  rather than from anything the promotion itself claims. Null when the document was not read. */
function criteriaTally(project: PromotionProjectView | null): { met: number; total: number } | null {
  const items = project?.acceptanceCriteriaItems;
  if (!items || items.length === 0) return null;
  return { met: items.filter((item) => item.satisfied === true).length, total: items.length };
}

/** The criteria whose work this merge puts on the upstream — the ones the receipt says now read
 *  "on main". Empty when the document was not read, and then the receipt says nothing about them. */
function landingCriteria(project: PromotionProjectView | null): number[] {
  return (project?.acceptanceCriteriaItems ?? [])
    .filter((item) => item.satisfied === true)
    .map((item) => item.ordinal);
}

/**
 * B5 / appendix A-Q14: the blockers a person still has to decide, on the tasks this merge would
 * bring in.
 *
 * They do not stop work reaching the project branch any more — the owner decided on 2026-09-14
 * that holding the branch for them helped nobody — so this card is where they surface instead.
 * Merging into main with one of these open is a decision about the blocker too, and the reader
 * makes it here rather than finding out afterwards.
 */
function humanBlockers(
  project: PromotionProjectView | null,
  taskIds: string[],
): ProjectBlocker[] {
  const brought = new Set(taskIds);
  return (project?.blockers?.open ?? []).filter(
    (blocker) =>
      blocker.owner === 'USER' && blocker.subjectType === 'TASK' && brought.has(blocker.subjectId),
  );
}

function openTasks(project: PromotionProjectView | null): number | null {
  const byStatus = project?.tasksByStatus;
  if (!byStatus) return null;
  return (byStatus.OPEN ?? 0) + (byStatus.IN_PROGRESS ?? 0);
}

/** State A's body: what would land, what was run, where main is, and what this does to the goal. */
function ReadyRows({
  promotion,
  project,
  now,
}: {
  promotion: ProjectPromotionView;
  project: PromotionProjectView | null;
  now: number;
}): JSX.Element {
  const upstream = shortRef(promotion.upstreamRef);
  const tally = criteriaTally(project);
  // The blockers row reads the row's own ids rather than the titles beside them: it asks which of
  // the tasks this merge would carry are still holding somebody up, and that is the recorded set.
  const blockers = humanBlockers(project, promotion.taskIds);
  const tree = shortSha(promotion.landsTreeSha);
  const checked = shortSha(promotion.upstreamShaChecked);
  return (
    <>
      <Row k="Branch">
        <span className="promotion-mono">{shortRef(promotion.sourceRef)}</span>
        {promotion.commitsAhead != null
          ? ` · ${plural(promotion.commitsAhead, 'commit')} ahead of ${upstream}`
          : null}
      </Row>
      <Row k="Tasks">
        {`${promotion.tasks.length} landed on the branch`}
        <ul className="project-promotion-tasks">
          {promotion.tasks.map((task) => (
            <li key={task.taskId}>{task.title}</li>
          ))}
        </ul>
      </Row>
      <Row k="Checks">
        {promotion.checks.length === 0 ? (
          `No check is configured — nothing ran on the combined tree`
        ) : (
          <>
            <span className="promotion-ok">✓ Passed on the combined tree</span>
            {promotion.checks.map((check, index) => (
              <CheckLine key={`${check.name}-${index}`} check={check} />
            ))}
          </>
        )}
      </Row>
      {/* When the branch last took main in (M1), which is what the owner is being asked to move
          forward — and, for a branch that has never absorbed it, the commit the check ran against
          instead, because that is the branch's whole relationship with main so far. */}
      <Row k={upstream}>
        {promotion.upstream.syncedAt ? (
          `synced ${ago(promotion.upstream.syncedAt, now)} · `
        ) : checked ? (
          <>
            {'checked against '}
            <span className="promotion-mono">{checked}</span>
            {' · '}
          </>
        ) : null}
        {promotion.upstream.conflicts ? (
          <span className="promotion-bad">
            {`${plural(promotion.conflicts.length, 'file')} conflict`}
          </span>
        ) : (
          <span className="promotion-ok">no conflicts</span>
        )}
      </Row>
      {tally ? (
        <Row k="Criteria">{`${tally.met} of ${tally.total} met on this branch — ${CRITERIA_TAIL}`}</Row>
      ) : null}
      {blockers.length > 0 ? (
        <Row k="Blockers">
          <span className="promotion-warn">{`${plural(blockers.length, 'blocker')} open on the tasks this brings in`}</span>
          {` — ${BLOCKERS_DECIDED_TOO}`}
          <ul className="project-promotion-blockers">
            {blockers.map((blocker) => (
              <li key={blocker.id}>
                {[blockerHeadline(blocker).title, blocker.subjectTitle].filter(Boolean).join(' · ')}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
      <Row k="Lands">
        {tree ? (
          <>
            {'exactly the tested tree '}
            <span className="promotion-mono">{tree}</span>
            {' · '}
          </>
        ) : null}
        {promotion.landsAs === 'MERGE_COMMIT' ? 'as a merge commit' : 'by fast-forward'}
        {promotion.filesChanged != null ? ` · ${plural(promotion.filesChanged, 'file')}` : null}
      </Row>
    </>
  );
}

/** State B's body: why it is still going, and that the reader is not the one it is waiting for. */
function MergingRows({ promotion, now }: { promotion: ProjectPromotionView; now: number }): JSX.Element {
  const upstream = shortRef(promotion.upstreamRef);
  const rechecking = promotion.state === 'RECHECKING';
  // The re-check's own numbers when the server has them, and what the row already carried when it
  // does not: a promotion re-checked before the platform counted anything still says how long it
  // has been running rather than going silent.
  const startedAt = promotion.recheck?.startedAt ?? promotion.recheckedAt;
  const since = startedAt ? formatSpan(now - Date.parse(startedAt)) : null;
  const movedBy = promotion.recheck?.upstreamMovedBy ?? null;
  const typical = promotion.recheck?.typicalMs ?? null;
  return (
    <>
      <Row k="Status">
        <span className="promotion-spin" aria-hidden="true" />
        {rechecking
          ? `${upstream} moved${movedBy != null ? ` ${plural(movedBy, 'commit')}` : ''} since the check — re-checking the combined tree${since ? ` (${since}${typical != null ? ` of ~${formatSpan(typical)}` : ' so far'})` : ''}`
          : `confirmed — merging the tested tree into ${upstream}`}
      </Row>
      <Row k="You">{NOTHING_TO_DO}</Row>
    </>
  );
}

/** State C's body: the commit, what is on main because of it, and what the branch still owes. */
function MergedRows({
  promotion,
  project,
  now,
}: {
  promotion: ProjectPromotionView;
  project: PromotionProjectView | null;
  now: number;
}): JSX.Element | null {
  const merged = promotion.merged;
  if (!merged) return null;
  const source = shortRef(promotion.sourceRef);
  const ordinals = landingCriteria(project);
  const open = openTasks(project);
  return (
    <>
      <Row k="Commit">
        <span className="promotion-mono">{shortSha(merged.sha)}</span>
        {` · merge of ${source} · by you · ${ago(merged.at, now)}`}
      </Row>
      <Row k={`Now on ${shortRef(promotion.upstreamRef)}`}>
        {plural(promotion.taskIds.length, 'task')}
        {ordinals.length > 0
          ? ` · ${ordinals.length === 1 ? 'criterion' : 'criteria'} ${ordinals.join(', ')} show “on ${shortRef(promotion.upstreamRef)}”`
          : null}
      </Row>
      <Row k="Next">
        {open == null
          ? `${source} keeps going`
          : open > 0
            ? `${source} keeps going — ${plural(open, 'task')} still open`
            : `${source} has no open tasks left`}
      </Row>
    </>
  );
}

/**
 * State D's body: why it cannot merge, who has it, and what happens when they are done — or when
 * they are not. The "who" and the "when" come from the exception item, which is where the platform
 * records whose problem this is; a card without one says the first two and stops.
 */
function BlockedRows({
  promotion,
  item,
  now,
}: {
  promotion: ProjectPromotionView;
  item: ProjectOpenItemRow | null;
  now: number;
}): JSX.Element {
  const upstream = shortRef(promotion.upstreamRef);
  const failed = promotion.checks.filter((check) => !passed(check));
  const waited = item ? formatSpan(now - Date.parse(item.waitingSince)) : null;
  const escalatesIn =
    item?.escalateAt != null ? Date.parse(item.escalateAt) - now : null;
  return (
    <>
      <Row k="Why">
        {promotion.conflicts.length > 0 ? (
          <>
            <span className="promotion-bad">{`${plural(promotion.conflicts.length, 'file')} conflict`}</span>
            {` with ${upstream} after syncing: `}
            {promotion.conflicts.map((path, index) => (
              <span key={path}>
                {index > 0 ? ', ' : null}
                <span className="promotion-mono">{path}</span>
              </span>
            ))}
          </>
        ) : failed.length > 0 ? (
          <>
            <span className="promotion-bad">Checks failed on the combined tree</span>
            {failed.map((check, index) => (
              <CheckLine key={`${check.name}-${index}`} check={check} />
            ))}
          </>
        ) : (
          <span className="promotion-bad">
            {`The combined tree could not be built on ${upstream}`}
          </span>
        )}
      </Row>
      {item ? (
        <Row k="Who">
          {item.assignee === 'COORDINATOR'
            ? `The coordinator is resolving it on the project branch${waited ? ` · ${waited}` : ''}`
            : `It is yours${waited ? ` · waiting ${waited}` : ''}`}
        </Row>
      ) : null}
      <Row k="Then">
        {`checks re-run and this card comes back as “Merge ${shortRef(promotion.sourceRef)} into ${upstream}?”`}
        {escalatesIn != null && escalatesIn > 0
          ? ` · goes to you if untouched for ${formatSpan(escalatesIn)}`
          : item?.assignee === 'COORDINATOR'
            ? ' · goes to you when it runs out of time'
            : null}
      </Row>
    </>
  );
}

/** `POST /projects/:id/promotions/:promotionId/{confirm|decline|cancel}` — the owner's three doors
 *  (§3.4 M-F3). The confirmation names the SHA the card was drawn from, so a candidate the branch
 *  has moved past is refused rather than merged as whatever is on the branch now. */
function decidePromotion(
  projectId: string,
  promotionId: string,
  door: 'confirm' | 'decline' | 'cancel',
  body: Record<string, unknown>,
): Promise<ProjectPromotionView> {
  return api<ProjectPromotionView>(
    `/projects/${encodeURIComponent(projectId)}/promotions/${encodeURIComponent(promotionId)}/${door}`,
    { method: 'POST', body },
  );
}

/**
 * The card, for a candidate that is asking or telling somebody something.
 *
 * Takes the promotion, the item and the project rather than reading them, so that the project page
 * and the coordinator's conversation can hand it what they already have — and so a test can draw
 * all four states without a server.
 */
export function ProjectPromotionCard({
  projectId,
  promotion,
  item,
  project,
  now,
}: {
  projectId: string;
  promotion: ProjectPromotionView;
  /** The exception item holding a BLOCKED candidate, when one has been filed. */
  item: ProjectOpenItemRow | null;
  /** The project document, for the criteria tally (M8). Null when it has not been read. */
  project: PromotionProjectView | null;
  /** Passed in so a test reads a fixed clock; the hosts give it `Date.now()`. */
  now: number;
}): JSX.Element | null {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (door: 'confirm' | 'decline' | 'cancel') =>
      decidePromotion(projectId, promotion.promotionId, door, {
        ...(door === 'confirm' ? { sourceSha: promotion.sourceSha } : {}),
      }),
    // Merged, declined or refused, everything this card is drawn from is re-read: the candidate
    // itself, the item that was holding it, and the project whose criteria have just moved.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectPromotionQuery(projectId).queryKey });
      void qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  if (!DRAWN_STATES.includes(promotion.state as (typeof DRAWN_STATES)[number])) return null;

  const merged = promotion.state === 'MERGED';
  const merging = promotion.state === 'CONFIRMED' || promotion.state === 'RECHECKING';
  const blocked = promotion.state === 'BLOCKED';
  const coordinator = item?.delivery.sessionId ?? null;

  return (
    <div
      className={`approval-card criteria-decision project-promotion is-${promotion.state.toLowerCase()}`}
      id={`promotion-${promotion.promotionId}`}
      data-state={promotion.state}
    >
      <div className="approval-head project-promotion-head">
        <span className="criteria-decision-heading">{promotionHeading(promotion)}</span>
        <span
          className={`criteria-provenance${merged ? ' prov-neutral' : ''}`}
          title={FROM_ORBIT_TITLE}
        >
          {FROM_ORBIT}
        </span>
      </div>
      <div className="approval-body is-plan project-promotion-body">
        {merged ? (
          <MergedRows promotion={promotion} project={project} now={now} />
        ) : merging ? (
          <MergingRows promotion={promotion} now={now} />
        ) : blocked ? (
          <BlockedRows promotion={promotion} item={item} now={now} />
        ) : (
          <ReadyRows promotion={promotion} project={project} now={now} />
        )}
      </div>
      {decide.isError ? (
        <Alert
          type="error"
          showIcon
          className="project-promotion-error"
          message={`${shortRef(promotion.sourceRef)} was not merged`}
          description={(decide.error as Error).message}
        />
      ) : null}
      {/* A receipt asks for nothing, so it has no action row at all. */}
      {merged ? null : (
        <CardActions className="approval-actions project-promotion-actions">
          <CardActionButton
            tone="primary"
            // The one rule `CardAction` exists for: a press that the door would refuse — a merge
            // while the tree is blocked, or one already under way — is disabled, never lit.
            disabled={merging || blocked || decide.isPending}
            onClick={() => decide.mutate('confirm')}
          >
            {merging ? MERGING : MERGE_TO_MAIN}
          </CardActionButton>
          {merging ? (
            <CardActionButton disabled={decide.isPending} onClick={() => decide.mutate('cancel')}>
              {CANCEL_MERGE}
            </CardActionButton>
          ) : blocked ? null : (
            <CardActionButton disabled={decide.isPending} onClick={() => decide.mutate('decline')}>
              {NOT_NOW}
            </CardActionButton>
          )}
          {blocked && coordinator ? (
            <Link
              className="project-promotion-link"
              to={`/sessions/${encodeURIComponent(encodeId(coordinator))}`}
            >
              {OPEN_COORDINATOR}
            </Link>
          ) : null}
          {/* Only on the card that is asking: "asked 2h ago" under a card that is merging, or that
              cannot merge, would be timing a question nobody is being asked. */}
          {promotion.askedAt && promotion.state === 'READY' ? (
            <span className="project-promotion-asked">{`asked ${ago(promotion.askedAt, now)}`}</span>
          ) : null}
        </CardActions>
      )}
    </div>
  );
}

/**
 * This project's merge card, wherever the owner is: under the project page's Open items, and in the
 * coordinator's own conversation (§7.5).
 *
 * Reads nothing without a project — an ordinary session coordinates none — and draws nothing while
 * no candidate is asking or telling anything, so neither host has to know whether there is one.
 */
export function ProjectPromotion({
  projectId,
  now = Date.now(),
}: {
  projectId: string | null | undefined;
  now?: number;
}): JSX.Element | null {
  const promotion = useQuery({
    ...projectPromotionQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<PromotionProjectView>(`/projects/${encodeURIComponent(projectId!)}`),
    enabled: Boolean(projectId),
  });
  const current = promotion.data;
  if (!projectId || !current) return null;
  const rows = [...(items.data?.needsYou ?? []), ...(items.data?.withCoordinator ?? [])];
  return (
    <ProjectPromotionCard
      projectId={projectId}
      promotion={current}
      item={rows.find((row) => row.promotionId === current.promotionId) ?? null}
      project={project.data ?? null}
      now={now}
    />
  );
}
