#!/usr/bin/env bash
# lab.sh <step>: the lab's checks on the machine, printed for the evidence README. Steps:
#   listing <label>   the rules that decide a runner's packets: FORWARD, INPUT, DOCKER-USER, nat PREROUTING (numbered),
#                     this program's chains, both families
#   state             the firewall's check, show and status.json, and the service's log
#   reach             from a runner container (orbit-managed-runner:local, its user 10001) on orbit-managed-runners
#   restart           restart k3s and watch, every 0.5 s, which rule is first in FORWARD, INPUT and nat PREROUTING
#   before-program    the firewall program before this task (a5e20f8ef), on the same host: what it says, what a runner reaches
#   remove            the service stopped, `remove`, what is left; then the service started again
set -uo pipefail
source /mnt/data/tmp/34wdoS/kit/env.sh
on() { docker exec "$M" "$@"; }
ch() { docker exec -w /work/orbit "$M" docker compose -f deploy/managed-runner/remote-host/compose.yml --env-file data/channel-host/compose.env "$@"; }
s() { echo; echo "### $*"; }
step=$1; shift
case "$step" in
  listing)
    s "Rule listing: $* ($(date -u +%FT%TZ))"
    on sh -c '
      for t in "filter FORWARD" "filter INPUT" "filter DOCKER-USER" "nat PREROUTING"; do
        set -- $t; echo "-- iptables -t $1 -S $2"; iptables -t $1 -S $2 | grep -v "^-P" | nl -ba -w2 -s": "
      done
      for c in ORBIT-MR-FORWARD ORBIT-MR-INPUT; do echo "-- iptables -S $c"; iptables -S $c 2>&1 | grep -v "^-N"; done
      echo "-- iptables -t nat -S ORBIT-MR-PREROUTING"; iptables -t nat -S ORBIT-MR-PREROUTING 2>&1 | grep -v "^-N"
      for t in "filter FORWARD" "filter INPUT" "nat PREROUTING"; do
        set -- $t; echo "-- ip6tables -t $1 -S $2"; ip6tables -t $1 -S $2 | grep -v "^-P" | nl -ba -w2 -s": "
      done
      echo "-- ip6tables -S ORBIT-MR-FORWARD / -t nat -S ORBIT-MR-PREROUTING"
      ip6tables -S ORBIT-MR-FORWARD 2>&1 | grep -v "^-N"; ip6tables -t nat -S ORBIT-MR-PREROUTING 2>&1 | grep -v "^-N"'
    ;;
  state)
    s "The firewall's check, show and status ($(date -u +%FT%TZ))"
    ch run --rm --no-deps managed-runner-firewall check; echo "check: exit $?"
    ch run --rm --no-deps managed-runner-firewall show
    on sh -c 'cat /work/orbit/data/channel-host/firewall/status.json | jq .'
    ch ps --format '{{.Service}}: {{.Status}}'
    s "The firewall service's log"
    on docker logs orbit-managed-runner-firewall 2>&1 | tail -${1:-20}
    ;;
  reach)
    s "From a runner container on orbit-managed-runners, as the runner's user ($(date -u +%FT%TZ))"
    GW=$(on docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
    POD=$(on k3s kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].status.podIP}')
    on docker rm -f lab-runner >/dev/null 2>&1
    on docker run -d --name lab-runner --network orbit-managed-runners --user 10001:10001 --cap-drop ALL \
      --security-opt no-new-privileges --entrypoint sleep orbit-managed-runner:local infinity >/dev/null
    echo "runner container: $(on docker inspect lab-runner -f '{{.Config.Image}} user {{.Config.User}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'), gateway $GW, CoreDNS pod $POD"
    TARGETS=$(cat <<J
[["tcp","kube-dns ClusterIP","10.43.0.10",53],
 ["tcp","kubernetes API ClusterIP","10.43.0.1",443],
 ["tcp","CoreDNS pod IP","$POD",53],
 ["tcp","CoreDNS pod IP, readiness port","$POD",8181],
 ["tcp","the node address, k3s API","$M_IP",6443],
 ["tcp","the node address, kubelet","$M_IP",10250],
 ["tcp","the node address, a NodePort","$M_IP",30053],
 ["tcp","the node's flannel cni0 address, kubelet","10.42.0.1",10250],
 ["tcp","this host on the runners' network, port 22","$GW",22],
 ["tcp","this host on the runners' network, the k3s API","$GW",6443],
 ["tcp","the HPC host on the lab bridge","172.31.92.1",22],
 ["tcp","the HPC host's LAN address","192.168.1.12",22],
 ["tcp","the HPC host's wg1 address","10.66.0.2",22],
 ["tcp","cloud metadata","169.254.169.254",80],
 ["tcp","a public address, port 443","1.1.1.1",443],
 ["https","a public https endpoint","https://www.cloudflare.com/cdn-cgi/trace"],
 ["https","another public https endpoint","https://github.com/"]]
J
)
    docker exec -i $M docker exec -i lab-runner python3 - "$TARGETS" < $K/kit/reach.py
    ;;
  restart)
    s "k3s restarted ($(date -u +%FT%TZ)); first rule of each hook every 0.5 s, printed when it changes"
    $K/kit/machine.sh k3s-stop
    $K/kit/machine.sh k3s-start
    on sh -c '
      last=""; end=$(( $(date +%s) + ${1:-150} ))
      while [ $(date +%s) -lt $end ]; do
        now="FORWARD: $(iptables -S FORWARD | sed -n 2p | grep -o "\-j [A-Z-]*")  INPUT: $(iptables -S INPUT | sed -n 2p | grep -o "\-j [A-Z-]*")  nat PREROUTING: $(iptables -t nat -S PREROUTING | sed -n 2p | grep -o "\-j [A-Z-]*")  ip6 FORWARD: $(ip6tables -S FORWARD | sed -n 2p | grep -o "\-j [A-Z-]*")"
        [ "$now" != "$last" ] && echo "$(date -u +%T.%N | cut -c1-12)  $now" && last=$now
        sleep 0.5
      done' sh "${1:-150}"
    $K/kit/machine.sh k3s-wait | head -3
    s "The firewall service's log over the restart"
    on docker logs --since 4m orbit-managed-runner-firewall 2>&1 | tail -20
    ;;
  before-program)
    s "The firewall program before this task (a5e20f8ef) on this host ($(date -u +%FT%TZ))"
    ch stop managed-runner-firewall
    ch run --rm --no-deps managed-runner-firewall remove
    on docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW --read-only \
      -v /kit/firewall-before.py:/opt/orbit-managed-runner-firewall/firewall.py:ro \
      -v /work/orbit/data/channel-host/firewall:/var/lib/orbit-managed-runner-firewall \
      orbit-managed-runner-firewall:local apply; echo "apply (before this task): exit $?"
    ;;
  remove)
    s "remove, with the service stopped ($(date -u +%FT%TZ))"
    ch stop managed-runner-firewall
    ch run --rm --no-deps managed-runner-firewall remove
    on sh -c 'echo "what is left of it:"; for f in iptables ip6tables; do $f-save | grep -c ORBIT-MR | sed "s/^/$f-save lines naming ORBIT-MR: /"; done'
    ch start managed-runner-firewall
    for _ in $(seq 1 30); do on sh -c 'jq -r .state /work/orbit/data/channel-host/firewall/status.json' | grep -qx enforced && break; sleep 1; done
    echo "service started again: $(on sh -c 'jq -c "{state, kubernetes, bridge}" /work/orbit/data/channel-host/firewall/status.json')"
    ;;
esac
