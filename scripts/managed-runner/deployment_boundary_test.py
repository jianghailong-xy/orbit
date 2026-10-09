#!/usr/bin/env python3
"""The optional managed runner delivery stays out of every default entry point.

docs/managed-runner-design.md, "Optional test deployment boundary": root Compose, .env.example,
/upgrade, the release and install paths and the normal start scripts neither reference
deploy/managed-runner or scripts/managed-runner nor switch the feature on. This reads the tracked
files of those entry points with `git grep`; nothing is built, started or sent anywhere.
"""

from pathlib import Path
import shutil
import subprocess
import unittest

REPO = Path(__file__).resolve().parents[2]

# The default entry points: what an operator or a release runs without asking for managed runners.
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
# What would wire the optional delivery in: its paths, and the switch or profile that enables it.
NEEDLES = [
    "deploy/managed-runner",
    "scripts/managed-runner",
    "ORBIT_MANAGED_RUNNERS_ENABLED",
    "ORBIT_MANAGED_RUNNERS_PROFILE",
    "pod-admission-webhook",
]


class DeploymentBoundaryTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("git") or not (REPO / ".git").exists():
            self.skipTest("needs the git checkout to read its tracked entry points")

    def git_grep(self, needle):
        result = subprocess.run(
            ["git", "-C", str(REPO), "grep", "-n", "-F", needle, "--", *ENTRY_POINTS],
            capture_output=True, text=True, check=False)
        # 1: nothing found. Anything else but 0 is git failing, which must not read as clean.
        self.assertIn(result.returncode, (0, 1), result.stderr)
        return result.stdout.splitlines()

    def test_default_entry_points_do_not_reference_the_optional_delivery(self):
        for needle in NEEDLES:
            with self.subTest(needle=needle):
                self.assertEqual(self.git_grep(needle), [], f"{needle} reached a default entry point")

    def test_the_entry_points_are_really_searched(self):
        # A pattern that matched nothing would make the test above vacuous.
        listed = subprocess.run(["git", "-C", str(REPO), "ls-files", "--", *ENTRY_POINTS],
                                capture_output=True, text=True, check=True).stdout.splitlines()
        for expected in ("docker-compose.yml", ".env.example", "package.json"):
            self.assertIn(expected, listed)
        self.assertTrue(any(path.startswith(".github/workflows/") for path in listed))
        self.assertTrue(any(path.startswith(".claude/skills/upgrade/") for path in listed))
        self.assertIn("src/web/public/install.sh", listed)
        self.assertNotEqual(self.git_grep("services:"), [], "git grep finds what is there")


if __name__ == "__main__":
    unittest.main()
