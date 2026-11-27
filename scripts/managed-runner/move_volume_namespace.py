#!/usr/bin/env python3
"""Move one managed runner's data volume to another namespace of the same cluster, keeping its data.

A namespace cannot be renamed, and a PersistentVolumeClaim cannot move. What can move is the
claim's PersistentVolume: with reclaim policy Retain, deleting the claim leaves the volume and its
data, and the volume can then be bound to a new claim of the same name in the other namespace. The
PV, its UID and its CSI volume handle stay what Orbit recorded; the claim gets a new UID, which the
runner's mapping must then record (docs/managed-runner-kubernetes-operations.md, "Move the runners
to another namespace").

    move_volume_namespace.py --from orbit-managed --to orbit-cloud --pvc mr-data-<runner uuid> --backup DIR [--dry-run]

It refuses, having changed nothing, unless: the claim is Bound; its PV is Retain and bound to it;
no Pod in either namespace mounts a claim of that name; no VolumeAttachment names the PV; and the
target namespace exists without a claim of that name. Before deleting anything it saves the claim
and the PV as JSON in DIR. A run that stopped after the claim was deleted is finished by running it
again with the same DIR. Moving back is the same command with --from and --to swapped.

It prints one tab-separated line, also appended to DIR/moved.tsv:
    <pvc name> <old claim uid> <new claim uid> <pv name> <pv uid> <volume handle>

KUBECTL names the command (default `kubectl`), for example `k3s kubectl` or `kubectl --context x`.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

KEPT_ANNOTATION_PREFIX = "orbit.dev/"


class Refused(Exception):
    pass


def kubectl(*args, stdin=None, check=True):
    command = shlex.split(os.environ.get("KUBECTL", "kubectl")) + list(args)
    done = subprocess.run(command, input=stdin, capture_output=True, text=True)
    if check and done.returncode != 0:
        raise Refused(f"{' '.join(args)}: {done.stderr.strip() or done.stdout.strip()}")
    return done


def get(kind, name, namespace=None):
    """The object as JSON, or None when it does not exist."""
    args = ["get", kind, name, "-o", "json"] + (["-n", namespace] if namespace else [])
    done = kubectl(*args, check=False)
    if done.returncode == 0:
        return json.loads(done.stdout)
    if "NotFound" in done.stderr or "not found" in done.stderr:
        return None
    raise Refused(f"get {kind} {name}: {done.stderr.strip()}")


def items(kind, namespace=None):
    args = ["get", kind, "-o", "json"] + (["-n", namespace] if namespace else [])
    return json.loads(kubectl(*args).stdout).get("items", [])


def pods_mounting(namespace, claim):
    return [p["metadata"]["name"] for p in items("pods", namespace)
            if any((v.get("persistentVolumeClaim") or {}).get("claimName") == claim for v in p["spec"].get("volumes", []))]


def attachments_of(pv_name):
    return [a["metadata"]["name"] for a in items("volumeattachments")
            if (a.get("spec", {}).get("source") or {}).get("persistentVolumeName") == pv_name]


def wait_for(what, check, timeout, interval=2):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise Refused(f"timed out after {timeout}s waiting for {what}")
        time.sleep(interval)


def new_claim(old, namespace, pv_name):
    meta = old["metadata"]
    spec = old["spec"]
    return {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {
            "name": meta["name"],
            "namespace": namespace,
            "labels": dict(meta.get("labels") or {}),
            "annotations": {k: v for k, v in (meta.get("annotations") or {}).items() if k.startswith(KEPT_ANNOTATION_PREFIX)},
        },
        "spec": {
            "storageClassName": spec["storageClassName"],
            "accessModes": spec["accessModes"],
            "volumeMode": spec.get("volumeMode", "Filesystem"),
            "resources": {"requests": {"storage": spec["resources"]["requests"]["storage"]}},
            "volumeName": pv_name,
        },
    }


def move(source_ns, target_ns, claim, backup, dry_run, timeout):
    if source_ns == target_ns:
        raise Refused("--from and --to are the same namespace")
    saved_claim = backup / f"{claim}.{source_ns}.pvc.json"
    saved_pv = backup / f"{claim}.{source_ns}.pv.json"

    if get("namespace", target_ns) is None:
        raise Refused(f"namespace {target_ns} does not exist")
    already = get("pvc", claim, target_ns)
    if already is not None:
        # A run that stopped after making the new claim: finish it if that claim is ours, on the PV saved.
        saved = json.loads(saved_claim.read_text()) if saved_claim.exists() and saved_pv.exists() else None
        if saved is None or already["spec"].get("volumeName") != saved["spec"]["volumeName"]:
            raise Refused(f"{target_ns} already has a claim {claim}")
        if dry_run:
            print(f"dry run: {target_ns}/{claim} exists on the saved PV; a run would finish the move", file=sys.stderr)
            return None
        return finish(source_ns, target_ns, claim, backup, saved, json.loads(saved_pv.read_text()), timeout)
    for namespace in (source_ns, target_ns):
        users = pods_mounting(namespace, claim)
        if users:
            raise Refused(f"Pods in {namespace} mount {claim}: {', '.join(users)}")

    old = get("pvc", claim, source_ns)
    if old is not None:
        if old.get("status", {}).get("phase") != "Bound" or not old["spec"].get("volumeName"):
            raise Refused(f"{source_ns}/{claim} is not Bound")
        pv_name = old["spec"]["volumeName"]
        pv = get("pv", pv_name)
        if pv is None:
            raise Refused(f"its PV {pv_name} does not exist")
        ref = pv["spec"].get("claimRef") or {}
        if (ref.get("namespace"), ref.get("name"), ref.get("uid")) != (source_ns, claim, old["metadata"]["uid"]):
            raise Refused(f"PV {pv_name} is not bound to {source_ns}/{claim}")
        resumed = False
    else:
        if not (saved_claim.exists() and saved_pv.exists()):
            raise Refused(f"{source_ns}/{claim} does not exist, and {backup} holds no saved copy of it to resume from")
        old = json.loads(saved_claim.read_text())
        pv_name = old["spec"]["volumeName"]
        pv = get("pv", pv_name)
        if pv is None:
            raise Refused(f"its PV {pv_name} does not exist")
        ref = pv["spec"].get("claimRef") or {}
        if ref.get("namespace") not in (source_ns, target_ns) or ref.get("name") != claim:
            raise Refused(f"PV {pv_name} is claimed by {ref.get('namespace')}/{ref.get('name')}, not by {claim}")
        resumed = True

    saved_pv_uid = json.loads(saved_pv.read_text())["metadata"]["uid"] if resumed else pv["metadata"]["uid"]
    handle = (pv["spec"].get("csi") or {}).get("volumeHandle")
    if pv["spec"].get("persistentVolumeReclaimPolicy") != "Retain":
        raise Refused(f"PV {pv_name} is not Retain: deleting its claim would delete the data")
    if pv["metadata"]["uid"] != saved_pv_uid:
        raise Refused(f"PV {pv_name} has another UID than the one saved")
    if not handle:
        raise Refused(f"PV {pv_name} has no CSI volume handle")
    attached = attachments_of(pv_name)
    if attached:
        raise Refused(f"PV {pv_name} is attached: {', '.join(attached)}")

    plan = f"{source_ns}/{claim} -> {target_ns}/{claim} on PV {pv_name} ({handle})"
    if dry_run:
        print(f"dry run: would move {plan}{' (resuming)' if resumed else ''}; nothing changed", file=sys.stderr)
        return None

    if not resumed:
        backup.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path, obj in ((saved_claim, old), (saved_pv, pv)):
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(obj, indent=2) + "\n")
            os.chmod(tmp, 0o600)
            tmp.replace(path)
        print(f"saved {saved_claim.name} and {saved_pv.name} in {backup}", file=sys.stderr)
        kubectl("delete", "pvc", claim, "-n", source_ns, "--wait=true", f"--timeout={timeout}s")
        print(f"deleted {source_ns}/{claim}; PV {pv_name} keeps the data (Retain)", file=sys.stderr)

    # Point the PV at the claim to come, by namespace and name only: no UID, so the new claim binds it.
    ref = {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "namespace": target_ns, "name": claim}
    kubectl("patch", "pv", pv_name, "--type", "json", "-p",
            json.dumps([{"op": "replace", "path": "/spec/claimRef", "value": ref}]))
    kubectl("create", "-f", "-", stdin=json.dumps(new_claim(old, target_ns, pv_name)))
    return finish(source_ns, target_ns, claim, backup, old, json.loads(saved_pv.read_text()), timeout)


def finish(source_ns, target_ns, claim, backup, old, saved_pv, timeout):
    """Wait for the new claim to bind the saved PV, check the PV kept its identity, and record the move."""
    pv_name = old["spec"]["volumeName"]
    handle = saved_pv["spec"]["csi"]["volumeHandle"]
    bound = wait_for(f"{target_ns}/{claim} to be Bound",
                     lambda: (lambda c: c if c and c.get("status", {}).get("phase") == "Bound" else None)(get("pvc", claim, target_ns)),
                     timeout)
    after = get("pv", pv_name)
    new_uid = bound["metadata"]["uid"]
    if (after["spec"].get("claimRef") or {}).get("uid") != new_uid:
        raise Refused(f"PV {pv_name} is not bound to the new claim's UID {new_uid}")
    if after["metadata"]["uid"] != saved_pv["metadata"]["uid"] or (after["spec"].get("csi") or {}).get("volumeHandle") != handle:
        raise Refused(f"PV {pv_name} changed identity during the move")
    line = "\t".join([claim, old["metadata"]["uid"], new_uid, pv_name, saved_pv["metadata"]["uid"], handle])
    with open(backup / "moved.tsv", "a") as out:
        out.write(line + "\n")
    print(f"moved {source_ns}/{claim} -> {target_ns}/{claim} on PV {pv_name}; new claim UID {new_uid}", file=sys.stderr)
    return line


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", required=True, help="the namespace the claim is in")
    parser.add_argument("--to", dest="target", required=True, help="the namespace to move it to")
    parser.add_argument("--pvc", required=True, help="the claim's name, mr-data-<runner uuid>")
    parser.add_argument("--backup", required=True, type=Path, help="where the claim and the PV are saved first")
    parser.add_argument("--dry-run", action="store_true", help="check everything, change nothing")
    parser.add_argument("--timeout", type=int, default=120, help="seconds to wait for a delete or a bind")
    args = parser.parse_args(argv)
    try:
        line = move(args.source, args.target, args.pvc, args.backup, args.dry_run, args.timeout)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 1
    if line:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
