#!/usr/bin/env bash
# /upgrade's two-stage release (.claude/skills/upgrade/SKILL.md, "Two-stage release"). The build stage runs here: it
# builds the apiserver, web and link gateway images from this checkout, boots the apiserver and web images as CI does,
# and pushes all three to ORBIT_REGISTRY, each tagged by the commit it was built from. The hosted runners' image
# (deploy/managed-runner/image) is not built here: /release publishes it when it creates a release tag
# (deploy/two-stage/publish-managed-runner.sh), and a deploy takes the image of the newest release tag at or behind the
# commit it deploys, or stops before changing anything when that image is not in the registry. The deploy stage runs on
# ORBIT_DEPLOY_HOST, driven from here over ssh: deploy/two-stage/deploy-stage.sh pulls those images there and recreates
# what changed, and builds nothing. That host holds no checkout: this script ships it the release's Compose file and the
# few files it mounts, taken from the commit, never from the working tree.
#
# Both copies of /upgrade's script start this once they hold the upgrade lock and have checked and pulled the checkout,
# whenever ORBIT_REGISTRY is set; run it through them.
#
#   release.sh [--build-only | --deploy <commit> | --plan <commit>] [--no-cache] [--pull-base] [--prune] [--stop-then-start]
#
# --plan prints what deploying the commit would change on the target, from its .env and files as they are, and leaves
# the target as it found it: the files it puts in place to render the release are put back, no image is pulled, and
# nothing is written to .env or brought up.
#
# The deploy replaces the apiserver and web without a gap: the release's container starts beside the running one, and
# the web gateway is handed over to it before the running one stops (deploy/two-stage/deploy-stage.sh). The running
# release's code runs meanwhile against the database as the new one's migrations leave it, so a release whose migration
# that code cannot run against is deployed with --stop-then-start: each running one stops before its replacement starts,
# as every release did before, and the web gateway answers 502 until the new one is healthy.
#
#   ORBIT_REGISTRY      the registry both hosts' Docker pull from and this one pushes to, host[:port] (required)
#   ORBIT_DEPLOY_HOST   the ssh destination of the host that runs the deployment, such as root@10.66.0.4 (required to deploy)
#   ORBIT_DEPLOY_DIR    the deployment's directory there (default /root/orbit)
#   ORBIT_BUILD_MIN_FREE_GB  the room a build needs on this host's Docker disk, in GiB (default 15); below it the build
#                       stage makes room first (make_room)
set -euo pipefail

MODE=release
COMMIT=""
NO_CACHE=0
PULL_BASE=0
PRUNE=0
STOP_THEN_START=0
while [ $# -gt 0 ]; do
  case "$1" in
    --build-only) MODE=build ;;
    --deploy|--plan)
      [ $# -ge 2 ] || { echo "error: $1 needs the commit of the release to deploy" >&2; exit 2; }
      MODE="${1#--}"
      COMMIT="$2"
      shift
      ;;
    --no-cache) NO_CACHE=1 ;;
    --pull-base) PULL_BASE=1 ;;
    --prune) PRUNE=1 ;;
    --stop-then-start) STOP_THEN_START=1 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
REGISTRY="${ORBIT_REGISTRY:-}"
HOST="${ORBIT_DEPLOY_HOST:-}"
DIR="${ORBIT_DEPLOY_DIR:-/root/orbit}"
# What the deployment's Compose reads from its directory besides .env and ./data: the files and directories it bind-mounts,
# the env file it may name, and the two Compose files a target lists in COMPOSE_FILE beside docker-compose.yml, with what
# they mount: deploy/postgres-pinned.yml, the only pin of postgres and pgbackup, and deploy/db-proxy.yml, the database
# entry. test/upgrade-two-stage.test.mjs holds this list to those files.
RELEASE_FILES=(docker-compose.yml gateway scripts/pg-archive-wal.sh scripts/pg-backup.sh src/link-gateway/nats.conf deploy/runner-link
  deploy/postgres-pinned.yml deploy/db-proxy.yml deploy/db-proxy deploy/monitoring scripts/pg-monitor-role.sh)
# in_registry, registry_digest, push_preflight, and the release tag that names the hosted runners' image.
# shellcheck source=deploy/two-stage/registry.sh
. "$REPO_ROOT/deploy/two-stage/registry.sh"

