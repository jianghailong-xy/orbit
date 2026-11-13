"""The channel-host kit (deploy/managed-runner/remote-host): install, upgrade <sha> and status on a fake Docker.

docs/managed-runner-remote-host-design.md, items 3 and 5, D2 and D3: on a host other than the server's, `install` makes
the managed runners' network, the Docker channel's token and channel.json (listening on one private address of the host
for the peers it names), the firewall's configuration with its rules applied and checked, and the runner image built
from this checkout; it starts both services and prints the entry for the server's profile.json. `upgrade <sha>` checks
that commit out, rebuilds, and switches channel.json to the new image as /upgrade does on a single host, then recreates
the channel. The network, image and firewall steps are scripts/install-server.sh's own (deploy/managed-runner/host.sh),
so this test drives them through the same fake Docker as new_deployment_test.py.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
KIT = "deploy/managed-runner/remote-host/remote-host.sh"
COPIED = [KIT, "deploy/managed-runner/remote-host/compose.yml", "deploy/managed-runner/host.sh", ".gitignore"]
IMAGE_ID = "sha256:" + "ab" * 32
NEW_IMAGE_ID = "sha256:" + "cd" * 32
DIRECTORY = "data/channel-host"
MOUNT = "/var/lib/orbit-managed-runners"


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, REPO / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARED = load("new_deployment_test", "scripts/managed-runner/new_deployment_test.py")
CHANNEL = load("channel", "deploy/managed-runner/docker-channel/channel.py")

# What the kit asks of Docker beyond the install's own calls, which the shared fake answers: whether a channel container
# exists here (FAKE_CHANNEL_EXISTS), the channel's check of a configuration (FAKE_CHECK_FAIL), and a member of channel.json
# read with the channel image's Python, run here on the directory the call mounts.
FAKE_DOCKER = r"""#!/usr/bin/env bash
log() { printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"; }
case "$*" in
  "container inspect orbit-docker-channel") log "$*"; [ -n "${FAKE_CHANNEL_EXISTS:-}" ] && exit 0; exit 1 ;;
  "run --rm --network none -v "*" orbit-docker-channel:local check-config --config "*) log "$*"; exit "${FAKE_CHECK_FAIL:-0}" ;;
  "run --rm --network none -v "*" --entrypoint python3 orbit-docker-channel:local -I -c "*)
    log "$*"; host="${6%%:*}"; code="${*: -1}"; exec python3 -I -c "${code//\/var\/lib\/orbit-managed-runners/$host}" ;;
