# Shared helpers of the lab's host scripts. Source it; it is not run on its own.
# shellcheck shell=bash

LAB_SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lab.env
. "$LAB_SCRIPTS/lab.env"

LAB_KUBECONFIG=$LAB_DIR/kubeconfig.json
LAB_KUBECTL=$LAB_DIR/bin/kubectl
LAB_SSH_KEY=$LAB_DIR/ssh/id_ed25519
LAB_QMP=$LAB_DIR/run/qmp.sock

say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { say "error: $*"; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root: systemd-run and /dev/kvm need it"; }

# Only this VM's context is ever used: no KUBECONFIG, no ~/.kube, no current-context fallback.
lab_kubectl() {
  [ -f "$LAB_KUBECONFIG" ] || die "no kubeconfig yet: $LAB_KUBECONFIG (run create.sh)"
  env -u KUBECONFIG "$LAB_KUBECTL" --kubeconfig "$LAB_KUBECONFIG" --context "$LAB_NAME" "$@"
}

lab_ssh() {
  ssh -i "$LAB_SSH_KEY" -p "$LAB_SSH_PORT" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -o UserKnownHostsFile="$LAB_DIR/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o LogLevel=ERROR ubuntu@127.0.0.1 "$@"
}

lab_scp_to() {  # lab_scp_to <local path>... <guest dir>
  local dest=${*: -1}
  scp -q -r -i "$LAB_SSH_KEY" -P "$LAB_SSH_PORT" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -o UserKnownHostsFile="$LAB_DIR/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o LogLevel=ERROR "${@:1:$#-1}" "ubuntu@127.0.0.1:$dest"
}

vm_running() { systemctl is-active --quiet "$LAB_UNIT.service"; }

mem_available_mib() { awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo; }

# Memory, as the host sees it: what the unit's cgroup holds (guest RAM in use plus qemu overhead).
unit_memory_report() {
  local cg
  cg=/sys/fs/cgroup$(systemctl show -P ControlGroup "$LAB_UNIT.service" 2>/dev/null)
  if [ -r "$cg/memory.current" ]; then
    printf 'unit %s: memory.current %s MiB, memory.peak %s MiB, swap %s MiB, memory.max %s\n' \
      "$LAB_UNIT" "$(( $(cat "$cg/memory.current") / 1048576 ))" \
      "$(( $(cat "$cg/memory.peak" 2>/dev/null || echo 0) / 1048576 ))" \
      "$(( $(cat "$cg/memory.swap.current" 2>/dev/null || echo 0) / 1048576 ))" "$(cat "$cg/memory.max")"
  fi
  printf 'host: MemAvailable %s MiB, SwapFree %s MiB\n' "$(mem_available_mib)" \
    "$(awk '/^SwapFree:/ {print int($2 / 1024)}' /proc/meminfo)"
}

wait_for_ssh() {  # wait_for_ssh <seconds>
  local deadline=$(( SECONDS + $1 ))
  until lab_ssh true 2>/dev/null; do
    vm_running || die "the VM stopped while waiting for SSH; see $LAB_DIR/logs/console.log"
    [ "$SECONDS" -lt "$deadline" ] || die "no SSH after $1 s; see $LAB_DIR/logs/console.log"
    sleep 5
  done
}
