import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { WikiEntryDetail } from '../lib/wiki';
import { WikiEntryDrawer, sessionTitle } from './WikiEntryDrawer';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * The entry drawer: what a reader opening one entry gets.
 *
 * The sections and their order are the design's own (mock 03) — Details, Sources, Anchors, Where it's
 * used, History — and Detector is the sixth section that is NOT drawn, because phase 1 has no
 * compliance reading to put in it and an empty one would read as a page that failed to load.
 */

const ENTRY_ID = '0196c000-0000-7000-8000-000000000001';

const DETAIL: WikiEntryDetail = {
  id: ENTRY_ID,
  spaceId: 'space',
  kind: 'pitfall',
  status: 'active',
  trust: 'confirmed',
  currentRevision: 2,
  title: "runner-go's full suite inside a session reaches production",
  summary: 'The tests take the real approval path to the live control plane.',
  fields: {
    trigger: { paths: ['src/runner-go/'], commands: ['go test ./...'] },
    symptom: 'eleven CLI tests fail and one hangs',
    cause: 'the tests read the session’s own ORBIT_* variables',
    fix: 'env -u ORBIT_SESSION_ID go test ./...',
  },
  topics: ['runner-engines'],
  aliases: [],
  anchors: [
    { type: 'path', path: 'src/runner-go/mcp.go', check: { state: 'verified', ref: 'd'.repeat(40), at: '2026-09-25T00:00:00.000Z' } },
  ],
  anchorState: 'verified',
  anchorCheckedRef: 'd'.repeat(40),
  anchorCheckedAt: '2026-09-25T00:00:00.000Z',
  tainted: false,
  challenged: false,
  unsupported: false,
  pinned: true,
  supersedesId: null,
  supersededById: null,
  validFrom: '2026-09-23T00:00:00.000Z',
  validTo: null,
  recordedAt: '2026-09-23T00:00:00.000Z',
  retiredAt: null,
  sources: [
    {
      id: 'source-one',
      kind: 'turn',
      ref: '0196c000-0000-7000-8000-0000000000aa',
      locator: { seq: 4, turnId: '0196c000-0000-7000-8000-0000000000bb' },
      quote: 'POST /runner/sessions/x/approvals -> 403 refused: PROJECT_SCOPE_MISMATCH',
      quoteVerified: true,
      state: 'live',
      tainted: false,
      createdAt: '2026-09-23T00:00:00.000Z',
    },
  ],
  history: [
    {
      id: 'rev-one',
      entryId: ENTRY_ID,
      revision: 1,
      title: 'x',
      summary: 'y',
      fields: {},
      topics: [],
      aliases: [],
      anchors: [],
      contentSha256: 'f'.repeat(64),
      authorKind: 'agent',
      authorUserId: null,
      authorSessionId: '0196c000-0000-7000-8000-0000000000aa',
      authorToolCallId: null,
      changesetOpId: null,
      createdAt: '2026-09-23T00:00:00.000Z',
    },
    {
      id: 'rev-two',
      entryId: ENTRY_ID,
      revision: 2,
      title: 'x',
      summary: 'y',
      fields: {},
      topics: [],
      aliases: [],
      anchors: [],
      contentSha256: 'e'.repeat(64),
      authorKind: 'owner',
      authorUserId: 'user',
      authorSessionId: null,
      authorToolCallId: null,
      changesetOpId: null,
      createdAt: '2026-09-24T00:00:00.000Z',
    },
  ],
  exposure: [
    { sessionId: '0196c000-0000-7000-8000-0000000000cc', entryId: ENTRY_ID, revision: 2, channel: 'push', at: '2026-09-25T00:00:00.000Z' },
  ],
};

