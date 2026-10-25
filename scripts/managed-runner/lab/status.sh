#!/usr/bin/env bash
# State and health of the lab: each VM's unit and memory, the host boundary, the link, the guests
# (k3s, Ceph), the Kubernetes nodes, Ceph-CSI, the StorageClass and the test namespace.
# Usage: status.sh [--wait SECONDS]   (keep checking until healthy, for at most SECONDS)
# Exit: 0 when the VMs are stopped or healthy, 1 when one runs but is not healthy. With the second
# VM off (single-node mode) its node is reported, not required.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

wait=0
case "${1:-}" in
  --wait) wait=${2:?usage: status.sh [--wait SECONDS]} ;;
  "") ;;
  *) die "usage: status.sh [--wait SECONDS]" ;;
esac

# The host stays clean whether or not the VMs run: no Ceph/RBD kernel modules, no Kubernetes.
host_modules=$(awk '$1 ~ /^(rbd|nbd|ceph|libceph)$/ {print $1}' /proc/modules | xargs)
echo "host kernel modules rbd/nbd/ceph/libceph loaded: ${host_modules:-none}"

for node in 1 2; do
  unit=$(node_unit "$node")
  if node_running "$node"; then
    pid=$(systemctl show -P MainPID "$unit.service")
    echo "VM $node: running, qemu pid $pid, cgroup $(systemctl show -P ControlGroup "$unit.service")"
    echo "VM $node qemu listens on: $(ss -Hltnp | awk -v pid="pid=$pid," 'index($0, pid) {print $4}' | sort | xargs)"
  elif [ "$node" = 2 ] && ! vm2_created; then
    echo "VM 2: not created (create.sh --nodes 2)"
  else
    echo "VM $node: stopped ($unit.service inactive)"
  fi
done
if vm_running; then
  link=$(ss -Htn state established "( sport = :$LAB_LINK_PORT )" | awk '{print $3 " <- " $4}' | xargs)
  echo "link 127.0.0.1:$LAB_LINK_PORT: ${link:-no second VM connected}"
fi
unit_memory_report
if ! vm_running; then
  vm2_running && { echo "not healthy: the second VM runs without the first"; exit 1; }
  exit 0
fi
echo "guest 1 (virtio-balloon): $(python3 -I "$LAB_SCRIPTS/qmp.py" "$LAB_QMP" balloon-stats 2>/dev/null || echo unavailable)"
vm2_running && echo "guest 2 (virtio-balloon): $(python3 -I "$LAB_SCRIPTS/qmp.py" "$LAB2_QMP" balloon-stats 2>/dev/null || echo unavailable)"

guest_health() {  # guest_health <1|2>: the guest's own report; its problems go into the array problems
  local step=health guest
  [ "$1" = 2 ] && step=agent-health
  guest=$(node_ssh "$1" sudo /opt/orbit-lab/provision.sh "$step" 2>/dev/null) \
    || guest='{"problems": ["guest health check failed"]}'
  echo "guest $1: $(jq -c . <<<"$guest")"
  while IFS= read -r problem; do problems+=("VM $1: $problem"); done < <(jq -r '.problems[]' <<<"$guest")
}

node_ready() {  # node_ready <node name>: True, False or Unknown
  lab_kubectl get node "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true
}

