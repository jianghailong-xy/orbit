// The stylesheets in main.tsx's order: the overlays', the review cards' and highlight.js's ahead of the
// reset and index.css, as the app's production build links them.
import '../src/components/ui/Overlay.css';
import '../src/components/ReviewCard.css';
import 'highlight.js/styles/github.css';
import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { App as AntApp, ConfigProvider } from 'antd';
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import type { ConfirmationReturnCard, ConfirmationReviewRequestCard, ProjectClosedQuestion } from '@orbit/shared';
import { ThemeProvider, useThemeMode } from '../src/lib/theme';
import { darkTheme, lightTheme } from '../src/theme';
import { ToastViewport } from '../src/components/ToastViewport';
import { ReviewRequestedCard, SentBackByReviewerCard } from '../src/components/ConfirmationReviewTurnCards';
import { AnsweredQuestionCard } from '../src/components/CoordinatorQuestionCard';
import { SessionCriteriaDecisionCard } from '../src/components/CriteriaDecisionCard';
import { SessionDecisionStrip } from '../src/components/DecisionRail';
import { SessionEvidenceDecisionCard } from '../src/components/EvidenceDecisionCard';
import { OwnerDecisionReceipt, SessionOwnerConfirmationCard, type RecordedOwnerDecision } from '../src/components/OwnerConfirmationCard';
import { OwnerConfirmationReopen } from '../src/components/OwnerConfirmationReopen';
import { ProjectStartDialog, SessionStartProjectCard } from '../src/components/StartProjectCard';
import reviewFixture from '../../shared/src/owner-confirmation-review.fixture.json';
import ids from './p43b-cards-ids.json';

// The P4.3b decision cards a session's conversation draws (WorkspaceView, P5's page): the real wired
// components, mounted with the providers main.tsx gives the app, reading and pressing through REST
// fixtures the spec installs (p43b-cards-fixtures.mjs). The same page runs on the same-commit
// reference tree (the cards on AntD) and on the delivery, so the two are compared on identical data.

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } });

const at = '2026-09-28T11:40:00.000Z';
const requestCard: ConfirmationReviewRequestCard = {
  requestId: 'review-request-1', reviewId: 'review-1', taskId: ids.ownerTask, title: 'File the September invoices',
  runSessionId: ids.runSession, branch: 'orbit/invoices-0928', sha: '59d9815', dueAt: '2026-09-28T12:10:00.000Z',
};
const returnCard: ConfirmationReturnCard = {
  requestId: 'review-request-1', recordId: 'record-1', reviewerSessionId: ids.reviewer, reviewerTitle: 'Invoice reviewer',
  reason: 'Two invoices are filed twice, and the summary does not add up.',
  problems: [
    { key: 'p1', text: 'invoice-0912.pdf and invoice-0912 (1).pdf are the same invoice.', evidenceRefs: [] },
    { key: 'p2', text: 'summary.csv totals 18,240.00; the statement says 18,120.00.', evidenceRefs: [] },
  ],
} as ConfirmationReturnCard;
// A confirmation the review came in after, and found a problem with (the shared review fixture).
const late = (reviewFixture.answers as unknown as Array<{ case: string; decided: RecordedOwnerDecision }>)
  .find((each) => each.case.startsWith('confirmed while it was under review'))!.decided;
