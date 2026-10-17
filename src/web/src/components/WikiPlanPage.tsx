import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BranchesOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DownOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  EllipsisOutlined,
  HolderOutlined,
  LockOutlined,
  PlusOutlined,
  ProfileOutlined,
  RightOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { WIKI_PLAN_SECTION_KINDS, type WikiPlanProposal, type WikiPlanSectionKind } from '@orbit/shared';
import { relTime } from './Transcript';
import { WikiContentsButton } from './WikiDirectory';
import { WikiDocRow } from './WikiDocList';
import { WikiSourceCard } from './WikiSources';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Drawer } from './ui/Drawer';
import { Input } from './ui/Input';
import { Menu } from './ui/Menu';
import { NumberInput } from './ui/NumberInput';
import { Select } from './ui/Select';
import { Switch } from './ui/Switch';
import { Textarea } from './ui/Textarea';
import {
  wikiDocsQuery,
  wikiEntriesQuery,
  wikiHealthQuery,
  wikiPlanQuery,
  wikiPlanVersionQuery,
  wikiPlanVersionsQuery,
  wikiSpaceQuery,
} from '../lib/queries';
import { useWikiMaintenanceWhere } from '../lib/useWikiMaintenanceWhere';
import { encodeId } from '../lib/idCodec';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { WIKI_HISTORY_MAINTENANCE, WIKI_TITLE, shortSha, wikiEntryPath, wikiShowMore, wikiSpacePath } from '../lib/wiki';
import { wikiCount } from '../lib/wikiArticles';
import { wikiSectionKindLabel } from '../lib/wikiDocs';
import {
  WIKI_PLAN_ACCEPT,
  WIKI_PLAN_ACCEPT_REFUSED,
  WIKI_PLAN_ADD_SECTION,
  WIKI_PLAN_CANCEL,
  WIKI_PLAN_CHANGE,
  WIKI_PLAN_CHANGES,
  WIKI_PLAN_CHANGE_REJECTED,
  WIKI_PLAN_CHECK,
  WIKI_PLAN_CONFIRM,
  WIKI_PLAN_COVERS,
  WIKI_PLAN_DIFF_LABELS,
  WIKI_PLAN_DOCUMENTS,
  WIKI_PLAN_DRAFT,
  WIKI_PLAN_DRAG,
  WIKI_PLAN_DRAWS_ON,
  WIKI_PLAN_EDIT,
  WIKI_PLAN_EDIT_KIND,
  WIKI_PLAN_EDIT_TITLE_FIELD,
  WIKI_PLAN_EMPTY_TITLE,
  WIKI_PLAN_FACTS_SHOWN,
  WIKI_PLAN_FOUND,
  WIKI_PLAN_FROM,
  WIKI_PLAN_HIDE_COMPARE,
  WIKI_PLAN_IN_FORCE,
  WIKI_PLAN_LENGTH,
  WIKI_PLAN_NONE,
  WIKI_PLAN_NOT_COVERED,
  WIKI_PLAN_NOT_FOUND,
  WIKI_PLAN_NOT_PROTECTED_NOTE,
  WIKI_PLAN_ONE_PER_LINE,
  WIKI_PLAN_PASSED,
  WIKI_PLAN_PROPOSED_BY,
  WIKI_PLAN_PROTECTED,
  WIKI_PLAN_PROTECTED_NOTE,
  WIKI_PLAN_PROTECTED_SWITCH,
  WIKI_PLAN_QUESTION,
  WIKI_PLAN_REDRAFT,
  WIKI_PLAN_REDRAFT_ALREADY,
  WIKI_PLAN_REDRAFT_ASKED,
  WIKI_PLAN_REDRAFT_GO,
  WIKI_PLAN_REDRAFT_PLACEHOLDER,
  WIKI_PLAN_REDRAFT_TITLE,
  WIKI_PLAN_REFS_SHOWN,
  WIKI_PLAN_REFS_SHOWN_PHONE,
  WIKI_PLAN_REJECT,
  WIKI_PLAN_SAVE_DRAFT,
  WIKI_PLAN_SECTIONS,
  WIKI_PLAN_SESSION_ANCHORS,
  WIKI_PLAN_SESSION_EVIDENCE,
  WIKI_PLAN_SESSION_KEYWORDS,
  WIKI_PLAN_SESSION_KINDS,
  WIKI_PLAN_SESSION_PROJECTS,
  WIKI_PLAN_SESSION_TIME,
  WIKI_PLAN_SESSION_TOPICS,
  WIKI_PLAN_SOURCES,
  WIKI_PLAN_SOURCE_CODE,
  WIKI_PLAN_SOURCE_CONTRACTS,
  WIKI_PLAN_SOURCE_DOCS,
  WIKI_PLAN_SOURCE_SESSIONS,
  WIKI_PLAN_SOURCE_SESSIONS_SHORT,
  WIKI_PLAN_STATUS_LABELS,
  WIKI_PLAN_TITLE,
  WIKI_PLAN_OP_LABELS,
  WIKI_PLAN_WHY,
  WIKI_PLAN_WRITTEN_FOR,
  wikiPlanAcceptConfirms,
  wikiPlanAcceptNote,
  wikiPlanAndMore,
  wikiPlanCategoryLine,
  wikiPlanChange,
  wikiPlanChangeAdded,
  wikiPlanChangeCount,
  wikiPlanChangesHint,
  wikiPlanChars,
  wikiPlanCompare,
  wikiPlanConfirmed,
  wikiPlanDefault,
  wikiPlanDiff,
  wikiPlanDocErrors,
  wikiPlanDocForm,
  wikiPlanDocEdit,
  wikiPlanDocLine,
  wikiPlanDocPath,
  wikiPlanDraftSaved,
  wikiPlanDrawsOn,
  wikiPlanEditBody,
  wikiPlanEditHead,
  wikiPlanEditSection,
  wikiPlanEditTitle,
  wikiPlanEmptyNote,
  wikiPlanEmptyText,
  wikiPlanErrorCount,
  wikiPlanFailedHint,
  wikiPlanFailedJob,
  wikiPlanFromFailedJob,
  wikiPlanFromVersion,
  wikiPlanGate,
  wikiPlanJobCard,
  wikiPlanJobHead,
  wikiPlanLostLabel,
  wikiPlanLostSections,
  wikiPlanMeta,
  wikiPlanMovedTo,
  wikiPlanNewest,
  wikiPlanNextVersion,
  wikiPlanOpenJob,
  wikiPlanPath,
  wikiPlanProtectedKept,
  wikiPlanProtectedMove,
  wikiPlanProtectedMovePhone,
  wikiPlanRedraftNote,
  wikiPlanSaveNote,
  wikiPlanSectionChars,
  wikiPlanSectionEditBody,
  wikiPlanSectionLine,
  wikiPlanSectionMeta,
  wikiPlanSectionPath,
  wikiPlanSectionsHint,
  wikiPlanSourceFound,
  wikiPlanSourceLines,
  wikiPlanSourcesSummary,
  wikiPlanTime,
  wikiPlanVersionLabel,
  wikiPlanVersionRows,
  WIKI_PLAN_WRITING_NOW,
  type WikiPlanDocForm,
  type WikiPlanJob,
  type WikiPlanJobCard,
  type WikiPlanShown,
  type WikiPlanShownDoc,
  type WikiPlanShownSection,
  type WikiPlanState,
} from '../lib/wikiPlan';
import { wikiSettingsPath } from '../lib/wikiReviewMode';
import {
  acceptWikiPlanProposal,
  confirmWikiPlan,
  decideWikiPlanProposal,
  editWikiPlan,
  redraftWikiPlan,
  useWikiWrite,
  wikiPlanGateErrors,
} from '../lib/wikiWrites';
import { useToast } from '../lib/toast';

