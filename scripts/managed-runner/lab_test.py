#!/usr/bin/env python3
"""The single-machine lab's pins and rendered objects (lab/lab.env, lab/render.py), offline."""

import asyncio
import base64
import importlib.util
import ipaddress
import json
from pathlib import Path
import re
import tempfile
import unittest
import urllib.parse

LAB = Path(__file__).resolve().parent / "lab"
REPO = LAB.parents[2]
spec = importlib.util.spec_from_file_location("lab_render", LAB / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
spec = importlib.util.spec_from_file_location("lab_single_writer", LAB / "single-writer.py")
single_writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(single_writer)
spec = importlib.util.spec_from_file_location("lab_api_gate", LAB / "api-gate.py")
api_gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api_gate)
FSID = "03082086-c9eb-11f1-8363-525400123456"


class LabTest(unittest.TestCase):
    def test_every_download_and_image_is_pinned(self):
        for name, value in render.ENV.items():
            if name.endswith("_SHA256"):
                self.assertRegex(value, r"^[0-9a-f]{64}$", name)
            if name.endswith("_IMAGE"):
                self.assertRegex(value, r"@sha256:[0-9a-f]{64}$", name)
        self.assertIn(":v3.18.0@", render.ENV["CEPHCSI_IMAGE"])
        minor = int(re.match(r"v1\.(\d+)\.", render.ENV["K3S_VERSION"])[1])
        self.assertIn(minor, (34, 35, 36), "outside the Kubernetes versions Ceph-CSI v3.18.0 was tested with")

    def test_storage_class_comes_from_the_repository_template(self):
        manifests = render.ceph_rbd.render(render.storage_environment(FSID))
        sc = manifests["storageclass.json"]
        self.assertEqual(sc["metadata"]["name"], "runner-data")
        self.assertEqual(sc["provisioner"], "rbd.csi.ceph.com")
        self.assertEqual(sc["parameters"]["clusterID"], FSID)
        self.assertEqual(sc["parameters"]["pool"], "orbit-mr-rbd")
        for key, value in {"mounter": "rbd", "tryOtherMounters": "false", "imageFeatures": "layering",
                           "csi.storage.k8s.io/fstype": "ext4"}.items():
            self.assertEqual(sc["parameters"][key], value)
        self.assertEqual((sc["reclaimPolicy"], sc["allowVolumeExpansion"], sc["volumeBindingMode"]),
                         ("Retain", False, "Immediate"))
        secrets = {v for k, v in sc["parameters"].items() if k.endswith("-secret-name")}
        self.assertEqual(secrets, {"orbit-mr-csi-rbd"})

    def test_operator_resources_pin_v3_18_0_and_name_the_profile_after_the_fsid(self):
        items = {item["kind"]: item for item in render.csi(FSID)}
        self.assertEqual(items["ClientProfile"]["metadata"]["name"], FSID)
        self.assertEqual(items["ConfigMap"]["data"]["plugin"], render.ENV["CEPHCSI_IMAGE"])
        self.assertEqual(items["Driver"]["spec"]["imageSet"]["name"], items["ConfigMap"]["metadata"]["name"])
        self.assertEqual(items["Driver"]["spec"]["controllerPlugin"]["replicas"], 1)

    def test_operator_manifest_gets_exactly_one_digest(self):
        tag = render.ENV["CSI_OPERATOR_IMAGE"].split("@")[0]
        with tempfile.NamedTemporaryFile("w", suffix=".yaml") as manifest:
            manifest.write(f"kind: Deployment\n        image: {tag}\n")
            manifest.flush()
            self.assertIn(f"image: {render.ENV['CSI_OPERATOR_IMAGE']}\n", render.operator(manifest.name))
            manifest.write(f"        image: {tag}\n")
            manifest.flush()
            with self.assertRaises(SystemExit):
                render.operator(manifest.name)

    def test_lab_scripts_never_trace_commands(self):
        # A shell trace would print the CephX key on its way into the Kubernetes Secret.
        for script in [*LAB.glob("*.sh"), *LAB.glob("guest/*.sh")]:
            self.assertNotRegex(script.read_text(), r"set -[a-z]*x|bash -x", script.name)


