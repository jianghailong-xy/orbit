# Orbit Cloud: "new version available" and Update Now

Status: proposed 2026-11-18; the owner chose confirm-and-interrupt for a busy runner and idle rolls on Docker. Server:
the idle path and the busy path are built (2026-11-22); the busy path on Kubernetes too (2026-11-23).
Board: `docs/mocks/managed-runner-update-now/`.

## Why

An Orbit Cloud runner (managed runner) runs a pinned image: the runner and every engine CLI at fixed versions,
self-update off (`ORBIT_NO_SELFUPDATE=1`, `ORBIT_NO_ENGINE_UPDATE=1`). Each Orbit release builds a new image, but a
running container keeps the image it was made from until it is recreated. On the Docker backend that happens only on an
idle sleep and wake, a crash restart, or a silent pre-link runner being stopped (`stopSilentPrevious`). Kubernetes also
rolls an idle runner (`rollPreviousImage`); Docker has no roll (`DockerBackend` has no `rollImage`).

A runner that is never idle never moves. Anything in `managedRunnerWork` counts as work, including a session's
background jobs, an active WHEN schedule or condition, due wakeups and pending merges. On 2026-11-18 the owner's runner
was on `managed-95884b154f` (Nov 16), 599 commits behind the current image. The clients hide every update notice for
Orbit Cloud ("Kept up to date by Orbit"), so the owner could neither see it nor act on it.
`docs/managed-runner-design.md` already records the gap: "a runner that never sleeps keeps the previous image; there
is no administrator command".

## What changes

1. **The status says when the image is old.** `ManagedRunnerStatus` gains
   `update?: { running: ManagedRunnerBuild; current: ManagedRunnerBuild; phase: 'available' | 'updating' }`, where
   `ManagedRunnerBuild` is `{ sha, version?, builtAt? }`. The manager already computes `previousImage` per instance; it
   now keeps the result on the mapping (`imageOutdatedSince`, `currentImageSha`, `currentImageVersion`) so the status
   read needs no backend call.
   - **The running build** comes from the runner's reported `version`: the release version for an image published from
     a release tag (`0.1.261-beta.83`, with an empty `sha`, which the server is not told), or `managed-<sha>` for an
     older image and for a single host's own build.
   - **The current build** is the profile image's `org.opencontainers.image.revision` label, with its
     `org.opencontainers.image.version` label as `version` when it was published from a release tag. The Docker channel
     reports both for the image it serves, and Kubernetes takes them from the profile (`runner.imageRevision`,
     `runner.imageVersion`, which the two-stage deploy writes).
   - **Compared** by version when both sides have one, and otherwise by commit. A runner on the current release has no
     `update`.
   - **When it is absent:** an instance on the current image, or a server that can't tell, has no `update`.
2. **Every client shows the Update card for Orbit Cloud.** Web, iOS/macOS and Android show the card a self-managed
   runner shows (docs/runner-update-drain-design.md), driven by `managed.update` instead of `runner.selfUpdate`.
   - The machine row gets the same "update available" dot.
   - The version line reads `Build 95884b1 · Nov 16`, replacing "Kept up to date by Orbit".
   - Later/postpone is left out. Waiting costs nothing, because the update otherwise happens at the next idle moment.
