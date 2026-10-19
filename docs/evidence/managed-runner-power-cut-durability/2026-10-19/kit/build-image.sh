#!/usr/bin/env bash
# The managed runner image from this task's commit (deploy/managed-runner/image), then the lab CA layer
# on top (scripts/managed-runner/lab/lab-ca-image.Dockerfile, T02a's CA, which every lab test server
# since T02a serves). Built in the 5 GiB-capped buildx builder t03-capped; nothing is pushed.
#   build-image.sh WORKDIR     (a clean checkout of HEAD is archived into WORKDIR/ctx)
set -euo pipefail
W=${1:?usage: build-image.sh WORKDIR}
REPO=$(cd "$(dirname "$0")/../../../../.." && pwd)
SHA=$(git -C "$REPO" rev-parse HEAD)
[ -z "$(git -C "$REPO" status --porcelain -- deploy/managed-runner/image src/runner-go)" ] || { echo "uncommitted image sources" >&2; exit 1; }
rm -rf "$W/ctx" "$W/product-oci" "$W/lab-ctx" && mkdir -p "$W/ctx" "$W/lab-ctx"
git -C "$REPO" archive HEAD | tar -x -C "$W/ctx"
echo "$SHA" > "$W/source-sha"
started=$(date +%s)
docker buildx build --builder t03-capped --file "$W/ctx/deploy/managed-runner/image/Dockerfile" \
  --build-arg ORBIT_SOURCE_SHA="$SHA" --provenance=false \
  --output "type=oci,dest=$W/product.oci.tar,name=docker.io/library/orbit-managed-runner:t02c-${SHA:0:9}" \
  "$W/ctx" > "$W/product-build.txt" 2>&1
echo "product build: $(( $(date +%s) - started )) s"
mkdir -p "$W/product-oci" && tar -xf "$W/product.oci.tar" -C "$W/product-oci"
DIGEST=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifests"][0]["digest"])' "$W/product-oci/index.json")
echo "product manifest: $DIGEST"
cp /mnt/data/managed-runner-lab/test-server-t02a/tls/ca.crt "$W/lab-ctx/ca.crt"
started=$(date +%s)
docker buildx build --builder t03-capped --build-context "base=oci-layout://$W/product-oci@$DIGEST" \
  --file "$REPO/scripts/managed-runner/lab/lab-ca-image.Dockerfile" --provenance=false \
  --output "type=oci,dest=$W/lab.oci.tar,name=docker.io/library/orbit-managed-runner-lab:t02c-${SHA:0:9}" \
  "$W/lab-ctx" > "$W/lab-build.txt" 2>&1
echo "lab CA build: $(( $(date +%s) - started )) s"
mkdir -p "$W/lab-oci" && tar -xf "$W/lab.oci.tar" -C "$W/lab-oci"
echo "lab manifest: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifests"][0]["digest"])' "$W/lab-oci/index.json")"
ls -la "$W"/*.tar
sha256sum "$W/lab.oci.tar"
