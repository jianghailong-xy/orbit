import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReopenBody, reopenProject, reopenPrompt } from './ProjectReopenControl';
import type { ReopenImpact } from '../lib/attribution';

const api = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({ api: (...args: unknown[]) => api(...(args as [])) }));

const PROJECT = '0195c0de-0000-7000-8000-000000000001';

function impact(over: Partial<ReopenImpact> = {}): ReopenImpact {
  return {
    status: 'DONE',
    settled: true,
    fromEpoch: '3',
    toEpoch: '4',
    retiringRuns: 2,
    wasLegacy: false,
    acknowledgement: '3',
    refusalCode: null,
    requiredAction:
      'Confirm the reopen by acknowledging acceptance epoch 3; it starts epoch 4 and retires 2 '
      + 'acceptance attempts.',
    ...over,
  };
}

const paint = (props: Partial<Parameters<typeof ReopenBody>[0]> = {}) =>
  renderToStaticMarkup(
    <ReopenBody
      impact={impact()}
      confirming={false}
      busy={false}
      error={null}
      onAsk={() => {}}
      onCancel={() => {}}
      onConfirm={() => {}}
      {...props}
    />,
  );

describe('ProjectReopenControl — what a reopen costs, before it is spent', () => {
  it('names both epochs and how many attempts stop counting', () => {
    const html = paint();
    expect(html).toContain('acceptance epoch 3');
    expect(html).toContain('Acceptance epoch 3 → 4.');
    expect(html).toContain('2 acceptance attempts are retired');
    // The point of the sentence: old evidence stays readable and stops being current.
    expect(html).toContain('They stay readable and stop counting');
  });

  it('says the legacy stamp is dropped, when there is one', () => {
    expect(paint()).not.toContain('compatibility stamp');
    expect(paint({ impact: impact({ wasLegacy: true }) })).toContain('compatibility stamp');
    expect(paint({ impact: impact({ wasLegacy: true }) })).toContain('LEGACY');
  });

  it('reads "1 attempt is retired" rather than "1 attempts are"', () => {
    expect(reopenPrompt(impact({ retiringRuns: 1 })).detail).toContain(
      '1 acceptance attempt is retired',
    );
    expect(reopenPrompt(impact({ retiringRuns: 0 })).detail).toContain(
      '0 acceptance attempts are retired',
    );
  });

  it('offers nothing to press on an OPEN project, and shows the CODE for why', () => {
    // AC5: "nothing to reopen" is an answer, and it is carried by a stable code rather than by
    // the absence of a button.
    const html = paint({
      impact: impact({
        status: 'OPEN',
        settled: false,
        toEpoch: '3',
        retiringRuns: 0,
        acknowledgement: null,
        refusalCode: 'PROJECT_NOT_SETTLED',
        requiredAction: 'This project is already OPEN; nothing has to be reopened.',
      }),
    });
    expect(html).toContain('PROJECT_NOT_SETTLED');
    expect(html).toContain('nothing has to be reopened');
    expect(html).not.toContain('Reopen…');
  });

  it('takes two presses, and the second names the epoch it lands in', () => {
    expect(paint()).toContain('Reopen…');
    expect(paint()).not.toContain('Yes, reopen');
    expect(paint({ confirming: true })).toContain('Yes, reopen at epoch 4');
  });

  it('sends the epoch the preview handed out — the echo IS the confirmation', () => {
    api.mockClear();
    void reopenProject(PROJECT, '3');
    expect(api).toHaveBeenCalledWith(`/projects/${PROJECT}/reopen`, {
      method: 'POST',
      body: { acknowledgedAcceptanceEpoch: '3' },
    });
  });

  it('surfaces a refused reopen instead of leaving the page looking unchanged', () => {
    const html = paint({
      confirming: true,
      error: new Error(
        'REOPEN_ACKNOWLEDGEMENT_STALE: this project is at acceptance epoch 4 and you acknowledged 3',
      ),
    });
    expect(html).toContain('This project was not reopened');
    expect(html).toContain('REOPEN_ACKNOWLEDGEMENT_STALE');
  });

  it('never offers a confirm it has no acknowledgement for', () => {
    // A settled project always has one; this is the belt-and-braces case where a server answered
    // `settled` without it, and pressing confirm would send an empty epoch the server refuses.
    const html = paint({ confirming: true, impact: impact({ acknowledgement: null }) });
    expect(html).toContain('disabled');
  });
});
