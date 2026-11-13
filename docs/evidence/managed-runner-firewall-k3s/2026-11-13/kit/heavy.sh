#!/usr/bin/env bash
# Revision 2 of the lab, the whole run in one hold of the shared HPC lock: the machine; the channel-host kit installed on
# it while it runs Docker only (the firewall as on any Docker host); k3s started for the first time with a runner
# connecting to the cluster's addresses throughout; a k3s restart and a kube-router sync (a pod started) the same way;
# the reinsertion window held open by hand; remove. Each step's output goes to logs2/.
set -uo pipefail
source /mnt/data/tmp/34wdoS/kit2/env.sh
SHA=$1
L=$K/logs2
lab() { $K/kit2/lab.sh "$@"; }
echo "==> $(date -u +%FT%TZ) machine"
$K/kit2/machine.sh down; $K/kit2/machine.sh up > $L/machine.txt 2>&1; echo "machine up: exit $?"
$K/kit2/machine.sh checkout $SHA >> $L/machine.txt 2>&1; echo "checkout: exit $?"
echo "==> $(date -u +%FT%TZ) kit install, Docker only"
docker exec -w /work/orbit $M deploy/managed-runner/remote-host/remote-host.sh install --listen $M_IP --allow-peer $PEER_IP --instance orbit-lab-k3s > $L/kit-install.txt 2>&1; echo "kit install: exit $?"
{ lab listing "Docker only, after the kit install"; lab state; lab runner; lab reach; } > $L/0-docker-only.txt 2>&1; echo "docker-only: exit $?"
docker exec $M sh -c 'iptables-save; echo; ip6tables-save; ip -4 rule; ip -6 rule' > $L/tables-docker-only.txt
echo "==> $(date -u +%FT%TZ) k3s, first start"
{ lab watch-start 200 k3s-first-start; $K/kit2/machine.sh k3s-start; lab first 190 "k3s starting for the first time";
  $K/kit2/machine.sh k3s-wait; lab watch-wait k3s-first-start; } > $L/1-k3s-first-start.txt 2>&1; echo "first start: exit $?"
docker exec -i $M k3s kubectl apply -f - > $L/nodeport.txt 2>&1 <<'YAML'
apiVersion: v1
kind: Service
metadata: {name: lab-dns-nodeport, namespace: kube-system}
spec:
  type: NodePort
  selector: {k8s-app: kube-dns}
  ports: [{name: dns-tcp, protocol: TCP, port: 53, targetPort: 53, nodePort: 30053}]
YAML
sleep 15
{ lab listing "k3s running"; lab state 30; lab reach; } > $L/2-k3s-running.txt 2>&1; echo "running: exit $?"
echo "==> $(date -u +%FT%TZ) k3s restart"
{ lab watch-start 200 k3s-restart; sleep 5; lab restart; lab first 190 "k3s restarted"; lab watch-wait k3s-restart;
  lab listing "after the k3s restart"; lab state 30; } > $L/3-k3s-restart.txt 2>&1; echo "restart: exit $?"
echo "==> $(date -u +%FT%TZ) kube-router sync"
{ lab watch-start 420 sync; (sleep 60; lab pod) & lab first 410 "a pod started at +60 s, then kube-router's periodic sync";
  wait; lab watch-wait sync; lab state 30; } > $L/4-sync.txt 2>&1; echo "sync: exit $?"
echo "==> $(date -u +%FT%TZ) window held open"
lab hold-window > $L/5-hold-window.txt 2>&1; echo "hold-window: exit $?"
{ lab remove; lab listing "after remove and the service started again"; lab state 10; lab reach; } > $L/6-remove.txt 2>&1; echo "remove: exit $?"
docker exec $M sh -c 'iptables-save; echo; ip6tables-save; ip -4 rule; ip -6 rule' > $L/tables-final.txt
docker exec $M docker logs orbit-managed-runner-firewall > $L/firewall-service.txt 2>&1
docker exec $M sh -c 'tail -c 300000 /var/log/k3s.log' > $L/k3s-log-tail.txt 2>&1
$K/kit2/machine.sh down
echo "==> $(date -u +%FT%TZ) done"
