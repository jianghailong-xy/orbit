# New deployments run managed runners; an upgrade keeps them as they were (2026-10-17)

Task D3 (34hJ7RbezzIdkzud1OBz2) of project 34ZteKCnYMpKY46f63Leb: a fresh install switches managed runners on
with the Docker backend, and an existing deployment keeps them as its `.env` has them. The design record is
[docs/managed-runner-design.md](../../../managed-runner-design.md), "Implementation record: new deployments"; the
operator's side is [docs/self-hosting.md](../../../self-hosting.md), "Managed runners".

## Revision 2: the default path (`revision-2/`)

Revision 1 (below) was sent back: its fresh install named T03's image with `--managed-runner-image`, while the
image this branch's own `deploy/managed-runner/image` built still exited at start in a Docker container and carried
no Claude Code. As the coordinator asked, the branch merged T03's tip d856cde9b (`orbit/task-runner-73447c`,
carrying 198f6d6cc, d856cde9b, Claude Code and the apt certificate fix) with `git merge --no-ff`, as e7b149183,
changing none of T03's files. Both hosts were then reset from scratch (the stacks, their databases, every managed
container, volume and network and every built image removed; only base images and the build cache kept) and both
runs repeated at e7b149183, with the kit's [old-install.sh](kit/old-install.sh) no longer echoing generated values.