3. **Update Now is `POST /api/managed-runner/update-now { interruptTurns }`.** It is owner-only, and refused with 409
   `MANAGED_RUNNER_CURRENT` when there is no `update`.
   - **Idle runner** (fresh workload report idle and `managedRunnerWork` empty): the same drain `rollPreviousImage`
     uses, marked `imageRollTo`. It wakes at once on the current image and interrupts nothing.
   - **Busy runner:** refused with 409 `MANAGED_RUNNER_BUSY`, listing the running turns (session id, title, started at)
     and the background-job count, unless `interruptTurns: true`. With it, one transaction records
     `updateRequestedAt`/`updateRequestedBy` and `updateInterruptTurns` on the mapping and a `managed_runner.update_now`
     activity row naming the interrupted sessions. The manager then asks the backend to stop the instance
     (`stopInstance`, as `stopSilentPrevious` does), again on every pass until the host reports the exit. The mapping
     stays READY meanwhile, and nothing is created.
     - Docker sends SIGTERM with the profile's stop grace. The runner's ordinary shutdown gives each turn its drain
       (100 s on Linux), then cuts it, marked `interrupt {reason: runner_restart}`, and the session stays resumable.
       This works on every runner image, the old one included.
     - The host's report of the exit is the stop proof (`terminated`). It spends no attempt and waits out no backoff:
       the next generation is made at once from the current image, on the same volume and runner. A crash of that
       generation is counted as any crash.
     - The cut is stored as the update's (`runner_update`, the runner's reason kept as `reportedReason`) when the
       runner stamped it while the owner's interrupting request was in progress (managed-runner-update-cut.ts). The
       next generation's reclaim then hands the turn back with the same "interrupted by the update" note a
       self-update's continuation opens with, and the clients draw the update's line.
     - **Verified on real Docker** (2026-11-22, `src/apiserver/src/managed-runners/managed-runner-update-now.it.ts`, run
       by `scripts/managed-runner/docker-backend-it.py` with a 240 s stop grace and the runner link): a Claude Code
       turn running a long Bash command was cut 100 s after Update Now, the container exited 0 and was removed before
       the next one was created, and the next generation was READY within 40 s of the exit and resumed the turn by
       itself, which then ended answered. No re-queue from the server is needed. Without the cut marking the
       continuation said "its runner restarted"; with it, it opens with the update's note.
     - **Not so on production's DeepSeek Harness turn** (2026-11-23, Kubernetes). The dsh engine alone cancelled its turn
       at the SIGTERM and reported it INTERRUPTED, with no cut. Its completion was lost as the container exited, so the
       next generation was handed the turn back with the restart's continuation. dsh's own turn ledger then re-sent the
       old settlement instead of prompting, Orbit never acknowledged it, and the session stayed RUNNING with nothing
       running. A second session of the same spawn tree waited behind it, because a two-slot runner gives a tree one
       running session. Three fixes:
       - dsh now drains and cuts like every other engine, and prompts a turn it finds cut, or settled INTERRUPTED by an
         earlier binary, when Orbit hands it back (runner-go dsh_acp.go).
       - The server re-queues as the fallback: a message turn an older runner reports INTERRUPTED while the owner's
         interrupting Update Now has asked its instance to stop is followed by the update's continuation
         (`queueUpdateNowContinuation`), so the session stays RUNNING for the next generation to take it.
       - The stop is recorded on the mapping: `stopRequestedAt` when the manager first asks the backend, and
         `stopAcknowledgedAt` when the host reports the exit. Both stay on the next generation.
   - **Demand never cancels an owner's Update Now,** on either path: on the idle path neither demand nor work recorded
     meanwhile calls its drain off, and the instance's acceptance does not wait for them (`ownerUpdateDrain`). What
     came meanwhile waits for the next generation, which wakes at once. An automatic idle roll is still called off by
     demand, as before.
   - **Kubernetes stops the Pod the same way** (owner's decision, 2026-11-23, after production — which runs on
     Kubernetes — recorded a busy runner's Update Now with `waitsForIdle: true` and never restarted it).
     `KubernetesBackend.stopInstance` deletes the recorded Pod by UID with the termination grace every managed Pod is
     made with (240 s), never shorter and never forced. The kubelet's SIGTERM gives the runner the same shutdown as on
     Docker. The stop proof is the kubelet's terminal report, which the stop-report finalizer keeps on the deleted Pod
     (`podStopConfirmed`). Nothing is made on the claim until that Pod is gone and its volume detached, and a Pod on an
     unreachable node, with no report, proves nothing. No Update Now waits for idle on either backend, so
     `update.waitsForIdle` no longer appears. A request recorded earlier with `waitsForIdle: true` has the same columns
     (`updateInterruptTurns`), so the next pass takes it up and stops the Pod. Only the owner's Update Now stops a Pod
     (`ownerStopsOnly`). An overdue sleep, a disabled owner's drain and a silent previous image are still never forced
     on Kubernetes, as docs/managed-runner-design.md records.
   - **A runner made before the `/home/orbit` volume layout** (an image before 2026-11-17, a944a7f362) has its volume
     in the earlier layout, which the owner chose not to migrate. Recreated on the current image, as Update Now and
     every other recreation does, it starts on an empty home beside the old one (`home/`), so its sign-ins,
     checkouts and engine conversations stay behind. That is open as its own task.
4. **Docker rolls idle runners too.** `DockerBackend.rollImage` is the profile's image, so `rollPreviousImage` runs on
   Docker exactly as on Kubernetes. A runner that goes quiet after a release moves without anyone pressing anything.

## What must hold

- **One writer per volume.** Nothing new starts before the host reports the old container stopped (the existing gate).
  Update Now never removes a container and never skips the stop proof.
- **Data stays.** The data volume (`/home/orbit`), runner row, workspaces and sign-ins are untouched. Only the
  per-generation boot volume is new, as on every wake.
- **Background jobs stop.** Unlike a self-update, which re-execs in place, a new container ends the sessions' background
  jobs and services. The confirmation says so and counts them.
- **A disabled account is never updated.** A FAILED or SLEEPING mapping gets no Update Now: a sleeping runner already
  wakes on the current image.

## Delivery

1. **Server.** The status field, the update-now route, the manager's owner-update step and the Docker `rollImage`.
   Pg specs cover each of these:
   - idle → roll;
   - busy without interrupt → 409;
   - busy with interrupt → stopInstance, then the next generation on the current image;
   - demand while updating → keeps going;
   - disabled → refused.
2. **Docker channel.** It reports the image revision label, with a test in the channel's suite.
3. **Clients.** Web, iOS/macOS and Android: the card, the confirmation, the row indicator and the version line, with
   tests on each.
4. **Rollout check.** Update Now on a production Orbit Cloud runner that has a busy session: it restarts on the current
   image, and the interrupted turn resumes.