class TwoNodeLabTest(unittest.TestCase):
    """The second VM and the link between the two (task L1), offline."""

    def test_the_link_subnet_is_clear_of_every_network_around_it(self):
        link = ipaddress.ip_network(render.ENV["LAB_LINK_NET"])
        around = {"HPC LAN": "192.168.1.0/24", "Docker default bridge and pools": "172.16.0.0/12",
                  "Docker pools": "192.168.0.0/16", "k3s Pods": "10.42.0.0/16", "k3s Services": "10.43.0.0/16",
                  "podman default": "10.88.0.0/16", "QEMU user network": "10.0.2.0/24"}
        for name, network in around.items():
            self.assertFalse(link.overlaps(ipaddress.ip_network(network)), name)
        first, second = (ipaddress.ip_address(render.ENV[key]) for key in ("LAB_LINK_IP", "LAB2_LINK_IP"))
        self.assertIn(first, link)
        self.assertIn(second, link)
        self.assertNotEqual(first, second)

    def test_names_ports_and_macs_of_the_two_vms_differ(self):
        env = render.ENV
        self.assertNotEqual(env["LAB_NAME"], env["LAB2_NAME"])
        self.assertNotEqual(env["LAB_UNIT"], env["LAB2_UNIT"])
        ports = [env[key] for key in ("LAB_SSH_PORT", "LAB2_SSH_PORT", "LAB_API_PORT", "LAB_LINK_PORT", "LAB_TEST_PG_PORT",
                                      "LAB_TEST_API_PORT", "LAB_TEST_TLS_PORT", "LAB_TEST_FAKE_MODEL_PORT")]
        self.assertEqual(len(set(ports)), len(ports))
        macs = [env[key] for key in ("LAB_USER_MAC", "LAB_LINK_MAC", "LAB2_USER_MAC", "LAB2_LINK_MAC")]
        self.assertEqual(len(set(macs)), len(macs))
        for mac in macs:
            self.assertRegex(mac, r"^52:54:00(:[0-9a-f]{2}){3}$")
        # The first VM keeps the user-network MAC its installed netplan matches (qemu's default for a first NIC).
        self.assertEqual(env["LAB_USER_MAC"], "52:54:00:12:34:56")

    def test_the_second_vm_is_the_owner_s_size(self):
        self.assertEqual((render.ENV["LAB2_VCPUS"], render.ENV["LAB2_MEMORY_MIB"]), ("2", "3072"))
        self.assertGreater(int(render.ENV["LAB2_UNIT_MEMORY_MAX"].rstrip("M")), 3072)
        self.assertTrue(render.ENV["LAB_DIR"].startswith("/mnt/data/"))

    def test_ceph_csi_reaches_the_monitor_on_the_link_and_its_controller_stays_on_the_first_vm(self):
        items = {item["kind"]: item for item in render.csi(FSID)}
        monitor = render.ENV["LAB_LINK_IP"] + ":6789"
        self.assertEqual(items["CephConnection"]["spec"]["monitors"], [monitor])
        self.assertEqual(render.storage_environment(FSID)["ceph"]["monitors"], [monitor])
        terms = items["Driver"]["spec"]["controllerPlugin"]["affinity"]["nodeAffinity"][
            "requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"]
        self.assertEqual(terms, [{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In",
                                                        "values": [render.ENV["LAB_NAME"]]}]}])
        self.assertNotIn("affinity", items["Driver"]["spec"]["nodePlugin"])  # a node plugin on every node

    def test_a_probe_pod_goes_to_the_node_it_names(self):
        pod = render.probe_pod("p", "c", "r", sleep=True, node=render.ENV["LAB2_NAME"])
        [term] = pod["spec"]["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"]
        self.assertEqual(term["matchExpressions"][0]["values"], [render.ENV["LAB2_NAME"]])
        self.assertNotIn("affinity", render.probe_pod("p", "c", "r", sleep=True)["spec"])

    def test_dhcp_goes_to_the_user_network_nic_only(self):
        config = (LAB / "cloud-init/network-config").read_text()
        self.assertEqual(set(re.findall(r"@@[A-Z_]+@@", config)), {"@@USER_MAC@@"})
        self.assertEqual(config.count("macaddress:"), 1)
        self.assertIn("dhcp4: true", config)
        self.assertEqual(sorted(set(re.findall(r"@@[A-Z_]+@@", (LAB / "cloud-init/user-data").read_text()))),
                         ["@@LAB_NAME@@", "@@LINK_IP@@", "@@SSH_PUBLIC_KEY@@"])

    def test_the_two_node_checks_load_and_read_only_the_lab_context(self):
        spec = importlib.util.spec_from_file_location("lab_two_node", LAB / "two-node.py")
        two_node = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(two_node)
        self.assertEqual(two_node.NODES, {1: render.ENV["LAB_NAME"], 2: render.ENV["LAB2_NAME"]})
        source = (LAB / "two-node.py").read_text()
        self.assertIn('"--context", ENV["LAB_NAME"]', source)
        self.assertNotIn("KUBECONFIG=", source)


