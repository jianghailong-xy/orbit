#!/usr/bin/env python3
"""Render the lab's Kubernetes objects. Prints them; never applies anything.

  render.py storage --fsid FSID           StorageClass from deploy/managed-runner/storage, via ceph_rbd.render
  render.py pvc --fsid FSID --name N --owner UUID --runner UUID [--capacity 1Gi] [--access-mode M]
                                          PVC from the same template (access mode overridable for probes)
  render.py operator INSTALL_YAML         Ceph-CSI Operator all-in-one manifest, operator image pinned by digest
  render.py csi --fsid FSID               image set, CephConnection, ClientProfile (named FSID) and Driver
  render.py namespace                     the namespace for later tests
  render.py probe-pod --name N --pvc P --run-id R [--sleep] [--node NODE]
                                          a Pod running the repository's ceph-rbd-payload.py on that PVC,
                                          scheduled onto NODE when given (two-node mode)
"""

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ceph_rbd", LAB.parent / "ceph_rbd.py")
ceph_rbd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ceph_rbd)


def lab_env():
    values = {}
    for line in (LAB / "lab.env").read_text().splitlines():
        match = re.match(r"([A-Z0-9_]+)=(\S*)", line)
        if match:
            values[match[1]] = match[2]
    return values


ENV = lab_env()


def storage_environment(fsid, pvc_name="unused", owner="unused", runner="unused", capacity="1Gi"):
    """The lab's values in the shape of deploy/managed-runner/storage/environment.example.json."""
    secret = {"name": ENV["LAB_CSI_SECRET"], "namespace": ENV["LAB_CSI_NAMESPACE"]}
    return {
        "kubernetes": {"namespace": ENV["LAB_NAMESPACE"]},
        "ceph": {"fsid": fsid, "monitors": [ENV["LAB_LINK_IP"] + ":6789"], "pool": ENV["LAB_POOL"]},
        "csi": {
            "clusterID": fsid,  # the Ceph FSID, which is also the ClientProfile's name
            "driver": ENV["LAB_CSI_DRIVER"],
            "namespace": ENV["LAB_CSI_NAMESPACE"],
            "configMapName": "ceph-csi-config",  # rendered by the template, not applied: the operator owns it
            "secretRefs": {name: secret for name in ("provisioner", "controllerPublish", "controllerExpand", "nodeStage")},
        },
        "storage": {"className": ENV["LAB_STORAGE_CLASS"], "pvcName": pvc_name, "ownerID": owner,
                    "runnerID": runner, "capacity": capacity},
    }


def operator(install_yaml):
    text = Path(install_yaml).read_text()
    tag = ENV["CSI_OPERATOR_IMAGE"].split("@")[0]
    if text.count(f"image: {tag}\n") != 1:
        raise SystemExit(f"expected exactly one 'image: {tag}' in {install_yaml}")
    return text.replace(f"image: {tag}\n", f"image: {ENV['CSI_OPERATOR_IMAGE']}\n")


def csi(fsid):
    namespace = ENV["LAB_CSI_NAMESPACE"]
    meta = lambda name: {"name": name, "namespace": namespace}  # noqa: E731
    pull = {"imagePullPolicy": "IfNotPresent"}
    return [
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta(ENV["LAB_CSI_IMAGESET"]),
         "data": {"plugin": ENV["CEPHCSI_IMAGE"], "provisioner": ENV["CSI_PROVISIONER_IMAGE"],
                  "attacher": ENV["CSI_ATTACHER_IMAGE"], "resizer": ENV["CSI_RESIZER_IMAGE"],
                  "registrar": ENV["CSI_REGISTRAR_IMAGE"]}},
        {"apiVersion": "csi.ceph.io/v1", "kind": "CephConnection", "metadata": meta(ENV["LAB_CEPH_CONNECTION"]),
         "spec": {"monitors": [ENV["LAB_LINK_IP"] + ":6789"]}},
        {"apiVersion": "csi.ceph.io/v1", "kind": "ClientProfile", "metadata": meta(fsid),
         "spec": {"cephConnectionRef": {"name": ENV["LAB_CEPH_CONNECTION"]}, "rbd": {}}},
        {"apiVersion": "csi.ceph.io/v1", "kind": "Driver", "metadata": meta(ENV["LAB_CSI_DRIVER"]),
         "spec": {"imageSet": {"name": ENV["LAB_CSI_IMAGESET"]}, "snapshotPolicy": "none",
                  "deployCsiAddons": False, "attachRequired": True, "fsGroupPolicy": "File",
                  # The provisioner and attacher stay on the first VM, the node that is never failed on
                  # purpose: with them on the second, its hard stop would also stop every attach and detach.
                  "controllerPlugin": {"replicas": 1, "affinity": node_affinity(ENV["LAB_NAME"]), **pull},
                  "nodePlugin": pull}},
    ]


