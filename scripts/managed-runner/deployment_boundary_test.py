#!/usr/bin/env python3
"""The default entry points may wire the Docker backend in, and nothing of Kubernetes, Rook, Ceph or CSI.

docs/managed-runner-design.md, "Optional test deployment boundary", as the account owner revised it on
2026-10-17 for new deployments ("Implementation record: new deployments"): root Compose, .env.example and
the install path may reference what the Docker backend needs — the restricted Docker channel
(deploy/managed-runner/docker-channel), the managed runner image (deploy/managed-runner/image), the switch
and the managed runners' directory — with its services in a Compose profile a fresh install switches on.
Since the account owner's decision of 2026-10-19 that is also the managed runners' host firewall
(deploy/managed-runner/firewall), under a profile of its own that a fresh install switches on too.
They still reference no other part of deploy/managed-runner (the Kubernetes Pod, storage and admission
templates, the Kubernetes profile), no scripts/managed-runner tooling, the single-machine lab
(docs/managed-runner-lab.md) or Kubernetes, Rook, Ceph or CSI at all. And /upgrade never writes the switch:
a deployment keeps managed runners as its own .env has them, and never starts the firewall: its rules stay as
an install left them.

This reads the tracked files of those entry points with `git grep`; nothing is built, started or sent
anywhere. What the install and /upgrade scripts do is new_deployment_test.py's.
"""

from pathlib import Path
import re
import shutil
import subprocess
import unittest

REPO = Path(__file__).resolve().parents[2]

# The default entry points: what an operator or a release runs without asking for anything optional.
ENTRY_POINTS = [
    "docker-compose*.yml",
    ".env.example",
    "package.json",
    ".github/",
    ".agents/skills/",
    ".claude/skills/",
    "src/web/public/install.sh",
    "gateway/",
    "src/apiserver/Dockerfile*",
    "src/web/Dockerfile*",
    "scripts/*.sh",
    "scripts/*.mjs",
    "scripts/ci/",
    "scripts/lib/",
]
# Git's `*` also crosses `/`, so `scripts/*.sh` takes in the optional delivery's own scripts, which
# are not entry points: they may name its paths and the single-machine lab.
EXCLUDED = [":(exclude)scripts/managed-runner/"]
# The parts of deploy/managed-runner the Docker backend is made of, which an entry point may name.
DOCKER_BACKEND_PARTS = {"docker-channel", "image", "firewall"}
# What would wire the rest in: the delivery's tooling and lab, and the admission webhook.
NEEDLES = [
    "scripts/managed-runner",
    "pod-admission-webhook",
    "managed-runner-lab",
]
# Kubernetes, Rook, Ceph and CSI by name, as whole words and in any case.
WORDS = ["kubernetes", "kube", "kubectl", "kubeconfig", "k3s", "helm", "rook", "ceph", "csi", "storageclass",
         "persistentvolumeclaim"]
SWITCH = "ORBIT_MANAGED_RUNNERS_ENABLED"
UPGRADE = [".claude/skills/upgrade/", ".agents/skills/upgrade/"]


class DeploymentBoundaryTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("git") or not (REPO / ".git").exists():
            self.skipTest("needs the git checkout to read its tracked entry points")

    def git_grep(self, *pattern, paths=None):
        result = subprocess.run(
            ["git", "-C", str(REPO), "grep", "-n", *pattern, "--", *(paths or [*ENTRY_POINTS, *EXCLUDED])],
            capture_output=True, text=True, check=False)
        # 1: nothing found. Anything else but 0 is git failing, which must not read as clean.
        self.assertIn(result.returncode, (0, 1), result.stderr)
        return result.stdout.splitlines()

    def test_default_entry_points_do_not_reference_the_kubernetes_delivery(self):
        for needle in NEEDLES:
            with self.subTest(needle=needle):
                self.assertEqual(self.git_grep("-F", needle), [], f"{needle} reached a default entry point")
        for word in WORDS:
            with self.subTest(word=word):
                self.assertEqual(self.git_grep("-i", "-w", "-F", word), [], f"{word} reached a default entry point")

    def test_only_the_docker_backend_of_deploy_managed_runner_is_referenced(self):
        found = self.git_grep("-F", "deploy/managed-runner")
        self.assertNotEqual(found, [], "root Compose builds the Docker channel from deploy/managed-runner")
        for line in found:
            for match in re.finditer(r"deploy/managed-runner(?:/([\w.-]+))?", line):
                with self.subTest(line=line):
                    self.assertIn(match.group(1), DOCKER_BACKEND_PARTS,
                                  f"a default entry point names a part of deploy/managed-runner other than the Docker backend: {line}")

    def test_upgrade_never_writes_the_switch(self):
        # Neither copy of /upgrade names the switch, its directory or its profile, or writes .env at all.
        for needle in (SWITCH, "ORBIT_MANAGED_RUNNERS_DIR", "COMPOSE_PROFILES"):
            with self.subTest(needle=needle):
                self.assertEqual(self.git_grep("-F", needle, paths=UPGRADE), [], f"/upgrade names {needle}")
        self.assertEqual(self.git_grep("-E", r"(>>?|tee( -a)?|sed -i.*) *\.?/?\.env\b", paths=UPGRADE), [],
                         "/upgrade writes .env")

    def test_upgrade_never_starts_the_firewall(self):
        # Where an upgrade names the firewall's service at all, it is to leave it out: in a comment, or in the
        # exclusion from the one recreate that would otherwise take every service Compose lists.
        named = self.git_grep("-F", "managed-runner-firewall", paths=UPGRADE)
        for line in named:
            with self.subTest(line=line):
                text = line.split(":", 2)[2].strip()
                self.assertTrue(text.startswith("#") or "grep -vxE 'docker-channel|managed-runner-firewall'" in text, line)
        self.assertEqual(self.git_grep("-F", "deploy/managed-runner/firewall", paths=UPGRADE), [])

    def test_copying_env_example_alone_switches_nothing_on(self):
        # The switch is written by the install script, not carried by the example: a .env copied by hand is
        # a deliberate choice, and the example's lines only document what the install writes.
        live = [line for line in (REPO / ".env.example").read_text().splitlines()
                if re.match(rf"\s*({SWITCH}|ORBIT_MANAGED_RUNNERS_DIR|COMPOSE_PROFILES)\s*=", line)]
        self.assertEqual(live, [])
        self.assertNotEqual(self.git_grep("-F", f"# {SWITCH}=true", paths=[".env.example"]), [],
                            ".env.example documents the switch a fresh install writes")

    def test_the_entry_points_are_really_searched(self):
        # A pattern that matched nothing would make the tests above vacuous.
        listed = subprocess.run(["git", "-C", str(REPO), "ls-files", "--", *ENTRY_POINTS, *EXCLUDED],
                                capture_output=True, text=True, check=True).stdout.splitlines()
        for expected in ("docker-compose.yml", ".env.example", "package.json", "scripts/install-server.sh"):
            self.assertIn(expected, listed)
        self.assertNotEqual(self.git_grep("-F", "deploy/managed-runner/firewall/Dockerfile", paths=["docker-compose.yml"]), [],
                            "root Compose builds the firewall from its own directory")
        self.assertTrue(any(path.startswith(".github/workflows/") for path in listed))
        self.assertTrue(any(path.startswith(".claude/skills/upgrade/") for path in listed))
        self.assertTrue(any(path.startswith(".agents/skills/upgrade/") for path in listed))
        self.assertIn("src/web/public/install.sh", listed)
        # The exclusion keeps the other nested scripts and drops only the delivery's own directory.
        self.assertTrue(any(path.startswith("scripts/ci/") for path in listed))
        self.assertFalse(any(path.startswith("scripts/managed-runner/") for path in listed))
        self.assertNotEqual(self.git_grep("-F", "services:"), [], "git grep finds what is there")
        self.assertNotEqual(self.git_grep("-F", SWITCH, paths=["docker-compose.yml"]), [], "and finds the switch")


if __name__ == "__main__":
    unittest.main()
