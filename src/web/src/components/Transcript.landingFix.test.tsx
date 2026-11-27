// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Transcript, type RunEvent } from './Transcript';

/**
 * A failed landing handed to the session that wrote the work (revision 42, §12.5 W6; board landing-fix-own-session
 * web a ①): Orbit's card, from the turn's own words — never the reader's bubble.
 */

const TURN = [
  'Orbit could not land your work for "A10c · Notification cold start drops the session" on project/34ZZnCsCFp.',
  '',
  'Conflict while rebasing onto project/34ZZnCsCFp at 41ac9e0:',
  'app/notify/ColdStartRouter.kt, app/session/SessionListStore.kt',
  '',
  'Nothing was pushed. project/34ZZnCsCFp is unchanged.',
  '',
  'Fix it on your own branch, in this checkout:',
  '1. Merge project/34ZZnCsCFp into your branch and resolve what conflicts.',
  '2. Run what failed until it passes.',
  '3. Commit, then end your turn.',
  '',
  'Orbit lands the new commit and runs the checks again by itself. Do not push project/34ZZnCsCFp.',
  'If this is not yours to fix, end your turn without committing and say why; the project\'s coordinator takes it from there.',
  'The full record: landing 4Hk1yFe1Kt1kI1YVMuLJLi.',
].join('\n');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(events: RunEvent[]) {
  act(() => root.render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><Transcript events={events} /></MemoryRouter>
    </QueryClientProvider>,
  ));
}

describe('the landing-fix turn', () => {
  it('draws as Orbit’s landing card, not as the reader’s bubble', () => {
    mount([
      { seq: 1, type: 'user', turnId: 't1', ts: '2026-11-20T02:02:31Z', payload: { text: TURN } },
      { seq: 2, type: 'assistant', turnId: 't1', ts: '2026-11-20T02:08:50Z', payload: { text: 'Committed 4be19c2.' } },
    ]);
    const card = container.querySelector<HTMLElement>('.landing-fix-card');
    expect(card).not.toBeNull();
    expect(container.querySelector('.chat-user')).toBeNull();
    const text = card!.textContent ?? '';
    expect(text).toContain('FROM ORBIT · LANDING');
    expect(text).toContain('Conflict');
    expect(text).toContain('Orbit could not land your work on project/34ZZnCsCFp');
    expect(text).toContain('Conflict while rebasing onto the project branch at 41ac9e0. Nothing was pushed.');
    expect(card!.querySelector('.landing-fix-card-files')?.textContent).toBe('app/notify/ColdStartRouter.kt\napp/session/SessionListStore.kt');
    expect([...card!.querySelectorAll('.landing-fix-card-steps li')].map((li) => li.textContent)).toEqual([
      'Merge the project branch into your branch and resolve what conflicts.',
      'Run what failed until it passes.',
      'Commit, then end your turn.',
    ]);
    const open = card!.querySelector<HTMLAnchorElement>('.landing-fix-card-open');
    expect(open?.textContent).toBe('Open landing ›');
    expect(open?.getAttribute('href')).toBe('/sessions/4Hk1yFe1Kt1kI1YVMuLJLi');
  });

  it('leaves a person’s own words that merely quote the first line as their bubble', () => {
    mount([{ seq: 1, type: 'user', turnId: 't1', ts: '2026-11-20T02:02:31Z', payload: { text: 'Why did it say "Orbit could not land your work"?' } }]);
    expect(container.querySelector('.landing-fix-card')).toBeNull();
  });
});
