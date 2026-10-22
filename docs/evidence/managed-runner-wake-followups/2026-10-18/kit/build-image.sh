#!/usr/bin/env bash
# The managed runner image from this task's commit (deploy/managed-runner/image, unchanged), then the
# lab CA layer on top (scripts/managed-runner/lab/lab-ca-image.Dockerfile). Nothing is pushed.
set -euo pipefail
W=/mnt/data/tmp/34hpKqWRaAJbUXoikQ3U4/image
WT=/root/.orbit/worktrees/54a4a7e8-e645-56e0-95e2-01e100985351
SHA=$(cat "$W/source-sha")
started=$(date +%s)
docker buildx build --builder t03-capped --file "$W/ctx/deploy/managed-runner/image/Dockerfile" \
  --build-arg ORBIT_SOURCE_SHA="$SHA" --provenance=false \
  --output "type=oci,dest=$W/product.oci.tar,name=docker.io/library/orbit-managed-runner:t06b-${SHA:0:9}" \
  "$W/ctx" > "$W/product-build.txt" 2>&1
echo "product build: $(( $(date +%s) - started )) s"
mkdir -p "$W/product-oci" && tar -xf "$W/product.oci.tar" -C "$W/product-oci"
DIGEST=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifests"][0]["digest"])' "$W/product-oci/index.json")
echo "product manifest: $DIGEST"
cp /mnt/data/managed-runner-lab/test-server-t02a/tls/ca.crt "$W/lab-ctx/ca.crt"
started=$(date +%s)
docker buildx build --builder t03-capped --build-context "base=oci-layout://$W/product-oci@$DIGEST" \
  --file "$WT/scripts/managed-runner/lab/lab-ca-image.Dockerfile" --provenance=false \
  --output "type=oci,dest=$W/lab.oci.tar,name=docker.io/library/orbit-managed-runner-lab:t06b-${SHA:0:9}" \
  "$W/lab-ctx" > "$W/lab-build.txt" 2>&1
echo "lab CA build: $(( $(date +%s) - started )) s"
ls -la "$W"/*.tar
sha256sum "$W/lab.oci.tar"
