# Restricted Docker channel (managed runners, Docker backend)

[channel.py](channel.py) is the only process of a Docker-backend deployment that holds the Docker
socket. The apiserver's Docker backend
([docker-backend.ts](../../../src/apiserver/src/managed-runners/docker-backend.ts)) reaches Docker only
through it: JSON over HTTP on a local unix socket (or a loopback port), with a bearer token. Neither
the apiserver process nor any managed runner container is given `docker.sock`.

It is optional and off by default like the rest of `deploy/managed-runner`: no default entry point
starts it (`scripts/managed-runner/deployment_boundary_test.py`). Wiring it into a new deployment is
task D3's. The design record is
[docs/managed-runner-design.md](../../../docs/managed-runner-design.md), "Implementation record:
Docker backend".

## Why a separate Python process

- **A separate process, not a module of the apiserver.** Access to `docker.sock` is root on the host.
  Keeping it in a process of its own, with a few hundred lines that do nothing else, keeps that
  access out of the large apiserver process and out of every container it manages. The apiserver
  can only ask for the operations below; it cannot pass Docker parameters through.
- **Python 3 standard library only.** No dependency to vendor or audit; it runs from `python3 -I` on
  a Linux host or in a minimal Python image. It sits beside the image entrypoint
  (`deploy/managed-runner/image/entrypoint.py`), and its tests run in the managed-runner Python suite
  (`python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'`) that the project's
  checks already run.

## What it offers

| Request | Answer |
| --- | --- |
| `GET /v1/info` | Its instance, image, network and limits, and the host (CPUs, memory, the disk Docker's volumes live on, what this instance's volumes hold) for the capacity budget. |
| `GET /v1/resources` | Every volume, container and kept credential of this instance (credentials without their token). |
| `PUT /v1/volumes/mr-data-<runner>` | Create the runner's data volume once (`ownerId`, `runnerId`, `limitBytes`); an existing one of this instance is returned as it is. |
| `GET /v1/volumes/mr-data-<runner>` | The volume, if it is this instance's. |
| `DELETE /v1/volumes/mr-data-<runner>?uid=` | Remove it, by its UID, only while no container refers to it. The manager never asks this; it is for an explicit deletion workflow or an operator. |
| `GET /v1/volumes/mr-data-<runner>/holders` | Every container that refers to the volume, in any state, labelled or not (others only counted). |
| `PUT/GET/DELETE /v1/credentials/<runner>` | The runner credential of one generation, kept in the state directory (0700/0600) until its container starts; removed by UID. |
| `POST /v1/containers` | Create the runner's container from the template and start it (create once). `dryRun: true` checks the request only. |
| `GET /v1/containers/mr-<runner>` | Docker's state of it: status, exit code, `FinishedAt`, OOM, and why the channel stopped it, if it did. |
| `POST /v1/containers/mr-<runner>/stop?uid=` | Stop it (SIGTERM, `stopGraceSeconds`, then SIGKILL), by its instance UID. |
| `DELETE /v1/containers/mr-<runner>?uid=` | Remove it, by its instance UID, only once it has stopped; its bootstrap volume goes with it. |
| `GET /v1/fencing-receipts/<runner>` | An operator's receipt for a container that vanished unobserved (below). |

Every request needs `Authorization: Bearer <token>`. Anything else is refused with a stable code.

## The rules it keeps

- **Its own label only.** Everything it creates carries `orbit.managed-runner.instance=<instanceId>`
  (and `orbit.managed-runner.kind`, owner, runner, UID; containers their generation and the volume UID
  they were authorized for). It reads, returns, changes and removes nothing without that label: a
  volume or container of the same name without it is `NOT_MANAGED`, never adopted.
- **The template, and nothing a request can change.** A container request names identities and
  amounts only. Docker parameters — `privileged`, capabilities, binds or mounts, host network, PID,
  IPC or UTS, devices, security options, a user, an environment, labels — are refused by name
  (`PARAMETER_REFUSED`); a volume that is not `mr-data-<runner uuid>` (a host path, the Docker socket)
  is `NAME_REFUSED`; another image is `IMAGE_REFUSED`; amounts above the configured ceilings are
  `LIMIT_REFUSED`. The template: the configured image (by local image ID), user `10001:10001`, every
  capability dropped, `no-new-privileges`, a read-only root filesystem, a private IPC namespace and
  cgroup namespace, CPU (`NanoCpus`), memory (swap not beyond it), PIDs, `/tmp` as a sized tmpfs,
  restart policy `no`, bounded json-file logs, the one configured network, and exactly three mounts:
  the runner's data volume at `/var/lib/orbit`, its bootstrap volume at `/run/orbit-bootstrap`, and
  `/tmp`. The spec is checked against those rules before it is sent, and what Docker made of it is
  inspected and checked again before it starts (`TEMPLATE_VIOLATION`, removed unstarted).
