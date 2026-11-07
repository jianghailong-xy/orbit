import { describe, expect, it } from 'vitest';
import { WIKI_CHAT_COPY, type WikiChatDraftView } from '@orbit/shared';
import { ApiError } from '../api';
import {
  WIKI_CHAT_SEND_FAILED,
  wikiChatCardFace,
  wikiChatCardLook,
  wikiChatDraftIdOf,
  wikiChatDraftingCall,
  wikiChatNeedsSeen,
  wikiChatResultLook,
  wikiChatSendError,
} from './wikiChat';
import { wikiWaiting, wikiWaitingIn } from './wikiSpace';

/**
 * The web's half of a chat's cards (docs/wiki-chat-design.md §7–§8, contract `chat.drafts`, board 42 ② ③ ④): the card a
 * drafting call names, read from its answer whichever engine recorded it; how each state looks and what it offers;
 * the line under an applied card for every result; what a send's failure says; and the Wiki's waiting count by the
 * contract's reading (`space.list.chatWaiting`).
 */

const card = (over: Partial<WikiChatDraftView>): WikiChatDraftView => ({
  id: 'D1',
  sessionId: 'S1chat',
  kind: 'entry',
  state: 'draft',
  label: 'Add decision',
  rationale: 'To ride out one gateway restart.',
  ops: [],
  sections: [],
  rewrites: [],
  similar: [],
  tainted: false,
  replaces: null,
  replacedBy: null,
  decision: null,
  decidedAt: null,
  undoneAt: null,
  undoable: false,
  changesetId: null,
  rewrite: null,
  createdAt: '2026-11-06T10:00:00.000Z',
  ...over,
});

