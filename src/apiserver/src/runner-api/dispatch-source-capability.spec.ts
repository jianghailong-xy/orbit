import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SESSION_SOURCE_PIN_V1 } from '@orbit/shared';
import { runnerSupportsCapability } from './runner-api.controller';
import { SOURCE_PROTOCOL_UNSUPPORTED_ERROR } from './runner-provider-support';

/**
 * SR35: a runner that does not understand SOURCE is REFUSED the session, not sent it to ignore.
 *
 * This is the one compatibility rule in `docs/project-source-contract.md` that has no safe middle.
 * Every other capability negotiates a feature off — an older runner simply gets no orchestration
 * tools, no terminal handoff. This one cannot: a runner handed `ClaimedSession.source` it has never
 * heard of does not fail, it forks from the workDir's HEAD and runs. That is the exact silent
 * baseline the contract exists to remove, and it would be indistinguishable from success.
 *
 * The capability token is therefore a wire contract between two codebases that never compile
 * together, so it is asserted across both. `source-freeze.pg.spec.ts` proves the withholding
 * actually happens against a real database; these prove the two ends agree on the word.
 */

// `build/runner-api` → the package, and the repo above it.
const API_SRC = path.resolve(__dirname, '../../src');
const REPO = path.resolve(__dirname, '../../../..');

const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

test('the Go runner declares the exact token the dispatch gate looks for', () => {
  const transport = read('src/runner-go/transport.go');
  // Declared as a constant AND joined into the header the runner sends on every request. Both
  // halves matter: a constant nobody sends is a capability the server never sees, and neither
  // failure would produce an error anywhere — just sessions that quietly never get dispatched.
  assert.match(
    transport,
    new RegExp(`sessionSourcePinV1\\s*=\\s*"${SESSION_SOURCE_PIN_V1}"`),
    'the runner spells the SOURCE capability differently from @orbit/shared',
  );
  const declaration = transport.slice(transport.indexOf('runnerCapabilitiesV1 = strings.Join'));
  assert.ok(
    declaration.slice(0, 400).includes('sessionSourcePinV1'),
    'the runner defines the SOURCE capability but never puts it in the header it sends',
  );
});

test('the runner only declares it in the same build that implements the handshake', () => {
  // The declaration is a PROMISE: it is what makes the control plane willing to hand this process a
  // session with a pinned baseline. A build that advertised it without pinning would be handed
  // exactly the rows it cannot drive correctly — worse than the old runner, which is at least
  // refused them.
  const runner = read('src/runner-go/source.go') + read('src/runner-go/runloop.go');
  assert.match(runner, /func ensureSourcePinned\(/);
  assert.match(runner, /ensureSourcePinned\(loopCtx, t, job\)/);
});

test('a capability header is matched as a whole item, however it is spelled or split', () => {
  // Runners send one header with a comma list; some HTTP layers split repeated headers into an
  // array. Both shapes have to find the token, and a substring match must not.
  assert.equal(runnerSupportsCapability(`gpu,${SESSION_SOURCE_PIN_V1},shell`, SESSION_SOURCE_PIN_V1), true);
  assert.equal(runnerSupportsCapability(['gpu', ` ${SESSION_SOURCE_PIN_V1.toUpperCase()} `], SESSION_SOURCE_PIN_V1), true);
  assert.equal(runnerSupportsCapability(undefined, SESSION_SOURCE_PIN_V1), false);
  assert.equal(runnerSupportsCapability('source-pin/v2', SESSION_SOURCE_PIN_V1), false);
  assert.equal(runnerSupportsCapability('source-pin', SESSION_SOURCE_PIN_V1), false);
});

test('the claim SQL withholds a resolved SOURCE from a runner that cannot pin it', () => {
  const queue = read('src/apiserver/src/queue/queue.service.ts');
  // The predicate, not merely the variable: what makes this safe is that the ONLY rows an incapable
  // runner may claim are the ones whose source_state is UNBOUND, which is every Legacy session.
  assert.match(
    queue,
    /\$\{supportsSourcePin\}::boolean\s*\n\s*OR s\."source_state" = 'UNBOUND'/,
    'the claim SQL no longer gates on the SOURCE capability',
  );
  // And that the flag reaching it is the negotiated one rather than a default.
  const controller = readFileSync(path.join(API_SRC, 'runner-api/runner-api.controller.ts'), 'utf8');
  assert.match(
    controller,
    /const supportsSourcePin = runnerSupportsCapability\(capabilities, SESSION_SOURCE_PIN_V1\)/,
  );
});

test('the refusal is explained without moving the session out of the queue', () => {
  // §10.1 names SOURCE_PROTOCOL_UNSUPPORTED, and §6.1 refuses to let it settle the state machine:
  // the session stays SELECTED because a newer runner coming online makes it runnable. So the
  // explanation goes on the display column and the state machine is untouched.
  assert.match(SOURCE_PROTOCOL_UNSUPPORTED_ERROR, /^SOURCE_PROTOCOL_UNSUPPORTED:/);
  assert.ok(SOURCE_PROTOCOL_UNSUPPORTED_ERROR.includes(SESSION_SOURCE_PIN_V1));

  const controller = readFileSync(path.join(API_SRC, 'runner-api/runner-api.controller.ts'), 'utf8');
  const marker = controller.slice(
    controller.indexOf('private async markSourceProtocolUnsupported'),
    controller.indexOf('// ── Interactive sessions (Route B) ──'),
  );
  assert.ok(marker.length > 0, 'markSourceProtocolUnsupported is gone');
  // Every WRITE this method makes, as opposed to what it selects on: `sourceState` legitimately
  // appears in the WHERE (that is how it finds the withheld rows), and only the `data` decides what
  // the row becomes.
  const writes = [...marker.matchAll(/\bdata: (\{[^}]*\})/g)].map(([, block]) => block);
  assert.deepEqual(writes, ['{ error: SOURCE_PROTOCOL_UNSUPPORTED_ERROR }']);
  assert.equal(
    marker.includes('sourceRefusalCode'),
    false,
    'the refusal column is welded to REFUSED, and REFUSED is terminal — this session is still queued',
  );
});
