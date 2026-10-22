#!/usr/bin/env python3
"""scripts/managed-runner/volume-backup.sh against a fake `docker` first on PATH.

What the script decides and the Docker commands it issues: it backs up a managed runner's data volume only while
no container refers to it, saves the labels a restore needs, runs its helper with no network and with the volume
read-only (backup) or the backup read-only (check, restore), checks a backup in a scratch volume it removes, and
never restores into a volume that exists. What the helper runs inside the runner image is exercised on real Docker
by D5's drill (docs/evidence/managed-runner-docker-security/2026-10-17/README.md), not here.
"""

import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/managed-runner/volume-backup.sh"
IMAGE = "sha256:" + "cd" * 32
RUNNER = "0195c0de-0000-7000-8000-0000000000a1"
V = f"mr-data-{RUNNER}"
LABELS = {
    "orbit.managed-runner.disk-limit-bytes": "21474836480",
    "orbit.managed-runner.instance": "orbit-fixture",
    "orbit.managed-runner.kind": "data",
    "orbit.managed-runner.owner": "0195c0de-0000-7000-8000-0000000000b1",
    "orbit.managed-runner.runner": RUNNER,
    "orbit.managed-runner.uid": "6f1c9a52-3d0e-4c55-9a43-1d2c7e0b8f10",
}

# The fake host: a volume exists while its state file does; `ps -aq` answers what the holders file says; the
# helper container records the script it was given on standard input.
FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_STATE/log"
last="${@: -1}"
case "$1 $2" in
  "volume inspect")
    [ -e "$FAKE_STATE/volume-$last" ] || exit 1
    if [ "$3" = -f ]; then
      if [ "$4" = "{{len .Labels}}" ]; then cat "$FAKE_STATE/labels-count"; else cat "$FAKE_STATE/labels-flags"; fi
    else
      echo "[{\"Name\": \"$last\"}]"
    fi ;;
  "volume create") touch "$FAKE_STATE/volume-$last"; echo "$last" ;;
  "volume rm") rm -f "$FAKE_STATE/volume-$last" ;;
  "ps -aq") cat "$FAKE_STATE/holders" 2>/dev/null ;;
  "ps -q") cat "$FAKE_STATE/running" 2>/dev/null ;;
  "run --rm") n=$(ls "$FAKE_STATE"/helper-stdin-* 2>/dev/null | wc -l); cat >"$FAKE_STATE/helper-stdin-$n"; echo "the helper ran" ;;
