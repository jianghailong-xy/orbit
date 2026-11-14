#!/usr/bin/env bash
# lab.sh <step>: the lab's checks on the machine, printed for the evidence README. Steps:
#   listing <label>      the rules that decide a runner's packets: FORWARD, INPUT, DOCKER-USER, nat and raw PREROUTING
#                        (numbered), this program's chains and its routing rule, both families
#   state [n]            the firewall's check, show and status.json, and the last n lines of the service's log
#   runner               (re)create the runner container: orbit-managed-runner:local, user 10001, on orbit-managed-runners
#   reach                from the runner container: every target once (tcp, udp DNS, https)
#   watch-start <s> <name>  from the runner container, in the background: every 0.5 s for s seconds, the cluster's
#                        addresses (pods 10.42.0.2-6, ClusterIPs, the node's NodePort and API, udp DNS), to logs/<name>
#   watch-wait <name>    wait for that watch and print it
#   first <s> [label]    the first rule of FORWARD, INPUT, nat and raw PREROUTING, ip6 FORWARD, every 0.5 s for s
#                        seconds, printed when it changes
#   restart              restart k3s (kill the server process, start it again: systemd's KillMode=process)
#   pod                  start a pod (a kube-router sync on a pod event)
#   hold-window          the service stopped, then kube-router's FORWARD and INPUT jumps and kube-proxy's nat jump put
#                        above this program's by hand and left there: reach; then the service started again
#   remove               the service stopped, `remove`, what is left; then the service started again
set -uo pipefail
source /mnt/data/tmp/34wdoS/kit2/env.sh
on() { docker exec "$M" "$@"; }
ch() { docker exec -w /work/orbit "$M" docker compose -f deploy/managed-runner/remote-host/compose.yml --env-file data/channel-host/compose.env "$@"; }
s() { echo; echo "### $*"; }
step=$1; shift
case "$step" in
  listing)
    s "Rule listing: $* ($(date -u +%FT%TZ))"
    on bash -c '
      for t in "filter FORWARD" "filter INPUT" "filter DOCKER-USER" "nat PREROUTING" "raw PREROUTING"; do
        set -- $t; echo "-- iptables -t $1 -S $2"; iptables -t $1 -S $2 2>&1 | grep -v "^-P" | nl -ba -w2 -s": "
      done
      for c in ORBIT-MR-FORWARD ORBIT-MR-INPUT; do echo "-- iptables -S $c"; iptables -S $c 2>&1 | grep -v "^-N"; done
      for t in nat:ORBIT-MR-PREROUTING raw:ORBIT-MR-RAW; do echo "-- iptables -t ${t%%:*} -S ${t#*:}"; iptables -t ${t%%:*} -S ${t#*:} 2>&1 | grep -v "^-N"; done
      echo "-- ip -4 rule"; ip -4 rule
      for t in "filter FORWARD" "filter INPUT" "nat PREROUTING" "raw PREROUTING"; do
        set -- $t; echo "-- ip6tables -t $1 -S $2"; ip6tables -t $1 -S $2 2>&1 | grep -v "^-P" | nl -ba -w2 -s": "
      done
      echo "-- ip6tables ORBIT-MR-FORWARD, nat ORBIT-MR-PREROUTING, raw ORBIT-MR-RAW"
      ip6tables -S ORBIT-MR-FORWARD 2>&1 | grep -v "^-N"; ip6tables -t nat -S ORBIT-MR-PREROUTING 2>&1 | grep -v "^-N"; ip6tables -t raw -S ORBIT-MR-RAW 2>&1 | grep -v "^-N"
      echo "-- ip -6 rule"; ip -6 rule'
    ;;
  state)
    s "The firewall's check, show and status ($(date -u +%FT%TZ))"
    ch run --rm --no-deps managed-runner-firewall check; echo "check: exit $?"
    ch run --rm --no-deps managed-runner-firewall show
    on sh -c 'jq . /work/orbit/data/channel-host/firewall/status.json; ls /work/orbit/data/channel-host/firewall/'
    ch ps --format '{{.Service}}: {{.Status}}'
    s "The firewall service's log"
    on docker logs orbit-managed-runner-firewall 2>&1 | tail -${1:-20}
    ;;
  runner)
    on docker rm -f lab-runner >/dev/null 2>&1
    on docker run -d --name lab-runner --network orbit-managed-runners --user 10001:10001 --cap-drop ALL \
      --security-opt no-new-privileges --entrypoint sleep orbit-managed-runner:local infinity >/dev/null
    echo "runner container: $(on docker inspect lab-runner -f '{{.Config.Image}} user {{.Config.User}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
    ;;
  reach)
    s "From the runner container on orbit-managed-runners, as the runner's user ($(date -u +%FT%TZ))"
    GW=$(on docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
    POD=$(on sh -c "k3s kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].status.podIP}' 2>/dev/null"); POD=${POD:-10.42.0.3}
    echo "gateway $GW, CoreDNS pod $POD"
    TARGETS=$(cat <<J
[["tcp","kube-dns ClusterIP","10.43.0.10",53],
 ["udp","kube-dns ClusterIP, a DNS question","10.43.0.10",53],
 ["tcp","kubernetes API ClusterIP","10.43.0.1",443],
 ["tcp","CoreDNS pod IP","$POD",53],
 ["udp","CoreDNS pod IP, a DNS question","$POD",53],
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
 ["udp","a private DNS server","192.168.1.254",53],
 ["tcp","a public address, port 443","1.1.1.1",443],
 ["udp","a public DNS server, a DNS question","1.1.1.1",53],
 ["https","a public https endpoint","https://www.cloudflare.com/cdn-cgi/trace"],
 ["https","another public https endpoint","https://github.com/"]]
J
)
    docker exec -i $M docker exec -i lab-runner python3 - "$TARGETS" < $K/kit2/reach.py
    ;;
  watch-start)
    secs=$1 name=$2
    TARGETS='[["tcp","10.42.0.2",53],["tcp","10.42.0.3",53],["tcp","10.42.0.4",53],["tcp","10.42.0.5",53],["tcp","10.42.0.6",53],
      ["tcp","10.42.0.3",8181],["tcp","10.43.0.10",53],["udp","10.43.0.10",53],["udp","10.42.0.3",53],["tcp","10.43.0.1",443],
      ["tcp","172.31.92.20",30053],["tcp","172.31.92.20",6443],["tcp","10.42.0.1",10250]]'
    (docker exec -i $M docker exec -i lab-runner python3 - "$secs" 0.5 "$TARGETS" < $K/kit2/watch.py > $K/logs2/watch-$name.txt 2>&1; echo "watch exit $?" >> $K/logs2/watch-$name.txt) &
    echo "$(date -u +%FT%TZ) watch $name started for $secs s"
    ;;
  watch-wait)
    name=$1
    while ! grep -q '^watch exit' $K/logs2/watch-$name.txt 2>/dev/null; do sleep 2; done
    s "Continuous connects from the runner container: $name"
    cat $K/logs2/watch-$name.txt
    ;;
  first)
    secs=$1; shift
    s "First rule of each hook every 0.5 s for $secs s, printed when it changes ($(date -u +%FT%TZ)) $*"
    on bash -c '
      f() { $1 -t $2 -S $3 2>/dev/null | sed -n 2p | grep -o "\-j [A-Z-]*"; }
      last=""; end=$(( $(date +%s) + $1 ))
      while [ $(date +%s) -lt $end ]; do
        now="FORWARD: $(f iptables filter FORWARD)  INPUT: $(f iptables filter INPUT)  nat: $(f iptables nat PREROUTING)  raw: $(f iptables raw PREROUTING)  ip6 FORWARD: $(f ip6tables filter FORWARD)  rule1: $(ip -4 rule | grep -c "^1:.*fwmark 0x100000/0x100000.*prohibit")"
        [ "$now" != "$last" ] && echo "$(date -u +%T.%N | cut -c1-10)  $now" && last=$now
        sleep 0.5
      done' sh "$secs"
    ;;
  restart)
    $K/kit2/machine.sh k3s-stop
    $K/kit2/machine.sh k3s-start
    ;;
  pod)
    echo "$(date -u +%FT%TZ) pod lab-sync-pod started"
    on k3s kubectl run lab-sync-pod --image=registry.k8s.io/pause:3.10 --restart=Never 2>&1
    ;;
  hold-window)
    s "The window held open by hand ($(date -u +%FT%TZ)): the service stopped, Kubernetes' jumps above this program's"
    ch stop managed-runner-firewall
    on bash -c '
      for t in iptables ip6tables; do
        for h in FORWARD:KUBE-ROUTER-FORWARD INPUT:KUBE-ROUTER-INPUT; do
          r=$($t -S ${h%%:*} | grep -- "-j ${h#*:}$" | head -1)
          [ -n "$r" ] && eval "$t ${r/-A /-D }" && eval "$t ${r/-A ${h%%:*}/-I ${h%%:*} 1}"
        done
        r=$($t -t nat -S PREROUTING | grep -- "-j KUBE-SERVICES$" | head -1)
        [ -n "$r" ] && eval "$t -t nat ${r/-A /-D }" && eval "$t -t nat ${r/-A PREROUTING/-I PREROUTING 1}"
      done'
    $K/kit2/lab.sh listing "the window held open: kube-router and kube-proxy first, the service stopped"
    $K/kit2/lab.sh reach
    ch run --rm --no-deps managed-runner-firewall check; echo "check: exit $?"
    ch start managed-runner-firewall
    for _ in $(seq 1 30); do on sh -c 'jq -r .state /work/orbit/data/channel-host/firewall/status.json' | grep -qx enforced && break; sleep 1; done
    echo "service started again: $(on sh -c 'jq -c "{state, kubernetes}" /work/orbit/data/channel-host/firewall/status.json')"
    ;;
  remove)
    s "remove, with the service stopped ($(date -u +%FT%TZ))"
    ch stop managed-runner-firewall
    ch run --rm --no-deps managed-runner-firewall remove
    on sh -c 'echo "what is left of it:"; for f in iptables ip6tables; do echo "$f-save lines naming ORBIT-MR: $($f-save | grep -c ORBIT-MR)"; done; echo "routing rules with its mark: $( (ip -4 rule; ip -6 rule) | grep -c 0x100000)"'
    ch start managed-runner-firewall
    for _ in $(seq 1 30); do on sh -c 'jq -r .state /work/orbit/data/channel-host/firewall/status.json' | grep -qx enforced && break; sleep 1; done
    echo "service started again: $(on sh -c 'jq -c "{state, kubernetes}" /work/orbit/data/channel-host/firewall/status.json')"
    ;;
esac
