#!/usr/bin/env bash
# Apply xfs-reflink.patch to a clean Ceph-CSI v3.18.2 checkout and run its unit test.
# Needs git and a Go toolchain; the ceph-csi go.mod asks for Go 1.26.4, so
# GOTOOLCHAIN=auto may download it on first use.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
version=v3.18.2
commit=2ae061402d436cf742ada728229898ac30f2e633

command -v git >/dev/null || { echo "verify.sh: git is required" >&2; exit 1; }
command -v go >/dev/null || { echo "verify.sh: go is required" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --branch "$version" \
  https://github.com/ceph/ceph-csi.git "$tmp/ceph-csi"
cd "$tmp/ceph-csi"

got=$(git rev-parse HEAD)
if [ "$got" != "$commit" ]; then
  echo "verify.sh: expected $commit, got $got" >&2
  exit 1
fi

git apply --check "$here/xfs-reflink.patch"
git apply "$here/xfs-reflink.patch"

unformatted=$(gofmt -l internal/rbd/nodeserver.go internal/rbd/xfs_reflink_test.go)
if [ -n "$unformatted" ]; then
  echo "verify.sh: gofmt needed: $unformatted" >&2
  exit 1
fi

if [ ! -f /usr/include/rados/librados.h ] && [ ! -f /usr/include/rbd/librbd.h ]; then
  echo "verify.sh: Ceph client headers missing (librados-dev, librbd-dev);" >&2
  echo "           run this in the ceph-csi devel container or install them" >&2
  exit 2
fi

GOTOOLCHAIN=auto go test -mod=vendor ./internal/rbd -run '^TestXfsReflinkArgs$'
echo "verify.sh: patch applies and TestXfsReflinkArgs passes"