function paint(entry: WikiEntryDetail = DETAIL, titles: Record<string, string> = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'entry', ENTRY_ID], entry);
  // What `POST /api/link-previews` answers for the sessions the exposure rows name, under the key the
  // read asks with: one batch of refs, canonicalised.
  const refs = Object.keys(titles).map((id) => `session:${id}`);
  if (refs.length > 0) {
    client.setQueryData(['link-previews', refs], {
      previews: Object.entries(titles).map(([id, title]) => ({
        kind: 'session',
        id,
        state: 'ok',
        session: { id, title },
      })),
    });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WikiEntryDrawer entryId={ENTRY_ID} spaceSlug="orbit" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the entry drawer', () => {
  it('names the kind, the topic and the three badges a reader checks first', () => {
    const html = paint();
    expect(html).toContain('Pitfall');
    expect(html).toContain('runner-engines');
    // The apostrophe arrives escaped in the markup, so the assertion is on the part that does not
    // carry one.
    expect(html).toContain('full suite inside a session reaches production');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Pinned');
  });

  it('draws its five sections in the design’s order, and never draws Detector', () => {
    const html = paint();
    const at = (needle: string) => html.indexOf(needle);
    expect(at('>Details<')).toBeGreaterThan(-1);
    expect(at('>Sources<')).toBeGreaterThan(at('>Details<'));
    expect(at('>Anchors<')).toBeGreaterThan(at('>Sources<'));
    expect(at('Where it&#x27;s used')).toBeGreaterThan(at('>Anchors<'));
    expect(at('>History<')).toBeGreaterThan(at('Where it&#x27;s used'));
    // A phase-1 wiki has no compliance reading, so the section is absent rather than empty.
    expect(html).not.toContain('Detector');
    expect(html).not.toContain('Compliance');
  });

  it('shows a pitfall’s own four fields, and the fix as the thing to run', () => {
    const html = paint();
    expect(html).toContain('Trigger');
    expect(html).toContain('Symptom');
    expect(html).toContain('Cause');
    expect(html).toContain('Fix');
    expect(html).toContain('env -u ORBIT_SESSION_ID go test ./...');
  });

  it('cites the record a claim came from, with the words it took and a tick', () => {
    const html = paint();
    expect(html).toContain('Session');
    expect(html).toContain('POST /runner/sessions/x/approvals -&gt; 403 refused: PROJECT_SCOPE_MISMATCH');
    expect(html).toContain('quote verified ✓');
  });

  it('says where an anchor was checked, and that a re-check follows main', () => {
    const html = paint();
    expect(html).toContain('src/runner-go/mcp.go');
    expect(html).toContain('ddddddd');
    expect(html).toContain('Checked again after every commit to main');
  });

  it('names the session an entry was shown to, from the one batched read', () => {
    const session = '0196c000-0000-7000-8000-0000000000cc';
    const html = paint(DETAIL, { [session]: 'runner-go suite hit prod' });
    expect(html).toContain('runner-go suite hit prod');
    expect(html).not.toContain('Session 0196c000');
  });

  it('falls back to the short id when the answer has no title for a session', () => {
    const html = paint();
    expect(html).toContain('Session 0196c000');
  });

  it('reads a session’s title by either spelling of its id, and says so when there is none', () => {
    const uuid = '0196c000-0000-7000-8000-0000000000cc';
    const titles = new Map([[uuid, 'A named session']]);
    expect(sessionTitle(uuid, titles)).toBe('A named session');
    expect(sessionTitle(uuid, new Map())).toBe('Session 0196c000');
    expect(sessionTitle(null, titles)).toBe('A session without an id');
  });

  it('counts the sessions it was pushed to, and names the revision that is current', () => {
    const html = paint();
    expect(html).toContain('Pushed to 1 session this week · fetched 0×');
    expect(html).toContain('r2');
    expect(html).toContain('r1');
    expect(html).toContain('Confirmed by you');
    expect(html).toContain('Proposed by a session');
    expect(html).toContain('Compare with r1');
  });

  it('offers the owner’s four actions, with Retire the one that takes it from agents', () => {
    const html = paint();
    expect(html).toContain('<span>Edit</span>');
    expect(html).toContain('aria-label="More actions"');
  });
});
