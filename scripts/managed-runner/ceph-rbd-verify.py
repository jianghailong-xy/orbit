#!/usr/bin/env python3
"""Staged live probe for an explicitly authorized, preconfigured Ceph test PVC.

This does not install CSI, apply storage templates, power off a node, force-delete
a Pod, break a lock, or remove attachments. See README.md for operator handoffs.
"""

import argparse
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid
from urllib.parse import quote

from ceph_rbd import load_environment, render, require


PAYLOAD = Path(__file__).with_name("ceph-rbd-payload.py")
PHASES = ("baseline", "duplicates", "migration-stop", "migration-resume", "fault-snapshot", "fault-resume")
OPERATIONS = {
    "baseline": {"create-test-pods", "exec-test-pods"},
    "duplicates": {"create-test-pods", "delete-test-pods"},
    "migration-stop": {"delete-test-pods", "exec-test-pods"},
    "migration-resume": {"create-test-pods", "exec-test-pods"},
    "fault-snapshot": {"exec-test-pods"},
    "fault-resume": {"create-test-pods", "exec-test-pods", "fault-resume"},
}
PREVIOUS_PHASE = {"duplicates": "baseline", "migration-stop": "duplicates", "migration-resume": "migration-stop",
                  "fault-snapshot": "migration-resume", "fault-resume": "fault-snapshot"}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def parse_time(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None, "receipt times must include timezone")
    return parsed


def actual_reference(value):
    return isinstance(value, str) and bool(value.strip()) and not any(marker in value.upper() for marker in ("REPLACE_ME", "PENDING", "${", "<"))


def admission_denied(returncode, stdout, stderr, marker):
    """Only the configured admission guard's explicit denial is a successful probe."""
    message = stdout + "\n" + stderr
    if returncode == 0 or not marker or marker not in message or "cannot create resource" in message:
        return False
    return bool(re.search(r'admission webhook [^\n]+ denied the request|ValidatingAdmissionPolicy [^\n]+ denied request', message, re.I))


def validate_receipt(receipt, env, scope, predecessor=None, target=None, kind=None, not_before=None):
    require(receipt.get("schemaVersion") == 1 and receipt.get("kind") == kind, "wrong receipt kind/schema")
    require(actual_reference(receipt.get("authorityRef")) and receipt.get("authorityRef") in env["verification"]["receiptAuthorityRefs"], "untrusted receipt authority reference")
    require(receipt.get("scope") == scope, "receipt must match every observed cluster/volume identity")
    observed = parse_time(receipt["observedAt"])
    require(observed <= datetime.now(timezone.utc), "receipt observation is in the future")
    if not_before is not None:
        require(observed >= parse_time(not_before), "receipt predates this stop/fault handoff")
    if predecessor is not None:
        require(receipt.get("predecessor") == predecessor, "receipt predecessor Pod UID/node UID/generation mismatch")
    if target is not None:
        reservation = receipt["reservation"]
        require(reservation["podName"] == scope["podName"] and reservation["nodeName"] == target["name"] and
                reservation["nodeUID"] == target["uid"], "reservation does not identify the authorized successor")
        require(type(reservation["generation"]) is int and reservation["generation"] > (predecessor["generation"] if predecessor else 0),
                "successor needs a new reserved generation")
        for key in ("reservationRef", "admissionPolicyRef", "requestUser"):
            require(actual_reference(reservation.get(key)), "reservation needs " + key)
    if kind in ("reservation", "normal-detach", "power-off-fence"):
        detach = receipt["detach"]
        for key in ("allContainersStopped", "csiUnpublished", "csiUnstaged", "deviceUnmapped", "noMountsOrClients"):
            require(detach.get(key) is True, "operator detach observation missing: " + key)
        require(isinstance(detach.get("observationRefs"), list) and bool(detach["observationRefs"]) and
                all(actual_reference(ref) for ref in detach["observationRefs"]), "independent node unmap/mount observations are required")
    if kind == "power-off-fence":
        fence = receipt["powerOffFence"]
        require(fence.get("poweredOff") is True and fence.get("quarantined") is True, "verified power-off and persistent quarantine are required")
        for key in ("controlActionRef", "independentPowerOffObservationRef", "quarantineRef", "outOfServiceRunbookRef"):
            require(actual_reference(fence.get(key)), "fence needs " + key)
        require(fence["controlActionRef"] != fence["independentPowerOffObservationRef"], "power-off control and independent observation need separate references")
        require(parse_time(fence["validUntil"]) > datetime.now(timezone.utc) + timedelta(seconds=2 * env["verification"]["timeoutSeconds"]),
                "fence/quarantine assurance must cover the phase operation timeout")
    # These checks bind operator statements, not their physical truth. Independent
    # receipt review remains an explicit gap even after this function succeeds.