esac
exec "$(dirname "$0")/docker-shared" "$@"
"""
FAKE_IP = """#!/bin/sh
echo "1: lo    inet 127.0.0.1/8 scope host lo"
echo "2: wg1    inet 10.66.0.3/24 scope global wg1"
"""


class RemoteHostTest(unittest.TestCase):
    def setUp(self):
        for tool in ("bash", "git", "openssl", "grep", "sed", "awk"):
            if not shutil.which(tool):
                self.skipTest(f"needs {tool}")
        self.root = Path(tempfile.mkdtemp(prefix="orbit-remote-host-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.checkout = self.root / "orbit"
        for relative in COPIED:
            target = self.checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / relative, target)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, text in (("docker", FAKE_DOCKER), ("docker-shared", SHARED.FAKE_DOCKER), ("ip", FAKE_IP)):
            (bin_dir / name).write_text(text)
            (bin_dir / name).chmod(0o755)
        self.log = self.root / "docker.log"
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith(("ORBIT_", "COMPOSE_", "GIT_"))},
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_DOCKER_LOG": str(self.log),
            "FAKE_IMAGE_ID": IMAGE_ID,
            "FAKE_GATEWAY": "172.30.0.1",
            "FAKE_BRIDGE": "br-0123456789ab",
            "GIT_AUTHOR_NAME": "fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_CEILING_DIRECTORIES": str(self.root),
        }
        self.git("init", "-q", "--initial-branch=main")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "fixture")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.checkout, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def kit(self, *args, **env):
        self.log.write_text("")
        self.log.with_name(self.log.name + ".applied").unlink(missing_ok=True)
        return subprocess.run([str(self.checkout / KIT), *args], cwd=self.root, env={**self.env, **env},
                              capture_output=True, text=True, timeout=120)

    def calls(self):
        return self.log.read_text().splitlines()

    def install(self, *extra, **env):
        return self.kit("install", "--listen", "10.66.0.3", "--allow-peer", "10.66.0.1", "--instance", "orbit-far", *extra, **env)

    def directory(self):
        return self.checkout / DIRECTORY

    def runner_build(self, sha):
        return (f"build --provenance=false -f deploy/managed-runner/image/Dockerfile --build-arg ORBIT_SOURCE_SHA={sha} "
                "-t orbit-managed-runner:local .")

    def compose(self, rest):
        return f"compose -f deploy/managed-runner/remote-host/compose.yml --env-file {DIRECTORY}/compose.env {rest}"

    # ── install ───────────────────────────────────────────────────────────────────────────────

    def test_install_prepares_this_host_and_prints_the_servers_profile_entry(self):
        run = self.install()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        directory = self.directory()
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(sorted(p.name for p in directory.iterdir()), ["channel.json", "compose.env", "firewall", "token"])
        token = (directory / "token").read_text().strip()
        self.assertRegex(token, r"^[0-9a-f]{64}$")
        for name in ("token", "channel.json", "compose.env"):
            self.assertEqual(stat.S_IMODE((directory / name).stat().st_mode), 0o600, name)

        # channel.json: the channel's own parser takes it, listening on the private address for the named peer only.
        config = CHANNEL.parse_config(json.loads((directory / "channel.json").read_text()))
        self.assertEqual(config["instanceId"], "orbit-far")
        self.assertEqual(config["listen"], {"tcp": {"host": "10.66.0.3", "port": 7300}, "allowPeers": ["10.66.0.1"]})
        self.assertEqual((config["image"], config["network"], config["tokenFile"]), (IMAGE_ID, "orbit-managed-runners", f"{MOUNT}/token"))
        self.assertEqual((directory / "compose.env").read_text().splitlines()[1:], [f"ORBIT_CHANNEL_HOST_DIR={directory}"])

        # The firewall's configuration, its rules applied and checked from the network, as a single host's install does.
        firewall = json.loads((directory / "firewall/config.json").read_text())
        self.assertEqual((firewall["network"], firewall["bridge"], firewall["gateway"]),
                         ("orbit-managed-runners", "br-0123456789ab", "172.30.0.1"))
        calls = self.calls()
        head = self.git("rev-parse", "HEAD")
        order = [
            "build -f deploy/managed-runner/firewall/Dockerfile -t orbit-managed-runner-firewall:local .",
            "network create --driver bridge --ipv6=false --opt com.docker.network.bridge.enable_icc=false orbit-managed-runners",
            self.runner_build(head),
            self.compose("build docker-channel"),
            f"run --rm --network none -v {directory}:{MOUNT}:ro orbit-docker-channel:local check-config --config {MOUNT}/channel.json.new",
            self.compose("up -d --wait --wait-timeout 120 managed-runner-firewall docker-channel"),
        ]
        positions = [calls.index(call) for call in order]
        self.assertEqual(positions, sorted(positions), calls)
        applied = [c for c in calls if " orbit-managed-runner-firewall:local apply " in c]
        self.assertEqual(len(applied), 1, calls)
        self.assertLess(calls.index(applied[0]), calls.index(order[-1]))
        self.assertTrue([c for c in calls if "probe --blocked 172.30.0.1:1" in c], calls)
        self.assertFalse([c for c in calls if re.match(r"(image )?(push|tag)\b|login\b", c)], calls)

        # The entry for docker.hosts, and where the token is; never the token itself.
        entries = [line.strip() for line in run.stdout.splitlines() if line.strip().startswith('{ "instanceId"')]
        self.assertEqual([json.loads(line) for line in entries],
                         [{"instanceId": "orbit-far", "channel": {"url": "http://10.66.0.3:7300"}, "tokenFile": f"{MOUNT}/orbit-far.token"}])
        self.assertIn(f"{directory}/token", run.stdout)
        self.assertNotIn(token, run.stdout + run.stderr)

    def test_install_refuses_before_anything_is_built(self):
        cases = {
            "no peer": ["install", "--listen", "10.66.0.3"],
            "no address": ["install", "--allow-peer", "10.66.0.1"],
            "another host's address": ["install", "--listen", "10.66.0.9", "--allow-peer", "10.66.0.1"],
            "the firewall's port": ["install", "--listen", "10.66.0.3", "--allow-peer", "10.66.0.1", "--port", "2086"],
        }
        for case, args in cases.items():
            with self.subTest(case=case):
                run = self.kit(*args)
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse([c for c in self.calls() if re.match(r"(compose .* )?(build|up|run|network create) ", c)], self.calls())
                self.assertFalse(self.directory().exists())
        with self.subTest(case="a channel container here already"):
            run = self.install(FAKE_CHANNEL_EXISTS="1")
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("orbit-docker-channel exists", run.stderr)
            self.assertFalse(self.directory().exists())
        with self.subTest(case="installed already"):
            self.assertEqual(self.install().returncode, 0)
            before = (self.directory() / "token").read_bytes()
            run = self.install()
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("upgrade", run.stderr)
            self.assertEqual((self.directory() / "token").read_bytes(), before)

    def test_a_configuration_the_channel_refuses_is_never_put_in_place(self):
        run = self.install(FAKE_CHECK_FAIL="1")
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse((self.directory() / "channel.json").exists())
        self.assertFalse([c for c in self.calls() if " up " in c], self.calls())

    # ── upgrade ───────────────────────────────────────────────────────────────────────────────

    def commit_another(self):
        (self.checkout / "next.txt").write_text("the next commit\n")
        self.git("add", "next.txt")
        self.git("commit", "-q", "-m", "next")
        return self.git("rev-parse", "HEAD")

    def test_upgrade_checks_out_the_commit_and_switches_channel_json_to_its_image(self):
        first = self.git("rev-parse", "HEAD")
        nxt = self.commit_another()
        self.git("checkout", "-q", "--detach", first)
        self.assertEqual(self.install().returncode, 0)
        before = (self.directory() / "channel.json").read_text()

        run = self.kit("upgrade", nxt[:12], FAKE_IMAGE_ID=NEW_IMAGE_ID)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), nxt, "that commit is checked out")
        self.assertEqual((self.directory() / "channel.json").read_text(), before.replace(IMAGE_ID, NEW_IMAGE_ID))
        self.assertEqual(stat.S_IMODE((self.directory() / "channel.json").stat().st_mode), 0o600)
        self.assertEqual(sorted(p.name for p in self.directory().iterdir()), ["channel.json", "compose.env", "firewall", "token"])
        calls = self.calls()
        ups = [c for c in calls if c.startswith(self.compose("up"))]
        self.assertEqual(ups, [self.compose("up -d --wait --wait-timeout 120 --no-deps managed-runner-firewall"),
                               self.compose("up -d --wait --wait-timeout 120 --no-deps --force-recreate docker-channel")])
        self.assertLess(calls.index(self.runner_build(nxt)), calls.index(ups[0]))
        self.assertIn(f"The managed runner image is now {NEW_IMAGE_ID} in channel.json", run.stdout)
        # status, at the end: the instance and its listener, read from channel.json.
        self.assertIn("Instance:     orbit-far", run.stdout)
        self.assertIn('Listens on:   {"host": "10.66.0.3", "port": 7300} for ["10.66.0.1"]', run.stdout)

        # Again, the same image: nothing written, and the channel recreated only if its own image changed.
        stamp = (self.directory() / "channel.json").stat().st_mtime_ns
        run = self.kit("upgrade", nxt, FAKE_IMAGE_ID=NEW_IMAGE_ID)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual((self.directory() / "channel.json").stat().st_mtime_ns, stamp)
        self.assertIn(self.compose("up -d --wait --wait-timeout 120 --no-deps docker-channel"), self.calls())
        self.assertIn(f"The managed runner image is unchanged ({NEW_IMAGE_ID})", run.stdout)

    def test_a_switch_whose_channel_did_not_start_is_finished_by_the_next_upgrade(self):
        self.assertEqual(self.install().returncode, 0)
        head = self.git("rev-parse", "HEAD")
        recreate = self.compose("up -d --wait --wait-timeout 120 --no-deps --force-recreate docker-channel")
        run = self.kit("upgrade", head, FAKE_IMAGE_ID=NEW_IMAGE_ID, FAKE_FAIL=recreate)
        self.assertNotEqual(run.returncode, 0)
        marker = self.directory() / ".image-switch"
        self.assertEqual(marker.read_text().strip(), NEW_IMAGE_ID)
        run = self.kit("upgrade", head, FAKE_IMAGE_ID=NEW_IMAGE_ID)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn(recreate, self.calls())
        self.assertFalse(marker.exists())

    def test_upgrade_refuses_uncommitted_changes_and_an_uninstalled_host(self):
        run = self.kit("upgrade", "HEAD")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("install first", run.stderr)
        self.assertEqual(self.install().returncode, 0)
        head = self.git("rev-parse", "HEAD")
        nxt = self.commit_another()
        self.git("checkout", "-q", "--detach", head)
        (self.checkout / ".gitignore").write_text("changed\n")
        run = self.kit("upgrade", nxt)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("uncommitted changes", run.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertFalse([c for c in self.calls() if re.match(r"(compose .* )?(build|up) ", c)], self.calls())


if __name__ == "__main__":
    unittest.main()
