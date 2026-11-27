# What deploy/two-stage/release.sh and deploy/two-stage/publish-managed-runner.sh both ask of the registry, and which
# release tag names the hosted runners' image. Sourced, with REGISTRY set to the registry's host[:port].

# Whether the registry has an image: yes or no, and anything else stops the run rather than being taken for a no.
in_registry() {
  local out
  if out="$(docker manifest inspect --insecure "$1" 2>&1 >/dev/null)"; then return 0; fi
  case "$out" in
    *"no such manifest"*|*"manifest unknown"*|*"not found"*) return 1 ;;
  esac
  echo "error: could not ask $REGISTRY about $1: $out" >&2
  exit 1
}

# The image by the digest the registry serves it under, <repository>@sha256:<64 hex>: how a hosted runner's profile names
# it (runner.image is pinned by digest), and what the node pulls.
registry_digest() {
  local digest
  digest="$(docker manifest inspect -v --insecure "$1" | grep -m1 -oE '"digest": *"sha256:[0-9a-f]{64}"' | grep -oE 'sha256:[0-9a-f]{64}' || true)"
  if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "error: $REGISTRY did not say which digest $1 has" >&2
    exit 1
  fi
  printf '%s@%s\n' "${1%:*}" "$digest"
}

# A registry served over plain HTTP, as one reached only over a private network may be, takes a push from a Docker
# daemon that lists it among its insecure-registries, and from no other. Checked before a build it would come too late for.
push_preflight() {
  case "$REGISTRY" in localhost:*|127.*) return 0 ;; esac
  curl -fsS -m 10 -o /dev/null "http://$REGISTRY/v2/" 2>/dev/null || return 0
  if ! docker info --format '{{range $name, $config := .RegistryConfig.IndexConfigs}}{{$name}} {{$config.Secure}}{{println}}{{end}}' \
    | grep -x "$REGISTRY false" >/dev/null; then
    echo "error: $REGISTRY serves plain HTTP, and this host's Docker does not list it among its insecure-registries, so" >&2
    echo "       nothing could be pushed there. Add \"insecure-registries\": [\"$REGISTRY\"] to /etc/docker/daemon.json and" >&2
    echo "       run systemctl reload docker (running containers stay up), then this again. Nothing was built." >&2
    exit 1
  fi
}

# A release tag: v, then the version of record (the root package.json's), such as v0.1.261-beta.83.
RELEASE_TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

# The hosted runners' image of a release tag, built from the tag's commit with the release version
# (publish-managed-runner.sh): MR_RELEASE_TAG the tag, MR_REVISION its commit, MR_VERSION the version without the "v", and
# MR_IMAGE <registry>/orbit-cloud-runner:<version>. Returns 1, with all four empty, for a tag whose commit has no
# deploy/managed-runner/image or whose Dockerfile predates release versions (ORBIT_RELEASE_VERSION): no image of it can
# report the release.
managed_runner_of_tag() {
  MR_RELEASE_TAG=""
  MR_REVISION=""
  MR_VERSION=""
  MR_IMAGE=""
  local commit
  [[ "$1" =~ $RELEASE_TAG_PATTERN ]] || return 1
  commit="$(git rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null || true)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  # grep reads to the end: `grep -q` exits at its match, and git show still writing then dies of SIGPIPE, which the
  # callers' pipefail turned into "no ORBIT_RELEASE_VERSION" (v0.1.261-beta.94, about 3% of runs under systemd-run).
  git show "$commit:deploy/managed-runner/image/Dockerfile" 2>/dev/null | grep '^ARG ORBIT_RELEASE_VERSION' >/dev/null || return 1
  MR_RELEASE_TAG="$1"
  MR_REVISION="$commit"
  MR_VERSION="${1#v}"
  MR_IMAGE="$REGISTRY/orbit-cloud-runner:$MR_VERSION"
}

# The newest release tag at or behind a commit, as /upgrade picks the downloadable runner's (docs/release-process.md,
# "Runner binaries come from the release tag"); empty when there is none.
release_tag_at() {
  git describe --tags --abbrev=0 --match 'v[0-9]*' "$1" 2>/dev/null || true
}
