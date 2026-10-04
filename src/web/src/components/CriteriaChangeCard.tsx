import { useEffect, useId, useRef, useState, type JSX, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import type { CriteriaChangesSinceConfirmed } from '@orbit/shared';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  acceptanceConfirmationQuery,
  confirmAcceptanceCriteria,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import {
  CRITERIA_CHANGE_EXPLAINS,
  CRITERIA_CHANGE_NEW,
  CRITERIA_CHANGE_REVISED,
  CRITERIA_CHANGE_STRICTER,
  CRITERIA_CHANGE_TITLE,
  CRITERIA_CHANGE_WHAT_CHANGED,
  confirmedChangesKey,
  confirmedChangesProjectKey,
  criteriaChangeConfirmLabel,
  criteriaChangeKind,
  criteriaChangeMeta,
  criteriaChangeShowAll,
  criteriaChangeSummary,
  criteriaChangeUnchanged,
  criteriaChangeWas,
  projectStarted,
} from '../lib/projectStart';
import {
  ACCEPTANCE_PROVENANCE_TITLE,
  ACCEPTANCE_SHOW_LESS_LABEL,
  CONFIRMATION_NOT_RECORDED,
  type ConfirmationCriterion,
  type ConfirmationProjectDocument,
  type SettlementPlanChat,
} from './AcceptanceConfirmationCard';
import { CardActionButton, CardActions } from './CardAction';
import { ENTER_HINT, useDecisionCardKeys } from './CardHotkey';
import { ReviewCard } from './ReviewCard';
import { PROVENANCE_LABEL, shortSeal } from './CriteriaDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * "Confirm the new criteria?" — a started project whose criteria moved after the owner confirmed
 * them, asked about what moved and nothing else.
 *
 * WHY ONLY THE CHANGES
 * --------------------
 * Two kinds of edit land without asking anybody once a project runs: a criterion ADDED, and a
 * check made STRICTER (its verification method up the ladder, its words untouched). Each used to
 * bring the whole confirmation card back — every criterion again, a button that read like
 * starting the project over, and nothing saying which line had moved. So this card lists the
 * changes the server computed against what the confirmation stored (`changesSinceConfirmed`) and
 * numbers the rest; the whole set is one toggle away. A change landed some other way (an approved
 * proposal, while the confirmation was already behind) is listed too, as changed, rather than
 * counted among the unchanged.
 *
 * NOTHING STOPS
 * -------------
 * The project keeps running while this waits: the confirmation gates DONE and nothing else, and the
 * card says so. The press confirms the version standing now at the confirmation door
 * (`POST /projects/:id/acceptance/confirmation`), which for a started project only confirms. The
 * record of it is the conversation's receipt, which says "You confirmed", and what this press
 * confirmed — how many new, how many stricter — is left for that receipt under the seal it signed.
 *
 * The words are `lib/projectStart.ts`'s, where OrbitKit's copy-parity tests read them.
 */

/** Whether a conversation is asked this: a started, OPEN project with criteria and work, whose set
 *  moved since the confirmation on record — and the server said how. */
export function criteriaChangeHeld(
  standing: StandardSetConfirmationStanding | null,
  project: ConfirmationProjectDocument | null,
): boolean {
  if (standing === null || standing.state !== 'STALE' || !standing.changesSinceConfirmed) return false;
  if (project === null || project.status !== 'OPEN') return false;
  if ((project.acceptanceCriteriaItems ?? []).length === 0) return false;
  if ((project._count?.tasks ?? 0) === 0) return false;
  return projectStarted(project) === true;
}

/** How many of each change a press confirms: what its receipt says after the seal. */
export function criteriaChangeCounts(changes: CriteriaChangesSinceConfirmed): string {
  return criteriaChangeSummary({
    added: changes.added.length,
    stricter: changes.stricter.length,
    revised: changes.revised.length,
    removed: changes.removed.length,
  });
}

export function CriteriaChangeCard({
  ref,
  projectTitle,
  standing,
  changes,
  criteria,
  busy = false,
  error = null,
  keys = false,
  onConfirm,
  onChatAbout,
}: {
  /** The card's own element, which is where its keyboard claim says it is drawn (`CardHotkey.ts`). */
  ref?: Ref<HTMLDivElement>;
  projectTitle: string;
  standing: StandardSetConfirmationStanding;
  changes: CriteriaChangesSinceConfirmed;
  /** Every criterion that stands now, for "Show all"; null when the project could not be read. */
  criteria: ConfirmationCriterion[] | null;
  busy?: boolean;
  error?: Error | null;
  keys?: boolean;
  onConfirm: () => void;
  onChatAbout: () => void;
}): JSX.Element {
  const listId = useId();
  const [all, setAll] = useState(false);
  const count = standing.currentVersion.material.length;
  const confirmedCount = standing.confirmation?.criteriaMaterial.length ?? 0;
  const items = [...(criteria ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const rows = [
    ...[...changes.added].sort((a, b) => a.ordinal - b.ordinal).map((change) => ({
      key: `new:${change.key}`,
      mark: '+',
      tone: 'is-new',
      kind: criteriaChangeKind(change.ordinal, CRITERIA_CHANGE_NEW),
      text: change.text,
      was: null as string | null,
    })),
    ...[...changes.stricter].sort((a, b) => a.ordinal - b.ordinal).map((change) => ({
      key: `stricter:${change.key}`,
      mark: '↑',
      tone: 'is-stricter',
      kind: criteriaChangeKind(change.ordinal, CRITERIA_CHANGE_STRICTER),
      text: change.verificationMethod,
      was: criteriaChangeWas(change.confirmedVerificationMethod),
    })),
    ...[...changes.revised].sort((a, b) => a.ordinal - b.ordinal).map((change) => ({
      key: `revised:${change.key}`,
      mark: '~',
      tone: 'is-revised',
      kind: criteriaChangeKind(change.ordinal, CRITERIA_CHANGE_REVISED),
      text: change.text,
      was: null as string | null,
    })),
  ];
  const unchanged = criteriaChangeUnchanged(
    [...changes.unchanged].sort((a, b) => a - b),
    changes.removed.length,
  );
  const answerable = !busy;
  return (
    <div ref={ref} className="approval-card settlement-card criteria-change-card">
      <div className="approval-head settlement-card-head">
        <span className="settlement-card-heading">{CRITERIA_CHANGE_TITLE}</span>
        <span className="criteria-provenance prov-brand" title={ACCEPTANCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions settlement-card-body">
        <div className="settlement-card-meta">
          {criteriaChangeMeta(projectTitle, confirmedCount, count, shortSeal(standing.currentVersion.digest))}
        </div>
        {rows.length > 0 ? (
          <ul className="criteria-change-list" aria-label={CRITERIA_CHANGE_WHAT_CHANGED}>
            {rows.map((row) => (
              <li key={row.key} className={row.tone}>
                <span className="criteria-change-mark" aria-hidden="true">{row.mark}</span>
                <span className="criteria-change-kind">{row.kind}</span>
                <span className="criteria-change-text">
                  {row.text}
                  {row.was ? <span className="criteria-change-was">{row.was}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="criteria-change-rest">
          {unchanged ? <span>{unchanged}</span> : null}
          {items.length > 0 ? (
            <>
              {unchanged ? <span aria-hidden="true">{' · '}</span> : null}
              <button
                type="button"
                className="settlement-card-read"
                aria-expanded={all}
                aria-controls={listId}
                onClick={() => setAll((open) => !open)}
              >
                {all ? ACCEPTANCE_SHOW_LESS_LABEL : criteriaChangeShowAll(items.length)}
              </button>
            </>
          ) : null}
        </div>
        {all ? (
          <ol id={listId} className="settlement-card-criteria is-open">
            {items.map((item) => (
              <li key={item.id} value={item.ordinal}>
                <span className="settlement-card-criterion">{item.text}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="settlement-card-explains">{CRITERIA_CHANGE_EXPLAINS}</p>
        {error ? (
          <Alert
            className="settlement-card-error"
            type="error"
            showIcon
            message={CONFIRMATION_NOT_RECORDED}
            description={error.message}
          />
        ) : null}
      </div>
      <CardActions className="approval-actions settlement-card-actions">
        <CardActionButton tone="primary" disabled={!answerable} onClick={onConfirm}>
          {criteriaChangeConfirmLabel(count)}
          {keys && answerable && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
        <CardActionButton tone="secondary" onClick={onChatAbout}>
          {OWNER_SEND_BACK_ACTION}
        </CardActionButton>
      </CardActions>
    </div>
  );
}

/**
 * The wired card for one conversation: drawn while `criteriaChangeHeld` holds, from the same two
 * reads the other settlement cards use, and pressed at the confirmation door with the version it
 * is drawn from. A refusal — the set moved again between the render and the press — re-reads, and
 * the card comes back listing what stands now.
 */
export function SessionCriteriaChangeCard({
  projectId,
  onOpen,
  onChatAbout,
}: {
  projectId: string | null | undefined;
  /** Told whether the card is on screen, each time that changes. A stable function. */
  onOpen?: (open: boolean) => void;
  onChatAbout?: (plan: SettlementPlanChat) => void;
}): JSX.Element | null {
  const [reviewOpen, setReviewOpen] = useState(false);
  const qc = useQueryClient();
  const project = projectId ?? '';
  const enabled = Boolean(projectId);
  const standingRead = useQuery({ ...acceptanceConfirmationQuery(project), enabled });
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () => api<ConfirmationProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled,
    refetchInterval: 20_000,
  });
  const standing = standingRead.isError ? null : (standingRead.data ?? null);
  const document = documentRead.isError ? null : (documentRead.data ?? null);
  const held = criteriaChangeHeld(standing, document);

  const confirm = useMutation({
    mutationFn: (press: { digest: string; summary: string }) =>
      confirmAcceptanceCriteria(project, press.digest),
    onSuccess: (next, press) => {
      // What this press confirmed, for the receipt under the seal it signed: the read that draws
      // the receipt says only the seal, since nothing is left changed once it is confirmed.
      qc.setQueryData(confirmedChangesKey(project, press.digest), press.summary);
      qc.setQueryData(confirmedChangesProjectKey(project), press.summary);
      qc.setQueryData(acceptanceConfirmationKey(project), next);
    },
    onError: () => qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(project) }),
  });
  const answeredHere =
    confirm.isSuccess
    && (standing === null || standing.currentVersion.digest === confirm.variables?.digest);
  const onScreen = held && !answeredHere;
  useEffect(() => {
    onOpen?.(onScreen);
  }, [onOpen, onScreen]);
  useEffect(() => () => onOpen?.(false), [onOpen]);

  const criteria = document?.acceptanceCriteriaItems ?? null;
  const title = document?.title || project;
  const press = (): void => {
    if (!onScreen || !standing?.changesSinceConfirmed || confirm.isPending) return;
    confirm.mutate({
      digest: standing.currentVersion.digest,
      summary: criteriaChangeCounts(standing.changesSinceConfirmed),
    });
  };
  const talkAbout = (): void => {
    if (!standing) return;
    setReviewOpen(false);
    onChatAbout?.({
      projectId: project,
      criteriaDigest: standing.currentVersion.digest,
      projectTitle: title,
      criteria: [...(criteria ?? [])].sort((a, b) => a.ordinal - b.ordinal).map((item) => item.text),
      question: 'CRITERIA_CHANGE',
    });
  };
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useDecisionCardKeys({
    confirmEnabled: reviewOpen && onScreen && !confirm.isPending,
    onConfirm: press,
    anchor,
  });

  if (!onScreen || !standing?.changesSinceConfirmed) return null;
  return (
    <ReviewCard id="settlement-preview" title={CRITERIA_CHANGE_TITLE} summary={title}
      meta={criteriaChangeCounts(standing.changesSinceConfirmed)}
      open={reviewOpen} onOpenChange={setReviewOpen}>
    <CriteriaChangeCard
      ref={anchor}
      projectTitle={title}
      standing={standing}
      changes={standing.changesSinceConfirmed}
      criteria={criteria}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      keys={keys}
      onConfirm={press}
      onChatAbout={talkAbout}
    />
    </ReviewCard>
  );
}
