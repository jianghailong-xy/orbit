#!/usr/bin/env python3
"""deploy/managed-runner/prepull-runner-image.sh against a fake `k3s` first on PATH.

What the script decides and what it asks the node's crictl: it refuses anything but a runner image by digest, leaves
an image the node has already as it is, pulls one it lacks and checks that the node then finds it by that reference,
and fails when the pull does. The pull from the real registry is exercised on the node by the release (.claude/skills/
release/SKILL.md, "Orbit Cloud runner image"), not here.
"""

import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy/managed-runner/prepull-runner-image.sh"
REF = "10.66.0.1:5000/orbit-cloud-runner@sha256:" + "ab" * 32

# The fake node: an image is there while its file exists; a pull makes it unless FAKE_PULL_FAILS is set.
FAKE_K3S = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_STATE/log"
[ "$1" = crictl ] || exit 99
key="$(printf '%s' "$3" | tr '/:@' '___')"
case "$2" in
  inspecti) [ -e "$FAKE_STATE/image-$key" ] ;;
  pull)
    [ -z "${FAKE_PULL_FAILS:-}" ] || { echo "pull failed" >&2; exit 1; }
    : >"$FAKE_STATE/image-$key"
    echo "Image is up to date for $3" ;;
  *) exit 98 ;;
esac
"""


class PrepullRunnerImage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.bin = root / "bin"
        self.state = root / "state"
        self.bin.mkdir()
        self.state.mkdir()
        fake = self.bin / "k3s"
        fake.write_text(FAKE_K3S)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args, **env):
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            env={"PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_STATE": str(self.state), **env},
            capture_output=True, text=True,
        )

    def log(self):
        path = self.state / "log"
        return path.read_text().splitlines() if path.exists() else []

    def test_pulls_an_image_the_node_lacks_and_finds_it_after(self):
        result = self.run_script(REF)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log(), [f"crictl inspecti {REF}", f"crictl pull {REF}", f"crictl inspecti {REF}"])
        self.assertIn("is on this node (pulled in", result.stdout)

    def test_leaves_an_image_the_node_has(self):
        self.assertEqual(self.run_script(REF).returncode, 0)
        (self.state / "log").unlink()
        result = self.run_script(REF)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log(), [f"crictl inspecti {REF}"])
        self.assertIn("already; nothing was pulled", result.stdout)

    def test_a_failed_pull_fails_and_names_the_registry_mirror(self):
        result = self.run_script(REF, FAKE_PULL_FAILS="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("registries.yaml", result.stderr)

    def test_refuses_anything_but_a_runner_image_by_digest(self):
        for bad in ["", "10.66.0.1:5000/orbit-cloud-runner:0.1.261-beta.97", "10.66.0.1:5000/orbit-apiserver@sha256:" + "ab" * 32,
                    "orbit-cloud-runner@sha256:abc"]:
            with self.subTest(ref=bad):
                result = self.run_script(bad)
                self.assertEqual(result.returncode, 2, result.stdout)
        self.assertEqual(self.run_script(REF, REF).returncode, 2, "one image at a time")
        self.assertEqual(self.log(), [], "nothing is asked of the node")


if __name__ == "__main__":
    unittest.main()