/**
 * The plan page (criterion 11's owner half, criterion 10 revised: mocks 21–22): the plan a wiki's
 * documents are written from, as the owner reviews, confirms and changes it.
 *
 * TOP TO BOTTOM, THE PHONE'S ORDER (`WIKI_PLAN_PAGE_SECTIONS`, held by `WikiPlanCopyParityTests`): the
 * crumb; the title with the version shown; where that version came from; Redraft…, Confirm plan and ···;
 * a failed draft's hint; the job's card — queued, drafting, held, failed, or the documents being
 * written; the gate's report; the changes a maintenance run proposed; the categories and documents.
 * On a desktop the actions stand in the title's row (a grid, the same DOM), and a document opens where
 * it is; on a phone a document, and then a section, is a page of its own.
 *
 * THE OWNER'S DOOR ONLY. Every write here is the JWT door's (`lib/wikiWrites.ts`): the server refuses a
 * request with a session header, and there is no MCP tool that confirms or accepts anything.
 *
 * WHAT THE PAGE SHOWS FIRST: a draft a job last failed with — the server stores nothing the gate refused,
 * so it is the job's own copy, numbered as the version it would have been, with Confirm plan off — then
 * a draft waiting, then the version in force. `?v=` shows any other.
 */

/** What the page reads: the plan, the version asked for, and the facts its job and head are said with. */
function usePlanPage(spaceId: string) {
  const [params] = useSearchParams();
  const asked = Number(params.get('v')) || null;
  const state = useQuery(wikiPlanQuery(spaceId));
  const versions = useQuery(wikiPlanVersionsQuery(spaceId));
  const directory = useQuery(wikiDocsQuery(spaceId));
  const space = useQuery(wikiSpaceQuery(spaceId));
  const maintenance = useWikiMaintenanceWhere(space.data);
  // Whether the server drafts the plan instead of a session on the maintenance provider (`health.executor`,
  // P9): the empty page's line under Draft plan names the System model while it does (owner's call 2026-10-08).
  const health = useQuery(wikiHealthQuery(spaceId));
  const plan = state.data;
  const failed = plan ? wikiPlanFailedJob(plan) : null;
  const failedNumber = plan && failed ? wikiPlanNextVersion(plan) : null;
  const stored = plan && asked !== null && asked !== failedNumber && asked !== plan.draft?.version && asked !== plan.confirmed?.version ? asked : null;
  const other = useQuery(wikiPlanVersionQuery(spaceId, stored));

  const shown = useMemo((): WikiPlanShown | null => {
    if (!plan) return null;
    if (asked === null) return wikiPlanDefault(plan);
    if (failed && asked === failedNumber) return wikiPlanFromFailedJob(failed, asked, wikiPlanNewest(plan)?.version ?? null);
    if (plan.draft?.version === asked) return wikiPlanFromVersion(plan.draft);
    if (plan.confirmed?.version === asked) return wikiPlanFromVersion(plan.confirmed);
    return other.data ? wikiPlanFromVersion(other.data) : null;
  }, [plan, asked, failed, failedNumber, other.data]);

  // What the shown version is held against: the version it revised, for the protection check and Compare.
  const base = useMemo((): WikiPlanShown | null => {
    if (!plan || !shown) return null;
    if (shown.status === 'failed') {
      const newest = wikiPlanNewest(plan);
      return newest ? wikiPlanFromVersion(newest) : null;
    }
    if (shown.status === 'draft' && plan.confirmed) return wikiPlanFromVersion(plan.confirmed);
    return null;
  }, [plan, shown]);

  const docs = directory.data?.plan ? directory.data.docs : null;
  const serverExecutes = health.data?.executor?.serverExecutes === true;
  return { asked, state, plan, versions, directory, docs, space, maintenance, serverExecutes, failed, failedNumber, shown, base, loading: state.isPending || (stored !== null && other.isPending) };
}

export function WikiPlanRoute({
  spaceId,
  spaceSlug,
  docSlug = null,
  section = null,
}: {
  spaceId: string;
  spaceSlug: string;
  /** A phone's document page, `/plan/d/:doc`, and its section page, `/plan/d/:doc/:n`. */
  docSlug?: string | null;
  section?: number | null;
}) {
  const page = usePlanPage(spaceId);
  if (page.state.isError) return <div className="wk-empty">The plan couldn’t be loaded. Check the connection, then try again.</div>;
  // A server from before the plan answers none: there is nothing to show or to ask for.
  if (page.state.data === null) return <div className="wk-empty">{WIKI_PLAN_NONE}</div>;
  if (!page.plan || page.loading) return <div className="wk-pl-page" aria-busy />;
  if (docSlug && page.shown) {
    const doc = page.shown.docs.find((row) => row.slug === docSlug);
    if (!doc) return <div className="wk-empty">That document is not in this version of the plan.</div>;
    if (section !== null) {
      const at = section - 1;
      const row = doc.sections[at];
      if (!row) return <div className="wk-empty">That section is not in this document.</div>;
      return <WikiPlanSectionPage page={page} spaceId={spaceId} spaceSlug={spaceSlug} doc={doc} section={row} index={at} />;
    }
    return <WikiPlanDocPage page={page} spaceId={spaceId} spaceSlug={spaceSlug} doc={doc} />;
  }
  return <WikiPlanPage page={page} spaceId={spaceId} spaceSlug={spaceSlug} />;
}

type PlanPage = ReturnType<typeof usePlanPage>;

