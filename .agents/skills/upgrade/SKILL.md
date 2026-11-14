---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment by rebuilding the apiserver and web images from current source and recreating only changed services; apiserver applies database migrations on boot and unchanged postgres stays running. Use when asked to deploy the latest Orbit code, update or upgrade the running containers, run /upgrade, or bring the Compose deployment up to date. Use --pull-base only when explicitly asked to refresh postgres or gateway base images. With ORBIT_REGISTRY set it is a two-stage release: build, boot-check and push here, then pull and recreate on ORBIT_DEPLOY_HOST, which builds nothing; roll back with --deploy <earlier commit>.
---

# Upgrade the Orbit stack

Orbit uses `docker-compose.yml` with `postgres`, `apiserver`, `wiki-worker`, `web`, and `gateway`. A routine upgrade rebuilds the locally built `apiserver` and `web` images (`wiki-worker` runs the `apiserver` image), then recreates only changed services. The persisted `orbit_pg` volume is preserved.

Database migrations are not a separate step: the apiserver container runs `prisma migrate deploy` during startup.

## Workflow

1. Run in the installed checkout, the one the deployment runs from, and never from a worktree (see "Where to run it" below). Check the current branch, worktree status, and Compose availability. On `main` the helper runs `git pull --ff-only` before building, so the deploy is origin's main and not a stale checkout; it never overwrites or discards local changes and stops if a fast-forward is impossible.

   The helper refuses to build when tracked files are modified: images are built from the working tree, not from `HEAD`, so uncommitted edits reach production while existing in no commit and are silently reverted by the next clean rebuild. Commit or stash first; pass `--allow-dirty` only when deliberately deploying an uncommitted change.

2. Choose flags from the request:

   - `--no-pull`: skip the pull on `main` and deploy the checkout as it is.
   - `--pull`: run `git pull --ff-only` even when the checkout is not on `main`.
   - `--pull-base`: pull the pinned `postgres` and `gateway` images and recreate the full stack. This is the only mode that may restart postgres; use it only when explicitly requested.
   - `--no-cache`: rebuild local images without Docker layer cache.
   - `--prune`: prune dangling images after a successful upgrade.
   - `--allow-dirty`: build despite uncommitted changes (they exist in no commit).

3. State which services may be recreated. When the chosen flags match the user's request, run:

   ```bash
   .agents/skills/upgrade/scripts/upgrade.sh
   .agents/skills/upgrade/scripts/upgrade.sh --prune
   ```

4. Report the final `docker compose ps` state. If health checks fail, inspect `docker compose logs <service>` and diagnose the failure; do not claim the upgrade succeeded.

## Behavior

On `main` the helper first fast-forwards to origin (`git pull --ff-only`) unless `--no-pull` is given.

Without `--pull-base`, the helper:

1. Builds `apiserver` (whose image `wiki-worker` runs) and `web`.
2. Runs `docker compose up -d --wait apiserver wiki-worker web gateway`.
3. Where `docker-compose.override.yml` adds other apiservers (`apiserver-2` and on; docs/self-hosting.md, "Several apiservers"), recreates them once `apiserver` is healthy and the migrations are applied, so they find none to apply.
4. Brings `pgbackup` up to date, last (see "pgbackup" below).
5. Prints `docker compose ps`.

Postgres is omitted from the recreate set. With `--pull-base`, the helper pulls `postgres` and `gateway`, then runs a full `up -d --wait` so changed base images take effect.

The helper writes nothing of managed runners to `.env`, so they stay as the deployment's `.env` has them: off unless it switches them on, which only a fresh install (`scripts/install-server.sh`) or an administrator does (docs/self-hosting.md, "Managed runners"). Where `.env` does not turn on the `managed-runners-docker` Compose profile, Compose does not list `docker-channel`, and the helper builds, recreates and writes exactly what it did before managed runners existed: nothing under `data/`, no managed runner image.

