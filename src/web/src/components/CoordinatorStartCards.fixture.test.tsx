// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RecordedStandardSetConfirmation } from '@orbit/shared';
import {
  ACCEPTANCE_RECEIPT_HEADING,
  AcceptanceConfirmationReceipt,
  acceptanceReceiptLine,
  acceptanceReceiptOpenLabel,
  acceptanceReceiptSeal,
  acceptanceReceiptStamp,
} from './AcceptanceConfirmationCard';
import { receiptClock } from './CriteriaDecisionCard';
import {
  PROJECT_STARTED_NONE_HELD,
  PROJECT_STARTED_NOTIFICATION,
  PROJECT_STARTED_TASKS_SHOWN,
  PROJECT_STARTED_TOLD,
  ProjectStartedCard,
  projectStartedBy,
  projectStartedHeldLead,
  projectStartedKind,
  projectStartedLabel,
  projectStartedMoreInProject,
  projectStartedShowMore,
} from './ProjectStartedCard';
import { parseProjectStarted } from '../lib/projectStarted';
import { runSettingsParts } from '../lib/projectStart';

/**
 * The shared cases (src/shared/src/coordinator-start-cards.fixture.json) Android is proved against
 * too: the receipt a project's start leaves, and the Project started card (board-4, criterion 7).
 */
type Fixture = {
  clock: { now: string; timeZone: string; locale: string };
  startReceipts: {
    name: string;
    confirmation: RecordedStandardSetConfirmation;
    expected: { heading: string; line: string; settings: string | null; differs: string[]; stamp: string; foldLabel: string; seal: string };
  }[];
  projectStarted: {
    name: string;
    payload: unknown;
    expected: {
      label: string; kind: string; title: string; settings: string | null; lead: string; tasks: string[];
      toggle: string | null; more: string | null; meta: string; told: string;
    };
  }[];
};
const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../shared/src/coordinator-start-cards.fixture.json'), 'utf8'),
) as Fixture;

const markup = (node: ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

describe('the start receipt, from the shared fixture', () => {
  for (const c of fixture.startReceipts) {
    it(c.name, () => {
      const { confirmation, expected } = c;
      expect(ACCEPTANCE_RECEIPT_HEADING).toBe(expected.heading);
      expect(acceptanceReceiptLine(confirmation)).toBe(expected.line);
      const started = confirmation.startedWith ?? null;
      const parts = started ? runSettingsParts(started.settings, started.differsFromRequest) : null;
      expect(parts?.map((p) => p.text).join(' · ') ?? null).toBe(expected.settings);
      expect(parts?.filter((p) => p.differs).map((p) => p.text) ?? []).toEqual(expected.differs);
      const { now, timeZone, locale } = fixture.clock;
      expect(`by you at ${receiptClock(confirmation.confirmedAt, new Date(now), { timeZone, locale })}`).toBe(expected.stamp);
      expect(acceptanceReceiptStamp(confirmation)).toMatch(/^by you at /);
      expect(acceptanceReceiptOpenLabel(confirmation.criteriaMaterial.length)).toBe(expected.foldLabel);
      expect(acceptanceReceiptSeal(confirmation)).toBe(expected.seal);
      const drawn = text(markup(<AcceptanceConfirmationReceipt confirmation={confirmation} />));
      expect(drawn).toContain(expected.line);
      // Each setting is drawn; one the owner changed is followed by its screen-reader words.
      for (const part of expected.settings?.split(' · ') ?? []) expect(drawn).toContain(part);
      expect(drawn).toContain(expected.foldLabel);
    });
  }
});

describe('Project started, from the shared fixture', () => {
  for (const c of fixture.projectStarted) {
    it(c.name, () => {
      const card = parseProjectStarted(c.payload)!;
      const { expected } = c;
      expect(card).not.toBeNull();
      expect(projectStartedLabel(card.by)).toBe(expected.label);
      expect(projectStartedKind(card.by)).toBe(expected.kind);
      expect(card.projectTitle).toBe(expected.title);
      const settings = card.settings
        ? runSettingsParts(card.settings, card.differsFromRequest ?? []).map((p) => p.text).join(' · ')
        : null;
      expect(settings).toBe(expected.settings);
      expect(card.heldCount === 0 ? PROJECT_STARTED_NONE_HELD : projectStartedHeldLead(card.heldCount)).toBe(expected.lead);
      expect(card.held.slice(0, PROJECT_STARTED_TASKS_SHOWN).map((t) => t.title)).toEqual(expected.tasks);
      const folded = card.held.length - PROJECT_STARTED_TASKS_SHOWN;
      expect(folded > 0 ? projectStartedShowMore(folded) : null).toBe(expected.toggle);
      const unlisted = card.heldCount - card.held.length;
      expect(unlisted > 0 ? projectStartedMoreInProject(unlisted) : null).toBe(expected.more);
      expect(`${projectStartedBy(card)} · ${PROJECT_STARTED_NOTIFICATION}`).toBe(expected.meta);
      expect(PROJECT_STARTED_TOLD).toBe(expected.told);
      const drawn = text(markup(<ProjectStartedCard card={card} text="told" />));
      for (const words of [expected.label, expected.kind, expected.title, expected.lead, expected.meta, expected.told, ...expected.tasks]) {
        expect(drawn).toContain(words);
      }
      // Each setting is drawn; one the owner changed is followed by its screen-reader words.
      for (const part of expected.settings?.split(' · ') ?? []) expect(drawn).toContain(part);
    });
  }
});
