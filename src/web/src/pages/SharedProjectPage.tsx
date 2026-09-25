import { Empty, List, Tag, Typography } from 'antd';
import { useEffect, useMemo } from 'react';
import type { ShareInclude, SharedProject, SharedProjectTaskRow, SharedScope } from '../api';
import { AppLink } from '../components/AppLink';
import { AcceptanceCriteriaCard, type AcceptanceCriterionItem } from '../components/ProjectAcceptanceCard';
import { ChainProgressStrip } from '../components/ProjectChainProgress';
import { ProjectGoalCard } from '../components/ProjectGoalCard';
import { ProjectPageBlock } from '../components/ProjectPageBlocks';
import { ProjectPanoramaCard } from '../components/ProjectPanoramaHeader';
import { ProjectTasksGraph } from '../components/ProjectTasksGraph';
import { PublicShell } from '../components/PublicShell';
import { encodeId } from '../lib/idCodec';
import { projectLinkResolver, PublicLinkResolverCtx } from '../lib/publicLinks';
import { countOf, shortDate } from '../lib/shareLinks';
import { titleFirstLine } from '../lib/title';
import { ago } from '../lib/watches';
import {
  type ProjectTask,
  ProjectTaskGroupsList,
  projectTaskIntegrationTag,
  projectTaskWorkLabel,
  projectTaskWorkStateOf,
  STATUS_COLOR,
  STATUS_LABEL,
  TASK_STATUS_COLOR,
  TaskStatusMark,
} from './ProjectsPage';

/** The resolver of a project link's pages, from the scope each of them carries. */
export function scopeResolver(token: string, scope: SharedScope) {
  return projectLinkResolver(token, {
    projectId: scope.projectId,
    taskIds: scope.tasks.map((task) => task.id),
    sessionIds: scope.conversations.map((conversation) => conversation.id),
  });
}

/** The three landing phrases a visitor is given, as the acceptance card's own codes. */
const LANDING_CODE: Record<SharedProject['criteria'][number]['landing'], string> = {
  ON_MAIN: 'LANDED',
  NOT_ON_MAIN_YET: 'ON_INTEGRATION_LINE',
  NO_MERGE_RECEIPT: 'UNKNOWN',
};

/** A shared criterion, as the app's acceptance card reads one. What holds an unmet one is named by
 *  its task — no clause, no action it needs: those are the owner's. */
function criterionItem(criterion: SharedProject['criteria'][number]): AcceptanceCriterionItem {
  return {
    id: String(criterion.ordinal),
    ordinal: criterion.ordinal,
    text: criterion.text,
    revision: 0,
    verificationMethod: criterion.verificationMethod,
    satisfied: criterion.satisfied ?? undefined,
    landing: LANDING_CODE[criterion.landing],
    unmet:
      criterion.heldUpBy.length > 0
        ? [{ heldUpBy: criterion.heldUpBy.map((task) => ({ taskId: task.id, title: task.title, status: task.status })) }]
        : [],
  };
}

/** Where a shared task is between done and on main, as the app's integration states. */
const LANDING_STATE = {
  INTEGRATING: 'RUNNING',
  ON_PROJECT_BRANCH: 'ON_INTEGRATION_LINE',
  ON_MAIN: 'ON_UPSTREAM',
} as const;

/** A shared task row, as the app's Tasks block reads one — so the same bands hold it. */
function projectTask(row: SharedProjectTaskRow): ProjectTask {
  return {
    id: row.id,
    title: row.title,
    status: row.status as ProjectTask['status'],
    parentTaskId: null,
    createdAt: '',
    updatedAt: '',
    childCount: row.childCount,
    unmetCount: row.unmetCount,
    blocksCount: row.blocksCount,
    topoLevel: row.topoLevel,
    dependencyState: row.dependencyState as ProjectTask['dependencyState'],
    workState: row.workState as ProjectTask['workState'],
    landingWaitCount: row.landingWaitCount,
    integration: row.landing
      ? {
          state: LANDING_STATE[row.landing],
          since: null,
          handler: null,
          openItemId: null,
          jobId: null,
          checksRunningForMs: null,
        }
      : undefined,
  };
}

/**
 * One task of the Tasks block, drawn as the app draws its rows — the status mark, the title, the
 * lanes it is in, what it waits on and blocks — without what the owner reads there alone: its
 * acceptance excerpt (the task page has it), its schedule, and the prerequisites it names. Its
 * title opens the task's public page when the link shares task pages; otherwise it is words. A
 * landed row names no branch: on the project branch, or on main.
 */
