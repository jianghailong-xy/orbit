import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { EvidenceReviewCard, RunQuestionCard } from '@orbit/shared';
import {
  parseEvidenceReview,
  parseEvidenceSendBack,
  parseRunNotice,
  parseRunQuestion,
  parseSessionOpening,
} from '../lib/orbitTurnCards';
import {
  ANSWERED_BY_SESSION,
  ANSWERED_BY_YOU,
  CLOSED_WITHOUT_ANSWER,
  COORDINATOR_WAS_TOLD,
  EVIDENCE_CLOSED,
  EVIDENCE_CONFIRMED,
  EVIDENCE_DECIDES,
  EVIDENCE_SENT_BACK,
  EVIDENCE_TO_REVIEW,
  EvidenceSentBackCard,
  EvidenceToReviewCard,
  NOTICE_FROM_RUN,
  NOTICE_STATE,
  QUESTION_FROM_RUN,
  RUN_WAS_TOLD,
  RunNoticeTurnCard,
  RunQuestionTurnCard,
  SESSION_STARTED,
  SESSION_WAS_TOLD,
  SHOW_BRIEF,
  SessionOpeningLine,
  evidenceState,
  openingSentence,
  runQuestionState,
} from './OrbitTurnCards';
import { OPEN_TASK_SESSION } from './ConfirmationReviewTurnCards';

const TASK = '01a0cca7-0000-7000-8000-0000000000d2';
const RUN = '01a0cca7-0000-7000-8000-0000000000d3';
const NOW = new Date('2026-11-11T05:20:00.000Z');

function html(node: JSX.Element): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const review = (over: Partial<EvidenceReviewCard> = {}): EvidenceReviewCard => ({
  evidenceId: 'e1', taskId: TASK, title: 'iOS/macOS: new account welcome card', revision: '1', runSessionId: RUN,
  dueAt: '2026-11-11T05:35:30.000Z', claim: 'iOS and macOS now show the welcome card.', state: 'OPEN',
  latestRevision: '1', decision: null, ...over,
});

const question = (over: Partial<RunQuestionCard> = {}): RunQuestionCard => ({
  requestId: 'r1', approvalId: 'a1', taskId: TASK, taskTitle: 'K4, K5 baseline red', runSessionId: RUN,
  replyBy: '2026-11-11T06:10:00.000Z', state: 'OPEN', approvalStatus: 'PENDING',
  questions: [{ question: 'Keep its place?', options: [{ label: 'Keep its place' }, { label: 'Go to the back' }] }],
  answers: null, answeredBy: null, ...over,
});

describe('Evidence to review', () => {
  it('names the task, the revision and its deadline, the claim, who decides, the way onto the run, and folds the block', () => {
    const block = '<orbit-evidence-review task="t">\nA run submitted evidence.\n</orbit-evidence-review>';
    const card = parseEvidenceReview({ text: '', evidenceReview: review() });
    expect(card).not.toBeNull();
    const out = html(<EvidenceToReviewCard card={card!} told={block} />);
    expect(out).toContain(EVIDENCE_TO_REVIEW);
    expect(out).toContain('iOS/macOS: new account welcome card');
    expect(out).toContain('/tasks/');
    expect(out).toMatch(/Revision 1 · Due \d/u);
    expect(out).toContain('iOS and macOS now show the welcome card.');
    expect(out).toContain(OPEN_TASK_SESSION);
    expect(out).toContain(SESSION_WAS_TOLD);
    expect(out).not.toContain('is-neutral');
  });

  it('says where it stands as the rows read now', () => {
    expect(evidenceState(review({ dueAt: null }), NOW).text).toBe(EVIDENCE_DECIDES);
    expect(evidenceState(review(), NOW).text).toMatch(/^This session decides it\. If it hasn't by .+, you're asked\.$/u);
    expect(evidenceState(review({ dueAt: '2026-11-11T05:00:00.000Z' }), NOW)).toMatchObject({ tone: 'warn' });
    expect(evidenceState(review({ dueAt: '2026-11-11T05:00:00.000Z' }), NOW).text).toMatch(/^You were asked at /u);
    expect(evidenceState(review({ state: 'SUPERSEDED', latestRevision: '2' }), NOW).text)
      .toBe('Revision 2 replaced it. Nothing to decide.');
    expect(evidenceState(review({ state: 'DECIDED', decision: 'CONFIRM' }), NOW)).toEqual({ text: EVIDENCE_CONFIRMED, tone: 'ok' });
    expect(evidenceState(review({ state: 'DECIDED', decision: 'SEND_BACK' }), NOW).text).toBe('Sent back.');
    expect(evidenceState(review({ state: 'CLOSED' }), NOW).text).toBe(EVIDENCE_CLOSED);
    const done = html(<EvidenceToReviewCard card={review({ state: 'DECIDED', decision: 'CONFIRM' })} told="" />);
    expect(done).toContain('is-neutral');
    expect(done).not.toContain(OPEN_TASK_SESSION);
  });

  it('parses nothing from a payload that is not one', () => {
    expect(parseEvidenceReview({ text: 'hi' })).toBeNull();
    expect(parseEvidenceReview({ evidenceReview: { ...review(), state: 'MAYBE' } })).toBeNull();
    expect(parseEvidenceReview({ evidenceReview: { taskId: TASK } })).toBeNull();
  });
});

