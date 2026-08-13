---
name: upgrade
description: Upgrade the Orbit Docker Compose deployment by rebuilding the apiserver and web images from current source and recreating only changed services; apiserver applies database migrations on boot and unchanged postgres stays running. Use when asked to deploy the latest Orbit code, update or upgrade the running containers, run /upgrade, or bring the Compose deployment up to date. Use --pull-base only when explicitly asked to refresh postgres or gateway base images.
---

# Upgrade the Orbit stack

Orbit uses `docker-compose.yml` with `postgres`, `apiserver`, `web`, and `gateway`. A routine upgrade rebuilds the locally built `apiserver` and `web` images, then recreates only changed services. The persisted `orbit_pg` volume is preserved.

Database migrations are not a separate step: the apiserver container runs `prisma migrate deploy` during startup.

## Workflow

1. Check the current branch, worktree status, and Compose availability. If `--pull` is requested, do not overwrite or discard local changes; stop if a fast-forward pull is unsafe.

   The helper refuses to build when tracked files are modified: images are built from the working tree, not from `HEAD`, so uncommitted edits reach production while existing in no commit and are silently reverted by the next clean rebuild. Commit or stash first; pass `--allow-dirty` only when deliberately deploying an uncommitted change.

2. Choose flags from the request:

   - `--pull`: run `git pull --ff-only` before building.
   - `--pull-base`: pull the pinned `postgres` and `gateway` images and recreate the full stack. This is the only mode that may restart postgres; use it only when explicitly requested.
   - `--no-cache`: rebuild local images without Docker layer cache.
   - `--prune`: prune dangling images after a successful upgrade.
   - `--allow-dirty`: build despite uncommitted changes (they exist in no commit).

3. State which services may be recreated. When the chosen flags match the user's request, run:

   ```bash
   .agents/skills/upgrade/scripts/upgrade.sh
   .agents/skills/upgrade/scripts/upgrade.sh --pull --prune
   ```

4. Report the final `docker compose ps` state. If health checks fail, inspect `docker compose logs <service>` and diagnose the failure; do not claim the upgrade succeeded.

## Behavior

Without `--pull-base`, the helper:

1. Builds `apiserver` and `web`.
2. Runs `docker compose up -d --wait apiserver web gateway`.
3. Prints `docker compose ps`.

Postgres is omitted from the recreate set. With `--pull-base`, the helper pulls `postgres` and `gateway`, then runs a full `up -d --wait` so changed base images take effect.

Concurrent upgrades are serialized with `/tmp/orbit-upgrade.lock`; a second invocation exits instead of starting another deployment.

## Requirements

- Docker Compose v2 is preferred. The legacy `docker-compose` binary is a fallback, but `--wait` requires v2 support.
- Run against an Orbit checkout with the normal deployment environment, including values normally supplied through the root `.env`.
- Never delete or recreate the `orbit_pg` volume as part of this workflow.
