import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const review = readFileSync(fileURLToPath(new URL('./JudgmentReviewPage.tsx', import.meta.url)), 'utf8');
const taskPanel = readFileSync(
  fileURLToPath(new URL('../components/TaskDetailPanel.tsx', import.meta.url)),
  'utf8',
);
const taskList = readFileSync(fileURLToPath(new URL('./TaskListView.tsx', import.meta.url)), 'utf8');
const sidePanel = readFileSync(
  fileURLToPath(new URL('../components/TasksSidePanel.tsx', import.meta.url)),
  'utf8',
);
const projectsPage = readFileSync(fileURLToPath(new URL('./ProjectsPage.tsx', import.meta.url)), 'utf8');

describe('human judgment phone and accessibility contract', () => {
  it('puts both acceptance viewports inside the one-column, full-width action breakpoint', () => {
    const breakpoint = 720;
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ]) {
      expect(viewport.width).toBeLessThanOrEqual(breakpoint);
      expect(viewport.height).toBeGreaterThan(viewport.width);
    }
    const narrow = css.slice(css.indexOf('@media (max-width: 720px)'), css.indexOf(':root[data-theme'));
    expect(narrow).toMatch(/\.judgment-inbox-list,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(narrow).toMatch(/\.judgment-history summary[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(narrow).toMatch(/\.judgment-decision-actions[\s\S]*flex-direction: column/);
    expect(narrow).toMatch(/\.judgment-decision-actions \.ant-btn[\s\S]*width: 100%[\s\S]*min-height: 44px/);
  });

  it('contains long digests, JSON, errors and controls without widening the page', () => {
    expect(css).toMatch(/\.judgment-page,[\s\S]*\.judgment-summary \*[\s\S]*min-width: 0/);
    expect(css).toMatch(/\.judgment-page \{[\s\S]*width: 100%[\s\S]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.judgment-json \{[\s\S]*max-width: 100%[\s\S]*white-space: pre-wrap[\s\S]*word-break: break-word/);
    expect(css).toMatch(/\.judgment-digest \{[\s\S]*word-break: break-all/);
    expect(css).toMatch(/\.judgment-decision textarea \{[\s\S]*width: 100%[\s\S]*max-width: 100%/);
  });

  it('keeps focus, labels, loading, inline recovery and duplicate-submit guards explicit', () => {
    expect(review).toContain('headingRef.current?.focus()');
    expect(review).toContain('errorRef.current?.focus()');
    expect(review).toContain('decisionRef.current?.focus()');
    expect(review).toContain('currentRequestRef.current.focus()');
    expect(review).toContain('role="status"');
    expect(review).toContain('role="alert"');
    expect(review).toContain('<label htmlFor="judgment-decision-note">');
    expect(review).toContain('disabled={!actionable || !note.trim() || decide.isPending}');
    expect(review).toContain('loading={decide.isPending');
    expect(review).toContain('setInlineError(error.message)');
    expect(css).toMatch(/\.tp-item:focus-visible,[\s\S]*\.tp-rail-item:focus-visible[\s\S]*outline: 2px solid var\(--brand\)/);
  });

  it('has no client-authored DONE path and notification links redirect by request identity', () => {
    expect(review).not.toMatch(/status\s*:\s*['"]DONE['"]/);
    expect(taskPanel).not.toContain('Mark done');
    expect(taskPanel).not.toMatch(/status\s*:\s*['"]DONE['"]/);
    expect(review).toContain('await review.refetch()');
    expect(taskList).toContain("searchParams.get('judgmentRequest')");
    expect(taskList).toContain('navigate(judgmentReviewPath(linkedJudgmentRequest), { replace: true })');
  });

  it('keeps a counted global inbox plus project and task request summaries reachable', () => {
    expect(sidePanel).toContain("{ key: 'judgments'");
    expect(sidePanel).toContain("label: '待我判定'");
    expect(sidePanel).toContain('openJudgmentCount');
    expect(projectsPage).toContain('<JudgmentRequestSummary projectId={id}');
    expect(taskPanel).toContain('<JudgmentRequestSummary taskId={taskId}');
  });
});