function SharedProjectTaskRow({ task }: { task: ProjectTask }) {
  const workLabel = projectTaskWorkLabel(task);
  const landing = projectTaskIntegrationTag(task, { ref: null, upstreamRef: null });
  return (
    <List.Item
      className="project-task-row"
      data-work-state={projectTaskWorkStateOf(task)}
      data-integration-state={task.integration?.state}
      style={{ display: 'block', ...(task.integration?.state === 'ON_UPSTREAM' ? { opacity: 0.55 } : {}) }}
    >
      <div className="project-task-row-layout">
        <div className="project-task-row-copy">
          <List.Item.Meta
            className="project-task-row-meta"
            title={
              <span className="project-task-row-title">
                <TaskStatusMark status={task.status} />{' '}
                <AppLink className="share-project-task" to={`/tasks/${encodeId(task.id)}`}>
                  {task.title}
                </AppLink>{' '}
                <Tag color={TASK_STATUS_COLOR[task.status] ?? 'default'}>{task.status}</Tag>
                {workLabel ? <Tag color={workLabel.color}>{workLabel.text}</Tag> : null}
                {landing ? <Tag color={landing.color}>{landing.text}</Tag> : null}
                {task.unmetCount > 0 ? <Tag color="gold">waits {task.unmetCount}</Tag> : null}
                {task.blocksCount > 0 ? <Tag color="blue">blocks {task.blocksCount}</Tag> : null}
              </span>
            }
          />
        </div>
        <div className="project-task-row-count">{countOf(task.childCount, 'subtask')}</div>
      </div>
    </List.Item>
  );
}

/**
 * The public page of a project link (`/s/<token>`, kind PROJECT): the app project page with nine
 * of its sixteen blocks taken out and none moved (docs/share-links-design.md §7, mock 04) — Header
 * (no Record as done / cancelled, no Delete; when it started and last moved instead), Work overview
 * (no banners; no Coordinator card, only its conversation when the link shares it), Goal, Task
 * graph, Chain progress, Acceptance criteria and Tasks (no New task, no acceptance excerpts), each
 * drawn by the app's own component from what the link carries. Links go where the link's scope
 * sends them (projectLinkResolver): the project's tasks to their public pages with Task pages, its
 * conversations with Conversations, everything else as words. A phone gets the app's phone layout,
 * because these are the app's components under the app's CSS.
 */
export function SharedProjectPage({
  token,
  data,
}: {
  token: string;
  data: { include: ShareInclude; root: SharedProject; scope: SharedScope };
}) {
  const project = data.root;
  const resolve = useMemo(() => scopeResolver(token, data.scope), [token, data.scope]);
  const criteria = useMemo(() => project.criteria.map(criterionItem), [project.criteria]);
  const tasks = useMemo(() => project.tasks.items.map(projectTask), [project.tasks.items]);
  const panorama = { buckets: project.overview.buckets, shape: project.overview.shape };

  useEffect(() => {
    const prev = document.title;
    document.title = `${titleFirstLine(project.title)} — Orbit`;
    return () => {
      document.title = prev;
    };
  }, [project.title]);

  return (
    <PublicShell crumbs={[{ label: titleFirstLine(project.title) }]} wide>
      <PublicLinkResolverCtx.Provider value={resolve}>
        <div className="share-project">
          <header className="project-detail-identity" data-project-block="header">
            <Typography.Title level={2} className="page-title">
              {project.title}
            </Typography.Title>
            <div className="project-detail-meta">
              <Tag color={STATUS_COLOR[project.status]}>{STATUS_LABEL[project.status]}</Tag>
              <span>{countOf(project.taskCount, 'task')}</span>
              <span className="share-project-meta is-started">Started {shortDate(project.createdAt)}</span>
              {project.lastActivityAt ? (
                <span className="share-project-meta">Last activity {ago(project.lastActivityAt, Date.now())}</span>
              ) : null}
            </div>
          </header>

          {/* The card marks itself (data-project-block="work-overview"), as it does on the app
              page. A row of its own: the Coordinator card that stands beside it there is the
              owner's, and with Conversations its conversation is all of it a visitor gets. */}
          <div className="share-project-overview">
            <ProjectPanoramaCard
              panorama={panorama}
              projectStatus={project.status}
              integrationLine={project.overview.integrationLine}
              banners={false}
            />
            {project.coordinator ? (
              <AppLink className="share-project-coordinator" to={`/sessions/${encodeId(project.coordinator.sessionId)}`}>
                Coordinator conversation ›
              </AppLink>
            ) : null}
          </div>

          <ProjectPageBlock name="goal">
            <ProjectGoalCard goal={project.goal} />
          </ProjectPageBlock>

          <ProjectPageBlock name="task-graph">
            <ProjectTasksGraph
              projectId={project.id}
              data={project.graph}
              footnote={data.include.taskPages ? 'Click a task to open its page.' : undefined}
            />
          </ProjectPageBlock>

          <ProjectPageBlock name="chain-progress">
            <ChainProgressStrip
              panorama={panorama}
              current={project.chain?.current ?? null}
              next={project.chain?.next ?? null}
            />
          </ProjectPageBlock>

          <ProjectPageBlock name="acceptance-criteria">
            <AcceptanceCriteriaCard criteria={criteria} integrationRef={null} />
          </ProjectPageBlock>

          <ProjectPageBlock name="tasks">
            <div className="share-project-tasks">
              <Typography.Title level={4}>Tasks</Typography.Title>
              {tasks.length > 0 ? (
                <ProjectTaskGroupsList
                  items={tasks}
                  hasMore={project.tasks.hasMore}
                  renderRow={(task) => <SharedProjectTaskRow task={task} />}
                />
              ) : (
                <Empty description="No top-level tasks yet" />
              )}
            </div>
          </ProjectPageBlock>
        </div>
      </PublicLinkResolverCtx.Provider>
    </PublicShell>
  );
}