class Kube:
    def __init__(self, env, output):
        self.env = env
        self.output = output
        self.events = []
        self.scope = None
        self.request_user = None
        self.expected_pod_manifest = None
        self.fence_expiry = None
        self.base = ["kubectl", "--kubeconfig", env["kubernetes"]["kubeconfig"], "--context", env["kubernetes"]["context"],
                     "--namespace", env["kubernetes"]["namespace"], "--request-timeout=20s"]

    def call(self, args, manifest=None, write=False, allow_failure=False, save_output=True):
        if write:
            self.check_identity()
            if self.fence_expiry is not None:
                require(self.fence_expiry > datetime.now(timezone.utc) + timedelta(seconds=2 * self.env["verification"]["timeoutSeconds"]),
                        "fence/quarantine assurance no longer covers this operation; stop for operator review")
        started = time.monotonic()
        event = {"sequence": len(self.events) + 1, "at": utc_now(), "argv": self.base + args}
        if manifest is not None:
            event["requestBody"] = manifest
        try:
            result = subprocess.run(self.base + args, input=json.dumps(manifest) if manifest is not None else None,
                                    text=True, capture_output=True, timeout=self.env["verification"]["timeoutSeconds"])
        except subprocess.SubprocessError as error:
            event.update(returncode=None, error=str(error), seconds=time.monotonic() - started)
            self.record(event)
            raise
        event.update(returncode=result.returncode, seconds=time.monotonic() - started)
        if save_output:
            event.update(stdout=result.stdout, stderr=result.stderr)
        self.record(event)
        if not allow_failure:
            require(result.returncode == 0, "kubectl failed; inspect commands.jsonl event " + str(event["sequence"]))
        return result

    def record(self, event):
        self.events.append(event)
        with (self.output / "commands.jsonl").open("a") as stream:
            stream.write(json.dumps(event) + "\n")

    def get(self, kind, name):
        return json.loads(self.call(["get", kind, name, "-o", "json"]).stdout)

    def check_identity(self):
        expected = self.env["kubernetes"]
        # Do not preserve kubeconfig users/exec-plugin environment or credentials.
        config = json.loads(self.call(["config", "view", "--minify", "-o", "json"], save_output=False).stdout)
        require(config["contexts"][0]["name"] == expected["context"], "context changed")
        require(config["clusters"][0]["cluster"]["server"] == expected["apiServer"], "API server changed")
        require(self.get("namespace", expected["namespace"])["metadata"]["uid"] == expected["namespaceUID"], "namespace UID changed")
        for name in ("nodeA", "nodeB"):
            node = self.get("node", expected[name]["name"])
            require(node["metadata"]["uid"] == expected[name]["uid"], "authorized node UID changed")
        if self.scope is not None:
            pvc = self.get("pvc", self.scope["pvcName"])
            pv = self.get("pv", self.scope["pvName"])
            require(pvc["metadata"]["uid"] == self.scope["pvcUID"] and pv["metadata"]["uid"] == self.scope["pvUID"] and
                    pvc["spec"]["volumeName"] == self.scope["pvName"] and pv["spec"]["csi"]["volumeHandle"] == self.scope["volumeHandle"],
                    "volume identity changed before write")
        if self.request_user is not None:
            whoami = json.loads(self.call(["auth", "whoami", "-o", "json"]).stdout)
            require(whoami["status"]["userInfo"]["username"] == self.request_user, "API request identity changed before write")

    def attachments(self):
        # Kubernetes does not expose a PV field selector here. Retain only entries
        # for this observed PV; no attachment is ever modified by this script.
        entries = json.loads(self.call(["get", "volumeattachments", "-o", "json"], save_output=False).stdout)["items"]
        selected = [item for item in entries if item.get("spec", {}).get("source", {}).get("persistentVolumeName") == self.scope["pvName"]]
        (self.output / "volumeattachments.json").write_text(json.dumps(selected, indent=2) + "\n")
        return selected

    def pod(self, name):
        result = self.call(["get", "pod", name, "--ignore-not-found", "-o", "json"])
        return json.loads(result.stdout) if result.stdout.strip() else None

    def delete_pod(self, name, uid):
        uri = "/api/v1/namespaces/" + quote(self.env["kubernetes"]["namespace"], safe="") + "/pods/" + quote(name, safe="")
        options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": uid}, "propagationPolicy": "Background"}
        return self.call(["delete", "--raw", uri, "-f", "-"], manifest=options, write=True)

    def wait(self, predicate, description):
        deadline = time.monotonic() + self.env["verification"]["timeoutSeconds"]
        while True:
            result = predicate()
            if result:
                return result
            require(time.monotonic() < deadline, "timed out: " + description)
            time.sleep(1)

    def detached(self):
        return not any(item.get("status", {}).get("attached") or item.get("status", {}).get("attachError") for item in self.attachments())


