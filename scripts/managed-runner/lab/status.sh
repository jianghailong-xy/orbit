#!/usr/bin/env bash
# State and health of the lab: the VM unit and its memory, the host boundary, the guest
# (k3s, Ceph), Ceph-CSI, the StorageClass and the test namespace.
# Usage: status.sh [--wait SECONDS]   (keep checking until healthy, for at most SECONDS)
# Exit: 0 when the VM is stopped or healthy, 1 when it runs but is not healthy.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

wait=0
case "${1:-}" in
  --wait) wait=${2:?usage: status.sh [--wait SECONDS]} ;;
  "") ;;
  *) die "usage: status.sh [--wait SECONDS]" ;;
esac

# The host stays clean whether or not the VM runs: no Ceph/RBD kernel modules, no Kubernetes.
host_modules=$(awk '$1 ~ /^(rbd|nbd|ceph|libceph)$/ {print $1}' /proc/modules | xargs)
echo "host kernel modules rbd/nbd/ceph/libceph loaded: ${host_modules:-none}"

if ! vm_running; then
  echo "VM: stopped ($LAB_UNIT.service inactive)"
  printf 'host: MemAvailable %s MiB\n' "$(mem_available_mib)"
  exit 0
fi

pid=$(systemctl show -P MainPID "$LAB_UNIT.service")
echo "VM: running, qemu pid $pid, cgroup $(systemctl show -P ControlGroup "$LAB_UNIT.service")"
echo "qemu listens on: $(ss -Hltnp | awk -v pid="pid=$pid," 'index($0, pid) {print $4}' | sort | xargs)"
unit_memory_report
echo "guest (virtio-balloon): $(python3 -I "$LAB_SCRIPTS/qmp.py" "$LAB_QMP" balloon-stats 2>/dev/null || echo unavailable)"

check() {
  local problems=()
  if ! lab_ssh true 2>/dev/null; then
    echo "no SSH yet"
    return 1
  fi
  local guest
  guest=$(lab_ssh sudo /opt/orbit-lab/provision.sh health 2>/dev/null) || guest='{"problems": ["guest health check failed"]}'
  echo "guest: $(jq -c . <<<"$guest")"
  while IFS= read -r problem; do problems+=("$problem"); done < <(jq -r '.problems[]' <<<"$guest")

  if [ -f "$LAB_KUBECONFIG" ]; then
    local ready
    ready=$(lab_kubectl get node "$LAB_NAME" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    echo "k3s node $LAB_NAME Ready: ${ready:-unknown} ($(lab_kubectl version -o json 2>/dev/null | jq -r .serverVersion.gitVersion))"
    [ "$ready" = True ] || problems+=("node not Ready")
    local workload desired available
    for workload in deployment/ceph-csi-operator-controller-manager "deployment/$LAB_CSI_DRIVER-ctrlplugin" \
                    "daemonset/$LAB_CSI_DRIVER-nodeplugin"; do
      desired=$(lab_kubectl -n "$LAB_CSI_NAMESPACE" get "$workload" -o json 2>/dev/null \
        | jq -r '(.status.replicas // .status.desiredNumberScheduled // 0 | tostring) + " " + (.status.availableReplicas // .status.numberAvailable // 0 | tostring)' || echo "0 0")
      read -r desired available <<<"$desired"
      echo "$workload: $available/$desired available"
      [ "$desired" -gt 0 ] && [ "$available" -eq "$desired" ] || problems+=("$workload not available")
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
  echo "healthy: k3s, Ceph ($LAB_OSD_COUNT OSDs, HEALTH_OK), Ceph-CSI, StorageClass $LAB_STORAGE_CLASS, namespace $LAB_NAMESPACE"
}

deadline=$(( SECONDS + wait ))
until check; do
  if [ "$SECONDS" -ge "$deadline" ]; then exit 1; fi
  sleep 15
done
