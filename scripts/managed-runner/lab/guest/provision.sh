#!/usr/bin/env bash
# Runs inside a lab VM as root, copied there by create.sh with lab.env beside it.
#   first VM:  provision.sh base | link 1 | ceph | k3s | csi-secret | facts | health | memory | trim
#   second VM: provision.sh base agent | link 2 | k3s-agent | agent-facts | agent-health | memory | trim
# Every step can be rerun: finished work is detected and skipped.
# Never print a CephX key: the CSI key goes from Ceph straight into a Kubernetes Secret.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../lab.env
. "$HERE/lab.env"
step=${1:?usage: provision.sh base [agent]|link 1|2|ceph|k3s|k3s-agent|csi-secret|facts|agent-facts|health|agent-health|memory|trim}
STATE=/var/lib/orbit-lab
mkdir -p "$STATE"
export DEBIAN_FRONTEND=noninteractive
log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$step" "$*"; }

# cephadm shell runs the pinned image's CLI; its "Inferring ..." notes on stderr are dropped.
ceph() { cephadm --image "$CEPH_IMAGE" shell -- ceph "$@" 2> >(grep -v '^Inferring ' >&2); }
rbd() { cephadm --image "$CEPH_IMAGE" shell -- rbd "$@" 2> >(grep -v '^Inferring ' >&2); }
kubectl() { k3s kubectl "$@"; }

fetch() {  # fetch <url> <sha256> <destination>
  curl -fsSL --retry 3 -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum -c --quiet - || { rm -f "$3.part"; log "checksum mismatch: $1"; exit 1; }
  mv "$3.part" "$3"
}

base() {  # base [agent]: the second VM runs no Ceph, so it needs no podman
  local role=${1:-server}
  log "waiting for cloud-init to finish"
  cloud-init status --wait >/dev/null || true
  # Versions stay as pinned while tests run: no unattended upgrades in this test-only VM.
  systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
  # multipathd would claim /dev/rbd* devices; the others are unused here and cost memory.
  systemctl disable --now multipathd.service multipathd.socket snapd.service snapd.socket snapd.seeded.service \
    fwupd.service fwupd-refresh.timer udisks2.service 2>/dev/null || true
  # Give free memory back to the host: free page reporting (virtio-balloon) in 32 KiB chunks instead
  # of the default 2 MiB, which misses most of a busy guest's free memory, and clean page cache
  # (container images, logs) dropped every 5 minutes so that it becomes free memory to report.
  echo 'w /sys/module/page_reporting/parameters/page_reporting_order - - - - 3' \
    > /etc/tmpfiles.d/orbit-lab-page-reporting.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/orbit-lab-page-reporting.conf
  cat > /etc/systemd/system/orbit-lab-drop-caches.service <<'EOF'
[Unit]
Description=Drop clean page cache so the host gets the memory back (Orbit managed-runner lab)

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo 1 > /proc/sys/vm/drop_caches'
EOF
  cat > /etc/systemd/system/orbit-lab-drop-caches.timer <<'EOF'
[Unit]
Description=Drop clean page cache every 5 minutes (Orbit managed-runner lab)

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now orbit-lab-drop-caches.timer
  if [ "$role" != agent ]; then
    apt-get update -qq
    # catatonit is only a recommendation of podman, but cephadm runs every container with --init.
    apt-get install -y -qq --no-install-recommends podman catatonit >/dev/null
  fi
  if ! modinfo rbd >/dev/null 2>&1; then
    apt-get update -qq
    log "rbd is not in the base modules: installing linux-modules-extra-$(uname -r)"
    apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null
  fi
  echo rbd > /etc/modules-load.d/orbit-lab-rbd.conf
  modprobe rbd
  log "kernel $(uname -r); rbd module $(modinfo -F filename rbd)$([ "$role" = agent ] || echo "; podman $(podman --version | awk '{print $3}')")"
  touch "$STATE/base.done"
}