# Every value that reaches the other host's shell is one of these shapes, so none of them needs quoting there.
if ! [[ "$REGISTRY" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "error: ORBIT_REGISTRY must be the registry's host[:port], such as 10.66.0.1:5000 (it is \"$REGISTRY\")" >&2
  exit 2
fi
if [ "$MODE" != build ]; then
  if ! [[ "$HOST" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9.:-]+$ ]]; then
    echo "error: ORBIT_DEPLOY_HOST must name the host to deploy to, as ssh takes it, such as root@10.66.0.4" >&2
    echo "       (it is \"$HOST\"); pass --build-only to build and push without deploying." >&2
    exit 2
  fi
  if ! [[ "$DIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "error: ORBIT_DEPLOY_DIR must be an absolute path (it is \"$DIR\")" >&2
    exit 2
  fi
fi
HEAD_COMMIT="$(git rev-parse HEAD)"
if [ "$MODE" = deploy ] || [ "$MODE" = plan ]; then
  if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || ! git cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
    echo "error: --$MODE takes a release's full 40-character commit, one this checkout has (it got \"$COMMIT\")" >&2
    exit 2
  fi
else
  COMMIT="$HEAD_COMMIT"
  # A tag names the commit its image was built from, so the build has to be of that commit and say so.
  if [ "${ORBIT_SOURCE_SHA:-$COMMIT}" != "$COMMIT" ]; then
    echo "error: ORBIT_SOURCE_SHA ($ORBIT_SOURCE_SHA) is not this checkout's commit ($COMMIT): a release is tagged by the" >&2
    echo "       commit it is built from, so check that commit out instead. Nothing was built." >&2
    exit 2
  fi
  export ORBIT_SOURCE_SHA="$COMMIT"
fi
if ! git cat-file -e "$COMMIT:deploy/two-stage/base-images.env" 2>/dev/null; then
  echo "error: $COMMIT predates the two-stage release (it has no deploy/two-stage/base-images.env), so its Compose" >&2
  echo "       file builds its images where it runs. It cannot be released this way." >&2
  exit 2
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
on_target() { "${SSH[@]}" "$HOST" "$@"; }

# The release a commit names: its three images, and the base images its deploy/two-stage/base-images.env pins (postgres,
# pgbackup and db-proxy are pinned in the Compose files that run them, which the deploy ships).
release_of() {
  local base name value
  APISERVER_IMAGE="$REGISTRY/orbit-apiserver:$1"
  WEB_IMAGE="$REGISTRY/orbit-web:$1"
  # The link gateway's image is named by the last commit under src/link-gateway, its whole build context, so a release
  # that did not change it recreates nothing.
  LINK_TAG="$(git log -1 --format=%H "$1" -- src/link-gateway)"
  if ! [[ "$LINK_TAG" =~ ^[0-9a-f]{40}$ ]]; then
    echo "error: no commit up to $1 touches src/link-gateway, so its link gateway image has no name" >&2
    exit 1
  fi
  LINK_IMAGE="$REGISTRY/orbit-link-gateway:$LINK_TAG"
  # The hosted runners' image is the newest release tag's at or behind the commit, as the downloadable runner is, so a
  # deploy between two releases moves no hosted runner (managed_runner_of_tag sets MR_IMAGE, MR_REVISION, MR_VERSION).
  # None for a commit without deploy/managed-runner/image, with no release tag behind it, or whose newest tag predates
  # release-built images: the hosted runners' profile is then left as it is.
  MR_RELEASE_TAG=""
  MR_REVISION=""
  MR_VERSION=""
  MR_IMAGE=""
  MR_WHY=""
  if git cat-file -e "$1:deploy/managed-runner/image/Dockerfile" 2>/dev/null; then
    local tag
    tag="$(release_tag_at "$1")"
    if [ -z "$tag" ]; then
      MR_WHY="no release tag (v*) is at or behind $1"
    elif ! managed_runner_of_tag "$tag"; then
      MR_WHY="$tag, the newest release tag at or behind $1, predates release-built hosted runner images"
    fi
  fi
  base="$(git show "$1:deploy/two-stage/base-images.env")"
  for name in ORBIT_NGINX_IMAGE ORBIT_NATS_IMAGE ORBIT_PROMETHEUS_IMAGE ORBIT_NODE_EXPORTER_IMAGE ORBIT_POSTGRES_EXPORTER_IMAGE ORBIT_GRAFANA_IMAGE ORBIT_LOKI_IMAGE ORBIT_ALLOY_IMAGE; do
    value="$(printf '%s\n' "$base" | sed -n "s/^$name=//p" | tail -n 1)"
    if ! [[ "$value" =~ ^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
      echo "error: $1's deploy/two-stage/base-images.env does not pin $name as <repository>@sha256:<64 hex>" >&2
      exit 1
    fi
    printf -v "$name" '%s' "$value"
  done
}

# Stops the run before anything is changed when the hosted runners' image of this release is not in the registry. Only
# /release publishes it, from the tag, on this host.
managed_runner_published() {
  if [ -n "$MR_WHY" ]; then
    echo "warning: the hosted runners' image is left as it is: $MR_WHY." >&2
    return 0
  fi
  [ -n "$MR_IMAGE" ] || return 0
  if ! in_registry "$MR_IMAGE"; then
    echo "error: $MR_IMAGE, the hosted runners' image of $MR_RELEASE_TAG (the newest release tag at or behind $COMMIT)," >&2
    echo "       is not in $REGISTRY. /release publishes it when it creates the tag; publish it on this host with:" >&2
    echo "       ORBIT_REGISTRY=$REGISTRY deploy/two-stage/publish-managed-runner.sh $MR_RELEASE_TAG" >&2
    echo "       Nothing was built or changed." >&2
    exit 1
  fi
}

# The web image now serving carries the runner release runners run today; the image built next keeps it at /dl/previous/
# (src/web/Dockerfile), as a single host's upgrade does, by the same tag. It is the one the deployment's host serves, or,
# before that host has served any, the one this host does.
PREVIOUS_RELEASE_ARG=""
previous_release() {
  local serving=""
  if [ -n "$HOST" ]; then
    serving="$(on_target "cd $DIR 2>/dev/null && docker compose ps -q web 2>/dev/null | xargs -r docker inspect --format '{{.Config.Image}}'" 2>/dev/null || true)"
    if [ -n "$serving" ] && ! docker image inspect "$serving" >/dev/null 2>&1 && ! docker pull "$serving" >/dev/null; then
      echo "warning: could not pull $serving, the web image $HOST serves" >&2
      serving=""
    fi
  fi
  if [ -z "$serving" ]; then serving="$(docker inspect --format '{{.Image}}' orbit-web 2>/dev/null || true)"; fi
  if [ -n "$serving" ] && docker tag "$serving" orbit-web:previous-release; then
    PREVIOUS_RELEASE_ARG="PREVIOUS_RELEASE_IMAGE=orbit-web:previous-release"
  else
    echo "warning: no orbit-web image to carry the runner release over from — the new web image keeps no previous one" >&2
  fi
}

# GiB free on the filesystem that holds Docker's data, or / where Docker does not say.
free_gb() {
  local root
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null | head -n 1 || true)"
  [ -d "$root" ] || root=/
  df -Pk "$root" | awk 'NR == 2 { print int($4 / 1048576) }'
}

# The build stage's room. A release build needs about ORBIT_BUILD_MIN_FREE_GB on Docker's disk: the hosted runners' image
# alone is about 4.4 GiB, and the build cache behind it several times that. Below it, room is made before anything is
# built, in this order, each step only while the disk is still short:
#   1. the registry's release images on this host, but for this release's own: every one is in the registry, which is
#      where a deploy and a rollback pull from, so nothing needs the copy here. One a container uses is kept (rmi
#      refuses it), and so is orbit-web:previous-release, which the next web image is built from.
#   2. dangling images;
#   3. build cache older than a week, then all of it, so the next build starts cold.
# Still short, the build stops before it starts, saying what fills the disk.
make_room() {
  local need="${ORBIT_BUILD_MIN_FREE_GB:-15}" free ref removed=0 keep
  if ! [[ "$need" =~ ^[0-9]+$ ]]; then
    echo "error: ORBIT_BUILD_MIN_FREE_GB must be a whole number of GiB (it is \"$need\")" >&2
    exit 2
  fi
  free="$(free_gb)"
  if [ "$free" -ge "$need" ]; then return 0; fi
  echo "==> $free GiB free on $(hostname)'s Docker disk, under the $need GiB a build needs: making room"
  keep=" $APISERVER_IMAGE $WEB_IMAGE $LINK_IMAGE ${MR_IMAGE} "
  while IFS= read -r ref; do
    case "$ref" in "$REGISTRY"/orbit-*:*) ;; *) continue ;; esac
    case "$keep" in *" $ref "*) continue ;; esac
    if docker rmi "$ref" >/dev/null 2>&1; then
      echo "    removed $ref (it is in $REGISTRY)"
      removed=$((removed + 1))
    fi
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}')
  echo "    $removed earlier release image(s) removed"
  free="$(free_gb)"
  if [ "$free" -lt "$need" ]; then
    echo "==> $free GiB free: pruning dangling images"
    docker image prune -f >/dev/null
    free="$(free_gb)"
  fi
  if [ "$free" -lt "$need" ]; then
    echo "==> $free GiB free: pruning build cache older than a week"
    docker builder prune -f --filter until=168h >/dev/null
    free="$(free_gb)"
  fi
  if [ "$free" -lt "$need" ]; then
    echo "==> $free GiB free: pruning all build cache (this build starts cold)"
    docker builder prune -af >/dev/null
    free="$(free_gb)"
  fi
  if [ "$free" -lt "$need" ]; then
    echo "error: $free GiB free on $(hostname)'s Docker disk after removing earlier release images and pruning, under the" >&2
    echo "       $need GiB a build needs. Something besides Docker's images and build cache fills it: see df -h and" >&2
    echo "       docker system df there. Nothing was built." >&2
    docker system df >&2 || true
    exit 1
  fi
  echo "==> $free GiB free: room made"
}

build_stage() {
  local absent=() image flags=()
  release_of "$COMMIT"
  echo "==> Build stage, on $(hostname): release $COMMIT for $REGISTRY"
  # A release that goes on to be deployed is refused here already, before its build, rather than after it.
  if [ "$MODE" = release ]; then managed_runner_published; fi
  for image in "$APISERVER_IMAGE" "$WEB_IMAGE" "$LINK_IMAGE"; do
    if in_registry "$image"; then
      echo "    $image is in the registry already, and a tag names one build: it is kept"
    else
      absent+=("$image")
    fi
  done
  if [ "${#absent[@]}" -eq 0 ]; then
    echo "==> Every image of release $COMMIT is in $REGISTRY already; nothing to build"
    return 0
  fi
  push_preflight
  make_room
  if [ "$NO_CACHE" -eq 1 ]; then flags+=(--no-cache); fi
  # Compose names the images it builds by these, as the deployment's host will name the ones it pulls.
  export ORBIT_IMAGE_TAG="$COMMIT" ORBIT_LINK_GATEWAY_TAG="$LINK_TAG"
  if [[ " ${absent[*]} " == *" $APISERVER_IMAGE "* || " ${absent[*]} " == *" $WEB_IMAGE "* ]]; then
    previous_release
    echo "==> Building $APISERVER_IMAGE and $WEB_IMAGE from this checkout"
    docker compose build ${flags[@]+"${flags[@]}"} ${PREVIOUS_RELEASE_ARG:+--build-arg "$PREVIOUS_RELEASE_ARG"} apiserver wiki-worker web
    echo "==> Booting both, as CI does, before either is pushed (scripts/image-boot-check.sh)"
    ORBIT_APISERVER_IMAGE="$APISERVER_IMAGE" ORBIT_WEB_IMAGE="$WEB_IMAGE" bash scripts/image-boot-check.sh
  fi
  if [[ " ${absent[*]} " == *" $LINK_IMAGE "* ]]; then
    # Without a provenance attestation, as a single host builds it: an image of the same content keeps its ID.
    echo "==> Building $LINK_IMAGE from src/link-gateway"
    docker build ${flags[@]+"${flags[@]}"} --provenance=false --build-arg "ORBIT_SOURCE_SHA=$LINK_TAG" -t "$LINK_IMAGE" src/link-gateway
  fi
  for image in "${absent[@]}"; do
    echo "==> Pushing $image"
    docker push "$image"
  done
  if [ "$PRUNE" -eq 1 ]; then
    echo "==> Pruning dangling images on $(hostname)"
    docker image prune -f
  fi
}

deploy_stage() {
  local image stage=".upgrade/release-$COMMIT" status=0 plan=0
  if [ "$MODE" = plan ]; then plan=1; fi
  release_of "$COMMIT"
  if [ "$plan" -eq 1 ]; then
    echo "==> Plan of the deploy stage, on $HOST in $DIR: release $COMMIT (nothing there is changed)"
  else
    echo "==> Deploy stage, on $HOST in $DIR: release $COMMIT"
  fi
  for image in "$APISERVER_IMAGE" "$WEB_IMAGE" "$LINK_IMAGE"; do
    if ! in_registry "$image"; then
      echo "error: $image is not in $REGISTRY. Build the release first, on a checkout of $COMMIT:" >&2
      echo "       upgrade.sh --build-only. Nothing was changed on $HOST." >&2
      exit 1
    fi
  done
  managed_runner_published
  # A hosted runner's profile on the target names this image by digest, with the tag's commit and release version, and
  # its runners move onto it once idle.
  MR_REF=""
  if [ -n "$MR_IMAGE" ]; then
    MR_REF="$(registry_digest "$MR_IMAGE")"
    echo "==> The hosted runners' image is $MR_RELEASE_TAG's: $MR_IMAGE ($MR_REVISION)"
  fi
  echo "==> Shipping $COMMIT's Compose file and the files it mounts (${RELEASE_FILES[*]}), and the deploy stage"
  git archive --format=tar --prefix="$stage/" "$COMMIT" -- "${RELEASE_FILES[@]}" \
    | on_target "mkdir -p $DIR/.upgrade && cd $DIR && rm -rf $stage && tar -x"
  on_target "cat > $DIR/.upgrade/deploy-stage.sh" <deploy/two-stage/deploy-stage.sh
  on_target "ORBIT_DEPLOY_DIR=$DIR ORBIT_RELEASE_COMMIT=$COMMIT ORBIT_REGISTRY=$REGISTRY ORBIT_LINK_GATEWAY_TAG=$LINK_TAG \
ORBIT_NGINX_IMAGE=$ORBIT_NGINX_IMAGE ORBIT_NATS_IMAGE=$ORBIT_NATS_IMAGE \
ORBIT_PROMETHEUS_IMAGE=$ORBIT_PROMETHEUS_IMAGE ORBIT_NODE_EXPORTER_IMAGE=$ORBIT_NODE_EXPORTER_IMAGE ORBIT_POSTGRES_EXPORTER_IMAGE=$ORBIT_POSTGRES_EXPORTER_IMAGE ORBIT_GRAFANA_IMAGE=$ORBIT_GRAFANA_IMAGE ORBIT_LOKI_IMAGE=$ORBIT_LOKI_IMAGE ORBIT_ALLOY_IMAGE=$ORBIT_ALLOY_IMAGE ORBIT_MANAGED_RUNNER_IMAGE=$MR_REF ORBIT_MANAGED_RUNNER_REVISION=$MR_REVISION ORBIT_MANAGED_RUNNER_VERSION=$MR_VERSION \
ORBIT_DEPLOY_PULL_BASE=$PULL_BASE ORBIT_DEPLOY_PRUNE=$PRUNE ORBIT_DEPLOY_PLAN=$plan ORBIT_DEPLOY_STOP_THEN_START=$STOP_THEN_START \
bash $DIR/.upgrade/deploy-stage.sh" || status=$?
  if [ "$status" -eq 255 ]; then
    echo "error: the connection to $HOST was lost (ssh exit 255). If the deploy stage had started, it goes on there and" >&2
    echo "       finishes on its own; its log is $HOST:$DIR/.upgrade/deploy.log." >&2
  fi
  return "$status"
}

case "$MODE" in
  release) build_stage; deploy_stage ;;
  build) build_stage ;;
  deploy|plan) deploy_stage ;;
esac
case "$MODE" in
  build) echo "✓ Release $COMMIT is in $REGISTRY. Deploy it with: upgrade.sh --deploy $COMMIT" ;;
  plan) echo "✓ Planned release $COMMIT on $HOST, and changed nothing there. Deploy it with: upgrade.sh --deploy $COMMIT" ;;
  *)
    echo "✓ Release $COMMIT runs on $HOST. To roll back, deploy the one before it (its commit is in"
    echo "  $HOST:$DIR/.upgrade/history): upgrade.sh --deploy <commit>, with the same ORBIT_REGISTRY and ORBIT_DEPLOY_HOST."
    ;;
esac
