import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectDoneCard } from '../components/ProjectSettlementCard';
import {
  criteriaInFlightCount,
  projectDoneCardTally,
  projectDoneTally,
  projectWhyNotDoneTally,
  type ProjectDoneCounts,
  type ProjectDoneCriterion,
} from './projectDone';

/**
 * Unmet criteria are counted apart, never under a landing reason, held to the fixture every client
 * reads: `contracts/unmet-criteria-counts.fixtures.json` (the apiserver's
 * project-looks-finished.pg.spec.ts case (6) serves the counts it names). A missing fixture is a failure.
 */
type Fixture = {
  project: { title: string; main: string; confirmation: 'CONFIRMED' };
  criteria: Array<Pick<ProjectDoneCriterion, 'satisfied' | 'landing' | 'landingReason'> & { ordinal: number; name: string }>;
  expect: {
    counts: ProjectDoneCounts;
    done: boolean;
    withheld: string[];
    notMet: number;
    running: number;
    text: { doneTally: string; doneCardTally: string; whyNotDoneTally: string; orbitChecked: string };
  };
};

const FIXTURE_PATH = fileURLToPath(new URL('../../../../contracts/unmet-criteria-counts.fixtures.json', import.meta.url));
const F: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const derivedDone = {
  status: 'OPEN' as const,
  done: F.expect.done,
  withheld: F.expect.withheld,
  confirmation: F.project.confirmation,
  criteria: F.criteria.map((criterion) => ({
    definitionId: `c${criterion.ordinal}`,
    satisfied: criterion.satisfied,
    landing: criterion.landing,
    landingReason: criterion.landingReason,
  })),
  counts: F.expect.counts,
};
const project = {
  id: 'p-handoff-v2',
  title: F.project.title,
  status: 'OPEN' as const,
  acceptanceCriteriaItems: F.criteria.map((criterion) => ({
    id: `c${criterion.ordinal}`,
    ordinal: criterion.ordinal,
    // Not the fixture's description, which names the landing lanes this card must not print.
    text: `Criterion ${criterion.ordinal}`,
  })),
  derivedDone,
};

describe('Done tally over a project shaped like Coordinator handoff v2', () => {
  it('counts the unmet criteria apart, never by their landing reason', () => {
    expect(projectDoneTally(F.expect.counts, F.project.main)).toBe(F.expect.text.doneTally);
    expect(projectDoneCardTally(F.expect.counts, F.project.main)).toBe(F.expect.text.doneCardTally);
    expect(projectWhyNotDoneTally(derivedDone, F.project.main)).toBe(F.expect.text.whyNotDoneTally);
    for (const text of Object.values(F.expect.text)) {
      expect(text).not.toMatch(/merged outside Orbit|ran without a branch|no code to land|nothing to land/);
    }
    expect(F.expect.text.doneCardTally).toContain(`${F.expect.notMet} not met`);
  });

  it('counts a criterion landing right now from the criteria, not from the met-only byReason', () => {
    expect(criteriaInFlightCount(derivedDone)).toBe(F.expect.running);
    // An unmet criterion in flight is still running, though byReason leaves it out.
    const unmetInFlight = {
      criteria: [...derivedDone.criteria, { definitionId: 'c6', satisfied: false, landing: 'UNKNOWN' as const, landingReason: 'IN_FLIGHT' as const }],
    };
    expect(criteriaInFlightCount(unmetInFlight)).toBe(F.expect.running + 1);
    expect(criteriaInFlightCount(undefined)).toBe(0);
  });

  it('the Record as done card shows the same tally and running count', () => {
    const html = renderToStaticMarkup(
      <ProjectDoneCard
        project={project}
        doneRequest={null}
        standing={null}
        runningCount={criteriaInFlightCount(derivedDone)}
        onRecordDone={() => {}}
        onNotYet={() => {}}
      />,
    );
    expect(html).toContain(F.expect.text.doneCardTally);
    expect(html).toContain(F.expect.text.orbitChecked);
    expect(html).not.toMatch(/merged outside Orbit|ran without a branch|no code to land/);
    // Each unmet row says not met; the met one says where its work is.
    expect(html.match(/is-unmet">not met</g)?.length).toBe(F.expect.notMet);
    expect(html).toContain('is-met">met · In flight<');
  });

  it('keeps a criterion waiting for a confirmation out of the not-met part, so none is counted twice', () => {
    expect(projectDoneCardTally(F.expect.counts, F.project.main, { waitingConfirmation: 1 }))
      .toBe('1 met · 0 landed on main · 3 not met · 1 wait for confirmation');
  });
});
