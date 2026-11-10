import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  KeyOutlined,
  OrderedListOutlined,
  QuestionOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { CoordinatorQuestionCard, coordinatorQuestions, type ProjectOpenItemRow } from '../components/CoordinatorQuestionCard';
import { OwnerRequestCard, OwnerRequestResolved } from '../components/OwnerRequestCard';
import { Spinner } from '../components/ui/Spinner';
import { formatSpan, ago } from '../lib/watches';
import { markdownToPlainText } from '../lib/markdownText';
import { streamPoll } from '../lib/listBudget';
import type { SidebarProject } from '../lib/projectAttention';
import {
  WAITING_ON_YOU,
  projectsWithQuestions,
  useSnoozes,
  useWaitingOnYouCount,
  type OwnerRequest,
} from '../lib/ownerRequests';
import { decisionReceiptTime } from '../components/EvidenceDecisionCard';
import { openProjectsQuery, ownerRequestsQuery, projectOpenItemsQuery } from '../lib/queries';
import '../components/OwnerRequest.css';

type InboxTab = 'open' | 'done' | 'declined';

const TABS: readonly { key: InboxTab; label: string; empty: string }[] = [
  { key: 'open', label: 'Open', empty: 'Nothing is waiting on you.' },
  { key: 'done', label: 'Done', empty: 'Nothing has been done yet.' },
  { key: 'declined', label: 'Declined', empty: 'Nothing has been declined.' },
];

const isTab = (value: string | null): value is InboxTab => TABS.some((tab) => tab.key === value);

const DAY = 86_400_000;

const ACTION: Readonly<Record<OwnerRequest['kind'], string>> = {
  DECISION: 'Answer',
  SECRET: 'Provide',
  MANUAL_STEP: 'Open steps',
  CONFIRM: 'Review',
};

const ICON: Readonly<Record<OwnerRequest['kind'], ReactNode>> = {
  DECISION: <QuestionOutlined />,
  SECRET: <KeyOutlined />,
  MANUAL_STEP: <OrderedListOutlined />,
  CONFIRM: <SafetyCertificateOutlined />,
};

/** "holds 2 tasks", and for how long once that has passed a day: the part of the row that is overdue. */
function holdsText(request: OwnerRequest, now: number): string | null {
  const count = request.blocksTaskIds.length;
  if (count === 0) return null;
  const waited = now - Date.parse(request.createdAt);
  return `holds ${count} ${count === 1 ? 'task' : 'tasks'}${waited >= DAY ? ` for ${formatSpan(waited)}` : ''}`;
}

function requestDetail(request: OwnerRequest): string | null {
  if (request.kind === 'MANUAL_STEP') {
    const steps = request.steps?.length ?? 0;
    return `${steps} ${steps === 1 ? 'step' : 'steps'}`;
  }
  if (request.kind === 'DECISION') {
    const label = request.recommendedOption === null ? undefined : request.options?.[request.recommendedOption]?.label;
    return label ? `decision · recommended: ${label}` : 'decision';
  }
  return request.kind === 'CONFIRM' ? 'confirmation' : null;
}

/** One row of the Open tab; its action opens the whole card underneath. */
function InboxRow({ icon, title, detail, overdue, age, action, children }: {
  icon: ReactNode;
  title: string;
  detail: string;
  overdue: string | null;
  age: string;
  action: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li className="owner-inbox-row">
      <div className="owner-inbox-row-line">
        <span className="owner-inbox-icon" aria-hidden="true">{icon}</span>
        <span className="owner-inbox-text">
          <span className="owner-inbox-title">{title}</span>
          <span className="owner-inbox-detail">
            {detail}
            {overdue ? <>{detail ? ' · ' : ''}<strong>{overdue}</strong></> : null}
          </span>
        </span>
        <span className="owner-inbox-side">
          <span className="owner-inbox-age">{age}</span>
          <button type="button" className="owner-inbox-action" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Close' : action}
          </button>
        </span>
      </div>
      {open ? <div className="owner-inbox-card">{children}</div> : null}
    </li>
  );
}

