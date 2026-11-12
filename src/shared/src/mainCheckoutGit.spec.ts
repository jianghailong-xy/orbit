import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAIN_CHECKOUT_ACTION_KINDS,
  MAIN_CHECKOUT_CARD_HANDLED_COPY,
  MAIN_CHECKOUT_FILE_LIMIT,
  MAIN_CHECKOUT_GIT_CAPABILITY,
  MAIN_CHECKOUT_LINK_ACTIONS,
  MAIN_CHECKOUT_NOTICE_KINDS,
  MAIN_CHECKOUT_REFUSAL_CODES,
  WORKTREE_ISOLATION_DIALOG_COPY,
  mainCheckoutBarStatus,
  mainCheckoutCardHandled,
  mainCheckoutCardSubtitle,
  mainCheckoutCardTitle,
  mainCheckoutCommitButton,
  mainCheckoutMoveHint,
  mainCheckoutResultLine,
  mainCheckoutReviewAndCommit,
  mainCheckoutTruncatedNote,
  worktreeIsolationDirtyBody,
  worktreeIsolationOffBody,
  worktreeIsolationStuckBody,
  type MainCheckoutActionCommand,
  type MainCheckoutActionRequest,
  type MainCheckoutActionResult,
  type MainCheckoutCardHandled,
  type MainCheckoutChangedNotice,
  type MainCheckoutCurrent,
  type MainCheckoutFile,
  type MainCheckoutLineView,
  type MainCheckoutRepoHealth,
  type MainCheckoutSnapshot,
} from './mainCheckoutGit';
import * as shared from './index';

/**
 * Pins the main checkout Git contract (docs/main-checkout-git-contract.md). The codes, kinds and
 * capability here are also read by src/runner-go/main_checkout_types_test.go from the same fixture, and
 * every result line is the exact sentence the clients draw — board 03's sentences character for character.
 */

interface FixtureResult {
  name: string;
  onBoard: boolean;
  result: MainCheckoutActionResult;
  view: MainCheckoutLineView;
  lead: string;
  text: string;
  link?: { action: string; label: string };
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'main-checkout-git.fixture.json'), 'utf8')) as {
  capability: string;
  fileLimit: number;
  actionKinds: string[];
  refusalCodes: string[];
  noticeKinds: Record<string, string>;
  snapshot: MainCheckoutSnapshot;
  truncatedSnapshot: MainCheckoutSnapshot;
  fingerprints: Array<{ head?: string; files: MainCheckoutFile[]; fingerprint: string }>;
  heartbeatRepo: MainCheckoutRepoHealth;
  requests: MainCheckoutActionRequest[];
  command: MainCheckoutActionCommand;
  changedNotice: MainCheckoutChangedNotice;
  results: FixtureResult[];
  cardHandled: {
    copy: Record<string, string>;
    cases: Array<{
      name: string;
      results: MainCheckoutActionResult[];
      current: MainCheckoutCurrent | null;
      handled: MainCheckoutCardHandled | null;
    }>;
  };
};

/** The fingerprint definition, written out here and in the Go test — never in product code, which is the
 *  runner's alone. */
