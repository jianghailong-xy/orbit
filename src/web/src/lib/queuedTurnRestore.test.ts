import { describe, expect, it } from 'vitest';
import { returnsToComposer } from './queuedTurnRestore';

const BG_WAKE = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_10bca948d369｜job｜npm test｜land gate',
  '      ended｜completed｜exit code 0',
  '  The control plane recorded this for you; the user did not say it.',
  '</background-job-wake>',
].join('\n');

describe('returnsToComposer', () => {
  it('hands back a message somebody typed', () => {
    expect(returnsToComposer({ content: 'and then deploy' })).toBe(true);
  });

  it('keeps back a turn the control plane says it wrote, whatever it says', () => {
    expect(returnsToComposer({ content: 'npm test -w @orbit/web', authoredByOrbit: true })).toBe(false);
    expect(returnsToComposer({ content: '请开始执行任务「Fix the race」。', authoredByOrbit: true })).toBe(false);
  });

  it('keeps back the wakes and deliveries by their shape, from a server that does not say so', () => {
    expect(returnsToComposer({ content: BG_WAKE })).toBe(false);
    expect(returnsToComposer({ content: 'Checks failed on the combined tree', openItemDelivery: { itemId: 'i' } })).toBe(false);
    expect(returnsToComposer({ content: 'From Orbit · project started', projectStarted: { projectId: 'p' } })).toBe(false);
  });
});
