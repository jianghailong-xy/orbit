#!/bin/sh
# Keep the runner release a web image replaces downloadable from the image that replaces it.
#
#   retain-runner-release.sh PREVIOUS_DL DL
#
# DL is this image's /dl, holding the release it publishes (scripts/build-binaries.sh). PREVIOUS_DL
# is the /dl of the image it replaces, which may not exist at all. Of the two releases that one
# published — its own at PREVIOUS_DL and the one it kept at PREVIOUS_DL/previous — the newest that is
# older than this image's goes to DL/previous: what was the latest when the version moved on, and what
# was already kept when the same version is built again. The control plane then holds runners at it
# during a staged rollout, or rolls them back to it (src/apiserver/src/runner-api/runner-release.ts).
#
# A release is kept only with the sha256 of every asset its version.json names, and only when every
# asset still has it. Keeping nothing is never an error: the image then publishes one release, as
# images did before this script.
#
# POSIX sh plus sort -V and sha256sum, as busybox has them: it runs in src/web/Dockerfile's nginx:alpine.
set -eu

previous_dl="$1"
dl="$2"

version_of() {
  grep -o '"version":"[^"]*"' "$1" 2>/dev/null | head -n 1 | cut -d '"' -f 4
}

# older A B: A is a lower version than B.
older() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

current="$(version_of "$dl/version.json")"
if [ -z "$current" ]; then
  echo "retain-runner-release: $dl/version.json names no version" >&2
  exit 1
fi

keep=""
keep_version=""
for candidate in "$previous_dl" "$previous_dl/previous"; do
  v="$(version_of "$candidate/version.json")"
  if [ -n "$v" ] && older "$v" "$current" && { [ -z "$keep_version" ] || older "$keep_version" "$v"; }; then
    keep="$candidate"
    keep_version="$v"
  fi
done
if [ -z "$keep" ]; then
  echo "retain-runner-release: no release older than $current to keep; /dl publishes $current alone"
  exit 0
fi

# Each asset as `<sha256>  <file>`, the form sha256sum -c reads: one line per entry of "assets".
digests="$(grep -o '"file":"[^"]*","sha256":"[^"]*"' "$keep/version.json" |
  sed 's/^"file":"\([^"]*\)","sha256":"\([^"]*\)"$/\2  \1/')" || true
if [ -z "$digests" ]; then
  echo "retain-runner-release: $keep_version predates asset digests; not keeping it"
  exit 0
fi
if ! (cd "$keep" && printf '%s\n' "$digests" | sha256sum -c >/dev/null 2>&1); then
  echo "retain-runner-release: $keep_version's assets do not match its version.json; not keeping it" >&2
  exit 0
fi

mkdir -p "$dl/previous"
cp "$keep/version.json" "$dl/previous/version.json"
printf '%s\n' "$digests" | while read -r _ file; do
  cp "$keep/$file" "$dl/previous/$file"
done
echo "retain-runner-release: /dl publishes $current, and $keep_version at /dl/previous"
