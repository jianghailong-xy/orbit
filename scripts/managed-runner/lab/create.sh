#!/usr/bin/env bash
# Create the lab, or finish creating it: every step checks what exists and skips it, so a run
# that was interrupted is simply run again. Leaves the VM running; stop it with stop.sh.
#   1. host: verified Ubuntu image, kubectl, operator manifest, SSH key, disks, cloud-init seed
#   2. boot (start.sh, with its memory guard)
#   3. guest: base packages, k3s, Ceph (cephadm), kubeconfig
#   4. Ceph-CSI: operator, Secret, CephConnection/ClientProfile/Driver, StorageClass, namespace
# See docs/managed-runner-lab.md for the design, the names it creates and its limits.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root
for tool in qemu-img qemu-system-x86_64 genisoimage ssh ssh-keygen scp curl gpg python3 systemd-run; do
  command -v "$tool" >/dev/null || die "missing host tool: $tool"
done
umask 077
install -d -m 0700 "$LAB_DIR"
for dir in images downloads disks seed ssh bin run logs state; do install -d -m 0700 "$LAB_DIR/$dir"; done
exec > >(tee -a "$LAB_DIR/logs/create.log") 2>&1
say "create: $LAB_DIR"

fetch() {  # fetch <url> <sha256> <destination>: download once, always verify
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    say "downloading $1"
    curl -fsSL --retry 3 -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { rm -f "$3.part"; die "checksum mismatch: $1"; }
    mv "$3.part" "$3"
  fi
}

# 1. Host artifacts.
image=$LAB_DIR/images/$(basename "$LAB_IMAGE_URL")
release=$(dirname "$LAB_IMAGE_URL")
if [ ! -f "$LAB_DIR/images/SHA256SUMS.verified" ]; then
  curl -fsSL -o "$LAB_DIR/images/SHA256SUMS" "$release/SHA256SUMS"
  curl -fsSL -o "$LAB_DIR/images/SHA256SUMS.gpg" "$release/SHA256SUMS.gpg"
  export GNUPGHOME=$LAB_DIR/images/gnupg
  install -d -m 0700 "$GNUPGHOME"
  curl -fsSL -o "$LAB_DIR/images/signing-key.asc" \
    "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$LAB_IMAGE_SIGNING_KEY"
  gpg --batch --quiet --import "$LAB_DIR/images/signing-key.asc"
  gpg --batch --quiet --status-fd 1 --verify "$LAB_DIR/images/SHA256SUMS.gpg" "$LAB_DIR/images/SHA256SUMS" \
    | grep -q "^\[GNUPG:\] VALIDSIG $LAB_IMAGE_SIGNING_KEY " || die "SHA256SUMS is not signed by $LAB_IMAGE_SIGNING_KEY"
  grep -q "^$LAB_IMAGE_SHA256 \*$(basename "$LAB_IMAGE_URL")\$" "$LAB_DIR/images/SHA256SUMS" \
    || die "the signed SHA256SUMS does not list the pinned image checksum"
  touch "$LAB_DIR/images/SHA256SUMS.verified"
  say "SHA256SUMS signature and the pinned image checksum agree"
