# Restricted Docker channel (managed runners, Docker backend)

[channel.py](channel.py) is the only process of a Docker-backend deployment that holds the Docker
socket. The apiserver's Docker backend
([docker-backend.ts](../../../src/apiserver/src/managed-runners/docker-backend.ts)) reaches Docker only
through it: JSON over HTTP on a local unix socket (or a loopback port, or a private address for named
peers: below), with a bearer token. Neither
the apiserver process nor any managed runner container is given `docker.sock`.

Root Compose runs it as the `docker-channel` service, built from [Dockerfile](Dockerfile) (Python's
standard library and this one file), under the `managed-runners-docker` profile: a fresh install
with `--managed-runners` (`scripts/install-server.sh`) switches that profile on in `.env`, and an upgrade never does, so a
deployment installed without it does not run the channel. The design record is
[docs/managed-runner-design.md](../../../docs/managed-runner-design.md), "Implementation record:
Docker backend" and "Implementation record: new deployments"; operating it is in
[docs/self-hosting.md](../../../docs/self-hosting.md), "Managed runners".

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
| `GET /v1/info` | Its instance, image (and its `org.opencontainers.image.revision` label as `imageRevision` and its `org.opencontainers.image.version` label as `imageVersion`, the release it was published for, each null when the image has none or it is empty), network and limits (with `maxContainers` as it applies), whether volume removal is on, and the host (CPUs, memory, the disk Docker's volumes live on, what this instance's volumes hold) for the capacity budget. |
| `GET /v1/resources` | Every volume, container and kept credential of this instance (credentials without their token). |
| `PUT /v1/volumes/mr-data-<runner>` | Create the runner's data volume once (`ownerId`, `runnerId`, `limitBytes`); an existing one of this instance is returned as it is. |
| `GET /v1/volumes/mr-data-<runner>` | The volume, if it is this instance's. |
| `DELETE /v1/volumes/mr-data-<runner>?uid=` | Off unless an operator turns it on (`allowVolumeRemoval`): `403 REMOVAL_REFUSED`, and nothing is looked up. On, it removes the volume by its UID, only while no container refers to it. The manager never asks this. |
| `GET /v1/volumes/mr-data-<runner>/holders` | Every container that refers to the volume, in any state, labelled or not (others only counted). |
| `PUT/GET/DELETE /v1/credentials/<runner>` | The runner credential of one generation, kept in the state directory (0700/0600) until its container starts; removed by UID. |
| `POST /v1/containers` | Create the runner's container from the template and start it (create once), unless this instance already has `maxContainers` containers (`429 CONTAINER_LIMIT`). `dryRun: true` checks the request only. |
| `GET /v1/containers/mr-<runner>` | Docker's state of it: status, exit code, `FinishedAt`, OOM, and why the channel stopped it, if it did; and the image ID it was made from (`image`), which after an upgrade is the previous one until its next container. |
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
  cgroup namespace, CPU (`NanoCpus`), memory (swap not beyond it), PIDs,
  restart policy `no`, bounded json-file logs, the one configured network, and exactly three mounts:
  the runner's data volume at `/home/orbit`, its bootstrap volume at `/run/orbit-bootstrap`, and
  the data volume's executable `.orbit-tmp` subpath at `/tmp`. Docker Engine 26 or later is required. The spec is checked against those rules before it is sent, and what Docker made of it is
  inspected and checked again before it starts (`TEMPLATE_VIOLATION`, removed unstarted).
- **One container per data volume.** Creates are serialized per runner; only `mr-<runner uuid>` may
  use a runner's volume (`SINGLE_CONTAINER_GUARD` — the manager's guard probe asks for exactly this
  refusal before every create); a volume any container still refers to is `VOLUME_IN_USE`; an
  earlier generation's container still there is `CONTAINER_CONFLICT`. A stopped container is never
  started again: the next generation is a new container.
- **A cap on all of them.** No more than `limits.maxContainers` containers of this instance at once,
  in any state, since each holds its volume until it is removed: a create past it is refused
  (`429 CONTAINER_LIMIT`) before anything is made, and the containers already there are not
  touched. Without the setting, the cap is one per CPU and per GiB of the host's memory, whichever
  is fewer (`NCPU` and `MemTotal`, as Docker reports them when the channel starts). That holds
  every runner of a profile that gives each at least one CPU and 1 GiB, more than the manager's
  budget (the host less a quarter) ever starts, and the manager reads the cap in `/v1/info` and
  plans for no more. Its purpose is the token's holder: each container was bounded, their number
  was not.
- **No volume removal, unless an operator turns it on.** The manager never removes a data volume.
  With `allowVolumeRemoval` off (the default), `DELETE /v1/volumes/…` is refused whoever asks;
  the operations runbook says when to turn it on and how to remove a volume.
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
- **A new image.** An upgrade rebuilds the image and restarts the channel on a configuration
  naming its new ID (the `/upgrade` skill; docs/self-hosting.md, "What an upgrade does"). Containers
  made from the previous image stay this instance's, read, stopped and removed by UID as before;
  only the configured image is made or started from then on, so a request naming the previous one
  is `IMAGE_REFUSED`, and a container of it that was made and never started is removed, never
  started, and made again from the current image. A runner's next container waits, as any next
  generation does, until its previous container is gone and nothing refers to the volume.
