import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectOpenItemsView } from '@orbit/shared';
import { ProjectDoneDeclineRow } from './ProjectDoneDeclineRow';
import { DONE_DECLINE_HEADING, DONE_DECLINE_HINT, formatDoneDateTime } from '../lib/projectDone';

const items: ProjectOpenItemsView = {
  needsYou: [], withCoordinator: [],
  latestDoneRequestDecline: { note: 'Android build still fails on the release key.', declinedAt: '2026-11-10T10:12:00Z' },
};
describe('the owner’s Not yet row', () => {
  it('renders the server’s note and timestamp in the grey info row', () => {
    const html = renderToStaticMarkup(<ProjectDoneDeclineRow items={items} />);
    expect(html).toContain('project-done-decline-row');
    expect(html).toContain(`<strong>${DONE_DECLINE_HEADING} · ${formatDoneDateTime(items.latestDoneRequestDecline!.declinedAt)}</strong>`);
    expect(html).toContain('“Android build still fails on the release key.”');
    expect(html).toContain(DONE_DECLINE_HINT);
  });
  it('hides when a newer request is open even if a cached decline is present', () => {
    const newer = { ...items, doneRequest: { itemId: 'new-request' } } as ProjectOpenItemsView;
    expect(renderToStaticMarkup(<ProjectDoneDeclineRow items={newer} />)).toBe('');
  });
  it.each([undefined, { needsYou: [], withCoordinator: [] }, { ...items, latestDoneRequestDecline: null }])('hides without a decline', (view) => {
    expect(renderToStaticMarkup(<ProjectDoneDeclineRow items={view} />)).toBe('');
  });
});

it('keeps the decline literals identical across web, iOS and Android', () => {
  const swift = readFileSync(new URL('../../../macos/OrbitKit/Sources/OrbitKit/App/ProjectDone.swift', import.meta.url), 'utf8');
  const kotlin = readFileSync(new URL('../../../android/app/src/main/kotlin/io/orbitd/android/projects/ProjectDone.kt', import.meta.url), 'utf8');
  for (const [name, value] of [['declineHeading', DONE_DECLINE_HEADING], ['declineHint', DONE_DECLINE_HINT]]) {
    expect(swift).toContain(`public static let ${name} = "${value}"`);
    expect(kotlin).toContain(`const val ${name} = "${value}"`);
  }
});
