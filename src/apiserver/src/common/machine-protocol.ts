import { SetMetadata } from '@nestjs/common';

export const MACHINE_PROTOCOL = 'orbit:machine-protocol';

/**
 * Marks a controller whose ids are KEYS, not addresses — the one surface that keeps UUIDs.
 *
 * `/api/runner/*` is not one thing. Under that prefix sit two populations that happen to share a
 * path and a credential:
 *
 *   - the **machine protocol** (this marker): claim / reclaim / leases / events / finalize /
 *     worktree ops. A runner writes these ids straight into filesystem paths and git ref names
 *     (`refs/orbit-base/<id>`), and alongside them travel the lease and fence tokens that are
 *     compared byte-for-byte. Flipping their spelling is not a formatting change, it is a
 *     re-keying of state that already exists on disk on machines this server does not control.
 *     A runner too old to normalize the spelling would orphan a live session's base ref, and the
 *     failure is the quiet kind: no error, every later diff computed against the wrong commit.
 *
 *   - the **agent-facing API** (unmarked): tasks, task-lists, workspaces, session orchestration,
 *     service tokens. The runner does not key anything by these — `orbit mcp` and the `orbit`
 *     CLI hand the response body through verbatim, as a tool result or on stdout, where the
 *     reader is a model or a person. An id here is an address exactly as it is on the web API,
 *     so it is spelled base62 exactly as it is there.
 *
 * The split has to be per-controller rather than per-path because the two populations overlap in
 * the URL space: `GET runner/sessions/claim` is machine protocol and `GET runner/sessions/:id` is
 * agent-facing, and a prefix test cannot tell them apart.
 */
export const MachineProtocol = () => SetMetadata(MACHINE_PROTOCOL, true);
