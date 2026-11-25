import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskStatusPill, taskStatusLabel } from './TaskStatusPill';

// Rows as the Tasks list endpoint sends them (taskRunOverlay): a held queued run carries `queuedOnHold: true` beside
// `queued: true`; an older server sends no `queuedOnHold` at all.
const heldRow = { status: 'IN_PROGRESS', running: false, queued: true, runReason: 'TURN', runStalled: false, queuedOnHold: true };
const plainRow = { ...heldRow, queuedOnHold: false };
const olderServerRow = (({ queuedOnHold: _omit, ...rest }) => rest)(heldRow);
const text = (props: Parameters<typeof TaskStatusPill>[0]) =>
  renderToStaticMarkup(<TaskStatusPill {...props} />).replace(/<[^>]+>/g, '');

describe('TaskStatusPill queued word', () => {
  it('reads "Queued" with the On hold mark beside it for a queued row whose run is held (the approved board)', () => {
    const html = renderToStaticMarkup(<TaskStatusPill {...heldRow} />);
    expect(html).toContain('<span class="status-dot"></span>Queued</span>');
    expect(html).toContain('data-mark="ON_HOLD"');
    expect(text(heldRow)).toBe('QueuedOn hold');
    // The word function a graph's label reads is the legacy one, pinned by legacyBaseline.test.ts; no caller passes
    // it `queuedOnHold`.
    expect(taskStatusLabel(heldRow.status, heldRow.running, heldRow.queued, heldRow.queuedOnHold)).toBe('On hold');
  });
  it('reads "Queued" for a plainly queued row', () => {
    expect(text(plainRow)).toBe('Queued');
    expect(taskStatusLabel(plainRow.status, false, true, false)).toBe('Queued');
  });
  it('reads "Queued" when an older server sends no queuedOnHold', () => {
    expect(text(olderServerRow)).toBe('Queued');
    expect(taskStatusLabel('IN_PROGRESS', false, true)).toBe('Queued');
  });
  it('never draws On hold for a row that is not queued, or is running', () => {
    expect(text({ status: 'OPEN', queued: false, queuedOnHold: true })).toBe('Open');
    expect(text({ status: 'IN_PROGRESS', running: true, queued: false, queuedOnHold: true })).toBe('Running');
  });
});