def discover(kube, env, receipt):
    kube.check_identity()
    version = json.loads(kube.call(["version", "-o", "json"]).stdout)
    require(version["serverVersion"]["gitVersion"].lstrip("v") == env["versions"]["kubernetes"].lstrip("v"), "actual API server version differs from reviewed profile")
    nodes = [kube.get("node", env["kubernetes"][name]["name"]) for name in ("nodeA", "nodeB")]
    for node, key in zip(nodes, ("nodeKernelA", "nodeKernelB")):
        require(node["status"]["nodeInfo"]["kernelVersion"] == env["versions"][key], "node kernel differs from reviewed profile")
    manifests = render(env)
    config = json.loads(kube.call(["get", "configmap", env["csi"]["configMapName"], "--namespace", env["csi"]["namespace"], "-o", "json"]).stdout)
    cluster_entries = [entry for entry in json.loads(config["data"]["config.json"]) if entry.get("clusterID") == env["csi"]["clusterID"]]
    require(len(cluster_entries) == 1 and set(cluster_entries[0]["monitors"]) == set(env["ceph"]["monitors"]), "observed CSI clusterID/MON configuration mismatch")
    expected_sc, expected_pvc = manifests["storageclass.json"], manifests["pvc.json"]
    sc = kube.get("storageclass", env["storage"]["className"])
    for key in ("provisioner", "parameters", "reclaimPolicy", "volumeBindingMode", "allowVolumeExpansion"):
        require(sc.get(key) == expected_sc[key], "StorageClass differs from approved profile: " + key)
    for key in ("storageclass.kubernetes.io/is-default-class", "storageclass.beta.kubernetes.io/is-default-class"):
        require(sc["metadata"].get("annotations", {}).get(key) != "true", "test class must not be the cluster default")
    pvc = kube.get("pvc", env["storage"]["pvcName"])
    require(pvc["status"]["phase"] == "Bound" and not pvc["metadata"].get("ownerReferences"), "precreated PVC must be bound and independent of compute")
    for key in ("storageClassName", "accessModes", "volumeMode", "resources"):
        require(pvc["spec"].get(key) == expected_pvc["spec"][key], "PVC differs from approved profile: " + key)
    for key in ("orbit.dev/owner-id", "orbit.dev/runner-id"):
        require(pvc["metadata"].get("annotations", {}).get(key) == expected_pvc["metadata"]["annotations"][key], "PVC ownership mismatch")
    pv = kube.get("pv", pvc["spec"]["volumeName"])
    claim = pv["spec"]["claimRef"]
    require((claim["namespace"], claim["name"], claim["uid"]) ==
            (env["kubernetes"]["namespace"], pvc["metadata"]["name"], pvc["metadata"]["uid"]), "PV claim identity mismatch")
    for key, expected in (("storageClassName", env["storage"]["className"]), ("accessModes", ["ReadWriteOnce"]),
                          ("volumeMode", "Filesystem"), ("persistentVolumeReclaimPolicy", "Retain")):
        require(pv["spec"].get(key) == expected, "PV profile mismatch: " + key)
    csi = pv["spec"]["csi"]
    require(csi["driver"] == env["csi"]["driver"] and csi.get("fsType") == "ext4", "PV CSI driver/filesystem mismatch")
    for key, operation in (("controllerPublishSecretRef", "controllerPublish"), ("controllerExpandSecretRef", "controllerExpand"), ("nodeStageSecretRef", "nodeStage")):
        require(csi.get(key) == env["csi"]["secretRefs"][operation], "PV CSI Secret reference mismatch: " + key)
    attributes = csi["volumeAttributes"]
    require(attributes.get("clusterID") == env["csi"]["clusterID"] and attributes.get("pool") == env["ceph"]["pool"], "PV Ceph cluster/pool mismatch")
    require(attributes.get("mounter") == "rbd" and attributes.get("imageFeatures") == "layering", "PV must retain kernel RBD/layering profile")
    image = attributes.get("imageName") or receipt["scope"]["rbdImage"]
    require(actual_reference(image) and actual_reference(receipt.get("rbdImageMappingRef")), "operator CSI-handle/RBD-image mapping observation is required; never decode/guess the handle")
    scope = {"context": env["kubernetes"]["context"], "apiServer": env["kubernetes"]["apiServer"],
             "namespace": env["kubernetes"]["namespace"], "namespaceUID": env["kubernetes"]["namespaceUID"],
             "pvcName": pvc["metadata"]["name"], "pvcUID": pvc["metadata"]["uid"], "pvName": pv["metadata"]["name"],
             "pvUID": pv["metadata"]["uid"], "volumeHandle": csi["volumeHandle"], "cephFSID": env["ceph"]["fsid"],
             "pool": env["ceph"]["pool"], "rbdImage": image,
             "podName": env["verification"]["podNamePrefix"] + "-" + env["storage"]["runnerID"]}
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,55}[a-z0-9]", scope["podName"]), "test Pod name leaves no room for duplicate probe suffixes")
    kube.scope = scope
    (kube.output / "resources.json").write_text(json.dumps({"version": version, "nodes": nodes, "csiConfig": config, "storageClass": sc, "pvc": pvc, "pv": pv}, indent=2) + "\n")
    return scope