link_step() {  # link 1|2: the NIC joined to the other VM by qemu, under a fixed name and address
  local node=${1:?usage: provision.sh link 1|2} ip mac prefix=${LAB_LINK_NET#*/} file=/etc/netplan/60-orbit-lab-link.yaml want
  case "$node" in
    1) ip=$LAB_LINK_IP mac=$LAB_LINK_MAC ;;
    2) ip=$LAB2_LINK_IP mac=$LAB2_LINK_MAC ;;
    *) log "usage: provision.sh link 1|2"; exit 2 ;;
  esac
  # No DHCP on the link; ignore-carrier keeps the address while the other VM is off.
  want=$(cat <<EOF
# The link to the other lab VM (a QEMU socket netdev). Written by the lab's provision.sh link.
network:
  version: 2
  ethernets:
    $LAB_LINK_IFACE:
      match:
        macaddress: "$mac"
      set-name: $LAB_LINK_IFACE
      addresses: ["$ip/$prefix"]
      dhcp4: false
      dhcp6: false
      accept-ra: false
      link-local: []
      ignore-carrier: true
EOF
)
  if [ "$(cat "$file" 2>/dev/null)" != "$want" ]; then
    (umask 077 && printf '%s\n' "$want" > "$file.part")
    mv "$file.part" "$file"
  fi
  if ! ip -4 -o addr show dev "$LAB_LINK_IFACE" 2>/dev/null | grep -q " $ip/$prefix "; then
    log "configuring the link NIC ($mac) as $LAB_LINK_IFACE $ip/$prefix"
    netplan apply
    local deadline=$(( SECONDS + 60 ))
    until ip -4 -o addr show dev "$LAB_LINK_IFACE" 2>/dev/null | grep -q " $ip/$prefix "; do
      [ "$SECONDS" -lt "$deadline" ] || { log "$LAB_LINK_IFACE did not get $ip/$prefix"; ip -br link; exit 1; }
      sleep 2
    done
  fi
  # Both nodes' names resolve to their link addresses (cloud-init wrote the user network's).
  local hosts
  hosts=$(awk -v a="$LAB_NAME" -v b="$LAB2_NAME" '!(NF == 2 && ($2 == a || $2 == b))' /etc/hosts)
  hosts=$(printf '%s\n%s %s\n%s %s' "$hosts" "$LAB_LINK_IP" "$LAB_NAME" "$LAB2_LINK_IP" "$LAB2_NAME")
  [ "$hosts" = "$(cat /etc/hosts)" ] || printf '%s\n' "$hosts" > /etc/hosts
  log "$LAB_LINK_IFACE $ip/$prefix ($mac); /etc/hosts: $LAB_NAME $LAB_LINK_IP, $LAB2_NAME $LAB2_LINK_IP"
}

k3s_binary() {
  if [ ! -x /usr/local/bin/k3s ] || [ "$(/usr/local/bin/k3s --version | awk 'NR==1 {print $3}')" != "$K3S_VERSION" ]; then
    local release=https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION/+/%2B}
    fetch "$release/k3s" "$K3S_SHA256" /usr/local/bin/k3s
    chmod 0755 /usr/local/bin/k3s
  fi
  install -d -m 0755 /etc/rancher/k3s
}

# Run the installer only for a first install, a new binary or a config.yaml that k3s has not been
# started with. The installer restarts k3s by itself only when its binary or unit changed, so a
# new config asks for the restart; the config it started with is remembered by its hash.
k3s_install() {  # k3s_install <done marker> [agent]
  local applied=$STATE/k3s-config.sha256 current changed=false
  current=$(sha256sum /etc/rancher/k3s/config.yaml | cut -d' ' -f1)
  [ "$(cat "$applied" 2>/dev/null)" = "$current" ] || changed=true
  if [ ! -f "$STATE/$1" ] || [ "$changed" = true ] || [ "$(cat "$STATE/k3s.installed" 2>/dev/null)" != "$K3S_SHA256" ]; then
    fetch "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION/+/%2B}/install.sh" "$K3S_INSTALL_SH_SHA256" "$STATE/k3s-install.sh"
    INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC="${2:-}" \
      INSTALL_K3S_FORCE_RESTART="$changed" sh "$STATE/k3s-install.sh" >/dev/null
    echo "$K3S_SHA256" > "$STATE/k3s.installed"
    echo "$current" > "$applied"
  fi
}

