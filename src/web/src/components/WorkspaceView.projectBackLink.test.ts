import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoordinatorBadge, projectBackLink } from './WorkspaceView';

/**
 * The session header's second way back. A coordinator conversation is reached from a project's
 * page and executes no task, so the task link never applies to it — without this the only way back
 * was the browser's own button.
 */
describe('projectBackLink', () => {
  it('links a coordinator session to the project it coordinates, by name', () => {
    expect(
      projectBackLink({
        id: 'sess-1',
        projectId: '018f3f3e-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
        projectTitle: '实施 Project 公平调度域改造',
      }),
    ).toEqual({
      // base62, like every other link the app builds — the id arrives already public and
      // `encodeId` is idempotent, so either spelling lands on the same route.
      path: '/projects/2wSIQlnsblAQ5epdQNQ3b',
      title: '实施 Project 公平调度域改造',
    });
  });

  it('has nothing to offer an ordinary session', () => {
    expect(projectBackLink({ id: 'sess-1', projectId: null, projectTitle: null })).toBeNull();
    // Rolling upgrades may still serve a row without either project field.
    expect(projectBackLink({ id: 'sess-1' })).toBeNull();
    expect(projectBackLink(null)).toBeNull();
  });

  it('reports a missing title as null, leaving the caller to name the button', () => {
    expect(
      projectBackLink({ projectId: '018f3f3e-1a2b-7c3d-8e4f-5a6b7c8d9e0f' })?.title,
    ).toBeNull();
  });
});

describe('CoordinatorBadge', () => {
  it('renders read-only relation metadata for a coordinator session', () => {
    const html = renderToStaticMarkup(createElement(CoordinatorBadge, { projectId: 'project-1' }));
    expect(html).toContain('class="coordinator-badge"');
    expect(html).toContain('Coordinator');
    expect(html).not.toContain('<button');
  });

  it('renders nothing for ordinary and rolling-upgrade session rows', () => {
    expect(renderToStaticMarkup(createElement(CoordinatorBadge, { projectId: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(CoordinatorBadge))).toBe('');
  });
});