| Step (UTC) | What happened |
| --- | --- |
| Fresh install (12:01:21–12:24:20) | `scripts/install-server.sh`, no flags: it built the managed runner image from the tip's own `deploy/managed-runner/image`, `orbit-managed-runner:local` = `sha256:b89d6f3f9c440a5e60c0b6a5302bbf5be3156daae19d663332e63e00970f2fd5`, revision label and `tool-versions.json` `sourceSha` e7b149183, with Codex 0.158.0 and Claude Code 2.1.300 ([image-built-by-install.txt](revision-2/fresh/image-built-by-install.txt)); created the ICC-off network; wrote `data/managed-runners` and `.env` (0600, the switch, the directory, the profile); applied the migrations; started all seven services healthy; "managed runners are enabled in orbit-3362a4ba", the channel serving that image ([install.log.gz](revision-2/fresh/install.log.gz), [config-after-install.txt](revision-2/fresh/config-after-install.txt)). No managed container or volume before a sign-in ([inventory-0b-after-install.txt](revision-2/fresh/inventory-0b-after-install.txt)). |
| First account (12:24:46–12:30:20) | `/setup`'s bootstrap: REQUESTED at once, STARTING 12:24:49 (volume, credential, container), the runner ONLINE 12:25:19, MODEL_UNAVAILABLE 12:25:22; an operator signed Codex in with a placeholder key, and the runner was READY and usable at 12:30:20 (`initialProvider` codex), in container `mr-01a149d2-…` on the install's image, its default workspace bound ([status-transitions.jsonl](revision-2/fresh/status-transitions.jsonl), [inventory-1-after-first-login.txt](revision-2/fresh/inventory-1-after-first-login.txt)). |
| Switched off (12:30:50) | `ORBIT_MANAGED_RUNNERS_ENABLED=false`, `docker compose up -d --wait apiserver`: capabilities `enabled: false`; a new account's sign-in NOT_PROVISIONED, its ensure 404; after 45 s still the one row, the first account's volumes kept and its container running ([steps.jsonl](revision-2/fresh/steps.jsonl), [inventory-2-after-switching-off.txt](revision-2/fresh/inventory-2-after-switching-off.txt)). |
| Previous version (12:03:51–12:09:49) | c291f9af6 installed as its README says ([previous-version-install.log.gz](revision-2/upgrade/previous-version-install.log.gz)). Its first `docker compose up -d --build` stopped on "container orbit-apiserver is unhealthy" (the first boot's migrations outlasting the health check on this disk; the README path predates D3), and the wrapper's `docker compose up -d --wait` after the apiserver became healthy brought every service up. Two accounts signed in: NOT_PROVISIONED, capabilities `enabled: false`, no row, no managed resource; `.env` sha256 `d691d1d4…` ([config-1-previous-version.txt](revision-2/upgrade/config-1-previous-version.txt)). |
| `/upgrade` to e7b149183 (12:10:21–12:21:27) | The checkout moved to e7b149183 and its `.claude/skills/upgrade/upgrade.sh` ran: exit 0, "Building images from source (apiserver wiki-worker web)"; apiserver, wiki-worker and web recreated, postgres and gateway left running, pgbackup untouched ([upgrade.log.gz](revision-2/upgrade/upgrade.log.gz)). |
| After the upgrade | `.env` byte for byte as before (`d691d1d4…` both); the apiserver with `ORBIT_MANAGED_RUNNERS_ENABLED=false` and `/dev/null` at its read-only mount; no `data/managed-runners`, no `docker-channel`, no `orbit-managed-runners` network, no channel or managed runner image ([config-2-after-upgrade.txt](revision-2/upgrade/config-2-after-upgrade.txt)). The two accounts and a new third one signed in: NOT_PROVISIONED; the third's ensure 404; no row after 45 s. Volumes, networks and container names as before the upgrade ([inventory-3-after-upgrade-and-sign-ins.txt](revision-2/upgrade/inventory-3-after-upgrade-and-sign-ins.txt), [inventory-diff-upgrade.txt](revision-2/upgrade/inventory-diff-upgrade.txt)). |

## Where it ran

- Two isolated Docker hosts on the HPC machine, `d3-fresh-dind` and `d3-upgrade-dind`: `docker:29.8.2-dind`
  containers, each with its own Docker daemon (29.8.2, Compose v5.6.0) and data root under /mnt/data, capped at
  6 GiB of memory and 8 CPUs, outside the Orbit runner's cgroup, their gateways published on host loopback only
  (127.0.0.1:12086 and 127.0.0.1:13086). Every Orbit container, volume and network of these runs lived inside them
  ([kit/dind-up.sh](kit/dind-up.sh)).
- The host's own Docker gained the pulled `docker:29.8.2-dind` image and those two containers, labelled
  `orbit.test=d3-34hJ7RbezzIdkzud1OBz2`, and nothing else. It runs no Orbit deployment (only other sessions' test
  databases), and neither did anything here touch orbitd.io.
- In revision 1, the managed runner image was built inside the fresh host from T03's branch `orbit/task-runner-73447c` at
  `d856cde9b35b3c91d1b3acbaa34aacebd21fed03`, which carries 198f6d6cc (the instance file a Docker container
  needs): `orbit-managed-runner:t03-d856cde9b` =
  `sha256:7d6bd8f205e93e31591df5f03e84074a58b325787b62ad1a9f7de41074c48b08`, revision label as above, never pushed
  ([fresh/t03-image-build.log.gz](fresh/t03-image-build.log.gz)). The upgrade host got the same image ID by
  `docker save | docker load`.
- No model was used: the runners' Codex was signed in with a placeholder key by an operator, as in D2's run, so
  READY here is not evidence of a real engine session (D4).
- [kit/verify.py](kit/verify.py) drove every step through the deployment's own API (via its gateway) and read
  Docker and PostgreSQL inside the host. Account passwords and tokens stayed out of these files; a scan of every
  file here, the compressed logs included, for the channel tokens, the deployments' secrets, the runner
  credentials and the passwords found none.

## Revision 1, fresh install: the D3 tip at 6f51ce21d with T03's image named (`fresh/`)

| Step (UTC) | What happened |
| --- | --- |
| Install, attempt 1 (10:40–10:48) | At af6047e9c, `scripts/install-server.sh --managed-runner-image orbit-managed-runner:t03-d856cde9b` built everything and failed at `up --wait`: the apiserver's first boot applied 428 migrations past its health check's budget on this disk, so web, gateway and the wiki worker were never started ([install-attempt1-unhealthy.log.gz](fresh/install-attempt1-unhealthy.log.gz)). Fixed by 7342cbbff: the install applies the migrations before starting the stack. The host was reset (stack, database, `.env`, the managed files and the network removed; build cache kept) and the tip cloned again. |
| Install (10:50:15–10:55:08) | Same command at 6f51ce21d: exit 0, all seven services healthy ([install.log.gz](fresh/install.log.gz)). `.env` 0600 with the switch, the directory and the profile; `data/managed-runners` 0700 holding `channel.json` and `profile.json` (`"backend": "docker"`, the image ID, `serverUrl` `http://172.19.0.1:2086`); network `orbit-managed-runners` with `enable_icc=false`, not internal; `docker-channel` with no network, the only Docker socket mount; the apiserver's mount read-only. The apiserver: "managed runners are enabled in orbit-14b77689", and its first channel call `GET /v1/info -> 200` ([config-after-install.txt](fresh/config-after-install.txt)). No managed container or volume before anyone signed in ([inventory-0b-after-install.txt](fresh/inventory-0b-after-install.txt)). |
| First account (10:55:23) | `/setup`'s bootstrap, the first account's sign-in: mapping REQUESTED at once; STARTING at 10:55:26 (data volume, credential and container made); the runner ONLINE at 10:55:56; MODEL_UNAVAILABLE at 10:56:02, no runtime signed in. |
| READY (11:10:57) | The driver's first placeholder sign-in (10:56:02) named the container by the API's public runner id and found none; the driver was corrected to read the name from the mapping. A second sign-in at 11:06:28 found the same mapping. An operator signed Codex in inside the container with a placeholder key at 11:06:29, and the runner became READY and usable (`initialProvider` codex), its default workspace bound to it. The database's one row (`docker`, READY, generation 1) names the one labelled container `mr-01a14980-…` and volume `mr-data-01a14980-…` Docker has ([steps.jsonl](fresh/steps.jsonl), [status-transitions.jsonl](fresh/status-transitions.jsonl), [inventory-1-after-first-login.txt](fresh/inventory-1-after-first-login.txt)). |
| Switched off (11:11:21) | `ORBIT_MANAGED_RUNNERS_ENABLED=false` in `.env` (the one line changed), `docker compose up -d --wait apiserver`: capabilities `enabled: false`. A new account's sign-in: NOT_PROVISIONED, `MANAGED_RUNNER_DISABLED`; its ensure 404 "nothing was written". After 45 s the database still holds the one row, Docker the one container and its two volumes: the first account's data volume is kept, and its running container is not stopped ([inventory-2-after-switching-off.txt](fresh/inventory-2-after-switching-off.txt)). |

| `/upgrade` of this deployment (11:38:20–11:41:35) | Its checkout moved to the final tip's fix 58e46b2d0 and `.claude/skills/upgrade/upgrade.sh` ran with the `managed-runners-docker` profile on in `.env`: exit 0, "Building images from source (apiserver wiki-worker web docker-channel)" — Compose lists the channel mid-list, which the fix reads to the end — the channel rebuilt to the same image and left running, `.env` byte for byte as before (sha256 `ce1c1157…`, the switch still `false` as the administrator left it) ([upgrade-of-new-deployment.log.gz](fresh/upgrade-of-new-deployment.log.gz)). |

## Revision 1, upgrade from the previous version (`upgrade/`)

| Step (UTC) | What happened |
| --- | --- |
| Previous version (11:13:14–11:19:58) | c291f9af6, origin/main before D3, installed as its README says: `cp .env.example .env`, two secrets, `docker compose up -d --build` ([previous-version-install.log.gz](upgrade/previous-version-install.log.gz), the two generated values redacted). The first account (bootstrap) and a second one signed in: NOT_PROVISIONED, `MANAGED_RUNNER_DISABLED`, capabilities `enabled: false`, no row ([inventory-1-previous-version-with-accounts.txt](upgrade/inventory-1-previous-version-with-accounts.txt), [config-1-previous-version.txt](upgrade/config-1-previous-version.txt)). |
| `/upgrade` (11:20:26–11:24:15) | The checkout moved to 6f51ce21d and `.claude/skills/upgrade/upgrade.sh` ran: exit 0, "Building images from source (apiserver wiki-worker web)", apiserver, wiki worker and web recreated, postgres and pgbackup left running ([upgrade.log.gz](upgrade/upgrade.log.gz)). |
| After the upgrade | `.env` byte for byte as before (sha256 `1ce028b2…` both, [env-sha256-before-upgrade.txt](upgrade/env-sha256-before-upgrade.txt), [env-sha256-after-upgrade.txt](upgrade/env-sha256-after-upgrade.txt)). The apiserver runs with `ORBIT_MANAGED_RUNNERS_ENABLED=false` and `/dev/null` at its managed runner mount, read-only; no `data/managed-runners` was made; no `docker-channel`, no `orbit-managed-runners` network, no managed runner image ([config-2-after-upgrade.txt](upgrade/config-2-after-upgrade.txt)). The two accounts and a third, new one signed in: NOT_PROVISIONED; the third's ensure 404; no row after 45 s. Volumes and networks are identical to before the upgrade and the containers have the same names ([inventory-3-after-upgrade-and-sign-ins.txt](upgrade/inventory-3-after-upgrade-and-sign-ins.txt), [inventory-diff-upgrade.txt](upgrade/inventory-diff-upgrade.txt)). |
| Switched on by an administrator (11:26:01–11:32:11) | `scripts/install-server.sh --enable-managed-runners --managed-runner-image orbit-managed-runner:t03-d856cde9b`: exit 0; `.env` gained the three lines and nothing else changed but its mode, now 0600 ([explicit-enable.log](upgrade/explicit-enable.log)); the channel started; the apiserver was recreated from the image it ran (`a4048f8388ea`): "managed runners are enabled in orbit-704aa7f3". The administrator's next sign-in got a runner, READY at 11:32:11 after the same placeholder sign-in ([inventory-4-after-explicit-enable.txt](upgrade/inventory-4-after-explicit-enable.txt)). |

## Not shown here

- A real engine session on a managed runner, and the runner's reach to a model's endpoint: D4.
- The channel's refusals and the containers' limits under attack, backups and failure handling: D5.
- An upgrade does not rebuild the managed runner image: a deployment's runners keep the image both files name
  until an administrator builds another and names it there.
- By hand, `docker compose up -d --build --wait` (the first-run checklist) still applies a new database's
  migrations at the apiserver's first boot, which on a disk this slow outlasts the health check; the install
  script applies them first. This predates D3.
