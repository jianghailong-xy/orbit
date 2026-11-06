import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SESSION_SOURCE_PIN_V1 } from '@orbit/shared';

/**
 * SR35: the runner declares source-pin/v1, in the build that implements the handshake. A control plane that still reads
 * the declaration withholds a pinned session from a runner without it; this one hands every runner that speaks the link
 * its sessions, every release that does having the handshake. A wire contract between two codebases that never compile
 * together, so it is asserted across both.
 */

// `build/runner-api` → the repo above the package.
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
  // exactly the rows it cannot drive correctly.
  const runner = read('src/runner-go/source.go') + read('src/runner-go/runloop.go');
  assert.match(runner, /func ensureSourcePinned\(/);
  assert.match(runner, /ensureSourcePinned\(loopCtx, t, job\)/);
});