# Shutdown order: k3s stops, then this unit releases RBD (Pods' containers, mounts, maps), then
# what the RBD client needs goes: Ceph in the first VM, the network to it in the second.
release_unit() {  # release_unit <what goes after it> <its units> <k3s unit>
  install -m 0755 "$HERE/release-rbd.sh" /usr/local/sbin/orbit-lab-release-rbd
  cat > /etc/systemd/system/orbit-lab-rbd-release.service <<EOF
[Unit]
Description=Release kernel RBD devices before $1 stops (Orbit managed-runner lab)
Wants=${2%% *}
After=$2
Before=$3

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/usr/local/sbin/orbit-lab-release-rbd
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now orbit-lab-rbd-release.service
}

k3s_step() {
  k3s_binary
  cat > /etc/rancher/k3s/config.yaml <<EOF
write-kubeconfig-mode: "0600"
node-name: $LAB_NAME
# Node traffic, the API server's address and flannel's VXLAN use the link to the second VM.
node-ip: $LAB_LINK_IP
flannel-iface: $LAB_LINK_IFACE
tls-san: ["$LAB_LINK_IP"]
disable: [traefik, servicelb, metrics-server, local-storage]
disable-helm-controller: true
secrets-encryption: true
kubelet-arg:
  # Ceph runs beside k3s, outside the kubelet's accounting: keep it out of what Pods may claim.
  - "system-reserved=cpu=1,memory=3Gi"
  - "eviction-hard=memory.available<256Mi,nodefs.available<10%,imagefs.available<10%"
EOF
  k3s_install k3s.done
  release_unit Ceph ceph.target k3s.service
  local deadline=$(( SECONDS + 300 ))
  until kubectl get node "$LAB_NAME" >/dev/null 2>&1; do  # registered a moment after k3s starts
    [ "$SECONDS" -lt "$deadline" ] || { log "node $LAB_NAME did not register"; exit 1; }
    sleep 3
  done
  kubectl wait --for=condition=Ready "node/$LAB_NAME" --timeout=300s
  deadline=$(( SECONDS + 300 ))
  until [ "$(kubectl get node "$LAB_NAME" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')" = "$LAB_LINK_IP" ]; do
    [ "$SECONDS" -lt "$deadline" ] || { log "node $LAB_NAME does not report $LAB_LINK_IP"; exit 1; }
    sleep 3
  done
  log "$(k3s --version | head -1), node IP $LAB_LINK_IP"
  touch "$STATE/k3s.done"
}

# The second VM: a k3s agent of the first VM's server, over the link. create.sh writes the join
# token into /etc/rancher/k3s/agent-token (0600) straight from the server; it is never printed.
k3s_agent_step() {
  k3s_binary
  [ -s /etc/rancher/k3s/agent-token ] || { log "no join token in /etc/rancher/k3s/agent-token (create.sh writes it)"; exit 1; }
  (umask 077 && cat > /etc/rancher/k3s/config.yaml <<EOF
node-name: $LAB2_NAME
server: https://$LAB_LINK_IP:6443
token-file: /etc/rancher/k3s/agent-token
node-ip: $LAB2_LINK_IP
flannel-iface: $LAB_LINK_IFACE
kubelet-arg:
  # No Ceph beside the agent: a smaller reservation than the server's.
  - "system-reserved=$LAB2_SYSTEM_RESERVED"
  - "eviction-hard=memory.available<256Mi,nodefs.available<10%,imagefs.available<10%"
EOF
)
  k3s_install k3s-agent.done agent
  release_unit "the network" "network-online.target systemd-networkd.service" k3s-agent.service
  local deadline=$(( SECONDS + 300 ))
  until [ "$(curl -fsS http://127.0.0.1:10248/healthz 2>/dev/null)" = ok ]; do  # the kubelet, once it joined
    [ "$SECONDS" -lt "$deadline" ] || { log "the kubelet of $LAB2_NAME is not healthy"; journalctl -u k3s-agent -n 20 --no-pager; exit 1; }
    sleep 3
  done
  log "$(k3s --version | head -1), agent of https://$LAB_LINK_IP:6443"
  touch "$STATE/k3s-agent.done"
}

