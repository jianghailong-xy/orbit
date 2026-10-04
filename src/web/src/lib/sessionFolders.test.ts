import { describe, expect, it } from 'vitest';
import type { SessionMoveTarget, SessionMoveTargets } from '@orbit/shared';
import { ApiError, type SessionFolder } from '../api';
import {
  FOLDER_COPY,
  folderNameDraft,
  folderNameFailure,
  foldersByName,
  listShowsFolders,
  moveConfirmAction,
  moveConfirmParagraphs,
  moveFailureText,
  moveTargetFolders,
  moveTargetFooter,
  moveTargetRows,
  movedToFolderToast,
  runWorkspaceMove,
  sessionFolderListing,
  sessionsInFolder,
} from './sessionFolders';

type Row = { id: string; folderId?: string | null; needsYou?: boolean; motion?: 'spinner' | 'pulse' | null };

const folder = (id: string, name: string): SessionFolder => ({ id, workspaceId: 'w1', name });
const readings = {
  needsYou: (s: Row) => !!s.needsYou,
  motion: (s: Row) => s.motion ?? null,
};

describe('listShowsFolders', () => {
  it('shows folders in Open and Completed, never in Trash or under a tag', () => {
    expect(listShowsFolders('open', false)).toBe(true);
    expect(listShowsFolders('completed', false)).toBe(true);
    expect(listShowsFolders('trash', false)).toBe(false);
    expect(listShowsFolders('open', true)).toBe(false);
  });
});