def node_affinity(node):
    """Required scheduling onto one node, by its hostname label."""
    term = {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": [node]}]}
    return {"nodeAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": {"nodeSelectorTerms": [term]}}}


def probe_pod(name, pvc, run_id, sleep, node=None):
    payload = ["python3", "/probe/ceph-rbd-payload.py", "writer", "--run-id", run_id]
    idle = ["python3", "-c", "import signal, sys, time\n"
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\ntime.sleep(10 ** 9)"]
    field = lambda path: {"valueFrom": {"fieldRef": {"fieldPath": path}}}  # noqa: E731
    pod = {
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {"name": name, "namespace": ENV["LAB_NAMESPACE"]},
        "spec": {
            "restartPolicy": "Always",
            "terminationGracePeriodSeconds": 30,
            "securityContext": {"runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "runAsNonRoot": True,
                                "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{
                "name": "probe", "image": ENV["PROBE_IMAGE"], "imagePullPolicy": "IfNotPresent",
                "command": idle if sleep else payload,
                "env": [{"name": "POD_NAME", **field("metadata.name")}, {"name": "POD_UID", **field("metadata.uid")},
                        {"name": "HOME", "value": "/tmp"}],
                "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                    "capabilities": {"drop": ["ALL"]}},
                "resources": {"requests": {"cpu": "50m", "memory": "64Mi"}, "limits": {"memory": "256Mi"}},
                "volumeMounts": [{"name": "data", "mountPath": "/var/lib/orbit"},
                                 {"name": "probe", "mountPath": "/probe", "readOnly": True},
                                 {"name": "tmp", "mountPath": "/tmp"}],
            }],
            "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": pvc}},
                        {"name": "probe", "configMap": {"name": "ceph-rbd-payload", "defaultMode": 0o555}},
                        {"name": "tmp", "emptyDir": {"sizeLimit": "64Mi"}}],
        },
    }
    if node:
        pod["spec"]["affinity"] = node_affinity(node)
    return pod


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("what", choices=("storage", "pvc", "operator", "csi", "namespace", "probe-pod"))
    parser.add_argument("install_yaml", nargs="?")
    parser.add_argument("--fsid")
    parser.add_argument("--name")
    parser.add_argument("--owner")
    parser.add_argument("--runner")
    parser.add_argument("--capacity", default="1Gi")
    parser.add_argument("--access-mode", default="ReadWriteOnce")
    parser.add_argument("--pvc")
    parser.add_argument("--run-id")
    parser.add_argument("--sleep", action="store_true")
    parser.add_argument("--node")
    args = parser.parse_args()
    if args.what == "operator":
        sys.stdout.write(operator(args.install_yaml))
        return
    if args.what in ("storage", "pvc"):
        manifests = ceph_rbd.render(storage_environment(args.fsid, args.name, args.owner, args.runner, args.capacity))
        result = manifests["storageclass.json"]
        if args.what == "pvc":
            result = manifests["pvc.json"]
            result["spec"]["accessModes"] = [args.access_mode]
    elif args.what == "csi":
        result = {"apiVersion": "v1", "kind": "List", "items": csi(args.fsid)}
    elif args.what == "namespace":
        result = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ENV["LAB_NAMESPACE"]}}
    else:
        result = probe_pod(args.name, args.pvc, args.run_id, args.sleep, args.node)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
