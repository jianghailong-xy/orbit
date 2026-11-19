#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
cd "$repo"
suites=(shared apiserver runner-go web android orbitkit compose)
selected=' '
plan=false
range=''

die() {
  printf 'Merge check: %s\n' "$*" >&2
  exit 2
}

plan_path() {
  local path=$1 suite note=''
  local matches
  case "$path" in
    src/shared/*) matches=(shared apiserver web) ;;
    src/apiserver/*) matches=(apiserver) ;;
    src/runner-go/*) matches=(runner-go) ;;
    src/web/*) matches=(web) ;;
    src/android/*) matches=(android) ;;
    src/macos/OrbitKit/*) matches=(orbitkit) ;;
    # What test/compose-topology.test.mjs reads: the compose file, images, deploy overlays and their configs.
    docker-compose*.yml|Dockerfile*|*/Dockerfile*|deploy/*|test/compose-topology*|src/link-gateway/*|scripts/pg-backup.sh)
      matches=(compose) ;;
    docs/*|release-notes/*|*.md|*.mdx|*.rst|*.txt|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg|*.pdf|LICENSE|NOTICE|.gitignore|.gitattributes)
      return 0 ;;
    *)
      matches=(apiserver)
      note=' (fallback for an unmapped path)' ;;
  esac
  printf '  %q -> %s%s\n' "$path" "${matches[*]}" "$note"
  for suite in "${matches[@]}"; do
    if [[ $selected != *" $suite "* ]]; then
      selected+="$suite "
    fi
  done
}

if [[ ${1:-} == --plan ]]; then
  plan=true
  shift
  if [[ ${1:-} == --range ]]; then
    [[ $# == 2 && $2 == ?*..[!.]* ]] || die 'Usage: --plan --range BASE..TIP'
    range=$2
    shift 2
  elif [[ ${1:-} == -- ]]; then
    shift
  fi
fi

if [[ -n ${MERGE_CHECK_SUITES:-} ]]; then
  [[ $MERGE_CHECK_SUITES =~ ^[a-z-]+(,[a-z-]+)*$ ]] ||
    die 'MERGE_CHECK_SUITES must contain comma-separated suite names'
  IFS=, read -r -a forced <<< "$MERGE_CHECK_SUITES"
  for suite in "${forced[@]}"; do
    case "$suite" in
      shared|apiserver|runner-go|web|android|orbitkit|compose) selected+="$suite " ;;
      *) die "Unknown suite in MERGE_CHECK_SUITES: $suite" ;;
    esac
  done
  [[ $# == 0 && -z $range ]] || die 'Use MERGE_CHECK_SUITES or explicit paths/range, one at a time'
  printf 'Suite selection forced by MERGE_CHECK_SUITES=%s\n' "$MERGE_CHECK_SUITES"
elif $plan && [[ $# -gt 0 ]]; then
  for path in "$@"; do
    plan_path "$path"
  done
else
  [[ $# == 0 ]] || die 'Usage: merge-check.sh [--plan [--range BASE..TIP | PATH ...]]'
  if [[ -n $range ]]; then
    from=$(git rev-parse --verify --end-of-options "${range%%..*}^{commit}") || die "Invalid range: $range"
    to=$(git rev-parse --verify --end-of-options "${range#*..}^{commit}") || die "Invalid range: $range"
    printf 'Changed paths in %s\n' "$range"
  else
    base=${MERGE_CHECK_BASE:-origin/main}
    base_sha=$(git rev-parse --verify --quiet --end-of-options "$base^{commit}") ||
      die "Base '$base' is unavailable. Set MERGE_CHECK_BASE to an upstream ref or commit in this checkout."
    to=HEAD
    from=$(git merge-base "$to" "$base_sha") || die "No merge base between HEAD and $base"
    printf 'Changed paths from merge base of HEAD and %s (%s)\n' "$base" "$from"
  fi
  paths_file=$(mktemp)
  trap 'rm -f -- "$paths_file"' EXIT
  # Treat a rename as both a deletion and an addition, including moves between suites.
  git diff --no-renames --name-only -z "$from" "$to" -- > "$paths_file"
  while IFS= read -r -d '' path; do
    plan_path "$path"
  done < "$paths_file"
  rm -f -- "$paths_file"
  trap - EXIT
fi

planned=''
for suite in "${suites[@]}"; do
  if [[ $selected == *" $suite "* ]]; then
    planned="${planned:+$planned }$suite"
  fi
done
if [[ -z $planned ]]; then
  printf 'Suites: none (no code changes)\n'
else
  printf 'Suites: %s\n' "$planned"
fi
if $plan; then
  exit 0
fi

run_shared() (
  npm test -w @orbit/shared
)

run_apiserver() (
  cd src/apiserver
  npx tsc -p tsconfig.test.json
  local spec specs=()
  shopt -s nullglob
  for spec in build/*/*.spec.js; do
    if [[ $spec != *.pg.spec.js ]]; then
      specs+=("$spec")
    fi
  done
  [[ -n ${specs[0]:-} ]] || die 'No compiled apiserver unit specs found'
  node --test --test-concurrency=4 --test-timeout=300000 --test-force-exit "${specs[@]}"
)

