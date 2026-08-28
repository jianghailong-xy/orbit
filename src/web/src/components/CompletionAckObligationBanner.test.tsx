import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ControlPlaneObligation } from '../api';
import {
  CompletionAckObligationBanner,
  controlPlaneObligationsOf,
} from './CompletionAckObligationBanner';
import { sessionLine } from './WorkspaceView';

const obligation: ControlPlaneObligation = {
  obligationId: 'obl-control-plane-ack-7',
  obligationRevision: 4,
  reason: 'A successful command is waiting for its canonical completion receipt to commit.',
  owner: 'PROJECT_COORDINATOR',
  requiredAction: 'Deploy the compatible writer, then let the original callback acknowledge.',
  actionProtocol: {
    steps: ['diagnose', 'repair', 'test', 'deploy', 'verify', 'recover'],
  },
  firstFailureAt: '2026-08-28T13:45:50.000Z',
  latestFailureAt: '2026-08-28T14:03:12.000Z',
  observationCount: 522,
  factKind: 'CONTROL_PLANE_COMMIT_REJECTED',
  errorFingerprint: 'P0001:TASK_DONE_CANONICAL_FACT_REQUIRED',
};

describe('CompletionAckObligationBanner', () => {
  it('renders the same canonical identity and remediation carried by the session row', () => {
    const session = { status: 'RUNNING', controlPlaneObligations: [obligation] };
    const row = sessionLine(session, true);
    const html = renderToStaticMarkup(
      <CompletionAckObligationBanner obligations={session.controlPlaneObligations} />,
    );

    expect(row.text).toBe('Command finished · completion receipt retrying');
    expect(html).toContain(`data-obligation-id="${obligation.obligationId}"`);
    expect(html).toContain('data-obligation-revision="4"');
    expect(html).toContain(obligation.obligationId);
    expect(html).toContain(obligation.reason);
    expect(html).toContain('Project coordinator');
    expect(html).toContain(obligation.requiredAction);
    expect(html).not.toContain('<button');
  });

  it('requires a canonical identity before raising the high-priority warning', () => {
    expect(
      controlPlaneObligationsOf({
        controlPlaneObligations: [{ ...obligation, obligationId: '' }],
      }),
    ).toEqual([]);
  });
});
