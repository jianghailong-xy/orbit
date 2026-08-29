#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${AUTHORITATIVE_TARGET_MANIFEST_PATH:-$REPO/build/outcome-reconciler-authoritative-target-manifest.json}"

if [ "${AUTHORITATIVE_TARGET_ALLOW_UNPUSHED:-0}" = "1" ]; then
  mkdir -p "$(dirname "$MANIFEST")"
  node "$REPO/scripts/outcome-reconciler-authoritative-target.mjs" "$MANIFEST"
  exit 0
fi

REMOTE="$(git -C "$REPO" config --get remote.origin.url)"
[ -n "$REMOTE" ] || { echo '!! origin URL is missing' >&2; exit 1; }

CLONE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/orbit-authoritative-target.XXXXXX")"
cleanup() {
  rm -rf -- "$CLONE_ROOT"
}
trap cleanup EXIT

CHECKOUT="$CLONE_ROOT/checkout"
echo "==> authoritative-target: cloning origin/main into $CHECKOUT"
git clone --quiet --no-tags --single-branch --branch main "$REMOTE" "$CHECKOUT"
git -C "$CHECKOUT" fetch --quiet origin refs/heads/main:refs/remotes/origin/main

mkdir -p "$(dirname "$MANIFEST")"
node "$CHECKOUT/scripts/outcome-reconciler-authoritative-target.mjs" "$MANIFEST"

