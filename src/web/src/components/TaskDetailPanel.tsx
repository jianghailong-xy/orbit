import { CheckOutlined, CloseOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, Input, Segmented, Select, Spin, Switch, Tooltip } from 'antd';
import { lazy, Suspense, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { taskPagePath, type TaskPage } from '../lib/taskPages';
import { useToast } from '../lib/toast';
import {
  applyTaskDependencyGraphExpansionLedger,
  buildDirectTaskDependencyGraph,
  reconcileTaskDependencyGraphRefresh,
  taskDependencyGraphStructureKey,
  taskDependencyGraphTruncationState,
  type TaskDependencyBranchAggregate,
  type TaskDependencyGraphExpansionLedgerEntry,
  type TaskDependencyGraphExpansionResponse,
  type TaskDependencyGraphNodesResponse,
  type TaskDependencyGraphResponse,
} from '../lib/taskDependencyGraph';
import {
  isSessionBusy,
  sessionRunStateOf,
  type SessionRunState,
} from '../lib/sessionState';
import { PENDING_SLOT_LABEL } from '../lib/runnerSlots';
import { TaskDependencyList } from './TaskDependencyList';

// Graph rendering pulls in React Flow + dagre. Keep that weight out of the initial task-list
// bundle; it is fetched only when someone opens a task with dependencies and selects Graph.
const LazyTaskDependencyGraph = lazy(async () => {
  const module = await import('./TaskDependencyGraph');
  return { default: module.TaskDependencyGraph };
});

// The detail panel's width is drag-resizable; persist the choice so it sticks across reloads.
// Until the user resizes, width stays null and the CSS clamp (responsive default) wins.
const TDP_WIDTH_KEY = 'orbit.taskDetailWidth';
const TDP_WIDTH_MIN = 440;
const TDP_WIDTH_MAX = 1000;
const TDP_WIDTH_DEFAULT = 600;

// TaskStatus (OPEN/IN_PROGRESS/DONE/CANCELLED/FAILED) -> header badge label + tone.
const STATUS_META: Record<string, { label: string; tone: string }> = {
  OPEN: { label: 'Open', tone: 'muted' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue' },
  DONE: { label: 'Done', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  FAILED: { label: 'Failed', tone: 'red' },
};

// A run's outcome badge is independent of whether its session is Open, Completed or in Trash.
const SESSION_STATE_META: Record<SessionRunState, { label: string; tone: string }> = {
  QUEUED: { label: PENDING_SLOT_LABEL, tone: 'muted' },
  RUNNING: { label: 'Running', tone: 'blue' },
  SUCCEEDED: { label: 'Succeeded', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  AWAITING_INPUT: { label: 'Awaiting reply', tone: 'amber' },
  INTERRUPTED: { label: 'Interrupted', tone: 'muted' },
  DORMANT: { label: 'Dormant', tone: 'muted' },
  ENDED: { label: 'Ended', tone: 'muted' },
};

const sessionStatusMeta = (session: any) => SESSION_STATE_META[sessionRunStateOf(session)];

const fmt = (d?: string | null): string =>
  d
    ? new Date(d).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const initial = (name?: string | null): string => (name ?? '?').trim().charAt(0).toUpperCase();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// rehype plugin: after the comment markdown is parsed, wrap each standalone
// `@<owned agent name>` in a text node with a `.tdp-mention` chip. Skips code/pre
// so mentions inside code spans stay literal. `names` is sorted longest-first so
// "@Bot2" wins over "@Bot"; the trailing `(?![\w])` blocks substrings.
const rehypeMentions = (names: string[]) => () => (tree: any) => {
  if (!names.length) return;
  const re = new RegExp(`@(?:${names.map(escapeRegExp).join('|')})(?![\\w])`, 'g');
  const splitText = (value: string): any[] => {
    re.lastIndex = 0;
    const out: any[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
      out.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['tdp-mention'] },
        children: [{ type: 'text', value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
    return out.length ? out : [{ type: 'text', value }];
  };
  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    const next: any[] = [];
    for (const child of node.children) {
      if (child.type === 'text') {
        next.push(...splitText(child.value));
      } else {
        if (child.type === 'element' && child.tagName !== 'code' && child.tagName !== 'pre') {
          walk(child);
        }
        next.push(child);
      }
    }
    node.children = next;
  };
  walk(tree);
};

// The list row passed in for an instant header render before /tasks/:id resolves.
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  creatorName?: string | null;
  assignee?: { id: string; name: string } | null;
  createdAt?: string;
  dueDate?: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  runnerId?: string | null;
}

export function TaskDetailPanel({
  taskId,
  summary,
  onOpenTask,
  onClose,
}: {
  taskId: string;
  summary?: TaskSummary;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const [draft, setDraft] = useState('');
  // Drag-resizable panel width (null until the user resizes — see TDP_WIDTH_* + startResize).
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(() => {
    const s = Number(localStorage.getItem(TDP_WIDTH_KEY));
    return s >= TDP_WIDTH_MIN && s <= TDP_WIDTH_MAX ? s : null;
  });
  const [resizing, setResizing] = useState(false);

  // /tasks/:id carries the full detail (description, comments, sessions) that the
  // list row lacks; show `summary` meanwhile so the header doesn't flash.
  const q = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api<any>(`/tasks/${taskId}`),
    // While the task has a busy (queued/running) session, poll so the 开始执行 button
    // leaves its running state once the run ends; stay idle otherwise.
    refetchInterval: (query) =>
      (query.state.data?.sessions ?? []).some((s: any) => isSessionBusy(s)) ? 4000 : false,
  });
  const task = q.data ?? summary;

  // A task detail only carries adjacent dependency edges. The dedicated graph snapshot follows
  // the DAG in both directions so opening a root prerequisite or a middle task still shows the
  // complete pipeline. Keeping the key under ['task', taskId] lets existing realtime
  // invalidation refresh both the detail and graph together.
  const dependencyGraphQ = useQuery({
    queryKey: ['task', taskId, 'dependency-graph'],
    queryFn: () =>
      api<TaskDependencyGraphResponse>(
        `/tasks/${taskId}/dependency-graph?direction=both&pairUnary=true`,
      ),
    enabled:
      !!q.data &&
      ((q.data.dependsOn?.length ?? 0) > 0 || (q.data.dependedOnBy?.length ?? 0) > 0),
  });
  const dependencyGraphBaseStructureKey = useMemo(
    () =>
      dependencyGraphQ.data
        ? taskDependencyGraphStructureKey(dependencyGraphQ.data)
        : null,
    [dependencyGraphQ.data],
  );
  const [dependencyExpansionLedger, setDependencyExpansionLedger] = useState<{
    focusTaskId: string;
    baseStructureKey: string | null;
    entries: TaskDependencyGraphExpansionLedgerEntry[];
  }>(() => ({ focusTaskId: taskId, baseStructureKey: null, entries: [] }));
  const activeDependencyExpansionEntries =
    dependencyExpansionLedger.focusTaskId === taskId &&
    dependencyExpansionLedger.baseStructureKey === dependencyGraphBaseStructureKey
      ? dependencyExpansionLedger.entries
      : [];
  const replayedDependencyGraphData = useMemo(
    () =>
      dependencyGraphQ.data
        ? applyTaskDependencyGraphExpansionLedger(
            dependencyGraphQ.data,
            activeDependencyExpansionEntries,
          )
        : undefined,
    [activeDependencyExpansionEntries, dependencyGraphQ.data],
  );
  const dependencyGraphKnownTaskIds = useMemo(
    () => replayedDependencyGraphData?.nodes.map((node) => node.id).sort() ?? [],
    [replayedDependencyGraphData],
  );
  const dependencyGraphNodesQ = useQuery({
    queryKey: ['task', taskId, 'dependency-graph-nodes', dependencyGraphKnownTaskIds],
    queryFn: () =>
      api<TaskDependencyGraphNodesResponse>(`/tasks/${taskId}/dependency-graph/nodes`, {
        method: 'POST',
        body: { taskIds: dependencyGraphKnownTaskIds },
      }),
    enabled:
      activeDependencyExpansionEntries.length > 0 && dependencyGraphKnownTaskIds.length > 0,
  });
  const expandedDependencyGraphData = useMemo(() => {
    if (
      !replayedDependencyGraphData ||
      activeDependencyExpansionEntries.length === 0 ||
      !dependencyGraphNodesQ.isSuccess ||
      dependencyGraphNodesQ.isFetching ||
      !dependencyGraphNodesQ.data
    ) {
      return replayedDependencyGraphData;
    }
    return reconcileTaskDependencyGraphRefresh(
      replayedDependencyGraphData,
      dependencyGraphNodesQ.data,
      dependencyGraphQ.data,
    );
  }, [
    activeDependencyExpansionEntries.length,
    dependencyGraphNodesQ.data,
    dependencyGraphNodesQ.isFetching,
    dependencyGraphNodesQ.isSuccess,
    dependencyGraphQ.data,
    replayedDependencyGraphData,
  ]);
  useEffect(() => {
    setDependencyExpansionLedger((previous) => {
      if (
        previous.focusTaskId === taskId &&
        previous.baseStructureKey === dependencyGraphBaseStructureKey
      ) {
        return previous;
      }
      return {
        focusTaskId: taskId,
        baseStructureKey: dependencyGraphBaseStructureKey,
        entries: [],
      };
    });
  }, [dependencyGraphBaseStructureKey, taskId]);
  const [dependencyViewOverride, setDependencyViewOverride] = useState<'graph' | 'list' | null>(null);
  useEffect(() => setDependencyViewOverride(null), [taskId]);

  // Owner's agents, for @-mention autocomplete and to label/trigger mentions.
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('/agents') });
  const agentList = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);

  // Owner's task lists, to move this task into a list (or detach it to 未分组).
  const taskListsQ = useQuery({
    queryKey: ['task-lists'],
    queryFn: () => api<{ id: string; title: string }[]>('/task-lists'),
  });

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tell the user which mentioned agents got triggered (those bound to a runner can
  // actually run; the rest are recorded on the comment but not started).
  const notifyMentions = (ids: string[]) => {
    if (!ids.length) return;
    const picked = agentList.filter((a) => ids.includes(a.id));
    const triggerable = picked.filter((a) => a.runnerId);
    const noRunner = picked.filter((a) => !a.runnerId);
    const parts: string[] = [];
    if (triggerable.length) parts.push(`Notified and triggered ${triggerable.map((a) => a.name).join(', ')}`);
    if (noRunner.length)
      parts.push(`${noRunner.map((a) => a.name).join(', ')} not bound to a runner — recorded but not triggered`);
    if (parts.length) message.info(parts.join('; '));
  };

  // Reassign (or clear, when null) the task's responsible agent. Refresh both the
  // open detail and the list row that shows the assignee.
  const updateAssignee = useMutation({
    mutationFn: (assigneeId: string | null) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { assigneeId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Move the task into a list (string) or detach it to 未分组 (null). Refresh the panel,
  // the list rows, and the sidebar's per-list / 未分组 counts.
  const updateList = useMutation({
    mutationFn: (listId: string | null) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { listId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-lists'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  // "开始执行": tell the task's responsible agent to start (or continue) a session on it.
  // The backend validates assignee + runner; refresh the panel so the new run shows up.
  const execute = useMutation({
    mutationFn: () => api(`/tasks/${taskId}/execute`, { method: 'POST' }),
    onSuccess: () => {
      message.success('Assignee agent triggered');
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Search prerequisite candidates server-side. Loading every task made this picker and
  // the surrounding panel unusable for large task sets; the first 50 recent matches are
  // enough for browsing and typing narrows across the owner's full task history.
  const [dependencyQuery, setDependencyQuery] = useState('');
  const dependencyTasksQ = useQuery({
    queryKey: ['tasks', 'dependency-search', dependencyQuery],
    queryFn: () => api<TaskPage>(taskPagePath({ limit: 50, q: dependencyQuery })),
  });

  // After any dependency/auto-run/mark-done change, refresh this panel and the list (its
  // lock indicators and the picker's task statuses both derive from the same data).
  const refreshTaskViews = () => {
    return Promise.all([
      qc.invalidateQueries({ queryKey: ['task', taskId] }),
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      qc.invalidateQueries({ queryKey: ['task-list'] }),
    ]);
  };

  const addDependency = useMutation({
    mutationFn: (dependsOnTaskId: string) =>
      api(`/tasks/${taskId}/dependencies`, { method: 'POST', body: { dependsOnTaskId } }),
    onSuccess: refreshTaskViews,
    onError: (e: Error) => message.error(e.message),
  });

  const removeDependency = useMutation({
    mutationFn: (dependsOnTaskId: string) =>
      api(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`, { method: 'DELETE' }),
    onSuccess: refreshTaskViews,
    onError: (e: Error) => message.error(e.message),
  });

  const expandDependencyBranch = useMutation({
    mutationFn: ({
      aggregate,
      focusTaskId,
    }: {
      aggregate: TaskDependencyBranchAggregate;
      focusTaskId: string;
      baseStructureKey: string | null;
    }) => {
      const current = expandedDependencyGraphData;
      if (!current) throw new Error('The dependency graph is still loading.');
      const loadedNeighborTaskIds = current.edges.flatMap((edge) => {
        if (aggregate.direction === 'prerequisites' && edge.targetTaskId === aggregate.parentTaskId) {
          return [edge.sourceTaskId];
        }
        if (aggregate.direction === 'dependents' && edge.sourceTaskId === aggregate.parentTaskId) {
          return [edge.targetTaskId];
        }
        return [];
      });
      return api<TaskDependencyGraphExpansionResponse>(`/tasks/${focusTaskId}/dependency-graph/expand`, {
        method: 'POST',
        body: {
          anchorTaskId: aggregate.parentTaskId,
          direction: aggregate.direction,
          knownTaskIds: current.nodes.map((node) => node.id),
          loadedNeighborTaskIds,
          limit: aggregate.nextBatchCount,
          cursor: aggregate.cursor,
        },
      });
    },
    onSuccess: (expansion, request) => {
      setDependencyExpansionLedger((previous) => {
        if (
          previous.focusTaskId !== request.focusTaskId ||
          previous.baseStructureKey !== request.baseStructureKey
        ) {
          return previous;
        }
        return {
          ...previous,
          entries: [
            ...previous.entries,
            {
              expansion,
              requestedGroup: {
                anchorTaskId: request.aggregate.parentTaskId,
                direction: request.aggregate.direction,
              },
            },
          ],
        };
      });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const setAutoRun = useMutation({
    mutationFn: (autoRunWhenReady: boolean) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { autoRunWhenReady } }),
    onSuccess: refreshTaskViews,
    onError: (e: Error) => message.error(e.message),
  });

  // Safety net for the "agent forgot to mark DONE" case (see §6.3): mark the task done
  // so its waiting dependents are released (and auto-run).
  const markDone = useMutation({
    mutationFn: () => api(`/tasks/${taskId}`, { method: 'PATCH', body: { status: 'DONE' } }),
    onSuccess: () => {
      message.success('Marked done — downstream tasks released');
      return refreshTaskViews();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const addComment = useMutation({
    mutationFn: (vars: { body: string; mentions: string[] }) =>
      api(`/tasks/${taskId}/comments`, { method: 'POST', body: vars }),
    onSuccess: (_data, vars) => {
      setDraft('');
      setCaret(0);
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      notifyMentions(vars.mentions);
    },
    onError: (e: Error) => message.error(e.message),
  });

  // An agent is mentioned when `@<name>` appears as a standalone token in the body.
  const mentionTokenRe = (name: string) => new RegExp(`(?:^|\\s)@${escapeRegExp(name)}(?![\\w])`);
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    const mentions = agentList.filter((a) => mentionTokenRe(a.name).test(body)).map((a) => a.id);
    addComment.mutate({ body, mentions });
  };

  // ── `@` mention autocomplete ───────────────────────────────────────────────
  // Mirrors the composer's `/` command menu (AgentView): while the caret sits right
  // after an `@token`, show owned agents; picking one inserts `@<name> ` (the trailing
  // space drops the token regex, so the menu auto-hides).
  const taRef = useRef<any>(null);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionToken = useMemo(() => {
    const before = draft.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return m ? m[1] : null;
  }, [draft, caret]);
  const mentionMatches = useMemo(() => {
    if (mentionToken === null) return [];
    const query = mentionToken.toLowerCase();
    return agentList
      .filter((a) => a.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(query) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(query) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [agentList, mentionToken]);
  useEffect(() => {
    setMentionIndex(0);
    setMentionDismissed(false);
  }, [mentionToken]);
  const showMention = mentionToken !== null && !mentionDismissed && mentionMatches.length > 0;
  const mentionIdx = mentionMatches.length ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;

  const pickMention = (agent: AgentRow) => {
    const before = draft.slice(0, caret).replace(/(^|\s)@([^\s@]*)$/, `$1@${agent.name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentionDismissed(false);
    setTimeout(() => {
      const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(before.length, before.length);
      }
      setCaret(before.length);
    }, 0);
  };

  // Wrap each standalone `@<owned agent name>` in the body with a mention chip. Longer
  // names first so "@Bot2" wins over "@Bot"; the trailing `(?![\w])` blocks substrings.
  const mentionNames = useMemo(
    () => agentList.map((a) => a.name).filter(Boolean).sort((a, b) => b.length - a.length),
    [agentList],
  );
  const mentionPlugin = useMemo(() => rehypeMentions(mentionNames), [mentionNames]);

  const status = STATUS_META[task?.status as string] ?? { label: task?.status ?? '', tone: 'muted' };
  const comments = q.data?.comments ?? [];
  const sessions = q.data?.sessions ?? [];

  // ── Dependencies ───────────────────────────────────────────────────────────
  const dependsOn = q.data?.dependsOn ?? []; // edges: this task's prerequisites
  const dependedOnBy = q.data?.dependedOnBy ?? []; // edges: tasks waiting on this one
  const dependencyState: string = q.data?.dependencyState ?? 'NONE';
  const blocked = dependencyState === 'BLOCKED' || dependencyState === 'BLOCKED_FAILED';
  const prereqIds = new Set(dependsOn.map((d: any) => d.dependsOnTask.id));
  const completedDirectPrerequisites = dependsOn.filter(
    (d: any) => d.dependsOnTask.status === 'DONE',
  ).length;
  const failedDirectPrerequisites = dependsOn.filter((d: any) =>
    ['FAILED', 'CANCELLED'].includes(d.dependsOnTask.status),
  ).length;
  const hasDependencyRelations = dependsOn.length > 0 || dependedOnBy.length > 0;
  const fallbackDependencyGraph = buildDirectTaskDependencyGraph(
    taskId,
    {
      id: taskId,
      title: task?.title ?? 'Current task',
      status: task?.status ?? 'OPEN',
      depth: 0,
    },
    dependsOn.map((d: any) => ({
      id: d.dependsOnTask.id,
      title: d.dependsOnTask.title,
      status: d.dependsOnTask.status,
      depth: 1,
      isDirect: true,
    })),
    dependedOnBy.map((d: any) => ({
      id: d.task.id,
      title: d.task.title,
      status: d.task.status,
      depth: 1,
    })),
  );
  const dependencyGraph = expandedDependencyGraphData ?? fallbackDependencyGraph;
  const dependencyTruncationState = taskDependencyGraphTruncationState(dependencyGraph);
  const dependencyView = dependencyViewOverride ?? (dependencyGraph.edges.length > 0 ? 'graph' : 'list');
  // Expansion deltas add real nodes without replacing the initial aggregate counts.
  // Derive this display count from the merged snapshot so it advances after every batch.
  const connectedCount = Math.max(dependencyGraph.nodes.length - 1, 0);
  const upstreamCount = dependencyGraph.counts?.upstream ?? dependsOn.length;
  const downstreamCount = dependencyGraph.counts?.downstream ?? dependedOnBy.length;
  // Candidate prerequisites: every other task not already a prerequisite of this one.
  const dependencyOptions = (dependencyTasksQ.data?.items ?? [])
    .filter((t: any) => t.id !== taskId && !prereqIds.has(t.id))
    .map((t: any) => ({ value: t.id, label: t.title }));
  // §6.3 safety net: a run finished successfully but the task still isn't DONE while
  // dependents wait — surface a one-click "标记完成" so the pipeline doesn't stall.
  const hasSucceededSession = sessions.some(
    (s: any) => sessionRunStateOf(s) === 'SUCCEEDED',
  );
  const needsDoneConfirm =
    dependedOnBy.length > 0 && task?.status !== 'DONE' && hasSucceededSession;

  // Need a responsible agent to execute; the runner check is enforced by the backend.
  const canExecute = !!task?.assignee;
  // "Running" = the trigger request is in flight, or the task has a busy (queued/running)
  // session. The button shows this state and stays disabled throughout — which also
  // debounces it against repeated clicks (no second trigger until the current run ends).
  const running = execute.isPending || sessions.some((s: any) => isSessionBusy(s));
  // Blocked tasks can't run until prerequisites clear; mirror the backend's execute gate.
  const executeDisabled = !canExecute || running || blocked;
  const executeHint = blocked
    ? dependencyState === 'BLOCKED_FAILED'
      ? 'Prerequisite cancelled — resolve it first'
      : 'Waiting for prerequisites'
    : !canExecute
      ? 'Assign an agent first'
      : running
        ? 'Task running…'
        : '';

  // Drag the panel's left edge to resize; it sits on the right, so dragging left widens it.
  // Listeners live on document so a fast drag keeps tracking past the 1px handle.
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width ?? asideRef.current?.getBoundingClientRect().width ?? TDP_WIDTH_DEFAULT;
    let latest = startW;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent): void => {
      latest = Math.min(TDP_WIDTH_MAX, Math.max(TDP_WIDTH_MIN, startW + startX - ev.clientX));
      setWidth(latest);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      localStorage.setItem(TDP_WIDTH_KEY, String(latest));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <aside
      ref={asideRef}
      className="task-detail-panel"
      style={width != null ? { width } : undefined}
    >
      <div
        className={`tdp-resizer${resizing ? ' resizing' : ''}`}
        onMouseDown={startResize}
      />
      <div className="tdp-head">
        <div className="tdp-head-main">
          <div className="tdp-title">{task?.title ?? 'Loading…'}</div>
          <div className="tdp-meta">
            <span className={`tdp-badge tone-${status.tone}`}>{status.label}</span>
            {task?.assignee && (
              <span className="tdp-meta-item">
                <Avatar size={18} style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 10 }}>
                  {initial(task.assignee.name)}
                </Avatar>
                {task.assignee.name}
              </span>
            )}
            {task?.createdAt && <span className="tdp-meta-item muted">· {fmt(task.createdAt)}</span>}
          </div>
        </div>
        <div className="tdp-head-actions">
          <Tooltip title={executeHint}>
            <span style={{ display: 'inline-flex' }}>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={running}
                disabled={executeDisabled}
                onClick={() => execute.mutate()}
                style={executeDisabled ? { pointerEvents: 'none' } : undefined}
              >
                {running ? 'Running' : 'Run'}
              </Button>
            </span>
          </Tooltip>
          {task && task.status !== 'DONE' && (
            <Button
              icon={<CheckOutlined />}
              loading={markDone.isPending}
              onClick={() => markDone.mutate()}
            >
              Mark done
            </Button>
          )}
          <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
        </div>
      </div>

      {q.isLoading ? (
        <div className="tdp-loading">
          <Spin />
        </div>
      ) : q.isError ? (
        <div className="tdp-empty">Failed to load task details.</div>
      ) : (
        <div className="tdp-body">
          {needsDoneConfirm && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                marginBottom: 12,
                background: 'var(--warning-bg)',
                border: '1px solid var(--warning-border)',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <span style={{ flex: 1 }}>
                {dependedOnBy.length} downstream task(s) are waiting, but this task isn't marked done yet.
              </span>
              <Button size="small" type="primary" loading={markDone.isPending} onClick={() => markDone.mutate()}>
                Mark done
              </Button>
            </div>
          )}
          <section className="tdp-section">
            <div className="tdp-section-title">Details</div>
            <div className="tdp-field">
              <span className="tdp-field-label">Assignee</span>
              <Select
                className="tdp-assignee-select"
                variant="borderless"
                value={task?.assignee?.id ?? undefined}
                placeholder="Unassigned"
                allowClear
                showSearch
                optionFilterProp="label"
                loading={agentsQ.isLoading || updateAssignee.isPending}
                disabled={updateAssignee.isPending}
                popupMatchSelectWidth={false}
                options={agentList.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(val) => updateAssignee.mutate(val ?? null)}
              />
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">List</span>
              <Select
                className="tdp-assignee-select"
                variant="borderless"
                value={q.data?.listId ?? undefined}
                placeholder="No list"
                allowClear
                showSearch
                optionFilterProp="label"
                loading={taskListsQ.isLoading || updateList.isPending}
                disabled={updateList.isPending}
                popupMatchSelectWidth={false}
                options={(taskListsQ.data ?? []).map((l) => ({ value: l.id, label: l.title }))}
                onChange={(val) => updateList.mutate(val ?? null)}
              />
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">Created by</span>
              <span className="tdp-field-value">{summary?.creatorName ?? '—'}</span>
            </div>
            {q.data?.creatorSession && (
              <div className="tdp-field">
                <span className="tdp-field-label">Created from</span>
                <Link
                  to={`/sessions/${encodeId(q.data.creatorSession.id)}`}
                  className="tdp-field-value tdp-field-link"
                  title="Go to the session that created this task"
                >
                  {q.data.creatorSession.title || 'Untitled session'}
                </Link>
              </div>
            )}
            <div className="tdp-field">
              <span className="tdp-field-label">Created</span>
              <span className="tdp-field-value">{fmt(task?.createdAt)}</span>
            </div>
          </section>

          <section className="tdp-section">
            <div className="tdp-dependency-head">
              <div className="tdp-section-title">Dependencies</div>
              {hasDependencyRelations && (
                <span className="tdp-dependency-summary">
                  {connectedCount} connected{dependencyGraph.truncated ? ' loaded' : ''} · {upstreamCount} upstream ·{' '}
                  {downstreamCount} downstream
                </span>
              )}
              {hasDependencyRelations && (
                <Segmented
                  className="tdp-dependency-view"
                  size="small"
                  value={dependencyView}
                  options={[
                    { label: 'Graph', value: 'graph' },
                    { label: 'List', value: 'list' },
                  ]}
                  onChange={(value) => setDependencyViewOverride(value as 'graph' | 'list')}
                  aria-label="Dependency view"
                />
              )}
            </div>
            {blocked && (
              <div className={`tdp-dependency-notice${dependencyState === 'BLOCKED_FAILED' ? ' is-failed' : ''}`}>
                {dependencyState === 'BLOCKED_FAILED'
                  ? failedDirectPrerequisites === 1
                    ? 'A direct prerequisite failed or was cancelled — resolve it before running.'
                    : `${failedDirectPrerequisites} direct prerequisites failed or were cancelled — resolve them before running.`
                  : `${completedDirectPrerequisites} of ${dependsOn.length} direct prerequisites complete. All are required.`}
              </div>
            )}
            {dependencyGraphQ.isError && hasDependencyRelations && (
              <div className="tdp-dependency-graph-error" role="alert">
                The complete dependency graph could not be loaded. Showing direct relationships.
              </div>
            )}
            {!hasDependencyRelations ? (
              <div className="tdp-muted">No dependencies</div>
            ) : dependencyView === 'graph' ? (
              dependencyGraphQ.isLoading ? (
                <div className="tdp-dependency-graph-loading"><Spin size="small" /></div>
              ) : (
                <Suspense fallback={<div className="tdp-dependency-graph-loading"><Spin size="small" /></div>}>
                  <LazyTaskDependencyGraph
                    graph={dependencyGraph}
                    title={task?.title ?? 'Current task'}
                    onOpenTask={onOpenTask}
                    onRemoveDependency={(id) => removeDependency.mutate(id)}
                    onExpandBranch={async (aggregate) => {
                      await expandDependencyBranch.mutateAsync({
                        aggregate,
                        focusTaskId: taskId,
                        baseStructureKey: dependencyGraphBaseStructureKey,
                      });
                    }}
                    expandingBranchKey={
                      expandDependencyBranch.isPending
                        ? expandDependencyBranch.variables?.aggregate.branchKey ?? null
                        : null
                    }
                    removingTaskId={removeDependency.isPending ? removeDependency.variables : null}
                  />
                </Suspense>
              )
            ) : (
              <TaskDependencyList
                graph={dependencyGraph}
                onOpenTask={onOpenTask}
                onRemoveDependency={(id) => removeDependency.mutate(id)}
                removingTaskId={removeDependency.isPending ? removeDependency.variables : null}
              />
            )}
            {dependencyTruncationState && (
              <div className="tdp-dependency-truncated">
                {dependencyTruncationState === 'expandable'
                  ? `The initial snapshot is limited to ${dependencyGraph.limits?.maxDepth ?? 8} hops or ${dependencyGraph.limits?.maxNodes ?? 100} tasks${dependencyGraph.limits?.maxEdges ? ` or ${dependencyGraph.limits.maxEdges} relationships` : ''}. Expand a collapsed branch to load the next batch.`
                  : 'Graph expansion limit reached. Some branch connections remain collapsed.'}
              </div>
            )}
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="Add a prerequisite…"
              value={null}
              showSearch
              filterOption={false}
              onSearch={setDependencyQuery}
              loading={dependencyTasksQ.isLoading || addDependency.isPending}
              popupMatchSelectWidth={false}
              options={dependencyOptions}
              onChange={(val) => {
                if (val) addDependency.mutate(val);
                setDependencyQuery('');
              }}
            />
            {dependsOn.length > 0 && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}
              >
                <Switch
                  size="small"
                  checked={task?.autoRunWhenReady ?? true}
                  loading={setAutoRun.isPending}
                  onChange={(v) => setAutoRun.mutate(v)}
                />
                <span>Auto-run when all prerequisites finish</span>
              </div>
            )}
          </section>

          {q.data?.description && (
            <section className="tdp-section">
              <div className="tdp-section-title">Description</div>
              <div className="tdp-prose">{q.data.description}</div>
            </section>
          )}

          <section className="tdp-section">
            <div className="tdp-section-title">Runs ({sessions.length})</div>
            {sessions.length === 0 ? (
              <div className="tdp-muted">No runs yet</div>
            ) : (
              sessions.map((s: any) => {
                const state = sessionRunStateOf(s);
                const meta = sessionStatusMeta(s);
                return (
                  <Link
                    key={s.id}
                    to={`/sessions/${encodeId(s.id)}`}
                    className={`tdp-session${state === 'FAILED' ? ' is-failed' : ''}`}
                  >
                    <span className={`tdp-dot ${state}`} />
                    <div className="tdp-session-main">
                      {/* Agent leads — it's what tells two runs of the same task apart; the
                          system-generated title just repeats the task name. */}
                      <div className="tdp-session-title">
                        {s.agent?.name || s.title || 'Untitled session'}
                      </div>
                      <div className="tdp-session-sub">{fmt(s.createdAt)}</div>
                    </div>
                    <span className={`tdp-badge tone-${meta.tone}`}>{meta.label}</span>
                  </Link>
                );
              })
            )}
          </section>

          <section className="tdp-section">
            <div className="tdp-section-title">Comments ({comments.length})</div>
            {comments.length === 0 ? (
              <div className="tdp-muted">No comments yet</div>
            ) : (
              comments.map((c: any) => (
                <div key={c.id} className="tdp-comment">
                  <Avatar
                    size={24}
                    style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 11, flex: 'none' }}
                  >
                    {initial(c.authorName)}
                  </Avatar>
                  <div className="tdp-comment-body">
                    <div className="tdp-comment-head">
                      <span className="tdp-comment-author">{c.authorName ?? 'Unknown'}</span>
                      <span className="tdp-comment-time">{fmt(c.createdAt)}</span>
                    </div>
                    <div className="tdp-comment-text md">
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight, mentionPlugin]}
                      >
                        {c.body}
                      </Markdown>
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      <div className="tdp-compose">
        {showMention && (
          <div className="tdp-mention-menu">
            {mentionMatches.map((a, i) => (
              <div
                key={a.id}
                className={`tdp-mention-item ${i === mentionIdx ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(a);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <Avatar
                  size={18}
                  style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 10, flex: 'none' }}
                >
                  {initial(a.name)}
                </Avatar>
                <span className="tdp-mention-name">{a.name}</span>
                {!a.runnerId && <span className="tdp-mention-norunner">No runner</span>}
              </div>
            ))}
          </div>
        )}
        <Input.TextArea
          ref={taRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          placeholder="Add a comment…  type @ to mention an agent  (⌘/Ctrl + Enter to send)"
          autoSize={{ minRows: 1, maxRows: 4 }}
          onKeyDown={(e) => {
            if (showMention) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionMatches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                return;
              }
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                pickMention(mentionMatches[mentionIdx]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMentionDismissed(true);
                return;
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button type="primary" onClick={submit} loading={addComment.isPending} disabled={!draft.trim()}>
          Send
        </Button>
      </div>
    </aside>
  );
}
