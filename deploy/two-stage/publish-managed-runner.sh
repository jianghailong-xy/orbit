#!/usr/bin/env bash
# Publishes the hosted runners' (Orbit Cloud's) image of a release tag: builds deploy/managed-runner/image/Dockerfile from
# the tag's commit, with its runner reporting the release version (the tag without its "v", 0.1.261-beta.83), and pushes
# it to ORBIT_REGISTRY as orbit-cloud-runner:<version>. /release runs it on the build host (workspace orbit-ws04) right
# after it pushes the tag (.claude/skills/release/SKILL.md, "Orbit Cloud runner image"), since the registry is reached
# only over WireGuard; a two-stage deploy then takes the image of the newest tag at or behind the commit it deploys
# (deploy/two-stage/release.sh) and builds none.
#
#   ORBIT_REGISTRY=<host:port> publish-managed-runner.sh <vX.Y.Z[-beta.N]> [--no-cache]
#
# A tag whose image is in the registry already is left as it is, so running this again is safe. The build reads the tag's
# commit through git archive, never the working tree, and this checkout stays on whatever it has checked out. A tag this
# checkout does not have is fetched from origin.
set -euo pipefail

TAG=""
NO_CACHE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-cache) NO_CACHE=1 ;;
    -*) echo "error: unknown argument: $1" >&2; exit 2 ;;
    *)
      [ -z "$TAG" ] || { echo "error: one release tag at a time (got $TAG and $1)" >&2; exit 2; }
      TAG="$1"
      ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
REGISTRY="${ORBIT_REGISTRY:-}"
# shellcheck source=deploy/two-stage/registry.sh
. "$REPO_ROOT/deploy/two-stage/registry.sh"

if ! [[ "$REGISTRY" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "error: ORBIT_REGISTRY must be the registry's host[:port], such as 10.66.0.1:5000 (it is \"$REGISTRY\")" >&2
  exit 2
fi
if ! [[ "$TAG" =~ $RELEASE_TAG_PATTERN ]]; then
  echo "error: give the release tag to publish, such as v0.1.261-beta.83 (got \"$TAG\")" >&2
  exit 2
fi
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "==> $TAG is not in this checkout: fetching it from origin"
  git fetch --quiet --no-tags origin "refs/tags/$TAG:refs/tags/$TAG" || {
    echo "error: origin has no tag $TAG. /release pushes the tag first; publish it once the tag is on origin." >&2
    exit 1
  }
fi
COMMIT="$(git rev-parse "refs/tags/$TAG^{commit}")"
VERSION="${TAG#v}"
# The tag names the version of record, as release.yml checks: the root package.json's version at that commit.
PACKAGE_VERSION="$(git show "$COMMIT:package.json" | sed -nE 's/^  "version": *"([^"]*)".*/\1/p' | head -n 1)"
if [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  echo "error: $TAG's package.json says version \"$PACKAGE_VERSION\", not $VERSION: that is no release of this repository." >&2
  exit 1
fi
if ! managed_runner_of_tag "$TAG"; then
  echo "error: $TAG ($COMMIT) predates release-built hosted runner images: its deploy/managed-runner/image/Dockerfile" >&2
  echo "       takes no ORBIT_RELEASE_VERSION, so its runner could not report $VERSION. Publish a later release." >&2
  exit 1
fi

echo "==> The hosted runners' image of $TAG: $MR_IMAGE, from $COMMIT"
if in_registry "$MR_IMAGE"; then
  echo "✓ $MR_IMAGE is in $REGISTRY already ($(registry_digest "$MR_IMAGE")); nothing was built"
  exit 0
fi
push_preflight

CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/orbit-cloud-runner-$VERSION.XXXXXX")"
trap 'rm -rf "$CONTEXT"' EXIT
# What the Dockerfile reads, as its Dockerfile.dockerignore admits it, at the tag's commit.
git archive --format=tar "$COMMIT" -- src/runner-go deploy/managed-runner/image | tar -x -C "$CONTEXT"
FLAGS=()
if [ "$NO_CACHE" -eq 1 ]; then FLAGS+=(--no-cache); fi
echo "==> Building $MR_IMAGE"
docker build ${FLAGS[@]+"${FLAGS[@]}"} --provenance=false -f "$CONTEXT/deploy/managed-runner/image/Dockerfile" \
  --build-arg "ORBIT_SOURCE_SHA=$COMMIT" --build-arg "ORBIT_RELEASE_VERSION=$VERSION" -t "$MR_IMAGE" "$CONTEXT"

# What the deploy and the Docker channel read of it: its labels, and the version its runner reports.
LABELS="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' "$MR_IMAGE")"
if [ "$LABELS" != "$COMMIT $VERSION" ]; then
  echo "error: $MR_IMAGE is labelled revision and version \"$LABELS\", not \"$COMMIT $VERSION\". Nothing was pushed." >&2
  exit 1
fi
REPORTED="$(docker run --rm --network none --entrypoint /usr/local/bin/orbit "$MR_IMAGE" version)"
if [ "$REPORTED" != "$VERSION" ]; then
  echo "error: the runner in $MR_IMAGE reports version \"$REPORTED\", not $VERSION. Nothing was pushed." >&2
  exit 1
fi
echo "    labels: revision $COMMIT, version $VERSION; its runner reports $REPORTED"
echo "==> Pushing $MR_IMAGE"
docker push "$MR_IMAGE"
echo "✓ $MR_IMAGE is in $REGISTRY ($(registry_digest "$MR_IMAGE")). A two-stage deploy of $TAG's commit, or of any commit"
echo "  after it up to the next release, moves the hosted runners onto it."
