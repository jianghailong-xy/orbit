import { describe, expect, it } from 'vitest';
import {
  SESSION_DRAG_TYPE,
  dragCarriesFiles,
  dragCarriesSession,
  dragEdgeScrollStep,
  folderDropVerdict,
  sessionRowDraggable,
} from './sessionDrag';

const known = new Set(['release', 'wiki']);
const loose = { id: 's1', workspaceId: 'w1', folderId: null };
const inRelease = { id: 's2', workspaceId: 'w1', folderId: 'release' };
const canDrag = { view: 'open' as const, dropTargets: true, touch: false, renaming: false };

describe('a session drag’s data types', () => {
  it('is its own type, which drop-to-upload does not read as files', () => {
    expect(dragCarriesSession([SESSION_DRAG_TYPE])).toBe(true);
    expect(dragCarriesFiles([SESSION_DRAG_TYPE])).toBe(false);
    expect(dragCarriesSession(['Files'])).toBe(false);
    expect(dragCarriesFiles(['Files'])).toBe(true);
    expect(dragCarriesSession(undefined)).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe('folderDropVerdict', () => {
  it('moves a session into another folder of its workspace, or out to No Folder', () => {
    expect(folderDropVerdict(loose, { workspaceId: 'w1', folderId: 'wiki' }, known)).toBe('move');
    expect(folderDropVerdict(inRelease, { workspaceId: 'w1', folderId: 'wiki' }, known)).toBe('move');
    expect(folderDropVerdict(inRelease, { workspaceId: 'w1', folderId: null }, known)).toBe('move');
  });

  it('takes no drop on the folder the session is already in', () => {
    expect(folderDropVerdict(inRelease, { workspaceId: 'w1', folderId: 'release' }, known)).toBe('here');
    expect(folderDropVerdict(loose, { workspaceId: 'w1', folderId: null }, known)).toBe('here');
  });

  it('reads a session filed in a folder since deleted as in no folder, as the list draws it', () => {
    const stale = { id: 's3', workspaceId: 'w1', folderId: 'gone' };
    expect(folderDropVerdict(stale, { workspaceId: 'w1', folderId: null }, known)).toBe('here');
    expect(folderDropVerdict(stale, { workspaceId: 'w1', folderId: 'wiki' }, known)).toBe('move');
  });

  it('refuses another workspace, and a folder that is not the workspace’s', () => {
    expect(folderDropVerdict(loose, { workspaceId: 'w2', folderId: 'wiki' }, known)).toBe('refused');
    expect(folderDropVerdict(loose, { workspaceId: 'w2', folderId: null }, known)).toBe('refused');
    expect(folderDropVerdict(loose, { workspaceId: 'w1', folderId: 'elsewhere' }, known)).toBe('refused');
  });
});

describe('sessionRowDraggable', () => {
  it('picks up a session Move… would file, where there is somewhere to drop it', () => {
    expect(sessionRowDraggable({}, canDrag)).toBe(true);
    expect(sessionRowDraggable({}, { ...canDrag, view: 'completed' })).toBe(true);
    expect(sessionRowDraggable({ pinnedAt: '2026-11-01T00:00:00Z' }, canDrag)).toBe(true);
    // A member whose project has no row here is filed by its own folder, as Move… files it.
    expect(sessionRowDraggable({ projectMembership: { role: 'TASK' }, projectMark: { projectId: 'p' } }, canDrag)).toBe(true);
  });

  it('picks up a project row by its coordinator, pinned or not', () => {
    const coordinator = { id: 'c', projectMembership: { role: 'COORDINATOR' } };
    expect(sessionRowDraggable(coordinator, canDrag)).toBe(true);
    expect(sessionRowDraggable({ ...coordinator, pinnedAt: '2026-11-01T00:00:00Z' }, canDrag)).toBe(true);
    expect(sessionRowDraggable(coordinator, { ...canDrag, view: 'trash' })).toBe(false);
  });

  it('leaves members that follow their coordinator where they are', () => {
    expect(sessionRowDraggable({ projectMembership: { role: 'TASK' } }, canDrag)).toBe(false);
  });

  it('is off in Trash, with nowhere to drop, on a touch screen and while the row is renamed', () => {
    expect(sessionRowDraggable({}, { ...canDrag, view: 'trash' })).toBe(false);
    expect(sessionRowDraggable({}, { ...canDrag, dropTargets: false })).toBe(false);
    expect(sessionRowDraggable({}, { ...canDrag, touch: true })).toBe(false);
    expect(sessionRowDraggable({}, { ...canDrag, renaming: true })).toBe(false);
  });
});

describe('dragEdgeScrollStep', () => {
  const list = { top: 100, bottom: 600 };
  it('scrolls up near the top edge and down near the bottom, faster closer to it', () => {
    expect(dragEdgeScrollStep(102, list)).toBeLessThan(0);
    expect(dragEdgeScrollStep(598, list)).toBeGreaterThan(0);
    expect(Math.abs(dragEdgeScrollStep(101, list))).toBeGreaterThan(Math.abs(dragEdgeScrollStep(140, list)));
    expect(dragEdgeScrollStep(599, list)).toBeGreaterThan(dragEdgeScrollStep(560, list));
  });

  it('stays put away from both edges and outside the list', () => {
    expect(dragEdgeScrollStep(350, list)).toBe(0);
    expect(dragEdgeScrollStep(50, list)).toBe(0);
    expect(dragEdgeScrollStep(700, list)).toBe(0);
    expect(dragEdgeScrollStep(350, { top: 0, bottom: 0 })).toBe(0);
  });
});
