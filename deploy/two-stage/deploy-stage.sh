#!/usr/bin/env bash
# The deploy stage of /upgrade's two-stage release (.claude/skills/upgrade/SKILL.md, "Two-stage release"). It runs on the
# host that runs the deployment, in the deployment's directory, which holds no checkout and no source: its own .env and
# ./data, the files the build host ships for each release, and nothing else. deploy/two-stage/release.sh, on the build
# host, has just put this release's files under .upgrade/release-<commit>/ there, and starts this script over ssh with
# what the release names:
#
#   ORBIT_DEPLOY_DIR         the deployment's directory
#   ORBIT_RELEASE_COMMIT     the commit the apiserver and web images were built from, and their tag
#   ORBIT_REGISTRY           the registry every image is pulled from
#   ORBIT_LINK_GATEWAY_TAG   the link gateway image's tag: the last commit under src/link-gateway
#   ORBIT_NGINX_IMAGE, ORBIT_NATS_IMAGE
#                            the base images by digest, from that commit's deploy/two-stage/base-images.env (postgres,
#                            pgbackup and db-proxy are pinned by deploy/postgres-pinned.yml and deploy/db-proxy.yml)
#   ORBIT_DEPLOY_PULL_BASE   1 lets a running postgres whose configuration changed be recreated (upgrade.sh --pull-base)
#   ORBIT_DEPLOY_PRUNE       1 prunes dangling images once the release runs (upgrade.sh --prune)
#   ORBIT_DEPLOY_PLAN        1 prints the plan and stops there, having changed nothing (upgrade.sh --plan)
#
# Nothing is built here. Every image is pulled before anything is recreated, every `up` says --no-build, and a release
# that names an image anywhere but the registry is refused.
set -euo pipefail

for name in ORBIT_DEPLOY_DIR ORBIT_RELEASE_COMMIT ORBIT_REGISTRY ORBIT_LINK_GATEWAY_TAG ORBIT_NGINX_IMAGE ORBIT_NATS_IMAGE; do
  if [ -z "${!name:-}" ]; then
    echo "error: $name is not set. deploy/two-stage/release.sh starts this script; run upgrade.sh on the build host." >&2
    exit 2
  fi
done
DIR="$ORBIT_DEPLOY_DIR"
COMMIT="$ORBIT_RELEASE_COMMIT"
REGISTRY="$ORBIT_REGISTRY"
LINK_TAG="$ORBIT_LINK_GATEWAY_TAG"
RELEASE_ENV=(
  "ORBIT_REGISTRY=$REGISTRY"
  "ORBIT_IMAGE_TAG=$COMMIT"
  "ORBIT_LINK_GATEWAY_TAG=$LINK_TAG"
  "ORBIT_NGINX_IMAGE=$ORBIT_NGINX_IMAGE"
  "ORBIT_NATS_IMAGE=$ORBIT_NATS_IMAGE"
)
PULL_BASE="${ORBIT_DEPLOY_PULL_BASE:-0}"
PRUNE="${ORBIT_DEPLOY_PRUNE:-0}"
PLAN="${ORBIT_DEPLOY_PLAN:-0}"
# From here on Compose reads the release from release_dc's environment below, and then from .env, as anyone's would.
unset ORBIT_REGISTRY ORBIT_IMAGE_TAG ORBIT_LINK_GATEWAY_TAG ORBIT_NGINX_IMAGE ORBIT_NATS_IMAGE
STAGE=".upgrade/release-$COMMIT"
cd "$DIR"
mkdir -p .upgrade

# The build host drives this over ssh. A connection lost halfway must not stop it between stopping a container and
# starting the one that replaces it, so it ignores the hangup and the broken pipe, which every command it starts
# inherits, and tee -p keeps writing the log here once the way back is gone. The log is the record either way.
trap '' HUP PIPE
exec > >(tee -p -a .upgrade/deploy.log) 2>&1
if [ "$PLAN" = 1 ]; then
  echo "==> $(date -u +%Y-%m-%dT%H:%M:%SZ): planning $COMMIT on $(hostname) in $DIR, which changes nothing here"
else
  echo "==> $(date -u +%Y-%m-%dT%H:%M:%SZ): deploying $COMMIT on $(hostname) in $DIR"
fi