class SingleWriterLabTest(unittest.TestCase):
    """lab/single-writer.py's rendered objects (T02a), offline: nothing reaches the lab."""

    def test_webhook_is_the_repository_template_filled_for_the_lab(self):
        ca = b"-----BEGIN CERTIFICATE-----\nlab\n-----END CERTIFICATE-----\n"
        config = single_writer.webhook_configuration(ca)
        hook = config["webhooks"][0]
        self.assertEqual((hook["failurePolicy"], hook["sideEffects"]), ("Fail", "None"))
        self.assertEqual(hook["clientConfig"]["url"], "https://10.0.2.2:13711/api/managed-runner/admission")
        self.assertEqual(base64.b64decode(hook["clientConfig"]["caBundle"]), ca)
        self.assertEqual(hook["namespaceSelector"], {"matchLabels": {"kubernetes.io/metadata.name": "orbit-mr-test"}})
        self.assertNotIn("objectSelector", hook)  # every Pod in the namespace, whatever its labels
        self.assertEqual(hook["rules"][0]["resources"], ["pods", "pods/ephemeralcontainers"])
        self.assertEqual(hook["rules"][0]["operations"], ["CREATE", "UPDATE"])
        self.assertNotRegex(json.dumps(config), r"__[A-Z0-9_]+__|REPLACE_ME")

    def test_the_api_server_presents_its_token_to_the_webhook_host_only(self):
        users = single_writer.webhook_kubeconfig("token")["users"]
        url = single_writer.webhook_configuration(b"ca")["webhooks"][0]["clientConfig"]["url"]
        self.assertEqual([user["name"] for user in users], [urllib.parse.urlsplit(url).netloc])
        plugin = single_writer.admission_configuration()["plugins"][0]
        self.assertEqual(plugin["name"], "ValidatingAdmissionWebhook")
        self.assertEqual(plugin["configuration"]["kubeConfigFile"], single_writer.GUEST_ADMISSION_DIR + "/webhook-kubeconfig.json")
        # Appended to k3s's own list in a drop-in: config.yaml, which provision.sh rewrites, is not touched.
        self.assertTrue(single_writer.K3S_DROP_IN.startswith("kube-apiserver-arg+:\n"))
        self.assertIn(f"admission-control-config-file={single_writer.GUEST_ADMISSION_DIR}/admission-configuration.json",
                      single_writer.K3S_DROP_IN)

    def test_profile_states_every_field_of_the_example(self):
        def paths(value, prefix=""):
            if not isinstance(value, dict):
                return {prefix}
            return set().union(*(paths(child, f"{prefix}.{key}" if prefix else key) for key, child in value.items()))
        example = json.loads((REPO / "deploy/managed-runner/manager-profile.example.json").read_text())
        image = single_writer.IMAGE_NAME + "@sha256:" + "a" * 64
        profile = single_writer.lab_profile(image, "b" * 64)
        self.assertEqual(paths(profile) - {"backend"}, paths(example))
        self.assertNotRegex(json.dumps(profile), r"REPLACE_ME|__[A-Z0-9_]+__")
        self.assertEqual(profile["valueKind"], "actual")
        self.assertEqual(profile["runner"]["image"], image)
        self.assertEqual(profile["runner"]["serverUrl"], "https://10.0.2.2:13711")
        self.assertEqual(profile["kubernetes"], {"kubeconfig": str(single_writer.MANAGER_KUBECONFIG), "context": "orbit-mr-lab-manager",
                                                 "apiServer": "https://127.0.0.1:16443", "namespace": "orbit-mr-test"})
        self.assertEqual(profile["admission"]["managerUsername"], "system:serviceaccount:orbit-mr-test:orbit-mr-manager")

    def test_manager_may_do_what_the_kubernetes_backend_calls_and_nothing_else(self):
        granted = {}
        for item in single_writer.manager_objects():
            for rule in item.get("rules", []):
                for resource in rule["resources"]:
                    granted[resource] = sorted(rule["verbs"])
        self.assertEqual(granted, {"pods": ["create", "delete", "get", "patch"], "persistentvolumeclaims": ["create", "get"],
                                   "secrets": ["create", "delete", "get"], "configmaps": ["get"],
                                   "persistentvolumes": ["get"], "volumeattachments": ["list"]})

    def test_payload_writes_under_the_runner_home(self):
        source = single_writer.payload_source()
        self.assertIn("Path('/var/lib/orbit/home/storage-verification')", source)
        self.assertNotIn('Path("/var/lib/orbit/storage-verification")', source)


class SwitchLabTest(unittest.TestCase):
    """lab/switch-lab.py (T08b), offline: the claim the runbook restores into carries the marks of the manager's own."""

    def test_the_restored_claim_is_the_repository_template_under_the_runner_s_name(self):
        spec = importlib.util.spec_from_file_location("lab_switch", LAB / "switch-lab.py")
        switch_lab = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(switch_lab)
        runner, owner = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "0199a1b2-0000-7000-8000-000000000001"
        values = {"storage.pvcName": f"mr-data-{runner}", "kubernetes.namespace": "orbit-mr-test", "storage.ownerID": owner,
                  "storage.runnerID": runner, "storage.className": "runner-data", "storage.capacity": "2Gi"}
        template = (REPO / "deploy/managed-runner/storage/pvc.template.json").read_text()
        rendered = json.loads(re.sub(r"\$\{([^}]+)\}", lambda match: values[match.group(1)], template))
        self.assertEqual(switch_lab.restore_claim_manifest("orbit-mr-test", f"mr-data-{runner}", owner, runner, "runner-data", "2Gi"), rendered)


