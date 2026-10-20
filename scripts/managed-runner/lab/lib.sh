# Shared helpers of the lab's host scripts. Source it; it is not run on its own.
# Node 1 is the first VM (k3s server, Ceph, Ceph-CSI); node 2 the second VM (k3s agent only).
# shellcheck shell=bash

LAB_SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lab.env
. "$LAB_SCRIPTS/lab.env"

LAB_KUBECONFIG=$LAB_DIR/kubeconfig.json
LAB_KUBECTL=$LAB_DIR/bin/kubectl
LAB_SSH_KEY=$LAB_DIR/ssh/id_ed25519
LAB_QMP=$LAB_DIR/run/qmp.sock
LAB2_QMP=$LAB_DIR/run/node2-qmp.sock
LAB2_ROOT_DISK=$LAB_DIR/disks/node2-root.qcow2
LAB2_SEED=$LAB_DIR/seed/node2-seed.iso

say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { say "error: $*"; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root: systemd-run and /dev/kvm need it"; }

# Only this VM's context is ever used: no KUBECONFIG, no ~/.kube, no current-context fallback.
lab_kubectl() {
  [ -f "$LAB_KUBECONFIG" ] || die "no kubeconfig yet: $LAB_KUBECONFIG (run create.sh)"
  env -u KUBECONFIG "$LAB_KUBECTL" --kubeconfig "$LAB_KUBECONFIG" --context "$LAB_NAME" "$@"
}

node_ssh_port() { if [ "$1" = 2 ]; then echo "$LAB2_SSH_PORT"; else echo "$LAB_SSH_PORT"; fi; }
node_unit() { if [ "$1" = 2 ]; then echo "$LAB2_UNIT"; else echo "$LAB_UNIT"; fi; }

node_ssh() {  # node_ssh <1|2> <command>...
  local port
  port=$(node_ssh_port "$1")
  shift
  ssh -i "$LAB_SSH_KEY" -p "$port" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -o UserKnownHostsFile="$LAB_DIR/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o LogLevel=ERROR ubuntu@127.0.0.1 "$@"
}
lab_ssh() { node_ssh 1 "$@"; }
lab2_ssh() { node_ssh 2 "$@"; }

lab_scp_to() {  # lab_scp_to <local path>... <guest dir>
  local dest=${*: -1}
  scp -q -r -i "$LAB_SSH_KEY" -P "$LAB_SSH_PORT" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -o UserKnownHostsFile="$LAB_DIR/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o LogLevel=ERROR "${@:1:$#-1}" "ubuntu@127.0.0.1:$dest"
}

# The guest scripts and lab.env, into /opt/orbit-lab of one VM.
copy_guest_scripts() {  # copy_guest_scripts <1|2>
  tar -C "$LAB_SCRIPTS" -cf - lab.env -C "$LAB_SCRIPTS/guest" provision.sh release-rbd.sh \
    | node_ssh "$1" 'sudo rm -rf /opt/orbit-lab && sudo install -d -m 0755 /opt/orbit-lab && sudo tar -C /opt/orbit-lab -xf -'
}

vm_running() { systemctl is-active --quiet "$LAB_UNIT.service"; }
vm2_running() { systemctl is-active --quiet "$LAB2_UNIT.service"; }
node_running() { systemctl is-active --quiet "$(node_unit "$1").service"; }
vm2_created() { [ -e "$LAB2_ROOT_DISK" ]; }

mem_available_mib() { awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo; }

# Memory, as the host sees it: what each running VM's cgroup holds (guest RAM in use plus qemu
# overhead), then the host's MemAvailable once.
unit_memory_line() {  # unit_memory_line <unit>
  local cg
  cg=/sys/fs/cgroup$(systemctl show -P ControlGroup "$1.service" 2>/dev/null)
  if [ -r "$cg/memory.current" ]; then
    printf 'unit %s: memory.current %s MiB, memory.peak %s MiB, swap %s MiB, memory.max %s\n' \
      "$1" "$(( $(cat "$cg/memory.current") / 1048576 ))" \
      "$(( $(cat "$cg/memory.peak" 2>/dev/null || echo 0) / 1048576 ))" \
      "$(( $(cat "$cg/memory.swap.current" 2>/dev/null || echo 0) / 1048576 ))" "$(cat "$cg/memory.max")"
  fi
}
unit_memory_report() {
  local unit
  for unit in "$LAB_UNIT" "$LAB2_UNIT"; do unit_memory_line "$unit"; done
  printf 'host: MemAvailable %s MiB, SwapFree %s MiB\n' "$(mem_available_mib)" \
    "$(awk '/^SwapFree:/ {print int($2 / 1024)}' /proc/meminfo)"
}

wait_for_ssh() {  # wait_for_ssh <seconds> [1|2]
  local node=${2:-1} deadline=$(( SECONDS + $1 )) console=$LAB_DIR/logs/console.log
  [ "$node" = 2 ] && console=$LAB_DIR/logs/node2-console.log
  until node_ssh "$node" true 2>/dev/null; do
    node_running "$node" || die "VM $node stopped while waiting for SSH; see $console"
    [ "$SECONDS" -lt "$deadline" ] || die "no SSH to VM $node after $1 s; see $console"
    sleep 5
  done
}

# The second node in the cluster: cordoned while its VM is off, so that nothing is scheduled onto a
# node that is not there, and uncordoned in two-node mode. A no-op until it has joined.
node2_registered() { lab_kubectl get node "$LAB2_NAME" >/dev/null 2>&1; }
cordon_node2() {  # cordon_node2 cordon|uncordon
  if [ -f "$LAB_KUBECONFIG" ] && vm_running && node2_registered; then
    if lab_kubectl "$1" "$LAB2_NAME" >/dev/null; then say "node $LAB2_NAME: ${1}ed"
    else say "warning: could not $1 node $LAB2_NAME"; fi
  fi
}
