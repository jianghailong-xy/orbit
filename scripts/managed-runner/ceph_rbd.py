#!/usr/bin/env python3
"""Offline preparation only: no Kubernetes/Ceph client or implicit deployment."""

import argparse
import copy
import json
from pathlib import Path
import re
import sys
import uuid


ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "deploy/managed-runner/storage"
GROUPS = ("authorization", "kubernetes", "ceph", "csi", "storage", "versions", "protection", "backup", "verification")


def field(env, path):
    value = env
    for part in path.split("."):
        value = value[part]
    return value


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_environment(path, live=False):
    env = json.loads(Path(path).read_text())
    require(env.get("schemaVersion") == 1, "schemaVersion must be 1")
    require(env.get("valueKind") in ("example", "actual"), "valueKind must be example or actual")
    for group in GROUPS:
        require(isinstance(env.get(group), dict), f"missing object: {group}")
    storage = env["storage"]
    for key, expected in {"accessMode": "ReadWriteOnce", "volumeMode": "Filesystem", "fsType": "ext4",
                          "mounter": "rbd", "reclaimPolicy": "Retain", "allowExpansion": False,
                          "bindingMode": "Immediate"}.items():
        require(storage.get(key) == expected, f"storage.{key} must equal {expected}")
    require(storage.get("imageFeatures") == ["layering"], "baseline imageFeatures must be [layering]; review another profile separately")
    require(env["authorization"].get("nonProduction") is True, "nonProduction authorization is required")
    require(isinstance(env["authorization"].get("allowedOperations"), list), "allowedOperations must be an explicit list")

    def no_credentials(value):
        if isinstance(value, dict):
            for key, child in value.items():
                require(key.lower() not in ("userkey", "adminkey", "secretdata", "stringdata", "kubeconfigdata", "token", "password"),
                        "environment must contain credential references only")
                no_credentials(child)
        elif isinstance(value, list):
            for child in value:
                no_credentials(child)
    no_credentials(env)

    # Actual manifests may only be rendered from a complete reviewed profile. Neither this
    # validation nor an operator reference establishes observed mounts or physical fencing.
    if live or env["valueKind"] == "actual":
        require(env["valueKind"] == "actual", "example values cannot be used for live operations")
        paths = [
            "authorization.reference", "kubernetes.kubeconfig", "kubernetes.context", "kubernetes.apiServer",
            "kubernetes.namespace", "kubernetes.namespaceUID", "kubernetes.nodeA.name", "kubernetes.nodeA.uid",
            "kubernetes.nodeB.name", "kubernetes.nodeB.uid", "ceph.fsid", "ceph.pool", "ceph.crushFailureDomain",
            "ceph.publicNetworkEvidenceRef", "ceph.osdNetworkEvidenceRef", "ceph.healthEvidenceRef",
            "ceph.cephXCapabilitiesEvidenceRef", "ceph.cephXKeyCompatibilityEvidenceRef",
            "csi.clusterID", "csi.driver", "csi.namespace", "csi.configMapName", "csi.configurationOwner",
            "storage.className", "storage.pvcName", "storage.ownerID", "storage.runnerID", "storage.capacity",
            "versions.kubernetes", "versions.ceph", "versions.cephCSI", "versions.nodeKernelA", "versions.nodeKernelB",
            "versions.compatibilityEvidenceRef", "protection.admissionEvidenceRef", "protection.fencingEvidenceRef",
            "protection.forcedDetachPolicyEvidenceRef", "verification.image", "verification.admissionDeniedMarker",
            "verification.serviceAccount", "verification.reservationAnnotation", "verification.podNamePrefix",
        ]
        for operation in ("provisioner", "controllerPublish", "controllerExpand", "nodeStage"):
            paths += [f"csi.secretRefs.{operation}.name", f"csi.secretRefs.{operation}.namespace"]
        for name in paths:
            value = field(env, name)
            require(isinstance(value, str) and value.strip() and
                    not any(marker in value.upper() for marker in ("REPLACE_ME", "PENDING", "EXAMPLE", "${")),
                    f"actual value/evidence required: {name}")
        require(env["ceph"]["topology"] in ("external", "rook"), "confirm external or rook test topology")
        require(env["csi"]["configurationOwner"] in ("raw", "operator", "rook"), "confirm existing CSI configuration owner")
        require(re.fullmatch(r"(?:[a-z0-9.-]+\.)?rbd\.csi\.ceph\.com", env["csi"]["driver"]), "only a confirmed Ceph RBD CSI driver is permitted")
        if env["ceph"]["topology"] == "rook" or env["csi"]["configurationOwner"] == "rook":
            require(env["versions"].get("rook") not in (None, "", "pending", "REPLACE_ME"), "actual Rook version required")
        require(Path(env["kubernetes"]["kubeconfig"]).is_absolute(), "kubeconfig must be an explicit absolute path")
        require(env["kubernetes"]["apiServer"].startswith("https://"), "explicit HTTPS API server required")
        require(env["kubernetes"]["context"] != "default", "unknown default context is not authorized")
        for name in ("kubernetes.context", "kubernetes.namespace", "kubernetes.nodeA.name", "kubernetes.nodeB.name",
                     "storage.className", "storage.pvcName", "csi.configMapName", "csi.namespace", "verification.serviceAccount"):
            require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]*", field(env, name)), f"invalid command identifier: {name}")
        require(env["kubernetes"]["namespace"] not in ("default", "kube-system", "kube-public", "kube-node-lease"), "dedicated test namespace required")
        require(env["kubernetes"]["nodeA"]["name"] != env["kubernetes"]["nodeB"]["name"] and
                env["kubernetes"]["nodeA"]["uid"] != env["kubernetes"]["nodeB"]["uid"], "two distinct authorized nodes required")
        for name in ("ceph.fsid", "storage.ownerID", "storage.runnerID"):
            require(str(uuid.UUID(field(env, name))) == field(env, name), f"canonical UUID required: {name}")
        require(storage["pvcName"] == "mr-data-" + storage["runnerID"], "PVC name must bind the stable runner UUID")
        require(re.fullmatch(r"[1-9][0-9]*(Mi|Gi|Ti)", storage["capacity"]), "explicit positive Mi/Gi/Ti capacity required")
        require(len(env["csi"]["clusterID"].encode()) <= 36, "CSI clusterID maximum is 36 bytes")
        require(isinstance(env["ceph"].get("monitors"), list) and bool(env["ceph"]["monitors"]), "MON endpoints required")
        require(all(isinstance(mon, str) and mon and "REPLACE_ME" not in mon for mon in env["ceph"]["monitors"]), "actual MON endpoints required")
        replicas, minimum = env["ceph"].get("replicaCount"), env["ceph"].get("minSize")
        require(type(replicas) is int and type(minimum) is int and 2 <= minimum <= replicas, "confirmed replicated pool size/min_size required; no single-copy fallback")
        require(env["protection"].get("admissionReady") is True and env["protection"].get("fencingReady") is True,
                "single Pod admission and fencing must be supplied and reviewed")
        require(isinstance(env["verification"].get("receiptAuthorityRefs"), list) and
                bool(env["verification"]["receiptAuthorityRefs"]) and
                all(isinstance(ref, str) and ref.strip() and "REPLACE_ME" not in ref for ref in env["verification"]["receiptAuthorityRefs"]),
                "trusted operator receipt authorities required")
        require(re.fullmatch(r".+@sha256:[0-9a-f]{64}", env["verification"]["image"]), "pin verification image digest")
        require(type(env["verification"].get("timeoutSeconds")) is int and 1 <= env["verification"]["timeoutSeconds"] <= 3600,
                "verification timeout must be 1..3600 seconds")
        require(bool(env["authorization"]["allowedOperations"]), "no live operation has been authorized")
    return env