# The same lock as /upgrade's script on a single host, /tmp/orbit-upgrade.lock: one upgrade at a time on this host, a
# second one refused at once, and a lock whose holder is gone taken over. (TMPDIR is unset over ssh; tests set it.)
LOCK_DIR="${TMPDIR:-/tmp}/orbit-upgrade.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "error: another upgrade is already in progress on this host (pid $LOCK_PID, lock: $LOCK_DIR)." >&2
    echo "       Nothing was changed. Wait for it to finish, or check: docker compose ps" >&2
    exit 1
  fi
  echo "warning: taking over a stale upgrade lock (holder ${LOCK_PID:-unknown} is gone)" >&2
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "error: another upgrade claimed the stale lock first" >&2
    exit 1
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT
echo "$$" >"$LOCK_DIR/pid"

if [ ! -f "$STAGE/docker-compose.yml" ]; then
  echo "error: $DIR/$STAGE holds no docker-compose.yml: the build host ships it before it starts this script." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "error: $DIR has no .env. This host keeps its own settings and secrets there; a deploy writes only the lines" >&2
  echo "       naming the release it runs (SKILL.md, \"Two-stage release\"). Nothing was changed." >&2
  exit 1
fi
# The release's names go into .env (below), between these two lines and nowhere else.
BEGIN="# >>> The release this host runs: written by /upgrade's two-stage deploy, and replaced whole by the next one"
END="# <<< The release this host runs"
begins="$(grep -cxF "$BEGIN" .env || true)"
ends="$(grep -cxF "$END" .env || true)"
if [ "$begins" != "$ends" ] || [ "$begins" -gt 1 ] \
  || { [ "$begins" -eq 1 ] && [ "$(grep -nxF "$BEGIN" .env | cut -d: -f1)" -gt "$(grep -nxF "$END" .env | cut -d: -f1)" ]; }; then
  echo "error: the release's lines in .env are not as a deploy writes them: one \"$BEGIN\"" >&2
  echo "       line, then one \"$END\" line. Fix them by hand. Nothing was changed." >&2
  exit 1
fi

# The release's files go in place first, each whole by a rename, as Compose has to read them where they are: a file it
# names relative to this directory, an env_file say, is read here. A running container that bind-mounts one of them keeps
# the file it started on, which the plan below compares with the new one for db-proxy, the gateway and pgbackup. The files
# they replace wait in .upgrade/previous/ until the release's images are all here: a deploy that stops before then, and a
# plan, which always stops there, put them back and take away the files and directories they added, so that they have
# changed nothing.
PREVIOUS=.upgrade/previous
rm -rf "$PREVIOUS"
FILES=()
MADE=()
while read -r file; do FILES+=("$file"); done < <(cd "$STAGE" && find . -type f | sed 's|^\./||' | sort)
for file in "${FILES[@]}"; do
  made=""
  IFS=/ read -ra parts <<<"$(dirname "$file")"
  for part in "${parts[@]}"; do
    made="${made:+$made/}$part"
    if [ ! -d "$made" ]; then MADE=("$made" ${MADE[@]+"${MADE[@]}"}); fi
  done
  mkdir -p "$(dirname "$file")" "$PREVIOUS/$(dirname "$file")"
  if [ -e "$file" ]; then cp -p "$file" "$PREVIOUS/$file"; fi
  mv -f "$STAGE/$file" "$file"
done
rm -rf "$STAGE"
# Every file as it was, and no directory the release's files made: MADE has each one before the one it is in.
put_back() {
  local file
  for file in "${FILES[@]}"; do
    if [ -e "$PREVIOUS/$file" ]; then mv -f "$PREVIOUS/$file" "$file"; else rm -f "$file"; fi
  done
  for file in ${MADE[@]+"${MADE[@]}"}; do rmdir "$file" 2>/dev/null || true; done
  rm -rf "$PREVIOUS"
}
# Stops the deploy before .env names the release: the files it replaced go back, and nothing else was changed.
refuse() {
  for line in "$@"; do echo "$line" >&2; done
  put_back
  echo "       This host's files are as they were, and nothing was changed." >&2
  exit 1
}

# This release as Compose renders it here: the files Compose reads in this directory (docker-compose.yml and
# docker-compose.override.yml, or what COMPOSE_FILE in .env lists) with the release's names, which win over .env's.
release_dc() { env "${RELEASE_ENV[@]}" docker compose "$@"; }
release_dc config --quiet || refuse "error: Compose cannot render this release with this host's .env and files (above)."
# sed reads to the end: nothing Compose prints is cut short, and none of it is shown.
PROJECT="$(release_dc config 2>/dev/null | sed -n 's/^name: //p')"
SERVICES="$(release_dc config --services)"
listed() { printf '%s\n' "$SERVICES" | grep -x "$1" >/dev/null; }
if ! listed apiserver; then
  refuse "error: the Compose files this host reads do not include the release's docker-compose.yml (COMPOSE_FILE in .env?)."
