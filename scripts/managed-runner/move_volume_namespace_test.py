"""move_volume_namespace.py against a fake kubectl that keeps a small cluster in a JSON file.

The fake binds as Kubernetes does for what the move relies on: deleting a claim whose PV is Retain
leaves the PV Released, still naming the claim it had; a PV whose claimRef names a namespace and a
claim without a UID binds the first such claim created, which then gets a new UID.

    python3 -m unittest scripts/managed-runner/move_volume_namespace_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "move_volume_namespace.py"

FAKE_KUBECTL = r'''
import json, os, sys, uuid
state_path = os.environ["FAKE_CLUSTER"]
state = json.load(open(state_path))
args = sys.argv[1:]
log = open(state_path + ".log", "a"); log.write(" ".join(args) + "\n"); log.close()
fail_on = os.environ.get("FAKE_FAIL_ON")
if fail_on and " ".join(args).startswith(fail_on):
    sys.stderr.write("injected failure\n"); sys.exit(1)

def save(): json.dump(state, open(state_path, "w"))
def ns_of(args): return args[args.index("-n") + 1] if "-n" in args else None
def missing(kind, name): sys.stderr.write(f'Error from server (NotFound): {kind} "{name}" not found\n'); sys.exit(1)

def bind(pvc):
    for pv in state["pvs"]:
        ref = pv["spec"].get("claimRef") or {}
        if pv["metadata"]["name"] == pvc["spec"].get("volumeName") and ref.get("namespace") == pvc["metadata"]["namespace"] \
                and ref.get("name") == pvc["metadata"]["name"] and not ref.get("uid"):
            ref["uid"] = pvc["metadata"]["uid"]; pv["status"] = {"phase": "Bound"}; pvc["status"] = {"phase": "Bound"}
            return
    pvc["status"] = {"phase": "Pending"}

verb = args[0]
if verb == "get":
    kind, rest = args[1], args[2:]
    name = rest[0] if rest and not rest[0].startswith("-") else None
    ns = ns_of(args)
    if kind == "namespace":
        if name in state["namespaces"]: print(json.dumps({"metadata": {"name": name}})); sys.exit(0)
        missing("namespaces", name)
    if kind == "pvc":
        for c in state["pvcs"]:
            if c["metadata"]["name"] == name and c["metadata"]["namespace"] == ns: print(json.dumps(c)); sys.exit(0)
        missing("persistentvolumeclaims", name)
    if kind == "pv":
        for v in state["pvs"]:
            if v["metadata"]["name"] == name: print(json.dumps(v)); sys.exit(0)
        missing("persistentvolumes", name)
    if kind == "pods":
        print(json.dumps({"items": [p for p in state["pods"] if p["metadata"]["namespace"] == ns]})); sys.exit(0)
    if kind == "volumeattachments":
        print(json.dumps({"items": state["attachments"]})); sys.exit(0)
    sys.exit(2)
if verb == "delete":
    name, ns = args[2], ns_of(args)
    claim = next(c for c in state["pvcs"] if c["metadata"]["name"] == name and c["metadata"]["namespace"] == ns)
    state["pvcs"].remove(claim)
    for v in state["pvs"]:
        if (v["spec"].get("claimRef") or {}).get("uid") == claim["metadata"]["uid"]:
            if v["spec"]["persistentVolumeReclaimPolicy"] == "Delete": state["pvs"].remove(v)
            else: v["status"] = {"phase": "Released"}
    save(); sys.exit(0)
if verb == "patch":
    name = args[2]; patch = json.loads(args[args.index("-p") + 1])
    pv = next(v for v in state["pvs"] if v["metadata"]["name"] == name)
    for op in patch:
        assert op["op"] == "replace" and op["path"] == "/spec/claimRef"
        pv["spec"]["claimRef"] = op["value"]; pv["status"] = {"phase": "Available"}
    save(); sys.exit(0)
if verb == "create":
    pvc = json.loads(sys.stdin.read())
    pvc["metadata"]["uid"] = str(uuid.uuid4())
    state["pvcs"].append(pvc); bind(pvc); save(); sys.exit(0)
sys.exit(2)
'''

OLD_UID = "d2a70caa-4b53-452e-9e3a-746bb9383053"
PV_UID = "0153aab4-40b7-4d6f-8f1f-6c5c93d55f25"
HANDLE = "0001-0024-cluster-0000000000000003-d858346b"
CLAIM = "mr-data-01a1e190-373f-76ce-8a14-4a43c4ce5f4a"
PV = "pvc-d2a70caa-4b53-452e-9e3a-746bb9383053"


def cluster(reclaim="Retain"):
    return {
        "namespaces": ["orbit-managed", "orbit-cloud"],
        "pvcs": [{
            "metadata": {"name": CLAIM, "namespace": "orbit-managed", "uid": OLD_UID,
                         "annotations": {"orbit.dev/owner-id": "owner-1", "orbit.dev/runner-id": "runner-1",
                                         "pv.kubernetes.io/bind-completed": "yes"}},
            "spec": {"storageClassName": "runner-data-xfs", "accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem",
                     "resources": {"requests": {"storage": "100Gi"}}, "volumeName": PV},
            "status": {"phase": "Bound"},
        }],
        "pvs": [{
            "metadata": {"name": PV, "uid": PV_UID},
            "spec": {"persistentVolumeReclaimPolicy": reclaim, "storageClassName": "runner-data-xfs",
                     "claimRef": {"namespace": "orbit-managed", "name": CLAIM, "uid": OLD_UID},
                     "csi": {"driver": "rbd.csi.ceph.com", "volumeHandle": HANDLE}},
            "status": {"phase": "Bound"},
        }],
        "pods": [],
        "attachments": [],
    }


class MoveVolumeNamespaceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "kubectl.py").write_text(FAKE_KUBECTL)
        self.state = self.root / "cluster.json"
        self.backup = self.root / "backup"

    def tearDown(self):
        self.dir.cleanup()

    def write(self, state):
        self.state.write_text(json.dumps(state))

    def read(self):
        return json.loads(self.state.read_text())

    def run_move(self, *extra, source="orbit-managed", target="orbit-cloud", **env):
        environment = {**os.environ, "KUBECTL": f"{sys.executable} -I {self.root / 'kubectl.py'}", "FAKE_CLUSTER": str(self.state), **env}
        return subprocess.run([sys.executable, "-I", str(SCRIPT), "--from", source, "--to", target, "--pvc", CLAIM,
                               "--backup", str(self.backup), "--timeout", "5", *extra],
                              capture_output=True, text=True, env=environment)

    def claim_in(self, namespace):
        return [c for c in self.read()["pvcs"] if c["metadata"]["namespace"] == namespace]

    def test_the_volume_moves_with_its_pv_identity_and_its_annotations(self):
        self.write(cluster())
        run = self.run_move()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.claim_in("orbit-managed"), [])
        [moved] = self.claim_in("orbit-cloud")
        self.assertNotEqual(moved["metadata"]["uid"], OLD_UID)
        self.assertEqual(moved["metadata"]["annotations"], {"orbit.dev/owner-id": "owner-1", "orbit.dev/runner-id": "runner-1"})
        self.assertEqual(moved["spec"]["volumeName"], PV)
        [pv] = self.read()["pvs"]
        self.assertEqual((pv["metadata"]["uid"], pv["spec"]["csi"]["volumeHandle"]), (PV_UID, HANDLE))
        self.assertEqual(pv["spec"]["claimRef"]["uid"], moved["metadata"]["uid"])
        line = run.stdout.strip().split("\t")
        self.assertEqual(line, [CLAIM, OLD_UID, moved["metadata"]["uid"], PV, PV_UID, HANDLE])
        self.assertEqual((self.backup / "moved.tsv").read_text().strip().split("\t"), line)
        self.assertTrue((self.backup / f"{CLAIM}.orbit-managed.pvc.json").exists())

    def test_and_back_again(self):
        self.write(cluster())
        self.assertEqual(self.run_move().returncode, 0)
        back = self.run_move(source="orbit-cloud", target="orbit-managed")
        self.assertEqual(back.returncode, 0, back.stderr)
        [claim] = self.claim_in("orbit-managed")
        self.assertEqual(self.read()["pvs"][0]["spec"]["claimRef"]["uid"], claim["metadata"]["uid"])

    def test_a_dry_run_changes_nothing(self):
        self.write(cluster())
        before = self.read()
        run = self.run_move("--dry-run")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("dry run", run.stderr)
        self.assertEqual(self.read(), before)
        self.assertFalse(self.backup.exists(), "a dry run makes no backup directory either")

    def test_it_refuses_what_would_lose_or_share_the_volume(self):
        cases = {
            "a Delete PV": (lambda s: s["pvs"][0]["spec"].update(persistentVolumeReclaimPolicy="Delete"), "not Retain"),
            "a Pod mounting the claim": (lambda s: s["pods"].append({"metadata": {"name": "mr-01a1e190", "namespace": "orbit-managed"},
                                                                     "spec": {"volumes": [{"persistentVolumeClaim": {"claimName": CLAIM}}]}}),
                                         "mount"),
            "an attachment": (lambda s: s["attachments"].append({"metadata": {"name": "csi-1"}, "spec": {"source": {"persistentVolumeName": PV}}}),
                              "attached"),
            "no target namespace": (lambda s: s["namespaces"].remove("orbit-cloud"), "does not exist"),
            "a claim there already": (lambda s: s["pvcs"].append({"metadata": {"name": CLAIM, "namespace": "orbit-cloud", "uid": "x"},
                                                                  "spec": {"volumeName": "another"}}), "already has"),
            "a PV bound elsewhere": (lambda s: s["pvs"][0]["spec"]["claimRef"].update(uid="someone-else"), "not bound to"),
        }
        for name, (change, needle) in cases.items():
            with self.subTest(name):
                state = cluster()
                change(state)
                self.write(state)
                before = self.read()
                run = self.run_move()
                self.assertEqual(run.returncode, 1, run.stderr)
                self.assertIn(needle, run.stderr)
                self.assertEqual(self.read(), before, "nothing changed")

    def test_a_run_that_stopped_after_the_delete_is_finished_by_the_next(self):
        self.write(cluster())
        run = self.run_move(FAKE_FAIL_ON="patch")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(self.claim_in("orbit-managed"), [], "the claim was deleted before the failure")
        self.assertEqual(self.read()["pvs"][0]["status"]["phase"], "Released")
        again = self.run_move()
        self.assertEqual(again.returncode, 0, again.stderr)
        [moved] = self.claim_in("orbit-cloud")
        self.assertEqual(self.read()["pvs"][0]["spec"]["claimRef"]["uid"], moved["metadata"]["uid"])
        self.assertEqual(again.stdout.split("\t")[1], OLD_UID, "the old UID comes from the saved copy")

    def test_a_run_that_stopped_after_making_the_new_claim_is_finished_by_the_next(self):
        self.write(cluster())
        self.assertEqual(self.run_move().returncode, 0)
        # As if it had stopped once the new claim was made: the move's line was never recorded.
        (self.backup / "moved.tsv").unlink()
        again = self.run_move()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(len(self.claim_in("orbit-cloud")), 1)
        self.assertTrue((self.backup / "moved.tsv").exists())

    def test_without_a_saved_copy_a_missing_claim_is_refused(self):
        state = cluster()
        state["pvcs"] = []
        self.write(state)
        run = self.run_move()
        self.assertEqual(run.returncode, 1)
        self.assertIn("no saved copy", run.stderr)


if __name__ == "__main__":
    unittest.main()
