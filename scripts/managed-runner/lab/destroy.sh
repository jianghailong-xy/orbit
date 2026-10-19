#!/usr/bin/env bash
# Destroy the lab: shut the VM down, then delete its disks (the guest and every Ceph OSD, so all
# PVC data), cloud-init seed, SSH key and kubeconfig. The verified downloads (images/, downloads/,
# bin/) and logs/ are kept for the next create.sh, and state/ (facts and smoke reports, which hold
# no credentials) moves to logs/; --purge removes the whole directory instead.
# Usage: destroy.sh --yes-destroy-lab [--purge]
set -euo pipefail
. "$(dirname "$0")/lib.sh"

confirmed=0 purge=0
for arg in "$@"; do
  case "$arg" in
    --yes-destroy-lab) confirmed=1 ;;
    --purge) purge=1 ;;
    *) die "usage: destroy.sh --yes-destroy-lab [--purge]" ;;
  esac
done
[ "$confirmed" -eq 1 ] || die "this deletes every disk of the lab; pass --yes-destroy-lab to confirm"
require_root

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
say "removed the VM's disks, seed, SSH key and kubeconfig; kept downloads, logs and earlier reports in $LAB_DIR/logs"
