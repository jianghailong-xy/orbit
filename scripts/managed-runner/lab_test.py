#!/usr/bin/env python3
"""The single-machine lab's pins and rendered objects (lab/lab.env, lab/render.py), offline."""

import base64
import importlib.util
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
        self.assertEqual(granted, {"pods": ["create", "delete", "get"], "persistentvolumeclaims": ["create", "get"],
                                   "secrets": ["create", "delete", "get"], "configmaps": ["get"],
                                   "persistentvolumes": ["get"], "volumeattachments": ["list"]})

    def test_payload_writes_under_the_runner_home(self):
        source = single_writer.payload_source()
        self.assertIn("Path('/var/lib/orbit/home/storage-verification')", source)
        self.assertNotIn('Path("/var/lib/orbit/storage-verification")', source)


if __name__ == "__main__":
    unittest.main()