class TakeoverLabTest(unittest.TestCase):
    """lab/takeover-lab.py (T02), offline: the fencing receipt it writes and the second Pods it tries on the other node."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("lab_takeover", LAB / "takeover-lab.py")
        cls.takeover = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.takeover)

    def test_the_receipt_has_every_field_of_the_repository_example_and_is_bound_to_the_mapping(self):
        def paths(value, prefix=""):
            found = set()
            for key, item in value.items():
                found.add(prefix + key)
                if isinstance(item, dict):
                    found |= paths(item, prefix + key + ".")
            return found
        example = json.loads((REPO / "deploy/managed-runner/fencing-receipt.example.json").read_text())
        mapping = {"runner_id": "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "generation": 3, "pod_name": "mr-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
                   "pod_uid": "pod-uid", "node_name": render.ENV["LAB2_NAME"], "pvc_uid": "pvc-uid", "volume_handle": "handle"}
        receipt = self.takeover.fencing_receipt(mapping, {"pool": "orbit-mr-rbd", "rbdImage": "csi-vol-1"}, "node-uid", "2026-10-19T12:00:00.000Z",
                                                {"at": "2026-10-19T12:00:30+00:00", "activeState": "inactive"}, "2026-10-19T12:01:00+00:00")
        self.assertEqual(paths(receipt), paths(example))
        self.assertEqual((receipt["method"], receipt["verification"]["result"], receipt["nodePowerOff"]["mechanism"]),
                         ("NODE_POWER_OFF", "POWERED_OFF", "HYPERVISOR"))
        self.assertIs(receipt["nodePowerOff"]["quarantined"], True)
        self.assertEqual(receipt["predecessor"], {"runnerId": mapping["runner_id"], "generation": 3, "podName": mapping["pod_name"], "podUid": "pod-uid",
                                                  "nodeName": render.ENV["LAB2_NAME"], "nodeUid": "node-uid", "pvcUid": "pvc-uid",
                                                  "volumeHandle": "handle", "rbdImage": {"pool": "orbit-mr-rbd", "image": "csi-vol-1"}})
        self.assertLessEqual(receipt["action"]["performedAt"].replace("Z", "+00:00"), receipt["verification"]["observedAt"])

    def test_a_contender_is_pinned_to_the_other_node_and_keeps_the_authorized_pod_s_shape(self):
        authorized = {"metadata": {"name": "mr-x", "labels": {"app": "runner"}, "annotations": {"orbit.dev/generation": "2"}, "finalizers": ["f"]},
                      "spec": {"nodeName": render.ENV["LAB2_NAME"], "priority": 0, "containers": [{"name": "runner"}],
                               "volumes": [{"name": "user-state", "persistentVolumeClaim": {"claimName": "mr-data-x"}}]}}
        copy = self.takeover.contender("t02-second-copy", authorized, render.ENV["LAB_NAME"], "mr-data-x", labelled=True)
        self.assertEqual(copy["spec"]["nodeName"], render.ENV["LAB_NAME"])
        self.assertNotIn("priority", copy["spec"])
        self.assertEqual(copy["metadata"], {"name": "t02-second-copy", "namespace": render.ENV["LAB_NAMESPACE"], "labels": {"app": "runner"},
                                            "annotations": {"orbit.dev/generation": "2"}})
        self.assertEqual(authorized["spec"]["nodeName"], render.ENV["LAB2_NAME"])
        plain = self.takeover.contender("t02-second-admin", None, render.ENV["LAB_NAME"], "mr-data-x")
        self.assertEqual((plain["spec"]["nodeName"], plain["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"]), (render.ENV["LAB_NAME"], "mr-data-x"))

    def test_it_reads_only_the_lab_context_and_its_own_server_directory(self):
        source = (LAB / "takeover-lab.py").read_text()
        self.assertNotIn("KUBECONFIG=", source)
        self.assertEqual(self.takeover.OWN_SERVER_DIRS, ("test-server-t02", "test-server-t02-dev"))
        self.assertEqual(self.takeover.NODES, {1: render.ENV["LAB_NAME"], 2: render.ENV["LAB2_NAME"]})


class CrossNodeLabTest(unittest.TestCase):
    """lab/cross-node-lab.py (T08x), offline: its own names over takeover-lab.py's, and the runbook commands it runs."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("lab_cross_node", LAB / "cross-node-lab.py")
        cls.cross = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.cross)

    def test_it_reads_only_the_lab_context_and_its_own_server_directory_and_names(self):
        source = (LAB / "cross-node-lab.py").read_text()
        # The runbook's own variable ADMIN_KUBECONFIG names the lab's kubeconfig; KUBECONFIG itself is never set.
        self.assertIsNone(re.search(r"(?<!ADMIN_)KUBECONFIG=", source))
        self.assertEqual(self.cross.OWN_SERVER_DIRS, ("test-server-t08x", "test-server-t08x-dev"))
        self.assertEqual(self.cross.NODES, {1: render.ENV["LAB_NAME"], 2: render.ENV["LAB2_NAME"]})
        # takeover-lab.py's own names (T02's accounts, probe, writer, context) are this task's in the helpers it shares.
        self.assertEqual((self.cross.wl.EMAIL, self.cross.ml.EMAIL), ("t08x-{}@lab.invalid", "t08x-{}@lab.invalid"))
        self.assertEqual(self.cross.wl.name_of("t08x-bob@lab.invalid"), "bob")
        self.assertEqual((self.cross.wl.PROBE_ROOT, self.cross.tl.WRITER_RUN), ("/var/lib/orbit/home/t08x-probe", "t08x-writer"))
        self.assertEqual(self.cross.al.CONTEXT.name, "t08x-context.json")
        self.assertIn("test-server-t08x", self.cross.al.OWN_SERVER_DIRS)

    def test_the_runbook_blocks_it_runs_are_the_runbook_s(self):
        query = self.cross.runbook_block("Find an account's runner", "from managed_runner m", "sql")
        self.assertIn("m.node_name", query)
        find = self.cross.find_runner_block()
        self.assertIn('$K get pod "mr-$R"', find)
        self.assertFalse([line for line in find.splitlines() if line.startswith(("R=", "rbd "))])
        self.assertIn("managed-runner-stop-report", self.cross.runbook_block("The stop-report finalizer", "UID_="))
        with self.assertRaises(self.cross.Failed):
            self.cross.runbook_block("The stop-report finalizer", "no such command")

    @unittest.skipUnless(__import__("shutil").which("jq"), "the runbook's finalizer patch uses jq")
    def test_the_runbook_s_finalizer_patch_tests_the_uid_and_the_finalizer(self):
        pod = {"metadata": {"uid": "uid-1", "finalizers": ["other.example/x", "orbit.dev/managed-runner-stop-report"]}}
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "bin").mkdir()
            kubectl = Path(folder) / "bin/kubectl"
            # A stand-in that records each call's arguments and answers the two reads the block makes.
            kubectl.write_text("#!/usr/bin/env python3\nimport json, pathlib, sys\nhere = pathlib.Path(sys.argv[0]).parent\n"
                               "with open(here / 'calls', 'a') as calls:\n    calls.write(json.dumps(sys.argv[1:]) + '\\n')\n"
                               "if any(a.startswith('jsonpath=') for a in sys.argv):\n    print('uid-1', end='')\n"
                               "elif sys.argv[-2:] == ['-o', 'json']:\n    print((here / 'pod.json').read_text())\n")
            kubectl.chmod(0o755)
            (Path(folder) / "bin/pod.json").write_text(json.dumps(pod))
            saved = self.cross.LAB_DIR
            self.cross.LAB_DIR = Path(folder)
            try:
                result = self.cross.runbook_bash("finalizer", self.cross.runbook_block("The stop-report finalizer", "UID_="), R="r1")
            finally:
                self.cross.LAB_DIR = saved
            calls = [json.loads(line) for line in (Path(folder) / "bin/calls").read_text().splitlines()]
        self.assertEqual(result["exit"], 0, result["stderr"])
        patch = calls[-1]
        self.assertEqual(patch[:-1], ["--kubeconfig", f"{folder}/kubeconfig.json", "--context", render.ENV["LAB_NAME"], "--namespace",
                                      render.ENV["LAB_NAMESPACE"], "patch", "pod", "mr-r1", "--type=json", "-p"])
        self.assertEqual(json.loads(patch[-1]),
                         [{"op": "test", "path": "/metadata/uid", "value": "uid-1"},
                          {"op": "test", "path": "/metadata/finalizers/1", "value": "orbit.dev/managed-runner-stop-report"},
                          {"op": "remove", "path": "/metadata/finalizers/1"}])

    def test_what_a_power_cut_left_of_the_last_seconds_is_classified(self):
        before = {"a": {"bytes": 10, "sha256": "x"}, "b": {"bytes": 10, "sha256": "y"}, "c": {"bytes": 10, "sha256": "z"}, "d": {"bytes": 10, "sha256": "w"}}
        after = {"a": {"bytes": 10, "sha256": "x"}, "b": {"bytes": 0, "sha256": "e"}, "c": {"error": "FileNotFoundError"}, "d": {"bytes": 12, "sha256": "v"}}
        self.assertEqual({path: found["result"] for path, found in self.cross.lost_since(before, after).items()},
                         {"a": "kept", "b": "shorter", "c": "missing", "d": "changed"})