fi
if listed docker-channel || listed managed-runner-firewall; then
  refuse "error: this host's .env switches on managed runners, whose images (docker-channel, managed-runner-firewall and" \
    "       the runners') are built where they run, and a two-stage release builds nothing here."
fi

# The single host's check, here: the deployment's mounts are relative, so a postgres of the name this release renders
# that keeps its archive anywhere else belongs to another directory, which this one must not be deployed over.
PG_NAME="$(release_dc config postgres 2>/dev/null | awk '/^[[:space:]]*container_name:/ { found = $2 } END { print found }')"
PG_NAME="${PG_NAME:-orbit-postgres}"
ARCHIVE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/archive"}}{{.Source}}{{end}}{{end}}' "$PG_NAME" 2>/dev/null || true)"
if [ -n "$ARCHIVE" ] && [ "$ARCHIVE" != "$DIR/data/pg-archive" ]; then
  refuse "error: $PG_NAME runs from ${ARCHIVE%/data/pg-archive}, not from $DIR: its /archive is $ARCHIVE." \
    "       Its mounts are relative, so deploying here would bind this directory's ./data."
fi

# What the deploy brings up, in the order Compose's depends_on gives them: db-proxy, where this host's COMPOSE_FILE lists
# deploy/db-proxy.yml, between postgres and the apiserver, which connects through it, and nats before the apiserver, which
# publishes to it. Any other service this host's files list is left as it is.
ORDER=(postgres db-proxy nats apiserver)
while read -r service; do ORDER+=("$service"); done < <(printf '%s\n' "$SERVICES" | grep -xE 'apiserver-[0-9]+' || true)
ORDER+=(wiki-worker web link-gateway gateway pgbackup)
DEPLOYED=()
for service in "${ORDER[@]}"; do
  if listed "$service"; then DEPLOYED+=("$service"); fi
done

# The file each of these services bind-mounts on its own, and where: a running container keeps the one it started on, and
# Compose sees no change in it, so a new one reaches the service only by recreating it.
declare -A MOUNTED=(
  [db-proxy]="/usr/local/etc/haproxy/haproxy.cfg deploy/db-proxy/haproxy.cfg"
  [gateway]="/etc/nginx/conf.d/default.conf gateway/nginx.conf"
  [pgbackup]="/usr/local/bin/pg-backup.sh scripts/pg-backup.sh"
)

# The plan: this release's config hash for each service against the hash its container was made with, and for those
# services, the file the running container has against the release's. STATE says what `up` does with it, RUNNING whether
# a container of it runs now, and FORCE that only a forced recreate brings it the release's file. Compose lists the
# services in no set order.
HASHES="$(release_dc config --hash '*' | sort)"
declare -A STATE=() RUNNING=() FORCE=()
echo "==> What this release changes, by each service's compose config hash"
while read -r service hash; do
  ids=()
  while read -r id; do ids+=("$id"); done < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$service" --filter "label=com.docker.compose.oneoff=False")
  RUNNING[$service]=false
  if [ "${#ids[@]}" -eq 0 ]; then
    STATE[$service]=create
  else
    read -r running made <<<"$(docker inspect -f '{{.State.Running}} {{index .Config.Labels "com.docker.compose.config-hash"}}' "${ids[0]}")"
    RUNNING[$service]="$running"
    if [ "$made" != "$hash" ]; then
      STATE[$service]=recreate
    elif [ "$running" = true ]; then
      STATE[$service]=unchanged
    else
      STATE[$service]=start
    fi
  fi
  note=""
  if [[ " ${DEPLOYED[*]} " != *" $service "* ]]; then
    note=" (a deploy leaves it as it is)"
  elif [ "$service" = postgres ] && [ "${STATE[$service]}" = recreate ] && [ "${RUNNING[$service]}" = true ] && [ "$PULL_BASE" != 1 ]; then
    note=" (left running: only --pull-base recreates a running postgres)"
  elif [ "$service" = pgbackup ] && [ "${STATE[$service]}" != create ] && [ "${RUNNING[$service]}" != true ]; then
    note=" (left stopped, as on a single host)"
  elif [ -n "${MOUNTED[$service]:-}" ] && [ "${RUNNING[$service]}" = true ] \
    && ! docker exec "${ids[0]}" cat "${MOUNTED[$service]%% *}" </dev/null | cmp -s - "${MOUNTED[$service]#* }"; then
    FORCE[$service]=1
    STATE[$service]=recreate
    note=" (it runs another ${MOUNTED[$service]#* })"
  fi
  printf '    %-16s %s%s\n' "$service" "${STATE[$service]}" "$note"