function fingerprint(head: string | undefined, files: MainCheckoutFile[]): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const parts: Buffer[] = [Buffer.from(`mc1\nhead ${head ?? '-'}\n`)];
  for (const f of sorted) parts.push(Buffer.from(`${f.status} ${f.contentHash} ${f.path}\0`));
  return `mc1:${head ?? '-'}:${createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
}

describe('main checkout Git contract', () => {
  it('names the capability, kinds, codes and notice kinds the fixture holds', () => {
    expect(MAIN_CHECKOUT_GIT_CAPABILITY).toBe('main-checkout-git/v1');
    expect(fixture.capability).toBe(MAIN_CHECKOUT_GIT_CAPABILITY);
    expect(fixture.fileLimit).toBe(MAIN_CHECKOUT_FILE_LIMIT);
    expect(fixture.actionKinds).toEqual([...MAIN_CHECKOUT_ACTION_KINDS]);
    expect(fixture.refusalCodes).toEqual([...MAIN_CHECKOUT_REFUSAL_CODES]);
    expect(fixture.noticeKinds).toEqual(MAIN_CHECKOUT_NOTICE_KINDS);
    expect(MAIN_CHECKOUT_NOTICE_KINDS.changed).not.toBe('shared-checkout-dirty');
  });

  it('is exported from the package root', () => {
    expect(shared.MAIN_CHECKOUT_GIT_CAPABILITY).toBe(MAIN_CHECKOUT_GIT_CAPABILITY);
    expect(shared.mainCheckoutResultLine).toBe(mainCheckoutResultLine);
  });

  it('defines the fingerprint over HEAD and every file, paths in UTF-8 byte order', () => {
    for (const v of fixture.fingerprints) expect(fingerprint(v.head, v.files)).toBe(v.fingerprint);
    expect(fixture.snapshot.fingerprint).toBe(fingerprint(fixture.snapshot.head, fixture.snapshot.files));
    // U+FF5E sorts before an astral character in UTF-8, after it in UTF-16: the order is bytes.
    const paths = fixture.snapshot.files.map((f) => f.path);
    expect(paths.indexOf('docs/～.md')).toBeLessThan(paths.indexOf('docs/\u{1F600}.md'));
    // Order of the input does not matter; content and status do.
    const files = fixture.snapshot.files;
    const head = fixture.snapshot.head;
    expect(fingerprint(head, [...files].reverse())).toBe(fixture.snapshot.fingerprint);
    const edited = files.map((f, i) => (i === 0 ? { ...f, contentHash: '0'.repeat(40) } : f));
    expect(fingerprint(head, edited)).not.toBe(fixture.snapshot.fingerprint);
    expect(fingerprint('0'.repeat(40), files)).not.toBe(fixture.snapshot.fingerprint);
    expect(fixture.snapshot.fingerprint.startsWith(`mc1:${head}:`)).toBe(true);
  });

  it('keeps the heartbeat to counts and the fingerprint', () => {
    expect(Object.keys(fixture.heartbeatRepo).sort()).toEqual(
      ['agentIds', 'ahead', 'behind', 'branch', 'fileCount', 'fingerprint', 'head', 'paths', 'root', 'state', 'truncated', 'upstream'],
    );
    expect(JSON.stringify(fixture.heartbeatRepo)).not.toMatch(/@@|contentHash|patch/);
  });

  it('has one request example per action kind, with only that kind’s fields', () => {
    expect(fixture.requests.map((r) => r.kind)).toEqual([...MAIN_CHECKOUT_ACTION_KINDS]);
    const fields = (r: MainCheckoutActionRequest) => Object.keys(r).sort();
    const base = ['fingerprint', 'kind', 'requestId', 'root'];
    const [move, commit, push, rescue] = fixture.requests;
    expect(fields(move)).toEqual([...base, 'files', 'targetSessionId'].sort());
    expect(fields(commit)).toEqual([...base, 'files', 'message'].sort());
    expect(fields(push)).toEqual(base);
    expect(fields(rescue)).toEqual(base);
    expect(Date.parse(fixture.command.expiresAt)).toBeGreaterThan(Date.parse(fixture.command.requestedAt));
  });

  it('writes every refusal code’s line, and board 03’s sentences exactly', () => {
    const covered = new Set(fixture.results.map((r) => r.result.code).filter(Boolean));
    expect([...covered].sort()).toEqual([...MAIN_CHECKOUT_REFUSAL_CODES].sort());
    expect(new Set(fixture.results.filter((r) => r.result.status === 'done').map((r) => r.result.kind))).toEqual(
      new Set(MAIN_CHECKOUT_ACTION_KINDS),
    );
    for (const r of fixture.results) {
      const got = mainCheckoutResultLine(r.result, r.view);
      expect(got.text, r.name).toBe(r.text);
      expect(got.lead, r.name).toBe(r.lead);
      expect(got.text.startsWith(got.lead), r.name).toBe(true);
      expect(got.link, r.name).toEqual(r.link);
      if (got.link) expect(MAIN_CHECKOUT_LINK_ACTIONS).toContain(got.link.action);
      expect(got.text).not.toMatch(/undefined|NaN/);
    }
    expect(fixture.results.filter((r) => r.onBoard).map((r) => r.text)).toEqual([
      'Moved 3 files into this worktree. The main checkout is clean again. A copy of what it held is on orbit/rescue-5f2c1a9.',
      'Committed 3 files to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet. This session\'s branch is unchanged.',
      'Pushed main to origin (62325fb..8d41e0c).',
      'Saved 3 files to orbit/rescue-5f2c1a9 and returned the main checkout to 62325fb. Ignored files were left alone.',
      'Nothing moved: the main checkout changed since you looked (src/api/retry.ts).',
      'Nothing moved: src/api/client.ts is also changed in this worktree, in the same lines. Commit it to main or save it to a rescue branch instead, or ask the agent to combine them.',
      'Push rejected: origin/main has 2 commits the main checkout doesn\'t. Nothing was changed, and Orbit never force-pushes.',
      'Push failed: the runner\'s git couldn\'t authenticate to origin (“Permission denied (publickey)”). Your commit is still in the main checkout.',
      'Can\'t commit right now: the main checkout is in the middle of a rebase.',
      'Waiting for the runner — orbit-hpc hasn\'t checked in for 3 min. Nothing has been changed; this runs when it\'s back, or you can cancel.',
    ]);
  });

  it('says where a move went, what stayed behind, and leaves the branch sentence out of a Shared session', () => {
    const move = fixture.results.find((r) => r.name === 'move done')!.result;
    expect(mainCheckoutResultLine({ ...move, targetSessionId: 'sess-2' }, { sessionId: 'sess-1', targetTitle: 'Bump eslint to 9' }).lead)
      .toBe('Moved 3 files into the worktree of “Bump eslint to 9”.');
    expect(mainCheckoutResultLine({ ...move, remaining: 1 }, { sessionId: 'sess-1' }).text)
      .toContain('The main checkout still has 1 other uncommitted file.');
    const commit = fixture.results.find((r) => r.name === 'commit done')!.result;
    expect(mainCheckoutResultLine(commit, { isolated: false }).text)
      .toBe('Committed 3 files to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet.');
    const push = fixture.results.find((r) => r.name === 'push done')!.result;
    expect(mainCheckoutResultLine({ ...push, remoteBefore: undefined }).text).toBe('Pushed main to origin as a new branch (8d41e0c).');
  });

  it('draws board 01, 02 and 04 copy', () => {
    const n = fixture.changedNotice;
    expect(mainCheckoutCardTitle(n.fileCount, n.truncated)).toBe('3 files changed in the main checkout during this turn');
    expect(mainCheckoutCardSubtitle(n.root, n.branch)).toBe(
      "/root/orbit on main, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them.",
    );
    expect(n.notice).toBe(`${mainCheckoutCardTitle(n.fileCount, n.truncated)} ${mainCheckoutCardSubtitle(n.root, n.branch)}`);
    expect(mainCheckoutCardTitle(200, true)).toBe('At least 200 files changed in the main checkout during this turn');
    expect(mainCheckoutTruncatedNote()).toBe('Orbit stopped counting at 200 files.');
    expect(mainCheckoutMoveHint('orbit/fix-retry-backoff')).toBe(
      'Copies them onto orbit/fix-retry-backoff, then clears them from the main checkout. A recovery branch is saved first.',
    );
    expect(mainCheckoutReviewAndCommit('main')).toBe('Review and commit to main…');
    expect(mainCheckoutBarStatus(3, 0)).toBe('3 uncommitted files');
    expect(mainCheckoutBarStatus(0, 1)).toBe('Clean · 1 commit not pushed');
    expect(mainCheckoutCommitButton(3, 'main')).toBe('Commit 3 files to main');
    expect(worktreeIsolationDirtyBody('/root/orbit', 3, 'main', fixture.snapshot.head!)).toBe(
      "The main checkout /root/orbit has 3 uncommitted files. New sessions start from the last commit on main (62325fb), so they won't see those files.",
    );
    expect(worktreeIsolationStuckBody('/root/orbit', 'rebase')).toBe(
      "The main checkout /root/orbit is stuck in a rebase — new sessions can be created, but merges stay blocked until it's cleaned up.",
    );
    expect(worktreeIsolationOffBody('/root/orbit', 2)).toBe(
      'New sessions will work directly in /root/orbit. The 2 sessions with unmerged worktrees keep them — merge or discard them from each session as before.',
    );
    expect(WORKTREE_ISOLATION_DIALOG_COPY.unchanged).toBe(
      'Nothing in the checkout is changed. Sessions already running keep working in the main checkout until they end.',
    );
  });

  it('retires a card once its changes were moved, saved or are gone, and only then', () => {
    expect(fixture.cardHandled.copy).toEqual(MAIN_CHECKOUT_CARD_HANDLED_COPY);
    for (const c of fixture.cardHandled.cases) {
      expect(mainCheckoutCardHandled(fixture.changedNotice, c.results, c.current), c.name).toBe(c.handled);
    }
    expect(mainCheckoutCardHandled(fixture.changedNotice, [], fixture.heartbeatRepo)).toBeNull();
    expect(mainCheckoutCardHandled(fixture.changedNotice, [], fixture.snapshot)).toBeNull();
  });
});