fi
fetch "$LAB_IMAGE_URL" "$LAB_IMAGE_SHA256" "$image"
fetch "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl" "$KUBECTL_SHA256" "$LAB_KUBECTL"
chmod 0700 "$LAB_KUBECTL"
fetch "$CSI_OPERATOR_INSTALL_URL" "$CSI_OPERATOR_INSTALL_SHA256" "$LAB_DIR/downloads/ceph-csi-operator-install.yaml"
[ -f "$LAB_SSH_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "$LAB_NAME" -f "$LAB_SSH_KEY"

if [ ! -f "$LAB_DIR/disks/root.qcow2" ]; then
  qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$LAB_DIR/disks/root.qcow2" "$LAB_ROOT_DISK_SIZE"
fi
for index in $(seq 0 $(( LAB_OSD_COUNT - 1 ))); do
  disk=$LAB_DIR/disks/osd-$index.qcow2
  [ -f "$disk" ] || qemu-img create -q -f qcow2 "$disk" "$LAB_OSD_DISK_SIZE"
done
if [ ! -f "$LAB_DIR/seed/seed.iso" ]; then
  sed -e "s|@@LAB_NAME@@|$LAB_NAME|g" -e "s|@@LAB_GUEST_IP@@|$LAB_GUEST_IP|g" \
      -e "s|@@SSH_PUBLIC_KEY@@|$(cat "$LAB_SSH_KEY.pub")|" \
      "$LAB_SCRIPTS/cloud-init/user-data" > "$LAB_DIR/seed/user-data"
  printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$LAB_NAME" "$(date -u +%Y%m%d%H%M%S)" "$LAB_NAME" \
    > "$LAB_DIR/seed/meta-data"
  genisoimage -quiet -output "$LAB_DIR/seed/seed.iso" -volid cidata -joliet -rock \
    "$LAB_DIR/seed/user-data" "$LAB_DIR/seed/meta-data"
fi

# 2. Boot.
vm_running || "$LAB_SCRIPTS/start.sh" --no-wait

# 3. Guest.
tar -C "$LAB_SCRIPTS" -cf - lab.env -C "$LAB_SCRIPTS/guest" provision.sh release-rbd.sh \
  | lab_ssh 'sudo rm -rf /opt/orbit-lab && sudo install -d -m 0755 /opt/orbit-lab && sudo tar -C /opt/orbit-lab -xf -'
for step in base ceph k3s; do
  say "guest step: $step"
  lab_ssh sudo /opt/orbit-lab/provision.sh "$step"
done

if [ ! -s "$LAB_KUBECONFIG" ]; then
  raw=$LAB_DIR/run/k3s.yaml
  lab_ssh sudo cat /etc/rancher/k3s/k3s.yaml > "$raw"
  env -u KUBECONFIG "$LAB_KUBECTL" --kubeconfig "$raw" config view --raw -o json \
    | python3 -I -c '
import json, sys
config = json.load(sys.stdin)
name, server, namespace = sys.argv[1:4]
assert len(config["clusters"]) == len(config["users"]) == len(config["contexts"]) == 1
config["clusters"][0]["name"] = name
config["clusters"][0]["cluster"]["server"] = server
config["users"][0]["name"] = name + "-admin"
config["contexts"][0] = {"name": name, "context": {"cluster": name, "user": name + "-admin", "namespace": namespace}}
config["current-context"] = name
json.dump(config, sys.stdout, indent=2)
' "$LAB_NAME" "https://127.0.0.1:$LAB_API_PORT" "$LAB_NAMESPACE" > "$LAB_KUBECONFIG.part"
  rm -f "$raw"
  chmod 0600 "$LAB_KUBECONFIG.part"
  mv "$LAB_KUBECONFIG.part" "$LAB_KUBECONFIG"
  say "kubeconfig $LAB_KUBECONFIG, context $LAB_NAME"
fi

# 4. Ceph-CSI and the storage profile.
fsid=$(lab_ssh "sudo awk '\$1 == \"fsid\" {print \$3}' /etc/ceph/ceph.conf")
[[ $fsid =~ ^[0-9a-f-]{36}$ ]] || die "no Ceph FSID in the guest"
python3 -B "$LAB_SCRIPTS/render.py" namespace | lab_kubectl apply -f -
python3 -B "$LAB_SCRIPTS/render.py" operator "$LAB_DIR/downloads/ceph-csi-operator-install.yaml" \
  | lab_kubectl apply --server-side --force-conflicts -f - >/dev/null
lab_kubectl -n "$LAB_CSI_NAMESPACE" rollout status deployment/ceph-csi-operator-controller-manager --timeout=600s
lab_ssh sudo /opt/orbit-lab/provision.sh csi-secret
python3 -B "$LAB_SCRIPTS/render.py" csi --fsid "$fsid" | lab_kubectl apply -f -
deadline=$(( SECONDS + 900 ))
until lab_kubectl -n "$LAB_CSI_NAMESPACE" get deployment "$LAB_CSI_DRIVER-ctrlplugin" >/dev/null 2>&1 \
   && lab_kubectl -n "$LAB_CSI_NAMESPACE" get daemonset "$LAB_CSI_DRIVER-nodeplugin" >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || die "the operator did not create the RBD driver's workloads"
  sleep 5
done
lab_kubectl -n "$LAB_CSI_NAMESPACE" rollout status "deployment/$LAB_CSI_DRIVER-ctrlplugin" --timeout=900s
lab_kubectl -n "$LAB_CSI_NAMESPACE" rollout status "daemonset/$LAB_CSI_DRIVER-nodeplugin" --timeout=900s
python3 -B "$LAB_SCRIPTS/render.py" storage --fsid "$fsid" | lab_kubectl apply -f -

lab_ssh sudo /opt/orbit-lab/provision.sh facts > "$LAB_DIR/state/facts.json"
say "facts: $LAB_DIR/state/facts.json"
# The image pulls above leave GiBs of page cache in the guest; hand it back to the host now.
lab_ssh sudo /opt/orbit-lab/provision.sh trim
"$LAB_SCRIPTS/status.sh" --wait 900
