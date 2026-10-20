#!/usr/bin/env bash
# Create the lab, or finish creating it: every step checks what exists and skips it, so a run
# that was interrupted is simply run again. Leaves the VMs running; stop them with stop.sh.
#   create.sh             the first VM: k3s server, Ceph, Ceph-CSI (single-node mode)
#   create.sh --nodes 2   the first VM, then the second, joined to it as a k3s agent
#   1. host: verified Ubuntu image, kubectl, operator manifest, SSH key, disks, cloud-init seeds
#   2. boot the first VM (start.sh, with its memory guard)
#   3. guest: base packages, the link NIC, Ceph (cephadm), k3s, kubeconfig. A lab built before
#      the link existed has its Ceph and k3s moved onto the link address here, data kept.
#   4. Ceph-CSI: operator, Secret, CephConnection/ClientProfile/Driver, StorageClass, namespace
#   5. --nodes 2: boot the second VM, base packages, the link NIC, the join token, the k3s agent,
#      and the CSI node plugin on it
# See docs/managed-runner-lab.md for the design, the names it creates and its limits.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
nodes=1
case "${1:-}" in
  --nodes) [[ ${2:-} =~ ^[12]$ ]] || die "usage: create.sh [--nodes 1|2]"; nodes=$2 ;;
  "") ;;
  *) die "usage: create.sh [--nodes 1|2]" ;;
esac
require_root
for tool in qemu-img qemu-system-x86_64 genisoimage ssh ssh-keygen scp curl gpg python3 systemd-run jq; do
  command -v "$tool" >/dev/null || die "missing host tool: $tool"
done
umask 077
install -d -m 0700 "$LAB_DIR"
for dir in images downloads disks seed ssh bin run logs state; do install -d -m 0700 "$LAB_DIR/$dir"; done
exec > >(tee -a "$LAB_DIR/logs/create.log") 2>&1
say "create: $LAB_DIR, $nodes node(s)"

fetch() {  # fetch <url> <sha256> <destination>: download once, always verify
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    say "downloading $1"
    curl -fsSL --retry 3 -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { rm -f "$3.part"; die "checksum mismatch: $1"; }
    mv "$3.part" "$3"
  fi
}

# A NoCloud seed: user-data (hostname, SSH key, the node's link address in /etc/hosts) and a
# network-config that gives DHCP to the user-network NIC only. Files of the first VM keep the
# names they always had; the second VM's carry the prefix node2-.
make_seed() {  # make_seed <file prefix> <name> <link ip> <user-network MAC>
  local seed=$LAB_DIR/seed/$1
  [ -f "${seed}seed.iso" ] && return 0
  sed -e "s|@@LAB_NAME@@|$2|g" -e "s|@@LINK_IP@@|$3|g" -e "s|@@SSH_PUBLIC_KEY@@|$(cat "$LAB_SSH_KEY.pub")|" \
      "$LAB_SCRIPTS/cloud-init/user-data" > "${seed}user-data"
  printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$2" "$(date -u +%Y%m%d%H%M%S)" "$2" > "${seed}meta-data"
  sed -e "s|@@USER_MAC@@|$4|g" "$LAB_SCRIPTS/cloud-init/network-config" > "${seed}network-config"
  genisoimage -quiet -output "${seed}seed.iso.part" -volid cidata -joliet -rock -graft-points \
    "user-data=${seed}user-data" "meta-data=${seed}meta-data" "network-config=${seed}network-config"
  mv "${seed}seed.iso.part" "${seed}seed.iso"
}

