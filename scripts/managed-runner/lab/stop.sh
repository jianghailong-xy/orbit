#!/usr/bin/env bash
# Shut the lab VM down cleanly: ACPI power button, then wait for qemu to exit.
# Inside the guest, orbit-lab-rbd-release.service stops the Pods' containers, unmounts and
# unmaps kernel RBD devices after k3s and before Ceph stop, so shutdown cannot hang on RBD.
# Usage: stop.sh [--timeout SECONDS] [--force]
#   --force  after the timeout, stop the unit anyway (qemu exits: a power cut for the guest)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

timeout=600 force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) timeout=$2; shift 2 ;;
    --force) force=1; shift ;;
    *) die "usage: stop.sh [--timeout SECONDS] [--force]" ;;
  esac
done
require_root

if ! vm_running; then
  say "$LAB_UNIT is not running"
  exit 0
fi
unit_memory_report
python3 -I "$LAB_SCRIPTS/qmp.py" "$LAB_QMP" powerdown >/dev/null
say "ACPI shutdown requested; waiting up to ${timeout} s"
deadline=$(( SECONDS + timeout ))
while vm_running; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    if [ "$force" -eq 1 ]; then
      say "no clean shutdown after ${timeout} s: stopping $LAB_UNIT.service (power cut)"
      systemctl stop "$LAB_UNIT.service"
      break
    fi
    die "the guest did not power off within ${timeout} s; see $LAB_DIR/logs/console.log, or rerun with --force"
  fi
  sleep 3
done
say "$LAB_UNIT stopped after $(( timeout - (deadline - SECONDS) )) s"
printf 'host: MemAvailable %s MiB\n' "$(mem_available_mib)"
