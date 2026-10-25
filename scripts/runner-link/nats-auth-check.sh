#!/usr/bin/env bash
# Checks src/link-gateway/nats.conf on a real nats-server, the image docker-compose.yml runs: with either user's public
# key empty or unset the server refuses to start; with both, a client without a seed cannot connect, so it can neither
# read a session's live stream nor publish a runner's hints, and each user can do what it does and nothing of the
# other's (TestNATSAuthorizationOnARealServer, src/link-gateway/natsauth_test.go). The server is a throwaway container on
# a loopback port, with fresh keys; nothing is left behind.
#
#   scripts/runner-link/nats-auth-check.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
gw="$repo/src/link-gateway"
image="nats:2.15-alpine"
conf="$gw/nats.conf"
for tool in docker go; do
  command -v "$tool" >/dev/null || { echo "nats-auth-check: $tool is required" >&2; exit 1; }
done

scratch="$(mktemp -d)"
cid=""
cleanup() {
  [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

(cd "$gw" && go build -o "$scratch/link-gateway" .)
pair() { "$scratch/link-gateway" nkey; }
api="$(pair)"; gateway="$(pair)"
api_seed="$(sed -n 's/^seed=//p' <<<"$api")"; api_key="$(sed -n 's/^public=//p' <<<"$api")"
gateway_seed="$(sed -n 's/^seed=//p' <<<"$gateway")"; gateway_key="$(sed -n 's/^public=//p' <<<"$gateway")"
run=(docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true -v "$conf:/etc/orbit-nats/nats.conf:ro")

echo "==> with a key empty or unset, nats-server refuses to start"
for env in "-e RUNNER_LINK_NATS_APISERVER_KEY= -e RUNNER_LINK_NATS_GATEWAY_KEY=$gateway_key" \
           "-e RUNNER_LINK_NATS_GATEWAY_KEY=$gateway_key"; do
  # shellcheck disable=SC2086
  if out="$(timeout 20 "${run[@]}" $env "$image" --config /etc/orbit-nats/nats.conf 2>&1)"; then
    echo "nats-auth-check: nats-server started without both keys ($env):" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "    refused: $(tail -n 1 <<<"$out")"
done

echo "==> with both keys: what each user may do, and what a client without a seed may not"
cid="$("${run[@]}" -d -p 127.0.0.1::4222 -e "RUNNER_LINK_NATS_APISERVER_KEY=$api_key" -e "RUNNER_LINK_NATS_GATEWAY_KEY=$gateway_key" \
  "$image" --config /etc/orbit-nats/nats.conf)"
port="$(docker port "$cid" 4222/tcp | head -n 1 | sed 's/.*://')"
for _ in $(seq 1 50); do
  docker logs "$cid" 2>&1 | grep -q 'Server is ready' && break
  sleep 0.2
done
(cd "$gw" && LINK_TEST_NATS_AUTH_URL="nats://127.0.0.1:$port" LINK_TEST_NATS_APISERVER_SEED="$api_seed" \
  LINK_TEST_NATS_GATEWAY_SEED="$gateway_seed" go test -count=1 -run 'TestNATSAuthorizationOnARealServer' -v .)
echo "==> nats.conf holds on $(docker exec "$cid" nats-server --version 2>/dev/null || echo "$image")"
