// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DoneRequest } from '@orbit/shared';
import { ProjectDoneCard, ProjectWhyNotDoneCard } from './ProjectSettlementCard';
import {
  PROJECT_DONE_COPY,
  projectDoneCardTally,
  projectDoneReceiptTally,
  projectDoneTally,
  projectWhyNotDoneTally,
} from '../lib/projectDone';

const project = {
  id: 'p1',
  title: 'Project closeout',
  status: 'OPEN' as const,
  acceptanceCriteriaItems: [
    { id: 'c1', ordinal: 1, text: 'The release is on main' },
    { id: 'c2', ordinal: 2, text: 'The live check was completed' },
  ],
  derivedDone: {
    status: 'OPEN' as const,
    done: false,
    withheld: ['CRITERION_UNLANDED'],
    confirmation: 'CONFIRMED' as const,
    criteria: [
      { definitionId: 'c1', satisfied: true, landing: 'LANDED' as const, landingReason: null },
      { definitionId: 'c2', satisfied: true, landing: 'LANDED' as const, landingReason: 'NOTHING_TO_LAND' as const },
    ],
    counts: {
      criteria: 2,
      met: 2,
      landed: 2,
      onMain: 1,
      byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 1, NO_RECEIPT: 0, CODELESS: 0 },
    },
  },
};

const request: DoneRequest = {
  criteriaDigest: 'digest-1',
  judgment: 'The goal is met. I checked the release evidence below.',
  gaps: [{
    criterionKey: 'c2',
    title: 'The live check was completed',
    whyNotProven: 'The task made no commits.',
    coordinatorChecked: 'main contains the release files',
    evidenceRefs: ['run-42'],
  }],
};

describe('owner project settlement card', () => {
  it('renders the coordinator call, server counts, gaps, checked line, and both answers', () => {
    const html = renderToStaticMarkup(
      <ProjectDoneCard
        project={project}
        doneRequest={request}
        standing={{
          state: 'CONFIRMED',
          confirmed: true,
          currentVersion: { digest: 'digest-1', material: [] },
          confirmation: { criteriaDigest: 'digest-1', criteriaMaterial: [], confirmedAt: '2026-09-29T00:00:00Z', confirmedById: 'u1' },
        }}
        onRecordDone={() => {}}
        onNotYet={() => {}}
      />,
    );
    expect(html).toContain(PROJECT_DONE_COPY.heading);
    expect(html).toContain(PROJECT_DONE_COPY.coordinatorCall);
    expect(html).toContain('2 met · 1 landed on main · 1 nothing to land');
    expect(html).toContain(PROJECT_DONE_COPY.whatOrbitCantProve);
    expect(html).toContain('Coordinator checked');
    expect(html).toContain('Orbit checked');
    expect(html).toContain(PROJECT_DONE_COPY.recordAsDone);
    expect(html).toContain(PROJECT_DONE_COPY.notYet);
  });

  it('uses only the unified counts for the tally', () => {
    expect(projectDoneTally(project.derivedDone.counts)).toBe(
      '2 criteria · 2 met · 1 landed on main · 1 nothing to land',
    );
  });

  it('keeps the card and receipt count copy to the three effect counts', () => {
    expect(projectDoneCardTally(project.derivedDone.counts)).toBe(
      '2 met · 1 landed on main · 1 nothing to land',
    );
    expect(projectDoneReceiptTally(project.derivedDone.counts, 1)).toBe(
      '2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted',
    );
    // Its parts add up to the criteria: no "2 met" counted a second time beside where they are.
    expect(projectWhyNotDoneTally(project.derivedDone)).toBe(
      '2 criteria · 1 on main · 1 nothing to land',
    );
  });

  it('does not offer Ask the coordinator when the only gaps are already being handled', () => {
    const html = renderToStaticMarkup(
      <ProjectWhyNotDoneCard
        project={{
          ...project,
          derivedDone: {
            ...project.derivedDone,
            criteria: [{ definitionId: 'c1', satisfied: true, landing: 'ON_INTEGRATION_LINE', landingReason: 'IN_FLIGHT' as const }],
            counts: {
              criteria: 1,
              met: 1,
              landed: 0,
              onMain: 0,
              byReason: { IN_FLIGHT: 1, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 },
            },
          },
        }}
        openItems={{ withCoordinator: [{ itemId: 'i1' } as never] }}
        onAskCoordinator={vi.fn()}
      />,
    );
    expect(html).toContain(PROJECT_DONE_COPY.waitingOnWork);
    expect(html).toContain(PROJECT_DONE_COPY.coordinatorIsOnIt);
    expect(html).not.toContain('Ask the coordinator to handle it');
  });

  it('keeps unmet codeless work in Waiting on work instead of treating it as settled', () => {
    const html = renderToStaticMarkup(
      <ProjectWhyNotDoneCard
        project={{
          ...project,
          derivedDone: {
            ...project.derivedDone,
            done: false,
            criteria: [{
              definitionId: 'c2',
              satisfied: false,
              landing: 'UNKNOWN' as const,
              landingReason: 'CODELESS' as const,
            }],
            counts: {
              criteria: 1,
              met: 0,
              landed: 0,
              onMain: 0,
              byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 1 },
            },
          },
        }}
      />,
    );
    expect(html).toContain(PROJECT_DONE_COPY.waitingOnWork);
    expect(html).not.toContain(PROJECT_DONE_COPY.thisProjectIsDone);
  });
});
