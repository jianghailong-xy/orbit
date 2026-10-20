#!/usr/bin/env bash
# Boot the lab VMs as their own transient systemd services, outside the Orbit runner's cgroup.
#   start.sh [--no-wait]             single-node mode: the first VM (k3s server, Ceph, Ceph-CSI)
#   start.sh --nodes 2 [--no-wait]   two-node mode: the first VM if it is off, then the second
#                                    (k3s agent); also how the second node comes back after a
#                                    hard stop (stop.sh --node 2 --hard)
# The memory guard counts what is about to boot: LAB_MIN_AVAILABLE_MIB of host MemAvailable for
# the first VM, LAB2_MIN_AVAILABLE_MIB for the second, their sum for both. Below it nothing boots.
# By default it waits until status.sh reports healthy, then drops the guests' page cache. The
# second node is cordoned in single-node mode and uncordoned in two-node mode.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage="usage: start.sh [--nodes 1|2] [--no-wait]"
wait=1 nodes=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-wait) wait=0; shift ;;
    --nodes) [ $# -ge 2 ] || die "$usage"; nodes=$2; shift 2 ;;
    *) die "$usage" ;;
  esac
done
[[ $nodes =~ ^[12]$ ]] || die "$usage"
require_root

boot=()  # the VMs to boot, in this order: the second connects to the first's end of the link
vm_running || boot+=(1)
if [ "$nodes" = 2 ]; then
  vm2_created || die "there is no second VM yet: run create.sh --nodes 2"
  vm2_running || boot+=(2)
elif vm2_running; then
  say "$LAB2_UNIT is running too, so this is two-node mode; stop.sh --node 2 goes back to one node"
fi

require_files() { local file; for file; do [ -e "$file" ] || die "missing $file: run create.sh first"; done; }
require_free_port() { if ss -Hltn "sport = :$1" | grep -q .; then die "127.0.0.1:$1 is already taken on the host"; fi; }
floor=0 guests=()
for node in "${boot[@]}"; do
  if [ "$node" = 1 ]; then
    require_files "$LAB_DIR/disks/root.qcow2" "$LAB_DIR/seed/seed.iso" "$LAB_SSH_KEY"
    for index in $(seq 0 $(( LAB_OSD_COUNT - 1 ))); do require_files "$LAB_DIR/disks/osd-$index.qcow2"; done
    for port in "$LAB_SSH_PORT" "$LAB_API_PORT" "$LAB_LINK_PORT"; do require_free_port "$port"; done
    floor=$(( floor + LAB_MIN_AVAILABLE_MIB ))
    guests+=("$LAB_NAME (${LAB_MEMORY_MIB} MiB)")
  else
    require_files "$LAB2_ROOT_DISK" "$LAB2_SEED" "$LAB_SSH_KEY"
    require_free_port "$LAB2_SSH_PORT"
    floor=$(( floor + LAB2_MIN_AVAILABLE_MIB ))
    guests+=("$LAB2_NAME (${LAB2_MEMORY_MIB} MiB)")
  fi
done
[ "${#boot[@]}" -eq 0 ] || [ -w /dev/kvm ] || die "/dev/kvm is not usable"

# The memory guard. A VM may grow to its guest RAM; booting into an already short host pushes
# everyone into swap, and an OOM kill inside the runner's cgroup stops the whole runner.
available=$(mem_available_mib)
if [ "${#boot[@]}" -gt 0 ]; then
  if [ "$available" -lt "$floor" ]; then
    say "refused: host MemAvailable is ${available} MiB, below the ${floor} MiB floor for booting $(printf '%s, ' "${guests[@]}" | sed 's/, $//')."
    say "The guest RAM is the most each VM can take. Wait until other work on this host has finished"
    say "(free -m, systemd-cgtop), then try again."
    exit 3
  fi
  say "host MemAvailable ${available} MiB (floor ${floor} MiB): booting $(printf '%s, ' "${guests[@]}" | sed 's/, $//')"
fi
mkdir -p "$LAB_DIR/run" "$LAB_DIR/logs" "$LAB_DIR/state"

drives=()
add_drive() {  # add_drive <id> <file> <serial>
  drives+=(-drive "if=none,id=$1,file=$2,format=qcow2,cache=none,aio=native,discard=unmap,detect-zeroes=unmap"
           -device "virtio-blk-pci,drive=$1,serial=$3")
}

# What both VMs share. -sandbox: qemu may not spawn, elevate or change resource controls.
common_args() {  # common_args <name> <vcpus> <memory MiB> <console log> <qmp socket> <pidfile>
  printf '%s\n' -name "$1,debug-threads=on" \
    -machine q35,accel=kvm -cpu host -smp "$2" -m "$3" \
    -nodefaults -display none -vga none \
    -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
    -chardev "file,id=console,path=$4,append=on" -serial chardev:console \
    -chardev "socket,id=qmp,path=$5,server=on,wait=off" -mon chardev=qmp,mode=control \
    -pidfile "$6" \
    -device virtio-balloon-pci,id=balloon0,free-page-reporting=on \
    -object rng-random,id=rng0,filename=/dev/urandom -device virtio-rng-pci,rng=rng0
}

