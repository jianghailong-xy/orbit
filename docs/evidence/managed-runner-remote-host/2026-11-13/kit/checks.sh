#!/usr/bin/env bash
# The lab's checks, after `scenario.mjs accounts`: printed for the evidence README. No token is printed.
set -uo pipefail
source /mnt/data/tmp/34w2jF/kit/env.sh
source $K/tunnels.env
s() { echo; echo "### $*"; }
R1=$(docker exec $CHAN docker ps --filter label=orbit.managed-runner.kind=runner --format '{{.Names}}' | sort | head -1)
GW=$(docker exec $CHAN docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
D0=$(docker exec $CHAN sh -c "ip -4 -o addr show docker0 | awk '{sub(/\/.*/,\"\",\$4); print \$4}'")

s "The channel's /v1/info, from the server machine ($SERVER_IP, in allowPeers)"
docker exec $SERVER sh -c 'curl -s -H "Authorization: Bearer $(cat /work/orbit/data/managed-runners/orbit-lab-chan.token)" http://172.31.91.20:7300/v1/info | jq .'

s "What /upgrade prints on this remote-only profile: info.js in the apiserver container"
docker exec -i -w /work/orbit $SERVER docker compose exec -T apiserver node - < /root/.orbit/worktrees/cc29e4ef-3ea7-57f7-a720-04f6e30bcbab/deploy/managed-runner/docker-channel/info.js

s "Another source (the HPC host on $NET, 172.31.91.1) is refused before a byte is read"
curl -s -m 5 -o /dev/null -w 'curl from the HPC host: exit=%{exitcode} http=%{http_code}\n' http://$CHAN_IP:$CHAN_PORT/v1/info; echo "curl exit $?"
docker exec $CHAN docker logs orbit-docker-channel 2>&1 | grep -E 'refused a connection|listening' | tail -3

s "From inside runner container $R1, as its own user ($(docker exec $CHAN docker exec $R1 id -u)), with the firewall enforced"
docker exec $CHAN docker exec -u 10001 $R1 python3 -c 'import sys; print(open("/proc/self/status").read().split("Uid:")[1].split()[0])' >/dev/null
TARGETS=$(cat <<J
[["tcp","the channel's own listener (this host's private address)","$CHAN_IP",$CHAN_PORT],
 ["tcp","this host, port 22","$CHAN_IP",22],
 ["tcp","this host's address on the runners' network, the channel's port","$GW",$CHAN_PORT],
 ["tcp","this host's docker0","$D0",80],
 ["tcp","the server machine's gateway (private link)","$SERVER_IP",2086],
 ["tcp","the HPC host's LAN address","192.168.1.12",22],
 ["tcp","the HPC host's wg1 address","10.66.0.2",22],
 ["tcp","cloud metadata","169.254.169.254",80],
 ["tcp","a public address, port 443","1.1.1.1",443],
 ["https","the server's public https origin","$SERVER_URL/api/health"],
 ["https","a public https endpoint","https://www.cloudflare.com/cdn-cgi/trace"]]
J
)
docker exec -i $CHAN docker exec -i $R1 python3 - "$TARGETS" < $K/kit/reach.py

s "The firewall's own check and status on the channel machine"
docker exec -w /work/orbit $CHAN docker compose -f deploy/managed-runner/remote-host/compose.yml --env-file data/channel-host/compose.env run --rm --no-deps managed-runner-firewall check
docker exec $CHAN sh -c 'iptables -S DOCKER-USER | head -3; iptables -S ORBIT-MR-FORWARD | head -20'

s "remote-host.sh status on the channel machine"
docker exec -w /work/orbit $CHAN deploy/managed-runner/remote-host/remote-host.sh status

s "The server's .env lines and profile (no secrets)"
docker exec -w /work/orbit $SERVER sh -c 'grep -E "^(ORBIT_MANAGED_RUNNERS_|COMPOSE_PROFILES|PUBLIC_ORIGIN|RUNNER_LINK_URL)" .env; jq -c "{docker, runner: {image: .runner.image, serverUrl: .runner.serverUrl}}" data/managed-runners/profile.json; ls -la data/managed-runners'
docker exec -w /work/orbit $SERVER sh -c 'docker compose ps --format "{{.Service}}: {{.Status}}"; docker compose logs apiserver 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep -E "managed runners are|ManagedRunnerManager" | tail -8'
s "Each runner's link presence on the server"
docker exec $SERVER docker exec orbit-postgres psql -U orbit -d orbit -tAF ' ' -c "SELECT r.name, r.status, p.link_state, m.cluster_key, m.namespace, m.management_state, m.pod_name FROM managed_runner m JOIN runner r ON r.id = m.runner_id LEFT JOIN runner_presence p ON p.runner_id = r.id"
