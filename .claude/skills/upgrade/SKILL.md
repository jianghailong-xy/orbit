---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment — rebuild the apiserver and web images from the current source and recreate only the services that changed (apiserver applies DB migrations on boot); an unchanged postgres is left running. Refreshing the postgres/gateway base images is opt-in via --pull-base. With ORBIT_REGISTRY set it is a two-stage release instead: build, boot-check and push here, tagged by commit, then pull and recreate on ORBIT_DEPLOY_HOST, which builds nothing, handing the apiserver and web over without a gap; a rollback deploys an earlier commit (--deploy). Use whenever someone wants to deploy the latest code, update/upgrade the running containers, bring a Compose deployment up to date, or roll one back.
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
`link-gateway`, recreates the web gateway if the `gateway/nginx.conf` it runs is not this
checkout's (a single-file bind mount Compose does not see change: a moment's break for web
traffic and streams, once per change), and checks that `/runner-link` reaches the link
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

With no `ORBIT_BACKUP_SYNC_TARGET`, or with `ORBIT_FILES_BACKEND=s3`, the last two have nothing to
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
registry first). For each image that is not there yet:

1. `docker compose build apiserver wiki-worker web`, under those names. This checkout's `.env` supplies the
   build arguments (`PUBLIC_ORIGIN`, and `COMPOSE_FILE` where it adds the macOS signing file), so they have to
   be the target's. The web image keeps the runner release the target's `web` serves at `/dl/previous/`, as
   on a single host: that image, pulled if this host lacks it, is tagged `orbit-web:previous-release` and
   passed as `PREVIOUS_RELEASE_IMAGE`. Before the target serves any, this host's own `orbit-web` is.
2. `scripts/image-boot-check.sh` boots the apiserver and web images, as CI does, before either is pushed.
3. The link gateway: `docker build --provenance=false`, as a single host builds it.
4. `docker push` of each.

**Deploy stage, on the target, driven from here over ssh.** The target has no checkout and no runner. The
build host ships it what the deployment's Compose reads from its directory, taken from the release's commit
with `git archive`, never from the working tree: `docker-compose.yml`, `gateway/`,
`scripts/pg-archive-wal.sh`, `scripts/pg-backup.sh`, `src/link-gateway/nats.conf`, `deploy/runner-link/`, and
the two Compose files a target lists beside `docker-compose.yml`, `deploy/postgres-pinned.yml` and
`deploy/db-proxy.yml`, with `deploy/db-proxy/`. They are staged under `.upgrade/release-<commit>/` there, beside
`deploy/two-stage/deploy-stage.sh`, which then, on the target:

1. takes the target's upgrade lock, `/tmp/orbit-upgrade.lock`, as a single host's upgrade takes its own: one
   upgrade at a time, a second refused at once, a lock whose holder is gone taken over;
2. stops, having changed nothing, where the target has no `.env`, where its `.env` switches on managed
   runners (their images are built where they run), or where a `postgres` of the name this release renders
   keeps its `/archive` in another directory;
3. puts the release's files in place, each whole by a rename, keeping the ones they replace until the
   release's images are all there: a deploy that stops before then puts them back, and takes away the files
   and directories it added, having changed nothing;