def render(env):
    values = copy.deepcopy(env)
    values["cephCSIConfigJSON"] = json.dumps([{"clusterID": env["csi"]["clusterID"], "monitors": env["ceph"]["monitors"]}])

    def replace(value):
        if isinstance(value, str):
            match = re.fullmatch(r"\$\{([A-Za-z0-9_.]+)\}", value)
            if match:
                return field(values, match[1])
            return re.sub(r"\$\{([A-Za-z0-9_.]+)\}", lambda m: str(field(values, m[1])), value)
        if isinstance(value, dict):
            return {key: replace(child) for key, child in value.items()}
        if isinstance(value, list):
            return [replace(child) for child in value]
        return value

    result = {name.replace(".template", ""): replace(json.loads((TEMPLATES / name).read_text()))
              for name in ("csi-config.template.json", "storageclass.template.json", "pvc.template.json")}
    sc, pvc = result["storageclass.json"], result["pvc.json"]
    require(sc["kind"] == "StorageClass" and sc["reclaimPolicy"] == "Retain", "StorageClass must retain the RBD image")
    require(sc["parameters"]["csi.storage.k8s.io/fstype"] == "ext4", "RBD filesystem must be ext4")
    require(sc["parameters"]["tryOtherMounters"] == "false", "no silent mounter fallback")
    require(pvc["kind"] == "PersistentVolumeClaim" and not pvc["metadata"].get("ownerReferences"), "PVC must be independent of compute")
    require(pvc["spec"]["storageClassName"] == sc["metadata"]["name"], "PVC must explicitly reference StorageClass")
    require(pvc["spec"]["accessModes"] == ["ReadWriteOnce"] and pvc["spec"]["volumeMode"] == "Filesystem", "PVC must be RWO Filesystem")
    config = json.loads(result["csi-config.json"]["data"]["config.json"])
    require(config[0]["clusterID"] == sc["parameters"]["clusterID"], "CSI/StorageClass clusterID mismatch")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "render"))
    parser.add_argument("--environment", required=True)
    parser.add_argument("--output", help="new local directory for optional manifests; never applied")
    args = parser.parse_args()
    env = load_environment(args.environment)
    manifests = render(env)
    if args.command == "render":
        require(args.output is not None, "render requires --output")
        output = Path(args.output)
        output.mkdir(parents=True, exist_ok=False)
        for name, manifest in manifests.items():
            (output / name).write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"offlineOnly": True, "valueKind": env["valueKind"], "manifests": list(manifests),
                      "clusterAcceptance": "NOT_EXECUTED", "missingEnvironment": env["valueKind"] == "example"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(f"refused: {error}", file=sys.stderr)
        sys.exit(2)