boot_node1() {
  rm -f "$LAB_QMP" "$LAB_DIR/run/qemu.pid"
  drives=()
  add_drive root "$LAB_DIR/disks/root.qcow2" orbit-root
  for index in $(seq 0 $(( LAB_OSD_COUNT - 1 ))); do
    add_drive "osd$index" "$LAB_DIR/disks/osd-$index.qcow2" "orbit-osd-$index"
  done
  local -a common
  mapfile -t common < <(common_args "$LAB_NAME" "$LAB_VCPUS" "$LAB_MEMORY_MIB" "$LAB_DIR/logs/console.log" \
                                    "$LAB_QMP" "$LAB_DIR/run/qemu.pid")
  # --collect: a failed or finished run leaves no unit behind, so the next start reuses the name.
  # OOMScoreAdjust=1000: under host-wide memory pressure the kernel kills the VM first, not the runner.
  # The link NIC comes last, so the devices before it keep their PCI slots and the guest's names.
  systemd-run --unit="$LAB_UNIT" --collect --quiet \
    --description="Orbit managed-runner lab VM (k3s, Ceph, Ceph-CSI; test only)" \
    -p MemoryMax="$LAB_UNIT_MEMORY_MAX" -p OOMScoreAdjust=1000 -p CPUQuota=$(( LAB_VCPUS * 100 ))% \
    -p TimeoutStopSec=30 \
    /usr/bin/qemu-system-x86_64 "${common[@]}" \
      -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$LAB_SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$LAB_API_PORT-:6443" \
      -device "virtio-net-pci,netdev=net0,mac=$LAB_USER_MAC" \
      "${drives[@]}" \
      -drive "if=none,id=seed,file=$LAB_DIR/seed/seed.iso,format=raw,media=cdrom,readonly=on" \
      -device ide-cd,drive=seed \
      -netdev "socket,id=link0,listen=127.0.0.1:$LAB_LINK_PORT" \
      -device "virtio-net-pci,netdev=link0,mac=$LAB_LINK_MAC"
  # qemu opens the link's listening socket before the guest runs; the second VM connects to it.
  local deadline=$(( SECONDS + 30 ))
  until ss -Hltn "sport = :$LAB_LINK_PORT" | grep -q .; do
    vm_running || die "$LAB_UNIT stopped right after it started; see journalctl -u $LAB_UNIT"
    [ "$SECONDS" -lt "$deadline" ] || die "the first VM does not listen on the link 127.0.0.1:$LAB_LINK_PORT"
    sleep 1
  done
}

boot_node2() {
  vm_running || die "the first VM is not running: the second connects to its end of the link"
  rm -f "$LAB2_QMP" "$LAB_DIR/run/node2-qemu.pid"
  drives=()
  add_drive root "$LAB2_ROOT_DISK" orbit-root
  local -a common
  mapfile -t common < <(common_args "$LAB2_NAME" "$LAB2_VCPUS" "$LAB2_MEMORY_MIB" "$LAB_DIR/logs/node2-console.log" \
                                    "$LAB2_QMP" "$LAB_DIR/run/node2-qemu.pid")
  systemd-run --unit="$LAB2_UNIT" --collect --quiet \
    --description="Orbit managed-runner lab VM 2 (k3s agent; test only)" \
    -p MemoryMax="$LAB2_UNIT_MEMORY_MAX" -p OOMScoreAdjust=1000 -p CPUQuota=$(( LAB2_VCPUS * 100 ))% \
    -p TimeoutStopSec=30 \
    /usr/bin/qemu-system-x86_64 "${common[@]}" \
      -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$LAB2_SSH_PORT-:22" \
      -device "virtio-net-pci,netdev=net0,mac=$LAB2_USER_MAC" \
      "${drives[@]}" \
      -drive "if=none,id=seed,file=$LAB2_SEED,format=raw,media=cdrom,readonly=on" \
      -device ide-cd,drive=seed \
      -netdev "socket,id=link0,connect=127.0.0.1:$LAB_LINK_PORT" \
      -device "virtio-net-pci,netdev=link0,mac=$LAB2_LINK_MAC"
  sleep 2  # a refused link connection ends qemu at once
  vm2_running || die "$LAB2_UNIT stopped right after it started; see journalctl -u $LAB2_UNIT"
}

# The second node takes part in two-node mode only; while its VM is off it stays cordoned.
settle_node2() { if [ "$nodes" = 2 ]; then cordon_node2 uncordon; elif ! vm2_running; then cordon_node2 cordon; fi; }

if [ "${#boot[@]}" -eq 0 ]; then
  say "already running"
  settle_node2
  unit_memory_report
  exit 0
fi
for node in "${boot[@]}"; do
  if [ "$node" = 1 ]; then boot_node1; else boot_node2; fi
  unit=$(node_unit "$node")
  say "started $unit.service (cgroup $(systemctl show -P ControlGroup "$unit.service"))"
  printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$available" "$unit" >> "$LAB_DIR/state/boots.tsv"
done
for node in "${boot[@]}"; do
  wait_for_ssh 600 "$node"
  say "SSH to VM $node is up: $(node_ssh "$node" uname -r)"
done
if [ "$wait" -eq 1 ] && [ -f "$LAB_KUBECONFIG" ]; then
  "$LAB_SCRIPTS/status.sh" --wait 900
  settle_node2
  # Starting every daemon and container fills the guests' page cache; give it back to the host.
  for node in "${boot[@]}"; do node_ssh "$node" sudo /opt/orbit-lab/provision.sh trim; done
  unit_memory_report
fi
