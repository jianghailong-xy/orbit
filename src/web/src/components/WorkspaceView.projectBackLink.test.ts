import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoordinatorBadge, projectBackLink, SessionTagChips, SessionTitleRow } from './WorkspaceView';
import type { SessionTagRef } from '../lib/sessionGrouping';

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
  it('renders an accessible marker only when the row coordinates a project', () => {
    const html = renderToStaticMarkup(createElement(CoordinatorBadge, { projectId: 'project-1' }));
    expect(html).toContain('class="coordinator-badge"');
    expect(html).toContain('title="This session coordinates a project"');
    expect(html).toContain('>Coordinator</span>');
    // The visible word IS the accessible name. An aria-label here would override it, so somebody
    // driving the UI by voice could say the word they can see and not match it (WCAG 2.5.3).
    expect(html).not.toContain('aria-label');
    expect(html).not.toContain('<button');
    expect(renderToStaticMarkup(createElement(CoordinatorBadge, { projectId: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(CoordinatorBadge))).toBe('');
  });

  it('keeps the marker when a long row title ellipsizes', () => {
    const title = '会话标题非常长'.repeat(20);
    const html = renderToStaticMarkup(
      createElement(SessionTitleRow, {
        session: {
          title,
          projectId: 'project-1',
          createdAt: '2026-08-26T12:00:00.000Z',
        },
      }),
    );
    expect(html).toContain(`class="session-title">${title}</div>`);
    expect(html).toContain('class="coordinator-badge"');
    expect(html.indexOf('class="coordinator-badge"')).toBeGreaterThan(html.indexOf('class="session-title"'));

    // jsdom has no layout engine, so assert the responsive flex contract directly: the title is
    // the shrinking, ellipsized item and the trailing chip never shrinks.
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const row = css.match(/\.session-title-row\s*\{([^}]*)\}/)?.[1] ?? '';
    const titleRule = css.match(/\.session-title\s*\{([^}]*)\}/)?.[1] ?? '';
    const marker = css.match(/\.coordinator-badge\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(row).toContain('min-width: 0');
    expect(titleRule).toContain('flex: 1');
    expect(titleRule).toContain('min-width: 0');
    expect(titleRule).toContain('overflow: hidden');
    expect(titleRule).toContain('text-overflow: ellipsis');
    expect(titleRule).toContain('white-space: nowrap');
    expect(marker).toContain('flex: none');
    expect(marker).toContain('white-space: nowrap');
  });
});

describe('SessionTagChips', () => {
  const tags: SessionTagRef[] = [
    { id: '1', name: '功能扩展', color: '#2ea121', isSystem: false, position: 0 },
    { id: '2', name: '项目架构', color: '#fa8c16', isSystem: false, position: 1 },
    { id: '3', name: '性能优化', color: '#3370ff', isSystem: false, position: 2 },
    { id: '4', name: '回归测试', color: '#cf3b35', isSystem: false, position: 3 },
  ];

  it('renders one named tag, the remaining count, and the compact total', () => {
    const html = renderToStaticMarkup(createElement(SessionTagChips, { tags, tooltipOpen: false }));

    expect(html.match(/class="session-tag-chip"/g)).toHaveLength(1);
    expect(html).toContain('class="session-tag-chip-label">功能扩展</span>');
    expect(html).toContain('session-tag-more--remaining">+3</span>');
    expect(html).toContain('session-tag-more--total">+4</span>');
    expect(html).toContain('class="session-tag-chips" aria-hidden="true"');
    expect(html).toContain('class="sr-only">Tags: 功能扩展, 项目架构, 性能优化, 回归测试</span>');
    expect(html).not.toContain('aria-label="Tags:');
  });

  it('does not invent a remaining count for a single tag or markup for no tags', () => {
    const one = renderToStaticMarkup(
      createElement(SessionTagChips, { tags: tags.slice(0, 1), tooltipOpen: false }),
    );

    expect(one).not.toContain('session-tag-more--remaining');
    expect(one).toContain('session-tag-more--total">+1</span>');
    expect(renderToStaticMarkup(createElement(SessionTagChips, { tags: [] }))).toBe('');
  });

  it('caps tags by the resizable list container while keeping names ellipsized and counts fixed', () => {
    // jsdom has no layout engine, so assert the responsive CSS contract directly.
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const list = css.match(/\.session-col-list\s*\{([^}]*)\}/)?.[1] ?? '';
    const group = css.match(/\.session-tag-chips\s*\{([^}]*)\}/)?.[1] ?? '';
    const label = css.match(/\.session-tag-chip-label\s*\{([^}]*)\}/)?.[1] ?? '';
    const count = css.match(/\.session-tag-more\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(list).toContain('container: session-list / inline-size');
    expect(group).toContain('flex: 0 1 auto');
    expect(group).toContain('min-width: 0');
    expect(group).toContain('max-width: min(30%, 112px)');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
    expect(count).toContain('flex: none');
    expect(css).toMatch(/@container session-list \(max-width: 279px\)/);
  });
});
