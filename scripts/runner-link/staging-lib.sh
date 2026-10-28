# Sourced by staging-up.sh, staging-down.sh and staging-client.sh: where the runner link staging stack lives and how
# Compose is run for it (README.md beside this file).
#
# The stack is the root docker-compose.yml under its own Compose project, with staging.compose.yml on top (and
# staging.acme.compose.yml in the ACME TLS mode, staging.loadgen.compose.yml for a load test). Compose runs with an
# empty environment plus the env file staging-up.sh writes, so nothing from the calling shell, an agent session's
# ORBIT_* variables included, reaches the stack: Compose prefers the shell's environment to an env file.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
project="${ORBIT_LINK_STAGING_PROJECT:-orbit-link-staging}"
# Every container, image and database these scripts act on is named after the project. A deployment's are orbit-*
# (docker-compose.yml's orbit-postgres, orbit-apiserver, …), so a project outside orbit-link-* could name them, and a
# script would stop, rebuild or write into a deployment. Refused before anything else runs (staging-name-check.sh).
if ! [[ "$project" =~ ^orbit-link-[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "staging: ORBIT_LINK_STAGING_PROJECT=$project does not start with orbit-link- followed by lowercase letters," \
    "digits, - or _: a staging stack's project is orbit-link-<name>, which no deployment's containers are named after" >&2
  exit 2
fi
state="${ORBIT_LINK_STAGING_DIR:-/var/tmp/$project}"
env_file="$state/compose.env"

die() { echo "staging: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }

# setting NAME DEFAULT: the value staging-up.sh recorded in the env file, else DEFAULT.
setting() {
  local value=""
  if [ -f "$env_file" ]; then
    value="$(sed -n "s/^$1=//p" "$env_file" | tail -n 1)"
  fi
  printf '%s' "${value:-$2}"
}

compose_files() {
  printf '%s\n' -f "$repo/docker-compose.yml" -f "$here/staging.compose.yml"
  if [ "$(setting STAGING_TLS files)" = acme ]; then
    printf '%s\n' -f "$here/staging.acme.compose.yml"
  fi
  if [ "$(setting STAGING_LOADGEN 0)" = 1 ]; then
    printf '%s\n' -f "$here/staging.loadgen.compose.yml"
  fi
  if [ "$(setting STAGING_GATEWAYS 1)" = 2 ]; then
    printf '%s\n' -f "$here/staging.gateways.compose.yml"
  fi
  # The apiservers past apiserver-b (extra_backends), which staging-up.sh writes for ORBIT_LINK_STAGING_BACKENDS of 3 or
  # more.
  if [ -f "$state/backends.compose.yml" ]; then
    printf '%s\n' -f "$state/backends.compose.yml"
  fi
}

# extra_backends [N]: the apiservers past the first that N backends take (N defaults to the stack's
# ORBIT_LINK_STAGING_BACKENDS), one name a line: apiserver-b (staging.compose.yml), then apiserver-c and on.
extra_backends() {
  local n="${1:-$(setting STAGING_BACKENDS 1)}" letters=bcdefghijklmnop i
  for ((i = 0; i < n - 1; i++)); do
    printf 'apiserver-%s\n' "${letters:i:1}"
  done
}

compose() {
  local files=()
  mapfile -t files < <(compose_files)
  env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    ${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} \
    docker compose -p "$project" --project-directory "$repo" --env-file "$env_file" "${files[@]}" "$@"
}

# One run at a time per state directory.
lock_state() {
  mkdir -p "$state"
  exec 9>"$state/.lock"
  flock -n 9 || die "another staging script is running on $state"
}