def payload_command(operation, run_id, minimum_rows=0, recover=False):
    encoded = base64.b64encode(PAYLOAD.read_bytes()).decode()
    command = ["python3", "-u", "-c", "import base64; exec(compile(base64.b64decode('" + encoded + "'), 'payload.py', 'exec'))",
               operation, "--run-id", run_id, "--minimum-rows", str(minimum_rows)]
    if recover:
        command.append("--recover")
    return command


def pod_manifest(env, reservation, run_id, existing=False):
    command = payload_command("writer", run_id)
    command += ["--expected-pod-name", env["verification"]["podNamePrefix"] + "-" + env["storage"]["runnerID"]]
    if existing:
        command += ["--require-existing", "--initially-quiesced"]
    ready_code = "import json,pathlib,sys; p=pathlib.Path('/var/lib/orbit/storage-verification/" + run_id + "/acknowledged.json'); sys.exit(0 if p.exists() and json.loads(p.read_text())['committedRows']>=10 else 1)"
    return {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": reservation["podName"], "namespace": env["kubernetes"]["namespace"],
            "annotations": {"orbit.dev/owner-id": env["storage"]["ownerID"], "orbit.dev/runner-id": env["storage"]["runnerID"],
                            env["verification"]["reservationAnnotation"]: str(reservation["generation"])}},
            "spec": {"nodeName": reservation["nodeName"], "restartPolicy": "Never", "terminationGracePeriodSeconds": 240,
            "serviceAccountName": env["verification"]["serviceAccount"], "automountServiceAccountToken": False,
            "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000,
                                "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": "probe", "image": env["verification"]["image"], "command": command,
                            "env": [{"name": "HOME", "value": "/tmp"},
                                    {"name": "POD_NAME", "valueFrom": {"fieldRef": {"apiVersion": "v1", "fieldPath": "metadata.name"}}},
                                    {"name": "POD_UID", "valueFrom": {"fieldRef": {"apiVersion": "v1", "fieldPath": "metadata.uid"}}}],
                            "readinessProbe": {"exec": {"command": ["python3", "-c", ready_code]}, "periodSeconds": 1},
                            "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                            "resources": {"requests": {"cpu": "100m", "memory": "128Mi", "ephemeral-storage": "100Mi"},
                                          "limits": {"cpu": "500m", "memory": "256Mi", "ephemeral-storage": "200Mi"}},
                            "volumeMounts": [{"name": "data", "mountPath": "/var/lib/orbit"}, {"name": "tmp", "mountPath": "/tmp"}]}],
            "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": env["storage"]["pvcName"]}}, {"name": "tmp", "emptyDir": {}}]}}