describe('Evidence sent back', () => {
  it('says which revision, who sent it back, and their note', () => {
    const block = '<orbit-evidence-send-back task="t" revision="1">\n…\n</orbit-evidence-send-back>';
    const bySession = parseEvidenceSendBack({ text: block, evidenceSendBack: {
      decisionId: 'd1', taskId: TASK, title: 'iOS/macOS: new account welcome card', revision: '1',
      note: 'The macOS screenshot is missing.', by: 'SESSION', bySessionId: RUN, byTitle: '新用户欢迎卡片',
    } });
    const out = html(<EvidenceSentBackCard card={bySession!} told={block} />);
    expect(out).toContain(EVIDENCE_SENT_BACK);
    expect(out).toContain('Revision 1 · by ');
    expect(out).toContain('/sessions/');
    expect(out).toContain('“The macOS screenshot is missing.”');
    expect(out).toContain(RUN_WAS_TOLD);
    const byYou = html(<EvidenceSentBackCard card={{ ...bySession!, by: 'OWNER', bySessionId: null, byTitle: null }} told="" />);
    expect(byYou).toContain('Revision 1 · by you');
    expect(parseEvidenceSendBack({ evidenceSendBack: { ...bySession!, by: 'SOMEONE' } })).toBeNull();
  });
});

describe('Question from a task run', () => {
  it('lists the questions read-only, and says who answers by when', () => {
    const card = parseRunQuestion({ text: '', runQuestion: question() });
    const out = html(<RunQuestionTurnCard card={card!} told="<orbit-run-question/>" />);
    expect(out).toContain(QUESTION_FROM_RUN);
    expect(out).toContain('Keep its place?');
    expect(out).toContain('Go to the back');
    expect(out).toContain(OPEN_TASK_SESSION);
    expect(out).toContain(COORDINATOR_WAS_TOLD);
    expect(out).not.toContain('<button type="button" class="crc-answer');
    expect(runQuestionState(card!, NOW).text)
      .toMatch(/^The run is waiting\. This session answers it; if it hasn't by .+, you're asked\.$/u);
  });

  it('ticks what was answered, and by whom', () => {
    const answered = question({ answers: { 'Keep its place?': ['Keep its place', 'only on Fridays'] }, answeredBy: 'SESSION', state: 'REPLIED' });
    const out = html(<RunQuestionTurnCard card={answered} told="" />);
    expect(out).toContain('✓ Keep its place');
    expect(out).toContain('✓ “only on Fridays”');
    expect(out).not.toContain(OPEN_TASK_SESSION);
    expect(runQuestionState(answered, NOW)).toEqual({ text: ANSWERED_BY_SESSION, tone: 'ok' });
    expect(runQuestionState({ ...answered, answeredBy: 'OWNER' }, NOW).text).toBe(ANSWERED_BY_YOU);
    expect(runQuestionState(question({ replyBy: '2026-11-11T05:00:00.000Z' }), NOW).text).toMatch(/^Passed to you at /u);
    expect(runQuestionState(question({ state: 'NO_REPLY', approvalStatus: 'ABANDONED' }), NOW).text).toBe(CLOSED_WITHOUT_ANSWER);
    expect(parseRunQuestion({ runQuestion: { ...question(), questions: [] } })).toBeNull();
  });
});

describe('Notice from a task run', () => {
  it('quotes the run, and says nothing waits for a reply', () => {
    const card = parseRunNotice({ text: '', runNotice: {
      requestId: 'n1', taskId: TASK, taskTitle: 'K4, K5 baseline red', runSessionId: RUN,
      message: 'The emulator is down.', state: 'READ',
    } });
    const out = html(<RunNoticeTurnCard card={card!} told="<orbit-run-notice/>" />);
    expect(out).toContain(NOTICE_FROM_RUN);
    expect(out).toContain('“The emulator is down.”');
    expect(out).toContain(NOTICE_STATE);
    expect(out).toContain('is-neutral');
    expect(parseRunNotice({ runNotice: { requestId: 'n1' } })).toBeNull();
  });
});

describe('A session Orbit opened', () => {
  it('is one line saying why, with the brief folded and the target linked', () => {
    const card = parseSessionOpening({ text: 'You are the coordinator…', sessionOpening: {
      kind: 'COORDINATOR', target: { kind: 'PROJECT', id: TASK, title: '落地检查分两层与基线红' }, mention: null,
    } });
    const out = html(<SessionOpeningLine card={card!} brief="You are the coordinator…" />);
    expect(out).toContain('Orbit started this session as the coordinator of ');
    expect(out).toContain('/projects/');
    expect(out).toContain(SHOW_BRIEF);
    expect(out).not.toContain('You are the coordinator…');
  });

  it('says each kind its own way, and shows a mention’s comment as the owner wrote it', () => {
    const target = { kind: 'TASK' as const, id: TASK, title: 'Welcome email' };
    expect(openingSentence({ kind: 'JUDGMENT', target, mention: null })).toBe('Orbit started this session to judge ');
    expect(openingSentence({ kind: 'DISPATCH', target: { ...target, kind: 'LIST' }, mention: null }))
      .toBe('Orbit started this session to dispatch the list ');
    expect(openingSentence({ kind: 'MENTION', target, mention: 'check it' })).toBe('Orbit started this session for your mention on ');
    expect(openingSentence({ kind: 'OTHER', target: null, mention: null })).toBe(SESSION_STARTED);
    expect(openingSentence({ kind: 'COORDINATOR', target: null, mention: null })).toBe(SESSION_STARTED);
    const out = html(<SessionOpeningLine card={{ kind: 'MENTION', target, mention: '@agent check the sender domain' }} brief="…" />);
    expect(out).toContain('“@agent check the sender domain”');
    const list = html(<SessionOpeningLine card={{ kind: 'DISPATCH', target: { ...target, kind: 'LIST' }, mention: null }} brief="…" />);
    expect(list).toContain('/lists/');
    expect(parseSessionOpening({ sessionOpening: { kind: 'SOMETHING' } })).toBeNull();
  });
});
