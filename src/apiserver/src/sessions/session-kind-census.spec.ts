import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The kind census (docs/project-integration-line-contract.md §2.9 LS6): every path that SCANS
 * sessions by a scheduler condition — a status, a retry instant, a lease, a runner's request —
 * filters them to CONVERSATION, so a LANDING row is never claimed, reaped, retried, handed to a
 * runner or counted by a list. LS1's AWAITING_INPUT means only that the subject is open; read as
 * a conversation's idle state it would be reaped as a dropped run and then armed for a retry.
 *
 * Checked BOTH ways, like the route census:
 *   1. every registered scan still carries its `sessionKind` / `kind = 'CONVERSATION'` filter —
 *      deleting one turns this red;
 *   2. in the files that own those scans, every session row-selection that filters on `status`
 *      carries the same filter unless it is one of the exceptions below with a stated reason — a
 *      NEW unregistered scan of that shape turns this red.
 */
const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

interface KindFilteredScan {
  file: string;
  name: string;
  /** Source text that identifies the query. Every occurrence is checked. */
  anchor: string;
  /** What the filter is written as, within `within` characters after the anchor. */
  filter: string;
  within?: number;
}

const SCANS: readonly KindFilteredScan[] = [
  {
    file: 'src/queue/queue.service.ts',
    name: 'the claim statement (the PENDING pick the runner is handed)',
    anchor: "WHERE s.status = 'PENDING'",
    filter: `AND s."kind" = 'CONVERSATION'`,
    within: 700,
  },
  {
    file: 'src/queue/queue.service.ts',
    name: 'pausedPendingSessions (a held row is a conversation)',
    anchor: 'const pending = await this.prisma.session.findMany({',
    filter: "sessionKind: 'CONVERSATION',",
  },
  {
    file: 'src/realtime/reaper.service.ts',
    name: 'the reaper sweep (a landing is never a dropped run)',
    anchor: 'const sessions = await this.prisma.session.findMany({',
    filter: "sessionKind: 'CONVERSATION'",
  },
  {
    file: 'src/sessions/auto-retry.service.ts',
    name: 'the auto-retry sweep',
    anchor: 'const due = await this.prisma.session.findMany({',
    filter: "sessionKind: 'CONVERSATION',",
  },
  {
    file: 'src/sessions/auto-retry.service.ts',
    name: 'releaseExpiredClaims',
    anchor: 'const lapsed = await this.prisma.session.findMany({',
    filter: "sessionKind: 'CONVERSATION',",
  },
  {
    file: 'src/runner-api/runner-api.controller.ts',
    name: 'reclaim (live work a runner lost contact with)',
    anchor: 'const sessions = await this.prisma.session.findMany({\n      where: {\n        assignedRunnerId: runner.id,',
    filter: "sessionKind: 'CONVERSATION',",
  },
  {
    file: 'src/runner-api/runner-api.controller.ts',
    name: 'the heartbeat lease fence',
    anchor: 'const matching = await this.prisma.session.findMany({',
    filter: "sessionKind: 'CONVERSATION',",
  },
  {
    file: 'src/runner-api/runner-api.controller.ts',
    name: 'the heartbeat worktree snapshot write',
    anchor: 'await this.prisma.session.updateMany({\n              where: {\n                id: s.sessionId,',
    filter: "sessionKind: 'CONVERSATION',",
  },
  {
    file: 'src/runner-api/runner-api.controller.ts',
    name: 'markProviderUpgradeRequired (the PENDING pick and its mark)',
    anchor: 'await this.prisma.session.findMany({\n        where: {\n          assignedRunnerId: runnerId,\n          status: RunStatus.PENDING,',
    filter: "sessionKind: 'CONVERSATION',",
    within: 220,
  },
  {
    file: 'src/runner-api/runner-api.controller.ts',
    name: 'markProviderUpgradeRequired and markSourceProtocolUnsupported marks',
    anchor: 'const marked = await this.prisma.session.updateMany({',
    filter: "sessionKind: 'CONVERSATION',",
    within: 400,
  },
  {
    file: 'src/runner-api/runner-api.controller.ts',
    name: 'markSourceProtocolUnsupported (the PENDING pick)',
    anchor: 'const pending = await this.prisma.session.findMany({\n      where: {\n        assignedRunnerId: runnerId,\n        status: RunStatus.PENDING,',
    filter: "sessionKind: 'CONVERSATION',",
    within: 220,
  },
  {
    file: 'src/realtime/realtime.service.ts',
    name: 'drainMergeRequests',
    anchor: 'async drainMergeRequests(',
    filter: "sessionKind: 'CONVERSATION',",
    within: 900,
  },
  {
    file: 'src/realtime/realtime.service.ts',
    name: 'drainCommitRequests',
    anchor: 'async drainCommitRequests(',
    filter: "sessionKind: 'CONVERSATION',",
    within: 900,
  },
  {
    file: 'src/sessions/sessions.service.ts',
    name: 'listForOrchestration (flat list, MCP session_list, runner list)',
    anchor: 'async listForOrchestration(',
    filter: 'sessionKind: SESSION_KIND_CONVERSATION,',
    within: 700,
  },
  {
    file: 'src/sessions/sessions.service.ts',
    name: 'list (every view of the flat GET /sessions)',
    anchor: 'const visibility: Prisma.Sql =',
    filter: `s.kind = 'CONVERSATION'`,
    within: 900,
  },
  {
    file: 'src/sessions/sessions.service.ts',
    name: 'workspaceSessionCounts (GET /sessions/counts)',
    anchor: 'async workspaceSessionCounts(',
    filter: 'sessionKind: SESSION_KIND_CONVERSATION,',
    within: 900,
  },
  {
    file: 'src/projects/project-done-request.ts',
    name: 'a done request\'s "nothing is still running" read',
    anchor: 'const runs = await tx.session.findMany({',
    filter: "sessionKind: 'CONVERSATION',",
    within: 700,
  },
  {
    file: 'src/push/push.service.ts',
    name: 'the push center\'s running-session read',
    anchor: 'this.prisma.session.findMany({',
    filter: "sessionKind: 'CONVERSATION',",
    within: 700,
  },
];

