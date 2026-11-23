import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAIM_MODEL_LOG_REDACTED, claimModelLogLine } from './claim-model-log';

/**
 * The control plane's half of a claim's model decision, `claim-model {json}`: what the runner
 * reported, what the resolver was offered, and what the runner will be told to run.
 *
 * These pin the two properties the line is FOR (a Google-mode id and an empty resolution must be
 * readable from it — 2026-10-05, the E2E failure was invisible on this side) and the one it must
 * never break: it may carry the fields of the resolution and nothing else, whatever is handed to it.
 */

const SESSION = '11111111-1111-4111-8111-111111111111';
// The seven ids the production runner reported for `antigravity` after a Google sign-in.
const GOOGLE_CATALOG = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-pro',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-oss-120b',
];

function parsed(line: string): Record<string, unknown> {
  assert.match(line, /^claim-model \{.*\}$/);
  return JSON.parse(line.slice('claim-model '.length));
}

test('a Google-mode pick reads back with its catalogue, its offer and its resolution', () => {
  const line = parsed(
    claimModelLogLine({
      sessionId: SESSION,
      provider: 'antigravity',
      requestedModel: 'claude-sonnet-5-5-medium',
      catalog: GOOGLE_CATALOG.map((value) => ({ value })),
      offered: GOOGLE_CATALOG.map((value) => ({ value })),
      resolvedModel: 'claude-sonnet-5-5-medium',
    }),
  );
  assert.deepEqual(line, {
    sessionId: SESSION,
    provider: 'antigravity',
    requestedModel: 'claude-sonnet-5-5-medium',
    catalogCount: 7,
    catalogModels: GOOGLE_CATALOG,
    offered: GOOGLE_CATALOG,
    resolvedModel: 'claude-sonnet-5-5-medium',
  });
});

test('the failure this exists for is legible: a catalogue id dispatched as no model at all', () => {
  // The pre-fix resolution of the same pick: the id was dropped and Antigravity's default is the
  // empty string, so agy is started without `--model`. The line must say both things at once.
  const line = parsed(
    claimModelLogLine({
      sessionId: SESSION,
      provider: 'antigravity',
      requestedModel: 'claude-sonnet-5-5',
      catalog: GOOGLE_CATALOG.map((value) => ({ value })),
      offered: GOOGLE_CATALOG.map((value) => ({ value })),
      resolvedModel: '',
    }),
  );
  assert.equal(line.requestedModel, 'claude-sonnet-5-5');
  assert.equal(line.resolvedModel, '');
  assert.ok((line.catalogModels as string[]).includes('claude-sonnet-5-5'));
  assert.ok((line.offered as string[]).includes('claude-sonnet-5-5'));
});

test('a silent runner is legible too: no catalogue, no offer, inheriting resolution', () => {
  const line = parsed(
    claimModelLogLine({ sessionId: SESSION, provider: 'antigravity', catalog: null, offered: undefined, resolvedModel: '' }),
  );
  assert.deepEqual(line, {
    sessionId: SESSION,
    provider: 'antigravity',
    requestedModel: null,
    catalogCount: 0,
    catalogModels: [],
    offered: [],
    resolvedModel: '',
  });
});

test('the line carries the resolution fields and nothing else it is handed', () => {
  // Nothing but the allow-listed fields has a key on the line, so a caller cannot smuggle a
  // request, an environment or a credential through it even by adding one to the object.
  const line = parsed(
    claimModelLogLine({
      sessionId: SESSION,
      provider: 'antigravity',
      requestedModel: 'claude-sonnet-5-5',
      catalog: [{ value: 'claude-sonnet-5-5' }],
      offered: [{ value: 'claude-sonnet-5-5' }],
      resolvedModel: 'claude-sonnet-5-5',
      ...({ env: { GEMINI_API_KEY: 'sk-live-secret' }, claim: { prompt: 'hi' } } as object),
    }),
  );
  assert.deepEqual(Object.keys(line).sort(), [
    'catalogCount',
    'catalogModels',
    'offered',
    'provider',
    'requestedModel',
    'resolvedModel',
    'sessionId',
  ]);
  assert.ok(!JSON.stringify(line).includes('sk-live-secret'));
});

test('values that are not what their field may hold are redacted, not written', () => {
  const line = parsed(
    claimModelLogLine({
      sessionId: 'not-a-uuid',
      provider: 'not-a-runtime',
      requestedModel: 'user@example.com',
      catalog: [
        { value: 'claude-sonnet-5-5' },
        // The three credential prefixes the project's leak check searches for (auth code, access
        // token, refresh token), each of which fits a model id's character set.
        { value: '4/0AfJohXnExample' },
        { value: 'ya29.a0AfH6SMExample' },
        { value: '1//0gExample' },
        { value: '  ' },
        { value: 42 },
        { label: 'no value at all' },
      ],
      offered: [{ value: 'claude-sonnet-5-5' }],
      resolvedModel: 'bearer abc.def',
    }),
  );
  assert.equal(line.sessionId, CLAIM_MODEL_LOG_REDACTED);
  assert.equal(line.provider, CLAIM_MODEL_LOG_REDACTED);
  assert.equal(line.requestedModel, CLAIM_MODEL_LOG_REDACTED);
  assert.equal(line.resolvedModel, CLAIM_MODEL_LOG_REDACTED);
  assert.equal(line.catalogCount, 7, 'the count is what the runner reported, whatever the rows hold');
  assert.deepEqual(line.catalogModels, [
    'claude-sonnet-5-5',
    CLAIM_MODEL_LOG_REDACTED,
    CLAIM_MODEL_LOG_REDACTED,
    CLAIM_MODEL_LOG_REDACTED,
    CLAIM_MODEL_LOG_REDACTED,
    CLAIM_MODEL_LOG_REDACTED,
    CLAIM_MODEL_LOG_REDACTED,
  ]);
});

test('a runaway catalogue cannot make the line unbounded', () => {
  const line = parsed(
    claimModelLogLine({
      sessionId: SESSION,
      provider: 'antigravity',
      catalog: Array.from({ length: 10_000 }, (_, i) => ({ value: `gemini-${i}-flash` })),
      offered: [],
      resolvedModel: '',
    }),
  );
  assert.equal(line.catalogCount, 10_000);
  assert.equal((line.catalogModels as string[]).length, 64);
});
