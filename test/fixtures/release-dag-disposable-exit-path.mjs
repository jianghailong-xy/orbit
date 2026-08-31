#!/usr/bin/env node
// Drives the Release DAG's own disposable-resource ownership from a child process, so what is
// under test is the production wiring rather than a copy of it.
//
// Exit-path modes install `guardDisposableResources` and then leave by exactly one of the paths a
// real attempt can take. Probe modes call one function and write its typed document out.
//
// usage: release-dag-disposable-exit-path.mjs BINDING MANIFEST MODE [READY_FILE] [CONTEXT]
//   modes: success | node-failure | uncaught | sigterm
//          cleanup | cleanup-with-unremovable | detect-leak | remediate-leak
import { writeFileSync } from 'node:fs';
import {
  cleanupDisposableResources,
  detectDisposableLeaks,
  dockerAdapter,
  guardDisposableResources,
  remediateDisposableLeaks,
} from '../../scripts/outcome-reconciler-release-dag-disposable.mjs';

const [bindingDigest, documentPath, mode, readyPath = null, contextPath = null] = process.argv
  .slice(2);
const write = (document) => {
  writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
};

// Fault injection: everything reaches real Docker except removal, which always fails. The
// inventory before and after is therefore a real observation of a container that will not go away.
const refusingDocker = (args, options) => (
  args[0] === 'rm'
    ? { status: 1, stdout: '', stderr: 'injected fault: container removal refused' }
    : dockerAdapter(args, options)
);
// A clock an hour ahead, so a container created now is genuinely older than the leak threshold
// without the test having to wait for it.
const anHourFromNow = () => Date.now() + (3_600 * 1_000);

if (mode === 'cleanup') {
  write(cleanupDisposableResources({ bindingDigest, contextPath, reason: 'PROBE' }));
} else if (mode === 'cleanup-with-unremovable') {
  write(cleanupDisposableResources({
    bindingDigest, contextPath, reason: 'PROBE', docker: refusingDocker,
  }));
} else if (mode === 'detect-leak') {
  write(detectDisposableLeaks({ bindingDigest, now: anHourFromNow }));
} else if (mode === 'remediate-leak') {
  write(remediateDisposableLeaks({ bindingDigest, now: anHourFromNow }));
} else {
  guardDisposableResources({ bindingDigest, contextPath, onManifest: write });
  if (mode === 'success') {
    console.log('exit-path: success');
  } else if (mode === 'node-failure') {
    // The path that leaked on 2026-08-31: a failed node exits before the tail of the file.
    console.log('exit-path: node-failure');
    process.exit(1);
  } else if (mode === 'uncaught') {
    setTimeout(() => { throw new Error('exit-path: uncaught node scheduling fault'); }, 1);
  } else if (mode === 'sigterm') {
    setInterval(() => {}, 1_000);
    writeFileSync(readyPath, 'ready\n');
  } else {
    throw new Error(`unknown exit path mode: ${mode}`);
  }
}
