import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusIcon, statusLabel } from './WorkspaceView';

/**
 * The one motion this product has for background work: the terminal glyph, breathing.
 *
 * It is not a smaller spinner and must not read as one — the shape and the colour stay the ones
 * that mean "not the agent working" (see AgentView's StatusIcon and the native
 * `SessionStatusGlyph`). What moves is only the claim "there is a job in flight here", which is
 * the one thing a process the workspace left up cannot say. So each case below is about the class
 * and the words that sit beside it, and about the negative over the SAME row.
 */
describe('the background-process status glyph', () => {
  // A parked conversation whose only live work is background processes: no turn in flight, no
  // sub-workspace, nothing waiting on a person.
  const parked = {
    status: 'AWAITING_INPUT',
    engineTurnActive: false,
    runningSubagentCount: 0,
  };

  it('breathes while a job is in flight', () => {
    const html = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, runningBgCount: 2, runningBgJobCount: 1 }} />,
    );

    expect(html).toContain('status-glyph-active');
    expect(html).toContain('anticon-code');
    // The words are the same ones the still case says — only the motion is new, and the tooltip
    // that carries them is rendered at runtime, on a hover, rather than in static markup, so they
    // are asserted through `statusLabel`, which is the same branching the tooltip reads.
    expect(statusLabel({ ...parked, runningBgCount: 2, runningBgJobCount: 1 })).toBe(
      '2 background processes running',
    );
  });

  it('stays still when the only thing up is a service the workspace left running', () => {
    const html = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, runningBgCount: 2, runningBgJobCount: 0 }} />,
    );

    // The same glyph, the same words, no motion: this is the row that would otherwise pulse for
    // the rest of a workspace's life.
    expect(html).toContain('anticon-code');
    expect(html).not.toContain('status-glyph-active');
  });

  it('keeps the static reading against a control plane that predates the count', () => {
    const html = renderToStaticMarkup(<StatusIcon session={{ ...parked, runningBgCount: 2 }} />);

    expect(html).toContain('anticon-code');
    expect(html).not.toContain('status-glyph-active');
    expect(statusLabel({ ...parked, runningBgCount: 2 })).toBe('2 background processes running');
  });

  it('never animates the working spinner or a sub-workspace', () => {
    // The generating case, and the sub-workspace case: both keep their own live indicator, and
    // neither should be wearing the background glyph's class.
    const generating = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, status: 'RUNNING', runningBgCount: 1, runningBgJobCount: 1 }} />,
    );
    const subagent = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, runningSubagentCount: 1, runningBgCount: 1, runningBgJobCount: 1 }} />,
    );

    expect(generating).toContain('anticon-loading');
    expect(subagent).toContain('anticon-loading');
    expect(generating).not.toContain('status-glyph-active');
    expect(subagent).not.toContain('status-glyph-active');
  });
});

/**
 * A session a live watch will resume: the glyph the screenshot found reading "Waiting for your reply"
 * over a session nobody was asking anything of. It takes the strip's eye, still and grey — a wake is
 * coming, nothing here is running, and nobody is being asked — and the native port's
 * `SessionStatusGlyph` draws the same `eye` in the same place.
 */
describe('the watching status glyph', () => {
  const parked = {
    status: 'AWAITING_INPUT',
    engineTurnActive: false,
    runningSubagentCount: 0,
    pendingApprovals: 0,
  };

  it('is the eye, not the reply bubble', () => {
    expect(renderToStaticMarkup(<StatusIcon session={parked} />)).toContain('anticon-message');
    const html = renderToStaticMarkup(<StatusIcon session={parked} watching="Watching 1 target" />);
    expect(html).toContain('anticon-eye');
    expect(html).not.toContain('anticon-message');
    expect(html).not.toContain('status-glyph-active');
  });

  it('outranks a process the workspace left up, breathing or not', () => {
    const html = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, runningBgCount: 1, runningBgJobCount: 1 }} watching="Watching 1 target" />,
    );
    expect(html).toContain('anticon-eye');
    expect(html).not.toContain('anticon-code');
    expect(html).not.toContain('status-glyph-active');
  });

  it('never hides work of its own or a question for the reader', () => {
    const subagent = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, runningSubagentCount: 1 }} watching="Watching 1 target" />,
    );
    const turn = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, engineTurnActive: true }} watching="Watching 1 target" />,
    );
    const asking = renderToStaticMarkup(
      <StatusIcon session={{ ...parked, pendingApprovals: 1 }} watching="Watching 1 target" />,
    );
    expect(subagent).toContain('anticon-loading');
    expect(turn).toContain('anticon-loading');
    expect(asking).toContain('anticon-pause-circle');
    for (const html of [subagent, turn, asking]) expect(html).not.toContain('anticon-eye');
  });
});
