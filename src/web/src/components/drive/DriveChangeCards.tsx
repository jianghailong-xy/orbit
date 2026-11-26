import '../../pages/DrivePage.css';
import { useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import type { DriveChatChangeGroup, DriveChatQuestion } from '@orbit/shared';
import { Button } from '../ui/Button';
import { messageOf } from '../../lib/drive';
import {
  DRIVE_CHANGES_APPLY,
  DRIVE_CHANGES_APPLYING,
  DRIVE_CHANGES_NEEDS_YOU,
  DRIVE_CHANGES_PREVIEW,
  DRIVE_CHANGES_SHOW_ALL,
  DRIVE_CHANGES_SHOW_LESS,
  DRIVE_CHANGES_TITLE,
  DRIVE_CHANGES_UNDO,
  DRIVE_CHANGES_UNDOING,
  DRIVE_CHANGES_UNDONE,
  DRIVE_REPLACE_KEEP_BOTH,
  DRIVE_REPLACE_REPLACE,
  DRIVE_REPLACE_TITLE,
  answerDriveChatQuestion,
  applyDriveChatGroup,
  driveChangesDone,
  driveChangesMore,
  driveChangesPending,
  driveChangesSkipped,
  driveChatGroupsQuery,
  driveChatQuestionsQuery,
  driveGroupLines,
  driveQuestionFacts,
  driveQuestionNeedsYou,
  undoDriveChatGroup,
} from '../../lib/driveChanges';

/** One turn's changes (board drive-chat 01 ③): the result first, the first few items, Show all, Undo. */
export function DriveChangesCard({ group }: { group: DriveChatChangeGroup }) {
  const client = useQueryClient();
  const [all, setAll] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const done = () => client.invalidateQueries({ queryKey: ['drive'] });
  const undo = useMutation({ mutationFn: () => undoDriveChatGroup(group.sessionId, group.id), onSuccess: done, onError: (e) => setFailed(messageOf(e)) });
  const apply = useMutation({ mutationFn: () => applyDriveChatGroup(group.sessionId, group.id), onSuccess: done, onError: (e) => setFailed(messageOf(e)) });

  const lines = driveGroupLines(group);
  const shown = all ? lines : lines.slice(0, DRIVE_CHANGES_PREVIEW);
  const pending = group.status === 'PENDING';
  const working = group.status === 'APPLYING' || group.status === 'UNDOING' || undo.isPending || apply.isPending;
  const state = group.status === 'UNDONE' ? DRIVE_CHANGES_UNDONE : pending ? DRIVE_CHANGES_NEEDS_YOU : group.status === 'APPLYING' ? DRIVE_CHANGES_APPLYING : group.status === 'UNDOING' ? DRIVE_CHANGES_UNDOING : driveChangesDone(group.total);
  return (
    <div className={`drive-card drive-changes${pending ? ' needs-you' : ''}${group.status === 'UNDONE' ? ' undone' : ''}`} data-group={group.id} data-status={group.status}>
      <div className="drive-card-head">
        <span className="drive-card-title">{DRIVE_CHANGES_TITLE}</span>
        <span className="drive-card-state">{state}</span>
      </div>
      {pending && <div className="drive-card-note">{driveChangesPending(group.heldItems.length)}</div>}
      <ul className="drive-card-items">
        {shown.map((line) => (
          <li key={line.id}>
            <b>{line.kind}</b> <span>{line.detail}</span>
          </li>
        ))}
      </ul>
      {!all && lines.length > shown.length && <div className="drive-card-more">{driveChangesMore(lines.length - shown.length)}</div>}
      {group.skipped > 0 && <div className="drive-card-note">{driveChangesSkipped(group.skipped)}</div>}
      {failed && <div className="drive-card-error" role="alert">{failed}</div>}
      <div className="drive-card-actions">
        {lines.length > DRIVE_CHANGES_PREVIEW && (
          <Button size="small" onClick={() => setAll(!all)}>
            {all ? DRIVE_CHANGES_SHOW_LESS : DRIVE_CHANGES_SHOW_ALL}
          </Button>
        )}
        {pending && (
          <Button size="small" variant="primary" disabled={working} onClick={() => { setFailed(null); apply.mutate(); }}>
            {DRIVE_CHANGES_APPLY}
          </Button>
        )}
        {group.status === 'DONE' && (
          <Button size="small" disabled={working} onClick={() => { setFailed(null); undo.mutate(); }}>
            {DRIVE_CHANGES_UNDO}
          </Button>
        )}
      </div>
    </div>
  );
}

function QuestionFile({ label, file }: { label: string; file: DriveChatQuestion['moving'] }) {
  const facts = driveQuestionFacts(file);
  return (
    <div className="drive-card-file">
      <b>{label}</b>
      <span className="path">{facts.path}</span>
      <span>{facts.size} · {facts.writer} · {facts.when}</span>
    </div>
  );
}

/** An overwrite the chat would not make on its own (board drive-chat 01 ④): both files, the recommendation, two buttons. */
export function DriveReplaceCard({ question }: { question: DriveChatQuestion }) {
  const client = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  const answer = useMutation({
    mutationFn: (choice: 'KEEP_BOTH' | 'REPLACE') => answerDriveChatQuestion(question.sessionId, question.id, choice),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drive'] }),
    onError: (e) => setFailed(messageOf(e)),
  });
  const open = driveQuestionNeedsYou(question);
  const busy = answer.isPending || question.status === 'ANSWERING';
  return (
    <div className={`drive-card drive-replace${open ? ' needs-you' : ''}`} data-question={question.id} data-status={question.status}>
      <div className="drive-card-head">
        <span className="drive-card-title">{DRIVE_REPLACE_TITLE}</span>
        {open && <span className="drive-card-state">{DRIVE_CHANGES_NEEDS_YOU}</span>}
      </div>
      <QuestionFile label="Already there" file={question.existing} />
      <QuestionFile label="Incoming" file={question.moving} />
      {open && (
        <div className="drive-card-note">
          Recommended: {DRIVE_REPLACE_KEEP_BOTH.toLowerCase()}. Replace keeps the old file as an earlier version.
        </div>
      )}
      {question.status === 'ANSWERED' && (
        <div className="drive-card-note">
          {question.choice === 'REPLACE' ? 'Replaced. The old file is in its versions.' : `Kept both${question.outcome ? ` · saved as ${question.outcome.name}` : ''}.`}
        </div>
      )}
      {question.status === 'STALE' && <div className="drive-card-note">{question.reason ?? 'This question is no longer open.'}</div>}
      {failed && <div className="drive-card-error" role="alert">{failed}</div>}
      {open && (
        <div className="drive-card-actions">
          <Button size="small" variant="primary" disabled={busy} onClick={() => { setFailed(null); answer.mutate('KEEP_BOTH'); }}>
            {DRIVE_REPLACE_KEEP_BOTH}
          </Button>
          <Button size="small" disabled={busy} onClick={() => { setFailed(null); answer.mutate('REPLACE'); }}>
            {DRIVE_REPLACE_REPLACE}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A Drive chat's cards under its conversation, oldest first: its change groups and overwrite questions. */
export function DriveChatCards({ sessionId }: { sessionId: string }) {
  const [groups, questions] = useQueries({ queries: [driveChatGroupsQuery(sessionId, true), driveChatQuestionsQuery(sessionId, true)] });
  const cards = [
    ...(groups.data ?? []).map((group) => ({ at: group.createdAt, node: <DriveChangesCard key={group.id} group={group} /> })),
    ...(questions.data ?? []).map((question) => ({ at: question.createdAt, node: <DriveReplaceCard key={question.id} question={question} /> })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (cards.length === 0) return null;
  return <div className="drive-cards">{cards.map((card) => card.node)}</div>;
}