class DurabilityLabTest(unittest.TestCase):
    """lab/durability-lab.py (T02c), offline: its own names, and how it reads and judges what a power cut left of a volume."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("lab_durability", LAB / "durability-lab.py")
        cls.durability = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.durability)

    def test_it_reads_only_the_lab_context_and_its_own_server_directory_and_names(self):
        source = (LAB / "durability-lab.py").read_text()
        self.assertIsNone(re.search(r"(?<!ADMIN_)KUBECONFIG=", source))
        self.assertEqual(self.durability.OWN_SERVER_DIRS, ("test-server-t02c", "test-server-t02c-dev"))
        self.assertEqual((self.durability.wl.EMAIL, self.durability.ml.EMAIL), ("t02c-{}@lab.invalid", "t02c-{}@lab.invalid"))
        self.assertEqual(self.durability.wl.name_of("t02c-bob@lab.invalid"), "bob")
        self.assertEqual(self.durability.al.CONTEXT.name, "t02c-context.json")
        self.assertEqual(self.durability.RUNS, {"before": "ann", "after": "bob"})
        self.assertTrue(self.durability.marker("ann", "LAST").startswith("T02C-"))

    def volume(self, folder):
        """A managed runner's volume in miniature, as a power cut would find it: the workspace repository, a session's
        worktree with the engine's commit, and its transcript with the last turn."""
        import subprocess
        root = Path(folder)
        env = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x", "PATH": "/usr/bin:/bin"}
        git = lambda d, *a: subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True, env=env).stdout.strip()
        workspace = root / "home/orbit-repos/default"
        workspace.mkdir(parents=True)
        git(workspace, "init", "-q", "-b", "master")
        git(workspace, "commit", "-q", "--allow-empty", "-m", "orbit: baseline")
        worktree = root / "home/.orbit/worktrees/s1"
        git(workspace, "worktree", "add", "-q", "-b", "orbit/s1", str(worktree))
        (worktree / "t08-annlast.txt").write_text("T08 annlast\n")
        git(worktree, "add", "t08-annlast.txt")
        git(worktree, "commit", "-q", "-m", "T08 annlast")
        transcript = root / "home/.claude/projects/p/11111111-2222-4333-8444-555555555555.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text('{"user": "T02C-ANN-S1 first"}\n{"user": "T02C-ANN-LAST last T03-SECRET annlast"}\n'
                              '{"assistant": "FAKE MODEL reply #3: tool result received: T08-WROTE-ANNLAST abc"}\n')
        return workspace, worktree, git(worktree, "rev-parse", "HEAD")

    def read(self, folder, commit):
        import os
        import subprocess
        import sys
        want = {"sessions": ["s1"], "commits": [{"label": "s1 last engine commit (returned: the turn ended)", "sha": commit, "repo": "s1", "ref": "HEAD"}],
                "markers": ["T02C-ANN-S1", "T02C-ANN-LAST", "tool result received: T08-WROTE-ANNLAST"]}
        result = subprocess.run([sys.executable, "-c", self.durability.READ, json.dumps(want)], capture_output=True, text=True,
                                env={**os.environ, "T02C_VOLUME_ROOT": folder})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_an_intact_volume_passes_every_check_of_the_run_after_the_fix(self):
        with tempfile.TemporaryDirectory() as folder:
            _, _, commit = self.volume(folder)
            view = self.read(folder, commit)
        step = self.durability.Step()
        summary = self.durability.judge_left(step, "after", "ann", view, "11111111-2222-4333-8444-555555555555")
        self.assertTrue(all(c["ok"] for c in step.checks), [c for c in step.checks if not c["ok"]])
        self.assertEqual((summary["unreadable"], summary["fsckErrors"], summary["returnedCommitsMissing"]), ([], [], []))
        self.assertEqual(summary["lastTurnInTheTranscript"], {"message": 1, "answer": 1})
        self.assertEqual(view["commits"]["s1 last engine commit (returned: the turn ended)"]["object"], "commit")

    def test_what_t02_found_is_damage_before_and_a_failure_after(self):
        with tempfile.TemporaryDirectory() as folder:
            workspace, worktree, commit = self.volume(folder)
            # What T02's cut left: an empty HEAD, an empty branch, an empty object, and the transcript without the answer.
            (workspace / ".git/HEAD").write_text("")
            (workspace / ".git/refs/heads/orbit/s1").write_text("")
            obj = workspace / ".git/objects" / commit[:2] / commit[2:]
            obj.chmod(0o644)
            obj.write_bytes(b"")
            transcript = Path(folder) / "home/.claude/projects/p/11111111-2222-4333-8444-555555555555.jsonl"
            transcript.write_text("\n".join(transcript.read_text().splitlines()[:2]) + "\n")
            view = self.read(folder, commit)
        before, after = self.durability.Step(), self.durability.Step()
        summary = self.durability.judge_left(before, "before", "ann", view, "11111111-2222-4333-8444-555555555555")
        self.assertTrue(all(c["ok"] for c in before.checks), before.checks)
        self.assertEqual(summary["unreadable"], ["s1", "workspace"])
        self.assertEqual(summary["lastTurnInTheTranscript"], {"message": 1, "answer": 0})
        self.assertIn("HEAD", summary["emptyGitFiles"]["workspace"])
        self.durability.judge_left(after, "after", "ann", view, "11111111-2222-4333-8444-555555555555")
        self.assertEqual(sorted(c["check"].split(": ", 1)[1] for c in after.checks if not c["ok"]),
                         ["every commit that had returned is there, on its branch", "every repository reads: HEAD and its branch valid",
                          "git fsck finds no error in any of them", "the last turn, its message and its final answer, is in the engine's transcript"])


