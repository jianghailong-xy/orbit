#!/usr/bin/env bash
# Destroy the lab: shut the VMs down (the second first), then delete their disks (the guests and
# every Ceph OSD, so all PVC data), cloud-init seeds, SSH key and kubeconfig. The verified
# downloads (images/, downloads/, bin/) and logs/ are kept for the next create.sh, and state/
# (facts and smoke reports, which hold no credentials) moves to logs/; --purge removes the whole
# directory instead.
# --node 2 destroys only the second VM (its disk and seed; it holds no Ceph data) and removes its
# node from the cluster when the first VM runs; create.sh --nodes 2 builds a new one.
# Usage: destroy.sh --yes-destroy-lab [--node 2 | --purge]
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage="usage: destroy.sh --yes-destroy-lab [--node 2 | --purge]"
confirmed=0 purge=0 only2=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes-destroy-lab) confirmed=1; shift ;;
    --purge) purge=1; shift ;;
    --node) [ "${2:-}" = 2 ] || die "$usage"; only2=1; shift 2 ;;
    *) die "$usage" ;;
  esac
done
[ "$confirmed" -eq 1 ] || die "this deletes lab disks; pass --yes-destroy-lab to confirm"
[ "$purge" -eq 0 ] || [ "$only2" -eq 0 ] || die "$usage"
require_root

if [ "$only2" -eq 1 ]; then
  "$LAB_SCRIPTS/stop.sh" --node 2 --timeout 600 --force
  if [ -f "$LAB_KUBECONFIG" ] && vm_running; then
    if node2_registered; then lab_kubectl delete node "$LAB2_NAME" --wait=true; fi
    lab_kubectl -n kube-system delete secret "$LAB2_NAME.node-password.k3s" --ignore-not-found
  else
    say "the first VM is off: node $LAB2_NAME stays registered until create.sh --nodes 2 replaces it"
  fi
  rm -f "${LAB2_ROOT_DISK:?}" "$LAB_DIR"/seed/node2-* "$LAB_DIR"/run/node2-*
  ssh-keygen -q -R "[127.0.0.1]:$LAB2_SSH_PORT" -f "$LAB_DIR/ssh/known_hosts" >/dev/null 2>&1 || true
  rm -f "$LAB_DIR/ssh/known_hosts.old"
  [ -f "$LAB_DIR/state/facts-node2.json" ] && mv "$LAB_DIR/state/facts-node2.json" \
    "$LAB_DIR/logs/facts-node2-destroyed-$(date -u +%Y%m%dT%H%M%SZ).json"
  say "removed the second VM's disk and seed; the first VM and every Ceph volume are untouched"
  exit 0
fi

"$LAB_SCRIPTS/stop.sh" --timeout 600 --force
if [ "$purge" -eq 1 ]; then
  rm -rf "${LAB_DIR:?}"
  say "removed $LAB_DIR"
  exit 0
fi
for dir in disks seed ssh run; do
  rm -rf "${LAB_DIR:?}/${dir:?}"
done
rm -f "${LAB_DIR:?}/kubeconfig.json"
if [ -d "$LAB_DIR/state" ]; then
  mv "$LAB_DIR/state" "$LAB_DIR/logs/state-destroyed-$(date -u +%Y%m%dT%H%M%SZ)"
fi
say "removed the VMs' disks, seeds, SSH key and kubeconfig; kept downloads, logs and earlier reports in $LAB_DIR/logs"