- **One container per data volume.** Creates are serialized per runner; only `mr-<runner uuid>` may
  use a runner's volume (`SINGLE_CONTAINER_GUARD` — the manager's guard probe asks for exactly this
  refusal before every create); a volume any container still refers to is `VOLUME_IN_USE`; an
  earlier generation's container still there is `CONTAINER_CONFLICT`. A stopped container is never
  started again: the next generation is a new container.
- **Credential and identity as read-only files.** The credential of the container's generation is
  written, before the container starts, into its bootstrap volume as `token`, beside `generation` and
  `instance.json` (`runnerId`, `generation`, `instanceUid`): root-owned, mode 0444, in a root-owned
  directory the runner cannot write. The container's environment names the files, never their
  contents; the channel never logs a credential. The instance UID is a canonical UUID the channel
  gives each container, the one the runner door authorizes.
- **Stop proof.** Docker's state of the container — `exited` with its exit code and `FinishedAt`,
  or never started — is the report the manager records as the stop proof; it then removes the
  container by UID, and only once it is gone and nothing refers to the volume does it release
  compute or start the next generation.

## Disk limit

A Docker local volume has no size limit of its own: the `local` driver's `size` option needs project
quotas on the filesystem under Docker's data root (XFS `pquota`), which is host configuration this
backend may not require or change, and loop-mounted images need privileges the channel does not
take. So the limit is measured and enforced at the container, the way the kubelet enforces an
ephemeral-storage limit:

- Each data volume carries its limit (`orbit.managed-runner.disk-limit-bytes`, the profile's
  `storage.capacity`, which is also its storage share of the pool).
- Every `diskCheckSeconds` the channel reads Docker's own measurement of every volume
  (`GET /system/df?type=volume`). The container of a volume over its limit is stopped (SIGTERM, the
  stop grace, SIGKILL) and the reason kept beside it; the manager sees the stop like any other and
  fails the runner retryable, with the reason in its detail.
- No container is created for a volume over its limit (`VOLUME_OVER_LIMIT`), so a retry does not
  start it again until an operator frees space on the volume or raises its limit
  (`volumeLimitOverrides`, by volume name).

The data is kept: nothing is deleted to enforce the limit. Writes between two checks can overshoot
it; `diskCheckSeconds` bounds how long. `/tmp` is a tmpfs counted in the container's memory limit,
and the root filesystem is read-only, so the data volume is the only disk a runner can fill.

## Fencing receipt

On one host Docker reports every stop it makes, so the manager needs an operator's receipt only for a
container that vanished without Docker's report (removed by hand, outside the channel): the mapping
waits in FENCING. After checking the host — no container or process of that instance UID, nothing
holding the volume (`docker ps -a`, `ps`, `fuser -m` on the volume's mount point) — an operator
writes `<stateDir>/fencing/<runner uuid>.json`:

```json
{
  "schemaVersion": 1,
  "kind": "orbit.managed-runner.fencing-receipt",
  "method": "HOST_PROCESS_CHECK",
  "predecessor": { "runnerId": "…", "generation": 3, "podName": "mr-…", "podUid": "…", "nodeName": "…", "pvcUid": "…", "volumeHandle": "docker:…" },
  "action": { "performedBy": "…", "performedAt": "…", "description": "…", "reference": "…" },
  "verification": { "observedBy": "…", "observedAt": "…", "result": "NO_PROCESS_OF_THE_INSTANCE", "evidenceReference": "…" }
}
```

The predecessor's fields are the mapping's recorded ones; a receipt that names anything else is
refused field by field and changes nothing.

## Configuration and running

[channel.example.json](channel.example.json) shows every field. `instanceId` is the deployment's label
value; `image` the managed runner image's local ID (`docker image inspect -f '{{.Id}}' <tag>`), built
from `deploy/managed-runner/image` and never pushed; `network` a dedicated bridge network, created by
whoever deploys it, with `com.docker.network.bridge.enable_icc=false` (the channel warns otherwise)
and the apiserver reachable from it; `limits` the ceilings a request may ask for; `tokenFile` a file
only its owner can read; `stateDir` where credentials, evictions and receipts live.

```bash
python3 -I deploy/managed-runner/docker-channel/channel.py check-config --config /etc/orbit-docker-channel/channel.json
python3 -I deploy/managed-runner/docker-channel/channel.py serve --config /etc/orbit-docker-channel/channel.json
```

The apiserver's profile ([manager-profile.example.json](manager-profile.example.json), `backend:
"docker"`) names the same instance and image, the channel's socket and the token file. At start-up the
channel finishes any container create a previous run left unstarted, then serves; it holds no state a
restart loses beyond what is in `stateDir` and Docker.

Tests: `scripts/managed-runner/docker_channel_test.py` (an in-memory Docker Engine, the real HTTP
server) and, on real Docker, `scripts/managed-runner/docker-backend-it.py`, which runs the apiserver's
`docker-backend.it.ts` against this channel, the real image and a disposable PostgreSQL.
