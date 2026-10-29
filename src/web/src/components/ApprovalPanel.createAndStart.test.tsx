// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel, CREATE_AND_START, offersCreateAndStart } from './ApprovalPanel';
import type { ApprovalInfo } from '../api';

// The single-task card's second yes: "Create and start" creates the task and starts its run in the
// same press, so the owner is not asked again to start it. Offered only where the server's forecast
// says nothing else would start the task, and sent as `startAfterCreate` beside the plain allow,
// which itself stays exactly what it was.

/** A single create card, with the server's forecast when one is given — filed, unless `accepts` is
 *  false, by a runner that acts on Create and start, which the server records beside the forecast. */
const taskCreate = (forecast?: Record<string, number>, accepts = true): ApprovalInfo =>
  ({
    id: 'c1',
    sessionId: 's1',
    toolName: 'orbit_task_create',
    status: 'PENDING',
    createdAt: '2026-10-29T05:00:00Z',
    input: {
      title: 'Fix login redirect',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      ...(accepts ? { acceptsStartAfterCreate: true } : {}),
      ...(forecast
        ? {
            preview: {
              taskCount: 1, startingNow: 0, blocked: 0, needsManualStart: 0, notDispatchable: 0,
              scheduled: 0, awaitingProjectStart: 0, ...forecast,
            },
          }
        : {}),
    },
  }) as ApprovalInfo;

const render = (a: ApprovalInfo) => renderToStaticMarkup(<ApprovalPanel approval={a} onDecide={() => {}} />);

describe('Create and start', () => {
  it('says the same words the native clients say', () => {
    expect(CREATE_AND_START).toBe('Create and start');
  });

  it('is offered only when the forecast says the task needs a manual start', () => {
    expect(offersCreateAndStart(taskCreate({ needsManualStart: 1 }))).toBe(true);
    expect(render(taskCreate({ needsManualStart: 1 }))).toContain(CREATE_AND_START);

    // Starts by itself (now, or at its runAt), waits on a prerequisite, cannot run, or waits for its
    // project to start: the press would add nothing to any of them.
    for (const forecast of [
      { startingNow: 1 }, { scheduled: 1 }, { blocked: 1 }, { notDispatchable: 1 }, { awaitingProjectStart: 1 },
    ]) {
      expect(offersCreateAndStart(taskCreate(forecast)), JSON.stringify(forecast)).toBe(false);
      expect(render(taskCreate(forecast)), JSON.stringify(forecast)).not.toContain(CREATE_AND_START);
    }
    // A card whose forecast could not be read says nothing either way.
    expect(offersCreateAndStart(taskCreate())).toBe(false);
    expect(render(taskCreate())).not.toContain(CREATE_AND_START);
  });

  it('is not offered on a card whose runner would only create the task', () => {
    // A runner, or a server, that predates the choice files the card without the mark: pressing the
    // button there would create the task and start nothing, so it is not offered.
    expect(offersCreateAndStart(taskCreate({ needsManualStart: 1 }, false))).toBe(false);
    expect(render(taskCreate({ needsManualStart: 1 }, false))).not.toContain(CREATE_AND_START);
    // The mark must be the server's boolean, not anything truthy.
    const stringly = taskCreate({ needsManualStart: 1 }, false);
    (stringly.input as Record<string, unknown>).acceptsStartAfterCreate = 'true';
    expect(offersCreateAndStart(stringly)).toBe(false);
  });

  it('belongs to the single-task card alone', () => {
    const preview = { taskCount: 1, needsManualStart: 1 };
    for (const toolName of ['orbit_task_batch', 'orbit_project_create', 'Bash']) {
      const card = { id: 'x', toolName, input: { title: 'Checkout rewrite', preview, acceptsStartAfterCreate: true } } as ApprovalInfo;
      expect(offersCreateAndStart(card), toolName).toBe(false);
      expect(render(card), toolName).not.toContain(CREATE_AND_START);
    }
  });

  it('sits after the plain yes, which is still there', () => {
    const html = render(taskCreate({ needsManualStart: 1 }));
    expect(html).toContain('Create it');
    expect(html.indexOf('Create it')).toBeLessThan(html.indexOf(CREATE_AND_START));
    expect(html.indexOf(CREATE_AND_START)).toBeLessThan(html.indexOf('Chat about this'));
  });

  describe('pressed', () => {
    let mounted: Root | null = null;
    let host: HTMLDivElement | null = null;

    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      host = document.createElement('div');
      document.body.append(host);
      mounted = createRoot(host);
    });

    afterEach(async () => {
      const root = mounted;
      mounted = null;
      if (root) await act(async () => root.unmount());
      host?.remove();
      host = null;
    });

    const button = (label: string): HTMLButtonElement => {
      const found = [...host!.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label));
      if (!found) throw new Error(`no "${label}" button on the card`);
      return found;
    };

    it('allows the card with the start; the plain yes carries none', async () => {
      const onDecide = vi.fn();
      await act(async () => {
        mounted!.render(<ApprovalPanel approval={taskCreate({ needsManualStart: 1 })} onDecide={onDecide} />);
      });

      await act(async () => button(CREATE_AND_START).click());
      expect(onDecide).toHaveBeenCalledTimes(1);
      expect(onDecide.mock.calls[0]).toEqual(['c1', 'allow', undefined, undefined, undefined, true]);

      await act(async () => button('Create it').click());
      expect(onDecide).toHaveBeenCalledTimes(2);
      // Exactly the call it made before this button existed.
      expect(onDecide.mock.calls[1]).toEqual(['c1', 'allow']);
    });

    it('cannot be pressed on a card nobody is waiting on any more', async () => {
      await act(async () => {
        mounted!.render(
          <ApprovalPanel approval={taskCreate({ needsManualStart: 1 })} onDecide={() => {}} answerable={false} />,
        );
      });
      expect(button(CREATE_AND_START).disabled).toBe(true);
    });
  });
});
