#!/usr/bin/env bash
# The server machine's code images, built on the HPC host's Docker (its build cache) from a clean checkout of the lab's
# commit, then saved for `docker load` into the server machine. Run under the heavy lock and the memory gate.
set -euo pipefail
SHA=$1
cd /mnt/data/tmp/34w2jF/base
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$SHA")" ] || { echo "base worktree is not at $SHA" >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "base worktree is dirty" >&2; exit 2; }
full=$(git rev-parse HEAD)
echo "==> $(date -Is) building orbit-apiserver:local at $full"
docker build -q --provenance=false -f src/apiserver/Dockerfile -t mrrh-apiserver:local .
echo "==> $(date -Is) building orbit-web at $full"
docker build -q --provenance=false -f src/web/Dockerfile --build-arg ORBIT_SOURCE_SHA="$full" -t mrrh-web:latest .
echo "==> $(date -Is) saving"
docker save mrrh-apiserver:local mrrh-web:latest -o /mnt/data/tmp/34w2jF/server-images.tar
ls -la /mnt/data/tmp/34w2jF/server-images.tar
echo "==> $(date -Is) done"