done <<<"$HASHES"

# Every image, before anything changes. Each comes from the registry, or this release is not one this host can run.
while read -r image; do
  case "$image" in
    "$REGISTRY"/*) ;;
    *)
      refuse "error: this release names $image, which is not in $REGISTRY: a two-stage deploy builds nothing here, and" \
        "       every image comes from the registry. postgres and pgbackup take theirs from deploy/postgres-pinned.yml," \
        "       which this host's COMPOSE_FILE (in .env) has to list after docker-compose.yml."
      ;;
  esac
done < <(release_dc config --images "${DEPLOYED[@]}")
if [ "$PLAN" = 1 ]; then
  put_back
  echo "✓ Planned $COMMIT on $(hostname). Nothing was pulled, written or brought up, and this host's files are as they were."
  exit 0
fi
echo "==> Pulling this release's images from $REGISTRY"
release_dc pull "${DEPLOYED[@]}" || refuse "error: an image of this release could not be pulled (above)."

# The release's names go into .env, so that any later `docker compose` here renders what this deploy ran. Only the lines
# between BEGIN and END are written, and the whole file is replaced by a rename: every other line stays as it was.
cp -p .env .upgrade/env.new
{
  awk -v begin="$BEGIN" -v end="$END" '$0 == begin { skip = 1; next } $0 == end { skip = 0; next } !skip' .env
  printf '%s\n' "$BEGIN" "${RELEASE_ENV[@]}" "$END"
} >.upgrade/env.new
mv -f .upgrade/env.new .env
rm -rf "$PREVIOUS"
if [ "$(docker compose config --hash '*' | sort)" != "$HASHES" ]; then
  echo "error: with the release's lines in .env, Compose renders something other than this release. Nothing was" >&2
  echo "       recreated; check the lines between \"$BEGIN\" and \"$END\" in .env." >&2
  exit 1
fi

# From here on, plain `docker compose`, as anyone on this host would run it.
up() { docker compose up -d --wait --no-deps --no-build "$@"; }
NOTICES=()
for service in "${DEPLOYED[@]}"; do
  state="${STATE[$service]:-create}"
  case "$service" in
    postgres)
      if [ "$state" = recreate ] && [ "${RUNNING[$service]}" = true ] && [ "$PULL_BASE" != 1 ]; then
        NOTICES+=("!!  postgres was NOT recreated: its configuration in this release differs from the one it runs. To apply it,
!!  accepting a database restart: upgrade.sh --pull-base --deploy $COMMIT")
      elif [ "$state" != unchanged ]; then
        echo "==> postgres: $state"
        up postgres
      fi
      ;;
    apiserver)
      echo "==> apiserver: $state (it applies database migrations as it starts)"
      up apiserver
      ;;
    pgbackup)
      # As on a single host, with one difference: a sidecar this host has never run is created, as the first deploy needs.
      if [ "$state" != create ] && [ "${RUNNING[$service]}" != true ]; then
        NOTICES+=("!!  pgbackup was NOT updated: it is stopped here, so its script and mounts stay as they were. To update it,
!!  run this in $DIR: docker compose up -d --no-deps --force-recreate pgbackup")
      elif [ -n "${FORCE[$service]:-}" ]; then
        echo "==> pgbackup: recreated to run this release's ${MOUNTED[$service]#* }"
        up --force-recreate pgbackup
      else
        echo "==> pgbackup: $state"
        up pgbackup
      fi
      ;;
    *)
      # db-proxy and gateway, recreated for the file the plan found they do not run: db-proxy's haproxy.cfg ends every
      # database connection once, and the apiserver's reconnect on their own (docs/postgres-standby.md).
      if [ -n "${FORCE[$service]:-}" ]; then
        echo "==> $service: recreated to run this release's ${MOUNTED[$service]#* }"
        up --force-recreate "$service"
      else
        echo "==> $service: $state"
        up "$service"
      fi
      ;;
  esac
done

echo "==> Stack status"
docker compose ps
if [ "$PRUNE" = 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $COMMIT link-gateway=$LINK_TAG" >>.upgrade/history
for notice in ${NOTICES[@]+"${NOTICES[@]}"}; do printf '%s\n' "$notice" >&2; done
echo "✓ Deployed $COMMIT on $(hostname). Its releases so far, newest last, are in $DIR/.upgrade/history."
