// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIKI_CHAT_PROMPT } from '@orbit/shared';
import { ExportCtx, type RunEvent, Transcript } from './Transcript';

const CONDITIONS = '<list-conditions>\n  Quota held dispatch\n</list-conditions>';
const PAGE = '<orbit_wiki_page of="doc" doc="1.1" slug="runner-presence">\nA runner sends a heartbeat every 30 seconds.\n</orbit_wiki_page>';
const SELECTION = '<orbit_wiki_selection doc="1.1" slug="runner-presence" sentences="1" sources="1">\nSelected heartbeat source.\n</orbit_wiki_selection>';
const CONTENTS = '<orbit_wiki_contents planVersion="3">\nThis is a view of the wiki\'s structure, not a source.\n1.1 runner-presence · Runner presence · Runtime\n  §1 heartbeat · Heartbeat · written, repoSha 7f3e2a1c0d9b\n</orbit_wiki_contents>';
const TYPED = 'What is the current state?';

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

function userEvent(text: string, controlPlaneNote?: string): RunEvent {
  return { seq: 7, type: 'user', turnId: 'turn-1', ts: '2026-11-18T12:26:47.307Z',
    payload: { text, ...(controlPlaneNote === undefined ? {} : { controlPlaneNote }) } };
}

async function mount(events: RunEvent[]) {
  await act(async () => root.render(<MemoryRouter><Transcript events={events} /></MemoryRouter>));
}

describe('recorded control-plane notes (owner decision 2026-11-18)', () => {
  it.each([
    ['list conditions', CONDITIONS, 'Quota held dispatch'],
    ['background inventory', '<background-jobs>\n  Still running: hidden-job\n</background-jobs>', 'hidden-job'],
    ['coordinator role', '<orbit_project_coordinator_context>\nYou coordinate this project.\n</orbit_project_coordinator_context>', 'You coordinate this project.'],
    ['wiki chat with page and selection', `${WIKI_CHAT_PROMPT}\n\n${PAGE}\n\n${SELECTION}`, 'A runner sends a heartbeat every 30 seconds.'],
    ['wiki chat first message with its contents', `${WIKI_CHAT_PROMPT}\n\n${CONTENTS}\n\n${PAGE}`, '§1 heartbeat · Heartbeat · written'],
    ['wiki contents alone, after the plan changed', CONTENTS, 'Runner presence · Runtime'],
    ['wiki chat without attachments', WIKI_CHAT_PROMPT, 'You are chatting beside a page of this repository'],
  ])('keeps %s out of the bubble and the rest of the transcript', async (_kind, block, marker) => {
    const note = `\n\n${block}`;
    await mount([userEvent(`${TYPED}${note}`, note)]);
    expect(container.querySelector('.chat-user')?.textContent?.trim()).toBe(TYPED);
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.textContent).not.toContain(block);
    expect(container.textContent).not.toContain(marker);
    expect(container.querySelector('[class*="chat-injected"]')).toBeNull();
    expect([...container.querySelector('.chat-user-meta')!.children].map((el) => el.className))
      .toEqual(['chat-copy', 'chat-time']);
  });

  it('keeps a card and its own words, without the appended note or attachment fold', async () => {
    const note = `\n\n${CONDITIONS}`;
    await mount([{
      ...userEvent(`The work is ready.${note}`, note),
      payload: { text: `The work is ready.${note}`, controlPlaneNote: note,
        sessionMessage: { fromSessionId: '00000000-0000-4000-8000-000000000001', fromTitle: 'Worker', fromAgentName: 'orbit' } },
    }]);
    expect(container.querySelector('.smc')?.textContent).toContain('The work is ready.');
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.textContent).not.toContain('Quota held dispatch');
    expect(container.querySelector('[class*="chat-injected"]')).toBeNull();
  });

  it('keeps block-shaped text the person typed when no note was recorded', async () => {
    await mount([userEvent(`${TYPED}\n\n${CONDITIONS}`)]);
    expect(container.querySelector('.chat-user')?.textContent).toContain('Quota held dispatch');
    expect(container.textContent).not.toContain('Orbit attached');
  });

  it('also omits the note and fold from the exported transcript', () => {
    const note = `\n\n${CONDITIONS}`;
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <Transcript events={[userEvent(`${TYPED}${note}`, note)]} live={false} />
      </ExportCtx.Provider>,
    );
    expect(html).toContain(TYPED);
    expect(html).not.toContain('Orbit attached');
    expect(html).not.toContain('chat-injected');
    expect(html).not.toContain('Quota held dispatch');
  });
});
