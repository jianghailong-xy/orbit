#!/usr/bin/env bash
# Shut the lab down cleanly: the second VM first (if it runs), then the first. Each gets the ACPI
# power button, then a wait for qemu to exit. Inside each guest, orbit-lab-rbd-release.service
# stops the Pods' containers, unmounts and unmaps kernel RBD devices after k3s stops and before
# Ceph (first VM) or the network (second VM) goes, so shutdown cannot hang on RBD.
# Usage: stop.sh [--node 2] [--timeout SECONDS] [--force]
#        stop.sh --node 2 --hard
#   --node 2   only the second VM: back to single-node mode (its node is cordoned first)
#   --hard     with --node 2: SIGKILL its qemu at once, a power cut with no shutdown in the guest
#              and nothing told to the cluster, to see what the cluster does when a node fails;
#              start.sh --nodes 2 brings it back
#   --force    after the timeout, stop the unit anyway (qemu exits: a power cut for the guest)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage="usage: stop.sh [--node 2] [--timeout SECONDS] [--force] | stop.sh --node 2 --hard"
timeout=600 force=0 only2=0 hard=0
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) [ $# -ge 2 ] || die "$usage"; timeout=$2; shift 2 ;;
    --force) force=1; shift ;;
    --node) [ "${2:-}" = 2 ] || die "$usage"; only2=1; shift 2 ;;
    --hard) hard=1; shift ;;
    *) die "$usage" ;;
  esac
done
[ "$hard" -eq 0 ] || [ "$only2" -eq 1 ] || die "--hard is for the second VM only: stop.sh --node 2 --hard"
require_root

shutdown_node() {  # shutdown_node <1|2>
  local node=$1 unit qmp console deadline
  unit=$(node_unit "$node")
  qmp=$LAB_QMP console=$LAB_DIR/logs/console.log
  [ "$node" = 2 ] && qmp=$LAB2_QMP console=$LAB_DIR/logs/node2-console.log
  if ! node_running "$node"; then
    say "$unit is not running"
    return 0
  fi
  unit_memory_line "$unit"
  python3 -I "$LAB_SCRIPTS/qmp.py" "$qmp" powerdown >/dev/null
  say "$unit: ACPI shutdown requested; waiting up to ${timeout} s"
  deadline=$(( SECONDS + timeout ))
  while node_running "$node"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      if [ "$force" -eq 1 ]; then
        say "no clean shutdown after ${timeout} s: stopping $unit.service (power cut)"
        systemctl stop "$unit.service"
        break
      fi
      die "VM $node did not power off within ${timeout} s; see $console, or rerun with --force"
    fi
    sleep 3
  done
  say "$unit stopped after $(( timeout - (deadline - SECONDS) )) s"
}

if [ "$hard" -eq 1 ]; then
  vm2_running || die "$LAB2_UNIT is not running"
  pid=$(systemctl show -P MainPID "$LAB2_UNIT.service")
  unit_memory_line "$LAB2_UNIT"
  systemctl kill --signal=SIGKILL "$LAB2_UNIT.service"
  say "$LAB2_UNIT: qemu (pid $pid) killed with SIGKILL at $(date -u +%FT%T.%3NZ); the guest got no shutdown"
  deadline=$(( SECONDS + 30 ))
  while vm2_running; do
    [ "$SECONDS" -lt "$deadline" ] || die "$LAB2_UNIT still runs 30 s after SIGKILL"
    sleep 1
  done
  printf 'host: MemAvailable %s MiB\n' "$(mem_available_mib)"
  exit 0
fi

# Nothing should be scheduled onto the second node while its VM is off.
vm2_running && cordon_node2 cordon
shutdown_node 2
[ "$only2" -eq 1 ] || shutdown_node 1
printf 'host: MemAvailable %s MiB\n' "$(mem_available_mib)"
