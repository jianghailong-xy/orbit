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

Run the script from anywhere (it `cd`s to the repo root itself):

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
   `wiki-worker` with the `apiserver` image it runs, and `gateway` only if its
   image or mounted `nginx.conf` changed), and block
   until they pass their healthcheck (apiserver runs migrations on boot).
   `postgres` is left running untouched — it is not in the recreate set.
4. Print `docker compose ps`.

With `--pull-base` it instead first runs `docker compose pull postgres gateway`
and then a full `docker compose up -d --wait`, so a genuinely new base image is
applied — this is the only path that may recreate (restart) `postgres`.

### Flags

- `--no-pull` — skip the pull and deploy the checkout exactly as it is (a
  pinned or offline deploy).
- `--pull` — pull even when the checkout is not on `main` (on `main` it is the
  default).
- `--pull-base` — also refresh the pinned base images (`postgres`, `gateway`)
  and run a full recreate. This is the only path that may restart `postgres`;
  omit it (the default) to leave an unchanged `postgres` running.
- `--no-cache` — rebuild the apiserver/web images without the Docker layer
  cache (use when a dependency change isn't being picked up).
- `--prune` — `docker image prune -f` after a successful upgrade to reclaim
  space from the now-dangling old image layers.
- `--allow-dirty` — build even though the checkout has uncommitted changes. Use
  when you deliberately want to test an uncommitted change in the deployment, and
  remember the change exists in no commit: the next clean rebuild reverts it.

```bash
.claude/skills/upgrade/upgrade.sh --prune
```

## Requirements

- Docker with the Compose v2 plugin (`docker compose`). The legacy
  `docker-compose` v1 binary is used as a fallback, but `--wait` requires v2.
- Run from a checkout of the repo (the script resolves the repo root relative
  to its own location).
- The same environment the stack normally uses (e.g. `JWT_SECRET`) should be
  present in the shell or repo-root `.env`.

## Notes

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
