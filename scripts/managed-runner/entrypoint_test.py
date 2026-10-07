#!/usr/bin/env python3
"""Scratch-filesystem checks with mocked mount and mapped UID; no container proof."""

from contextlib import redirect_stdout
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import unittest
from unittest import mock


ENTRYPOINT = Path(__file__).resolve().parents[2] / "deploy/managed-runner/image/entrypoint.py"
sys.dont_write_bytecode = True


class ForegroundExec(BaseException):
    pass


class EntrypointTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("managed_runner_entrypoint", ENTRYPOINT)
        self.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runner)
        self.scratch = tempfile.TemporaryDirectory(prefix="entrypoint-test-")
        self.addCleanup(self.scratch.cleanup)
        self.runner.ROOT = Path(self.scratch.name) / "volume"
        self.runner.ROOT.mkdir(mode=0o700)
        # This namespace cannot prove UID 10001 or Kubernetes mounts. The filesystem
        # cases use its actual mapped owner; separate cases retain the production UID.
        self.runner.UID, self.runner.GID = os.geteuid(), os.getegid()
        self.real_require_mount = self.runner.require_mount
        mount = mock.patch.object(self.runner, "require_mount")
        mount.start()
        self.addCleanup(mount.stop)
        self.token = Path(self.scratch.name) / "enrollment-token"
        self.token.write_text("fixture-enrollment-token\n")
        self.token.chmod(0o400)
        environment = mock.patch.dict(os.environ, {
            "PATH": "/usr/bin:/bin",
            "ORBIT_RUNNER_SERVER_URL": "https://control.example.test",
            "ORBIT_RUNNER_NAME": "isolated-fixture",
            "ORBIT_RUNNER_MAX_CONCURRENT": "1",
            "ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE": str(self.token),
            "ORBIT_SESSION_ID": "must-not-reach-runner",
            "ORBIT_SERVICE_TOKEN": "must-not-reach-runner",
            "KUBECONFIG": "/must-not-reach-runner",
            "DOCKER_HOST": "unix:///must-not-reach-runner",
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        popen = mock.patch.object(self.runner.subprocess, "Popen", side_effect=self.register_process)
        self.popen = popen.start()
        self.addCleanup(popen.stop)
        foreground = mock.patch.object(self.runner.os, "execvpe", side_effect=ForegroundExec)
        self.foreground = foreground.start()
        self.addCleanup(foreground.stop)
        self.registration_exit = 0
        self.registration_write_config = True
        self.wait_hook = None
        self.signals = []
        self.old_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.old_umask)

    @property
    def orbit(self):
        return self.runner.paths()[1]

    @property
    def config(self):
        return self.orbit / "config.json"

    def write_config(self, **changes):
        self.runner.prepare()
        config = {"serverUrl": "https://control.example.test", "runnerId": "fixture-runner-id",
                  "runnerToken": "fixture-runner-secret", "name": "isolated-fixture", "maxConcurrent": 1,
                  "workDir": str(self.runner.paths()[2]), "autoInstallEngines": False}
        config.update(changes)
        self.config.write_text(json.dumps(config, sort_keys=True))
        self.config.chmod(0o600)

    def register_process(self, argv, **kwargs):
        self.assertEqual(argv[:2], ["/usr/local/bin/orbit", "register"])
        self.assertIn("--no-service", argv)
        self.assertIn("--no-auto-install-engines", argv)
        pending = self.orbit / "registration-pending.json"
        self.assertTrue(pending.is_file(), "write the durable guard before contacting enrollment")
        self.assertEqual(stat.S_IMODE(pending.stat().st_mode), 0o600)
        self.assertEqual(json.loads(pending.read_text())["serverUrl"], "https://control.example.test")
        self.assertEqual(kwargs["stdin"], self.runner.subprocess.DEVNULL)
        self.assertNotIn("ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE", kwargs["env"])

        def wait():
            if self.wait_hook:
                self.wait_hook()
            if self.registration_write_config:
                self.write_config()
            return self.registration_exit

        return mock.Mock(wait=wait, send_signal=self.signals.append)

    def start(self):
        with self.assertRaises(ForegroundExec):
            self.runner.main(["run"])
        args = self.foreground.call_args.args
        self.assertEqual(args[:2], ("/usr/local/bin/orbit", ["orbit", "run"]))
        env = args[2]
        self.assertEqual(env["HOME"], str(self.runner.paths()[0]))
        self.assertEqual(env["ORBIT_HOME"], str(self.orbit))
        self.assertEqual(env["CODEX_HOME"], str(self.runner.paths()[0] / ".codex"))
        self.assertEqual(env["ORBIT_NO_SELFUPDATE"], "1")
        self.assertEqual(env["ORBIT_NO_ENGINE_UPDATE"], "1")
        self.assertFalse(any(key.startswith("ORBIT_RUNNER_") for key in env))
        for key in ("ORBIT_SESSION_ID", "ORBIT_SERVICE_TOKEN", "KUBECONFIG", "DOCKER_HOST"):
            self.assertNotIn(key, env)

    def assert_refused(self):
        with self.assertRaises((ValueError, OSError)):
            self.runner.main(["run"])
        self.popen.assert_not_called()
        self.foreground.assert_not_called()

    def test_first_start_registers_once_and_execs_foreground(self):
        self.start()
        self.popen.assert_called_once()
        self.assertFalse((self.orbit / "registration-pending.json").exists())
        marker = json.loads((self.orbit / "container-identity.json").read_text())
        self.assertEqual(marker["layoutVersion"], 1)
        self.assertEqual(marker["runnerId"], "fixture-runner-id")

    def test_inherited_path_and_user_bins_cannot_shadow_bootstrap_or_runtime(self):
        malicious = Path(self.scratch.name) / "malicious-bin"
        malicious.mkdir()
        os.environ["PATH"] = str(malicious)
        self.start()
        env = self.foreground.call_args.args[2]
        path = env["PATH"].split(os.pathsep)
        self.assertEqual(path[:4], ["/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin"])
        self.assertNotIn(str(malicious), path)
        for directory in (self.runner.paths()[0] / ".local/bin", self.runner.paths()[0] / ".opencode/bin",
                          self.runner.paths()[0] / ".kimi-code/bin"):
            self.assertGreater(path.index(str(directory)), 3)

    def test_rebuild_preserves_identity_credentials_and_all_local_state_bytes(self):
        self.start()
        retained = [self.config, self.orbit / "container-identity.json"]
        for relative in ("home/.orbit/runs/session/meta.json", "home/.orbit/worktrees/session/work.txt",
                         "home/.orbit/uploads/session/attachment.bin", "home/.orbit/codex-state/partition/state.sqlite",
                         "home/.codex/sessions/session.jsonl", "home/.claude/projects/session.jsonl",
                         "home/orbit-repos/default/project.txt"):
            path = self.runner.ROOT / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture-state:" + relative.encode())
            retained.append(path)
        before = {path: path.read_bytes() for path in retained}
        os.environ.pop("ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE")
        os.environ.pop("ORBIT_RUNNER_NAME")
        os.environ.pop("ORBIT_RUNNER_MAX_CONCURRENT")
        os.environ["ORBIT_RUNNER_EXPECTED_ID"] = "fixture-runner-id"
        self.start()
        self.popen.assert_called_once()
        self.assertEqual(before, {path: path.read_bytes() for path in retained})

    def test_check_reads_identity_without_registration_or_runner_start(self):
        self.write_config()
        before = self.config.read_bytes()
        output = io.StringIO()
        with redirect_stdout(output):
            self.runner.main(["check"])
        self.assertEqual(json.loads(output.getvalue())["runnerId"], "fixture-runner-id")
        self.assertEqual(before, self.config.read_bytes())
        self.popen.assert_not_called()
        self.foreground.assert_not_called()

    def test_absent_enrollment_token_never_contacts_network(self):
        os.environ.pop("ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE")
        self.assert_refused()
        self.assertFalse((self.orbit / "registration-pending.json").exists())

    def test_empty_enrollment_token_never_contacts_network(self):
        self.token.chmod(0o600)
        self.token.write_text("\n")
        self.token.chmod(0o400)
        self.assert_refused()

    def test_first_start_requires_explicit_name_and_positive_concurrency(self):
        for variable, value in (("ORBIT_RUNNER_NAME", ""), ("ORBIT_RUNNER_MAX_CONCURRENT", "0"),
                                ("ORBIT_RUNNER_MAX_CONCURRENT", "garbage")):
            with self.subTest(variable=variable, value=value), mock.patch.dict(os.environ, {variable: value}):
                self.assert_refused()

    def test_explicit_approved_server_is_required_for_fresh_or_retained_identity(self):
        for server in ("", "http://unapproved.example.test", "https://user:password@example.test", "https://example.test/?token=secret"):
            with self.subTest(server=server), mock.patch.dict(os.environ, {"ORBIT_RUNNER_SERVER_URL": server}):
                self.assert_refused()
        self.write_config()
        os.environ.pop("ORBIT_RUNNER_SERVER_URL")
        self.assert_refused()

    def test_corrupt_retained_config_is_not_replaced(self):
        self.runner.prepare()
        self.config.write_text("{corrupt")
        self.assert_refused()
        self.assertEqual(self.config.read_text(), "{corrupt")

    def test_incomplete_or_incompatible_config_is_not_reenrolled(self):
        for changes in ({"runnerToken": ""}, {"runnerId": ""}, {"runnerId": 10},
                        {"workDir": "/different/absolute/path"}, {"autoInstallEngines": True},
                        {"serverUrl": "https://different.example.test"}):
            with self.subTest(changes=changes):
                self.write_config(**changes)
                self.assert_refused()

    def test_wrong_expected_runner_id_is_refused(self):
        self.write_config()
        os.environ["ORBIT_RUNNER_EXPECTED_ID"] = "other-user-runner"
        self.assert_refused()

    def test_wrong_retained_volume_marker_is_refused(self):
        self.write_config()
        self.runner.durable_json(self.orbit / "container-identity.json", {"runnerId": "other-user-runner"})
        self.assert_refused()

    def test_missing_config_with_retained_session_data_never_registers(self):
        self.runner.prepare()
        (self.orbit / "runs" / "existing-session.json").write_text("retained")
        self.assert_refused()

    def test_missing_config_with_retained_engine_history_never_registers(self):
        self.runner.prepare()
        (self.runner.paths()[0] / ".codex" / "session.jsonl").write_text("retained engine state")
        self.assert_refused()

    def test_missing_config_with_another_retained_repository_never_registers(self):
        self.runner.prepare()
        (self.runner.paths()[0] / "orbit-repos" / "existing-repository").mkdir()
        self.assert_refused()

    def test_failed_or_uncertain_registration_is_never_repeated(self):
        self.registration_exit = 1
        self.registration_write_config = False
        with self.assertRaises(ValueError):
            self.runner.main(["run"])
        self.assertTrue((self.orbit / "registration-pending.json").exists())
        self.popen.reset_mock()
        self.assert_refused()

    def test_success_exit_without_config_still_leaves_uncertain_attempt(self):
        self.registration_write_config = False
        with self.assertRaises(OSError):
            self.runner.main(["run"])
        self.assertTrue((self.orbit / "registration-pending.json").exists())
        self.popen.reset_mock()
        self.assert_refused()

    def test_signal_during_enrollment_is_forwarded_and_does_not_start_runner(self):
        self.registration_write_config = False
        self.wait_hook = lambda: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        with self.assertRaises(SystemExit) as result:
            self.runner.main(["run"])
        self.assertEqual(result.exception.code, 128 + signal.SIGTERM)
        self.assertEqual(self.signals, [signal.SIGTERM])
        self.assertTrue((self.orbit / "registration-pending.json").exists())
        self.foreground.assert_not_called()

    def test_populated_config_reconciles_pending_without_rotating_identity(self):
        self.write_config()
        self.runner.durable_json(self.orbit / "registration-pending.json", {"name": "old-attempt"})
        before = self.config.read_bytes()
        self.start()
        self.popen.assert_not_called()
        self.assertEqual(before, self.config.read_bytes())
        self.assertFalse((self.orbit / "registration-pending.json").exists())

    def test_insecure_known_directories_and_config_are_hardened(self):
        self.write_config()
        self.orbit.chmod(0o755)
        self.config.chmod(0o644)
        self.start()
        self.assertEqual(stat.S_IMODE(self.orbit.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)

    def test_symlink_directory_is_refused_without_touching_its_target(self):
        self.runner.prepare()
        outside = Path(self.scratch.name) / "outside"
        outside.mkdir(mode=0o755)
        outside.chmod(0o755)
        uploads = self.orbit / "uploads"
        uploads.rmdir()
        uploads.symlink_to(outside, target_is_directory=True)
        self.assert_refused()
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o755)

    def test_symlink_config_is_refused_without_reading_or_chmodding_target(self):
        self.runner.prepare()
        outside = Path(self.scratch.name) / "outside-config"
        outside.write_text("outside-private-data")
        outside.chmod(0o644)
        self.config.symlink_to(outside)
        self.assert_refused()
        self.assertEqual(outside.read_text(), "outside-private-data")
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o644)

    def test_init_volume_only_hardens_known_layout_not_user_children(self):
        if os.geteuid() != 0:
            self.skipTest("init-volume requires root; mapped filesystem check unavailable")
        self.runner.prepare()
        child = self.runner.paths()[2] / "user-file"
        child.write_text("unchanged")
        child.chmod(0o644)
        self.runner.main(["init-volume"])
        self.assertEqual(child.read_text(), "unchanged")
        self.assertEqual(stat.S_IMODE(child.stat().st_mode), 0o644)
        self.popen.assert_not_called()
        self.foreground.assert_not_called()

    def test_runtime_rejects_other_uid_with_production_constants(self):
        self.runner.UID = self.runner.GID = 10001
        with mock.patch.object(self.runner.os, "geteuid", return_value=0):
            self.assert_refused()

    def test_ephemeral_unmounted_root_is_rejected(self):
        with self.assertRaises(ValueError):
            self.real_require_mount()

    def test_foreground_exec_keeps_the_local_volume_lock_inheritable(self):
        self.write_config()
        inherited = []
        original = self.runner.lock_volume

        def lock():
            fd = original()
            inherited.append(os.get_inheritable(fd))
            return fd

        with mock.patch.object(self.runner, "lock_volume", side_effect=lock):
            self.start()
        self.assertEqual(inherited, [True])

    def test_competing_local_runner_is_refused_before_enrollment(self):
        self.runner.prepare()
        lock = self.runner.lock_volume()
        try:
            self.assert_refused()
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            os.close(lock)


if __name__ == "__main__":
    print("Scope: real scratch file checks; mount and UID mapping adapted for local namespace. "
          "No container, cluster, Ceph, or real-engine acceptance.", flush=True)
    unittest.main()
