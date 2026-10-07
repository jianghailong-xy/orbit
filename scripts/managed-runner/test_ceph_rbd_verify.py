"""No cluster access: denial paths and receipt binding with subprocess tripwires."""

import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_ceph_rbd import actual_fixture


spec = importlib.util.spec_from_file_location("ceph_rbd_verify", Path(__file__).with_name("ceph-rbd-verify.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class LiveBoundaryTests(unittest.TestCase):
    def test_no_execute_wrong_context_namespace_permissions_or_missing_kubeconfig_cannot_call_kubectl(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "environment.json"
            base = ["verify", "--phase", "baseline", "--environment", str(config), "--context", "offline-test",
                    "--namespace", "offline-test", "--output", str(Path(directory) / "output")]
            for failure in ("execute", "context", "namespace", "operations", "kubeconfig"):
                with self.subTest(failure=failure):
                    env = actual_fixture()
                    args = base.copy()
                    if failure != "execute":
                        args.append("--execute")
                    if failure in ("context", "namespace"):
                        args[args.index("--" + failure) + 1] = "unapproved-scope"
                    if failure == "operations":
                        env["authorization"]["allowedOperations"] = ["exec-test-pods"]
                    config.write_text(json.dumps(env))
                    with patch.object(sys, "argv", args), patch("subprocess.run", side_effect=AssertionError("kubectl must not run")):
                        with self.assertRaises(ValueError):
                            verify.main()
                    self.assertFalse((Path(directory) / "output").exists())

    def test_wrong_api_server_prevents_mutation_and_kubeconfig_is_not_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            env = actual_fixture()
            kube = verify.Kube(env, Path(directory))
            config = {"contexts": [{"name": env["kubernetes"]["context"]}],
                      "clusters": [{"cluster": {"server": "https://unapproved.invalid"}}],
                      "users": [{"user": {"token": "credential-log-tripwire"}}]}
            response = subprocess.CompletedProcess([], 0, json.dumps(config), "")
            with patch("subprocess.run", return_value=response) as run:
                with self.assertRaisesRegex(ValueError, "API server"):
                    kube.call(["create", "-f", "-"], manifest={"kind": "Pod"}, write=True)
            self.assertEqual(run.call_count, 1)
            command = run.call_args.args[0]
            for flag, expected in (("--kubeconfig", env["kubernetes"]["kubeconfig"]),
                                   ("--context", "offline-test"), ("--namespace", "offline-test")):
                self.assertEqual(command[command.index(flag) + 1], expected)
            self.assertNotIn("create", command)
            self.assertNotIn("credential-log-tripwire", (Path(directory) / "commands.jsonl").read_text())

    def test_writes_check_identity_and_do_not_invoke_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            kube = verify.Kube(actual_fixture(), Path(directory))
            response = subprocess.CompletedProcess([], 0, "{}", "")
            with patch.object(kube, "check_identity") as check, patch("subprocess.run", return_value=response) as run:
                kube.call(["create", "-f", "-"], manifest={"kind": "Pod"}, write=True)
            check.assert_called_once()
            self.assertIsInstance(run.call_args.args[0], list)
            self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_expiring_fence_prevents_successor_write(self):
        with tempfile.TemporaryDirectory() as directory:
            kube = verify.Kube(actual_fixture(), Path(directory))
            kube.fence_expiry = datetime.now(timezone.utc) + timedelta(seconds=1)
            with patch.object(kube, "check_identity"), patch("subprocess.run", side_effect=AssertionError("expired fence must block mutation")):
                with self.assertRaisesRegex(ValueError, "no longer covers"):
                    kube.call(["create", "-f", "-"], manifest={"kind": "Pod"}, write=True)

    def test_only_explicit_single_pod_admission_denial_counts(self):
        marker = "MANAGED_PVC_SINGLE_POD"
        denial = 'Error from server (Forbidden): admission webhook "managed.test" denied the request: ' + marker
        self.assertTrue(verify.admission_denied(1, "", denial, marker))
        for code, message in ((0, denial), (1, "cannot create resource pods: " + marker),
                              (1, "Multi-Attach error: " + marker), (1, "image pull failed: " + marker),
                              (1, 'admission webhook "different.test" denied the request: different policy')):
            with self.subTest(message=message):
                self.assertFalse(verify.admission_denied(code, "", message, marker))

    def test_delete_uses_atomic_old_pod_uid_and_default_grace(self):
        with tempfile.TemporaryDirectory() as directory:
            kube = verify.Kube(actual_fixture(), Path(directory))
            with patch.object(kube, "call") as call:
                kube.delete_pod("probe", "old-pod-uid")
            args = call.call_args.args[0]
            body = call.call_args.kwargs["manifest"]
            self.assertEqual(body["preconditions"], {"uid": "old-pod-uid"})
            self.assertNotIn("gracePeriodSeconds", body)
            self.assertNotIn("--force", args)
            self.assertEqual(args[args.index("--raw") + 1], "/api/v1/namespaces/offline-test/pods/probe")
            self.assertTrue(call.call_args.kwargs["write"])

    def test_pod_mutation_or_local_ext4_cannot_count_as_rbd_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            env = actual_fixture()
            kube = verify.Kube(env, Path(directory))
            identity = {"podName": "probe", "podUID": "pod-uid", "nodeName": "offline-a", "nodeUID": "a-uid", "generation": 1}
            template = verify.pod_manifest(env, identity, "offline-probe")
            kube.expected_pod_manifest = template
            valid = copy.deepcopy(template)
            valid["metadata"]["uid"] = identity["podUID"]
            for failure in ("volume", "image", "generation"):
                with self.subTest(failure=failure):
                    pod = copy.deepcopy(valid)
                    if failure == "volume":
                        pod["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"] = "other-volume"
                    elif failure == "image":
                        pod["spec"]["containers"][0]["image"] = "unapproved:latest"
                    else:
                        pod["metadata"]["annotations"][env["verification"]["reservationAnnotation"]] = "2"
                    with patch.object(kube, "pod", return_value=pod):
                        with self.assertRaises(ValueError):
                            verify.assert_pod(kube, identity)
            result = {"sqliteIntegrity": ["ok"], "sqliteJournalMode": "wal", "gitStatus": "",
                      "mountInfo": ["32 25 8:1 / /var/lib/orbit rw - ext4 /dev/sda1 rw"]}
            response = subprocess.CompletedProcess([], 0, json.dumps(result), "")
            with patch.object(verify, "assert_pod"), patch.object(kube, "call", return_value=response):
                with self.assertRaisesRegex(ValueError, "kernel /dev/rbd"):
                    verify.probe(kube, identity, "offline-probe")


class ReceiptTests(unittest.TestCase):
    def fixture(self):
        env = actual_fixture()
        scope = {"context": "offline-test", "pvcUID": "pvc-uid", "pvUID": "pv-uid", "volumeHandle": "original-handle",
                 "rbdImage": "original-image", "podName": "probe"}
        predecessor = {"podName": "probe", "podUID": "old-pod-uid", "nodeName": "offline-a", "nodeUID": "a-uid", "generation": 1}
        target = env["kubernetes"]["nodeB"]
        receipt = {"schemaVersion": 1, "kind": "power-off-fence", "authorityRef": "offline-test-authority", "scope": scope,
                   "observedAt": datetime.now(timezone.utc).isoformat(), "predecessor": predecessor,
                   "reservation": {"podName": "probe", "nodeName": target["name"], "nodeUID": target["uid"], "generation": 2,
                                   "reservationRef": "unit-reservation", "admissionPolicyRef": "unit-policy", "requestUser": "unit-manager"},
                   "detach": {"allContainersStopped": True, "csiUnpublished": True, "csiUnstaged": True,
                              "deviceUnmapped": True, "noMountsOrClients": True, "observationRefs": ["unit-unmap-observation"]},
                   "powerOffFence": {"poweredOff": True, "quarantined": True, "controlActionRef": "unit-power-action",
                                     "independentPowerOffObservationRef": "unit-independent-power", "quarantineRef": "unit-quarantine",
                                     "outOfServiceRunbookRef": "unit-runbook",
                                     "validUntil": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}}
        return env, scope, predecessor, target, receipt

    def test_receipt_requires_current_volume_predecessor_authority_and_quarantine(self):
        env, scope, predecessor, target, valid = self.fixture()
        verify.validate_receipt(valid, env, scope, predecessor, target, "power-off-fence")
        alterations = [("authorityRef", "untrusted"), ("scope", dict(scope, pvcUID="replacement-pvc")),
                       ("predecessor", dict(predecessor, podUID="another-pod")),
                       ("reservation", dict(valid["reservation"], generation=1)),
                       ("detach", dict(valid["detach"], deviceUnmapped=False)),
                       ("powerOffFence", dict(valid["powerOffFence"], poweredOff=False)),
                       ("powerOffFence", dict(valid["powerOffFence"], quarantined=False)),
                       ("powerOffFence", dict(valid["powerOffFence"], validUntil=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat())),
                       ("observedAt", (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())]
        for key, value in alterations:
            with self.subTest(key=key):
                receipt = copy.deepcopy(valid)
                receipt[key] = value
                with self.assertRaises(ValueError):
                    verify.validate_receipt(receipt, env, scope, predecessor, target, "power-off-fence")

    def test_previous_stop_receipt_cannot_be_replayed_for_new_handoff(self):
        env, scope, predecessor, target, receipt = self.fixture()
        receipt["observedAt"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        trigger = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        with self.assertRaisesRegex(ValueError, "predates"):
            verify.validate_receipt(receipt, env, scope, predecessor, target, "power-off-fence", not_before=trigger)


if __name__ == "__main__":
    unittest.main()
