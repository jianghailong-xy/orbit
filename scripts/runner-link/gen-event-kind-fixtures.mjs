#!/usr/bin/env node
// Writes src/runner-go/testdata/b8-link-events.json: how the apiserver's event ingest reads the events a runner sends
// over the link, as its own code says, for the runner's twin of those rules (src/runner-go/link_events_kind.go):
//
//   - isNoiseSystemEvent (src/apiserver/src/common/system-noise.ts) on every shape of system event a runner emits, and
//     on the edges of its predicate: the noise pings a runner in link mode keeps out of its durable stream;
//   - NON_REPLAYABLE_EVENT_TYPES, MEANINGFUL_SYSTEM_SUBTYPES and PING_KEYS, the lists that predicate and the link's
//     EVENT_LIVE_ONLY refusal read;
//   - COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES, read out of src/apiserver/src/runner-api/runner-api.controller.ts, where it
//     is not exported: the ping-shaped boundaries a runner sends with "provider" added, bare and enriched;
//   - the bare ping that holds the seq of a live event numbered under HTTP mode ({"subtype":"live_event_seq"}).
//
// src/runner-go/link_events_kind_test.go holds the Go side to this file case by case, so a change to the server's set
// or predicate turns it red until the runner follows. Regenerate after changing either side:
//
//   npx tsc -p src/apiserver/tsconfig.json     # or npm run build -w @orbit/apiserver
//   node scripts/runner-link/gen-event-kind-fixtures.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = path.join(repo, 'src/apiserver/dist/common/system-noise.js');
if (!existsSync(compiled)) {
  console.error(`missing ${compiled}: build the apiserver first (npx tsc -p src/apiserver/tsconfig.json)`);
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { isNoiseSystemEvent, NON_REPLAYABLE_EVENT_TYPES, MEANINGFUL_SYSTEM_SUBTYPES, PING_KEYS } = require(compiled);

// The controller does not export the set; its source is what the ingest runs.
const controller = readFileSync(path.join(repo, 'src/apiserver/src/runner-api/runner-api.controller.ts'), 'utf8');
const literal = /const COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES = new Set\(\[([^\]]*)\]\)/.exec(controller);
if (!literal) {
  console.error('COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES is not where it was in runner-api.controller.ts: update this script');
  process.exit(1);
}
const boundarySubtypes = [...literal[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
if (boundarySubtypes.length === 0) {
  console.error('COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES reads as empty: update this script');
  process.exit(1);
}

const system = (name, payload) => ({ name, type: 'system', payload });
const shapes = [
  // What runners emit (claude.go, codex*.go, opencode.go, kimi_acp.go, dsh_*.go, session.go).
  system('claude progress ping: subtype, model and sessionId only', { subtype: 'status', model: null, sessionId: 'sess-1' }),
  system('claude status naming its phase (enginePhase)', { subtype: 'status', model: null, sessionId: 'sess-1', enginePhase: 'compacting' }),
  system('claude thinking-tokens ping', { subtype: 'thinking_tokens', model: 'claude-opus-5-5', sessionId: 'sess-1' }),
  system('init with the runtime session id', { subtype: 'init', sessionId: 'sess-1' }),
  system('init with nothing but its subtype', { subtype: 'init' }),
  system('resumed with nothing but its subtype', { subtype: 'resumed' }),
  system('resumed after a crash', { subtype: 'resumed', attempt: 1 }),
  system('resumed after a config change', { subtype: 'resumed', reason: 'config_changed' }),
  system('engine stderr, no subtype', { stderr: 'No conversation found with session ID x\n' }),
  system('context gauge', { subtype: 'context', contextTokens: 12000, contextWindow: 200000 }),
  system('opencode step start', { subtype: 'step_start', sessionId: 'sess-1' }),
  system('claude compaction boundary with its metadata', { subtype: 'compact_boundary', model: null, sessionId: 'sess-1', compactMetadata: { trigger: 'auto', preTokens: 180000 } }),
  system('claude compaction boundary without metadata', { subtype: 'compact_boundary', model: null, sessionId: 'sess-1' }),
  system('claude compaction summary', { subtype: 'compact_summary', text: 'This session is being continued from a previous conversation' }),
  system('codex app-server compaction, bare', { subtype: 'context_compacted' }),
  system('a shared-checkout notice', { notice: 'files changed outside the session', noticeKind: 'shared-checkout-dirty', paths: ['a.go'] }),
  system('a cursor notice', { noticeKind: 'cursor-plan-mode-left', provider: 'cursor', notice: 'refused' }),
  system('a reload naming its provider', { subtype: 'reload', reason: 'launch_changed', provider: 'dsh' }),
  // The predicate's edges.
  system('an empty payload', {}),
  system('no payload at all', null),
  system('only model', { model: 'm' }),
  system('a subtype that is not a string', { subtype: 7 }),
  system('a null subtype', { subtype: null }),
  system('meaningful subtype among ping keys', { subtype: 'resumed', model: null, sessionId: null }),
  system('one key past the ping keys', { subtype: 'status', model: null, sessionId: 's', x: 1 }),
  // Not system events: never noise.
  { name: 'an assistant reply', type: 'assistant', payload: { text: 'hello' } },
  { name: 'an empty assistant payload', type: 'assistant', payload: {} },
  { name: 'a user turn', type: 'user', payload: { text: 'hi' } },
  { name: 'a text delta', type: 'text_delta', payload: { text: 'he' } },
];
const cases = shapes.map((c) => ({ ...c, noise: isNoiseSystemEvent({ type: c.type, payload: c.payload ?? undefined }) }));

const boundaries = boundarySubtypes.map((subtype) => {
  const bare = { subtype };
  const enriched = { subtype, provider: 'codex' };
  return {
    subtype,
    bare: { payload: bare, noise: isNoiseSystemEvent({ type: 'system', payload: bare }) },
    enriched: { payload: enriched, noise: isNoiseSystemEvent({ type: 'system', payload: enriched }) },
  };
});

const placeholderPayload = { subtype: 'live_event_seq' };
const placeholder = {
  type: 'system',
  payload: placeholderPayload,
  noise: isNoiseSystemEvent({ type: 'system', payload: placeholderPayload }),
  coordinatorBoundary: boundarySubtypes.includes(placeholderPayload.subtype),
};
if (!placeholder.noise || placeholder.coordinatorBoundary) {
  console.error('the live_event_seq placeholder is no longer a bare ping the server ignores: pick another');
  process.exit(1);
}

const out = path.join(repo, 'src/runner-go/testdata/b8-link-events.json');
writeFileSync(out, `${JSON.stringify({
  generatedBy: 'scripts/runner-link/gen-event-kind-fixtures.mjs, with src/apiserver/src/common/system-noise.ts and the '
    + 'COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES of src/apiserver/src/runner-api/runner-api.controller.ts',
  nonReplayableEventTypes: [...NON_REPLAYABLE_EVENT_TYPES],
  meaningfulSystemSubtypes: [...MEANINGFUL_SYSTEM_SUBTYPES].sort(),
  pingKeys: [...PING_KEYS].sort(),
  coordinatorContextBoundarySubtypes: boundarySubtypes,
  liveEventSeqPlaceholder: placeholder,
  cases,
  boundaries,
}, null, 2)}\n`);
console.log(`wrote ${cases.length} cases, ${boundaries.length} boundaries and the placeholder to ${path.relative(repo, out)}`);
for (const c of cases) console.log(`  ${c.noise ? 'noise' : 'kept '} ${c.type} ${JSON.stringify(c.payload)}`);
