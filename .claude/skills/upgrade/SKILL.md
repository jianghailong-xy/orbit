---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment — rebuild the apiserver and web images from the current source and recreate only the services that changed (apiserver applies DB migrations on boot); an unchanged postgres is left running. Refreshing the postgres/gateway base images is opt-in via --pull-base. With ORBIT_REGISTRY set it is a two-stage release instead: build, boot-check and push here, tagged by commit, then pull and recreate on ORBIT_DEPLOY_HOST, which builds nothing, handing the apiserver and web over without a gap; a rollback deploys an earlier commit (--deploy). From a session on another workspace, production is deployed through SubAgents: orbit-ws04 builds and deploys, then orbit-prod checks the host and moves its checkout to the release. Use whenever someone wants to deploy the latest code, update/upgrade the running containers, bring a Compose deployment up to date, or roll one back.
---

# Upgrade the Orbit stack

Orbit runs as a single Docker Compose stack (`docker-compose.yml` at the repo
root) with `postgres`, `apiserver`, `wiki-worker`, `web`, and `gateway` among its
services. `apiserver` and `web` are built locally from source, and `wiki-worker`
runs the `apiserver` image with another command; `postgres` and `gateway`
(nginx) use pinned upstream images. A routine upgrade rebuilds the locally-built
images and recreates only the services that actually changed — an unchanged
`postgres` is never restarted. Refreshing the upstream base images is opt-in via
`--pull-base`. With `ORBIT_REGISTRY` set, the images are built on one host and run on another: see
[Two-stage release](#two-stage-release).

Database migrations are **not** a separate step — the apiserver container runs
`prisma migrate deploy` on startup (see `src/apiserver/Dockerfile` `CMD`), so
recreating it applies any new migrations against the persisted `orbit_pg`
volume.

## Who runs it

An upgrade is mostly waiting on builds and reading their output, which needs no expensive model. If the
session runs on one, such as an Opus or Fable model, hand the run to DeepSeek V4.1 Flash with Orbit's
`delegate` (`model: "deepseek-flash"`, Orbit's id for DeepSeek V4.1 Flash; `background: true`) instead of running it
yourself. If `delegate` refuses the model (`SUBAGENT_TARGET_CANNOT_RUN`), take another flash model from the list the
refusal prints. Claude Code's Agent tool cannot pick a model outside Claude's, so use `delegate`. On an
inexpensive model, run it yourself as below.

- Settle every choice before you hand it off, since the agent cannot ask the owner: which checkout to run
  from (see [Where to run it](#where-to-run-it)), the exact command and flags the owner asked for, and for a
  two-stage release the commit and the `ORBIT_REGISTRY`/`ORBIT_DEPLOY_HOST` values.
- The brief tells the agent to read this file, run exactly that command, stop and report at the first
  failure without retrying, working around a guard (such as adding `--allow-dirty`) or rolling back, and hand back the
  script's last 30 lines and `docker compose ps` (for a two-stage release, the plan table and the deploy's last lines).
- The brief names the script by absolute path, `<checkout>/.claude/skills/upgrade/upgrade.sh`: the SubAgent
  starts in this session's working directory, which need not be the checkout the deployment runs from.
- A build takes 10 to 15 minutes, so end the turn after delegating: Orbit wakes this session with the result.
  Report it to the owner, and do not run the upgrade yourself as well.

This covers running `upgrade.sh` from this session. From another workspace, production deploys through
`delegate` SubAgents instead (see [Production from another workspace](#production-from-another-workspace)).
Those SubAgents run on their workspaces' own engines, and this session only briefs and waits for them.

## How to use

Run the script of the checkout the deployment runs from (see [Where to run it](#where-to-run-it)). Your
working directory does not matter: it `cd`s to its own repo root.

```bash
.claude/skills/upgrade/upgrade.sh
```

It will, in order:

0. **Refuse to build from a dirty checkout.** The image is built from the working
   tree, not from `HEAD` — `docker compose build` copies whatever is on disk — so
   uncommitted edits ship into production while existing in no commit. That has
   happened here: a hotfix that lived only in this checkout served production for
   hours, invisible to every branch and one clean rebuild away from silently
   reverting. Modified tracked files abort the upgrade; untracked files only warn
   (they are additive, not a silent divergence from HEAD). `--allow-dirty`
   proceeds anyway, loudly.
1. **Pull main first.** On `main` the checkout is fast-forwarded to origin
   (`git pull --ff-only`) before anything is built. Merges also reach origin
   without passing through this checkout (another machine's runner, a GitHub
   merge), and a stale checkout rebuilds an old tree while still reporting
   success. Fast-forward only: a checkout that has diverged from origin stops
   the upgrade before any build; one that is only ahead (a local fast-forward
   not pushed yet) deploys as it is. Off `main` nothing is pulled unless you
   pass `--pull`; `--no-pull` skips the pull.
2. Resolve the checked-out commit as `ORBIT_SOURCE_SHA`, then run
   `docker compose build apiserver wiki-worker web` to rebuild from that exact source
   revision (`wiki-worker` has no build of its own: it runs the `apiserver` image).
   The running `orbit-web` image is tagged `orbit-web:previous-release` and passed
   as `--build-arg PREVIOUS_RELEASE_IMAGE`, so the new web image keeps the runner
   release it replaces at `/dl/previous/` — what a staged rollout holds runners at
   and a rollback returns them to (docs/release-process.md, "Runner rollout and
   rollback"). With no `orbit-web` container running, nothing is kept.
   The runner binaries in the web image are built from the newest `v*` tag behind
   HEAD, unpacked at `.runner-release/`, not from the checkout: runner code ships
   only with a release tag (docs/release-process.md, "Runner binaries come from the
   release tag"). With no such tag, the checkout's own runner is built, with a warning.
3. `docker compose up -d --wait apiserver wiki-worker web gateway` — recreate only the
   services whose image or config changed (the freshly built `apiserver`/`web`,
   `wiki-worker` with the `apiserver` image it runs), and block
   until they pass their healthcheck (apiserver runs migrations on boot).
   `postgres` is left running untouched — it is not in the recreate set. The web gateway
   has been seen to already (see [Runner link](#runner-link)).
4. `docker compose up -d --wait --no-deps apiserver-2 …` — only where
   `docker-compose.override.yml` adds other apiservers (`apiserver-2` and on,
   docs/self-hosting.md, "Several apiservers"), and only once `apiserver` is healthy
   and has applied the migrations, so they find none to apply. They run the
   `apiserver` image, so a new one recreates them.
5. Bring `pgbackup` up to date, last (see [pgbackup](#pgbackup)): `docker compose up -d --wait --no-deps --force-recreate
   pgbackup` if the script it runs is not this checkout's, otherwise the same without
   `--force-recreate`, which recreates it for a change of configuration, such as a new
   mount, and leaves it running if there is none.
6. Print `docker compose ps`.

On a deployment whose `.env` turns on the `managed-runners-docker` profile, steps
2 and 3 also cover managed runners: `docker-channel` is built with the rest, the
managed runner image is rebuilt and named in both of its files, and the apiserver
and then `docker-channel` are recreated after the other services (see Notes).

With `--pull-base` it instead first runs `docker compose pull postgres gateway`
and then a full `docker compose up -d --wait`, so a genuinely new base image is
applied — this is the only path that may recreate (restart) `postgres`. With the
managed runners' profile on, that full recreate leaves out `docker-channel`,
which follows the apiserver as above.

### Flags

- `--no-pull` — skip the pull and deploy the checkout exactly as it is (a
  pinned or offline deploy).
- `--pull` — pull even when the checkout is not on `main` (on `main` it is the
  default).
- `--pull-base` — also refresh the pinned base images (`postgres`, `gateway`)
  and run a full recreate. This is the only path that may restart `postgres`;
  omit it (the default) to leave an unchanged `postgres` running.
- `--no-cache` — rebuild the apiserver/web images (and, with managed runners on,
  the channel's and the managed runner image) without the Docker layer cache (use
  when a dependency change isn't being picked up).
- `--prune` — `docker image prune -f` after a successful upgrade to reclaim
  space from the now-dangling old image layers. In the classic image store that
  includes a previous managed runner image once no container, running or
  stopped, was made from it; Docker never prunes one a container uses.
- `--allow-dirty` — build even though the checkout has uncommitted changes. Use
  when you deliberately want to test an uncommitted change in the deployment, and
  remember the change exists in no commit: the next clean rebuild reverts it.

```bash
.claude/skills/upgrade/upgrade.sh --prune
```

## Runner link

Runners work over the runner link (docs/self-hosting.md, "Runner link"), so the script
brings it up, in the section of the script marked as the same in both copies. What `.env`
says decides what it may do, and no line of `.env` ever changes:

- **No link in it.** It builds `src/link-gateway`, has that image make the link's secrets,
  and appends them to `.env` with `RUNNER_LINK_URL=same-origin`, in one write, unprinted.
- **`RUNNER_LINK_URL=same-origin`.** It rebuilds the gateway, named by the last commit
  under `src/link-gateway`, so that a commit elsewhere recreates nothing.
- **Anything else,** as production's own host name: `.env` is not opened for writing, and
  `link-gateway` and `nats` are neither built nor restarted. An unfinished link gets a
  warning, by name, never by value.

After the images are built and before the apiserver is recreated, it starts `nats` and
`link-gateway`, recreates `nats` if the `src/link-gateway/nats.conf` it runs is not this
checkout's, and the web gateway if the `gateway/nginx.conf` it runs is not this checkout's
(single-file bind mounts Compose does not see change: a moment's break, once per change, for the
runner link's NATS connections or for web traffic and streams), and checks that `/runner-link` reaches the link
gateway. This build's `docker-compose.yml` requires `RUNNER_LINK_SIGNING_KEY`, since it has no
HTTPS work path, so a failure there stops the upgrade before the apiserver is recreated, and
the deployment goes on running the build it has.

A pull that changes this script runs the new one, from the start.

## Where to run it

Run it in the installed checkout, the one the deployment runs from, and never from a worktree. A
deployment's bind mounts are relative (`./data/postgres`, `./data/pg-archive`, `./data/files`), so from
any other directory Compose would bind that directory's empty `./data`: the database, the archive the
off-host mirror reads, and every attachment's bytes.

So the script stops first, before it pulls, builds, tags or recreates anything, if the postgres
container this checkout's Compose names has its `/archive` anywhere else. The refusal names the checkout
to run from and says nothing was changed. With no such container there is no deployment yet, and a first
install goes ahead. A separate deployment on the same Docker passes on its own `/archive` if its containers
have names of their own, set in its `docker-compose.override.yml`: the check goes by the name Compose
renders, so one with the same names cannot be told from that deployment and is refused.

## pgbackup

The backup sidecar needs a step of its own. Compose bind-mounts `scripts/pg-backup.sh` into it
as a single file, so a new checkout replaces the file under a running container, which keeps the
one it started on, and Compose sees no change. The script compares what the container has with
the checkout. `--no-deps` keeps `postgres` out of it, and recreating it cuts short a base backup
in progress, which it takes again as it starts.

A sidecar that is not running is left as it is, and the run says `pgbackup was NOT updated` as its
last lines, with the command to run.

The step is in the script, so it runs once the script on disk has it. A run from an older version
pulls the new script from inside itself and finishes as the old one, reporting success with
`pgbackup` unchanged. Put the new version on disk first and pass `--no-pull`, or run it a second time.

After an upgrade, confirm it took effect:

```bash
# The mount, read-only: prints "/var/lib/orbit/files false".
docker inspect orbit-pgbackup --format '{{range .Mounts}}{{println .Destination .RW}}{{end}}' | grep /var/lib/orbit/files
# The script is this checkout's: prints nothing, and exits 0.
docker exec orbit-pgbackup cat /usr/local/bin/pg-backup.sh | cmp - scripts/pg-backup.sh
# Both copies are named and working: "watching" names <target> and <target>-files, with no ERROR after it.
docker logs orbit-pgbackup 2>&1 | grep -E 'watching|mirrored|ERROR' | tail
# A file from ./data/files reached the target, within a poll (15 minutes) of the sidecar starting. With
# ORBIT_BACKUP_SYNC_TARGET=root@backup-host:/data/backup/orbit-pg-archive:
f="$(find data/files -type f -not -path 'data/files/tmp/*' | tail -1)"
ssh root@backup-host ls -l "/data/backup/orbit-pg-archive-files/${f#data/files/}"
```

With no `ORBIT_BACKUP_SYNC_TARGET`, or with `ORBIT_DRIVE_BACKEND=s3`, the last two have nothing to
show: see the [backup and restore runbook](../../../docs/postgres-backup-restore.md#attachment-files).

## Two-stage release

With `ORBIT_REGISTRY` set, the upgrade builds on this host and deploys on another, which runs the
deployment and builds nothing. Orbit's production builds on wikova, pushes to the WireGuard-only
registry `10.66.0.1:5000`, and runs on `10.66.0.4`. Without `ORBIT_REGISTRY` nothing in this section
applies, and the script does exactly what the sections above say.

```bash
# Build and check here, push, then deploy on the target: the usual upgrade.
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .claude/skills/upgrade/upgrade.sh --prune
# Build, check and push only: the release is in the registry, and nothing runs it yet.
ORBIT_REGISTRY=10.66.0.1:5000 .claude/skills/upgrade/upgrade.sh --build-only
# Deploy a release that is in the registry already, building nothing. A rollback is this, with an earlier commit.
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .claude/skills/upgrade/upgrade.sh --deploy <40-character commit>
# What that deploy would change on the target, changing nothing there.
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .claude/skills/upgrade/upgrade.sh --plan <40-character commit>
# A release whose migration the running release's code cannot run against: stop, then start (below).
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .claude/skills/upgrade/upgrade.sh --deploy <40-character commit> --stop-then-start
```

`ORBIT_DEPLOY_DIR` is the deployment's directory on the target, `/root/orbit` unless it is set. The script
still takes this host's lock, refuses a dirty checkout and pulls `main` first (`--deploy` and `--plan` pull
nothing unless `--pull` is given); then `deploy/two-stage/release.sh` takes over, and nothing else in the script
runs: this host's own containers, `.env` and runner link are left as they are.

**Build stage, on this host.** A release is named by the commit it was built from:
`<registry>/orbit-apiserver:<commit>`, which `wiki-worker` runs too, `<registry>/orbit-web:<commit>`, and
`<registry>/orbit-link-gateway:<commit>`, where that commit is the last one under `src/link-gateway`, its
whole build context, so that a release which does not change the gateway recreates nothing. A tag names one
build: one that is in the registry already is kept and never pushed again (to rebuild it, delete it from the
registry first).

The hosted runners' image is **not** built here. It is `<registry>/orbit-cloud-runner:<version>`, published from a
release tag when /release creates it (`deploy/two-stage/publish-managed-runner.sh <tag>`, below), and its runner
reports that version. A release uses the image of the newest `v*` tag at or behind its commit, so a deploy between
two releases moves no hosted runner. Where that image is not in the registry, a release stops before its build and a
deploy or plan before it changes anything, naming the command that publishes it. A commit without
`deploy/managed-runner/image`, with no release tag behind it, or whose newest tag predates release-built images (its
Dockerfile takes no `ORBIT_RELEASE_VERSION`) names none: the deploy says so and leaves the hosted runners' profile as it
is. For each other image that is not there yet:

0. Room first. A build needs `ORBIT_BUILD_MIN_FREE_GB` (15 unless set) free on the disk that holds Docker's data.
   Below that, before anything is built, it removes this registry's earlier release images on this host
   (`<registry>/orbit-*:<tag>` but this release's own: each is in the registry, which a deploy and a rollback
   pull from, and one a container uses is kept), then prunes dangling images, then build cache older than a
   week, then all build cache, re-checking after each and stopping at the first that is enough. Still short, it
   stops before building and prints `docker system df`: what fills the disk is then not Docker's to clear.
1. `docker compose build apiserver wiki-worker web`, under those names. This checkout's `.env` supplies the
   build arguments (`PUBLIC_ORIGIN`, and `COMPOSE_FILE` where it adds the macOS signing file), so they have to
   be the target's. The web image keeps the runner release the target's `web` serves at `/dl/previous/`, as
   on a single host: that image, pulled if this host lacks it, is tagged `orbit-web:previous-release` and
   passed as `PREVIOUS_RELEASE_IMAGE`. Before the target serves any, this host's own `orbit-web` is.
2. `scripts/image-boot-check.sh` boots the apiserver and web images, as CI does, before either is pushed.
3. The link gateway: `docker build --provenance=false`, as a single host builds it.
4. `docker push` of each.

**Publishing the hosted runners' image of a release tag**, on this host (/release does it right after it pushes the
tag; docs/release-process.md, "Orbit Cloud runner image comes from the release tag"):

```bash
ORBIT_REGISTRY=10.66.0.1:5000 deploy/two-stage/publish-managed-runner.sh v0.1.261-beta.83
```

It fetches the tag from origin if this checkout lacks it, checks that the tag's `package.json` names that version, and
skips a tag whose image is in the registry already. Otherwise it builds `deploy/managed-runner/image/Dockerfile` from
the tag's commit (`git archive`, never the working tree; the checkout is not moved) with `ORBIT_SOURCE_SHA` the tag's
commit and `ORBIT_RELEASE_VERSION` the version, checks the image's `org.opencontainers.image.revision` and
`org.opencontainers.image.version` labels and the version its runner reports, and pushes it. The image is about 4.4 GiB
and takes several minutes the first time. `--no-cache` applies to the build.

**Deploy stage, on the target, driven from here over ssh.** The deploy stage needs no checkout and no runner on the
target, and reads neither: `10.66.0.4` has both, for orbit-prod (see
[Production from another workspace](#production-from-another-workspace)). The
build host ships it what the deployment's Compose reads from its directory, taken from the release's commit
with `git archive`, never from the working tree: `docker-compose.yml`, `gateway/`,
`scripts/pg-archive-wal.sh`, `scripts/pg-backup.sh`, `src/link-gateway/nats.conf`, `deploy/runner-link/`, and
the two Compose files a target lists beside `docker-compose.yml`, `deploy/postgres-pinned.yml` and
`deploy/db-proxy.yml`, with `deploy/db-proxy/`, and the monitoring profile's config, `deploy/monitoring/` and
`scripts/pg-monitor-role.sh`. They are staged under `.upgrade/release-<commit>/` there, beside
`deploy/two-stage/deploy-stage.sh`, which then, on the target:

1. takes the target's upgrade lock, `/tmp/orbit-upgrade.lock`, as a single host's upgrade takes its own: one
   upgrade at a time, a second refused at once, a lock whose holder is gone taken over;
2. stops, having changed nothing, where the target has no `.env`, where its `.env` switches on managed
   runners on Docker (the `managed-runners-docker` profile: their images are built where they run), or where a `postgres` of the name this release renders
   keeps its `/archive` in another directory;
3. puts the release's files in place, each whole by a rename, keeping the ones they replace until the
   release's images are all there: a deploy that stops before then puts them back, and takes away the files
   and directories it added, having changed nothing;
4. prints the plan: each service's `docker compose config --hash` for this release against the hash its
   container was made with, as `create`, `unchanged`, `start` or `recreate`. `db-proxy`, `nats`, `gateway`
   and `pgbackup` each bind-mount one file on its own (`deploy/db-proxy/haproxy.cfg`,
   `src/link-gateway/nats.conf`, `gateway/nginx.conf`, `scripts/pg-backup.sh`), which a running container keeps from its start whatever Compose sees, so one that
   runs another than the release's is `recreate` too, and says which file. Under the table it says how the
   apiserver and web are replaced: `Replacing the apiserver and web: without a gap`, or `stop, then start` with
   the reason ([Without a gap](#without-a-gap), below). Where the target runs managed runners on Kubernetes (its
   `.env` sets `ORBIT_MANAGED_RUNNERS_ENABLED=true`, and `profile.json` in `ORBIT_MANAGED_RUNNERS_DIR` says
   `"backend": "kubernetes"`), it also prints the hosted runners' image: `unchanged`, or the profile's
   `runner.image` and the release's image by digest, `<registry>/orbit-cloud-runner@sha256:<64 hex>`, then an
   `imageRevision` line: `unchanged`, or the profile's `runner.imageRevision` (`(none)` if missing) and the release
   tag's commit, which the image was built from (`ORBIT_SOURCE_SHA`), and an `imageVersion` line the same way for
   `runner.imageVersion` and the release version its runner reports;
5. stops, having changed nothing, if an image the release runs does not come from the registry: `postgres` and
   `pgbackup` have theirs only from `deploy/postgres-pinned.yml`, so a target whose `COMPOSE_FILE` does not
   list it is refused. `--plan` stops here in any case, with every file put back;
6. pulls every image the release runs, and stops if one is missing;
7. writes the release's names into `.env` (below), and, where the plan printed a new hosted runners' image, sets
   the profile's `runner.image` to it, `runner.imageRevision` to the tag's commit and `runner.imageVersion` to the
   release version, in the same rename, keeping the profile it replaces beside it as
   `profile.json.bak-<time>-before-<commit>`. Kubernetes learns a runner's target build only from
   `runner.imageRevision` and `runner.imageVersion`, and offers Update Now only with them. An unchanged image whose
   revision or version is missing or different gets it written the same way (a backfill); with all three right
   nothing is written. The apiserver reads the profile only as it starts, so one the release does not otherwise
   replace is replaced for any write. Once it runs, its manager moves each hosted runner onto the new
   image as soon as that runner is idle: drained like a sleep, and woken at once as the next generation, on the same
   volume (`rollPreviousImage` in `src/apiserver/src/managed-runners/managed-runner-manager.ts`). A busy runner moves
   later, and nothing in flight is cut short;
8. brings each service up on its own, `docker compose up -d --wait --no-deps --no-build <service>`, in the
   order `depends_on` gives: `postgres` only when it is new or not running (a running one whose configuration
   the release changes is left running, and the run says so, unless `--pull-base`), `db-proxy` where the
   target lists `deploy/db-proxy.yml` (recreating it ends every database connection once, and the apiserver
   reconnects on its own), `nats`, `apiserver`, which applies the database migrations as it starts,
   `apiserver-2` and on, `wiki-worker`, `web`, `link-gateway`, `gateway`, and `pgbackup`, as on a single host,
   but created where the target has never run one. `up` recreates only what changed, and `--force-recreate`
   what the plan found running another file. The `apiserver` and `web` it recreates are handed over without a
   gap, and a `gateway` it recreates then goes first, ahead of the `apiserver` ([Without a gap](#without-a-gap));
   `wiki-worker`, which serves no HTTP, is simply recreated;
9. prints `docker compose ps`, and adds the release to `.upgrade/history`. Its whole output is in
   `.upgrade/deploy.log`;
10. removes the target's earlier release images: every `<registry>/orbit-apiserver`, `orbit-web` and
   `orbit-link-gateway` image except those of the last 3 releases in `.upgrade/history`, and any a container still
   uses, which Docker refuses to remove. Nothing else removed them: on 2026-11-18 production had kept 77 releases'
   images, 137 GB, with 6.6 GB of its disk left. This runs on every deploy, `--prune` or not; `--prune` still
   prunes dangling images as well.

A lost ssh connection does not stop it halfway: it ignores the hangup and goes on, writing its log.

**Plan.** `--plan <commit>` runs the deploy stage up to step 5 and stops there: it prints the plan of deploying
that release, from the target's own `.env` and files, and leaves the target as it found it. No image is pulled,
nothing is written to `.env` or brought up, and every file it put in place to render the release is put back with
its bytes, mode and modification time. As in a deploy, the files move by rename, so each comes back as a new file:
a running container that bind-mounts one keeps the one it started on, which has the same bytes. It holds the
target's lock for the few seconds it reads, and adds its output to `.upgrade/deploy.log` there. Run it before a
deploy or a rollback whose effect on a running `postgres` or `db-proxy` matters.

**What the target keeps.** Its `.env` is its own: its secrets and settings, which no deploy ships or copies
back. Make it once, before the first deploy; for the move to `10.66.0.4`, a copy of the build host's
(`install -m 600`), changed where the two differ, and with the lines `10.66.0.4` has already: its
`COMPOSE_FILE=docker-compose.yml:deploy/postgres-pinned.yml:deploy/db-proxy.yml`, its `ORBIT_REGISTRY` and its
pgbackup's `ORBIT_BACKUP_*` (docs/postgres-standby.md). A deploy writes only the block between
`# >>> The release this host runs` and `# <<< The release this host runs` at its end: `ORBIT_REGISTRY`,
`ORBIT_IMAGE_TAG`, `ORBIT_LINK_GATEWAY_TAG`, `ORBIT_NGINX_IMAGE`, `ORBIT_NATS_IMAGE` and the monitoring profile's six
images, `ORBIT_PROMETHEUS_IMAGE` to `ORBIT_ALLOY_IMAGE` (docs/configuration.md,
"Images and the two-stage release"). It replaces the whole file by a rename, every other line as it was, so that
any later `docker compose` there renders the release that runs, and never builds anything. `COMPOSE_FILE` lists
`docker-compose.yml` and `deploy/postgres-pinned.yml` on every target, and `deploy/db-proxy.yml` where the
apiserver connects through the proxy; each release ships its own copy of those. Any other Compose file the
target has, `docker-compose.override.yml` or another that `COMPOSE_FILE` lists, stays as it is and is rendered
with each release; a service it adds is left as it is. Its `./data` stays where it is.

**Base images.** Each runs by digest, pulled from the registry, which holds them under Docker Hub's own path,
`library/<name>`. `postgres` and `pgbackup` run PostgreSQL 16.14 as `deploy/postgres-pinned.yml` pins it, never
the floating `16-alpine` tag, which has moved on, and `db-proxy` the HAProxy `deploy/db-proxy.yml` pins; the
release's `deploy/two-stage/base-images.env` pins `gateway` (nginx), `nats` and the monitoring profile's Prometheus,
node-exporter, postgres-exporter, Grafana, Loki and Alloy (their paths in the registry are Docker Hub's, such as `prom/prometheus`). Each pin is in one file only,
and changes in a commit, so a release and its rollback both name the base images they ran with. A new digest has
to be copied to the registry, as `base-images.env` says, before a release names it.

**Rollback.** Deploy an earlier release: `upgrade.sh --deploy <its commit>`, with the same
`ORBIT_REGISTRY` and `ORBIT_DEPLOY_HOST`; `--plan <its commit>` first shows what it changes. Its images are in
the registry (the target keeps only the last 3 releases' images, so an older one is pulled again), its files come from its commit, nothing is built, and `up` recreates what differs from it. Its hosted
runners' image is its own too: the profile names it again, and the runners move back onto it once idle. The
target's `.upgrade/history` lists the releases it ran, newest last. The database keeps the migrations a later
release applied: roll back past a migration only to code that runs on the database as that migration left it.

**Requirements.** Both hosts' Docker trust the registry. One served over plain HTTP, as `10.66.0.1:5000` is,
is listed in each host's `/etc/docker/daemon.json` under `insecure-registries`, which
`systemctl reload docker` applies without stopping a container; the build stage checks this host's before it
builds. Where the target runs managed runners on Kubernetes, the node pulls the hosted runners' image from the
registry too: k3s on `10.66.0.3` lists `10.66.0.1:5000` as a plain-HTTP mirror in
`/etc/rancher/k3s/registries.yaml` (docs/managed-runner-k3s-xfs-deployment.md, "Runner image"). Without it a woken
runner's Pod ends in `ImagePullBackOff`. This host reaches the target as root over `ssh` with a key, and has `git`, `curl` and
`docker manifest`; the target has Docker with Compose v2, and GNU `tar` and `tee`. `--no-cache` applies to
the build, `--prune` to both hosts, and `--pull-base` and `--stop-then-start` to the deploy, as above. To
confirm that the target built nothing, `docker buildx du` there reports no build cache, and `docker image ls`
lists only the registry's images.

### Without a gap

A two-stage deploy replaces the `apiserver` and `web` it recreates without a gap: the web gateway always has
one that answers. For each, `<name>` being the running container (`orbit-apiserver`, `orbit-web`):

1. `<name>-next`, a container of the release, starts beside `<name>`: `docker compose run --no-deps`, so with
   the service's whole configuration from the release. The deploy waits until it passes its health check. The
   apiserver's applies the database migrations as it starts, while `<name>` runs on, and answers to the
   apiserver's names in the project's network too (`apiserver`, `orbit-apiservers`), so that the link gateway
   reaches it. web's answers to its own name only.
2. The web gateway is pointed at it. `gateway/nginx.conf`'s routes to the apiserver and to web include a file
   from `/etc/nginx/handover/` after the line that names their upstream. The deploy writes
   `set $apiserver <name>-next:3000;` there (or `set $web <name>-next:80;`), inside the running gateway, checks
   the configuration (`nginx -t`) and reloads. nginx starts new workers, which take every new connection, and
   lets the old ones finish what they are serving. Nothing is mounted there, so a gateway always starts on its
   own file's routes.
3. `<name>` stops by itself. An apiserver ends its streams, answers what is in flight and exits 0, within 25 s
   (`src/apiserver/src/common/graceful-stop.ts`); the log says how long each stop took and its exit code. `up`
   recreates it from the release and waits for its health check.
4. The gateway is pointed at the new `<name>`, the apiserver by its container's name until `-next` is gone, and
   `<name>-next` stops and is removed. The file goes, and the gateway runs on its own file's routes again.

`wiki-worker` serves no HTTP and is simply recreated, after the apiserver. A `gateway` the release recreates,
for a new `gateway/nginx.conf` or nginx image, goes first, ahead of the apiserver, so that the gateway doing the
handover runs the release's `gateway/nginx.conf`. Recreating the gateway, like `db-proxy`, `nats` or
`link-gateway`, is a moment's break of its own, which a release that changes none of them does not have.

**Streams.** The session and control-plane streams an apiserver carries end when it stops, cleanly. Each client
opens its stream again through the gateway, on the apiserver that answers now, from the last stored event it had:
the web app does so after 2 to 2.5 s. In a release they end twice, once as `<name>` stops and once as
`<name>-next` does. A reload closes the gateway's idle keep-alive connections, as every nginx reload does, and a
client sends its next request on a new one. One it sends at the very moment its connection closes is reset, as
on any keep-alive connection a server closes (on 10.66.0.4, 2 of 7,852 requests at 200 a second over 160
reloads; a release reloads the gateway five times).

**Which way the plan says.** The plan's line under its table is `Replacing the apiserver and web: without a
gap`, or `stop, then start` with the reason, one of these:

- `--stop-then-start`, given for a release whose migration the running release's code cannot run against (below);
- a release whose `gateway/nginx.conf` is from before handovers, with no route a deploy can point, as a rollback
  to one is;
- no web gateway running on the target, as before its first deploy.

Stop, then start is how every release replaced them before: each running one stops before its replacement
starts, and the web gateway answers 502 until the new one is healthy, 20 to 40 s for the apiserver.

**Migrations: the exception.** While a release is handed over, the running release's code runs against the
database as the new release's migrations leave it: the apiserver from the moment `<name>-next` has applied them
until `<name>` stops, and `wiki-worker` until it is recreated. A release with a migration that code cannot run
against is deployed with `--stop-then-start`, which stops that code before the migration runs: one that drops or
renames a table or a column the running release reads or writes, adds a `NOT NULL` column without a default
where it inserts rows, or adds a constraint or a trigger that its writes break. An additive migration, such as a
new table, a column with a default or an index, needs nothing. To see what a release adds, compare it with the
commit the target runs, the last line of `.upgrade/history` there:

```bash
git diff --stat <the commit the target runs> <the release's commit> -- src/apiserver/prisma/migrations/
```

A rollback is the same in reverse, under the rule in **Rollback** above: the code rolled back to runs against the
database as the later release left it, during the handover and after.

**A deploy that does not finish.** One that stops after it started `<name>-next`, or a host that goes down during
one, can leave `<name>-next` running and the gateway sending to it. The plan names one it finds, and the next
deploy points the gateway back at `<name>` and removes `<name>-next` once `<name>` is healthy. If `<name>` is
not healthy, `<name>-next` may be all that serves: the deploy stops and says to deploy with `--stop-then-start`,
which brings `<name>` up first. A `<name>-next` that has not passed its health check is never stopped, since it
may be applying the migrations, which stopping it would cut short: the deploy stops before the gateway is pointed
at it, and `<name>` runs on.

## Production from another workspace

Orbit's production spans two workspaces, each with its own git checkout of this repository at `/root/orbit`:

- **orbit-ws04** is wikova, the build host. Other sessions share its `/root/orbit`, so a release is never built there
  and nothing is checked out or merged in it. Each release is built and driven from a fresh detached worktree of it,
  `/dev/shm/wkdir-release-main-<first 9 characters of the commit>`. That worktree gets the small build-only `.env`
  (`PUBLIC_ORIGIN`, `JWT_SECRET`, `PROVIDER_SECRET_KEY`, `RUNNER_LINK_SIGNING_KEY`), copied from the newest earlier one.
- **orbit-prod** is `10.66.0.4`, where the release runs. Its `/root/orbit` is the deploy directory. It is also a git
  checkout, detached at the commit production runs, so that a SubAgent can run there. The deploy stage does not read
  it as a checkout: it ships the release's files from orbit-ws04, and nothing is built on `10.66.0.4`. Its
  `.git/info/exclude` keeps the host's own files out of git: `.env*` (the secrets and their backups), `.upgrade/` and
  `docker-compose.override.yml`. `data/` is in `.gitignore`.

A session on another workspace, such as orbit-develop on HPC or orbit-macos, runs nothing locally, because its checkout
deploys nothing. It coordinates the two through cross-workspace SubAgents (docs/subagent-design.md §10): orbit-ws04
builds and deploys, then orbit-prod checks production on the host itself and moves its checkout to the release. A
session on orbit-ws04 runs step 2's work itself, as in [Two-stage release](#two-stage-release), and still delegates step
4 to orbit-prod. Either kind of SubAgent runs on its workspace's default engine, in a temporary worktree of that
workspace's `/root/orbit`, which is deleted when it ends, so each brief works by absolute path. A
SubAgent cannot ask anyone anything, so each brief settles every choice in advance, and any case the brief does not
cover is a stop.

Deploying is the owner's decision. Delegate only when the owner asked for this deploy, in this session.

1. **Name the commit.** `git fetch origin main && git rev-parse origin/main` gives the 40-character commit to deploy,
   unless the owner named another one. Both SubAgents work on exactly that commit, even if main moves on meanwhile.
2. **Deploy through orbit-ws04**, in the background, because the build takes about 12 minutes and the deploy 1 to 2
   more: `delegate({ description: "Deploy <short commit> to production", workspace: "orbit-ws04", background: true,
   size: "M", prompt: <the orbit-ws04 brief> })`. End the turn: Orbit wakes this session with the result.
3. A result without `✓ Release <commit> runs on root@10.66.0.4` is not a deploy. Report what it stopped at, and stop
   there: do not delegate again before you have read why.
4. **Check through orbit-prod**: `delegate({ description: "Check production runs <short commit>", workspace:
   "orbit-prod", size: "S", prompt: <the orbit-prod brief> })`, in the foreground, since it takes about a minute.
5. **Report** both results: the commit, the plan table, how the apiserver and web were replaced, the target's
   `docker compose ps`, the history line, where orbit-prod's checkout now is, and the log path.

The orbit-ws04 brief: fill in `<commit>`, and `<c9>`, its first 9 characters. Add `--stop-then-start` or `--pull-base` to
the `--deploy` command in step 6 only when the owner asked for it.

```text
You are on wikova, workspace orbit-ws04. Deploy Orbit commit <commit> to production (10.66.0.4) with the two-stage
release, as .claude/skills/upgrade/SKILL.md describes under "Two-stage release". You run in a temporary worktree that
is deleted when you end: work by absolute path. Stop and report at the first step that fails, and do not improvise
around a guard. Do not retry, and do not roll back. Answer in English.

Hard rules: other sessions share /root/orbit. Never build in it, never run a compose command in it, and never check
out, merge, reset or stash anything there; read it and add a worktree to it only. Deploy only to root@10.66.0.4,
never on wikova. Never edit 10.66.0.4's .env. Never print a value from any .env.

1. Nothing else is releasing. `cat /tmp/orbit-upgrade.lock/pid` here and `ssh root@10.66.0.4 cat
   /tmp/orbit-upgrade.lock/pid` there must name no live process, and `systemctl list-units 'orbit-build-*'
   'orbit-deploy-*' --no-legend` must list none running. `df -h / /dev/shm`: at least 1.5G free on /dev/shm.
   Note / as it is, but do not stop for it: the build in step 4 makes its own room on / (earlier release images,
   then build cache) and stops by itself if that is not enough.
2. `git -C /root/orbit fetch origin` and `git -C /root/orbit cat-file -e "<commit>^{commit}"`. The commit production
   runs, R, is the second field of `ssh root@10.66.0.4 tail -1 /root/orbit/.upgrade/history`. R must be an ancestor
   of <commit> (`git -C /root/orbit merge-base --is-ancestor R <commit>`): otherwise this would roll production
   back, so stop. Run `git -C /root/orbit diff --stat R <commit> -- src/apiserver/prisma/migrations/`. If it lists a
   migration that drops or renames a table or column, adds a NOT NULL column without a default, or adds a constraint
   or trigger, stop and report it: this deploy hands over without a gap only for additive migrations.
3. W=/dev/shm/wkdir-release-main-<c9>. `git -C /root/orbit worktree add --detach "$W" <commit>`. Copy the build-only
   .env from the newest other /dev/shm/wkdir-release-*/.env (141 bytes, names PUBLIC_ORIGIN, JWT_SECRET,
   PROVIDER_SECRET_KEY, RUNNER_LINK_SIGNING_KEY): `install -m 600 <that file> "$W/.env"`. If there is none, stop.
4. Build and push, as a transient unit so that neither a command timeout nor your own end cuts it short:
   systemd-run --unit orbit-build-<c9> -p WorkingDirectory="$W" env ORBIT_REGISTRY=10.66.0.1:5000 \
     ORBIT_DEPLOY_HOST=root@10.66.0.4 "$W/.claude/skills/upgrade/upgrade.sh" --no-pull --build-only
   It takes 10 to 15 minutes. Wait in steps shorter than 10 minutes
   (`timeout 540 bash -c 'while systemctl is-active -q orbit-build-<c9>; do sleep 10; done'`). Read its output
   with `journalctl -u orbit-build-<c9> --no-pager`. It must end with `✓ Release <commit> is in 10.66.0.1:5000`.
5. Plan: `cd "$W" && ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4
   .claude/skills/upgrade/upgrade.sh --plan <commit>`. Stop without deploying if the plan would create, start or
   recreate postgres, db-proxy, pgbackup, nats or link-gateway, or if it renders docker-channel or
   managed-runner-firewall. Recreating apiserver, web and wiki-worker is expected, and so is a new hosted runners'
   image under "The hosted runners' image". Note the "Replacing the apiserver and web" line, and that image line.
6. Deploy, the same way as step 4, as unit orbit-deploy-<c9> running
   `"$W/.claude/skills/upgrade/upgrade.sh" --deploy <commit>` with the same env. It takes 1 to 2 minutes. Its
   output must end with `✓ Release <commit> runs on root@10.66.0.4`.
7. `curl -fsS https://orbitd.io/api/health`.
8. Remove your worktree, and only yours: `git -C /root/orbit worktree remove --force "$W"`.
9. Hand back: the commit, R (the rollback target), the plan table and its "Replacing the apiserver and web" line,
   the health answer, and the deploy unit's last 15 lines. On a failure, also hand back the step it failed at, the
   failing unit's last 40 lines, and whether $W is still there.
```

The orbit-prod brief: fill in `<commit>`.

```text
You are on 10.66.0.4, workspace orbit-prod: Orbit's production host. /root/orbit is its deploy directory and a git
checkout, detached at the release it runs. Commit <commit> has just been deployed here from wikova. Check that it
runs, and move the checkout to it. You run in a temporary worktree that is deleted when you end, so work in
/root/orbit by absolute path. Start, stop, recreate or pull nothing, and write nothing outside /root/orbit/.git and
the checkout's files named in step 4. Stop and report at the first step that fails. Answer in English.

1. `cat /tmp/orbit-upgrade.lock/pid` must name no live process; if it does, a deploy is running: stop.
2. `tail -1 /root/orbit/.upgrade/history` must name <commit> as its second field.
3. In /root/orbit, `docker compose ps` must show every service running, and healthy where it has a health check,
   with no `orbit-apiserver-next` or `orbit-web-next`. The runner served at /dl is the newest `v*` release tag at or
   behind the commit, not the commit itself (or, with no such tag, the commit). Check that its commit is in it:
   git -C /root/orbit fetch --quiet origin +refs/heads/main:refs/remotes/origin/main '+refs/tags/*:refs/tags/*'
   t="$(git -C /root/orbit describe --tags --abbrev=0 --match 'v*' <commit>)" && r="$(git -C /root/orbit rev-list -n1 "$t")" || r=<commit>
   curl -s https://orbitd.io/dl/orbit-linux-x64.gz | gzip -dc | grep -a -c "$r"   # 1 or more
4. Move the checkout to <commit>, touching no file the deploy shipped (running containers bind-mount some):
   cd /root/orbit
   old="$(git rev-parse HEAD)"
   git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main && git cat-file -e "<commit>^{commit}"
   git update-ref --no-deref HEAD <commit> && git reset -q && git update-index -q --refresh
   The files the release shipped (RELEASE_FILES in deploy/two-stage/release.sh) must already be the commit's:
   git status --porcelain --untracked-files=no -- docker-compose.yml gateway scripts/pg-archive-wal.sh \
     scripts/pg-backup.sh src/link-gateway/nats.conf deploy/runner-link deploy/postgres-pinned.yml deploy/db-proxy.yml deploy/db-proxy
   must print nothing; if it prints anything, stop: the deployed files are not the commit's. Any other file it lists
   without that pathspec only lags behind the commit (a CI script, client sources), and is no reason to stop.
   Bring the rest up to the commit:
   git diff --name-only -z | xargs -0 -r git checkout --
   git diff --name-only -z --diff-filter=D "$old" <commit> | xargs -0 -r rm -f --
   `git status --porcelain --untracked-files=no` must then print nothing.
5. Hand back: the history line, `docker compose ps`, the release tag and the /dl count, and `git -C /root/orbit log -1 --format='%H %s'`.
```

## Requirements

- Docker with the Compose v2 plugin (`docker compose`). The legacy
  `docker-compose` v1 binary is used as a fallback, but `--wait` requires v2.
- Run the script of the checkout the deployment runs from (it resolves the repo root relative
  to its own location).
- The same environment the stack normally uses (e.g. `JWT_SECRET`) should be
  present in the shell or repo-root `.env`.

## Notes

- Managed runners stay as the deployment's `.env` has them: the script never writes `.env`. A
  deployment installed before them, or without `--managed-runners`, keeps them off; only a fresh
  install with `--managed-runners` (`scripts/install-server.sh`) or an administrator switches them on (docs/self-hosting.md,
  "Managed runners"). Where `.env` does not turn on the `managed-runners-docker` Compose profile,
  Compose does not list `docker-channel`, and the script builds, recreates and writes exactly what it
  did before managed runners existed: nothing under `data/`, no managed runner image.
- Where `.env` turns that profile on, the script also:
  1. finds the managed runners' directory where Compose binds it into `docker-channel`, and stops
     before building anything if its `channel.json` and `profile.json` are not there;
  2. builds `docker-channel` with the other images, then the managed runner image from
     `deploy/managed-runner/image` as `orbit-cloud-runner:local` (local, never pushed; `--no-cache`
     applies to it too);
  3. when its image ID is new, writes that ID into both files, each replaced whole by a rename;
  4. recreates the other services as above, then the apiserver again if that did not recreate it
     (it reads the profile only as it starts), and with it the other apiservers, then
     `docker-channel`, last. The apiserver goes
     first: until the channel serves the image its profile names, it makes no container and only
     waits, while a channel already on the new image would refuse the old apiserver's creates.
  A managed runner's container keeps the image it was made from and is never stopped by the
  upgrade: each runner moves to the new image with its next container, when it wakes after it next
  sleeps. Nothing deletes the previous image while a container uses it: in Docker's containerd image
  store it loses its name when the new image takes the tag, and its storage goes with the last
  container made from it; in the classic store `--prune` removes it once no container uses it.
  `data/managed-runners/.image-switch` marks a switch written and not yet started on, so a run that
  failed between the two is finished by the next one.
- The default `up -d --wait apiserver wiki-worker web gateway` only recreates services whose
  image or config changed, so an upgrade with no source changes is a no-op (and
  stays healthy). `postgres` is never recreated unless you pass `--pull-base` and
  its base image actually changed.
- The `orbit_pg` volume is preserved across the upgrade; data is not lost.
- If a healthcheck fails, `up --wait` exits non-zero — check
  `docker compose logs <service>` (commonly `apiserver` if a migration failed).
- Concurrent upgrades are serialized by a lock directory (`/tmp/orbit-upgrade.lock`,
  created with `mkdir` so it works on macOS as well as Linux; a lock whose holding
  process is gone is reported and taken over).
  If an upgrade is already running, a second invocation exits immediately with a
  non-zero status rather than running a redundant rebuild.