- **No runner container without the host firewall, where there is one.** A deployment whose
  install firewalled the managed runners' network has `firewall/config.json` beside `channel.json`
  ([the firewall](../firewall/README.md)). There the channel creates or starts a runner container
  only while the firewall service's `firewall/status.json` says its rules are in force: `"enforced"`,
  not past its `validUntil`, from this boot (`bootId`), and for the bridge and gateway the configured
  network has now. Otherwise the create is `503 FIREWALL_NOT_ENFORCED` with the reason, before
  anything is made; the manager waits on it as on `CONTAINER_LIMIT`, spending none of the runner's
  attempts, and a container made and never started is left for the manager. Reads, stops and removals go on regardless, and so does the
  single-container guard's dry run. Without `firewall/config.json` nothing changes.

## Disk limit

The channel reports `volumeLimitMode` in `/v1/info` and logs the mode at startup.

- **Filesystem.** With `volumeFilesystemRoot`, each data volume uses a preallocated ext4 image
  of the requested size. The local driver binds the mounted image's data directory. An out-of-space
  write under `/home/orbit` or `/tmp` returns `ENOSPC`. The channel samples filesystem usage for
  the runner's budget. `host.disk` measures the backing disk and `host.managedVolumeBytes`
  includes the full reservation for each image.
- **Measured.** Without the filesystem root, the channel uses Docker's measurements every
  `diskCheckSeconds`, stops runners whose volumes exceed their limits and refuses over-limit
  starts with `VOLUME_OVER_LIMIT`. The host disk is measured at `diskProbePath`, Docker's data
  root, or the channel's state directory in that order. Root Compose supplies a read-only probe
  volume beside Docker's data volumes.

[The operations runbook](../../../docs/managed-runner-docker-operations.md#filesystem-limits-for-docker-data-volumes)
covers host setup, migration and verification.

## `/tmp` on the data volume

Docker mounts the data volume’s `.orbit-tmp` directory at `/tmp` with `VolumeOptions.Subpath`. Before each
create, the channel makes the directory root-owned with mode 1777 through a temporary container that never
starts. The runner clears it at startup and after the last active session ends. The API still validates
`resources.tmpBytes` against `limits.maxTmpBytes` for compatibility. Both paths share the volume’s capacity.

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

[channel.example.json](channel.example.json) shows every required field. `instanceId` is the deployment's label
value; `image` the managed runner image's local ID (`docker image inspect -f '{{.Id}}' <tag>`), built
from `deploy/managed-runner/image` and never pushed; `network` a dedicated bridge network, created by
whoever deploys it, with `com.docker.network.bridge.enable_icc=false` (the channel warns otherwise)
and the apiserver reachable from it; `limits` the ceilings a request may ask for, and optionally
`maxContainers`; `tokenFile` a file only its owner can read; `stateDir` where credentials, evictions
and receipts live. Optional: `diskProbePath` (above), `allowVolumeRemoval` (`false` unless set),
`volumeLimitOverrides`, `extraLabels`, `socketMode`, `logMaxSize`, `logMaxFiles`.

`listen` is one of:

- `{"unixSocket": "<absolute path>"}` (the example, and Compose's);
- `{"tcp": {"host": "127.0.0.1" or "::1", "port": <port>}}`, a loopback port;
- `{"tcp": {"host": "<one private IPv4 address of this host>", "port": <port>}, "allowPeers": ["<IPv4 address>", ...]}`,
  for an apiserver on another host over a private link (`wg1` in
  [docs/managed-runner-remote-host-design.md](../../../docs/managed-runner-remote-host-design.md), D1):
  for example `{"tcp": {"host": "10.66.0.3", "port": 7300}, "allowPeers": ["10.66.0.1"]}`. The host must be
  in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 100.64.0.0/10; `0.0.0.0`, `::` and public addresses are
  refused, and so is a host other than loopback without a non-empty `allowPeers`. `allowPeers` holds
  private IPv4 addresses (or `127.0.0.1`), written plainly, no ranges. A connection from any other
  source address is closed before a byte of it is read, and logged as one line with that address. A
  loopback listener may name `allowPeers` too; without it, it is unchanged.

Every mode still needs the bearer token on every request; `allowPeers` only narrows who may ask.

```bash
python3 -I deploy/managed-runner/docker-channel/channel.py check-config --config /etc/orbit-docker-channel/channel.json
python3 -I deploy/managed-runner/docker-channel/channel.py serve --config /etc/orbit-docker-channel/channel.json [--disk-probe-path <dir>]
```

The apiserver's profile ([manager-profile.example.json](manager-profile.example.json), `backend:
"docker"`) names the same instance and image, the channel's socket and the token file. At start-up the
channel finishes any container create a previous run left unstarted, then serves; it holds no state a
restart loses beyond what is in `stateDir` and Docker.

In a Compose deployment, `scripts/install-server.sh` writes both files, the token and the network:
`data/managed-runners/` holds `channel.json`, `profile.json` and `token` (the state directory and the
socket are made there too), mounted at `/var/lib/orbit-cloud-runners` in `docker-channel` and,
read-only, in the apiserver; the network is `orbit-cloud-runners`, with inter-container traffic
off, and a runner reaches the apiserver through the gateway's published port at that network's
gateway address. Unless installed with `--no-managed-runner-firewall`, `data/managed-runners/firewall/`
holds the host firewall's configuration and status, which the rule above reads. Each upgrade rebuilds the image and names its new ID in both files, then recreates
the apiserver and, after it, the channel. The probe volume and `--disk-probe-path` are Compose's own
(the service's `command` and third mount), so a deployment gets them with the Compose file, freshly
installed or upgraded, and no file in `data/managed-runners` names them.

Tests: `scripts/managed-runner/docker_channel_test.py` (an in-memory Docker Engine, the real HTTP
server) and, on real Docker, `scripts/managed-runner/docker-backend-it.py`, which runs the apiserver's
`docker-backend.it.ts` against this channel, the real image and a disposable PostgreSQL.