check() {
  problems=()
  if ! lab_ssh true 2>/dev/null; then
    echo "no SSH to VM 1 yet"
    return 1
  fi
  guest_health 1
  local two=0
  if vm2_running; then
    two=1
    if lab2_ssh true 2>/dev/null; then guest_health 2; else problems+=("no SSH to VM 2 yet"); fi
  fi

  if [ -f "$LAB_KUBECONFIG" ]; then
    local ready nodes=("$LAB_NAME")
    [ "$two" -eq 1 ] && nodes+=("$LAB2_NAME")
    echo "k3s $(lab_kubectl version -o json 2>/dev/null | jq -r .serverVersion.gitVersion)"
    for name in "${nodes[@]}"; do
      ready=$(node_ready "$name")
      echo "node $name Ready: ${ready:-unknown}, $(lab_kubectl get node "$name" -o json 2>/dev/null \
        | jq -r '"internal IP " + ([.status.addresses[] | select(.type == "InternalIP") | .address] | join(",")) + (if .spec.unschedulable then ", cordoned" else "" end)')"
      [ "$ready" = True ] || problems+=("node $name not Ready")
    done
    if [ "$two" -eq 0 ] && node2_registered; then
      echo "node $LAB2_NAME (its VM is off): Ready $(node_ready "$LAB2_NAME"), $(lab_kubectl get node "$LAB2_NAME" \
        -o jsonpath='{.spec.unschedulable}' | sed 's/^true$/cordoned/;s/^$/not cordoned/')"
    fi
    local workload desired available
    for workload in deployment/ceph-csi-operator-controller-manager "deployment/$LAB_CSI_DRIVER-ctrlplugin"; do
      desired=$(lab_kubectl -n "$LAB_CSI_NAMESPACE" get "$workload" -o json 2>/dev/null \
        | jq -r '(.status.replicas // 0 | tostring) + " " + (.status.availableReplicas // 0 | tostring)' || echo "0 0")
      read -r desired available <<<"$desired"
      echo "$workload: $available/$desired available"
      [ "$desired" -gt 0 ] && [ "$available" -eq "$desired" ] || problems+=("$workload not available")
    done
    # The node plugin is a DaemonSet: one Pod per node, required on the nodes whose VM runs.
    local plugins
    plugins=$(lab_kubectl -n "$LAB_CSI_NAMESPACE" get pods -o json 2>/dev/null | jq -c --arg ds "$LAB_CSI_DRIVER-nodeplugin" \
      '[.items[] | select(any(.metadata.ownerReferences[]?; .kind == "DaemonSet" and .name == $ds))
        | {node: .spec.nodeName, ready: (any(.status.conditions[]?; .type == "Ready" and .status == "True"))}]') || plugins='[]'
    [ -n "$plugins" ] || plugins='[]'
    for name in "${nodes[@]}"; do
      if [ "$(jq --arg n "$name" '[.[] | select(.node == $n and .ready)] | length' <<<"$plugins")" -ge 1 ]; then
        echo "daemonset/$LAB_CSI_DRIVER-nodeplugin on $name: ready"
      else
        echo "daemonset/$LAB_CSI_DRIVER-nodeplugin on $name: not ready"
        problems+=("no ready CSI node plugin on $name")
      fi
    done
    lab_kubectl get storageclass "$LAB_STORAGE_CLASS" >/dev/null 2>&1 || problems+=("no StorageClass $LAB_STORAGE_CLASS")
    lab_kubectl get namespace "$LAB_NAMESPACE" >/dev/null 2>&1 || problems+=("no namespace $LAB_NAMESPACE")
  else
    problems+=("no kubeconfig yet")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    printf 'not healthy: %s\n' "$(IFS=';'; echo "${problems[*]}")"
    return 1
  fi
  if [ "$two" -eq 1 ]; then
    echo "healthy, two nodes: $LAB_NAME and $LAB2_NAME Ready over the link $LAB_LINK_NET; Ceph ($LAB_OSD_COUNT OSDs, HEALTH_OK) at $LAB_LINK_IP; Ceph-CSI on both nodes; StorageClass $LAB_STORAGE_CLASS, namespace $LAB_NAMESPACE"
  else
    echo "healthy: k3s, Ceph ($LAB_OSD_COUNT OSDs, HEALTH_OK), Ceph-CSI, StorageClass $LAB_STORAGE_CLASS, namespace $LAB_NAMESPACE"
  fi
}

deadline=$(( SECONDS + wait ))
until check; do
  if [ "$SECONDS" -ge "$deadline" ]; then exit 1; fi
  sleep 15
done
