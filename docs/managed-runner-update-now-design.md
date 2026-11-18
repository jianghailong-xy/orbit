# Orbit Cloud: "new version available" and Update Now

Status: proposed 2026-11-18; the owner chose confirm-and-interrupt for a busy runner and idle rolls on Docker.
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
   `ManagedRunnerBuild` is `{ sha, builtAt? }`. The manager already computes `previousImage` per instance; it now keeps
   the result on the mapping (`imageOutdatedSince`, `currentImageSha`) so the status read needs no backend call.
   - **The running build** comes from the runner's reported `version` (`managed-<sha>`).
   - **The current build** is the profile image's `org.opencontainers.image.revision` label. The Docker channel adds it
     to the image it reports, and Kubernetes takes it from the profile.
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
     and the background-job count, unless `interruptTurns: true`. With it, the mapping records
     `updateRequestedAt`/`updateRequestedBy` and an activity row naming the interrupted sessions. The manager then asks
     the backend to stop the instance (`stopInstance`, as `stopSilentPrevious` does).
     - Docker sends SIGTERM with the profile's stop grace. The runner's ordinary shutdown stops its turns, which stay
       resumable. This works on every runner image, the old one included.
     - The host's report of the exit is the stop proof (`terminated`). The next generation is made from the current
       image on the same volume and runner, and the interrupted turns are resumed with the same "interrupted by the
       update" note a self-update writes.
     - **Not verified yet:** that a SIGTERM stop leaves each turn in a state the next generation resumes by itself.
       The server task checks this on a real container first. If they don't come back, the server re-queues the
       turns it recorded in `updateRequestedAt`'s activity row.
   - **Demand never cancels an owner's Update Now.** An idle roll is still cancelled by demand, as today.
   - **Kubernetes has no `stopInstance`.** There, a busy runner's Update Now waits for idle and the card says so. There
     is no Kubernetes deployment today.
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