def assert_pod(kube, identity):
    pod = kube.pod(identity["podName"])
    require(pod is not None and pod["metadata"]["uid"] == identity["podUID"] and pod["spec"]["nodeName"] == identity["nodeName"],
            "current Pod differs from recorded predecessor")
    require(pod["metadata"]["annotations"].get(kube.env["verification"]["reservationAnnotation"]) == str(identity["generation"]), "Pod generation annotation changed")
    require(pod["spec"]["serviceAccountName"] == kube.env["verification"]["serviceAccount"] and
            any(volume.get("persistentVolumeClaim", {}).get("claimName") == kube.env["storage"]["pvcName"] for volume in pod["spec"]["volumes"]),
            "Pod service account/PVC differs from scope")
    expected = kube.expected_pod_manifest["spec"]
    for key in ("nodeName", "restartPolicy", "terminationGracePeriodSeconds", "serviceAccountName", "automountServiceAccountToken", "securityContext", "volumes"):
        require(pod["spec"].get(key) == expected[key], "persisted Pod differs from approved template: " + key)
    require(not any(pod["spec"].get(key) for key in ("hostNetwork", "hostPID", "hostIPC", "initContainers", "ephemeralContainers")), "unexpected host access or additional containers")
    containers = pod["spec"]["containers"]
    require(len(containers) == 1, "unexpected sidecar")
    for key in ("name", "image", "command", "env", "securityContext", "resources", "volumeMounts"):
        require(containers[0].get(key) == expected["containers"][0][key], "persisted container differs from approved template: " + key)
    require(not containers[0].get("volumeDevices") and not containers[0]["securityContext"].get("privileged"), "unexpected device or privilege")
    return pod


def create_pod(kube, receipt, run_id, existing=False):
    reservation = receipt["reservation"]
    whoami = json.loads(kube.call(["auth", "whoami", "-o", "json"]).stdout)
    require(whoami["status"]["userInfo"]["username"] == reservation["requestUser"], "API request identity differs from reserved manager")
    kube.request_user = reservation["requestUser"]
    require(kube.pod(reservation["podName"]) is None, "fixed-name Pod already exists; do not adopt or replace it")
    kube.expected_pod_manifest = pod_manifest(kube.env, reservation, run_id, existing)
    (kube.output / "pod-manifest.json").write_text(json.dumps(kube.expected_pod_manifest, indent=2) + "\n")
    pod = json.loads(kube.call(["create", "-f", "-", "-o", "json"], manifest=kube.expected_pod_manifest, write=True).stdout)
    identity = {"podName": reservation["podName"], "podUID": pod["metadata"]["uid"], "nodeName": reservation["nodeName"],
                "nodeUID": reservation["nodeUID"], "generation": reservation["generation"]}
    (kube.output / "created-pod.json").write_text(json.dumps(identity, indent=2) + "\n")

    def ready():
        current = assert_pod(kube, identity)
        require(current["status"].get("phase") not in ("Failed", "Succeeded"), "probe container exited")
        return current if any(item["type"] == "Ready" and item["status"] == "True" for item in current["status"].get("conditions", [])) else None

    kube.wait(ready, "test Pod readiness")
    return identity


def probe(kube, identity, run_id, operation="snapshot", previous=None, recover=False):
    assert_pod(kube, identity)
    minimum = previous["committedRows"] if previous else 0
    command = payload_command(operation, run_id, minimum, recover) + ["--expected-pod-uid", identity["podUID"]]
    result = json.loads(kube.call(["exec", identity["podName"], "-c", "probe", "--", *command], write=True).stdout)
    if operation == "resume-writer":
        return result
    require(result["sqliteIntegrity"] == ["ok"] and result["sqliteJournalMode"].lower() == "wal" and not result["gitStatus"], "probe integrity/WAL/Git status failed")
    require(any(re.search(r" - ext4 /dev/rbd[0-9]+ ", line) for line in result["mountInfo"]), "actual /var/lib/orbit mount must be ext4 on a kernel /dev/rbd device")
    expected_kernel = kube.env["versions"]["nodeKernelA" if identity["nodeName"] == kube.env["kubernetes"]["nodeA"]["name"] else "nodeKernelB"]
    require(result["kernel"] == expected_kernel, "mounted probe kernel differs from reviewed node")
    if previous:
        require(result["ordinarySHA256"] == previous["ordinarySHA256"] and result["gitCommit"] == previous["gitCommit"] and
                result["prefixSHA256"] == previous["rowSHA256"] and result["committedRows"] >= previous["committedRows"],
                "original file/Git/acknowledged SQLite rows did not survive")
    return result


