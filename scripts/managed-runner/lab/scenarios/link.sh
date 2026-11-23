#!/usr/bin/env bash
# The runner link for the lab test server (runners speak only over it). Run after `test-server.sh start ...`, which
# rewrites api.env: this appends the link settings and restarts the apiserver.
#   [LAB_NATS=1] link.sh start|stop
# Gateway: src/link-gateway built from this checkout, plain on 127.0.0.1:13714, behind a socat TLS front on
# 127.0.0.1:13713 with the lab's cert (SAN 10.0.2.2), which Pods reach as wss://10.0.2.2:13713. With LAB_NATS=1 also
# NATS for the browser's byte streams (the viewer route), from the repo's nats.conf.
set -euo pipefail
S=${LAB_TEST_SERVER_DIR:?}
L=$(cd "$(dirname "$0")/.." && pwd)
R=$(cd "$L/../../.." && pwd)
K=$S/link
GW=orbit-mr-lab-link-gw
FRONT=orbit-mr-lab-link-tls
case "${1:-}" in
  start)
    umask 077; mkdir -p "$K" "$S/logs"
    [ -s "$K/gateway_token" ] || openssl rand -base64 32 | tr -d '\n' > "$K/gateway_token"
    [ -s "$K/runner-link.pem" ] || openssl genpkey -algorithm ed25519 -out "$K/runner-link.pem"
    (cd "$R/src/link-gateway" && CGO_ENABLED=0 go build -trimpath -o "$K/link-gateway" .)
    grep -q '^RUNNER_LINK_URL=' "$S/secrets/api.env" || cat >> "$S/secrets/api.env" <<ENV
RUNNER_LINK_SIGNING_KEY=$(base64 -w0 "$K/runner-link.pem")
RUNNER_LINK_URL=wss://10.0.2.2:13713
RUNNER_LINK_GATEWAY_TOKEN=$(cat "$K/gateway_token")
RUNNER_LINK_INTERNAL_PORT=13715
ENV
    cat > "$K/gateway.env" <<ENV
LINK_LISTEN_ADDR=127.0.0.1:13714
LINK_METRICS_ADDR=127.0.0.1:13716
LINK_TLS_MODE=off
LINK_PUBLIC_KEYS=$(openssl pkey -in "$K/runner-link.pem" -pubout | base64 -w0)
LINK_GATEWAY_TOKEN=$(cat "$K/gateway_token")
LINK_API_URL=http://127.0.0.1:13710
LINK_INTERNAL_API_URLS=http://127.0.0.1:13715
ENV
    if [ "${LAB_NATS:-0}" = 1 ]; then
      if [ ! -s "$K/nats-keys.env" ]; then
        a=$("$K/link-gateway" nkey); g=$("$K/link-gateway" nkey)
        { echo "API_SEED=$(sed -n 's/^seed=//p' <<<"$a")"; echo "API_KEY=$(sed -n 's/^public=//p' <<<"$a")"
          echo "GW_SEED=$(sed -n 's/^seed=//p' <<<"$g")"; echo "GW_KEY=$(sed -n 's/^public=//p' <<<"$g")"; } > "$K/nats-keys.env"
      fi
      . "$K/nats-keys.env"
      docker rm -f orbit-mr-lab-nats >/dev/null 2>&1 || true
      docker run -d --name orbit-mr-lab-nats --label orbit.lab=test-server --memory 128m -p 127.0.0.1:13717:4222 \
        -e RUNNER_LINK_NATS_APISERVER_KEY="$API_KEY" -e RUNNER_LINK_NATS_GATEWAY_KEY="$GW_KEY" \
        -v "$R/src/link-gateway/nats.conf:/etc/orbit-nats/nats.conf:ro" nats:2.15-alpine --config /etc/orbit-nats/nats.conf >/dev/null
      grep -q '^RUNNER_LINK_NATS_URL=' "$S/secrets/api.env" || printf 'RUNNER_LINK_NATS_URL=nats://127.0.0.1:13717\nRUNNER_LINK_NATS_SEED=%s\n' "$API_SEED" >> "$S/secrets/api.env"
      printf 'LINK_NATS_URL=nats://127.0.0.1:13717\nLINK_NATS_SEED=%s\n' "$GW_SEED" >> "$K/gateway.env"
    fi
    systemctl restart orbit-mr-lab-api
    for _ in $(seq 100); do curl -sf -o /dev/null http://127.0.0.1:13710/api/health && break; sleep 3; done
    systemctl is-active --quiet "$GW" || systemd-run --unit="$GW" --collect --quiet -p MemoryMax=256M \
      -p EnvironmentFile="$K/gateway.env" -p StandardOutput=append:"$S/logs/link-gateway.log" \
      -p StandardError=append:"$S/logs/link-gateway.log" "$K/link-gateway"
    systemctl is-active --quiet "$FRONT" || systemd-run --unit="$FRONT" --collect --quiet -p MemoryMax=128M \
      -p StandardOutput=append:"$S/logs/link-tls.log" -p StandardError=append:"$S/logs/link-tls.log" \
      "$(command -v socat)" "OPENSSL-LISTEN:13713,bind=127.0.0.1,reuseaddr,fork,cert=$S/tls/server.pem,verify=0" TCP:127.0.0.1:13714
    sleep 2
    echo "apiserver $(systemctl is-active orbit-mr-lab-api), gateway $(systemctl is-active $GW), front $(systemctl is-active $FRONT)"
    grep -i "runner link" "$S/logs/apiserver.log" | tail -3 | cut -c1-200 || true
    tail -3 "$S/logs/link-gateway.log" | cut -c1-200 ;;
  stop) systemctl stop "$FRONT" "$GW" 2>/dev/null || true; docker rm -f orbit-mr-lab-nats >/dev/null 2>&1 || true ;;
  *) echo "usage: link.sh start|stop" >&2; exit 2 ;;
esac