function WikiPlanPage({ page, spaceId, spaceSlug }: { page: PlanPage; spaceId: string; spaceSlug: string }) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const navigate = useNavigate();
  const message = useToast();
  const plan = page.plan!;
  const shown = page.shown;
  const [redrafting, setRedrafting] = useState(false);
  const [editing, setEditing] = useState<{ doc: WikiPlanShownDoc } | null>(null);
  const [comparing, setComparing] = useState(false);
  const open = wikiPlanOpenJob(plan);
  const now = Date.now();
  const inForce = shown?.status === 'confirmed' && plan.confirmed?.version === shown.version;
  const card = wikiPlanJobCard(plan.job, {
    now,
    runnerOnline: page.maintenance.runnerOnline,
    serverExecutes: page.serverExecutes,
    failed: shown?.status === 'failed' ? page.failed : null,
    inForce,
    directory: page.directory.data,
  });
  const confirm = useWikiWrite(({ version }: { version: number }) => confirmWikiPlan(spaceId, version));
  const draft = useWikiWrite(() => redraftWikiPlan(spaceId, null));
  const diff = comparing && shown && page.base ? wikiPlanDiff(shown, page.base) : null;
  const canEdit = !!shown && (shown.status === 'draft' || inForce) && wikiPlanNewest(plan)?.version === shown.version;
  const showsChanges = !!shown && shown.status !== 'superseded' && plan.proposals.length > 0;

  const onConfirm = async () => {
    if (!shown) return;
    try {
      await confirm.mutateAsync({ version: shown.version });
      message.success(wikiPlanConfirmed(shown.version));
      navigate(wikiPlanPath(spaceSlug));
    } catch (error) {
      message.error("Couldn't confirm the plan", error instanceof Error ? error.message : undefined);
    }
  };
  const onDraft = async () => {
    try {
      const answer = await draft.mutateAsync(undefined);
      message.success(answer.created ? WIKI_PLAN_REDRAFT_ASKED : WIKI_PLAN_REDRAFT_ALREADY);
    } catch (error) {
      message.error("Couldn't draft the plan", error instanceof Error ? error.message : undefined);
    }
  };

  const moreItems = [
    ...(shown && page.base && shown.version !== page.base.version
      ? [{ key: 'compare', label: comparing ? WIKI_PLAN_HIDE_COMPARE : wikiPlanCompare(page.base.version), onSelect: () => setComparing(!comparing) }]
      : []),
  ];

  return (
    <div className="wk-pl-page">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          <RightOutlined className="ic" />
          <span>{WIKI_PLAN_TITLE}</span>
        </div>
        <WikiContentsButton />
      </div>
      <div className="wk-pl-head">
        <div className="wk-pl-titlerow">
          <h1 className="t-title">{WIKI_PLAN_TITLE}</h1>
          {shown && <PlanVersionMenu page={page} spaceSlug={spaceSlug} />}
        </div>
        <div className="wk-pl-meta">
          {shown ? (
            <>
              {wikiPlanMeta(shown, { job: shown.status === 'failed' ? page.failed : open ?? plan.job, docs: inForce ? page.docs : null }).map((part, i) => (
                <Fragment key={part}>
                  {i > 0 && <span className="sep">·</span>}
                  <span>{part}</span>
                </Fragment>
              ))}
              {page.base && shown.version !== page.base.version && !phone && (
                <>
                  <span className="sep">·</span>
                  <button type="button" className="lk" onClick={() => setComparing(!comparing)}>
                    {comparing ? WIKI_PLAN_HIDE_COMPARE : wikiPlanCompare(page.base.version)}
                  </button>
                </>
              )}
            </>
          ) : open ? (
            <span>{wikiPlanJobHead(open)}</span>
          ) : (
            <span>{WIKI_PLAN_NONE}</span>
          )}
        </div>
        {shown && (
          <div className="wk-pl-acts">
            {(shown.status === 'draft' || shown.status === 'failed') && (
              <Button variant="primary" disabled={shown.status === 'failed' || confirm.isPending} loading={confirm.isPending} onClick={onConfirm}>
                {WIKI_PLAN_CONFIRM}
              </Button>
            )}
            {shown.status !== 'superseded' && (
              <Button icon={<SyncOutlined />} onClick={() => setRedrafting(true)} disabled={!!open}>
                {WIKI_PLAN_REDRAFT}
              </Button>
            )}
            {moreItems.length > 0 && (
              <Menu items={moreItems} trigger={<Button icon={<EllipsisOutlined />} aria-label="More" />} />
            )}
          </div>
        )}
      </div>
      {shown?.status === 'failed' && <div className="wk-pl-hint">{wikiPlanFailedHint(plan.confirmed?.version ?? null)}</div>}

      {card && <PlanJobCard card={card} spaceSlug={spaceSlug} solo={!!shown && card.look === 'failed'} />}
      {!shown && !open && (
        <PlanEmpty where={page.maintenance.where} provider={page.maintenance.provider} serverExecutes={page.serverExecutes} busy={draft.isPending} onDraft={onDraft} />
      )}

      {shown && (shown.status === 'draft' || shown.status === 'failed') && (
        <PlanGateReport shown={shown} base={page.base} job={shown.status === 'failed' ? page.failed : plan.job} phone={phone} />
      )}

      {showsChanges && (
        <PlanChanges plan={plan} spaceId={spaceId} spaceSlug={spaceSlug} base={page.plan?.confirmed ? wikiPlanFromVersion(page.plan.confirmed) : null} onEdit={(doc) => setEditing({ doc })} />
      )}

      {shown && (
        <PlanDocuments
          shown={shown}
          base={page.base}
          plan={plan}
          spaceSlug={spaceSlug}
          phone={phone}
          heading={showsChanges && inForce}
          diff={diff}
          canEdit={canEdit}
          onEdit={(doc) => setEditing({ doc })}
        />
      )}

      <PlanRedraftModal
        open={redrafting}
        onClose={() => setRedrafting(false)}
        spaceId={spaceId}
        provider={page.maintenance.provider}
        serverExecutes={page.serverExecutes}
        plan={plan}
        protectedDocs={(page.plan && wikiPlanNewest(page.plan) ? wikiPlanFromVersion(wikiPlanNewest(page.plan)!) : null)?.docs.filter((doc) => doc.protected).map((doc) => doc.number) ?? []}
      />
      {editing && shown && editing.doc.stored && (
        <PlanEditDrawer
          spaceId={spaceId}
          spaceSlug={spaceSlug}
          plan={plan}
          shown={shown}
          doc={editing.doc}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** The version menu beside the title (mock 21 strip): every stored version, and a failed draft over them. */
function PlanVersionMenu({ page, spaceSlug }: { page: PlanPage; spaceSlug: string }) {
  const navigate = useNavigate();
  const shown = page.shown!;
  const rows = wikiPlanVersionRows(page.versions.data ?? [], page.failed && page.failedNumber ? { version: page.failedNumber, at: page.failed.endedAt } : null);
  const items = rows.map((row) => ({
    key: String(row.version),
    label: (
      <span className="wk-pl-verrow">
        <span className="v">{wikiPlanVersionLabel(row.version)}</span>
        <span className="d">{row.note}</span>
        <span className={`tdp-badge tone-${row.status === 'confirmed' ? 'blue' : 'muted'}`}>{WIKI_PLAN_STATUS_LABELS[row.status]}</span>
      </span>
    ),
    selected: row.version === shown.version,
    onSelect: () => navigate(wikiPlanPath(spaceSlug, row.version)),
  }));
  return (
    <Menu
      items={items}
      popupClassName="wk-pl-vermenu"
      trigger={
        <button type="button" className="wk-pl-ver">
          <span>{wikiPlanVersionLabel(shown.version)}</span>
          <span className={`tdp-badge tone-${shown.status === 'confirmed' ? 'blue' : 'muted'}`}>{WIKI_PLAN_STATUS_LABELS[shown.status]}</span>
          <DownOutlined className="ic" />
        </button>
      }
    />
  );
}

/** The job's card (mock 21 ⑨, 22 ⑩): grey queued, blue drafting and writing, amber held, red failed. */
function PlanJobCard({ card, spaceSlug, solo }: { card: WikiPlanJobCard; spaceSlug: string; solo: boolean }) {
  const tone = card.look === 'queued' ? 'wait' : card.look === 'held' ? 'held' : card.look === 'failed' ? 'fail' : 'run';
  const icon =
    card.look === 'queued' ? (
      <ClockCircleOutlined className="ic" />
    ) : card.look === 'held' ? (
      <ExclamationCircleFilled className="ic" />
    ) : card.look === 'failed' ? (
      <CloseCircleFilled className="ic" />
    ) : (
      <SyncOutlined spin className="ic" />
    );
  const link = card.link;
  const to = link?.to === 'run' && link.sessionId ? `/sessions/${encodeId(link.sessionId)}` : link?.to === 'settings' ? wikiSettingsPath(spaceSlug) : link?.to === 'runners' ? '/infrastructure' : null;
  return (
    <section className={`wk-pl-check wk-pl-job solo ${tone}${solo ? ' failed-solo' : ''}`} role="status">
      <div className="h">
        {icon}
        <b>{card.title}</b>
        <span className="sub">{card.text}</span>
        {link && to && (
          <Link className="r lk" to={to}>
            {link.label}
          </Link>
        )}
      </div>
      {card.progress && (
        <div className="wk-pl-prog">
          <div className="bar">
            <i style={{ width: `${Math.round((card.progress.done / Math.max(1, card.progress.total)) * 100)}%` }} />
          </div>
          {card.progress.now && (
            <div className="next">
              {WIKI_PLAN_WRITING_NOW} <b>{card.progress.now}</b>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** No plan yet (mock 21 ⑨ A, 22 ①): what a plan is, Draft plan, and where and how long it runs. */
function PlanEmpty({
  where,
  provider,
  serverExecutes,
  busy,
  onDraft,
}: {
  where: string | null;
  provider: string | null;
  serverExecutes: boolean;
  busy: boolean;
  onDraft: () => void;
}) {
  return (
    <div className="wk-pl-empty">
      <ProfileOutlined className="ic" />
      <b>{WIKI_PLAN_EMPTY_TITLE}</b>
      <p>{wikiPlanEmptyText(provider, serverExecutes)}</p>
      <Button variant="primary" loading={busy} onClick={onDraft}>
        {WIKI_PLAN_DRAFT}
      </Button>
      <div className="note">{wikiPlanEmptyNote(where, provider, serverExecutes)}</div>
    </div>
  );
}

/** The gate's report (mock 21 ①, E): four rows, and the references not found listed where they were named. */
function PlanGateReport({ shown, base, job, phone }: { shown: WikiPlanShown; base: WikiPlanShown | null; job: WikiPlanJob | null; phone: boolean }) {
  const gate = wikiPlanGate(shown, { base, job });
  const [all, setAll] = useState(false);
  const refs = all ? gate.refs : gate.refs.slice(0, phone ? WIKI_PLAN_REFS_SHOWN_PHONE : WIKI_PLAN_REFS_SHOWN);
  const hidden = gate.refs.length - refs.length;
  return (
    <section className={`wk-pl-check ${gate.passed ? 'pass' : 'fail'}`}>
      <div className="h">
        {gate.passed ? <CheckCircleFilled className="ic" /> : <CloseCircleFilled className="ic" />}
        <b>{gate.title}</b>
        <span className="sub">{gate.line}</span>
        {gate.aside && <span className="r">{gate.aside}</span>}
      </div>
      {gate.rows.map((row) => (
        <div className={`wk-pl-ck ${row.ok ? 'is-ok' : 'is-bad'}`} key={row.check}>
          {row.ok ? <CheckCircleFilled className="ic" /> : <CloseCircleFilled className="ic" />}
          <span className="n">{row.title}</span>
          <span className="r">{row.text}</span>
          {row.check === 'references' && gate.refs.length > 0 && (
            <div className="wk-pl-errs">
              <div className="by">
                {gate.refKinds.map((kind) => {
                  const [n, ...rest] = kind.split(' ');
                  return (
                    <span key={kind}>
                      <b>{n}</b> {rest.join(' ')}
                    </span>
                  );
                })}
              </div>
              {refs.map((ref, i) => (
                <div className="wk-pl-err" key={`${ref.where}:${i}`}>
                  <span className="at">{ref.where}</span>
                  <span className="k">{ref.kind}</span>
                  <span className="m">
                    <code>{ref.ref}</code> <span className="why">— {ref.why}</span>
                  </span>
                </div>
              ))}
              {hidden > 0 && (
                <button type="button" className="more" onClick={() => setAll(true)}>
                  {wikiShowMore(hidden)}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// ── The changes proposed ───────────────────────────────────────────────────────────────────────

function PlanChanges({
  plan,
  spaceId,
  spaceSlug,
  base,
  onEdit,
}: {
  plan: WikiPlanState;
  spaceId: string;
  spaceSlug: string;
  base: WikiPlanShown | null;
  onEdit: (doc: WikiPlanShownDoc) => void;
}) {
  return (
    <section className="wk-pl-changes">
      <div className="h">
        <h2>{WIKI_PLAN_CHANGES}</h2>
        <span className="n">{wikiPlanChangesHint(plan.proposals.length)}</span>
      </div>
      {plan.proposals.map((proposal) => (
        <PlanChangeCard key={proposal.id} proposal={proposal} plan={plan} spaceId={spaceId} spaceSlug={spaceSlug} base={base} onEdit={onEdit} />
      ))}
    </section>
  );
}

/**
 * One change a maintenance run proposed (mock 21 ②): Review's card, with the plan's parts — why, the change
 * to the document's sections, the new sections' sources, the facts it came from, the gate it passed.
 *
 * ACCEPT, BY WHAT IS WAITING (mock 21 ⑩). With no other draft, one press accepts and confirms: the accept
 * makes a draft, and only a draft the gate passed is then confirmed — two requests, and a refusal of the
 * first leaves the plan as it was, its errors listed here. With a draft waiting, accepting adds the change
 * to a new draft and the page moves to it, for the owner to confirm with the rest.
 */
function PlanChangeCard({
  proposal,
  plan,
  spaceId,
  spaceSlug,
  base,
  onEdit,
}: {
  proposal: WikiPlanProposal;
  plan: WikiPlanState;
  spaceId: string;
  spaceSlug: string;
  base: WikiPlanShown | null;
  onEdit: (doc: WikiPlanShownDoc) => void;
}) {
  const navigate = useNavigate();
  const message = useToast();
  const entries = useQuery(wikiEntriesQuery(spaceId));
  const [refused, setRefused] = useState<string[] | null>(null);
  const change = wikiPlanChange(proposal, base);
  const confirms = wikiPlanAcceptConfirms(plan);
  const accept = useWikiWrite(({ confirm }: { confirm: boolean }) => acceptWikiPlanProposal(spaceId, proposal.id, confirm));
  const reject = useWikiWrite(() => decideWikiPlanProposal(proposal.id, 'reject'));
  const titles = new Map((entries.data ?? []).map((entry) => [entry.id, entry.title]));
  const sources = change.added.flatMap((section) => wikiPlanSourceLines(section.sources));
  const facts = proposal.facts.slice(0, WIKI_PLAN_FACTS_SHOWN);
  const more = proposal.facts.length - facts.length;

  const run = async (edit: boolean) => {
    setRefused(null);
    try {
      const answer = await accept.mutateAsync({ confirm: confirms && !edit });
      if (answer.confirmed) {
        message.success(wikiPlanConfirmed(answer.confirmed.version));
        navigate(wikiPlanPath(spaceSlug));
      } else {
        message.success(wikiPlanChangeAdded(answer.draft.version));
        navigate(wikiPlanPath(spaceSlug, answer.draft.version));
        if (edit) {
          const doc = wikiPlanFromVersion(answer.draft).docs.find((row) => row.slug === proposal.change.doc.slug);
          if (doc) onEdit(doc);
        }
      }
    } catch (error) {
      const errors = wikiPlanGateErrors(error);
      if (errors) setRefused(errors.map((e) => `${e.path} ${e.message}`));
      else message.error(edit ? "Couldn't edit the change" : "Couldn't accept the change", error instanceof Error ? error.message : undefined);
    }
  };
  const onReject = async () => {
    try {
      await reject.mutateAsync(undefined);
      message.success(WIKI_PLAN_CHANGE_REJECTED);
    } catch (error) {
      message.error("Couldn't reject the change", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <div className="approval-card wk-prop wk-pl-prop">
      <div className="approval-head">
        <span className="wk-op add plan">{WIKI_PLAN_OP_LABELS[change.op]}</span>
        <span className="kind">{change.target}</span>
        <span className="by">
          · {WIKI_PLAN_PROPOSED_BY} <b className="lk">{WIKI_HISTORY_MAINTENANCE}</b>
        </span>
        <span className="age">{relTime(proposal.createdAt)}</span>
      </div>
      <div className="approval-body">
        <div className="wk-prop-t">{change.title}</div>
        <div className="wk-pkv">
          <div className="k">{WIKI_PLAN_WHY}</div>
          <div className="v">{proposal.reason}</div>
          {(change.rows.length > 0 || change.renumber) && (
            <>
              <div className="k">{WIKI_PLAN_CHANGE}</div>
              <div className="v">
                <div className="wk-pl-new">
                  {change.rows.map((row) => (
                    <div className={`row ${row.mark === 'same' ? 'ctx' : row.mark}`} key={`${row.mark}:${row.n}`}>
                      <span className="n">{row.n}</span>
                      <span className="t">{row.title}</span>
                      <span className="ty">{row.note}</span>
                    </div>
                  ))}
                  {change.renumber && (
                    <div className="row ctx">
                      <span className="n" />
                      <span className="t">{change.renumber}</span>
                      <span className="ty" />
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          {sources.length > 0 && (
            <>
              <div className="k">{WIKI_PLAN_SOURCES}</div>
              <div className="v">
                {sources.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </>
          )}
          {facts.length > 0 && (
            <>
              <div className="k">{WIKI_PLAN_FROM}</div>
              <div className="v">
                {facts.map((fact) =>
                  fact.kind === 'session' ? (
                    <WikiSourceCard key={fact.id} kind="session" id={fact.id} />
                  ) : fact.kind === 'entry' ? (
                    <div className="wk-pl-fact" key={fact.id}>
                      <Link to={wikiEntryPath(spaceSlug, fact.id)}>{titles.get(fact.id) ?? fact.id}</Link>
                    </div>
                  ) : (
                    // A design document that landed on origin/main: the commit that added it, by its sha — no page of Orbit's.
                    <div className="wk-pl-fact commit" key={fact.id}>
                      <BranchesOutlined /> <code>{shortSha(fact.id)}</code>
                    </div>
                  ),
                )}
                {more > 0 && <div className="wk-pl-more">{wikiPlanAndMore(more)}</div>}
              </div>
            </>
          )}
          <div className="k">{WIKI_PLAN_CHECK}</div>
          <div className="v">
            <span className="wk-pl-okline">
              <CheckCircleFilled /> {WIKI_PLAN_PASSED}
            </span>
          </div>
        </div>
        {refused && (
          <div className="wk-pl-refused">
            <b>{WIKI_PLAN_ACCEPT_REFUSED}</b>
            <ul>
              {refused.slice(0, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="card-actions approval-actions">
        <button type="button" className="card-action card-action--primary" disabled={accept.isPending} onClick={() => void run(false)}>
          {WIKI_PLAN_ACCEPT}
        </button>
        <button type="button" className="card-action card-action--secondary" disabled={accept.isPending} onClick={() => void run(true)}>
          {WIKI_PLAN_EDIT}
        </button>
        <button type="button" className="card-action card-action--secondary" disabled={reject.isPending} onClick={() => void onReject()}>
          {WIKI_PLAN_REJECT}
        </button>
        <span className="grow" />
        <span className="note">{wikiPlanAcceptNote(plan, change.op)}</span>
      </div>
    </div>
  );
}

// ── Categories, documents, sections ───────────────────────────────────────────────────────────

function PlanDocuments({
  shown,
  base,
  plan,
  spaceSlug,
  phone,
  heading,
  diff,
  canEdit,
  onEdit,
}: {
  shown: WikiPlanShown;
  base: WikiPlanShown | null;
  plan: WikiPlanState;
  spaceSlug: string;
  phone: boolean;
  heading: boolean;
  diff: ReturnType<typeof wikiPlanDiff> | null;
  canEdit: boolean;
  onEdit: (doc: WikiPlanShownDoc) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const changes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const proposal of plan.proposals) counts.set(proposal.change.doc.slug, (counts.get(proposal.change.doc.slug) ?? 0) + 1);
    return counts;
  }, [plan.proposals]);
  const version = shown.status === 'failed' || shown.status === 'superseded' || shown.version !== (plan.draft ?? plan.confirmed)?.version ? shown.version : null;
  return (
    <div className="wk-pl-docs">
      {heading && (
        <div className="wk-pl-docs-h">
          <h2>{WIKI_PLAN_DOCUMENTS}</h2>
          <span className="n">{WIKI_PLAN_IN_FORCE}</span>
          <span className="c">
            {wikiCount(shown.docs.length)} {shown.docs.length === 1 ? 'document' : 'documents'}
          </span>
        </div>
      )}
      {diff && <div className="wk-pl-hint">{diff.line}</div>}
      {shown.categories.map((category) => (
        <section className="wk-pl-cat" key={category.key}>
          <div className="wk-pl-cat-h">
            <span className="no">{category.number}</span>
            <b>{category.title}</b>
            <span className="q">{category.question}</span>
            <span className="c">{wikiPlanCategoryLine(category)}</span>
          </div>
          {category.docs.map((doc) => {
            const errors = wikiPlanDocErrors(shown, doc).length;
            const marked = diff?.docs.get(doc.slug);
            if (phone) {
              return (
                <WikiDocRow
                  key={doc.slug}
                  to={wikiPlanDocPath(spaceSlug, doc.slug, version)}
                  number={doc.number}
                  title={doc.title}
                  locked={doc.protected}
                  line={doc.question}
                  extra={
                    <span className="l3">
                      {errors > 0 && <span className="errn">{wikiPlanErrorCount(errors)}</span>}
                      {errors > 0 && ' · '}
                      {wikiPlanDocLine(doc)}
                    </span>
                  }
                />
              );
            }
            const isOpen = open === doc.slug;
            return (
              <div className={`wk-pl-doc${isOpen ? ' open' : ''}`} key={doc.slug}>
                <button type="button" className="caret" aria-expanded={isOpen} aria-label={doc.title} onClick={() => setOpen(isOpen ? null : doc.slug)}>
                  {isOpen ? <DownOutlined /> : <RightOutlined />}
                </button>
                <span className="no">{doc.number}</span>
                <button type="button" className="main" onClick={() => setOpen(isOpen ? null : doc.slug)}>
                  <span className="t">
                    <span className="tt">{doc.title}</span>
                    {doc.protected && <LockOutlined className="ic lock" />}
                    {marked && marked !== 'same' && <span className={`wk-pl-diff ${marked}`}>{WIKI_PLAN_DIFF_LABELS[marked]}</span>}
                  </span>
                  {!isOpen && <span className="q">{doc.question}</span>}
                </button>
                <span className="meta">
                  {errors > 0 && (
                    <span className="errn">
                      <CloseCircleFilled className="ic" /> {wikiPlanErrorCount(errors)}
                    </span>
                  )}
                  {(changes.get(doc.slug) ?? 0) > 0 && <span className="wk-pl-chg">{wikiPlanChangeCount(changes.get(doc.slug)!)}</span>}
                  <span>{wikiPlanDocLine(doc)}</span>
                  {isOpen && canEdit && doc.stored && (
                    <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(doc)}>
                      {WIKI_PLAN_EDIT}
                    </Button>
                  )}
                </span>
                {isOpen && (
                  <div className="wk-pl-body">
                    <PlanDocFields shown={shown} doc={doc} />
                    <PlanSections shown={shown} base={base} doc={doc} />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {diff && diff.removed.length > 0 && (
        <section className="wk-pl-cat">
          {diff.removed.map((doc) => (
            <div className="wk-pl-doc gone" key={doc.slug}>
              <span className="caret" />
              <span className="no">{doc.number}</span>
              <span className="main">
                <span className="t">
                  <span className="tt">{doc.title}</span>
                </span>
              </span>
              <span className="meta" />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** A document's fields (mock 21 ④): what it answers, for whom, what it covers and leaves out, how long, protected, what it draws on. */
function PlanDocFields({ shown, doc }: { shown: WikiPlanShown; doc: WikiPlanShownDoc }) {
  const numbers = new Map(shown.docs.map((row) => [row.slug, row.number]));
  return (
    <div className="wk-pl-kv">
      <div className="k">{WIKI_PLAN_QUESTION}</div>
      <div className="v">
        <b>{doc.question}</b>
      </div>
      <div className="k">{WIKI_PLAN_WRITTEN_FOR}</div>
      <div className="v">
        <ul>
          {doc.audience.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="k">{WIKI_PLAN_COVERS}</div>
      <div className="v">
        <ul>
          {doc.scopeIn.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {doc.scopeOut.length > 0 && (
        <>
          <div className="k">{WIKI_PLAN_NOT_COVERED}</div>
          <div className="v">
            <ul>
              {doc.scopeOut.map((out) => (
                <li key={out.text}>
                  {out.text}
                  {out.docs.map((slug) => (
                    <span className="see" key={slug}>
                      {' '}
                      → {numbers.get(slug) ?? slug}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <div className="k">{WIKI_PLAN_LENGTH}</div>
      <div className="v">{wikiPlanChars(doc.length)}</div>
      <div className="k">{WIKI_PLAN_PROTECTED}</div>
      <div className="v">
        {doc.protected ? (
          <span className="lockline">
            <LockOutlined className="ic" /> {WIKI_PLAN_PROTECTED_NOTE}
          </span>
        ) : (
          <span className="dim">{WIKI_PLAN_NOT_PROTECTED_NOTE}</span>
        )}
      </div>
      <div className="k">{WIKI_PLAN_DRAWS_ON}</div>
      <div className="v">{wikiPlanDrawsOn(doc)}</div>
    </div>
  );
}

/** A document's sections (mock 21 ④), each opening to its sources; a protected document's lost sections in red. */
function PlanSections({ shown, base, doc }: { shown: WikiPlanShown; base: WikiPlanShown | null; doc: WikiPlanShownDoc }) {
  const [open, setOpen] = useState<number | null>(null);
  const lost = shown.status === 'failed' ? wikiPlanLostSections(shown, base, doc.slug) : [];
  const rows: Array<{ kind: 'section'; index: number } | { kind: 'lost'; at: number }> = [];
  doc.sections.forEach((_, index) => {
    lost.forEach((row, at) => {
      if (row.number - 1 === index) rows.push({ kind: 'lost', at });
    });
    rows.push({ kind: 'section', index });
  });
  lost.forEach((row, at) => {
    if (row.number - 1 >= doc.sections.length) rows.push({ kind: 'lost', at });
  });
  return (
    <div className="wk-pl-secs">
      <div className="h">
        {WIKI_PLAN_SECTIONS} <span className="c">{wikiPlanSectionsHint(doc.sections.length)}</span>
      </div>
      {rows.map((row) =>
        row.kind === 'lost' ? (
          <div className="wk-pl-sec gone" key={`lost:${row.at}`}>
            <span className="n">−</span>
            <span className="t">{wikiPlanLostLabel(base?.version ?? 0, lost[row.at].number, lost[row.at].title)}</span>
            <span className="ty">{lost[row.at].movedTo ? wikiPlanMovedTo(lost[row.at].movedTo!) : ''}</span>
            <span className="len" />
            <span className="src" />
            <span className="why">
              <CloseCircleFilled className="ic" /> {wikiPlanProtectedMove(doc.number)}
            </span>
          </div>
        ) : (
          <PlanSectionRow
            key={row.index}
            shown={shown}
            doc={doc}
            section={doc.sections[row.index]}
            index={row.index}
            open={open === row.index}
            onToggle={() => setOpen(open === row.index ? null : row.index)}
          />
        ),
      )}
    </div>
  );
}

function PlanSectionRow({
  shown,
  doc,
  section,
  index,
  open,
  onToggle,
}: {
  shown: WikiPlanShown;
  doc: WikiPlanShownDoc;
  section: WikiPlanShownSection;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`wk-pl-sec${open ? ' open' : ''}`}>
      <span className="n">{index + 1}</span>
      <button type="button" className="t" aria-expanded={open} onClick={onToggle}>
        {section.title}
        <span className="cov">{section.covers}</span>
      </button>
      <span className="ty">{wikiSectionKindLabel(section.kind)}</span>
      <span className="len">{wikiPlanSectionChars(section.length)}</span>
      <span className="src">{wikiPlanSourcesSummary(section)}</span>
      {open && <PlanSources shown={shown} doc={doc} section={section} index={index} />}
    </div>
  );
}

function FoundMark({ found }: { found: boolean | null }) {
  if (found === null) return null;
  return <span className={found ? 'ok' : 'bad'}>{found ? WIKI_PLAN_FOUND : WIKI_PLAN_NOT_FOUND}</span>;
}

/** A section's sources (mock 21 ④, 22 ④⑤): design docs, code and contracts, each found or not; where to look in sessions. */
function PlanSources({ shown, doc, section, index, short = false }: { shown: WikiPlanShown; doc: WikiPlanShownDoc; section: WikiPlanShownSection; index: number; short?: boolean }) {
  const sessions = section.sources.sessions;
  return (
    <div className="wk-pl-src">
      {section.sources.docs.length > 0 && (
        <>
          <div className="g">{WIKI_PLAN_SOURCE_DOCS}</div>
          {section.sources.docs.map((source, k) => (
            <div className="r" key={`d${k}`}>
              <span className="p">
                <code>{source.path}</code>
                {source.section ? ` § ${source.section}` : ''}
              </span>
              <FoundMark found={wikiPlanSourceFound(shown, doc, index, 'docs', k)} />
            </div>
          ))}
        </>
      )}
      {section.sources.code.length > 0 && (
        <>
          <div className="g">{WIKI_PLAN_SOURCE_CODE}</div>
          {section.sources.code.map((source, k) => (
            <div className="r" key={`c${k}`}>
              <span className="p">
                <code>{source.path}</code>
                {source.symbols.length > 0 && <span className="sym"> · {source.symbols.join(' · ')}</span>}
              </span>
              <FoundMark found={wikiPlanSourceFound(shown, doc, index, 'code', k)} />
            </div>
          ))}
        </>
      )}
      {section.sources.contracts.length > 0 && (
        <>
          <div className="g">{WIKI_PLAN_SOURCE_CONTRACTS}</div>
          {section.sources.contracts.map((source, k) => (
            <div className="r" key={`k${k}`}>
              <span className="p">
                <code>{source.path}</code>
              </span>
              <FoundMark found={wikiPlanSourceFound(shown, doc, index, 'contracts', k)} />
            </div>
          ))}
        </>
      )}
      {sessions && (
        <>
          <div className="g">{short ? WIKI_PLAN_SOURCE_SESSIONS_SHORT : WIKI_PLAN_SOURCE_SESSIONS}</div>
          <div className="cond">
            {sessions.projects.length > 0 && (
              <>
                <span className="k">{WIKI_PLAN_SESSION_PROJECTS}</span>
                <span className="v">
                  {sessions.projects.map((project) => (
                    <span className="chip" key={project.id ?? project.title}>
                      {project.title}
                    </span>
                  ))}
                </span>
              </>
            )}
            <span className="k">{WIKI_PLAN_SESSION_TIME}</span>
            <span className="v">{wikiPlanTime(sessions.since, sessions.until)}</span>
            {sessions.keywords.length > 0 && (
              <>
                <span className="k">{WIKI_PLAN_SESSION_KEYWORDS}</span>
                <span className="v">
                  {sessions.keywords.map((word) => (
                    <span className="chip" key={word}>
                      {word}
                    </span>
                  ))}
                </span>
              </>
            )}
            {sessions.anchorPaths.length > 0 && (
              <>
                <span className="k">{WIKI_PLAN_SESSION_ANCHORS}</span>
                <span className="v">
                  {sessions.anchorPaths.map((path) => (
                    <code key={path}>{path}</code>
                  ))}
                </span>
              </>
            )}
            {sessions.entryKinds.length > 0 && (
              <>
                <span className="k">{WIKI_PLAN_SESSION_KINDS}</span>
                <span className="v">{sessions.entryKinds.join(' · ')}</span>
              </>
            )}
            {sessions.topics.length > 0 && (
              <>
                <span className="k">{WIKI_PLAN_SESSION_TOPICS}</span>
                <span className="v">{sessions.topics.join(' · ')}</span>
              </>
            )}
            {sessions.evidence && (
              <>
                <span className="k">{WIKI_PLAN_SESSION_EVIDENCE}</span>
                <span className="v">{sessions.evidence}</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── A phone's document and section pages (mock 22 ③–⑤) ─────────────────────────────────────────

function PlanSubCrumb({ spaceSlug, parent, parentTo }: { spaceSlug: string; parent: string; parentTo: string }) {
  return (
    <div className="wk-art-crumbrow">
      <div className="wk-crumb">
        <Link to={wikiPlanPath(spaceSlug)}>{WIKI_PLAN_TITLE}</Link>
        <RightOutlined className="ic" />
        <Link to={parentTo}>{parent}</Link>
      </div>
      <WikiContentsButton />
    </div>
  );
}

/** A plan document's own page on a phone (mock 22 ③): its number, title and lock; its line; its fields; its sections. */
function WikiPlanDocPage({ page, spaceId, spaceSlug, doc }: { page: PlanPage; spaceId: string; spaceSlug: string; doc: WikiPlanShownDoc }) {
  const shown = page.shown!;
  const plan = page.plan!;
  const [editing, setEditing] = useState(false);
  const errors = wikiPlanDocErrors(shown, doc).length;
  const version = shown.version !== (plan.draft ?? plan.confirmed)?.version || shown.status === 'failed' ? shown.version : null;
  const category = shown.categories.find((row) => row.key === doc.category);
  const canEdit = (shown.status === 'draft' || shown.status === 'confirmed') && wikiPlanNewest(plan)?.version === shown.version && !!doc.stored;
  const lost = shown.status === 'failed' ? wikiPlanLostSections(shown, page.base, doc.slug) : [];
  return (
    <div className="wk-pl-page wk-pl-docpage">
      <PlanSubCrumb spaceSlug={spaceSlug} parent={category ? `${category.number} ${category.title}` : WIKI_PLAN_TITLE} parentTo={wikiPlanPath(spaceSlug, version)} />
      <div className="wk-pl-titlerow">
        <h1 className="t-title">
          {doc.number} {doc.title}
          {doc.protected && <LockOutlined className="ic lock" />}
        </h1>
        {canEdit && <Button icon={<EditOutlined />} aria-label={WIKI_PLAN_EDIT} onClick={() => setEditing(true)} />}
      </div>
      <div className="wk-pl-meta">
        <span>
          {wikiPlanVersionLabel(shown.version)} · {WIKI_PLAN_STATUS_LABELS[shown.status]}
        </span>
        {errors > 0 && (
          <>
            <span className="sep">·</span>
            <span className="errn">{wikiPlanErrorCount(errors)}</span>
          </>
        )}
        <span className="sep">·</span>
        <span>{wikiPlanDocLine(doc)}</span>
      </div>
      <PlanDocFields shown={shown} doc={doc} />
      <div className="wk-pl-secs phone">
        <div className="h">
          {WIKI_PLAN_SECTIONS} <span className="c">{wikiCount(doc.sections.length)}</span>
        </div>
        {doc.sections.map((section, index) => (
          <Fragment key={index}>
            {lost
              .filter((row) => row.number - 1 === index)
              .map((row) => (
                <div className="wk-pl-sec gone phone" key={`lost:${row.number}`}>
                  <span className="t">− {wikiPlanLostLabel(page.base?.version ?? 0, row.number, row.title)}</span>
                  <span className="why">{wikiPlanProtectedMovePhone(row.movedTo, doc.number)}</span>
                </div>
              ))}
            <Link className="wk-pl-sec phone" to={wikiPlanSectionPath(spaceSlug, doc.slug, index, version)}>
              <span className="n">{index + 1}</span>
              <span className="t">
                {section.title}
                <span className="cov">{wikiPlanSectionLine(section)}</span>
              </span>
              <RightOutlined className="chev" />
            </Link>
          </Fragment>
        ))}
      </div>
      {editing && (
        <PlanEditDrawer spaceId={spaceId} spaceSlug={spaceSlug} plan={plan} shown={shown} doc={doc} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

/** A plan section's own page on a phone (mock 22 ④⑤): its title, kind and length, what it covers, its sources. */
function WikiPlanSectionPage({
  page,
  spaceId,
  spaceSlug,
  doc,
  section,
  index,
}: {
  page: PlanPage;
  spaceId: string;
  spaceSlug: string;
  doc: WikiPlanShownDoc;
  section: WikiPlanShownSection;
  index: number;
}) {
  const shown = page.shown!;
  const plan = page.plan!;
  const [editing, setEditing] = useState(false);
  const version = shown.version !== (plan.draft ?? plan.confirmed)?.version || shown.status === 'failed' ? shown.version : null;
  const canEdit = (shown.status === 'draft' || shown.status === 'confirmed') && wikiPlanNewest(plan)?.version === shown.version && !!doc.stored;
  return (
    <div className="wk-pl-page wk-pl-secpage">
      <PlanSubCrumb spaceSlug={spaceSlug} parent={doc.number} parentTo={wikiPlanDocPath(spaceSlug, doc.slug, version)} />
      <div className="wk-pl-titlerow">
        <h1 className="t-title">
          §{index + 1} {section.title}
        </h1>
        {canEdit && <Button icon={<EditOutlined />} aria-label={WIKI_PLAN_EDIT} onClick={() => setEditing(true)} />}
      </div>
      <div className="wk-pl-meta">
        <span>{wikiPlanSectionMeta(shown, section)}</span>
      </div>
      <div className="wk-pl-kv">
        <div className="k">{WIKI_PLAN_COVERS}</div>
        <div className="v">{section.covers}</div>
      </div>
      <PlanSources shown={shown} doc={doc} section={section} index={index} short />
      {editing && doc.stored && (
        <PlanSectionEditModal
          spaceId={spaceId}
          plan={plan}
          shown={shown}
          doc={doc}
          index={index}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// ── Redraft… ───────────────────────────────────────────────────────────────────────────────────

/** Redraft the plan (mock 21 ⑧, 22 ⑧): what to change, in the owner's words; empty is a fresh draft. */
function PlanRedraftModal({
  open,
  onClose,
  spaceId,
  provider,
  serverExecutes,
  plan,
  protectedDocs,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  provider: string | null;
  serverExecutes: boolean;
  plan: WikiPlanState;
  protectedDocs: string[];
}) {
  const message = useToast();
  const [words, setWords] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const redraft = useWikiWrite((instructions: string) => redraftWikiPlan(spaceId, instructions));
  const newest = wikiPlanNewest(plan);
  const submit = async () => {
    try {
      const answer = await redraft.mutateAsync(words);
      message.success(answer.created ? WIKI_PLAN_REDRAFT_ASKED : WIKI_PLAN_REDRAFT_ALREADY);
      setWords('');
      onClose();
    } catch (error) {
      message.error("Couldn't redraft the plan", error instanceof Error ? error.message : undefined);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="wk-pl-modal-t">
          <SyncOutlined className="ic" /> {WIKI_PLAN_REDRAFT_TITLE}
        </span>
      }
      initialFocus={field}
      className="wk-pl-redraft-dialog"
      footer={
        <>
          <Button onClick={onClose}>{WIKI_PLAN_CANCEL}</Button>
          <Button variant="primary" loading={redraft.isPending} onClick={() => void submit()}>
            {WIKI_PLAN_REDRAFT_GO}
          </Button>
        </>
      }
    >
      <p className="wk-pl-modal-p">{wikiPlanRedraftNote(provider, newest ? { version: newest.version, inForce: newest.status === 'confirmed' } : null, serverExecutes)}</p>
      <Textarea ref={field} value={words} onChange={(event) => setWords(event.target.value)} rows={4} placeholder={WIKI_PLAN_REDRAFT_PLACEHOLDER} />
      {protectedDocs.length > 0 && <div className="wk-pl-modal-note">{wikiPlanProtectedKept(protectedDocs)}</div>}
    </Dialog>
  );
}

// ── Edit ───────────────────────────────────────────────────────────────────────────────────────

const KIND_OPTIONS = WIKI_PLAN_SECTION_KINDS.map((kind) => ({ value: kind, label: wikiSectionKindLabel(kind) }));

/**
 * Edit one document (mock 21 ⑦, 22 ⑨): its title, question, readers, what it covers, length, protection and
 * sections — dragged into a new order, given a kind, taken out, or added. Saving makes a new draft, which
 * goes through the gate again; the sections it kept keep their sources, and the next run finds material
 * for the ones it added.
 */
function PlanEditDrawer({
  spaceId,
  spaceSlug,
  plan,
  shown,
  doc,
  onClose,
}: {
  spaceId: string;
  spaceSlug: string;
  plan: WikiPlanState;
  shown: WikiPlanShown;
  doc: WikiPlanShownDoc;
  onClose: () => void;
}) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const navigate = useNavigate();
  const message = useToast();
  const [form, setForm] = useState<WikiPlanDocForm>(() => wikiPlanDocForm(doc.stored!));
  const [refused, setRefused] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const save = useWikiWrite((body: Parameters<typeof editWikiPlan>[1]) => editWikiPlan(spaceId, body));
  const next = wikiPlanNextVersion(plan);
  const category = shown.categories.find((row) => row.key === doc.category)?.title ?? doc.category;
  useEffect(() => setForm(wikiPlanDocForm(doc.stored!)), [doc.stored]);

  const setSection = (i: number, patch: Partial<WikiPlanDocForm['sections'][number]>) =>
    setForm({ ...form, sections: form.sections.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
  const move = (from: number, to: number) => {
    if (from === to) return;
    const rows = [...form.sections];
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    setForm({ ...form, sections: rows });
  };
  const submit = async () => {
    setRefused(null);
    try {
      const version = await save.mutateAsync(wikiPlanEditBody(shown.version, wikiPlanDocEdit(doc.stored!, form), doc.slug));
      message.success(wikiPlanDraftSaved(version.version));
      onClose();
      navigate(wikiPlanPath(spaceSlug, version.version));
    } catch (error) {
      const errors = wikiPlanGateErrors(error);
      if (errors) setRefused(errors.map((e) => `${e.path} ${e.message}`));
      else message.error("Couldn't save the draft", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      placement="right"
      width={phone ? '100%' : 560}
      className="wk-pl-drawer"
      title={
        <div className="wk-pl-drawer-t">
          <div className="sub">{wikiPlanEditHead(shown, category)}</div>
          <div>
            {wikiPlanEditTitle(doc.number)} {!phone && doc.title}
          </div>
        </div>
      }
      footer={
        <div className="wk-pl-dfoot">
          <span className="l">{wikiPlanSaveNote(next)}</span>
          <Button onClick={onClose}>{WIKI_PLAN_CANCEL}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => void submit()}>
            {WIKI_PLAN_SAVE_DRAFT}
          </Button>
        </div>
      }
    >
      <div className="wk-pl-form">
        <label className="wk-pl-f">
          <span className="l">{WIKI_PLAN_EDIT_TITLE_FIELD}</span>
          <Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </label>
        <label className="wk-pl-f">
          <span className="l">{WIKI_PLAN_QUESTION}</span>
          <Textarea autoSize value={form.question} onChange={(event) => setForm({ ...form, question: event.target.value })} />
        </label>
        <label className="wk-pl-f">
          <span className="l">
            {WIKI_PLAN_WRITTEN_FOR} <span className="dim">{WIKI_PLAN_ONE_PER_LINE}</span>
          </span>
          <Textarea autoSize value={form.audience.join('\n')} onChange={(event) => setForm({ ...form, audience: event.target.value.split('\n') })} />
        </label>
        <label className="wk-pl-f">
          <span className="l">
            {WIKI_PLAN_COVERS} <span className="dim">{WIKI_PLAN_ONE_PER_LINE}</span>
          </span>
          <Textarea autoSize value={form.scopeIn.join('\n')} onChange={(event) => setForm({ ...form, scopeIn: event.target.value.split('\n') })} />
        </label>
        <div className="wk-pl-f row2">
          <div className="grow">
            <span className="l">{WIKI_PLAN_LENGTH}</span>
            <div className="len">
              <NumberInput min={1} value={form.length.min} onValueChange={(value) => setForm({ ...form, length: { ...form.length, min: Number(value) || 1 } })} />
              <span>–</span>
              <NumberInput min={1} value={form.length.max} onValueChange={(value) => setForm({ ...form, length: { ...form.length, max: Number(value) || 1 } })} />
              <span className="dim">chars</span>
            </div>
          </div>
          <div>
            <span className="l">{WIKI_PLAN_PROTECTED}</span>
            <div className="sw">
              <Switch checked={form.protected} onCheckedChange={(value) => setForm({ ...form, protected: value })} />
              <span className="dim">{WIKI_PLAN_PROTECTED_SWITCH}</span>
            </div>
          </div>
        </div>
        <div className="wk-pl-f">
          <span className="l">
            {WIKI_PLAN_SECTIONS} <span className="dim">{WIKI_PLAN_DRAG}</span>
          </span>
          {form.sections.map((row, i) => (
            <div
              className={`wk-pl-esec${drag === i ? ' dragging' : ''}`}
              key={`${row.key ?? 'new'}:${i}`}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              <HolderOutlined className="hd" />
              <span className="n">{i + 1}</span>
              {row.key ? (
                <span className="t">{row.title}</span>
              ) : (
                <Input size="small" value={row.title} placeholder={WIKI_PLAN_EDIT_TITLE_FIELD} onChange={(event) => setSection(i, { title: event.target.value })} />
              )}
              <Select<WikiPlanSectionKind>
                size="small"
                value={row.kind}
                options={KIND_OPTIONS}
                onValueChange={(kind) => {
                  if (kind !== null) setSection(i, { kind });
                }}
                aria-label={WIKI_PLAN_EDIT_KIND}
              />
              <button type="button" className="x" aria-label="Remove" onClick={() => setForm({ ...form, sections: form.sections.filter((_, j) => j !== i) })}>
                <CloseOutlined />
              </button>
            </div>
          ))}
          <button type="button" className="wk-pl-add" onClick={() => setForm({ ...form, sections: [...form.sections, { key: null, title: '', kind: 'other' }] })}>
            <PlusOutlined /> {WIKI_PLAN_ADD_SECTION}
          </button>
        </div>
        {refused && (
          <div className="wk-pl-refused">
            <ul>
              {refused.slice(0, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Drawer>
  );
}

/** One section, edited from its own page on a phone: title, kind, what it covers, length. */
function PlanSectionEditModal({
  spaceId,
  plan,
  shown,
  doc,
  index,
  onClose,
}: {
  spaceId: string;
  plan: WikiPlanState;
  shown: WikiPlanShown;
  doc: WikiPlanShownDoc;
  index: number;
  onClose: () => void;
}) {
  const message = useToast();
  const stored = doc.stored!.sections[index];
  const [form, setForm] = useState({ title: stored.title, kind: stored.kind, covers: stored.covers, length: stored.length });
  const [refused, setRefused] = useState<string[] | null>(null);
  const save = useWikiWrite((body: Parameters<typeof editWikiPlan>[1]) => editWikiPlan(spaceId, body));
  const submit = async () => {
    setRefused(null);
    try {
      const version = await save.mutateAsync(wikiPlanSectionEditBody(shown.version, doc.slug, stored, form));
      message.success(wikiPlanDraftSaved(version.version));
      onClose();
    } catch (error) {
      const errors = wikiPlanGateErrors(error);
      if (errors) setRefused(errors.map((e) => `${e.path} ${e.message}`));
      else message.error("Couldn't save the draft", error instanceof Error ? error.message : undefined);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={wikiPlanEditSection(index + 1)}
      className="wk-pl-section-dialog"
      footer={
        <>
          <Button onClick={onClose}>{WIKI_PLAN_CANCEL}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => void submit()}>
            {WIKI_PLAN_SAVE_DRAFT}
          </Button>
        </>
      }
    >
      <div className="wk-pl-form">
        <label className="wk-pl-f">
          <span className="l">{WIKI_PLAN_EDIT_TITLE_FIELD}</span>
          <Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </label>
        <label className="wk-pl-f">
          <span className="l">{WIKI_PLAN_EDIT_KIND}</span>
          <Select<WikiPlanSectionKind>
            value={form.kind}
            options={KIND_OPTIONS}
            onValueChange={(kind) => {
              if (kind !== null) setForm({ ...form, kind });
            }}
          />
        </label>
        <label className="wk-pl-f">
          <span className="l">{WIKI_PLAN_COVERS}</span>
          <Textarea autoSize value={form.covers} onChange={(event) => setForm({ ...form, covers: event.target.value })} />
        </label>
        <label className="wk-pl-f">
          <span className="l">{WIKI_PLAN_LENGTH}</span>
          <NumberInput min={1} value={form.length} onValueChange={(value) => setForm({ ...form, length: Number(value) || 1 })} />
        </label>
        <div className="wk-pl-f hint">{wikiPlanSaveNote(wikiPlanNextVersion(plan))}</div>
        {refused && (
          <div className="wk-pl-refused">
            <ul>
              {refused.slice(0, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The one mark a gate row wears on its own: used by the home card's rows. */
export function WikiPlanCheckIcon({ ok }: { ok: boolean }): ReactNode {
  return ok ? <CheckCircleOutlined /> : <CloseCircleFilled />;
}
