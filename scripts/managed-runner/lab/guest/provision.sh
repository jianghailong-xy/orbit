#!/usr/bin/env bash
# Runs inside the lab VM as root, copied there by create.sh with lab.env beside it.
#   provision.sh base | k3s | ceph | csi-secret | facts | health | memory | trim
# Every step can be rerun: finished work is detected and skipped.
# Never print a CephX key: the CSI key goes from Ceph straight into a Kubernetes Secret.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../lab.env
. "$HERE/lab.env"
step=${1:?usage: provision.sh base|k3s|ceph|csi-secret|facts|health|memory|trim}
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

base() {
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
  apt-get update -qq
  # catatonit is only a recommendation of podman, but cephadm runs every container with --init.
  apt-get install -y -qq --no-install-recommends podman catatonit >/dev/null
  if ! modinfo rbd >/dev/null 2>&1; then
    log "rbd is not in the base modules: installing linux-modules-extra-$(uname -r)"
    apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null
  fi
  echo rbd > /etc/modules-load.d/orbit-lab-rbd.conf
  modprobe rbd
  log "kernel $(uname -r); rbd module $(modinfo -F filename rbd); podman $(podman --version | awk '{print $3}')"
  touch "$STATE/base.done"
}

k3s_step() {
  if [ ! -x /usr/local/bin/k3s ] || [ "$(/usr/local/bin/k3s --version | awk 'NR==1 {print $3}')" != "$K3S_VERSION" ]; then
    local release=https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION/+/%2B}
    fetch "$release/k3s" "$K3S_SHA256" /usr/local/bin/k3s
    chmod 0755 /usr/local/bin/k3s
  fi
  install -d -m 0755 /etc/rancher/k3s
  local config_before
  config_before=$(sha256sum /etc/rancher/k3s/config.yaml 2>/dev/null || true)
  cat > /etc/rancher/k3s/config.yaml <<EOF
write-kubeconfig-mode: "0600"
node-name: $LAB_NAME
node-ip: $LAB_GUEST_IP
disable: [traefik, servicelb, metrics-server, local-storage]
disable-helm-controller: true
secrets-encryption: true
kubelet-arg:
  # Ceph runs beside k3s, outside the kubelet's accounting: keep it out of what Pods may claim.
  - "system-reserved=cpu=1,memory=3Gi"
  - "eviction-hard=memory.available<256Mi,nodefs.available<10%,imagefs.available<10%"
EOF
  # The installer restarts k3s: run it only for a first install, a new binary or a new config.
  if [ ! -f "$STATE/k3s.done" ] || [ "$config_before" != "$(sha256sum /etc/rancher/k3s/config.yaml)" ] \
     || [ "$(cat "$STATE/k3s.installed" 2>/dev/null)" != "$K3S_SHA256" ]; then
    fetch "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION/+/%2B}/install.sh" "$K3S_INSTALL_SH_SHA256" "$STATE/k3s-install.sh"
    INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="$K3S_VERSION" sh "$STATE/k3s-install.sh" >/dev/null
    echo "$K3S_SHA256" > "$STATE/k3s.installed"
  fi

  # Shutdown order: k3s stops, then this unit releases RBD (Pods' containers, mounts, maps), then Ceph.
  install -m 0755 "$HERE/release-rbd.sh" /usr/local/sbin/orbit-lab-release-rbd
  cat > /etc/systemd/system/orbit-lab-rbd-release.service <<'EOF'
[Unit]
Description=Release kernel RBD devices before Ceph stops (Orbit managed-runner lab)
Wants=ceph.target
After=ceph.target
Before=k3s.service

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
  local deadline=$(( SECONDS + 300 ))
  until kubectl get node "$LAB_NAME" >/dev/null 2>&1; do  # registered a moment after k3s starts
    [ "$SECONDS" -lt "$deadline" ] || { log "node $LAB_NAME did not register"; exit 1; }
    sleep 3
  done
  kubectl wait --for=condition=Ready "node/$LAB_NAME" --timeout=300s
  log "$(k3s --version | head -1)"
  touch "$STATE/k3s.done"
}

