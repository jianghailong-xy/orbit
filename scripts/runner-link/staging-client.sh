#!/usr/bin/env bash
# Runs the link gateway's test client (link-gateway client, src/link-gateway/README.md) against the staging stack, as
# the probe runner staging-up.sh registered: from the stack's own link gateway image, with the seeded runner token and
# the staging CA. Arguments go to the client; the defaults send heartbeats over HTTPS and mirror them with a small event
# batch each.
#
#   scripts/runner-link/staging-client.sh -duration 60s
#   scripts/runner-link/staging-client.sh -until-drains 1 -summary /tmp/summary.json
#
# The client's summary file and capture, when asked for, are written under <state>/client/ (that directory is
# mounted at the same path in the container).
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
token_file="$state/secrets/runner_token"
[ -s "$token_file" ] || die "no probe runner token in $token_file: run staging-up.sh first"
mkdir -p "$state/client"

image="$project-link-gateway:local"
tls_mode="$(setting STAGING_TLS files)"
if [ "$tls_mode" = acme ]; then
  # The gateway's name resolves only inside the project's network, and its certificate chains to the root Pebble made
  # when it started, which its management port hands out.
  curl -sk "https://127.0.0.1:$(setting STAGING_PEBBLE_MGMT_PORT 15000)/roots/0" > "$state/client/acme-root.pem"
  network=(--network "${project}_default")
  api="http://apiserver:3000"
  ca="$state/client/acme-root.pem"
else
  network=(--network host)
  api="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
  ca="$state/tls/ca.pem"
fi

# The defaults come first, so an argument given here overrides them (-http=false, -events 0).
exec docker run --rm "${network[@]}" \
  -v "$state/client:$state/client" -v "$ca:/etc/orbit-link-staging/ca.pem:ro" \
  -e LINK_CLIENT_RUNNER_TOKEN="$(cat "$token_file")" \
  "$image" client -api "$api" -ca /etc/orbit-link-staging/ca.pem -http -events 2 "$@"
