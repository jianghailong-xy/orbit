# Managed runner without a default workspace

**Status:** agreed 2026-11-16 (owner): the managed runner no longer creates a `Default` workspace; the six
unused ones in production go (migration 0930); option A for the setup card (board
`docs/mocks/managed-runner-no-default-workspace`).
This note's rules replace the "Default workspace" and "First session" rows of
`docs/managed-runner-design.md` and the default-workspace parts of C7.

## Today

`createMapping` (`managed-runners/managed-runner.service.ts`) writes the runner row, the mapping and a workspace
named `Default` (`workDir` `/var/lib/orbit/home/orbit-repos/default`) in one transaction. That workspace is:

- `managed_runner.default_workspace_id`: NOT NULL, unique, ON DELETE RESTRICT (migration 0399);
- `workspaceId` in `GET /api/managed-runner`;
- the only workspace where the first-session rules apply: the provider seed (`lastProviderByWorkspace`
  joins on `default_workspace_id`) and the `MODEL_UNAVAILABLE` guard (`assertManagedFirstSessionRuntime`,
  called only for a session sent with that `workspaceId`);
- where a new account lands: web `firstOpenableWorkspace`, Android `MainActivity` managed landing, Swift via
  the agent list; and the managed welcome card plus the "can't start yet" draft block in all three clients.

## Proposal

The managed runner is a machine like any other: it starts with no workspace, and its first workspace is made
the way every machine's is, from the setup card (`docs/first-workspace-contract.md`).

### Server

1. `createMapping` writes the runner row and the mapping only.
2. Migration: `default_workspace_id` becomes nullable; its unique index and foreign key stay, so an existing
   mapping keeps pointing at its workspace. Nothing writes the column again.
3. Migration 0930 lets go of every default workspace nobody used (no session, no task, no project): the mapping
   stops naming it and it is soft-deleted. One that was used stays as an ordinary workspace.
4. The first-session rules key on the **runner**, not the workspace: they apply to a session on the managed
   runner whose owner has no interactive session on that runner yet, whether it is sent with a `workspaceId`
   or makes its workspace (`newWorkspace`). That also closes today's gap where a `newWorkspace` session on the
   managed runner skips the guard.
5. `GET /api/managed-runner` keeps `workspaceId` for older clients and always sends `null`. No client reads it
   after this change.
6. A `newFolder` on a managed runner that has never reported goes in its image's home, `/home/orbit`
   (`MANAGED_RUNNER_HOME`), where every managed image (`create-workdir/v2`) makes it; once it has reported, the
   usual rule (`newFolderRootFor`, its home on a `create-workdir/v2` runner) applies, asleep or not. The folder is made at claim, as for every `newFolder`.

### Clients (web, macOS/iOS, Android)

7. Remove the default-workspace welcome card and draft block (`managedDraftBlocked`, `isManagedDefaultDraft`,
   `ManagedWelcomeDraft`, Android's managed landing).
8. A new account lands on the managed runner's setup card whatever state the runner is in. The runner counts
   as "a machine to set up" while it is preparing, asleep or waking, not only while it is online.
9. On that card (since 2026-11-16 only a folder, a name and Create workspace on every client,
   `docs/mocks/new-folder-in-home/workspace-card-with-name`), while the runner is not up: the notice says it is
   being set up or asleep instead of offline, the folder name is taken unchecked (no directory probe) and sent
   as `newFolder`, and Create workspace works. The workspace's first message queues and wakes the runner, as
   sending to any managed session already does. Frames A–C of board 01 drew an engine step and a picked-folder
   line; main's card dropped both, so they are not built.

Points 8 and 9 change three clients' UI, so each needs a design board under `docs/mocks/` signed off first.

### Image

10. The image makes no `orbit-repos/default` (2026-11-17). The runner's work directory is the repos folder.
    On a volume an earlier image ran on, the entrypoint moves the config and identity marker from
    `orbit-repos/default` to `orbit-repos` and removes that folder while it is still empty
    (`retire_legacy_workdir`); one with anything in it stays.
11. The image makes no `orbit-repos` either (2026-11-23). The runner's work directory is home; the runner makes
    `orbit-repos` itself when it clones the first repository. On a volume an earlier image ran on, the entrypoint
    moves the config and identity marker from `orbit-repos` (or `orbit-repos/default`) to home and leaves
    `orbit-repos` where it is.

## Not changed

The runner row, its data volume and the sleep/wake rules. Workspace deletion: an owner can delete a former
`Default` workspace like any other.