# A cluster bootstrapped before the link existed (task L0) has its MON, mgr and OSDs on the user
# network's address, which the second VM cannot reach (its own user network has the same one).
# Move them to the link address, keeping every pool, image and key: a monmap with the new MON
# address injected into the stopped MON (Ceph's "Changing a Monitor's IP Address (Advanced Method)"),
# the configs that name the MON rewritten, and the other daemons restarted on the new public
# network. A rerun after an interruption picks up whatever is still on another address.
ceph_readdress() {  # ceph_readdress <fsid>
  local fsid=$1 mon=$LAB_NAME old dir=/var/lib/orbit-lab/readdress daemon stale deadline
  old=$(ceph mon dump -f json | jq -r --arg m "$mon" \
    '.mons[] | select(.name == $m) | .public_addrs.addrvec[] | select(.type == "v2") | .addr | sub(":[0-9]+$"; "")')
  [ -n "$old" ] || { log "no address of mon.$mon in the monmap"; exit 1; }
  if [ "$old" != "$LAB_LINK_IP" ]; then
    if [ -n "$(ls /sys/bus/rbd/devices/ 2>/dev/null)" ]; then
      # A kernel RBD client knows the MON and OSDs by their old address: its I/O would hang.
      log "RBD devices are mapped here: delete the Pods that mount RBD volumes, then rerun"
      exit 1
    fi
    log "moving the cluster from $old to $LAB_LINK_IP"
    # While the MON still answers at the old address: the network the daemons bind to, and the
    # address cephadm reaches this host at (sshd listens on every address).
    ceph config set global public_network "$LAB_LINK_NET"
    ceph orch host set-addr "$mon" "$LAB_LINK_IP" >/dev/null
    rm -rf "$dir" && install -d -m 0755 "$dir"
    cephadm --image "$CEPH_IMAGE" shell --mount "$dir:/mnt/readdress" -- sh -ec "
      ceph mon getmap -o /mnt/readdress/monmap
      monmaptool --rm $mon /mnt/readdress/monmap
      monmaptool --addv $mon '[v2:$LAB_LINK_IP:3300,v1:$LAB_LINK_IP:6789]' /mnt/readdress/monmap
      monmaptool --print /mnt/readdress/monmap" </dev/null 2> >(grep -v '^Inferring ' >&2)
    chmod 0644 "$dir/monmap"
    systemctl stop "ceph-$fsid@mon.$mon.service"
    cephadm --image "$CEPH_IMAGE" shell --name "mon.$mon" --mount "$dir:/mnt/readdress" -- \
      ceph-mon -i "$mon" --inject-monmap /mnt/readdress/monmap --setuser ceph --setgroup ceph \
      </dev/null 2> >(grep -v '^Inferring ' >&2)
    local old_re=${old//./\\.}
    sed -i -e "s/\([^0-9]\)$old_re:/\1$LAB_LINK_IP:/g" -e "s|^\([[:space:]]*public network = \).*|\1$LAB_LINK_NET|" \
      /etc/ceph/ceph.conf "/var/lib/ceph/$fsid/config/ceph.conf" /var/lib/ceph/"$fsid"/*/config
    systemctl start "ceph-$fsid@mon.$mon.service"
    deadline=$(( SECONDS + 300 ))
    until ceph mon dump -f json 2>/dev/null | jq -e --arg a "$LAB_LINK_IP:3300" '[.mons[].public_addrs.addrvec[].addr] | index($a)' >/dev/null; do
      [ "$SECONDS" -lt "$deadline" ] || { log "mon.$mon does not answer at $LAB_LINK_IP"; exit 1; }
      sleep 5
    done
    rm -rf "$dir"
    # The crash agent reads the MON address from its config only when it starts.
    systemctl restart "ceph-$fsid@crash.$mon.service" || true
  fi
  # The mgr and every OSD still bound to another address come back on the link when they restart.
  stale=$( { ceph osd dump -f json | jq -r --arg ip "$LAB_LINK_IP:" \
               '.osds[] | select(any(.public_addrs.addrvec[]; .addr | startswith($ip) | not)) | "osd.\(.osd)"'
             ceph mgr dump -f json | jq -r --arg ip "$LAB_LINK_IP:" \
               'select(any(.active_addrs.addrvec[]; .addr | startswith($ip) | not)) | "mgr.\(.active_name)"'; } | xargs)
  [ -n "$stale" ] || return 0
  log "restarting on $LAB_LINK_NET: $stale"
  for daemon in $stale; do
    # cephadm's units leave the old container's conmon behind for a moment (KillMode=none), so a
    # restart can fail with "Device or resource busy"; systemd starts the unit again by itself.
    systemctl restart "ceph-$fsid@$daemon.service" || log "ceph-$fsid@$daemon: the restart failed once; systemd retries it"
  done
  deadline=$(( SECONDS + 600 ))
  until [ "$(ceph osd dump -f json | jq --arg ip "$LAB_LINK_IP:" \
             '[.osds[] | select(.up == 1) | .public_addrs.addrvec[].addr | select(startswith($ip))] | length')" -ge $(( LAB_OSD_COUNT * 2 )) ] \
        && ceph mgr dump -f json | jq -e --arg ip "$LAB_LINK_IP:" 'all(.active_addrs.addrvec[]; .addr | startswith($ip))' >/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || { log "the OSDs and the mgr did not come back on $LAB_LINK_IP"; exit 1; }
    sleep 5
  done
  # cephadm still lists a daemon whose restart failed once as failed until it looks again.
  ceph orch ps --refresh >/dev/null
  log "the MON, the mgr and $LAB_OSD_COUNT OSDs are on $LAB_LINK_IP"
}

ceph_step() {
  if [ ! -x /usr/local/sbin/cephadm ]; then
    fetch "$CEPHADM_URL" "$CEPHADM_SHA256" /usr/local/sbin/cephadm
    chmod 0755 /usr/local/sbin/cephadm
  fi
  podman image exists "$CEPH_IMAGE" || podman pull -q "$CEPH_IMAGE" >/dev/null
  if [ ! -s /etc/ceph/ceph.conf ]; then
    log "bootstrapping a single-host cluster on $LAB_LINK_IP"
    cephadm --image "$CEPH_IMAGE" bootstrap --mon-ip "$LAB_LINK_IP" --single-host-defaults \
      --skip-dashboard --skip-monitoring-stack --skip-firewalld --skip-pull > "$STATE/bootstrap.log" 2>&1 \
      || { tail -20 "$STATE/bootstrap.log"; exit 1; }
  fi
  local fsid
  fsid=$(awk '$1 == "fsid" {print $3}' /etc/ceph/ceph.conf)
  log "fsid $fsid"
  ceph_readdress "$fsid"
  # Every daemon binds to the link, the network the second VM reaches this one on.
  ceph config set global public_network "$LAB_LINK_NET"
  # One host: one mon and one mgr (the default specs ask for 5 and 2).
  ceph orch apply mon --placement="$LAB_NAME" >/dev/null
  ceph orch apply mgr --placement="$LAB_NAME" >/dev/null

  # Memory: the smallest targets that leave room for k3s and later workloads in 6 GiB.
  ceph config set osd osd_memory_target_autotune false
  ceph config set osd osd_memory_target "$LAB_OSD_MEMORY_TARGET"
  ceph config set mon mon_memory_target "$LAB_MON_MEMORY_TARGET"
  # Slow BlueStore operations are routine on the one HDD the host shares with every session: let
  # the alert clear 10 minutes after the last one rather than the default 24 hours.
  ceph config set osd bluestore_slow_ops_warn_lifetime 600
  ceph device monitoring off
  ceph orch ls --service-type ceph-exporter 2>/dev/null | grep -q ceph-exporter && ceph orch rm ceph-exporter >/dev/null
  ceph mgr module disable nfs || true
  ceph mgr module disable nvmeof || true
  # One host: replicas go to distinct OSDs (CRUSH failure domain osd), never a single copy.
  ceph config set global osd_pool_default_size "$LAB_POOL_SIZE"
  ceph config set global osd_pool_default_min_size "$LAB_POOL_MIN_SIZE"

  local index serial device
  for index in $(seq 0 $(( LAB_OSD_COUNT - 1 ))); do
    serial=orbit-osd-$index
    device=$(readlink -f "/dev/disk/by-id/virtio-$serial")
    [ -b "$device" ] || { log "no disk with serial $serial"; exit 1; }
    if [ -n "$(lsblk -no FSTYPE "$device" | grep -v '^$' || true)" ]; then
      log "$device ($serial) already holds an OSD"
      continue
    fi
    log "creating an OSD on $device ($serial)"
    ceph orch daemon add osd "$LAB_NAME:$device"
  done
  local deadline=$(( SECONDS + 600 ))
  until [ "$(ceph osd stat -f json | jq '.num_up_osds')" -ge "$LAB_OSD_COUNT" ]; do
    [ "$SECONDS" -lt "$deadline" ] || { log "OSDs did not come up"; exit 1; }
    sleep 5
  done

  if ! ceph osd pool ls | grep -qx "$LAB_POOL"; then
    ceph osd pool create "$LAB_POOL" 32 32 replicated
  fi
  for pool in .mgr "$LAB_POOL"; do
    ceph osd pool set "$pool" size "$LAB_POOL_SIZE" >/dev/null
    ceph osd pool set "$pool" min_size "$LAB_POOL_MIN_SIZE" >/dev/null
  done
  ceph osd pool application get "$LAB_POOL" | grep -q rbd || rbd pool init "$LAB_POOL"

  # The CSI identity: the documented pool-scoped RBD profile, nothing more. The keyring it
  # returns goes to /dev/null; csi-secret moves the key into Kubernetes without printing it.
  ceph auth get-or-create "client.$LAB_CEPH_CLIENT" mon 'profile rbd' \
    osd "profile rbd pool=$LAB_POOL" mgr "profile rbd pool=$LAB_POOL" >/dev/null
  deadline=$(( SECONDS + 600 ))
  local failed_over=0 health
  until health=$(ceph health detail) && grep -q HEALTH_OK <<<"$health"; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "$health"; log "Ceph is not HEALTH_OK"; exit 1; }
    # Seen on 20.2.4: right after bootstrap, cephadm calls the mon and mgr it deployed itself
    # "stray"; a mgr failover clears that stale view.
    if [ "$failed_over" -eq 0 ] && grep -q CEPHADM_STRAY_DAEMON <<<"$health"; then
      log "cephadm reports its own bootstrap daemons as stray: failing the mgr over once"
      ceph mgr fail
      failed_over=1
    fi
    sleep 10
  done
  log "$(ceph health)"
  touch "$STATE/ceph.done"
}

csi_secret() {
  kubectl get namespace "$LAB_CSI_NAMESPACE" >/dev/null
  ceph auth print-key "client.$LAB_CEPH_CLIENT" \
    | kubectl -n "$LAB_CSI_NAMESPACE" create secret generic "$LAB_CSI_SECRET" \
        --from-literal=userID="$LAB_CEPH_CLIENT" --from-file=userKey=/dev/stdin --dry-run=client -o json \
    | kubectl apply -f - >/dev/null
  # Compare without printing either value.
  if [ "$(ceph auth print-key "client.$LAB_CEPH_CLIENT" | sha256sum)" = \
       "$(kubectl -n "$LAB_CSI_NAMESPACE" get secret "$LAB_CSI_SECRET" -o jsonpath='{.data.userKey}' | base64 -d | sha256sum)" ]; then
    log "Secret $LAB_CSI_NAMESPACE/$LAB_CSI_SECRET holds the key of client.$LAB_CEPH_CLIENT"
  else
    log "Secret $LAB_CSI_NAMESPACE/$LAB_CSI_SECRET does not match the Ceph key"; exit 1
  fi
}

# CephX key type from the key's header (two little-endian bytes); the secret bytes are never shown.
# 1 is CEPH_CRYPTO_AES, 2 is CEPH_CRYPTO_AES256KRB5 ("aes256k"), as in Ceph's src/include/ceph_fs.h.
key_type() {
  ceph auth print-key "client.$1" | base64 -d | head -c 2 | od -An -tu2 | tr -d ' '
}

facts() {
  local fsid
  fsid=$(awk '$1 == "fsid" {print $3}' /etc/ceph/ceph.conf)
  jq -n \
    --arg kernel "$(uname -r)" \
    --arg os "$(. /etc/os-release && echo "$PRETTY_NAME")" \
    --arg rbdModule "$(modinfo -F filename rbd)" \
    --arg rbdLoaded "$(grep -c '^rbd ' /proc/modules || true)" \
    --arg k3s "$(k3s --version | head -1)" \
    --arg podman "$(podman --version)" \
    --arg cephadm "$(sha256sum /usr/local/sbin/cephadm | cut -d' ' -f1)" \
    --arg fsid "$fsid" \
    --argjson versions "$(ceph versions -f json)" \
    --argjson mons "$(ceph mon dump -f json | jq '[.mons[] | {name, public_addrs}]')" \
    --arg allowedCiphers "$(ceph mon dump 2>/dev/null | grep -i cipher || true)" \
    --argjson osds "$(ceph osd tree -f json | jq '[.nodes[] | select(.type == "osd") | {name, status, device_class}]')" \
    --argjson pool "$(ceph osd pool get "$LAB_POOL" all -f json | jq '{pool, size, min_size, pg_num, crush_rule}')" \
    --argjson rule "$(ceph osd crush rule dump replicated_rule -f json | jq '[.steps[] | select(.op | test("choose"))]')" \
    --argjson csiUser "$(ceph auth get "client.$LAB_CEPH_CLIENT" -f json | jq '[.[] | {entity, caps}]')" \
    --arg csiKeyType "$(key_type "$LAB_CEPH_CLIENT")" \
    --arg adminKeyType "$(key_type admin)" \
    --argjson memoryTargets "$(jq -n --arg osd "$(ceph config get osd osd_memory_target)" --arg mon "$(ceph config get mon mon_memory_target)" '{osd: $osd, mon: $mon}')" \
    --arg publicNetwork "$(ceph config get mon public_network)" \
    --argjson osdAddrs "$(ceph osd dump -f json | jq '[.osds[] | {osd, public: [.public_addrs.addrvec[].addr], cluster: [.cluster_addrs.addrvec[].addr]}]')" \
    --argjson link "$(link_facts)" \
    '{kernel: $kernel, os: $os, rbdModule: $rbdModule, rbdLoaded: $rbdLoaded, k3s: $k3s, podman: $podman,
      cephadmSHA256: $cephadm, fsid: $fsid, cephVersions: $versions, mons: $mons, allowedCiphers: $allowedCiphers,
      osds: $osds, pool: $pool, crushRuleChoose: $rule, csiUser: $csiUser,
      keyTypeIds: {csi: $csiKeyType, admin: $adminKeyType}, memoryTargets: $memoryTargets,
      publicNetwork: $publicNetwork, osdAddrs: $osdAddrs, link: $link}'
}

link_facts() {  # the link NIC as the guest sees it
  local mac
  mac=$(ip -j link show dev "$LAB_LINK_IFACE" 2>/dev/null | jq -r '.[0].address // empty')
  ip -j -4 addr show dev "$LAB_LINK_IFACE" 2>/dev/null | jq -c --arg mac "$mac" \
    '[.[] | {ifname, mac: $mac, operstate, mtu, addresses: [.addr_info[] | .local + "/" + (.prefixlen | tostring)]}][0] // null'
}

agent_facts() {
  jq -n \
    --arg kernel "$(uname -r)" \
    --arg os "$(. /etc/os-release && echo "$PRETTY_NAME")" \
    --arg rbdModule "$(modinfo -F filename rbd)" \
    --arg rbdLoaded "$(grep -c '^rbd ' /proc/modules || true)" \
    --arg k3s "$(k3s --version | head -1)" \
    --arg pageReportingOrder "$(cat /sys/module/page_reporting/parameters/page_reporting_order)" \
    --argjson link "$(link_facts)" \
    --arg server "https://$LAB_LINK_IP:6443" \
    '{kernel: $kernel, os: $os, rbdModule: $rbdModule, rbdLoaded: $rbdLoaded, k3s: $k3s, server: $server,
      pageReportingOrder: $pageReportingOrder, link: $link}'
}

trim() {  # after image pulls: hand the page cache back to the host now rather than at the next timer
  sync
  echo 1 > /proc/sys/vm/drop_caches
  log "page cache dropped; $(free -m | awk '/^Mem:/ {print $3 " MiB used, " $6 " MiB cache, " $4 " MiB free"}')"
}

health() {
  local problems=() status=null listeners
  systemctl is-active --quiet k3s || problems+=("k3s is not active")
  systemctl is-active --quiet orbit-lab-rbd-release || problems+=("orbit-lab-rbd-release is not active")
  grep -q '^rbd ' /proc/modules || problems+=("the rbd module is not loaded")
  ip -4 -o addr show dev "$LAB_LINK_IFACE" 2>/dev/null | grep -q " $LAB_LINK_IP/" || problems+=("$LAB_LINK_IFACE has no $LAB_LINK_IP")
  # Where the Ceph daemons listen: on the link, which the second VM reaches, not the user network.
  listeners=$(ss -Hltnp | awk '/"ceph-(mon|mgr|osd)"/ {sub(/:[0-9]+$/, "", $4); print $4}' | sort -u | xargs)
  ss -Hltn "( sport = :3300 )" | awk '{print $4}' | grep -qx "$LAB_LINK_IP:3300" || problems+=("the Ceph MON does not listen on $LAB_LINK_IP:3300")
  [[ " $listeners " != *" $LAB_GUEST_IP "* ]] || problems+=("a Ceph daemon still listens on $LAB_GUEST_IP")
  if status=$(ceph status -f json 2>/dev/null) && [ -n "$status" ]; then
    [ "$(jq -r .health.status <<<"$status")" = HEALTH_OK ] || problems+=("Ceph is $(jq -r .health.status <<<"$status")")
    [ "$(jq .osdmap.num_up_osds <<<"$status")" -ge "$LAB_OSD_COUNT" ] || problems+=("not every OSD is up")
  else
    status=null
    problems+=("no answer from Ceph")
  fi
  jq -n --argjson status "$status" --arg listeners "$listeners" --arg problems "$(printf '%s\n' "${problems[@]}")" \
    '{cephHealth: $status.health.status, osdsUp: $status.osdmap.num_up_osds, osdsIn: $status.osdmap.num_in_osds,
      pgStates: $status.pgmap.pgs_by_state, cephListens: $listeners,
      problems: ($problems | split("\n") | map(select(. != "")))}'
}

# The second VM: its agent, its RBD client, and the first VM's Ceph reached over the link.
agent_health() {
  local problems=() port rtt mapped
  systemctl is-active --quiet k3s-agent || problems+=("k3s-agent is not active")
  systemctl is-active --quiet orbit-lab-rbd-release || problems+=("orbit-lab-rbd-release is not active")
  grep -q '^rbd ' /proc/modules || problems+=("the rbd module is not loaded")
  ip -4 -o addr show dev "$LAB_LINK_IFACE" 2>/dev/null | grep -q " $LAB2_LINK_IP/" || problems+=("$LAB_LINK_IFACE has no $LAB2_LINK_IP")
  rtt=$(ping -c 3 -i 0.2 -W 2 "$LAB_LINK_IP" 2>/dev/null | awk -F/ '/^rtt/ {print $5}')
  [ -n "$rtt" ] || problems+=("no ping answer from $LAB_LINK_IP over the link")
  for port in 3300 6789; do
    timeout 3 bash -c "exec 3<>/dev/tcp/$LAB_LINK_IP/$port" 2>/dev/null || problems+=("Ceph MON $LAB_LINK_IP:$port unreachable")
  done
  mapped=$(find /sys/bus/rbd/devices -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
  jq -n --arg rtt "$rtt" --argjson mapped "$mapped" --arg problems "$(printf '%s\n' "${problems[@]}")" \
    '{linkRttMs: $rtt, rbdMapped: $mapped, problems: ($problems | split("\n") | map(select(. != "")))}'
}

memory() {
  echo "== free -m"; free -m
  echo "== resident memory by process (MiB, top 25)"
  ps -eo rss=,comm= --sort=-rss | head -25 | awk '{printf "%7.1f  %s\n", $1 / 1024, $2}'
  echo "== Ceph daemons (podman)"
  podman stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null | sed 's/^ceph-[0-9a-f-]*-//'
}

case "$step" in
  base) base "${2:-}" ;;
  link) link_step "${2:-}" ;;
  k3s) k3s_step ;;
  k3s-agent) k3s_agent_step ;;
  ceph) ceph_step ;;
  csi-secret) csi_secret ;;
  facts) facts ;;
  agent-facts) agent_facts ;;
  health) health ;;
  agent-health) agent_health ;;
  trim) trim ;;
  memory) memory ;;
  *) log "unknown step"; exit 2 ;;
esac