4. prints the plan: each service's `docker compose config --hash` for this release against the hash its
   container was made with, as `create`, `unchanged`, `start` or `recreate`. `db-proxy`, `gateway` and
   `pgbackup` each bind-mount one file on its own (`deploy/db-proxy/haproxy.cfg`, `gateway/nginx.conf`,
   `scripts/pg-backup.sh`), which a running container keeps from its start whatever Compose sees, so one that
   runs another than the release's is `recreate` too, and says which file. Under the table it says how the
   apiserver and web are replaced: `Replacing the apiserver and web: without a gap`, or `stop, then start` with
   the reason ([Without a gap](#without-a-gap), below);
5. stops, having changed nothing, if an image the release runs does not come from the registry: `postgres` and
   `pgbackup` have theirs only from `deploy/postgres-pinned.yml`, so a target whose `COMPOSE_FILE` does not
   list it is refused. `--plan` stops here in any case, with every file put back;
6. pulls every image the release runs, and stops if one is missing;
7. writes the release's names into `.env` (below);
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
   `.upgrade/deploy.log`.

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
`ORBIT_IMAGE_TAG`, `ORBIT_LINK_GATEWAY_TAG`, `ORBIT_NGINX_IMAGE` and `ORBIT_NATS_IMAGE` (docs/configuration.md,
"Images and the two-stage release"). It replaces the whole file by a rename, every other line as it was, so that
any later `docker compose` there renders the release that runs, and never builds anything. `COMPOSE_FILE` lists
`docker-compose.yml` and `deploy/postgres-pinned.yml` on every target, and `deploy/db-proxy.yml` where the
apiserver connects through the proxy; each release ships its own copy of those. Any other Compose file the
target has, `docker-compose.override.yml` or another that `COMPOSE_FILE` lists, stays as it is and is rendered
with each release; a service it adds is left as it is. Its `./data` stays where it is.

**Base images.** Each runs by digest, pulled from the registry, which holds them under Docker Hub's own path,
`library/<name>`. `postgres` and `pgbackup` run PostgreSQL 16.14 as `deploy/postgres-pinned.yml` pins it, never
the floating `16-alpine` tag, which has moved on, and `db-proxy` the HAProxy `deploy/db-proxy.yml` pins; the
release's `deploy/two-stage/base-images.env` pins `gateway` (nginx) and `nats`. Each pin is in one file only,
and changes in a commit, so a release and its rollback both name the base images they ran with. A new digest has
to be copied to the registry, as `base-images.env` says, before a release names it.

**Rollback.** Deploy an earlier release: `upgrade.sh --deploy <its commit>`, with the same
`ORBIT_REGISTRY` and `ORBIT_DEPLOY_HOST`; `--plan <its commit>` first shows what it changes. Its images are in
the registry, its files come from its commit, nothing is built, and `up` recreates what differs from it. The
target's `.upgrade/history` lists the releases it ran, newest last. The database keeps the migrations a later
release applied: roll back past a migration only to code that runs on the database as that migration left it.

**Requirements.** Both hosts' Docker trust the registry. One served over plain HTTP, as `10.66.0.1:5000` is,
is listed in each host's `/etc/docker/daemon.json` under `insecure-registries`, which
`systemctl reload docker` applies without stopping a container; the build stage checks this host's before it
builds. This host reaches the target as root over `ssh` with a key, and has `git`, `curl` and
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

## Requirements

- Docker with the Compose v2 plugin (`docker compose`). The legacy
  `docker-compose` v1 binary is used as a fallback, but `--wait` requires v2.
- Run the script of the checkout the deployment runs from (it resolves the repo root relative
  to its own location).
- The same environment the stack normally uses (e.g. `JWT_SECRET`) should be
  present in the shell or repo-root `.env`.

## Notes

- Managed runners stay as the deployment's `.env` has them: the script never writes `.env`. A
  deployment installed before them, or with `--no-managed-runners`, keeps them off; only a fresh
  install (`scripts/install-server.sh`) or an administrator switches them on (docs/self-hosting.md,
  "Managed runners"). Where `.env` does not turn on the `managed-runners-docker` Compose profile,
  Compose does not list `docker-channel`, and the script builds, recreates and writes exactly what it
  did before managed runners existed: nothing under `data/`, no managed runner image.
- Where `.env` turns that profile on, the script also:
  1. finds the managed runners' directory where Compose binds it into `docker-channel`, and stops
     before building anything if its `channel.json` and `profile.json` are not there;
  2. builds `docker-channel` with the other images, then the managed runner image from
     `deploy/managed-runner/image` as `orbit-managed-runner:local` (local, never pushed; `--no-cache`
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
