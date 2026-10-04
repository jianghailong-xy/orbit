import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApprovalPanel } from '../src/components/ApprovalPanel';
import type { ApprovalInfo } from '../src/api';
import { ThemeProvider } from '../src/lib/theme';

const approval = (toolName: string, input: unknown): ApprovalInfo => ({
  id: toolName, sessionId: 'review-fixture', toolName, input, status: 'PENDING', createdAt: '2026-10-04T00:00:00.000Z',
});
const background = approval('Bash', { command: 'pwd' });
const question = approval('AskUserQuestion', { questions: [{
  question: 'Which branches should receive the change?', multiSelect: true,
  options: [{ label: 'Main' }, { label: 'Release' }],
}] });
const plan = approval('ExitPlanMode', {
  plan: '# Review the migration plan\n\n' + Array.from({ length: 80 }, (_, index) =>
    `## Step ${index + 1}\n\nKeep the existing confirmation, draft and keyboard behavior while reviewing this long plan.\n\n`).join(''),
});

function Reviews() {
  const [decisions, setDecisions] = useState<unknown[][]>([]);
  const decide = (...args: unknown[]) => setDecisions((previous) => [...previous, args]);
  return <main style={{ maxWidth: 900, width: '100%', margin: '0 auto', padding: 24 }}>
    <h1 tabIndex={-1}>Compact review behavior</h1>
    <output data-testid="decisions">{JSON.stringify(decisions)}</output>
    <ApprovalPanel approval={background} active onDecide={decide} />
    <ApprovalPanel approval={question} onDecide={decide} />
    <ApprovalPanel approval={plan} active onDecide={decide} />
  </main>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(<StrictMode>
  <QueryClientProvider client={client}><ThemeProvider><Reviews /></ThemeProvider></QueryClientProvider>
</StrictMode>);
