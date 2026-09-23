/**
 * The gate in front of the artifact route: which absolute paths a session may ask to have fetched,
 * and which it may not. It is the apiserver half of a boundary the runner enforces for real (it
 * reads the file) — but a request that gets past this one is a request to walk a path the client
 * picked, so what it refuses is worth pinning down.
 *
 * The case it exists for is the second and third below: an agent draws its mock inside the session's
 * checkout and links it, and the checkout is where clients now meet paths they cannot read. Before
 * this, only `.orbit/uploads/<session>` was a session's own directory, and the checkout was refused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { resolveLegacyArtifactPath } from './legacy-artifact-path';

const SESSION = '01a0c8ed-3b0b-742c-a7ee-93f0de502852';
const PUBLIC_ID = uuidToBase62(SESSION);

test('a file in the session’s own directories is an artifact', () => {
  for (const [name, raw, wantRoot, wantFile] of [
    ['the uploads scratch', `/root/.orbit/uploads/${SESSION}/drill/out.json`,
      `/root/.orbit/uploads/${SESSION}`, `/root/.orbit/uploads/${SESSION}/drill/out.json`],
    ['the checkout the agent works in', `/root/.orbit/worktrees/${SESSION}/docs/mocks/card.png`,
      `/root/.orbit/worktrees/${SESSION}`, `/root/.orbit/worktrees/${SESSION}/docs/mocks/card.png`],
    // A worktree is created under whichever spelling the claim carried; the request names the
    // session as the row stores it.
    ['a checkout named by public id', `/root/.orbit/worktrees/${PUBLIC_ID}/docs/mocks/card.png`,
      `/root/.orbit/worktrees/${PUBLIC_ID}`, `/root/.orbit/worktrees/${PUBLIC_ID}/docs/mocks/card.png`],
    ['a workspace subdirectory layout', `/home/u/.orbit/worktrees/${SESSION}/sub/dir/x.png`,
      `/home/u/.orbit/worktrees/${SESSION}`, `/home/u/.orbit/worktrees/${SESSION}/sub/dir/x.png`],
    // Percent-encoded on the way in (a markdown link may be), decoded before the checks.
    ['percent-encoded', `/root/.orbit/worktrees/${SESSION}/docs%2Fmocks%2Fcard.png`,
      `/root/.orbit/worktrees/${SESSION}`, `/root/.orbit/worktrees/${SESSION}/docs/mocks/card.png`],
  ] as const) {
    const resolved = resolveLegacyArtifactPath(SESSION, raw);
    assert.ok(resolved, `${name} was refused`);
    assert.equal(resolved.root, wantRoot, `${name}: root`);
    assert.equal(resolved.file, wantFile, `${name}: file`);
  }
});

test('everything else is not', () => {
  for (const [name, raw] of [
    ['another session’s checkout', '/root/.orbit/worktrees/01a0c8ec-f319-7345-9e22-2004b7535e93/docs/mocks/x.png'],
    ['another session’s uploads', '/root/.orbit/uploads/01a0c8ec-f319-7345-9e22-2004b7535e93/x.png'],
    ['the worktrees root itself', '/root/.orbit/worktrees'],
    ['the session dir itself, with nothing under it', `/root/.orbit/worktrees/${SESSION}`],
    ['a directory that only looks like one', `/root/.orbit/worktrees/${SESSION}-other/x.png`],
    ['somewhere else entirely', `/etc/passwd`],
    ['a relative path', `docs/mocks/card.png`],
    ['a traversal', `/root/.orbit/worktrees/${SESSION}/../../etc/passwd`],
    ['nothing at all', ''],
    ['undefined', undefined],
  ] as const) {
    assert.equal(resolveLegacyArtifactPath(SESSION, raw), null, `${name} was accepted`);
  }
});