ceph_step() {
  if [ ! -x /usr/local/sbin/cephadm ]; then
    fetch "$CEPHADM_URL" "$CEPHADM_SHA256" /usr/local/sbin/cephadm
    chmod 0755 /usr/local/sbin/cephadm
  fi
  podman image exists "$CEPH_IMAGE" || podman pull -q "$CEPH_IMAGE" >/dev/null
  if [ ! -s /etc/ceph/ceph.conf ]; then
    log "bootstrapping a single-host cluster on $LAB_GUEST_IP"
    cephadm --image "$CEPH_IMAGE" bootstrap --mon-ip "$LAB_GUEST_IP" --single-host-defaults \
      --skip-dashboard --skip-monitoring-stack --skip-firewalld --skip-pull > "$STATE/bootstrap.log" 2>&1 \
      || { tail -20 "$STATE/bootstrap.log"; exit 1; }
  fi
  local fsid
  fsid=$(awk '$1 == "fsid" {print $3}' /etc/ceph/ceph.conf)
  log "fsid $fsid"
  # One host: one mon and one mgr (the default specs ask for 5 and 2).
  ceph orch apply mon --placement="$LAB_NAME" >/dev/null
  ceph orch apply mgr --placement="$LAB_NAME" >/dev/null

  # Memory: the smallest targets that leave room for k3s and later workloads in 6 GiB.
  ceph config set osd osd_memory_target_autotune false
  ceph config set osd osd_memory_target "$LAB_OSD_MEMORY_TARGET"
  ceph config set mon mon_memory_target "$LAB_MON_MEMORY_TARGET"
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
    '{kernel: $kernel, os: $os, rbdModule: $rbdModule, rbdLoaded: $rbdLoaded, k3s: $k3s, podman: $podman,
      cephadmSHA256: $cephadm, fsid: $fsid, cephVersions: $versions, mons: $mons, allowedCiphers: $allowedCiphers,
      osds: $osds, pool: $pool, crushRuleChoose: $rule, csiUser: $csiUser,
      keyTypeIds: {csi: $csiKeyType, admin: $adminKeyType}, memoryTargets: $memoryTargets}'
}

trim() {  # after image pulls: hand the page cache back to the host now rather than at the next timer
  sync
  echo 1 > /proc/sys/vm/drop_caches
  log "page cache dropped; $(free -m | awk '/^Mem:/ {print $3 " MiB used, " $6 " MiB cache, " $4 " MiB free"}')"
}

health() {
  local problems=() status=null
  systemctl is-active --quiet k3s || problems+=("k3s is not active")
  systemctl is-active --quiet orbit-lab-rbd-release || problems+=("orbit-lab-rbd-release is not active")
  grep -q '^rbd ' /proc/modules || problems+=("the rbd module is not loaded")
  if status=$(ceph status -f json 2>/dev/null) && [ -n "$status" ]; then
    [ "$(jq -r .health.status <<<"$status")" = HEALTH_OK ] || problems+=("Ceph is $(jq -r .health.status <<<"$status")")
    [ "$(jq .osdmap.num_up_osds <<<"$status")" -ge "$LAB_OSD_COUNT" ] || problems+=("not every OSD is up")
  else
    status=null
    problems+=("no answer from Ceph")
  fi
  jq -n --argjson status "$status" --arg problems "$(printf '%s\n' "${problems[@]}")" \
    '{cephHealth: $status.health.status, osdsUp: $status.osdmap.num_up_osds, osdsIn: $status.osdmap.num_in_osds,
      pgStates: $status.pgmap.pgs_by_state, problems: ($problems | split("\n") | map(select(. != "")))}'
}

memory() {
  echo "== free -m"; free -m
  echo "== resident memory by process (MiB, top 25)"
  ps -eo rss=,comm= --sort=-rss | head -25 | awk '{printf "%7.1f  %s\n", $1 / 1024, $2}'
  echo "== Ceph daemons (podman)"
  podman stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null | sed 's/^ceph-[0-9a-f-]*-//'
}

case "$step" in
  base) base ;;
  k3s) k3s_step ;;
  ceph) ceph_step ;;
  csi-secret) csi_secret ;;
  facts) facts ;;
  health) health ;;
  trim) trim ;;
  memory) memory ;;
  *) log "unknown step"; exit 2 ;;
esac
