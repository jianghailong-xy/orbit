import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { App as AntApp, ConfigProvider } from 'antd';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApprovalPanel } from '../src/components/ApprovalPanel';
import { CoordinatorQuestionCard, type ProjectOpenItemRow } from '../src/components/CoordinatorQuestionCard';
import type { ApprovalInfo } from '../src/api';
import { ThemeProvider, useThemeMode } from '../src/lib/theme';
import { darkTheme, lightTheme } from '../src/theme';

const approval = (toolName: string, input: unknown): ApprovalInfo => ({
  id: toolName, sessionId: 'review-fixture', toolName, input, status: 'PENDING', createdAt: '2026-10-04T00:00:00.000Z',
});
const background = approval('Bash', { command: 'pwd' });
const question = approval('AskUserQuestion', { questions: [{
  question: 'Which branches should receive the change?', multiSelect: true,
  options: [{ label: 'Main' }, { label: 'Release' }],
}] });
const coordinatorQuestion: ProjectOpenItemRow = {
  itemId: 'review-question', kind: 'COORDINATOR_QUESTION', title: 'Review the integration approach',
  detailLine: 'Blocks 2 tasks', assignee: 'OWNER', waitingSince: '2026-10-04T00:00:00.000Z',
  assigneeReason: 'DEFAULT', escalateAt: null, escalatedAt: null, taskId: null,
  sessionId: null, promotionId: null, fuseEpisodeId: null, facts: null, actions: [],
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  question: {
    question: [
      'The project branch and main both changed while the integration checks were running. The conflict is limited to the imports at the top of one file; both imports are still needed.',
      'The coordinator has prepared a merge that preserves both changes. The full test suite and production build pass on the combined tree. The project branch can be updated without rewriting its history.',
      'The proposed next steps are to publish the tested merge, rerun the branch checks, and leave the final review ready for the owner. Which approach should the coordinator take?',
    ].join('\n\n'),
    options: [
      { label: 'Publish the tested merge', description: 'Preserve both changes and the existing history.' },
      { label: 'Wait for the next main update' },
      { label: 'Leave the integration for manual review' },
    ],
    recommendedOption: 0, blocksTaskIds: ['task-1', 'task-2'], ifUnanswered: null,
  },
};
const plan = approval('ExitPlanMode', {
  plan: '# Review the migration plan\n\n' + Array.from({ length: 80 }, (_, index) =>
    `## Step ${index + 1}\n\nKeep the existing confirmation, draft and keyboard behavior while reviewing this long plan.\n\n`).join(''),
});

function Reviews() {
  const { resolved } = useThemeMode();
  const [decisions, setDecisions] = useState<unknown[][]>([]);
  const decide = (...args: unknown[]) => setDecisions((previous) => [...previous, args]);
  return <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}><AntApp>
    <main style={{ maxWidth: 900, width: '100%', margin: '0 auto', padding: 24 }}>
    <h1 tabIndex={-1}>Compact review behavior</h1>
    <output data-testid="decisions">{JSON.stringify(decisions)}</output>
    <ApprovalPanel approval={background} active onDecide={decide} />
    <ApprovalPanel approval={question} onDecide={decide} />
    <CoordinatorQuestionCard projectId="review-project" row={coordinatorQuestion} now={Date.parse('2026-10-04T00:01:00.000Z')} />
    <ApprovalPanel approval={plan} active onDecide={decide} />
    </main>
  </AntApp></ConfigProvider>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(<StrictMode>
  <QueryClientProvider client={client}><ThemeProvider><Reviews /></ThemeProvider></QueryClientProvider>
</StrictMode>);