wait_node_plugin() {  # wait_node_plugin <node>: the CSI node plugin's Pod on that node is Ready
  local deadline=$(( SECONDS + 900 ))
  until lab_kubectl -n "$LAB_CSI_NAMESPACE" get pods -o json | jq -e --arg n "$1" --arg ds "$LAB_CSI_DRIVER-nodeplugin" \
          '[.items[] | select(.spec.nodeName == $n and any(.metadata.ownerReferences[]?; .kind == "DaemonSet" and .name == $ds))
            | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length > 0' >/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || die "no ready CSI node plugin on $1 after 900 s"
    sleep 10
  done
  say "CSI node plugin ready on $1"
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
make_seed "" "$LAB_NAME" "$LAB_LINK_IP" "$LAB_USER_MAC"

# 2. Boot.
vm_running || "$LAB_SCRIPTS/start.sh" --no-wait

# 3. Guest.
copy_guest_scripts 1
lab_ssh sudo /opt/orbit-lab/provision.sh base
lab_ssh sudo /opt/orbit-lab/provision.sh link 1
for step in ceph k3s; do
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
wait_node_plugin "$LAB_NAME"
# The operator renders the CephConnection's monitors into the driver's ConfigMap.
deadline=$(( SECONDS + 300 ))
until lab_kubectl -n "$LAB_CSI_NAMESPACE" get configmap ceph-csi-config -o jsonpath='{.data.config\.json}' 2>/dev/null \
        | jq -e --arg m "$LAB_LINK_IP:6789" --arg c "$fsid" '[.[] | select(.clusterID == $c) | .monitors] == [[$m]]' >/dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || die "ceph-csi-config does not name the monitor $LAB_LINK_IP:6789"
  sleep 5
done
python3 -B "$LAB_SCRIPTS/render.py" storage --fsid "$fsid" | lab_kubectl apply -f -

lab_ssh sudo /opt/orbit-lab/provision.sh facts > "$LAB_DIR/state/facts.json"
say "facts: $LAB_DIR/state/facts.json"
# The image pulls above leave GiBs of page cache in the guest; hand it back to the host now.
lab_ssh sudo /opt/orbit-lab/provision.sh trim
vm2_running || cordon_node2 cordon
"$LAB_SCRIPTS/status.sh" --wait 900
[ "$nodes" = 2 ] || exit 0

# 5. The second VM: a k3s agent over the link; Ceph stays in the first VM.
if [ ! -f "$LAB2_ROOT_DISK" ]; then
  qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$LAB2_ROOT_DISK" "$LAB2_ROOT_DISK_SIZE"
  # A node of this name from an earlier second VM holds another node password: k3s would refuse the new one.
  if node2_registered; then
    say "removing node $LAB2_NAME, left by an earlier second VM"
    lab_kubectl delete node "$LAB2_NAME" --wait=true
    lab_kubectl -n kube-system delete secret "$LAB2_NAME.node-password.k3s" --ignore-not-found
  fi
fi
make_seed node2- "$LAB2_NAME" "$LAB2_LINK_IP" "$LAB2_USER_MAC"
vm2_running || "$LAB_SCRIPTS/start.sh" --nodes 2 --no-wait
copy_guest_scripts 2
lab2_ssh sudo /opt/orbit-lab/provision.sh base agent
lab2_ssh sudo /opt/orbit-lab/provision.sh link 2
# The join token goes from the server straight into the agent's 0600 file, compared by hash; it
# is never printed or written on the host.
token=/var/lib/rancher/k3s/server/agent-token
if [ "$(lab_ssh sudo sha256sum "$token" | cut -d' ' -f1)" != \
     "$(lab2_ssh 'sudo sha256sum /etc/rancher/k3s/agent-token 2>/dev/null' | cut -d' ' -f1 || true)" ]; then
  lab_ssh sudo cat "$token" \
    | lab2_ssh 'sudo install -d -m 0755 /etc/rancher/k3s && sudo sh -c "umask 077 && cat > /etc/rancher/k3s/agent-token"'
  [ "$(lab_ssh sudo sha256sum "$token" | cut -d' ' -f1)" = "$(lab2_ssh sudo sha256sum /etc/rancher/k3s/agent-token | cut -d' ' -f1)" ] \
    || die "the join token did not arrive intact"
  say "join token: copied from the server into $LAB2_NAME:/etc/rancher/k3s/agent-token (0600)"
fi
lab2_ssh sudo /opt/orbit-lab/provision.sh k3s-agent
lab_kubectl wait --for=condition=Ready "node/$LAB2_NAME" --timeout=600s
cordon_node2 uncordon
wait_node_plugin "$LAB2_NAME"
lab2_ssh sudo /opt/orbit-lab/provision.sh agent-facts > "$LAB_DIR/state/facts-node2.json"
say "facts: $LAB_DIR/state/facts-node2.json"
lab2_ssh sudo /opt/orbit-lab/provision.sh trim
lab_kubectl get nodes -o wide
"$LAB_SCRIPTS/status.sh" --wait 900
