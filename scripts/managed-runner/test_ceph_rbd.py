"""Offline safety regression tests; these establish no Ceph/Kubernetes acceptance."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ceph_rbd


EXAMPLE = ceph_rbd.TEMPLATES / "environment.example.json"
spec = importlib.util.spec_from_file_location("ceph_rbd_payload", Path(__file__).with_name("ceph-rbd-payload.py"))
payload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(payload)


def actual_fixture():
    # Deliberately unreachable endpoint and nonexistent credentials: never a live environment.
    env = json.loads(EXAMPLE.read_text())

    def replace(value):
        if isinstance(value, dict):
            return {key: replace(child) for key, child in value.items()}
        if isinstance(value, list):
            return [replace(child) for child in value]
        if isinstance(value, str):
            return value.replace("REPLACE_ME", "offline-test").replace("pending", "offline-test")
        return value

    env = replace(env)
    env["valueKind"] = "actual"
    env["authorization"]["allowedOperations"] = ["create-test-pods", "delete-test-pods", "exec-test-pods"]
    env["kubernetes"].update({"kubeconfig": "/nonexistent/offline-test.kubeconfig", "apiServer": "https://127.0.0.1:9",
                              "context": "offline-test", "namespace": "offline-test", "namespaceUID": "ns-uid",
                              "nodeA": {"name": "offline-a", "uid": "a-uid"}, "nodeB": {"name": "offline-b", "uid": "b-uid"}})
    env["ceph"].update({"topology": "external", "fsid": "00000000-0000-4000-8000-000000000001", "replicaCount": 3, "minSize": 2})
    env["csi"].update({"driver": "rbd.csi.ceph.com", "configurationOwner": "raw"})
    env["storage"].update({"ownerID": "00000000-0000-4000-8000-000000000002", "runnerID": "00000000-0000-4000-8000-000000000003",
                           "pvcName": "mr-data-00000000-0000-4000-8000-000000000003", "capacity": "1Gi"})
    env["verification"].update({"image": "offline-test/probe@sha256:" + "a" * 64, "receiptAuthorityRefs": ["offline-test-authority"]})
    env["protection"].update({"admissionReady": True, "fencingReady": True})
    return env


class PreparationTests(unittest.TestCase):
    def load(self, env, live=False):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "environment.json"
            path.write_text(json.dumps(env))
            return ceph_rbd.load_environment(path, live=live)

    def test_example_render_has_explicit_storage_and_no_secret_or_compute(self):
        with patch("subprocess.run", side_effect=AssertionError("offline work invoked a process")):
            env = ceph_rbd.load_environment(EXAMPLE)
            manifests = ceph_rbd.render(env)
        self.assertEqual({value["kind"] for value in manifests.values()}, {"ConfigMap", "StorageClass", "PersistentVolumeClaim"})
        sc = manifests["storageclass.json"]
        self.assertEqual(sc["reclaimPolicy"], "Retain")
        self.assertEqual(sc["metadata"]["annotations"]["storageclass.kubernetes.io/is-default-class"], "false")
        self.assertEqual(sc["parameters"]["mounter"], "rbd")
        self.assertEqual(sc["parameters"]["tryOtherMounters"], "false")
        self.assertEqual(sc["parameters"]["csi.storage.k8s.io/fstype"], "ext4")
        self.assertEqual(json.loads(manifests["csi-config.json"]["data"]["config.json"])[0]["clusterID"], sc["parameters"]["clusterID"])
        self.assertNotIn("ownerReferences", manifests["pvc.json"]["metadata"])
        self.assertEqual(manifests["pvc.json"]["spec"]["storageClassName"], "runner-data")
        self.assertNotIn("userKey", json.dumps(manifests))

    def test_example_cannot_enter_live_path(self):
        with self.assertRaisesRegex(ValueError, "example values"):
            ceph_rbd.load_environment(EXAMPLE, live=True)

    def test_complete_fixture_render_preserves_reference_types(self):
        manifests = ceph_rbd.render(self.load(actual_fixture()))
        self.assertIs(manifests["storageclass.json"]["allowVolumeExpansion"], False)
        self.assertEqual(manifests["pvc.json"]["spec"]["resources"]["requests"]["storage"], "1Gi")

    def test_unsafe_profiles_are_rejected(self):
        cases = [("storage", "accessMode", "ReadWriteOncePod"), ("storage", "reclaimPolicy", "Delete"),
                 ("storage", "fsType", "xfs"), ("storage", "mounter", "rbd-nbd"),
                 ("storage", "mounter", "krbd"), ("kubernetes", "context", "--context=production"),
                 ("storage", "allowExpansion", True), ("authorization", "nonProduction", False),
                 ("ceph", "minSize", 1), ("protection", "admissionReady", False),
                 ("protection", "fencingReady", False), ("authorization", "allowedOperations", []),
                 ("ceph", "topology", "pending"), ("kubernetes", "context", "default"),
                 ("kubernetes", "namespace", "default"), ("verification", "receiptAuthorityRefs", []),
                 ("verification", "image", "probe:latest"), ("versions", "compatibilityEvidenceRef", "REPLACE_ME"),
                 ("csi", "driver", "cephfs.csi.ceph.com")]
        for group, key, value in cases:
            with self.subTest(group=group, key=key):
                env = actual_fixture()
                env[group][key] = value
                with self.assertRaises(ValueError):
                    self.load(env, live=True)

    def test_duplicate_nodes_or_volume_identity_conflict_are_rejected(self):
        env = actual_fixture()
        env["kubernetes"]["nodeB"] = copy.deepcopy(env["kubernetes"]["nodeA"])
        with self.assertRaises(ValueError):
            self.load(env, live=True)
        env = actual_fixture()
        env["storage"]["pvcName"] = "unrelated-volume"
        with self.assertRaises(ValueError):
            self.load(env, live=True)

    def test_environment_rejects_credential_material(self):
        env = json.loads(EXAMPLE.read_text())
        env["csi"]["userKey"] = "unit-test-credential-tripwire"
        with self.assertRaisesRegex(ValueError, "references only"):
            self.load(env)


class ProbeTests(unittest.TestCase):
    def test_probe_prefix_proves_committed_rows_survive_new_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "offline-probe"
            database = payload.initialize(root)
            try:
                for index in range(1, 4):
                    database.execute("INSERT INTO probe VALUES (?, ?)", (index, f"row-{index}"))
                database.commit()
                payload.durable_write(root / "acknowledged.json", json.dumps({"committedRows": 3}))
                before = payload.snapshot(root)
                database.execute("INSERT INTO probe VALUES (4, 'row-4')")
                database.commit()
                after = payload.snapshot(root, minimum_rows=3)
                self.assertEqual(before["rowSHA256"], after["prefixSHA256"])
                self.assertEqual(before["ordinarySHA256"], after["ordinarySHA256"])
                self.assertEqual(before["gitCommit"], after["gitCommit"])
                self.assertEqual(after["sqliteIntegrity"], ["ok"])
                self.assertEqual(after["sqliteJournalMode"].lower(), "wal")
                self.assertEqual(after["gitStatus"], "")
                self.assertEqual(after["committedRows"], 4)
                database.execute("UPDATE probe SET payload='corrupted' WHERE sequence=2")
                database.commit()
                self.assertNotEqual(before["rowSHA256"], payload.snapshot(root, minimum_rows=3)["prefixSHA256"])
            finally:
                database.close()

    def test_probe_rejects_missing_committed_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "offline-probe"
            database = payload.initialize(root)
            try:
                database.execute("INSERT INTO probe VALUES (2, 'row-2')")
                database.commit()
                payload.durable_write(root / "acknowledged.json", json.dumps({"committedRows": 2}))
                with self.assertRaisesRegex(RuntimeError, "committed-row"):
                    payload.snapshot(root, minimum_rows=2)
            finally:
                database.close()

    def test_successor_cannot_initialize_missing_data_or_write_before_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing-original-data"
            with self.assertRaisesRegex(RuntimeError, "may not initialize"):
                payload.writer(missing, require_existing=True, initially_quiesced=True)
            self.assertFalse(missing.exists())
            root = Path(directory) / "offline-probe"
            database = payload.initialize(root)
            database.execute("INSERT INTO probe VALUES (1, 'original-row')")
            database.commit()
            database.close()
            payload.durable_write(root / "acknowledged.json", json.dumps({"committedRows": 1}))
            before = payload.snapshot(root)
            with patch.object(payload, "initialize", side_effect=AssertionError("successor must not initialize")), \
                 patch.object(payload.signal, "signal"), patch.object(payload.time, "sleep", side_effect=InterruptedError("test ends idle loop")):
                with self.assertRaises(InterruptedError):
                    payload.writer(root, require_existing=True, initially_quiesced=True)
            after = payload.snapshot(root)
            self.assertEqual(before["rowSHA256"], after["rowSHA256"])
            self.assertEqual(after["committedRows"], 1)
            self.assertTrue(after["quiesced"])


if __name__ == "__main__":
    unittest.main()
