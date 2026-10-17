#!/usr/bin/env python3
"""The single-machine lab's pins and rendered objects (lab/lab.env, lab/render.py), offline."""

import importlib.util
from pathlib import Path
import re
import tempfile
import unittest

LAB = Path(__file__).resolve().parent / "lab"
spec = importlib.util.spec_from_file_location("lab_render", LAB / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
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


if __name__ == "__main__":
    unittest.main()