def execute_phase(args, env, kube, report, receipt):
    scope = report["scope"]
    run_id = report["runID"]
    checks = report["checks"]
    if args.phase == "baseline":
        validate_receipt(receipt, env, scope, target=env["kubernetes"]["nodeA"], kind="reservation")
        require(kube.detached(), "PVC already has an attached or failed attachment")
        identity = create_pod(kube, receipt, run_id)
        report["pod"] = identity
        report["podTemplate"] = kube.expected_pod_manifest
        report["snapshot"] = kube.wait(lambda: initial_snapshot(kube, identity, run_id), "at least ten committed SQLite rows")
        checks["baseline"] = "observed"
    elif args.phase == "duplicates":
        identity = report["pod"]
        assert_pod(kube, identity)
        for suffix, target in (("same", env["kubernetes"]["nodeA"]), ("cross", env["kubernetes"]["nodeB"])):
            reservation = dict(identity, podName=scope["podName"] + "-" + suffix, nodeName=target["name"], nodeUID=target["uid"])
            require(kube.pod(reservation["podName"]) is None, "duplicate-probe name already exists")
            manifest = pod_manifest(env, reservation, run_id)
            manifest["metadata"].pop("labels", None)
            # The identical command checks the downward-API Pod name and remains
            # inert in contenders if admission is broken; only name/node differ.
            response = kube.call(["create", "-f", "-", "-o", "json"], manifest=manifest, write=True, allow_failure=True)
            if response.returncode == 0:
                admitted = json.loads(response.stdout)
                current = kube.pod(reservation["podName"])
                require(current is not None and current["metadata"]["uid"] == admitted["metadata"]["uid"], "admitted duplicate changed identity")
                kube.delete_pod(reservation["podName"], admitted["metadata"]["uid"])
                raise ValueError("duplicate Pod was admitted; ordinary deletion requested, stop for operator review")
            require(admission_denied(response.returncode, response.stdout, response.stderr, env["verification"]["admissionDeniedMarker"]),
                    "duplicate rejected without configured admission denial; RBAC/Pending/storage errors are not acceptance")
            require(kube.pod(reservation["podName"]) is None, "denied contender must not exist")
            checks["duplicate-" + suffix] = "explicit-admission-denial-observed"
    elif args.phase == "migration-stop":
        identity = report["pod"]
        report["snapshot"] = probe(kube, identity, run_id, "quiesce", report["snapshot"])
        report["stopRequestedAt"] = utc_now()
        assert_pod(kube, identity)
        kube.delete_pod(identity["podName"], identity["podUID"])
        kube.wait(lambda: kube.pod(identity["podName"]) is None, "normal Pod termination")
        kube.wait(kube.detached, "CSI VolumeAttachment detached observation")
        checks["normal-api-stop-and-detach"] = "observed-awaiting-independent-node-unmap-receipt"
    elif args.phase in ("migration-resume", "fault-resume"):
        predecessor = report["pod"]
        target = env["kubernetes"]["nodeB" if args.phase == "migration-resume" else "nodeA"]
        validate_receipt(receipt, env, scope, predecessor, target, "normal-detach" if args.phase == "migration-resume" else "power-off-fence",
                         report["stopRequestedAt"] if args.phase == "migration-resume" else report["faultSnapshotAt"])
        if args.phase == "fault-resume":
            kube.fence_expiry = parse_time(receipt["powerOffFence"]["validUntil"])
        require(kube.pod(predecessor["podName"]) is None and kube.detached(), "operator must settle old Pod/attachments after cessation proof before resume")
        identity = create_pod(kube, receipt, run_id, existing=True)
        report["predecessor"] = predecessor
        report["pod"] = identity
        report["podTemplate"] = kube.expected_pod_manifest
        report["snapshot"] = probe(kube, identity, run_id, previous=report["snapshot"], recover=True)
        checks[args.phase] = "mounted-original-volume-and-preserved-probe-observed"
        if args.phase == "migration-resume":
            report["migrationSeconds"] = (datetime.now(timezone.utc) - parse_time(report["stopRequestedAt"])).total_seconds()
        else:
            report["faultWindowSeconds"] = (datetime.now(timezone.utc) - parse_time(report["faultSnapshotAt"])).total_seconds()
    elif args.phase == "fault-snapshot":
        identity = report["pod"]
        probe(kube, identity, run_id, "resume-writer")
        previous = report["snapshot"]
        report["snapshot"] = kube.wait(lambda: fault_snapshot(kube, identity, run_id, previous), "live committed WAL writes before operator fencing")
        report["faultSnapshotAt"] = utc_now()
        checks["pre-fault-live-wal"] = "observed-writer-left-running-awaiting-operator-power-off"
    kube.attachments()