class ApiGateTest(unittest.TestCase):
    """lab/api-gate.py (T04) on loopback sockets: a stand-in upstream answers every chunk it receives."""

    def test_lose_answer_takes_one_large_request_and_the_reads_after_it_then_passes(self):
        def record(kind, length):
            return bytes([kind, 3, 3]) + length.to_bytes(2, "big") + b"x" * length

        async def scenario(state_dir):
            async def answer(reader, writer):
                while await reader.read(65536):
                    writer.write(b"ANSWER")
                    await writer.drain()
                writer.close()
            upstream = await asyncio.start_server(answer, "127.0.0.1", 0)
            gate = api_gate.Gate(upstream.sockets[0].getsockname()[1], state_dir)
            front = await asyncio.start_server(gate.handle, "127.0.0.1", 0)
            port = front.sockets[0].getsockname()[1]

            async def ask(*records):
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                for item in records:
                    writer.write(item)
                await writer.drain()
                try:
                    got = await asyncio.wait_for(reader.read(100), 3)
                except (ConnectionError, asyncio.TimeoutError):
                    got = b""
                writer.close()
                return got

            api_gate.write_control(state_dir, {"mode": "lose-answer", "minBytes": 1000, "skip": 1, "then": 1})
            seen = [
                await ask(record(22, 300), record(23, 60)),   # a handshake and a small request: answered
                await ask(record(23, 1500)),                  # the first large one is skipped
                await ask(record(23, 1500)),                  # the next loses its answer
                await ask(record(23, 53), record(23, 600)),   # and so does the read after it, whatever its size
                await ask(record(23, 53), record(23, 600)),   # then it passes again
            ]
            log = Path(state_dir, api_gate.LOG)
            for _ in range(100):  # each connection's line is written once both its sides have closed
                if log.exists() and len(log.read_text().splitlines()) == len(seen):
                    break
                await asyncio.sleep(0.05)
            front.close()
            upstream.close()
            return seen

        with tempfile.TemporaryDirectory() as state_dir:
            seen = asyncio.run(scenario(state_dir))
            self.assertEqual(seen, [b"ANSWER", b"ANSWER", b"", b"", b"ANSWER"])
            self.assertEqual(api_gate.read_control(state_dir)["mode"], "pass")
            log = [json.loads(line) for line in Path(state_dir, api_gate.LOG).read_text().splitlines()]
            self.assertEqual([entry["lost"] for entry in log], [False, False, "record of 1500 bytes", "follower", False])
            self.assertEqual([entry["end"] for entry in log][2:4], ["answer lost", "answer lost"])


