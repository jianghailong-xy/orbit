---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment — rebuild the apiserver and web images from the current source and recreate only the services that changed (apiserver applies DB migrations on boot); an unchanged postgres is left running. Refreshing the postgres/gateway base images is opt-in via --pull-base. Use whenever someone wants to deploy the latest code, update/upgrade the running containers, or bring a Compose deployment up to date.
---

# Upgrade the Orbit stack

Orbit runs as a single Docker Compose stack (`docker-compose.yml` at the repo
root) with `postgres`, `apiserver`, `wiki-worker`, `web`, and `gateway` among its
services. `apiserver` and `web` are built locally from source, and `wiki-worker`
runs the `apiserver` image with another command; `postgres` and `gateway`
(nginx) use pinned upstream images. A routine upgrade rebuilds the locally-built
images and recreates only the services that actually changed — an unchanged
`postgres` is never restarted. Refreshing the upstream base images is opt-in via
`--pull-base`.

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
gateway. A failure there stops nothing else: the runners stay on HTTPS, the last lines say
why, and the script exits 1. In a build whose `docker-compose.yml` requires
`RUNNER_LINK_SIGNING_KEY`, one with no HTTPS work path, the same failure stops the upgrade
before the apiserver is recreated. It never writes `RUNNER_LINK_REQUIRED`, which is an
administrator's.

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