esac
exit 0
"""


class VolumeBackupTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="volume-backup-test-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.checkout = self.root / "checkout"
        (self.checkout / "data/managed-runners").mkdir(parents=True)
        (self.checkout / "data/managed-runners/channel.json").write_text(f'{{\n  "schemaVersion": 1,\n  "image": "{IMAGE}",\n  "network": "orbit-managed-runners"\n}}\n')
        self.state = self.root / "state"
        self.state.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_STATE": str(self.state)}
        self.backup = self.root / "backups" / "20261017T000000Z"
        self.volume_exists(V, LABELS)

    def volume_exists(self, name, labels):
        (self.state / f"volume-{name}").touch()
        (self.state / "labels-flags").write_text("".join(f"--label {k}={v} " for k, v in sorted(labels.items())) + "\n")
        (self.state / "labels-count").write_text(f"{len(labels)}\n")

    def run_script(self, action, volume=V):
        return subprocess.run(["bash", str(SCRIPT), action, volume, str(self.backup)], cwd=self.checkout, env=self.env,
                              capture_output=True, text=True, timeout=60)

    def calls(self):
        log = self.state / "log"
        return log.read_text().splitlines() if log.exists() else []

    def helper_calls(self):
        return [shlex.split(c) for c in self.calls() if c.startswith("run --rm")]

    def helper_call(self):
        return self.helper_calls()[0]

    def helper_script(self, n=0):
        return (self.state / f"helper-stdin-{n}").read_text()

    @staticmethod
    def pairs(call):
        return [call[i:i + 2] for i in range(len(call) - 1)]

    def write_backup(self):
        self.backup.mkdir(parents=True)
        for suffix in ("tar.gz", "sha256"):
            (self.backup / f"{V}.{suffix}").write_text("x\n")
        (self.backup / f"{V}.labels").write_text("".join(f"--label {k}={v} " for k, v in sorted(LABELS.items())) + "\n")

    def test_a_backup_waits_for_the_runner_to_sleep(self):
        (self.state / "holders").write_text("4f2a9c1b77e0\n")
        result = self.run_script("backup")
        self.assertEqual(result.returncode, 1)
        self.assertIn("a container still refers to", result.stderr)
        self.assertFalse(any(c.startswith("run ") for c in self.calls()), "no helper while the volume is held")

    def test_a_backup_keeps_the_labels_and_reads_the_volume_read_only_with_no_network(self):
        result = self.run_script("backup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.backup / f"{V}.labels").read_text().split(),
                         [w for k, v in sorted(LABELS.items()) for w in ("--label", f"{k}={v}")])
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o700)
        call = self.helper_call()
        for flag in (["--network", "none"], ["--user", "0:0"], ["-v", f"{V}:/data:ro"], ["-v", f"{self.backup}:/backup:rw"],
                     ["--entrypoint", "sh"]):
            self.assertIn(flag, [call[i:i + 2] for i in range(len(call) - 1)], call)
        self.assertEqual(call[-3:], [IMAGE, "-s", V], "the configured image by its ID, with the volume's name")
        script = self.helper_script()
        self.assertIn("tar --numeric-owner -czpf", script)
        self.assertNotIn("sqlite3", script, "a WAL database does not open on the read-only volume: check does it")

    def test_only_a_managed_runner_s_data_volume(self):
        for name in ("orbit_pg-socket", f"mr-boot-{RUNNER}-g1", "/var/lib/docker/volumes", f"{V}x"):
            with self.subTest(name=name):
                result = self.run_script("backup", name)
                self.assertEqual(result.returncode, 1)
                self.assertIn("is not a managed runner's data volume", result.stderr)
        self.volume_exists(V, {k: v for k, v in LABELS.items() if k != "orbit.managed-runner.kind"})
        result = self.run_script("backup")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not carry a managed runner's data labels", result.stderr)

    def test_a_label_value_with_a_space_is_not_saved_as_arguments(self):
        self.volume_exists(V, {**LABELS, "orbit.test": "two words"})
        result = self.run_script("backup")
        self.assertEqual(result.returncode, 1)
        self.assertIn("holds a space", result.stderr)

    def test_it_runs_only_from_a_deployment_checkout(self):
        (self.checkout / "data/managed-runners/channel.json").unlink()
        result = self.run_script("backup")
        self.assertEqual(result.returncode, 1)
        self.assertIn("run this from the deployment's checkout", result.stderr)

    def test_a_check_unpacks_into_a_scratch_volume_inspects_it_as_the_runner_and_removes_it(self):
        self.write_backup()
        result = self.run_script("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        created = [c.split()[-1] for c in self.calls() if c.startswith("volume create")]
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].startswith("orbit-restore-check-"))
        self.assertIn(f"volume rm {created[0]}", self.calls())
        unpack, inspect = self.helper_calls()
        self.assertIn(["--user", "0:0"], self.pairs(unpack), "only root restores every owner")
        self.assertIn(["-v", f"{created[0]}:/data:rw"], self.pairs(unpack))
        self.assertIn(["-v", f"{self.backup}:/backup:ro"], self.pairs(unpack))
        self.assertIn("cmp -s /tmp/restored.sha256", self.helper_script(0))
        self.assertIn(["--user", "10001:10001"], self.pairs(inspect), "what SQLite creates beside a database is the runner's")
        self.assertIn(["-v", f"{created[0]}:/var/lib/orbit:rw"], self.pairs(inspect), "where the runner mounts it")
        script = self.helper_script(1)
        self.assertIn("pragma integrity_check", script)
        self.assertIn("git -C", script)
        self.assertIn("exit 5", script, "anything that is not ok fails the check")
        self.assertTrue((self.state / f"volume-{V}").exists(), "the runner's own volume is not touched")

    def test_a_restore_never_writes_into_a_volume_that_exists(self):
        self.write_backup()
        result = self.run_script("restore")
        self.assertEqual(result.returncode, 1)
        self.assertIn("restore never writes into a volume that is there", result.stderr)
        self.assertFalse(any(c.startswith(("volume create", "run ")) for c in self.calls()))

    def test_a_restore_recreates_the_volume_with_its_labels(self):
        self.write_backup()
        (self.state / f"volume-{V}").unlink()
        result = self.run_script("restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(shlex.split(c) for c in self.calls() if c.startswith("volume create"))
        self.assertEqual(create[2:], [w for k, v in sorted(LABELS.items()) for w in ("--label", f"{k}={v}")] + [V])
        unpack, inspect = self.helper_calls()
        self.assertIn(["-v", f"{V}:/data:rw"], self.pairs(unpack))
        self.assertIn(["-v", f"{self.backup}:/backup:ro"], self.pairs(unpack))
        self.assertIn(["--user", "10001:10001"], self.pairs(inspect))
        self.assertIn(["-v", f"{V}:/var/lib/orbit:rw"], self.pairs(inspect))

    def test_verify_inspects_a_volume_in_place_only_while_nothing_runs_on_it(self):
        (self.state / "running").write_text("4f2a9c1b77e0\n")
        result = subprocess.run(["bash", str(SCRIPT), "verify", V], cwd=self.checkout, env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("a running container uses", result.stderr)
        self.assertEqual(self.helper_calls(), [])
        (self.state / "running").unlink()
        (self.state / "holders").write_text("4f2a9c1b77e0\n")  # an exited container, as after a host lost power
        result = subprocess.run(["bash", str(SCRIPT), "verify", V], cwd=self.checkout, env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        (inspect,) = self.helper_calls()
        self.assertIn(["--user", "10001:10001"], self.pairs(inspect))
        self.assertIn(["-v", f"{V}:/var/lib/orbit:rw"], self.pairs(inspect))
        self.assertFalse(any(a.startswith(f"{self.backup}") or a.endswith(":/backup:ro") for a in inspect), "no backup directory")
        self.assertIn("pragma integrity_check", self.helper_script(0))

    def test_a_check_or_restore_needs_the_whole_backup(self):
        self.backup.mkdir(parents=True)
        (self.state / f"volume-{V}").unlink()
        for action in ("check", "restore"):
            with self.subTest(action=action):
                result = self.run_script(action)
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"{V}.tar.gz is missing", result.stderr)


if __name__ == "__main__":
    unittest.main()
