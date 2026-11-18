#!/usr/bin/env bash
# The whole lab in one hold of the shared HPC lock (the machine, idle outside it, was taken by the host's OOM killer
# once): the machine, k3s beside Docker, the channel-host kit installed as an operator runs it (its runner image build)
# on a host where k3s already runs, then every check of lab.sh. Each step's output goes to logs/.
set -uo pipefail
source /mnt/data/tmp/34wdoS/kit/env.sh
L=$K/logs
lab() { $K/kit/lab.sh "$@"; }
echo "==> $(date -u +%FT%TZ) machine"
$K/kit/machine.sh down; $K/kit/machine.sh up > $L/machine.txt 2>&1; echo "machine up: exit $?"
$K/kit/machine.sh checkout b7ee5596c >> $L/machine.txt 2>&1; echo "checkout: exit $?"
echo "==> $(date -u +%FT%TZ) k3s"
$K/kit/machine.sh k3s-start
$K/kit/machine.sh k3s-wait > $L/k3s-up.txt 2>&1; echo "k3s up: exit $?"
docker exec -i $M k3s kubectl apply -f - > $L/nodeport.txt 2>&1 <<'YAML'
apiVersion: v1
kind: Service
metadata: {name: lab-dns-nodeport, namespace: kube-system}
spec:
  type: NodePort
  selector: {k8s-app: kube-dns}
  ports: [{name: dns-tcp, protocol: TCP, port: 53, targetPort: 53, nodePort: 30053}]
YAML
echo "nodeport: exit $?"
sleep 30
docker exec $M sh -c 'iptables-save; echo; ip6tables-save' > $L/iptables-k3s-before-kit.txt
echo "==> $(date -u +%FT%TZ) kit install"
docker exec -w /work/orbit $M deploy/managed-runner/remote-host/remote-host.sh install --listen $M_IP --allow-peer $PEER_IP --instance orbit-lab-k3s > $L/kit-install.txt 2>&1; echo "kit install: exit $?"
echo "==> $(date -u +%FT%TZ) checks"
{ lab listing "after the kit install, k3s running"; lab state; lab reach; } > $L/1-installed.txt 2>&1; echo "installed checks: exit $?"
{ lab restart 150; lab listing "after the k3s restart"; lab state 40; lab reach; } > $L/2-k3s-restart.txt 2>&1; echo "restart checks: exit $?"
{ lab before-program; lab listing "the program before this task, k3s running"; lab reach; } > $L/3-before-program.txt 2>&1; echo "before-program: exit $?"
{ lab remove; lab listing "after remove and the service started again"; lab state 10; lab reach; } > $L/4-remove.txt 2>&1; echo "remove: exit $?"
docker exec $M sh -c 'iptables-save; echo; ip6tables-save' > $L/iptables-final.txt
echo "==> $(date -u +%FT%TZ) done"
