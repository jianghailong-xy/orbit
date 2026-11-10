// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ProjectOpenItemsView } from '@orbit/shared';
import { ProjectDoneDeclineRow } from './ProjectDoneDeclineRow';
import { ProjectStaleDoneRow } from './ProjectStaleDoneRow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const stale = { reason: 'Criterion 3’s task was reopened after it asked.', supersededAt: '2026-11-10T12:00:00Z' };
describe('stale done request on the sessions page', () => {
  it('draws the server reason in a grey info row and gives way to an open request or newer decline', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (view: Partial<ProjectOpenItemsView>) => act(() => root.render(<><ProjectStaleDoneRow view={{ needsYou: [], withCoordinator: [], ...view } as ProjectOpenItemsView} /><ProjectDoneDeclineRow items={{ needsYou: [], withCoordinator: [], ...view } as ProjectOpenItemsView} /></>));
    render({ latestDoneRequestSuperseded: stale });
    expect(host.querySelector('strong')?.textContent).toBe('The coordinator’s request went stale');
    expect(host.textContent).toContain('Criterion 3’s task was reopened after it asked. The coordinator has been told and will ask again when the work settles.');
    expect(host.textContent).not.toContain('asked..');
    render({ latestDoneRequestSuperseded: stale, doneRequest: { itemId: 'new' } as never });
    expect(host.textContent).toBe('');
    render({ latestDoneRequestSuperseded: stale, latestDoneRequestDecline: { note: 'Still missing', declinedAt: '2026-11-10T13:00:00Z' } });
    expect(host.textContent).toContain('You said not yet');
    expect(host.textContent).not.toContain('went stale');
    expect(host.querySelectorAll('[role="note"]')).toHaveLength(1);
    render({ latestDoneRequestSuperseded: stale, latestDoneRequestDecline: { note: 'Still missing', declinedAt: '2026-11-10T11:00:00Z' } });
    expect(host.querySelectorAll('[role="note"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('You said not yet');
    render({});
    expect(host.textContent).toBe('');
    act(() => root.unmount());
  });
});
