import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectDoneCheck, ProjectDoneFinding } from '@orbit/shared';
import { describe, expect, it } from 'vitest';
import { ProjectDoneCard } from './ProjectSettlementCard';
import { AcceptanceCriteriaCard, type AcceptanceCriterionItem } from './ProjectAcceptanceCard';
import {
  ACCEPTANCE_STANDING_MIXED,
  CRITERION_CHECK_FAILED,
  CRITERION_CONFIRM,
  CRITERION_CONFIRM_AGAIN,
  CRITERION_CONFIRMED_BY_COORDINATOR,
  CRITERION_RUN_CHECK_AGAIN,
  CRITERION_STALE,
  CRITERION_WAITS_CONFIRMATION,
  CRITERION_WITHDRAW,
  DONE_CARD_MOVE_TO_FOLLOW_UP,
  DONE_CARD_OPEN,
  LANDING_NO_CODE_TO_LAND,
  LANDING_RAN_WITHOUT_BRANCH,
  NON_CODE_BODY,
  NON_CODE_LEAD,
  NON_CODE_MARKED_BY_COORDINATOR,
  doneFindingLine,
  projectDoneCardTally,
  projectWhyNotDoneTally,
  type CriterionConfirmationStanding,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * The done card and the acceptance rows as the boards draw them: the decided board ③ (one blocker
 * for an unmet criterion, with Open and Move to a follow-up…; a non-code project with no landing),
 * ④ (Ran without a branch) and the follow-up boards 01–03 (the mark's provenance, confirmer rows).
 */

const PROJECT = '34vfv0OR79IojfYntb8SA';
const TASK = '34vfyypl5XcTT4aneydVl';
const byReason = (over: Partial<Record<string, number>> = {}) => ({
  IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, NO_BRANCH: 0, CODELESS: 0, ...over,
});

function finding(over: Partial<ProjectDoneFinding>): ProjectDoneFinding {
  return {
    severity: 'REFUSE', code: 'DONE_NO_CRITERIA', message: 'diagnostic', requiredAction: '',
    criterion: null, reason: null, tasks: [], items: [], jobs: [], ...over,
  };
}

function check(findings: ProjectDoneFinding[], nonCode = false): ProjectDoneCheck {
  return { criteria: [], tasks: [], ownerItems: [], jobs: [], criteriaDigest: 'd', stateDigest: 's', nonCode, findings };
}

/** The CBAI shape: four criteria, three met, the fourth held by one open task, nothing landed. */
function cbai(over: Partial<ProjectDoneDocument> = {}): ProjectDoneDocument {
  const items = [
    'Criterion 1 (placeholder text)', 'Criterion 2 (91 tasks)', 'Criterion 3 (2 tasks)', 'External prerequisites settled',
  ].map((text, index) => ({ id: `c${index + 1}`, key: `k${index + 1}`, ordinal: index + 1, text, revision: 1 }));
  return {
    id: PROJECT,
    title: 'CBAI Phase 0',
    status: 'OPEN',
    acceptanceCriteriaItems: items,
    derivedDone: {
      status: 'OPEN', done: false, withheld: ['CRITERION_UNSATISFIED'], confirmation: 'CONFIRMED',
      criteria: items.map((item, index) => ({
        definitionId: item.id, satisfied: index < 3, landing: 'UNKNOWN', landingReason: 'CODELESS',
      })),
      counts: { criteria: 4, met: 3, landed: 0, onMain: 0, byReason: byReason({ CODELESS: 4 }) },
    },
    ...over,
  };
}

const unmet4 = finding({
  code: 'DONE_CRITERION_UNSATISFIED',
  criterion: { key: 'k4', ordinal: 4, text: 'External prerequisites settled' },
  tasks: [{ taskId: TASK, title: 'Settle external prerequisites (SMS, WeChat, payment, ICP)' }],
});

const card = (project: ProjectDoneDocument, findings: ProjectDoneFinding[] = []) => renderToStaticMarkup(
  <ProjectDoneCard project={project} doneCheck={check(findings)} onRecordDone={() => {}} />,
);

describe('the done card, decided board ③', () => {
  it('shows one blocker for criterion 4, naming its open task with Open, and Move to a follow-up…', () => {
    const html = card(cbai(), [unmet4]);
    expect(html).toContain('1 thing stands in the way');
    expect(html).toContain('Criterion 4 is not met — 1 task is still open');
    expect(html).toContain('Settle external prerequisites (SMS, WeChat, payment, ICP)');
    expect(html).toContain(`/projects/${PROJECT}/tasks/${TASK}"`);
    expect(html).toContain(`>${DONE_CARD_OPEN}<`);
    expect(html).toContain(DONE_CARD_MOVE_TO_FOLLOW_UP);
    expect(html).toContain('takes criterion 4 and its open tasks out of this project');
    expect(html).toContain('If you record it done anyway, Orbit keeps criterion 4 as the gap you accepted.');
    // The unmet criterion is not reported a second time as not on main, nor as "no code to land".
    expect(html).not.toContain('is not on main');
    expect(html).not.toContain('project-done-findings');
    expect(html).toContain('>not met<');
  });

  it('a non-code project shows the mark with who and when and Change, and no landing anywhere', () => {
    const project = cbai({ nonCode: true, nonCodeSetBy: 'COORDINATOR', nonCodeSetAt: '2026-11-11T10:20:00.000Z' });
    project.derivedDone = {
      ...project.derivedDone!,
      nonCode: true,
      criteria: project.derivedDone!.criteria.map((criterion) => ({ ...criterion, landingReason: null })),
      counts: { criteria: 4, met: 3, landed: 0, onMain: 0, byReason: byReason() },
    };
    const html = card(project, [unmet4]);
    expect(html).toContain(NON_CODE_LEAD);
    expect(html).toContain(NON_CODE_BODY);
    expect(html).toContain(`${NON_CODE_MARKED_BY_COORDINATOR} · Nov 11`);
    expect(html).toContain(`href="/projects/${PROJECT}#delivers"`);
    expect(html).toContain('3 of 4 met');
    expect(html.replace(NON_CODE_BODY, '')).not.toMatch(/landed|nothing to land|No code to land|Landed on/u);
    expect(projectWhyNotDoneTally(project.derivedDone)).toBe('4 criteria · 3 met · 1 not met');
  });
});

describe('after Move to a follow-up, board 02 ⑤', () => {
  it('every criterion left is met and the check finds nothing: the press is Record as done, not anyway', () => {
    const project = cbai();
    project.acceptanceCriteriaItems = project.acceptanceCriteriaItems!.slice(0, 3);
    project.derivedDone = {
      ...project.derivedDone!,
      criteria: project.derivedDone!.criteria.slice(0, 3),
      counts: { criteria: 3, met: 3, landed: 0, onMain: 0, byReason: byReason() },
    };
    const html = card(project, []);
    expect(html).toContain('>Record as done<');
    expect(html).not.toContain('Record as done anyway');
  });
});

describe('Ran without a branch, decided board ④', () => {
  it('labels the row and the tally, and the finding says why rather than "not on main"', () => {
    const project = cbai();
    project.derivedDone = {
      ...project.derivedDone!,
      criteria: project.derivedDone!.criteria.slice(0, 3).map((criterion, index) => ({
        ...criterion, satisfied: true, landing: index < 2 ? 'LANDED' : 'UNKNOWN', landingReason: index < 2 ? null : 'NO_BRANCH',
      })),
      counts: { criteria: 3, met: 3, landed: 2, onMain: 2, byReason: byReason({ NO_BRANCH: 1 }) },
    };
    const noBranch = finding({
      severity: 'WARN', code: 'DONE_CRITERION_UNLANDED', reason: 'NO_BRANCH',
      criterion: { key: 'k3', ordinal: 3, text: 'Criterion 3' },
      tasks: Array.from({ length: 6 }, (_, n) => ({ taskId: `t${n}`, title: `t${n}` })),
    });
    const html = card(project, [noBranch]);
    expect(html).toContain('3 met · 2 landed on main · 1 ran without a branch');
    expect(html).toContain(`is-met is-warn">met · ${LANDING_RAN_WITHOUT_BRANCH}`);
    expect(html).toContain('Orbit can’t prove 1 thing');
    expect(doneFindingLine(noBranch)).toBe(
      'Criterion 3: 6 tasks ran without a branch, so Orbit can’t see whether their changes reached main. '
        + 'Check main yourself before recording it done.',
    );
    expect(html).not.toContain(LANDING_NO_CODE_TO_LAND);
  });

  it('reads the reason for every unlanded finding; only no merge seen says not on main', () => {
    const at = (reason: ProjectDoneFinding['reason']) => doneFindingLine(finding({
      severity: 'WARN', code: 'DONE_CRITERION_UNLANDED', reason, criterion: { key: 'k', ordinal: 2, text: '' },
    }), 'master');
    expect(at('NO_RECEIPT')).toBe('Criterion 2 is not on master');
    expect(at('ON_PROJECT_BRANCH')).toBe('Criterion 2 is on the project branch, not on master yet');
    expect(at('IN_FLIGHT')).toBe('Criterion 2 is being landed on master');
    expect(at('CODELESS')).toBe('Criterion 2 has no code to land');
    expect(at('NO_BRANCH')).toContain('Criterion 2: its work ran without a branch');
  });

  it('drops zero parts from the card tally', () => {
    expect(projectDoneCardTally({ criteria: 2, met: 2, landed: 2, onMain: 2, byReason: byReason() })).toBe('2 met · 2 landed on main');
  });
});

const at = '2026-11-10T08:02:00.000Z';
function standing(over: Partial<CriterionConfirmationStanding>): CriterionConfirmationStanding {
  return { state: 'UNCONFIRMED', current: null, stale: false, checkRunning: null, ...over };
}
const view = (confirmerKind: 'OWNER' | 'COORDINATOR' | 'AGENT_CHECK', over: Record<string, unknown> = {}) => ({
  id: `v-${confirmerKind}`, revision: 1, confirmerKind, outcome: 'CONFIRMED' as const, sessionId: confirmerKind === 'OWNER' ? null : '34vfKfVa3Q5DbRIBi4A5C',
  checkTaskId: null, note: 'Aliyun SMS template approved', attachmentIds: [], at, ...over,
});

describe('criteria met by confirmation, board 03', () => {
  it('the done card says who confirmed a met one and offers Confirm… on the others', () => {
    const project = cbai();
    project.derivedDone = {
      ...project.derivedDone!,
      criteria: [
        { definitionId: 'c1', satisfied: true, landing: 'LANDED', landingReason: null },
        { definitionId: 'c2', satisfied: true, landing: 'LANDED', landingReason: null, satisfiedBy: 'CONFIRMATION', confirmation: standing({ state: 'CONFIRMED', current: view('OWNER') }) },
        { definitionId: 'c3', satisfied: false, landing: 'LANDED', landingReason: null, satisfiedBy: 'CONFIRMATION', confirmation: standing({}) },
        { definitionId: 'c4', satisfied: false, landing: 'LANDED', landingReason: null, satisfiedBy: 'CONFIRMATION', confirmation: standing({ state: 'STALE', stale: true, current: view('OWNER') }) },
      ],
      counts: { criteria: 4, met: 2, landed: 4, onMain: 4, byReason: byReason() },
    };
    const html = card(project);
    expect(html).toContain('met · by you');
    expect(html).toContain('Confirmed by you · Nov 10 · “Aliyun SMS template approved”');
    expect(html).toContain('not met · waits for confirmation');
    expect(html).toContain(CRITERION_CONFIRM);
    expect(html).toContain('not met · confirmed for an earlier wording');
    expect(html).toContain(CRITERION_CONFIRM_AGAIN);
    expect(html).toContain('2 wait for confirmation');
  });

  it('the acceptance rows draw each confirmer, the stale wording and the mode, with the owner’s presses', () => {
    const row = (ordinal: number, over: Partial<AcceptanceCriterionItem>): AcceptanceCriterionItem => ({
      id: `r${ordinal}`, ordinal, text: `Criterion ${ordinal}`, revision: 1, verificationMethod: 'Check the console.',
      satisfiedBy: 'CONFIRMATION', satisfied: false, unmet: [{ clause: 'NOT_CONFIRMED', heldUpBy: [] }], ...over,
    });
    const criteria = [
      row(1, { satisfiedBy: 'TASKS', satisfied: true, unmet: [], landing: 'LANDED' }),
      row(2, { satisfied: true, unmet: [], confirmation: standing({ state: 'CONFIRMED', current: view('COORDINATOR', { note: 'AppID shows Approved.' }) }) }),
      row(3, { confirmation: standing({ state: 'CHECK_FAILED', current: view('AGENT_CHECK', { outcome: 'FAILED', note: 'no filing number' }) }) }),
      row(4, { revision: 2, confirmation: standing({ state: 'STALE', stale: true, current: view('OWNER') }) }),
      row(5, { confirmation: standing({}) }),
    ];
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AcceptanceCriteriaCard criteria={criteria} integrationRef={null} projectId={PROJECT} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain(ACCEPTANCE_STANDING_MIXED.replace('{n}', '5').replace('{a}', '1').replace('{b}', '4'));
    expect(html).toContain(CRITERION_CONFIRMED_BY_COORDINATOR);
    expect(html).toContain('“AppID shows Approved.”');
    expect(html).toContain(CRITERION_WITHDRAW);
    expect(html).toContain('Open conversation');
    expect(html).toContain(CRITERION_CHECK_FAILED);
    expect(html).toContain('FAIL — no filing number');
    expect(html).toContain(CRITERION_RUN_CHECK_AGAIN);
    expect(html).toContain(CRITERION_STALE);
    expect(html).toContain('You confirmed revision 1 on Nov 10. The wording has changed since.');
    expect(html).toContain(CRITERION_CONFIRM_AGAIN);
    expect(html).toContain(CRITERION_WAITS_CONFIRMATION);
    expect(html).toContain('Met by: <b>its tasks</b>');
    expect(html).toContain('Met by: <b>confirmation</b>');
  });

  it('a public page draws the same states and none of the presses', () => {
    const html = renderToStaticMarkup(
      <AcceptanceCriteriaCard
        integrationRef={null}
        criteria={[{ id: 'r1', ordinal: 1, text: 'SMS provider is live', revision: 1, satisfiedBy: 'CONFIRMATION', satisfied: true, unmet: [], confirmation: standing({ state: 'CONFIRMED', current: view('OWNER') }) }]}
      />,
    );
    expect(html).toContain('Met · confirmed by you');
    expect(html).not.toContain(CRITERION_WITHDRAW);
    expect(html).not.toContain('Met by:');
  });
});