const rewrite = (over: Partial<NonNullable<WikiChatDraftView['rewrite']>>): NonNullable<WikiChatDraftView['rewrite']> => ({
  jobId: 'J1',
  result: 'rewriting',
  reason: null,
  sha: null,
  sections: [
    { doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', result: null, changed: null, versionId: null },
    { doc: 'runner-architecture', key: 'heartbeat', where: '7.1 §2', result: null, changed: null, versionId: null },
  ],
  seen: false,
  settledAt: null,
  ...over,
});

describe('the card a drafting call made (contract `chat.drafts.toolResult`)', () => {
  const propose = { changesetId: '', replayed: false, ops: [{ seq: 0, status: 'draft', entryId: null }], status: 'draft', draftId: '34draftA1b2c3d4e5f6g7', similar: [], rewrites: [] };
  const draft = { status: 'draft', draftId: '34draftB1b2c3d4e5f6g7', kind: 'rewrite', replayed: false, rewrites: [] };
  const note = { noted: true, noteId: 'N1', created: true, readBy: 'maintenance', challenged: { status: 'draft', draftId: '34draftC1b2c3d4e5f6g7' } };

  it('reads the answer Claude Code records as JSON text, for each drafting tool', () => {
    expect(wikiChatDraftIdOf(JSON.stringify(propose))).toBe('34draftA1b2c3d4e5f6g7');
    expect(wikiChatDraftIdOf([{ type: 'text', text: JSON.stringify(draft) }])).toBe('34draftB1b2c3d4e5f6g7');
    expect(wikiChatDraftIdOf(JSON.stringify(note))).toBe('34draftC1b2c3d4e5f6g7');
  });

  it('reads the structured answer an engine passes through with the MCP wrapper (Codex)', () => {
    const wrapper = { content: [{ type: 'text', text: 'Drafted card 34draftA1b2c3d4e5f6g7 for the owner …' }], structuredContent: propose };
    expect(wikiChatDraftIdOf(wrapper)).toBe('34draftA1b2c3d4e5f6g7');
    expect(wikiChatDraftIdOf({ result: { structuredContent: draft } })).toBe('34draftB1b2c3d4e5f6g7');
  });

  it('reads the id the runner’s own sentence names when an engine hands the agent text alone', () => {
    expect(wikiChatDraftIdOf('Drafted card 34draftA1b2c3d4e5f6g7 for the owner of this wiki chat. Nothing in the wiki changed')).toBe('34draftA1b2c3d4e5f6g7');
    expect(wikiChatDraftIdOf('This request already made card 34draftB1b2c3d4e5f6g7 under this idempotencyKey')).toBe('34draftB1b2c3d4e5f6g7');
    expect(wikiChatDraftIdOf('Noted as N1.\nIn this wiki chat the flag is card 34draftC1b2c3d4e5f6g7, for the owner to apply')).toBe('34draftC1b2c3d4e5f6g7');
  });

  it('keys the card by its public id whichever spelling the answer used', () => {
    const uuid = '0196e000-0000-7000-8000-000000000501';
    const id = wikiChatDraftIdOf(JSON.stringify({ status: 'draft', draftId: uuid, kind: 'rewrite', replayed: false, rewrites: [] }));
    expect(id).toMatch(/^[0-9A-Za-z]{20,22}$/u);
    expect(wikiChatDraftIdOf(`Drafted card ${uuid} for the owner of this wiki chat.`)).toBe(id);
    expect(wikiChatDraftIdOf(`Drafted card ${id} for the owner of this wiki chat.`)).toBe(id);
  });

  it('names no card for a dry run, a refusal, or any other answer', () => {
    expect(wikiChatDraftIdOf(JSON.stringify({ ...propose, draftId: null, dryRun: true }))).toBeNull();
    expect(wikiChatDraftIdOf(JSON.stringify({ changesetId: 'C1', replayed: false, ops: [{ seq: 0, status: 'refused', reasons: [] }] }))).toBeNull();
    expect(wikiChatDraftIdOf('Dry run in a wiki chat: every op was checked, and NO card was made')).toBeNull();
    expect(wikiChatDraftIdOf({ noted: true, noteId: 'N1' })).toBeNull();
    expect(wikiChatDraftIdOf(null)).toBeNull();
  });

  it('tells a drafting call by its MCP name under any engine, or by the CLI door in a shell', () => {
    for (const name of ['mcp__orbit__wiki_propose', 'mcp__orbit__wiki_draft', 'mcp__orbit__wiki_note']) expect(wikiChatDraftingCall(name)).toBe(true);
    for (const name of ['mcp__orbit__wiki_search', 'mcp__orbit__wiki_get', 'mcp__orbit__session_create', 'Read', 'wiki_draft']) {
      expect(wikiChatDraftingCall(name), name).toBe(false);
    }
    expect(wikiChatDraftingCall('Bash', { command: 'orbit wiki draft --kind rewrite --doc sessions-runtime' })).toBe(true);
    expect(wikiChatDraftingCall('Bash', { command: 'cd x && orbit wiki propose --json < ops.json' })).toBe(true);
    expect(wikiChatDraftingCall('Bash', { command: 'orbit wiki search lease' })).toBe(false);
  });
});

describe('how a card looks in each state (design §7.3, board 42 ② ③ ④)', () => {
  const add = [{ seq: 0, op: 'add' as const, entryId: null, baseRevision: null, payload: {}, similar: [], tainted: false, entry: null, decision: null }];
  it.each([
    ['draft', { state: 'draft' }, 'Draft · Add decision', 'brand', ['apply', 'edit', 'discard'], null, false],
    ['replaced', { state: 'replaced' }, 'Replaced', 'grey', [], 'A newer draft took over.', true],
    ['changed', { state: 'changed' }, 'Changed since this draft', 'amber', ['redo', 'discard'], null, false],
    ['applied', { state: 'applied', undoable: true }, 'Applied · Confirmed by you', 'ok', ['undo', 'open_entry'], null, true],
    ['discarded', { state: 'discarded' }, 'Discarded', 'grey', [], null, true],
    ['not applied', { state: 'not_applied' }, 'Not applied', 'grey', [], null, true],
    ['undone', { state: 'undone' }, 'Undone', 'grey', [], null, true],
    ['a rewrite drafted', { kind: 'rewrite', label: 'Rewrite from main', state: 'draft' }, 'Draft · Rewrite from main', 'brand', ['rewrite', 'discard'], null, false],
    ['a plan change', { kind: 'plan', label: 'Plan change', state: 'draft' }, 'Draft · Plan change', 'brand', ['apply_rebuild', 'open_in_plan', 'discard'], null, false],
  ] as const)('%s', (_name, over, title, tone, actions, note, quiet) => {
    const look = wikiChatCardLook(card({ ops: add, ...(over as Partial<WikiChatDraftView>) }));
    expect(look.title).toBe(title);
    expect(look.tone).toBe(tone);
    expect(look.actions).toEqual(actions);
    expect(look.note).toBe(note);
    expect(look.quiet).toBe(quiet);
    expect(look.inReview).toBe(false);
  });

  it('says an applied card whose challenge waits in Review is in Review, amber, its note opening Review — not confirmed', () => {
    const challenge = [{ seq: 0, op: 'challenge' as const, entryId: 'E1', baseRevision: 3, payload: {}, similar: [], tainted: false, entry: null, decision: 'pending' }];
    const look = wikiChatCardLook(card({ state: 'applied', label: 'Challenge entry', ops: challenge }));
    expect(look.title).toBe('Applied · In Review');
    expect(look.title).not.toMatch(/confirmed/iu);
    expect(look.tone).toBe('amber');
    expect(look.note).toBe(WIKI_CHAT_COPY.card.appliedInReviewNote);
    expect(look.inReview).toBe(true);
    expect(look.actions).toEqual(['open_entry']);
    // Answered in Review since: the press stands confirmed.
    const answered = wikiChatCardLook(card({ state: 'applied', label: 'Challenge entry', ops: [{ ...challenge[0]!, decision: 'accepted' }] }));
    expect(answered.title).toBe('Applied · Confirmed by you');
    expect(answered.inReview).toBe(false);
  });

  it('puts what a card is about on its face: the entry’s words, the why, the sources, an amend’s red and green lines', () => {
    const face = wikiChatCardFace(card({
      ops: [{
        seq: 0, op: 'add', entryId: null, baseRevision: null, similar: [], tainted: false, entry: null, decision: null,
        payload: {
          entry: { kind: 'decision', title: 'Runner offline after three missed heartbeats', summary: 'One line.', fields: { decision: 'Three missed heartbeats mark a runner offline.', context: 'x' } },
          sources: [{ kind: 'turn', session: 'self', quote: 'Keep three.' }, { kind: 'commit', ref: '99cd3c4'.padEnd(40, '0'), locator: { path: 'src/apiserver/src/runners/runner-presence.ts', lines: '30-31' } }],
        },
      }],
    }));
    expect(face.heading).toBe('Runner offline after three missed heartbeats');
    expect(face.rows).toEqual([
      { label: 'Decision', value: 'Three missed heartbeats mark a runner offline.' },
      { label: 'Why', value: 'To ride out one gateway restart.' },
    ]);
    expect(face.sources).toEqual(['Your message in this chat', 'src/apiserver/src/runners/runner-presence.ts L30-31 · 99cd3c4']);

    const amend = wikiChatCardFace(card({
      label: 'Amend entry',
      ops: [{
        seq: 0, op: 'amend', entryId: 'E1', baseRevision: 2, similar: [], tainted: false, decision: null,
        entry: { title: 'Why long-poll, not WebSocket', summary: 'The gateway does not support WebSocket.' },
        payload: { changes: { summary: 'The nginx config of the time limited the handshake.' } },
      }],
    }));
    expect(amend.heading).toBe('Why long-poll, not WebSocket');
    expect(amend.diff).toEqual([
      { sign: '-', text: 'The gateway does not support WebSocket.' },
      { sign: '+', text: 'The nginx config of the time limited the handshake.' },
    ]);

    const rewriteCard = wikiChatCardFace(card({ kind: 'rewrite', rewrites: [{ doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', title: 'Turn delivery' }] }));
    expect(rewriteCard.heading).toBe('3.1 §3 Turn delivery');
  });
});

describe('the line under an applied card, for every result (design §8.3)', () => {
  const applied = (over: Partial<NonNullable<WikiChatDraftView['rewrite']>>) => card({ state: 'applied', undoable: true, rewrite: rewrite(over) });
  it.each([
    ['rewriting, before the job named its commit', {}, 'Rewriting 3.1 §3 and 7.1 §2…', 'run', false, []],
    ['rewriting from main', { sha: '7f3e2a1c9b8d' }, 'Rewriting 3.1 §3 and 7.1 §2 from main@7f3e2a1…', 'run', false, []],
    ['held up by maintenance', { result: 'waiting', reason: 'maintenance_running' }, 'Rewrite waiting · Maintenance is running', 'amber', true, []],
    ['held up by a setting the owner fixes', { result: 'waiting', reason: 'no_workspace' }, 'Rewrite waiting · Maintenance has no workspace', 'amber', true, ['settings']],
    [
      'updated',
      {
        result: 'updated',
        sections: [
          { doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', result: 'updated', changed: 1, versionId: 'V1' },
          { doc: 'runner-architecture', key: 'heartbeat', where: '7.1 §2', result: 'same', changed: 0, versionId: null },
        ],
      },
      'Wiki updated · 3.1 §3 — 1 sentence · 7.1 §2 — reads the same',
      'ok',
      false,
      ['see_changes'],
    ],
    [
      'read the same, not seen',
      { result: 'same', sections: [{ doc: 'sessions-runtime', key: 'turn-delivery', where: '3.1 §3', result: 'same', changed: 0, versionId: 'V2' }] },
      '3.1 §3 — reads the same',
      'amber',
      true,
      ['see_changes'],
    ],
    ['failed', { result: 'failed' }, 'Rewrite failed', 'error', true, ['try_again']],
    [
      'gone from the plan',
      { result: 'gone', sections: [{ doc: 'sessions-runtime', key: 'old', where: 'sessions-runtime §old', result: 'gone', changed: null, versionId: null }] },
      'sessions-runtime §old — no longer in the plan',
      'grey',
      false,
      [],
    ],
  ] as const)('%s', (_name, over, line, tone, waits, rewriteActions) => {
    const view = applied(over as Partial<NonNullable<WikiChatDraftView['rewrite']>>);
    const look = wikiChatResultLook(view)!;
    expect(look.line).toBe(line);
    expect(look.tone).toBe(tone);
    expect(look.waits).toBe(waits);
    expect(wikiChatCardLook(view).rewriteActions).toEqual(rewriteActions);
    expect(wikiChatCardLook(view).actions).toEqual(['undo', 'open_entry']);
  });

  it('stops waiting once seen; draws nothing for a card that is not applied; and Settings only for the reasons Settings fixes', () => {
    const settings = (reason: 'no_workspace' | 'runner_missing' | 'runner_offline' | 'maintenance_running') =>
      wikiChatCardLook(card({ state: 'applied', undoable: true, rewrite: rewrite({ result: 'waiting', reason }) })).rewriteActions;
    expect(wikiChatResultLook(card({ state: 'applied', rewrite: rewrite({ result: 'same', seen: true }) }))!.waits).toBe(false);
    expect(wikiChatResultLook(card({ state: 'applied', rewrite: rewrite({ result: 'failed', seen: true }) }))!.waits).toBe(false);
    expect(wikiChatResultLook(card({ state: 'undone', rewrite: rewrite({ result: 'updated' }) }))).toBeNull();
    expect(wikiChatResultLook(card({ state: 'applied', rewrite: null }))).toBeNull();
    expect(settings('no_workspace')).toEqual(['settings']);
    expect(settings('runner_missing')).toEqual(['settings']);
    expect(settings('runner_offline')).toEqual([]);
    expect(settings('maintenance_running')).toEqual([]);
  });

  it('marks a settled rewrite seen once it is opened, and only a settled one not seen yet', () => {
    for (const result of ['updated', 'same', 'failed'] as const) expect(wikiChatNeedsSeen(card({ state: 'applied', rewrite: rewrite({ result }) }))).toBe(true);
    for (const result of ['rewriting', 'waiting', 'gone'] as const) expect(wikiChatNeedsSeen(card({ state: 'applied', rewrite: rewrite({ result }) }))).toBe(false);
    expect(wikiChatNeedsSeen(card({ state: 'applied', rewrite: rewrite({ result: 'same', seen: true }) }))).toBe(false);
  });
});

describe('what a message that did not go says (C8 review)', () => {
  it('says the server’s refusal in its own words, a server failure as one, and asks to check the connection only without a server', () => {
    const worktrees = new ApiError(
      "this space's chats run only in a workspace of the space that runs its sessions in worktrees of their own: a chat never runs in a shared checkout",
      400,
    );
    expect(wikiChatSendError(worktrees)).toBe(
      "Not sent: this space's chats run only in a workspace of the space that runs its sessions in worktrees of their own: a chat never runs in a shared checkout.",
    );
    const closed = new ApiError('The workspace turned its worktrees off: a wiki chat needs one of its own.', 409);
    expect(wikiChatSendError(closed)).toBe('Not sent: The workspace turned its worktrees off: a wiki chat needs one of its own.');
    const context = new ApiError('wikiContext is { page?, selection? }: a page of a document, an entry or the plan', 400, 'WIKI_SCHEMA', {
      errors: [{ path: 'wikiContext.selection.sentenceIds', message: 'is not what a wiki chat message carries here' }],
    });
    expect(wikiChatSendError(context)).toBe(
      'The attachments weren’t taken: wikiContext is { page?, selection? }: a page of a document, an entry or the plan. Remove them and send again.',
    );
    expect(wikiChatSendError(new ApiError('Bad Gateway', 502))).toBe('The server couldn’t take the message (502). Try again in a moment.');
    for (const sentence of [wikiChatSendError(worktrees), wikiChatSendError(closed), wikiChatSendError(context)]) {
      expect(sentence).not.toMatch(/connection/u);
    }
    expect(wikiChatSendError(new TypeError('Failed to fetch'))).toBe(WIKI_CHAT_SEND_FAILED);
    expect(WIKI_CHAT_SEND_FAILED).toMatch(/Check the connection/u);
  });
});

describe('the Wiki’s waiting count, by the contract’s reading (`space.list.chatWaiting`)', () => {
  it('adds a space’s rewrites that wait to its proposals and its plan’s count; a server without them adds none', () => {
    expect(wikiWaitingIn({ pendingOps: 2, planWaiting: 1, chatWaiting: 3 })).toBe(6);
    expect(wikiWaitingIn({ pendingOps: 2, planWaiting: 1 })).toBe(3);
    expect(wikiWaiting([{ pendingOps: 1, planWaiting: 0, chatWaiting: 1 }, { pendingOps: 0, planWaiting: 2, chatWaiting: 2 }])).toBe(6);
  });
});
