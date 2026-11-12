// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeId } from './idCodec';
import {
  isTaskHome,
  linkedTaskId,
  useCloseTaskOverPage,
  useTaskLinksOpenInPlace,
  useTaskOverPage,
} from './taskInPlace';

const ORIGIN = window.location.origin;
const TASK = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const OTHER = encodeId('0195c0de-0000-7000-8000-0000000000a2');

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe('linkedTaskId', () => {
  it('reads a same-origin task address, relative or whole', () => {
    expect(linkedTaskId(`/tasks/${TASK}`, ORIGIN)).toBe(TASK);
    expect(linkedTaskId(`${ORIGIN}/tasks/${TASK}`, ORIGIN)).toBe(TASK);
  });

  it('leaves every other link alone', () => {
    expect(linkedTaskId('/tasks', ORIGIN)).toBeNull();
    expect(linkedTaskId(`/tasks/${TASK}/evidence`, ORIGIN)).toBeNull();
    // A list named in the query is where the link means to open it.
    expect(linkedTaskId(`/tasks/${TASK}?list=abc`, ORIGIN)).toBeNull();
    expect(linkedTaskId(`https://elsewhere.example/tasks/${TASK}`, ORIGIN)).toBeNull();
    expect(linkedTaskId(`/sessions/${TASK}`, ORIGIN)).toBeNull();
  });
});

describe('isTaskHome', () => {
  it('is the Tasks routes and a project page, nothing else', () => {
    for (const home of ['/tasks', `/tasks/${TASK}`, '/lists/inbox', '/projects/p1', `/projects/p1/tasks/${TASK}`]) {
      expect(isTaskHome(home), home).toBe(true);
    }
    for (const page of ['/sessions/s1', '/inbox', '/wiki/orbit', '/projects', '/projects/p1/landings', '/settings']) {
      expect(isTaskHome(page), page).toBe(false);
    }
  });
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function Page() {
  useTaskLinksOpenInPlace();
  const open = useTaskOverPage();
  const close = useCloseTaskOverPage();
  return (
    <>
      <Link to={`/tasks/${TASK}`}>first task</Link>
      <a href={`/tasks/${OTHER}`}>second task</a>
      {open && (
        <button type="button" onClick={close}>
          close {open}
        </button>
      )}
      <Where />
    </>
  );
}

function app(at: string) {
  root = createRoot(container);
  act(() => root!.render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/sessions/:id" element={<Page />} />
        <Route path="/projects/:id" element={<Page />} />
        <Route path="/tasks/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  ));
}

const where = () => container.querySelector('[data-testid="where"]')!.textContent;
const byText = (text: string) =>
  [...container.querySelectorAll<HTMLElement>('a, button')].find((el) => el.textContent === text)!;
const press = (text: string, init: MouseEventInit = {}) =>
  act(() => {
    byText(text).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  });

describe('a task link pressed on a page that is not its home', () => {
  it('opens the task over the page, and close returns to the page', () => {
    app('/sessions/s1?folder=f1');
    press('first task');
    expect(where()).toBe(`/sessions/s1?folder=f1&task=${TASK}`);
    press(`close ${TASK}`);
    expect(where()).toBe('/sessions/s1?folder=f1');
  });

  it('opens a plain anchor the same way, replacing the task already open', () => {
    app(`/sessions/s1?task=${TASK}`);
    press('second task');
    expect(where()).toBe(`/sessions/s1?task=${OTHER}`);
    // Opened by an address, not from the page: close puts the page's own address in its place.
    press(`close ${OTHER}`);
    expect(where()).toBe('/sessions/s1');
  });

  it('leaves a modified press to the browser', () => {
    app('/sessions/s1');
    press('second task', { metaKey: true });
    expect(where()).toBe('/sessions/s1');
  });
});

describe('a task link pressed on a task home', () => {
  it('keeps the address it names: the project page has its own rule', () => {
    app('/projects/p1');
    press('first task');
    expect(where()).toBe(`/tasks/${TASK}`);
  });
});
