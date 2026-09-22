import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHERE THE EXCEPTION CARDS COME FROM, AND WHERE THEY GO.
 *
 * A project's open exceptions — an item a clock made the owner's, a task that failed, the pause the
 * owner is the only one who can lift — were drawn as a BLOCK under the conversation
 * (`ProjectExceptionCards` as a sibling of `<Transcript>`). That is where a card with no moment of
 * its own belongs, and the one place a card WITH one must not go: an exception escalated
 * thirty-four minutes ago sat under the newest message counting `waiting 34m`, which is one card
 * telling two stories about when it happened. The account owner's screenshot, 2026-09-22, and the
 * mock it produced (`docs/mocks/escalated-card-placement.html`).
 *
 * What holds this in the view — and what no unit test of the pieces can hold — is that the
 * conversation inserts them at the moment each happened, off the item's own clock, by the same rule
 * its records are placed by (`decisionReceiptAnchor`). Both native clients do the same
 * (`DeliveryAnchor.exception`), which is why the field and the rule are named here as well.
 */

describe('where the conversation’s exception cards come from', () => {
  /** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
  const source = (): string => {
    const found = ['src/components/WorkspaceView.tsx', 'src/web/src/components/WorkspaceView.tsx']
      .map((each) => resolve(process.cwd(), each))
      .find(existsSync);
    if (!found) throw new Error(`WorkspaceView.tsx is not under ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  it('reads this project’s open items, on the read the page and the other cards share', () => {
    expect(
      source(),
      'the pane never reads what this project still owes somebody',
    ).toContain('projectOpenItemsQuery');
  });

  it('places each of them at the moment it happened, among the events it has', () => {
    const view = source();
    expect(
      view,
      'the cards are still drawn without a moment of their own',
    ).toContain('exceptionCardRows(openItems.data, transcriptEvents)');
    expect(view, 'the row is not handed the card its anchor is about').toContain(
      'element: <ItemAsCard',
    );
  });

  it('hands them to the transcript as inserts, and keeps no block of its own', () => {
    const view = source();
    expect(view, 'the pane stopped inserting anything into the conversation').toContain(
      'inserts={transcriptInserts}',
    );
    expect(
      view,
      'the block under the conversation is back: a card placed by its own moment drawn below '
        + 'every message instead',
    ).not.toContain('ProjectExceptionCards');
  });
});