/**
 * Scans that filter on `status` but are not scheduler picks, with the reason they need no filter.
 * Everything else in the watched files must carry one — see the second test.
 */
const EXCEPTIONS: ReadonlyArray<{ file: string; anchor: string; why: string }> = [
  {
    file: 'src/sessions/sessions.service.ts',
    anchor: 'where: { rootSessionId, status: { in: UNSETTLED_SESSION_STATUSES } },',
    why: 'the spawn-tree quota counts CHILDREN by root_session_id, and a LANDING row writes NULL there (LS1)',
  },
  {
    file: 'src/sessions/sessions.service.ts',
    anchor: 'where: { ...open, status: { in: [RunStatus.RUNNING, RunStatus.PENDING] } },',
    why: '`open` is the shared counts filter, which carries sessionKind (checked above)',
  },
  {
    file: 'src/sessions/sessions.service.ts',
    anchor: 'where: {\n          ...open,\n          OR: [',
    why: '`open` carries sessionKind (checked above)',
  },
  {
    file: 'src/sessions/sessions.service.ts',
    anchor: 'where: { ...open, ...GENERATING_SESSION_FILTER,',
    why: '`open` carries sessionKind (checked above)',
  },
];

/** The files whose session row-selection the scan heuristic watches. */
const WATCHED = [
  'src/queue/queue.service.ts',
  'src/realtime/reaper.service.ts',
  'src/sessions/auto-retry.service.ts',
  'src/sessions/sessions.service.ts',
  'src/runner-api/runner-api.controller.ts',
  'src/realtime/realtime.service.ts',
  'src/push/push.service.ts',
  'src/projects/project-done-request.ts',
];

test('every registered scan still filters LANDING out', () => {
  const sources = new Map<string, string>();
  for (const scan of SCANS) {
    if (!sources.has(scan.file)) sources.set(scan.file, read(scan.file));
    const source = sources.get(scan.file)!;
    const at = source.indexOf(scan.anchor);
    assert.ok(at >= 0, `${scan.name}: "${scan.anchor.split('\n')[0]}" is no longer in ${scan.file}`);
    let cursor = at;
    const seen: number[] = [];
    while (cursor >= 0) {
      seen.push(cursor);
      cursor = source.indexOf(scan.anchor, cursor + scan.anchor.length);
    }
    for (const start of seen) {
      const window = source.slice(start, start + (scan.within ?? 700));
      assert.ok(
        window.includes(scan.filter),
        `${scan.name} at ${scan.file}:${source.slice(0, start).split('\n').length} no longer filters kind — expected "${scan.filter}"`,
      );
    }
  }
});

test('the flat search filters LANDING out of every one of its owner-scoped branches', () => {
  const source = read('src/sessions/sessions.service.ts');
  const start = source.indexOf('private async searchRows(');
  assert.ok(start >= 0, 'searchRows moved');
  const end = source.indexOf('\n  async workspaceSessionCounts(', start);
  assert.ok(end > start, 'searchRows\' end moved');
  const body = source.slice(start, end);
  const ownerFilters = body.match(/s\.owner_id = \$\{ownerId\}::uuid/g) ?? [];
  const guarded = body.match(/s\.owner_id = \$\{ownerId\}::uuid\n\s*AND s\.kind = 'CONVERSATION'/g) ?? [];
  // Seven today: the content CTE's join, the five meta branches and the recents branch.
  assert.equal(ownerFilters.length, 7, `searchRows has ${ownerFilters.length} owner filters, not 7`);
  assert.equal(guarded.length, ownerFilters.length, 'an owner-scoped search branch does not filter kind');
});

test('no watched file holds an unregistered status scan of sessions', () => {
  const problems: string[] = [];
  for (const file of WATCHED) {
    const source = read(file);
    const re = /\.session\.(findMany|count|groupBy|updateMany|deleteMany)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      const segment = source.slice(match.index, match.index + 1600);
      const cut = segment.search(/\n\s*(select|include)\s*:/);
      const head = cut >= 0 ? segment.slice(0, cut) : segment.slice(0, 800);
      if (!/\bstatus\s*:/.test(head)) continue;
      if (head.includes('sessionKind')) continue;
      // A write or read that names the row by id is a compare-and-set, not a scan.
      if (/(^|[\s{])id(\s*[:,]|\s*=)/.test(head)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      const excused = EXCEPTIONS.some((e) => e.file === file && head.includes(e.anchor));
      if (!excused) problems.push(`${file}:${line} (${match[1]}) scans sessions by status without a kind filter`);
    }
  }
  assert.deepEqual(problems, [], `unregistered session status scans:\n${problems.join('\n')}`);
});
