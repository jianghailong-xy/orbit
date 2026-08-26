// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SameOriginLink, sameOriginRoute } from './SameOriginLink';

let container: HTMLDivElement;
let root: Root;

function LocationProbe() {
  const location = useLocation();
  return <output data-location>{location.pathname + location.search + location.hash}</output>;
}

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

describe('sameOriginRoute', () => {
  it('keeps the path, query, and hash for an absolute current-origin URL', () => {
    expect(
      sameOriginRoute(
        'https://orbit.example/tasks/task-1?view=activity#latest',
        'https://orbit.example/sessions/session-1',
      ),
    ).toBe('/tasks/task-1?view=activity#latest');
  });

  it('treats a different scheme or port as external', () => {
    const current = 'https://orbit.example/sessions/session-1';

    expect(sameOriginRoute('http://orbit.example/tasks/task-1', current)).toBeNull();
    expect(sameOriginRoute('https://orbit.example:8443/tasks/task-1', current)).toBeNull();
  });

  it('does not turn a credential-bearing URL into an app route', () => {
    expect(
      sameOriginRoute(
        'https://reader:secret@orbit.example/tasks/task-1',
        'https://orbit.example/sessions/session-1',
      ),
    ).toBeNull();
  });
});

describe('SameOriginLink', () => {
  it('navigates a same-origin absolute URL through React Router in the current tab', async () => {
    const href = `${window.location.origin}/tasks/task-1?view=activity#latest`;
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/sessions/session-1']}>
          <SameOriginLink href={href}>Task</SameOriginLink>
          <LocationProbe />
        </MemoryRouter>,
      );
    });

    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/tasks/task-1?view=activity#latest');
    expect(link.getAttribute('target')).toBeNull();

    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(container.querySelector('[data-location]')?.textContent).toBe(
      '/tasks/task-1?view=activity#latest',
    );
  });

  it('opens an external URL in an isolated new tab', async () => {
    await act(async () => {
      root.render(<SameOriginLink href="https://example.com/docs">Docs</SameOriginLink>);
    });

    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('degrades a same-origin URL to a same-tab anchor outside router context', async () => {
    const href = `${window.location.origin}/tasks/task-1`;
    await act(async () => {
      root.render(<SameOriginLink href={href}>Task</SameOriginLink>);
    });

    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('target')).toBeNull();
  });

  it('leaves fragment and download links to the browser in the same tab', async () => {
    await act(async () => {
      root.render(
        <>
          <SameOriginLink href="#latest">Latest</SameOriginLink>
          <SameOriginLink href="/api/export" download>
            Export
          </SameOriginLink>
        </>,
      );
    });

    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#latest', '/api/export']);
    expect(links.every((link) => link.getAttribute('target') === null)).toBe(true);
  });
});