The helper also brings up the runner link (docs/self-hosting.md, "Runner link"; the section marked in the script, the same in both copies), and what `.env` says decides what it may do. With no link in it, it builds `src/link-gateway`, has that image make the link's secrets, and appends them to `.env` with `RUNNER_LINK_URL=same-origin`, in one write that changes no line and prints none of them. With `RUNNER_LINK_URL=same-origin` it rebuilds the gateway, named by the last commit under `src/link-gateway`, so that a commit elsewhere recreates nothing. With anything else, as production's own host name, `.env` is not opened for writing, and `link-gateway` and `nats` are neither built nor restarted. After the images are built and before the apiserver is recreated, it starts `nats` and `link-gateway`, recreates the web gateway if the `gateway/nginx.conf` it runs is not this checkout's, which Compose does not see, and checks that `/runner-link` reaches the link gateway. This build's `docker-compose.yml` requires `RUNNER_LINK_SIGNING_KEY`, since it has no HTTPS work path, so a failure there stops the upgrade before the apiserver is recreated, and the deployment goes on running the build it has. A pull that changes this script runs the new one, from the start.

Where `.env` turns that profile on, the helper also keeps managed runners current (the section marked in the script, the same in both copies of /upgrade's script):

1. It finds the managed runners' directory where Compose binds it into `docker-channel`, and stops before building anything if its `channel.json` and `profile.json` are not there.
2. It builds `docker-channel` with the other images, then the managed runner image from `deploy/managed-runner/image` as `orbit-managed-runner:local` (local, never pushed; `--no-cache` applies to it too).
3. After the migrations, when the image ID is new, it writes that ID into both files, each replaced whole by a rename.
4. It recreates the other services as above, then the apiserver again if that did not recreate it (it reads the profile only as it starts), and with it the other apiservers, then `docker-channel`, last. The apiserver goes first: until the channel serves the image its profile names, it makes no container and only waits, while a channel already on the new image would refuse the old apiserver's creates.

A managed runner's container keeps the image it was made from and is never stopped by the upgrade: each runner moves to the new image with its next container, when it wakes after it next sleeps. Nothing deletes the previous image while a container uses it: in Docker's containerd image store it loses its name when the new image takes the tag, and its storage goes with the last container made from it; in the classic store `--prune` removes it once no container, running or stopped, was made from it. `data/managed-runners/.image-switch` marks a switch written and not yet started on, so a run that failed between the two is finished by the next one.

Concurrent upgrades are serialized with `/tmp/orbit-upgrade.lock`; a second invocation exits instead of starting another deployment.

## Where to run it

Run the helper in the installed checkout, the one the deployment runs from, and never from a worktree. A deployment's bind mounts are relative (`./data/postgres`, `./data/pg-archive`, `./data/files`), so from any other directory Compose would bind that directory's empty `./data`: the database, the archive the off-host mirror reads, and every attachment's bytes.

So the helper stops first, before it pulls, builds, tags or recreates anything, if the postgres container this checkout's Compose names has its `/archive` anywhere else. The refusal names the checkout to run from and says nothing was changed. With no such container there is no deployment yet, and a first install goes ahead. A separate deployment on the same Docker passes on its own `/archive` if its containers have names of their own, set in its `docker-compose.override.yml`, and it exports its own `COMPOSE_PROJECT_NAME` for this helper: the check goes by the name Compose renders, so one with the same names cannot be told from that deployment and is refused.

## pgbackup

The backup sidecar needs a step of its own. Compose bind-mounts `scripts/pg-backup.sh` into it as a single file, so a new checkout replaces the file under a running container, which keeps the one it started on, and Compose sees no change. The helper compares what the container has with the checkout: if they differ it runs `docker compose up -d --wait --no-deps --force-recreate pgbackup`, otherwise the same without `--force-recreate`, which recreates it for a change of configuration, such as a new mount, and leaves it running if there is none. `--no-deps` keeps `postgres` out of it, and recreating it cuts short a base backup in progress, which it takes again as it starts.

A sidecar that is not running is left as it is, and the helper says `pgbackup was NOT updated` as its last lines, with the command to run.

The step is in the script, so it runs once the script on disk has it. A run from an older version pulls the new script from inside itself and finishes as the old one, reporting success with `pgbackup` unchanged. Put the new version on disk first and pass `--no-pull`, or run it a second time.

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

With no `ORBIT_BACKUP_SYNC_TARGET`, or with `ORBIT_FILES_BACKEND=s3`, the last two have nothing to show: see the backup and restore runbook, `docs/postgres-backup-restore.md`, "Attachment files".

## Two-stage release

With `ORBIT_REGISTRY` set, the helper builds on this host and deploys on another, which runs the deployment and builds nothing: Orbit's production builds on wikova, pushes to the WireGuard-only registry `10.66.0.1:5000`, and runs on `10.66.0.4`. Without `ORBIT_REGISTRY` nothing here applies. The full account is the `.claude` skill's section of the same name (`.claude/skills/upgrade/SKILL.md`).

```bash
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .agents/skills/upgrade/scripts/upgrade.sh --prune
ORBIT_REGISTRY=10.66.0.1:5000 .agents/skills/upgrade/scripts/upgrade.sh --build-only
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .agents/skills/upgrade/scripts/upgrade.sh --deploy <40-character commit>
ORBIT_REGISTRY=10.66.0.1:5000 ORBIT_DEPLOY_HOST=root@10.66.0.4 .agents/skills/upgrade/scripts/upgrade.sh --plan <40-character commit>
```

`ORBIT_DEPLOY_DIR` is the deployment's directory on the target (`/root/orbit`). After the lock, the dirty check and the pull, `deploy/two-stage/release.sh` takes over, and this host's own containers, `.env` and runner link are left as they are.

- Build stage, here: the images are tagged by commit, `<registry>/orbit-apiserver:<commit>`, `<registry>/orbit-web:<commit>` and `<registry>/orbit-link-gateway:<last commit under src/link-gateway>`. Each that is not in the registry yet is built (`docker compose build apiserver wiki-worker web`, keeping the target's serving web release at `/dl/previous/` through `orbit-web:previous-release`; the link gateway with `docker build --provenance=false`), booted by `scripts/image-boot-check.sh`, and pushed. A tag in the registry is never pushed again.
- Deploy stage, on the target over ssh: the target has no checkout. The commit's `docker-compose.yml`, `gateway/`, `scripts/pg-archive-wal.sh`, `scripts/pg-backup.sh`, `src/link-gateway/nats.conf`, `deploy/runner-link/`, `deploy/postgres-pinned.yml`, `deploy/db-proxy.yml` and `deploy/db-proxy/` are shipped with `git archive`, and `deploy/two-stage/deploy-stage.sh` takes the target's `/tmp/orbit-upgrade.lock`, puts the files in place (and back, with no directory it added, if it stops before its images are all pulled), prints each service's config-hash plan (with `db-proxy`, `gateway` and `pgbackup` also `recreate` when the single file each bind-mounts is not the release's), refuses an image that does not come from the registry, pulls every image, writes the release into its block of the target's `.env`, and brings each service up with `docker compose up -d --wait --no-deps --no-build` in `depends_on` order: postgres, db-proxy, nats, apiserver and the rest. A running postgres is recreated only with `--pull-base`. Its log and history are in `.upgrade/` there.
- `--plan <commit>` runs the deploy stage up to its plan and the registry check, then puts every file back: it pulls, writes and brings up nothing.
- The target's `.env` is its own, made once before the first deploy; a deploy writes only the block between `# >>> The release this host runs` and `# <<< The release this host runs`, so a later `docker compose` there renders the release that runs. Its `COMPOSE_FILE` lists `docker-compose.yml:deploy/postgres-pinned.yml`, and `:deploy/db-proxy.yml` where the apiserver connects through the proxy (10.66.0.4's does); the release ships those. Any other Compose file it lists, or its `docker-compose.override.yml`, is rendered with each release and otherwise left alone.
- Base images run by digest: postgres and pgbackup as `deploy/postgres-pinned.yml` pins them (PostgreSQL 16.14), db-proxy as `deploy/db-proxy.yml` does, nginx and nats as `deploy/two-stage/base-images.env` does. A target that does not list `deploy/postgres-pinned.yml` is refused.
- Rollback: `--deploy <earlier commit>`, which builds nothing (`--plan <earlier commit>` first shows what it changes); the target's `.upgrade/history` lists what it ran. Code older than a migration the database has applied may not run on it.
- Both hosts' Docker must trust the registry (`insecure-registries` in `/etc/docker/daemon.json` for a plain-HTTP one, applied with `systemctl reload docker`). `docker buildx du` and `docker image ls` on the target show that nothing was built there.

## Requirements

- Docker Compose v2 is preferred. The legacy `docker-compose` binary is a fallback, but `--wait` requires v2 support.
- Run against the checkout the deployment runs from, with the normal deployment environment, including values normally supplied through the root `.env`.
- Never delete or recreate the `orbit_pg` volume as part of this workflow.
