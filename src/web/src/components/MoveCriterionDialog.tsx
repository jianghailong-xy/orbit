import { useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import {
  MOVE_AND_ONE_OPEN_TASK,
  MOVE_AND_OPEN_TASKS,
  MOVE_BACK,
  MOVE_CANCEL,
  MOVE_CONFIRM_ACTION,
  MOVE_CONFIRM_EXISTING,
  MOVE_CONFIRM_NEW,
  MOVE_CONFIRM_RECORD,
  MOVE_CONFIRM_THIS_ALL_MET,
  MOVE_CONFIRM_TITLE,
  MOVE_EXISTING_PROJECT,
  MOVE_FOLLOW_UP_GOAL,
  MOVE_FOLLOW_UP_TITLE,
  MOVE_KEEPS,
  MOVE_KEEPS_ALL_MET,
  MOVE_MOVES,
  MOVE_NEW_HINT,
  MOVE_NEW_PROJECT,
  MOVE_NEXT,
  MOVE_NO_OPEN_PROJECTS,
  MOVE_NOT_MOVED,
  MOVE_OPEN_ONLY,
  MOVE_PROJECT_TASKS,
  MOVE_SEARCH,
  MOVE_STAYS,
  MOVE_TITLE,
  MOVE_TO,
  moveCriterion,
} from '../lib/projectDone';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Input';
import { Radio, RadioGroup } from './ui/Radio';

/** The criterion the done card offers to move, and what the dialog needs to say about the rest. */
export interface MoveCriterionSubject {
  projectId: string;
  projectTitle: string;
  criterionKey: string;
  ordinal: number;
  text: string;
  /** The criterion's open serving tasks, as the done check named them. */
  openTasks: ReadonlyArray<{ taskId: string; title: string }>;
  /** How many criteria the project keeps after the move, and whether all of those are met. */
  keeps: number;
  keepsAllMet: boolean;
}

type Target = 'NEW' | 'EXISTING';

interface ProjectRow { id: string; title: string; status: string; _count?: { tasks?: number } }

function tasksPhrase(n: number): string {
  return n === 1 ? MOVE_AND_ONE_OPEN_TASK : MOVE_AND_OPEN_TASKS.replace('{n}', String(n));
}

/**
 * "Move to a follow-up…" (board 02 ⑥): one dialog, two steps. The first says what moves, what stays
 * and where to; the second says what each project becomes, and its press is the move. The owner's
 * alone (the door refuses a session), and refused while a moving task runs — in the door's words.
 */
export function MoveCriterionDialog({
  subject,
  open,
  onClose,
  onMoved,
}: {
  subject: MoveCriterionSubject;
  open: boolean;
  onClose: () => void;
  onMoved?: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [step, setStep] = useState<'pick' | 'confirm'>('pick');
  const [target, setTarget] = useState<Target>('NEW');
  const [title, setTitle] = useState(MOVE_FOLLOW_UP_TITLE.replace('{title}', subject.projectTitle));
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const projects = useQuery({
    queryKey: ['projects'],
    meta: { entities: ['project', 'task'] },
    queryFn: () => api<ProjectRow[]>('/projects'),
    enabled: open && target === 'EXISTING',
  });
  const candidates = (projects.data ?? [])
    .filter((row) => row.status === 'OPEN' && row.id !== subject.projectId)
    .filter((row) => row.title.toLowerCase().includes(search.trim().toLowerCase()));
  const pickedRow = (projects.data ?? []).find((row) => row.id === picked) ?? null;
  const move = useMutation({
    mutationFn: () => moveCriterion(
      subject.projectId,
      subject.criterionKey,
      target === 'NEW'
        ? {
          newProject: {
            title: title.trim(),
            goal: MOVE_FOLLOW_UP_GOAL.replace('{title}', subject.projectTitle).replace('{n}', String(subject.ordinal)),
          },
        }
        : { toProjectId: picked! },
    ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', subject.projectId] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      onMoved?.();
      onClose();
    },
  });
  const ready = target === 'NEW' ? title.trim().length > 0 : picked !== null;
  const destination = target === 'NEW' ? title.trim() : pickedRow?.title ?? '';
  const ordinal = String(subject.ordinal);
  const tasks = tasksPhrase(subject.openTasks.length);

  const footer = step === 'pick' ? (
    <>
      <Button onClick={onClose}>{MOVE_CANCEL}</Button>
      <Button variant="primary" disabled={!ready} onClick={() => setStep('confirm')}>{MOVE_NEXT}</Button>
    </>
  ) : (
    <>
      <Button onClick={() => setStep('pick')} disabled={move.isPending}>{MOVE_BACK}</Button>
      <Button variant="primary" loading={move.isPending} onClick={() => move.mutate()}>
        {MOVE_CONFIRM_ACTION.replace('{n}', ordinal)}
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={move.isPending}
      width={560}
      className="move-criterion-dialog"
      title={step === 'pick'
        ? MOVE_TITLE
        : MOVE_CONFIRM_TITLE.replace('{n}', ordinal).replace('{project}', destination)}
      footer={footer}
    >
      {step === 'pick' ? (
        <div className="move-criterion-body">
          <div className="move-criterion-label">{MOVE_MOVES}</div>
          <div className="move-criterion-moves">
            <b>{ordinal} · {subject.text}</b>{' '}
            {subject.openTasks.length > 0 ? (
              <>
                {tasks}
                {': '}
                {subject.openTasks.map((task) => task.title).join(', ')}
              </>
            ) : null}
          </div>
          <div className="move-criterion-stays">
            {MOVE_STAYS}{' '}
            {(subject.keepsAllMet ? MOVE_KEEPS_ALL_MET : MOVE_KEEPS).replace('{n}', String(subject.keeps))}
          </div>
          <div className="move-criterion-label">{MOVE_TO}</div>
          <RadioGroup<Target>
            className="move-criterion-target"
            aria-label={MOVE_TO}
            value={target}
            onValueChange={(value) => setTarget(value)}
          >
            <Radio value="NEW">{MOVE_NEW_PROJECT}</Radio>
            <Radio value="EXISTING">{MOVE_EXISTING_PROJECT}</Radio>
          </RadioGroup>
          {target === 'NEW' ? (
            <div className="move-criterion-new">
              <Input value={title} aria-label={MOVE_NEW_PROJECT} onChange={(event) => setTitle(event.target.value)} />
              <div className="move-criterion-hint">{MOVE_NEW_HINT}</div>
            </div>
          ) : (
            <div className="move-criterion-existing">
              <Input value={search} placeholder={MOVE_SEARCH} aria-label={MOVE_SEARCH} onChange={(event) => setSearch(event.target.value)} />
              <ul className="move-criterion-projects" role="listbox" aria-label={MOVE_EXISTING_PROJECT}>
                {candidates.map((row) => (
                  <li
                    key={row.id}
                    role="option"
                    aria-selected={row.id === picked}
                    className={row.id === picked ? 'is-picked' : undefined}
                    onClick={() => setPicked(row.id)}
                  >
                    <span>{row.title}</span>
                    {row._count?.tasks != null ? <span className="move-criterion-meta">{MOVE_PROJECT_TASKS.replace('{n}', String(row._count.tasks))}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="move-criterion-hint">
                {projects.isSuccess && candidates.length === 0 ? MOVE_NO_OPEN_PROJECTS : MOVE_OPEN_ONLY}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="move-criterion-body">
          <p>
            {subject.keepsAllMet
              ? MOVE_CONFIRM_THIS_ALL_MET.replace('{n}', String(subject.keeps))
              : MOVE_KEEPS.replace('{n}', String(subject.keeps))}
          </p>
          <p>
            {(target === 'NEW' ? MOVE_CONFIRM_NEW : MOVE_CONFIRM_EXISTING)
              .replace('{project}', destination)
              .replace('{n}', ordinal)
              .replace('{tasks}', subject.openTasks.length > 0 ? tasks : '')
              .replace(' ,', ',')
              .replace(' .', '.')}
          </p>
          <p className="move-criterion-hint">{MOVE_CONFIRM_RECORD}</p>
          {move.error ? <Alert type="error" title={MOVE_NOT_MOVED} description={move.error.message} /> : null}
        </div>
      )}
    </Dialog>
  );
}