describe('foldersByName', () => {
  it('orders names as Finder does: case-insensitive, digits by value, id settles a tie', () => {
    const sorted = foldersByName([
      folder('c', 'Sprint 10'),
      folder('b', 'sprint 2'),
      folder('z', 'Bugs'),
      folder('a', 'bugs'),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['a', 'z', 'b', 'c']);
  });
});

describe('sessionFolderListing', () => {
  const folders = [folder('f2', 'Wiki'), folder('f1', 'Release'), folder('f3', 'Empty')];
  const sessions: Row[] = [
    { id: 's1', folderId: 'f1', needsYou: true },
    { id: 's2', folderId: null },
    { id: 's3', folderId: 'f1', motion: 'spinner' },
    { id: 's4', folderId: 'f2', motion: 'pulse' },
    { id: 's5', folderId: 'gone' },
  ];

  it('puts folders on top by name and keeps every other session, a deleted folder’s too, in the list', () => {
    const listing = sessionFolderListing(sessions, folders, { view: 'open', byTag: false, ...readings });
    expect(listing.folders.map((r) => [r.folder.name, r.sessionCount])).toEqual([
      ['Empty', 0],
      ['Release', 2],
      ['Wiki', 1],
    ]);
    expect(listing.sessions.map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('reports for the sessions inside: who waits on you, and what is moving', () => {
    const [, release, wiki] = sessionFolderListing(sessions, folders, { view: 'open', byTag: false, ...readings }).folders;
    expect(release).toMatchObject({ needsYou: 1, running: true, jobs: false });
    expect(wiki).toMatchObject({ needsYou: 0, running: false, jobs: true });
  });

  it('draws no activity while the Runner is offline, but still counts who waits on you', () => {
    const [, release, wiki] = sessionFolderListing(sessions, folders, {
      view: 'open',
      byTag: false,
      runnerOffline: true,
      ...readings,
    }).folders;
    expect(release).toMatchObject({ needsYou: 1, running: false, jobs: false });
    expect(wiki).toMatchObject({ running: false, jobs: false });
  });

  it('shows only the folders a completed session is in on Completed', () => {
    const listing = sessionFolderListing(sessions, folders, { view: 'completed', byTag: false, ...readings });
    expect(listing.folders.map((r) => r.folder.name)).toEqual(['Release', 'Wiki']);
  });

  it('stays flat in Trash and under a tag', () => {
    for (const opts of [{ view: 'trash' as const, byTag: false }, { view: 'open' as const, byTag: true }]) {
      const listing = sessionFolderListing(sessions, folders, { ...opts, ...readings });
      expect(listing.folders).toEqual([]);
      expect(listing.sessions).toHaveLength(sessions.length);
    }
  });

  it('lists a folder’s own sessions on its page, in the list’s order', () => {
    expect(sessionsInFolder(sessions, 'f1').map((s) => s.id)).toEqual(['s1', 's3']);
  });
});

describe('folder names and failures', () => {
  it('trims a name and ignores one of spaces alone', () => {
    expect(folderNameDraft('  Notes ')).toBe('Notes');
    expect(folderNameDraft('   ')).toBeNull();
  });

  it('says a taken name in so many words, anything else in the server’s', () => {
    const taken = new ApiError('a folder with that name already exists in this workspace', 409);
    expect(folderNameFailure(taken, 'Release', 'orbit', 'renamed')).toBe(
      'There’s already a folder named “Release” in orbit. Choose another name.',
    );
    expect(folderNameFailure(new ApiError('workspace not found', 403), 'X', 'orbit', 'created')).toBe(
      'The folder couldn’t be created: workspace not found.',
    );
  });

  it('confirms a delete without a count', () => {
    expect(FOLDER_COPY.deleteTitle('Release')).toBe('Delete “Release”?');
    expect(FOLDER_COPY.deleteMessage).toBe('Its sessions move back to the list. No session is deleted.');
  });

  it('names where a session went, or the folder it left', () => {
    expect(movedToFolderToast({ name: 'Release' }, null)).toBe('Moved to “Release”');
    expect(movedToFolderToast(null, { name: 'Wiki' })).toBe('Moved out of “Wiki”');
    expect(movedToFolderToast(null, null)).toBe('Moved out of its folder');
  });
});

const target = (over: Partial<SessionMoveTarget> = {}): SessionMoveTarget => ({
  workspaceId: 'w2',
  name: 'wikova-develop',
  provider: 'codex',
  runnerId: 'r1',
  runnerName: 'wikova',
  runnerOnline: true,
  workDir: '/srv/wikova-develop',
  reason: null,
  conversation: 'continues',
  folders: [],
  ...over,
});

const answer = (over: Partial<SessionMoveTargets> = {}): SessionMoveTargets => ({
  workspaceId: 'w1',
  folderId: null,
  folders: [],
  reason: null,
  needsEnd: false,
  branch: null,
  changedFiles: 0,
  unmergedFiles: 0,
  mergeTarget: null,
  targets: [target()],
  ...over,
});

const providerName = (slug: string) => (slug === 'codex' ? 'Codex' : 'Claude');

describe('moveTargetRows', () => {
  it('opens a workspace the session can go to and names its provider and runner', () => {
    expect(moveTargetRows(answer(), providerName)).toEqual([
      { target: target(), enabled: true, detail: 'Codex · wikova' },
    ]);
  });

  it('greys a workspace with the server’s reason, and every row when the session can’t move', () => {
    const blocked = target({ reason: 'Update HPC to move sessions here' });
    expect(moveTargetRows(answer({ targets: [blocked] }), providerName)[0]).toMatchObject({
      enabled: false,
      detail: 'Update HPC to move sessions here',
    });
    expect(moveTargetRows(answer({ reason: 'Stop the session first.' }), providerName)[0].enabled).toBe(false);
  });

  it('keeps an offline runner open', () => {
    expect(moveTargetRows(answer({ targets: [target({ runnerOnline: false })] }), providerName)[0].enabled).toBe(true);
  });
});

describe('a workspace step', () => {
  it('lists the server’s folders with the ones made since, by name, once each', () => {
    const t = target({ folders: [{ id: 'b', name: 'Infra', sessionCount: 3 }, { id: 'a', name: 'Bugs', sessionCount: 12 }] });
    const made = [{ id: 'c', name: 'Cleanup', sessionCount: 0 }, { id: 'a', name: 'Bugs', sessionCount: 0 }];
    expect(moveTargetFolders(t, made).map((f) => f.name)).toEqual(['Bugs', 'Cleanup', 'Infra']);
  });

  it('says how the conversation comes along and where the agent works', () => {
    expect(moveTargetFooter(target())).toBe(
      'Same runner (wikova). The conversation carries over as it is. The agent works in /srv/wikova-develop from your next message.',
    );
    expect(moveTargetFooter(target({ conversation: 'rebuilt', runnerName: 'HPC', workDir: null, runnerOnline: false }))).toBe(
      'Another runner (HPC). The conversation is rebuilt from Orbit’s record, its earlier parts summarized for the agent. HPC is offline: your next message waits for it.',
    );
  });
});

describe('the confirmation', () => {
  it('names unmerged changes, a rebuilt conversation and an end first', () => {
    const a = answer({ needsEnd: true, branch: 'orbit/review-import-3fa21c', changedFiles: 4, unmergedFiles: 3, mergeTarget: 'main' });
    expect(moveConfirmParagraphs(a, target({ conversation: 'rebuilt' }), 'orbit')).toEqual([
      'The conversation moves with it. Your next message continues it in wikova-develop.',
      'Earlier parts of the conversation are summarized for the agent.',
      '3 changed files aren’t merged into main yet. They stay on branch orbit/review-import-3fa21c in orbit.',
      'The session ends first.',
    ]);
    expect(moveConfirmAction(a)).toBe('End and Move');
  });

  it('says one unmerged file in the singular, and merged changes plainly', () => {
    const one = answer({ branch: 'b', changedFiles: 2, unmergedFiles: 1 });
    expect(moveConfirmParagraphs(one, target(), 'orbit')[1]).toBe(
      '1 changed file isn’t merged into main yet. It stays on branch b in orbit.',
    );
    const merged = answer({ branch: 'b', changedFiles: 2, unmergedFiles: 0 });
    expect(moveConfirmParagraphs(merged, target(), 'orbit')[1]).toBe('Changes made so far stay on branch b in orbit.');
    expect(moveConfirmAction(merged)).toBe('Move');
  });

  it('shows only the reason, preserving the server’s words and punctuation', () => {
    expect(moveFailureText(new ApiError('Stop the session first.', 409))).toBe('Stop the session first.');
    expect(moveFailureText(new ApiError('Bad Gateway', 502))).toBe('Bad Gateway');
    expect(moveFailureText(new ApiError('Permission denied.', 403))).toBe('Permission denied.');
    expect(moveFailureText(new Error('The connection dropped.'))).toBe('The connection dropped.');
    expect(moveFailureText(null)).toBe('something went wrong');
  });
});

describe('runWorkspaceMove', () => {
  const noSleep = async () => {};

  it('moves an ended session straight away', async () => {
    const calls: string[] = [];
    const out = await runWorkspaceMove({
      endingFirst: false,
      end: async () => calls.push('end'),
      ended: async () => true,
      move: async () => calls.push('move'),
      phase: (p) => calls.push(p),
      sleep: noSleep,
    });
    expect(out).toBeNull();
    expect(calls).toEqual(['moving', 'move']);
  });

  it('ends first, waits until the session has ended, then moves', async () => {
    const calls: string[] = [];
    let looks = 0;
    const out = await runWorkspaceMove({
      endingFirst: true,
      end: async () => calls.push('end'),
      ended: async () => ++looks >= 3,
      move: async () => calls.push('move'),
      phase: (p) => calls.push(p),
      sleep: noSleep,
    });
    expect(out).toBeNull();
    expect(calls).toEqual(['ending', 'end', 'moving', 'move']);
    expect(looks).toBe(3);
  });

  it('waits on a session already ending (409), and stops on any other end failure', async () => {
    const already = await runWorkspaceMove({
      endingFirst: true,
      end: async () => {
        throw new ApiError('already ending', 409);
      },
      ended: async () => true,
      move: async () => {},
      sleep: noSleep,
    });
    expect(already).toBeNull();
    const failed = await runWorkspaceMove({
      endingFirst: true,
      end: async () => {
        throw new ApiError('runner offline', 503);
      },
      ended: async () => true,
      move: async () => {},
      sleep: noSleep,
    });
    expect(failed).toBe('The session couldn’t be ended, so it wasn’t moved: runner offline.');
  });

  it('gives up when the session never ends, and says why a move was refused', async () => {
    const timedOut = await runWorkspaceMove({
      endingFirst: true,
      end: async () => {},
      ended: async () => false,
      move: async () => {},
      sleep: noSleep,
      timeoutMs: 3,
      intervalMs: 1,
    });
    expect(timedOut).toBe('The session hasn’t finished ending, so it wasn’t moved. Try again once it has ended.');
    const refused = await runWorkspaceMove({
      endingFirst: false,
      end: async () => {},
      ended: async () => true,
      move: async () => {
        throw new ApiError('The session woke up; stop it first.', 409);
      },
      sleep: noSleep,
    });
    expect(refused).toBe('The session woke up; stop it first.');
  });
});