// Two coordinator questions that have ended, as the conversation draws them (main 3ff232299): one
// answered with an option and a note and delivered, one the coordinator withdrew with a reason.
const recordsNow = new Date('2026-09-28T12:00:00.000Z');
const answeredQuestion: ProjectClosedQuestion = {
  itemId: 'question-record-answered',
  question: {
    question: 'The notes for the overlays and the pickers both build on the shared examples page.\n\nShould the pickers notes wait for that page, or start on a page of their own?',
    options: [
      { label: 'Wait for the shared examples page', description: 'One page to keep up to date.' },
      { label: 'Start on a page of their own' },
    ],
    recommendedOption: 0,
    blocksTaskIds: [],
    ifUnanswered: 'the pickers notes stay waiting',
  },
  askedAt: '2026-09-28T11:20:00.000Z',
  resolution: 'ANSWERED',
  resolvedBy: 'USER',
  resolvedAt: '2026-09-28T11:35:00.000Z',
  answer: { option: 0, text: 'Keep each example to one screen.' },
  delivery: { sessionId: ids.runSession, at: '2026-09-28T11:35:00.000Z' },
  withdrawReason: null,
};
const withdrawnQuestion: ProjectClosedQuestion = {
  itemId: 'question-record-withdrawn',
  question: {
    question: 'Should the README link every note, or one index page?',
    options: [],
    recommendedOption: null,
    blocksTaskIds: [],
    ifUnanswered: null,
  },
  askedAt: '2026-09-28T11:10:00.000Z',
  resolution: 'WITHDRAWN',
  resolvedBy: 'COORDINATOR',
  resolvedAt: '2026-09-28T11:30:00.000Z',
  answer: null,
  delivery: null,
  withdrawReason: 'The plan now links one index page.',
};

function Section({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <section className="p43b-case" data-case={name} aria-label={title}>
      <h2 className="p43b-case-title">{title}</h2>
      {children}
    </section>
  );
}

function Cards() {
  const { resolved } = useThemeMode();
  const [startOpen, setStartOpen] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const note = (what: string) => () => setEvents((previous) => [...previous, what]);
  return (
    <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
      <AntApp>
        <BrowserRouter>
          <main style={{ maxWidth: 820, width: '100%', margin: '0 auto', padding: '24px 16px', boxSizing: 'border-box' }}>
            <h1 tabIndex={-1} style={{ fontSize: 18, margin: '0 0 16px' }}>P4.3b decision cards</h1>
            <output data-testid="events" style={{ display: 'block', fontSize: 12 }}>{JSON.stringify(events)}</output>
            <Section name="evidence" title="Evidence decision">
              <SessionEvidenceDecisionCard sessionId={ids.session} projectId={ids.project} onSendBack={note('evidence: send back')} />
            </Section>
            <Section name="owner" title="Owner confirmation">
              <SessionOwnerConfirmationCard sessionId={ids.session} taskId={ids.ownerTask} onSendBack={note('owner: send back')} />
            </Section>
            <Section name="criteria" title="Criteria decision">
              <SessionCriteriaDecisionCard projectId={ids.project} onDecided={note('criteria: decided')} />
            </Section>
            <Section name="strip" title="Decision strip">
              <SessionDecisionStrip sessionId={ids.session} projectId={ids.project} />
            </Section>
            <Section name="review-turns" title="Review turns">
              <ReviewRequestedCard card={requestCard} ts={at} />
              <SentBackByReviewerCard card={returnCard} ts={at} />
            </Section>
            <Section name="receipt" title="Owner decision receipt">
              <OwnerDecisionReceipt
                view={{ title: 'File the September invoices', acceptanceCriteria: 'Every September invoice is filed once.' }}
                decided={late}
                reopen={<OwnerConfirmationReopen taskId={ids.receiptTask} projectId={null} status="DONE" />}
              />
            </Section>
            <Section name="question-records" title="Ended coordinator questions">
              <AnsweredQuestionCard record={answeredQuestion} now={recordsNow} />
              <AnsweredQuestionCard record={withdrawnQuestion} now={recordsNow} />
            </Section>
            <Section name="live-start" title="Start card in a conversation">
              <SessionStartProjectCard projectId={ids.liveStartProject} />
            </Section>
            <Section name="start" title="Start dialog">
              <button type="button" onClick={() => setStartOpen(true)}>Open the start dialog</button>
              <ProjectStartDialog projectId={ids.startProject} asked open={startOpen} onClose={() => setStartOpen(false)} />
            </Section>
          </main>
          <ToastViewport />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Cards />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
