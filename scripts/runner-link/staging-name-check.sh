#!/usr/bin/env bash
# Checks that every staging script refuses a Compose project outside orbit-link-* before it does anything
# (staging-lib.sh). A name such as `orbit` would point the scripts at a deployment's containers (orbit-postgres,
# orbit-apiserver, …: docker-compose.yml), and loadgen-seed.sh would write a fleet into its database.
#
# Each script runs with such a name. docker, curl, node, git and the other tools the scripts call are stand-ins on PATH
# that only record being called. The script must exit 2 with the refusal, call none of them and create no state
# directory. Then the names of the stacks run so far, and the default, must pass.
#
#   scripts/runner-link/staging-name-check.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
for tool in docker curl node git openssl jq flock systemd-run systemctl go psql base64; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/called"\n' "$tool" "$work" > "$work/bin/$tool"
  chmod +x "$work/bin/$tool"
done

scripts=(staging-up.sh staging-down.sh staging-client.sh staging-check.sh staging-check-link.sh staging-check-switch.sh
  loadgen-seed.sh loadgen-run.sh)
refused=(orbit orbit-postgres orbit-apiserver orbit-link orbit-link- orbit-linkx Orbit-link-x orbit-link-X x-orbit-link-y
  orbit-link-a/../b "orbit-link-a b" orbit-link-.hidden)
fail=0
checked=0
for name in "${refused[@]}"; do
  for script in "${scripts[@]}"; do
    rm -f "$work/called"
    rc=0
    # `seed` gets loadgen-seed.sh past its own usage check; every script must stop before it reads arguments at all.
    out="$(PATH="$work/bin:$PATH" ORBIT_LINK_STAGING_PROJECT="$name" ORBIT_LINK_STAGING_DIR="$work/state" \
      bash "$here/$script" seed 2>&1)" || rc=$?
    checked=$((checked + 1))
    if [ "$rc" != 2 ] || ! grep -q "does not start with orbit-link-" <<<"$out" || [ -e "$work/called" ] || [ -e "$work/state" ]; then
      echo "FAIL: $script with ORBIT_LINK_STAGING_PROJECT='$name': exit $rc," \
        "called: $(tr '\n' ';' < "$work/called" 2>/dev/null || echo none), state directory: $([ -e "$work/state" ] && echo created || echo none)," \
        "said: ${out:0:200}"
      fail=1
    fi
  done
done

accepted=(orbit-link-staging orbit-link-b1 orbit-link-b4 orbit-link-b4a orbit-link-b4b orbit-link-b6 orbit-link-d0
  orbit-link-c2 orbit-link-c2b orbit-link-a_b)
for name in "${accepted[@]}" ""; do
  got="$(ORBIT_LINK_STAGING_PROJECT="$name" bash -c 'source "$1/staging-lib.sh" && printf %s "$project"' _ "$here" 2>&1)" || {
    echo "FAIL: ORBIT_LINK_STAGING_PROJECT='$name' was refused: $got"
    fail=1
    continue
  }
  want="${name:-orbit-link-staging}"
  if [ "$got" != "$want" ]; then
    echo "FAIL: ORBIT_LINK_STAGING_PROJECT='$name' gave project '$got', want '$want'"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "OK: ${#refused[@]} names refused by each of ${#scripts[@]} scripts ($checked runs) before anything ran;" \
    "${#accepted[@]} stack names and the default accepted"
fi
exit "$fail"