def initial_snapshot(kube, identity, run_id):
    result = probe(kube, identity, run_id)
    return result if result["committedRows"] >= 10 else None


def fault_snapshot(kube, identity, run_id, previous):
    result = probe(kube, identity, run_id, previous=previous)
    return result if result["committedRows"] > previous["committedRows"] and result["walBytes"] > 0 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", required=True, choices=PHASES)
    for name in ("environment", "context", "namespace", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--execute", action="store_true", help="explicit authorization to run this phase in the named test scope")
    parser.add_argument("--state", help="successful immediately preceding phase's report.json")
    parser.add_argument("--receipt", help="operator-reviewed reservation/detach/power-off receipt JSON")
    args = parser.parse_args()
    require(args.execute, "live verification requires explicit --execute; use ceph_rbd.py for offline preparation")
    env = load_environment(args.environment, live=True)
    require(args.context == env["kubernetes"]["context"] and args.namespace == env["kubernetes"]["namespace"], "explicit context/namespace must match authorized environment")
    require(OPERATIONS[args.phase] <= set(env["authorization"]["allowedOperations"]), "phase operations are not authorized")
    require(Path(env["kubernetes"]["kubeconfig"]).is_file(), "explicit kubeconfig file is missing")
    state = json.loads(Path(args.state).read_text()) if args.state else None
    if args.phase != "baseline":
        require(state is not None and state.get("phase") == PREVIOUS_PHASE[args.phase] and state.get("phaseSucceeded") is True,
                "a successful immediately preceding phase report is required")
        require(state.get("environmentSHA256") == fingerprint(env), "environment changed since preceding phase")
    receipt = json.loads(Path(args.receipt).read_text()) if args.receipt else None
    if args.phase in ("baseline", "migration-resume", "fault-resume"):
        require(receipt is not None, "this phase requires an operator receipt")
    mapping_receipt = receipt if receipt else state["mappingReceipt"]
    output = Path(args.output)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(output, 0o700)
    kube = Kube(env, output)
    kube.request_user = receipt["reservation"]["requestUser"] if receipt and "reservation" in receipt else state.get("requestUser") if state else None
    kube.expected_pod_manifest = state.get("podTemplate") if state else None
    report = copy.deepcopy(state) if state else {"runID": "rbd-" + uuid.uuid4().hex, "checks": {}, "startedAt": utc_now()}
    prior_gaps = report.get("gaps", [])
    report.update(phase=args.phase, phaseSucceeded=False, environmentSHA256=fingerprint(env), clusterAcceptance="INCOMPLETE",
                  gaps=list(dict.fromkeys(prior_gaps + ["Remaining phases and real fault acceptance must be reviewed; no overall completion is asserted.",
                        "Operator receipt references require independent physical fencing, Ceph mapping/health and node-unmap review.",
                        "Independent backup/restore and old-node safe rejoin are not executed by this probe."])))
    try:
        scope = discover(kube, env, mapping_receipt)
        if state:
            require(scope == state["scope"], "cluster/PVC/PV/image identity changed between phases")
        report["scope"] = scope
        report["requestUser"] = kube.request_user
        report["mappingReceipt"] = mapping_receipt
        if receipt:
            report.setdefault("operatorReceipts", []).append(receipt)
            if not receipt.get("cephHealth") or not receipt.get("nodeStorageObservationRefs") or not receipt.get("csiObservation"):
                report["gaps"].append(args.phase + ": no complete contemporaneous Ceph health, actual CSI version and node map/mount operator observations.")
        else:
            report["gaps"].append(args.phase + ": fresh Ceph health and node map/mount operator observations were not collected in this phase.")
        execute_phase(args, env, kube, report, receipt)
        report["phaseSucceeded"] = True
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
        raise
    finally:
        report["finishedAt"] = utc_now()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"phase": args.phase, "phaseSucceeded": True, "report": str(output / "report.json"), "clusterAcceptance": "INCOMPLETE"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print("refused/failed: " + str(error), file=sys.stderr)
        sys.exit(2)
