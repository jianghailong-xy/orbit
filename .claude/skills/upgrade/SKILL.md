---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment — rebuild the apiserver and web images from the current source and recreate only the services that changed (apiserver applies DB migrations on boot); an unchanged postgres is left running. Refreshing the postgres/gateway base images is opt-in via --pull-base. Use whenever someone wants to deploy the latest code, update/upgrade the running containers, or bring a Compose deployment up to date.
---

# Upgrade the Orbit stack

Orbit runs as a single Docker Compose stack (`docker-compose.yml` at the repo
root) with four services: `postgres`, `apiserver`, `web`, and `gateway`.
`apiserver` and `web` are built locally from source; `postgres` and `gateway`
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

1. `docker compose build apiserver web` — rebuild from the current source.
2. `docker compose up -d --wait apiserver web gateway` — recreate only the
   services whose image or config changed (the freshly built `apiserver`/`web`,
   and `gateway` only if its image or mounted `nginx.conf` changed), and block
   until they pass their healthcheck (apiserver runs migrations on boot).
   `postgres` is left running untouched — it is not in the recreate set.
3. Print `docker compose ps`.

With `--pull-base` it instead first runs `docker compose pull postgres gateway`
and then a full `docker compose up -d --wait`, so a genuinely new base image is
applied — this is the only path that may recreate (restart) `postgres`.

### Flags

- `--pull` — `git pull --ff-only` first, to upgrade to the latest committed
  source before building.
- `--pull-base` — also refresh the pinned base images (`postgres`, `gateway`)
  and run a full recreate. This is the only path that may restart `postgres`;
  omit it (the default) to leave an unchanged `postgres` running.
- `--no-cache` — rebuild the apiserver/web images without the Docker layer
  cache (use when a dependency change isn't being picked up).
- `--prune` — `docker image prune -f` after a successful upgrade to reclaim
  space from the now-dangling old image layers.

```bash
.claude/skills/upgrade/upgrade.sh --pull --prune
```

## Requirements

- Docker with the Compose v2 plugin (`docker compose`). The legacy
  `docker-compose` v1 binary is used as a fallback, but `--wait` requires v2.
- Run from a checkout of the repo (the script resolves the repo root relative
  to its own location).
- The same environment the stack normally uses (e.g. `JWT_SECRET`) should be
  present in the shell or repo-root `.env`.

## Notes

- The default `up -d --wait apiserver web gateway` only recreates services whose
  image or config changed, so an upgrade with no source changes is a no-op (and
  stays healthy). `postgres` is never recreated unless you pass `--pull-base` and
  its base image actually changed.
- The `orbit_pg` volume is preserved across the upgrade; data is not lost.
- If a healthcheck fails, `up --wait` exits non-zero — check
  `docker compose logs <service>` (commonly `apiserver` if a migration failed).
- Concurrent upgrades are serialized by a `flock` lock (`/tmp/orbit-upgrade.lock`).
  If an upgrade is already running, a second invocation exits immediately with a
  non-zero status rather than running a redundant rebuild.
