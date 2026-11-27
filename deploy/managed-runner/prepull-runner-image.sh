#!/usr/bin/env bash
# Pull a release's Orbit Cloud runner image onto this k3s node before any runner needs it.
#
#   deploy/managed-runner/prepull-runner-image.sh 10.66.0.1:5000/orbit-cloud-runner@sha256:<64 hex>
#
# Run as root on the node, right after the release tag's image is published (.claude/skills/release/SKILL.md, "Orbit
# Cloud runner image"). Give it the reference by digest that publish-managed-runner.sh prints and that a deploy writes
# into the profile's runner.image. A runner's Pod pulls with IfNotPresent: the first Pod on a new image waited for its
# 1.5 GB pull before any container started, 116 s on 2026-11-25, while the ones after it started in about 9 s. Pulled
# here, that first start is as quick as the rest.
#
# An image the node has already is left as it is. Nothing else on the node is changed: no Pod, no other image.
set -euo pipefail

REF="${1:-}"
if ! [[ "$REF" =~ ^[^@[:space:]]+/orbit-cloud-runner@sha256:[0-9a-f]{64}$ ]]; then
  echo "error: give the runner image by digest, <registry>/orbit-cloud-runner@sha256:<64 hex> (got \"$REF\")" >&2
  exit 2
fi
if [ "$#" -ne 1 ]; then
  echo "error: one image at a time" >&2
  exit 2
fi

# k3s ships crictl as a subcommand; a node with crictl of its own on PATH uses that.
if command -v k3s >/dev/null 2>&1; then
  crictl() { k3s crictl "$@"; }
elif ! command -v crictl >/dev/null 2>&1; then
  echo "error: neither k3s nor crictl is on PATH: this is not a k3s node" >&2
  exit 1
fi

if crictl inspecti "$REF" >/dev/null 2>&1; then
  echo "✓ $REF is on this node already; nothing was pulled"
  exit 0
fi

echo "==> Pulling $REF"
started=$SECONDS
if ! crictl pull "$REF"; then
  echo "error: the pull of $REF failed. Is the registry listed in /etc/rancher/k3s/registries.yaml" >&2
  echo "       (docs/managed-runner-k3s-xfs-deployment.md, \"From the registry, with each release\")?" >&2
  exit 1
fi
if ! crictl inspecti "$REF" >/dev/null 2>&1; then
  echo "error: $REF was pulled, yet the node does not find it by that reference" >&2
  exit 1
fi
echo "✓ $REF is on this node (pulled in $((SECONDS - started)) s); the first runner to start on it does not wait for it"
