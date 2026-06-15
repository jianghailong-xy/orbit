---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment — rebuild the apiserver and web images from the current source, refresh the postgres/gateway base images, and recreate the whole stack (apiserver applies DB migrations on boot). Use whenever someone wants to deploy the latest code, update/upgrade the running containers, or bring a Compose deployment up to date.
---

# Upgrade the Orbit stack

Orbit runs as a single Docker Compose stack (`docker-compose.yml` at the repo
root) with four services: `postgres`, `apiserver`, `web`, and `gateway`.
`apiserver` and `web` are built locally from source; `postgres` and `gateway`
(nginx) use pinned upstream images. This skill rebuilds and recreates them all.

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

1. `docker compose pull postgres gateway` — refresh the pinned base images.
2. `docker compose build apiserver web` — rebuild from the current source.
3. `docker compose up -d --wait` — recreate changed containers and block until
   every service passes its healthcheck (apiserver runs migrations on boot).
4. Print `docker compose ps`.

### Flags

- `--pull` — `git pull --ff-only` first, to upgrade to the latest committed
  source before building.
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
- The same environment the stack normally uses (e.g. `JWT_SECRET`,
  `ADMIN_TOKEN`) should be present in the shell or repo-root `.env`.

## Notes

- `up -d --wait` only recreates services whose image or config changed, so an
  upgrade with no source changes is close to a no-op (and stays healthy).
- The `orbit_pg` volume is preserved across the upgrade; data is not lost.
- If a healthcheck fails, `up --wait` exits non-zero — check
  `docker compose logs <service>` (commonly `apiserver` if a migration failed).