type OpenRow =
  | { at: string; request: OwnerRequest }
  | { at: string; project: SidebarProject; question: ProjectOpenItemRow };

/**
 * Everything agents have asked the owner to do, in one place: owner requests, and the questions
 * coordinators filed through `ask_owner`, which stay on their own table but are one list to the owner.
 */
export function WaitingOnYouPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: InboxTab = isTab(tabParam) ? tabParam : 'open';
  const count = useWaitingOnYouCount();
  const open = useQuery(ownerRequestsQuery('open'));
  const ended = useQuery({ ...ownerRequestsQuery(tab === 'declined' ? 'declined' : 'done'), enabled: tab !== 'open' });
  const projects = useQuery(openProjectsQuery());
  const asking = useMemo(() => projectsWithQuestions(projects.data ?? []), [projects.data]);
  const items = useQueries({
    queries: asking.map((project) => ({ ...projectOpenItemsQuery(project.id), refetchInterval: streamPoll(20_000) })),
  });
  const snoozes = useSnoozes();
  const now = Date.now();
  const titleOf = (projectId: string | null): string | undefined =>
    projects.data?.find((project) => project.id === projectId)?.title;

  const rows: OpenRow[] = [
    ...(open.data?.requests ?? []).map((request) => ({ at: request.createdAt, request })),
    ...asking.flatMap((project, index) =>
      coordinatorQuestions(items[index]?.data).map((question) => ({ at: question.waitingSince, project, question }))),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const current = TABS.find((candidate) => candidate.key === tab)!;
  const loading = tab === 'open' ? open.isLoading : ended.isLoading;
  const endedRows = ended.data?.requests ?? [];
  const empty = !loading && (tab === 'open' ? rows.length === 0 : endedRows.length === 0);

  return (
    <div className="owner-inbox">
      <header className="owner-inbox-head">
        <h1 className="page-title">{WAITING_ON_YOU}</h1>
        {count > 0 ? <span className="owner-inbox-count">{count}</span> : null}
        <div className="owner-inbox-tabs" role="tablist" aria-label={WAITING_ON_YOU}>
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`owner-inbox-tab${tab === key ? ' is-on' : ''}`}
              onClick={() => setParams({ tab: key }, { replace: true })}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {loading ? <Spinner /> : null}
      {empty ? <p className="owner-inbox-empty">{current.empty}</p> : null}
      {tab === 'open' && rows.length > 0 ? (
        <ul className="owner-inbox-list">
          {rows.map((row) => {
            if ('request' in row) {
              const { request } = row;
              const project = titleOf(request.projectId);
              const until = snoozes[request.id] ?? 0;
              return (
                <InboxRow
                  key={request.id}
                  icon={ICON[request.kind]}
                  title={request.title}
                  detail={[project, requestDetail(request)].filter(Boolean).join(' · ')}
                  overdue={holdsText(request, now)}
                  age={until > now
                    ? `Reminder ${decisionReceiptTime(new Date(until).toISOString(), new Date(now))}`
                    : ago(request.createdAt, now)}
                  action={ACTION[request.kind]}
                >
                  <OwnerRequestCard request={request} now={now} />
                </InboxRow>
              );
            }
            const { project, question } = row;
            const recommended = question.question?.recommendedOption;
            const label = recommended === null || recommended === undefined ? undefined : question.question?.options[recommended]?.label;
            return (
              <InboxRow
                key={question.itemId}
                icon={<QuestionOutlined />}
                title={markdownToPlainText(question.question?.question ?? '')}
                detail={[project.title, label ? `decision · recommended: ${label}` : 'decision'].join(' · ')}
                overdue={null}
                age={ago(question.waitingSince, now)}
                action="Answer"
              >
                <CoordinatorQuestionCard projectId={project.id} row={question} now={now} />
              </InboxRow>
            );
          })}
        </ul>
      ) : null}
      {tab !== 'open' && endedRows.length > 0 ? (
        <div className="owner-inbox-ended">
          {endedRows.map((request) => <OwnerRequestResolved key={request.id} request={request} now={now} />)}
        </div>
      ) : null}
    </div>
  );
}