run_runner_go() (
  local scratch
  scratch=$(mktemp -d /tmp/XXXXX)
  trap 'rm -rf -- "$scratch"' EXIT
  chmod 755 "$scratch"
  cd src/runner-go
  TMPDIR="$scratch" GOTMPDIR="$scratch" go test -timeout 30m ./... \
    -skip '^(TestRealCodexOnAChatGPTLogin|TestDshLifecycleShutdownAndResume)$'
)

run_web() (
  # The web build imports the built @orbit/shared, as the JavaScript CI job's root build provides.
  npm run build -w @orbit/shared
  npm run build -w @orbit/web
  npm test -w @orbit/web
)

run_android() (
  local init=${MERGE_CHECK_GRADLE_INIT:-}
  if [[ -n $init && $init != /* ]]; then
    init="$PWD/$init"
  fi
  if [[ -f /opt/android-sdk/orbit-env.sh ]]; then
    # shellcheck source=/dev/null
    source /opt/android-sdk/orbit-env.sh
  fi
  : "${ANDROID_HOME:=${ANDROID_SDK_ROOT:?Set ANDROID_HOME to the Android SDK}}"
  export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
  cd src/android
  set -- --no-daemon --max-workers=2
  if [[ -n $init ]]; then
    set -- "$@" -I "$init"
  fi
  bash ./gradlew "$@" :core:test :app:testDebugUnitTest
)

run_orbitkit() (
  if command -v swift >/dev/null; then
    cd src/macos/OrbitKit
    swift test
  else
    docker run --rm -v "$PWD:/repo" -w /repo/src/macos/OrbitKit swift:6.1 bash -euc '
      scratch=$(mktemp -d /tmp/orbitkit.XXXXXX)
      trap "rm -rf -- \"\$scratch\"" EXIT
      swift test --scratch-path "$scratch"
    '
  fi
)

run_compose() (
  npm run test:compose-topology
)

active=''
passed=' '
swift_unavailable=false
summarize() {
  local code=$? suite
  for suite in "${suites[@]}"; do
    if [[ $passed == *" $suite "* ]]; then
      printf '%s: ran and passed\n' "$suite"
    elif [[ $active == "$suite" ]]; then
      printf '%s: failed (exit %s)\n' "$suite" "$code" >&2
    elif [[ $suite == orbitkit ]] && $swift_unavailable; then
      printf '%s: skipped (Swift and Docker are unavailable)\n' "$suite"
    elif [[ $selected == *" $suite "* ]]; then
      printf '%s: skipped (stopped after %s failed)\n' "$suite" "$active"
    elif [[ -n ${MERGE_CHECK_SUITES:-} ]]; then
      printf '%s: skipped (excluded by MERGE_CHECK_SUITES)\n' "$suite"
    else
      printf '%s: skipped (no matching paths)\n' "$suite"
    fi
  done
}
trap summarize EXIT

for suite in "${suites[@]}"; do
  [[ $selected == *" $suite "* ]] || continue
  if [[ $suite == orbitkit ]] && ! command -v swift >/dev/null && ! command -v docker >/dev/null; then
    swift_unavailable=true
    continue
  fi
  active=$suite
  printf 'Running %s\n' "$suite"
  "run_${suite//-/_}"
  passed+="$suite "
  active=''
done