class FakeModelTest(unittest.TestCase):
    """lab/fake-model.py (T03, T06) on a loopback port: its triggers, in the request shape Claude Code 2.1.300 sends,
    whose every request ends with a `system` message."""

    SYSTEM = {"role": "system", "content": [{"type": "text", "text": "a reminder"}]}

    def setUp(self):
        import socket
        import subprocess
        import sys
        import time
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.log = tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False).name
        self.server = subprocess.Popen([sys.executable, "-I", str(LAB / "fake-model.py"), str(self.port), self.log])
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.05)

    def tearDown(self):
        self.server.terminate()
        self.server.wait(10)
        Path(self.log).unlink()

    def ask(self, messages, stream=True):
        import urllib.request
        body = {"model": "m", "stream": stream, "messages": messages + [self.SYSTEM],
                "tools": [{"name": "mcp__orbit__bg_run"}, {"name": "mcp__orbit__schedule_wakeup"}]}
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/anthropic/v1/messages?beta=true",
                                         data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        text = urllib.request.urlopen(request, timeout=10).read().decode()
        if not stream:
            return json.loads(text)["content"]
        blocks, partial = [], {}
        for line in text.splitlines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            if event["type"] == "content_block_start":
                blocks.append(dict(event["content_block"]))
            elif event["type"] == "content_block_delta" and event["delta"]["type"] == "input_json_delta":
                partial[len(blocks) - 1] = partial.get(len(blocks) - 1, "") + event["delta"]["partial_json"]
            elif event["type"] == "content_block_delta":
                blocks[-1]["text"] = blocks[-1].get("text", "") + event["delta"]["text"]
        for index, raw in partial.items():
            blocks[index]["input"] = json.loads(raw)
        return blocks

    @staticmethod
    def user(text):
        return {"role": "user", "content": [{"type": "text", "text": text}]}

    def test_an_answer_quotes_the_markers_of_the_last_message(self):
        [answer] = self.ask([self.user("T02-ANN-MOVE T08-ANN-S1 a message, T05-NOT-A-MARKER")])
        self.assertEqual(answer["type"], "text")
        self.assertTrue(answer["text"].endswith("Answering: T02-ANN-MOVE T08-ANN-S1"), answer["text"])

    def test_t08x_markers_are_quoted_too(self):
        [answer] = self.ask([self.user("T08X-BOB-LAST a message, T08Y-NOT-A-MARKER")])
        self.assertTrue(answer["text"].endswith("Answering: T08X-BOB-LAST"), answer["text"])

    def test_t02c_markers_are_quoted_too(self):
        [answer] = self.ask([self.user("T02C-ANN-LAST a message, T02D-NOT-A-MARKER")])
        self.assertTrue(answer["text"].endswith("Answering: T02C-ANN-LAST"), answer["text"])

    def test_a_held_turn_answers_its_tool_result_only_after_the_hold(self):
        import time
        first = self.user("T02C-ANN-HOLD FAKE-WRITE held FAKE-HOLD 2")
        [call] = self.ask([first])
        self.assertEqual((call["type"], call["name"]), ("tool_use", "Bash"))
        self.assertIn("git commit -q -m 'T08 held'", call["input"]["command"])
        called = {"role": "assistant", "content": [{"type": "tool_use", "id": call["id"], "name": call["name"], "input": call["input"]}]}
        result = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"],
                                               "content": [{"type": "text", "text": "T08-WROTE-HELD abc 123"}]}]}
        started = time.monotonic()
        [answer] = self.ask([first, called, result])
        self.assertGreaterEqual(time.monotonic() - started, 2)
        self.assertIn("tool result received: T08-WROTE-HELD", answer["text"])
        logged = [json.loads(line) for line in Path(self.log).read_text().splitlines()]
        self.assertEqual([(entry["kind"], entry["hold"]) for entry in logged], [("tool_use", 0), ("tool_result_reply", 2)])

    def test_a_background_job_is_one_bg_run_call_and_its_result_is_answered(self):
        first = self.user("T06-X FAKE-BG 7 start a job")
        [call] = self.ask([first])
        self.assertEqual((call["type"], call["name"]), ("tool_use", "mcp__orbit__bg_run"))
        self.assertEqual(call["input"], {"command": "sleep 7", "kind": "job", "wakeOnExit": True})
        called = {"role": "assistant", "content": [{"type": "tool_use", "id": call["id"], "name": call["name"], "input": call["input"]}]}
        result = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"],
                                               "content": [{"type": "text", "text": "Started job bgj_1"}]}]}
        [answer] = self.ask([first, called, result])
        self.assertEqual(answer["type"], "text")
        self.assertIn("tool result received: Started job bgj_1", answer["text"])
        # The trigger again in the same conversation (a later turn): no second job.
        [again] = self.ask([first, called, result, {"role": "assistant", "content": [answer]}, first])
        self.assertEqual(again["type"], "text")
        self.assertIn("Answering: T06-X", again["text"])

    def test_a_wakeup_is_a_schedule_wakeup_call_with_its_own_marker(self):
        [call] = self.ask([self.user("FAKE-WAKEUP 240 amy1 later")], stream=False)
        self.assertEqual(call["name"], "mcp__orbit__schedule_wakeup")
        self.assertEqual(call["input"]["delaySeconds"], 240)
        self.assertTrue(call["input"]["prompt"].startswith("T06-WOKE-AMY1: "))

    def test_a_tool_loop_edits_commits_and_builds_then_leaves_an_edit_for_the_runner(self):
        import subprocess
        import time
        prompt = self.user("D10-AMY-T1 a turn of work. FAKE-LOOP 2 30 200 amyt1")
        messages, calls = [prompt], []
        with tempfile.TemporaryDirectory() as checkout:
            subprocess.run(["git", "init", "-q", checkout], check=True)
            for name, value in (("user.name", "D10"), ("user.email", "d10@lab.invalid")):
                subprocess.run(["git", "-C", checkout, "config", name, value], check=True)
            while True:
                started = time.monotonic()
                [answer] = self.ask(messages)
                self.assertGreaterEqual(time.monotonic() - started, 0.2)  # the think time
                if answer["type"] == "text":
                    break
                calls.append(answer["input"]["description"])
                ran = subprocess.run(["bash", "-c", answer["input"]["command"]], cwd=checkout, capture_output=True, text=True)
                self.assertEqual(ran.returncode, 0, ran.stderr)
                messages += [{"role": "assistant", "content": [answer]},
                             {"role": "user", "content": [{"type": "tool_result", "tool_use_id": answer["id"],
                                                           "content": [{"type": "text", "text": ran.stdout}]}]}]
            self.assertEqual(calls, ["D10 amyt1 edit 0", "D10 amyt1 commit 0", "D10 amyt1 build 0",
                                     "D10 amyt1 edit 1", "D10 amyt1 commit 1", "D10 amyt1 build 1", "D10 amyt1 edit 2"])
            self.assertTrue(answer["text"].endswith("loop amyt1 done after 7 tool calls. Answering: D10-AMY-T1"), answer["text"])
            log = subprocess.run(["git", "-C", checkout, "log", "--format=%s"], capture_output=True, text=True).stdout.split("\n")
            self.assertEqual(log[:2], ["D10 amyt1 1", "D10 amyt1 0"])
            # The build's 30 files, ignored by Git; the last edit is the runner's to commit.
            self.assertEqual(len(list(Path(checkout, "build/obj").iterdir())), 30)
            status = subprocess.run(["git", "-C", checkout, "status", "--porcelain"], capture_output=True, text=True).stdout
            self.assertEqual(status.split(), ["M", "src/log-amyt1.txt", "M", "src/version.txt"])
        results = [m["content"][0]["content"][0]["text"] for m in messages if m["role"] == "user" and m is not prompt]
        self.assertRegex(results[1], r"^D10-COMMIT amyt1 0 rc=0 us=\d+$")
        self.assertRegex(results[2], r"^D10-BUILD amyt1 0 files=30 rc=0 us=\d+$")
        logged = [json.loads(line) for line in Path(self.log).read_text().splitlines()]
        self.assertEqual([entry["kind"] for entry in logged], ["loop_tool_use"] * 7 + ["loop_done"])
        self.assertEqual([entry["loop"]["made"] for entry in logged], list(range(8)))
        # The next turn of the same session is not a loop.
        [next_answer] = self.ask(messages + [{"role": "assistant", "content": [answer]}, self.user("D10-AMY-T2 hello")])
        self.assertTrue(next_answer["text"].endswith("Answering: D10-AMY-T2"), next_answer["text"])

    def test_an_overloaded_provider_fails_the_first_n_requests_then_answers(self):
        message = [self.user("T06-RT FAKE-APIERR 2 rt1 a question")]
        texts = [self.ask(message)[0]["text"] for _ in range(3)]
        for text in texts[:2]:
            # What the control plane reads as a retryable failure (@orbit/shared isRetryableApiErrorText).
            self.assertRegex(text, r"^API Error: 529 \{")
        self.assertIn("Answering: T06-RT", texts[2])
        kinds = [json.loads(line)["kind"] for line in Path(self.log).read_text().splitlines()]
        self.assertEqual(kinds, ["api_error", "api_error", "text"])


if __name__ == "__main__":
    unittest.main()
