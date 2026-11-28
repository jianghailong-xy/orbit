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
    expect(html).toMatch(/data-state="PENDING"[^>]*><span[^>]*anticon-clock-circle.*?<\/span><\/span>Queued<\/span>/);
    expect(html).not.toContain('status-dot');
    expect(html).toContain('data-mark="ON_HOLD"');
    expect(text(heldRow)).toBe('QueuedOn hold');
    // The word function a graph's label reads is the legacy one, pinned by legacyBaseline.test.ts; no caller passes
    // it `queuedOnHold`.
    expect(taskStatusLabel(heldRow.status, heldRow.running, heldRow.queued, heldRow.queuedOnHold)).toBe('On hold');
  });
  it('draws the clock, not a dot, on a queued Tasks list row', () => {
    const html = renderToStaticMarkup(<TaskStatusPill {...plainRow} />);
    expect(html).toContain('anticon-clock-circle');
    expect(html).not.toContain('status-dot');
  });
  it('reads "Queued" for a plainly queued row', () => {
    expect(text(plainRow)).toBe('Queued');
    expect(taskStatusLabel(plainRow.status, false, true, false)).toBe('Queued');
  });
  it('reads "Queued" when an older server sends no queuedOnHold', () => {
    const html = renderToStaticMarkup(<TaskStatusPill {...olderServerRow} />);
    expect(html).toContain('<span class="status-dot"></span>Queued</span>');
    expect(html).not.toContain('data-state=');
    expect(text(olderServerRow)).toBe('Queued');
    expect(taskStatusLabel('IN_PROGRESS', false, true)).toBe('Queued');
  });
  it('never draws On hold for a row that is not queued, or is running', () => {
    expect(text({ status: 'OPEN', queued: false, queuedOnHold: true })).toBe('Open');
    expect(text({ status: 'IN_PROGRESS', running: true, queued: false, queuedOnHold: true })).toBe('Running');
  });
});

describe('TaskStatusPill on a live run, as the board draws it', () => {
  const row = { status: 'IN_PROGRESS', running: true, queued: false, runStalled: false, queuedOnHold: false };
  const draw = (props: Parameters<typeof TaskStatusPill>[0]) => {
    const html = renderToStaticMarkup(<TaskStatusPill {...props} />);
    return { text: text(props), marks: [...html.matchAll(/data-mark="([A-Z_]+)"/g)].map((m) => m[1]) };
  };

  // taskRunOverlay answers WAITING for all three: a RESUME_SESSION watch, a scheduled wake-up, an armed retry.
  // Will resume is not a mark (the owner, 2026-11-27: a list row's title-line icon instead), so the pill says Idle alone.
  it('reads a plain "Idle" for a parked run a watch or an armed retry will wake', () => {
    const html = renderToStaticMarkup(<TaskStatusPill {...row} runReason="WAITING" />);
    expect(html).toMatch(/^<span class="status-pill todo">.*?data-state="IDLE".*?<path d="M2\.7 3\.7h10\.6.*?>Idle<\/span>$/);
    expect(draw({ ...row, runReason: 'WAITING' })).toEqual({ text: 'Idle', marks: [] });
  });
  // A failed turn with a retry armed has released its session (Idle, Retrying on the session's own surfaces), so it
  // carries no task: the row says no run is live, and the pill keeps the task's own lifecycle word.
  it('keeps the task\'s own word, with no mark, for a released run that is Retrying', () => {
    const released = { ...row, running: false, runReason: null };
    expect(draw(released)).toEqual({ text: 'In progress', marks: [] });
    expect(draw({ ...released, status: 'FAILED' })).toEqual({ text: 'Failed', marks: [] });
  });
  it('reads a plain "Running" for a run held by a background job (Background is not a mark)', () => {
    expect(draw({ ...row, runReason: 'BACKGROUND_JOB' })).toEqual({ text: 'Running', marks: [] });
  });
  it('reads a plain "Running" for a turn', () => {
    expect(draw({ ...row, runReason: 'TURN' })).toEqual({ text: 'Running', marks: [] });
  });
  it('draws as before when an older server sends no queuedOnHold', () => {
    expect(draw({ status: 'IN_PROGRESS', running: true, runReason: 'WAITING' })).toEqual({ text: 'Running', marks: [] });
  });
});
