#!/usr/bin/env bash
# The managed runner image from this checkout's HEAD (deploy/managed-runner/image), then the lab CA layer on top
# (lab-ca-image.Dockerfile) with the CA of the test server named by $LAB_TEST_SERVER_DIR. Built in a buildx builder
# of the docker-container driver (LAB_BUILDX_BUILDER, made if missing); the OCI archives go to WORKDIR, nothing is
# pushed.
#   build-image.sh WORKDIR
set -euo pipefail
W=${1:?usage: build-image.sh WORKDIR}
L=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$L/../../.." && pwd)
CA=${LAB_TEST_SERVER_DIR:?}/tls/ca.crt
BUILDER=${LAB_BUILDX_BUILDER:-orbit-mr-lab}
SHA=$(git -C "$REPO" rev-parse HEAD)
# The name single-writer.py imports the image under and pins.
IMAGE_NAME=$(sed -n "s/^IMAGE_NAME = '\(.*\)'$/\1/p" "$L/single-writer.py")
[ -n "$IMAGE_NAME" ] || { echo "no IMAGE_NAME in single-writer.py" >&2; exit 1; }
[ -z "$(git -C "$REPO" status --porcelain -- deploy/managed-runner/image src/runner-go)" ] || { echo "uncommitted image sources" >&2; exit 1; }
docker buildx inspect "$BUILDER" >/dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
rm -rf "$W" && mkdir -p "$W/ctx" "$W/lab-ctx"
git -C "$REPO" archive HEAD | tar -x -C "$W/ctx"
echo "$SHA" > "$W/source-sha"
started=$(date +%s)
docker buildx build --builder "$BUILDER" --file "$W/ctx/deploy/managed-runner/image/Dockerfile" \
  --build-arg ORBIT_SOURCE_SHA="$SHA" --provenance=false \
  --output "type=oci,dest=$W/product.oci.tar,name=docker.io/library/orbit-cloud-runner:browser-${SHA:0:9}" \
  "$W/ctx"
echo "product build: $(( $(date +%s) - started )) s"
mkdir -p "$W/product-oci" && tar -xf "$W/product.oci.tar" -C "$W/product-oci"
rm -f "$W/product.oci.tar"
DIGEST=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifests"][0]["digest"])' "$W/product-oci/index.json")
echo "product manifest: $DIGEST"
cp "$CA" "$W/lab-ctx/ca.crt"
started=$(date +%s)
docker buildx build --builder "$BUILDER" --build-context "base=oci-layout://$W/product-oci@$DIGEST" \
  --file "$L/lab-ca-image.Dockerfile" --provenance=false \
  --output "type=oci,dest=$W/lab.oci.tar,name=$IMAGE_NAME:lab-${SHA:0:9}" \
  "$W/lab-ctx"
echo "lab CA build: $(( $(date +%s) - started )) s"
rm -rf "$W/product-oci" "$W/ctx"
ls -la "$W"/*.tar
