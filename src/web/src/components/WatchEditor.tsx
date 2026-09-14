import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Checkbox, Modal, Radio, Select } from 'antd';
import {
  WATCH_LIMITS,
  type UpdateWatchRequest,
  type WatchAction,
  type WatchTargetKind,
  type WatchView,
} from '@orbit/shared';
import { sessionSearchQuery, watchesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { compatibleUuid } from '../lib/uuid';
import {
  DEFAULT_LEAF,
  EDITOR_PREDICATE_VERSION,
  LEAF_COPY,
  TTL_CHOICES,
  choiceOf,
  createWatch,
  createWatchBody,
  describeCondition,
  expiryLabel,
  leavesFor,
  predicateFor,
  sameResourceId,
  updateWatch,
  watchErrorMessage,
  type ConditionChoice,
} from '../lib/watches';
import { WatchTargetLink, useNow } from './WatchParts';

export type WatchEditorMode =
  | { kind: 'create'; targets: readonly { kind: WatchTargetKind; id: string }[] }
  | { kind: 'edit'; watch: WatchView };

/** The deadline choice that leaves an edited watch's expiry where it is. */
const KEEP_DEADLINE = 'keep';

/** How many targets the dialog names before "+N more". */
const SHOWN_TARGETS = 6;

const sameChoice = (a: ConditionChoice | null, b: ConditionChoice | null): boolean =>
  !!a && !!b && a.leaf === b.leaf && a.aggregation === b.aggregation && !!a.orAnyFails === !!b.orAnyFails;

/**
 * Follow (create) or edit a watch. Following asks the three things a watch is — what to wait for, what
 * to do then, and until when — over the targets Follow was pressed on. Editing may change only the
 * condition and the deadline: the server keeps a watch's targets and action as created.
 */
export function WatchEditorModal({ mode, onClose }: { mode: WatchEditorMode; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const editing = mode.kind === 'edit' ? mode.watch : null;
  const targets =
    mode.kind === 'edit'
      ? mode.watch.targets.map((t) => ({ kind: t.targetKind, id: t.targetResourceId }))
      : mode.targets;
  const kinds = [...new Set(targets.map((t) => t.kind))];
  const kind = kinds.length === 1 ? kinds[0] : null;
  const several = targets.length > 1;
  const stored = editing ? choiceOf(editing.predicate) : null;
  // A condition this dialog cannot say — an agent's composite, or one over sessions and tasks at
  // once — is kept exactly as stored, and only its deadline can be changed here.
  const fixedCondition = !kind || (!!editing && !stored);
  const [choice, setChoice] = useState<ConditionChoice | null>(() =>
    editing ? stored : kind ? { leaf: DEFAULT_LEAF[kind], aggregation: 'ALL' } : null,
  );
  const [action, setAction] = useState<WatchAction>('NOTIFY_USER');
  const [observer, setObserver] = useState<string | undefined>();
  const [ttl, setTtl] = useState<number | typeof KEEP_DEADLINE>(
    editing ? KEEP_DEADLINE : WATCH_LIMITS.defaultTtlSeconds,
  );
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: a retried Follow returns the watch the first press made.
  const [idempotencyKey] = useState(compatibleUuid);

  const save = useMutation({
    mutationFn: (): Promise<WatchView> => {
      if (mode.kind === 'create') {
        return createWatch(
          createWatchBody({
            targets,
            choice: choice!,
            action,
            observerSessionId: observer,
            ttlSeconds: ttl === KEEP_DEADLINE ? WATCH_LIMITS.defaultTtlSeconds : ttl,
            idempotencyKey,
          }),
        );
      }
      const body: UpdateWatchRequest = {};
      if (!fixedCondition && choice && !sameChoice(choice, stored)) {
        body.predicateVersion = EDITOR_PREDICATE_VERSION;
        body.predicate = predicateFor(choice);
      }
      if (ttl !== KEEP_DEADLINE) body.ttlSeconds = ttl;
      return updateWatch(mode.watch.id, body);
    },
    onSuccess: (saved) => {
      if (saved?.id) {
        qc.setQueryData<WatchView[]>(watchesQuery().queryKey, (rows) =>
          rows?.some((row) => row.id === saved.id)
            ? rows.map((row) => (row.id === saved.id ? saved : row))
            : rows && [saved, ...rows],
        );
      }
      void qc.invalidateQueries({ queryKey: watchesQuery().queryKey });
      toast.success(
        mode.kind === 'edit'
          ? 'Watch updated'
          : saved?.state === 'MATCHED'
            ? 'Already true, so the watch triggered at once'
            : 'Following',
      );
      onClose();
    },
    onError: (err) => setError(watchErrorMessage(err)),
  });

  const dirty = ttl !== KEEP_DEADLINE || (!fixedCondition && !sameChoice(choice, stored));
  const canSave = editing ? dirty : !!choice && (action === 'NOTIFY_USER' || !!observer);
  const noun = kind === 'SESSION' ? 'session' : kind === 'TASK' ? 'task' : 'target';
  const kept = editing ? expiryLabel(editing, now) : null;

  return (
    <Modal
      open
      title={editing ? 'Edit watch' : `Follow ${several ? `${targets.length} ${noun}s` : noun}`}
      okText={editing ? 'Save' : 'Follow'}
      okButtonProps={{ disabled: !canSave }}
      confirmLoading={save.isPending}
      onOk={() => {
        setError(null);
        save.mutate();
      }}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="watch-editor">
        <div className="watch-editor-field">
          <div className="watch-editor-label">Watching</div>
          <div className="watch-targets">
            {targets.slice(0, SHOWN_TARGETS).map((t) => (
              <WatchTargetLink key={`${t.kind}:${t.id}`} kind={t.kind} id={t.id} />
            ))}
            {targets.length > SHOWN_TARGETS && (
              <span className="watch-muted">+{targets.length - SHOWN_TARGETS} more</span>
            )}
          </div>
        </div>

        <div className="watch-editor-field">
          <div className="watch-editor-label">
            {several ? `Wait until the ${noun}s…` : `Wait until the ${noun}…`}
          </div>
          {fixedCondition || !kind || !choice ? (
            <div className="watch-editor-fixed">
              {editing ? describeCondition(editing.predicate, editing.targets) : 'These targets cannot share one condition.'}
              <span className="watch-editor-hint">
                This condition was set elsewhere and can’t be changed here. Its deadline can.
              </span>
            </div>
          ) : (
            <>
              {several && (
                <Radio.Group
                  className="watch-editor-aggregation"
                  optionType="button"
                  size="small"
                  value={choice.aggregation}
                  onChange={(e) =>
                    setChoice({
                      ...choice,
                      aggregation: e.target.value,
                      orAnyFails: e.target.value === 'ALL' && choice.orAnyFails,
                    })
                  }
                  options={[
                    { value: 'ALL', label: `All ${targets.length}` },
                    { value: 'ANY', label: 'Any one' },
                  ]}
                />
              )}
              <Radio.Group
                className="watch-editor-options"
                value={choice.leaf}
                onChange={(e) =>
                  setChoice({
                    ...choice,
                    leaf: e.target.value,
                    orAnyFails: e.target.value !== 'TASK_FAILED' && choice.orAnyFails,
                  })
                }
              >
                {leavesFor(kind).map((leaf) => (
                  <Radio key={leaf} value={leaf}>
                    <span className="watch-editor-option">{LEAF_COPY[leaf].option}</span>
                    <span className="watch-editor-hint">{LEAF_COPY[leaf].hint}</span>
                  </Radio>
                ))}
              </Radio.Group>
              {kind === 'TASK' && several && choice.aggregation === 'ALL' && choice.leaf !== 'TASK_FAILED' && (
                <Checkbox
                  checked={!!choice.orAnyFails}
                  onChange={(e) => setChoice({ ...choice, orAnyFails: e.target.checked })}
                >
                  Or as soon as any of them fails
                </Checkbox>
              )}
            </>
          )}
        </div>

        <div className="watch-editor-field">
          <div className="watch-editor-label">Then</div>
          {editing ? (
            <div className="watch-editor-fixed">
              {editing.action === 'NOTIFY_USER' ? 'Notify you' : 'Resume the waiting session'}
              <span className="watch-editor-hint">
                What a watch follows and what it does are fixed when it is created.
              </span>
            </div>
          ) : (
            <>
              <Radio.Group
                className="watch-editor-options"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                <Radio value="NOTIFY_USER">
                  <span className="watch-editor-option">Notify me</span>
                </Radio>
                <Radio value="RESUME_SESSION">
                  <span className="watch-editor-option">Resume a session</span>
                  <span className="watch-editor-hint">
                    Queues one turn in that session, behind any turn it is running.
                  </span>
                </Radio>
              </Radio.Group>
              {action === 'RESUME_SESSION' && (
                <SessionPicker
                  value={observer}
                  onChange={setObserver}
                  exclude={targets.filter((t) => t.kind === 'SESSION').map((t) => t.id)}
                />
              )}
            </>
          )}
        </div>

        <div className="watch-editor-field">
          <div className="watch-editor-label">{editing ? 'Deadline' : 'Stop watching after'}</div>
          <Radio.Group
            className="watch-editor-ttl"
            optionType="button"
            size="small"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            options={[
              ...(editing ? [{ value: KEEP_DEADLINE, label: kept ? `Keep (${kept.text})` : 'Keep' }] : []),
              ...TTL_CHOICES.map((c) => ({ value: c.seconds, label: c.label })),
            ]}
          />
          <span className="watch-editor-hint">
            {editing && ttl !== KEEP_DEADLINE ? 'Counted from now. ' : ''}
            If the condition has not held by then, the watch expires
            {!editing && action === 'RESUME_SESSION' ? ' and tells the session so' : ''}. Pausing does not
            stop this clock.
          </span>
        </div>

        {error && (
          <div className="watch-problem tone-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The session a RESUME_SESSION watch will wake, found with the ⌘K palette's search. */
function SessionPicker({
  value,
  onChange,
  exclude,
}: {
  value?: string;
  onChange: (id: string | undefined) => void;
  /** The watch's own session targets: a session cannot be resumed by a watch on itself. */
  exclude: readonly string[];
}) {
  const [query, setQuery] = useState('');
  const search = useQuery(sessionSearchQuery(query));
  const hits = (search.data?.hits ?? []).filter((hit) => !exclude.some((id) => sameResourceId(id, hit.id)));
  return (
    <Select
      className="watch-editor-session"
      value={value}
      placeholder="Pick the session to resume"
      showSearch={{ filterOption: false, onSearch: setQuery }}
      loading={search.isFetching}
      notFoundContent={search.isFetching ? 'Searching…' : 'No matching session'}
      options={hits.map((hit) => ({
        value: hit.id,
        label: hit.agent?.name ? `${hit.title} · ${hit.agent.name}` : hit.title,
      }))}
      onChange={(id) => onChange(id)}
    />
  );
}
