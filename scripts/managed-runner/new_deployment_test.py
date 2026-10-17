#!/usr/bin/env python3
"""A fresh install switches managed runners on; an upgrade leaves a deployment's switch as it was, and keeps
a new deployment's managed runner image current.

The account owner's decision of 2026-10-17 (docs/managed-runner-design.md, "Implementation record: new
deployments"): scripts/install-server.sh writes the switch, the managed runners' directory and the Docker
backend's Compose profile into a new deployment's .env, and /upgrade — both copies of its script — never
writes .env, so a deployment installed without those lines keeps managed runners off. Where .env turns the
profile on, /upgrade also rebuilds the managed runner image and names its new ID in channel.json and
profile.json, then recreates the apiserver before the channel ("Implementation record: image upgrades"):
everything else it does, and everything it does where the profile is off, is what it did before.

Each case copies the scripts into a throwaway Git checkout and runs them with a fake `docker` first on PATH,
which records every call and answers as a host with nothing on it would. Nothing is built, started or sent
anywhere. channel.py's own parser checks the channel configuration the install and the upgrade write.
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
INSTALL = "scripts/install-server.sh"
UPGRADES = [".claude/skills/upgrade/upgrade.sh", ".agents/skills/upgrade/scripts/upgrade.sh"]
COPIED = [INSTALL, *UPGRADES, ".env.example", ".gitignore", "docker-compose.yml"]
IMAGE_ID = "sha256:" + "ab" * 32
GATEWAY = "172.30.0.1"
SWITCH_LINES = [
    "ORBIT_MANAGED_RUNNERS_ENABLED=true",
    "ORBIT_MANAGED_RUNNERS_DIR=./data/managed-runners",
    "COMPOSE_PROFILES=managed-runners-docker",
]

# The fake host. `compose config --services` lists the Docker channel only where .env switches its profile on,
# as Compose does, and `compose config docker-channel` then binds this checkout's data/managed-runners into it as
# Compose prints a bind; a network exists once created; an image is found by any name. The apiserver's container
# is replaced by a `compose up` that recreates it: one forced, or any naming it when FAKE_APISERVER_IMAGE_CHANGED
# says its image changed. A call matching FAKE_FAIL fails.
FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ -n "${FAKE_FAIL:-}" ] && [[ "$*" == $FAKE_FAIL ]]; then echo "fake docker: failing $*" >&2; exit 1; fi
apiserver_recreated() { echo "apiserver-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')" >"$FAKE_DOCKER_LOG.apiserver"; }
case "$*" in
  "compose version") echo "Docker Compose version v5.0.0" ;;
  "compose config --services")
    # In the order Compose lists them: the channel, when its profile is on, before the services after it.
    echo postgres; echo apiserver; echo wiki-worker
    grep -qx 'COMPOSE_PROFILES=managed-runners-docker' .env 2>/dev/null && echo docker-channel
    echo web; echo gateway; echo pgbackup ;;
  "compose config docker-channel")
    grep -qx 'COMPOSE_PROFILES=managed-runners-docker' .env 2>/dev/null || exit 1
    printf '%s\n' 'name: orbit' 'services:' '  docker-channel:' '    image: orbit-docker-channel:local' '    volumes:' \
      '      - type: bind' '        source: /var/run/docker.sock' '        target: /var/run/docker.sock' '        bind:' \
      '          create_host_path: true' '      - type: bind' "        source: $PWD/data/managed-runners" \
      '        target: /var/lib/orbit-managed-runners' '        bind:' '          create_host_path: true' ;;
  "compose ps -q apiserver") cat "$FAKE_DOCKER_LOG.apiserver" 2>/dev/null || echo apiserver-0 ;;
  "compose up "*--force-recreate*apiserver*) apiserver_recreated ;;
  "compose up "*apiserver*) [ -n "${FAKE_APISERVER_IMAGE_CHANGED:-}" ] && apiserver_recreated ;;
  "compose logs apiserver") echo "[ManagedRunners] managed runners are enabled in orbit-fixture (Docker instance orbit-fixture)" ;;
  "image inspect -f {{.Id}} "*) echo "$FAKE_IMAGE_ID" ;;
  "network inspect -f {{index .Options \"com.docker.network.bridge.enable_icc\"}} "*) echo false ;;
  "network inspect -f {{range .IPAM.Config}}{{.Gateway}} {{end}} "*) echo "$FAKE_GATEWAY " ;;
  "network inspect "*) [ -e "$FAKE_DOCKER_LOG.network" ] || exit 1 ;;
  "network create "*) : >"$FAKE_DOCKER_LOG.network" ;;
  "inspect --format {{.Image}} orbit-web") exit 1 ;;
esac
exit 0
"""


def load_channel():
    spec = importlib.util.spec_from_file_location("channel", REPO / "deploy/managed-runner/docker-channel/channel.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NewDeploymentTest(unittest.TestCase):
    def setUp(self):
        for tool in ("bash", "git", "openssl", "grep", "sed"):
            if not shutil.which(tool):
                self.skipTest(f"needs {tool}")
        self.root = Path(tempfile.mkdtemp(prefix="orbit-new-deployment-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.checkout = self.root / "orbit"
        for relative in COPIED:
            target = self.checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / relative, target)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
        self.log = self.root / "docker.log"
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith(("ORBIT_", "COMPOSE_", "GIT_"))},
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_DOCKER_LOG": str(self.log),
            "FAKE_IMAGE_ID": IMAGE_ID,
            "FAKE_GATEWAY": GATEWAY,
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

    def run_script(self, relative, *args, **env):
        self.log.write_text("")
        return subprocess.run([str(self.checkout / relative), *args], cwd=self.checkout, env={**self.env, **env},
                              capture_output=True, text=True, timeout=120)

    def calls(self):
        return self.log.read_text().splitlines()

    def live_lines(self, text):
        return [line for line in text.splitlines() if line and not line.lstrip().startswith("#")]

    # ── the fresh install ─────────────────────────────────────────────────────────────────────

    def test_a_fresh_install_writes_the_switch_the_directory_and_the_docker_profile(self):
        run = self.run_script(INSTALL, "--managed-runner-image", "orbit-managed-runner:fixture")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        env_file = self.checkout / ".env"
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        live = self.live_lines(env_file.read_text())
        for line in SWITCH_LINES:
            self.assertEqual(live.count(line), 1, f"{line} in {live}")
        secrets = {name: value for name, value in (line.split("=", 1) for line in live)
                   if name in ("JWT_SECRET", "PROVIDER_SECRET_KEY")}
        self.assertEqual(len(secrets), 2)
        self.assertTrue(all(len(value.strip('"')) >= 40 for value in secrets.values()), "both secrets generated")
        self.assertNotEqual(secrets["JWT_SECRET"], secrets["PROVIDER_SECRET_KEY"])

        directory = self.checkout / "data/managed-runners"
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        for name in ("token", "channel.json", "profile.json"):
            self.assertEqual(stat.S_IMODE((directory / name).stat().st_mode), 0o600, name)
        token = (directory / "token").read_text().strip()
        self.assertRegex(token, r"^[0-9a-f]{64}$")

        channel = load_channel().parse_config(json.loads((directory / "channel.json").read_text()))
        profile = json.loads((directory / "profile.json").read_text())
        self.assertEqual(profile["backend"], "docker")
        self.assertEqual(profile["valueKind"], "actual")
        self.assertEqual(channel["image"], IMAGE_ID)
        self.assertEqual(profile["runner"]["image"], IMAGE_ID)
        self.assertEqual(channel["instanceId"], profile["docker"]["instanceId"])
        self.assertEqual(channel["network"], "orbit-managed-runners")
        self.assertEqual(profile["runner"]["serverUrl"], f"http://{GATEWAY}:2086")
        # Both name the files where root Compose mounts the directory.
        self.assertEqual(channel["listen"]["unixSocket"], profile["docker"]["channel"]["socketPath"])
        self.assertEqual(channel["tokenFile"], profile["docker"]["tokenFile"])
        self.assertTrue(channel["tokenFile"].startswith("/var/lib/orbit-managed-runners/"))
        self.assertNotIn(token, (directory / "channel.json").read_text() + (directory / "profile.json").read_text())

        calls = self.calls()
        self.assertIn("network create --driver bridge --opt com.docker.network.bridge.enable_icc=false orbit-managed-runners", calls)
        # Built, the database up, its migrations applied, then the stack: the apiserver's first boot has none left.
        started = [c for c in calls if c.startswith(("compose build", "compose up", "compose run"))]
        self.assertEqual([c.split(" sh -c ")[0] for c in started], [
            "compose build",
            "compose up -d --wait --wait-timeout 300 postgres",
            "compose run --rm --no-deps apiserver",
            "compose up -d --wait --wait-timeout 900",
        ])
        self.assertIn("migrate deploy", started[2])
        self.assertFalse([c for c in calls if c.startswith(("build", "push", "image push", "login"))], calls)

    def test_a_fresh_install_builds_the_managed_runner_image_here_and_pushes_nothing(self):
        run = self.run_script(INSTALL, "--no-start")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        head = self.git("rev-parse", "HEAD")
        calls = self.calls()
        self.assertIn(f"build -f deploy/managed-runner/image/Dockerfile --build-arg ORBIT_SOURCE_SHA={head} "
                      "-t orbit-managed-runner:local .", calls)
        self.assertIn("image inspect -f {{.Id}} orbit-managed-runner:local", calls)
        self.assertFalse([c for c in calls if re.match(r"(image )?push|login|compose up", c)], calls)
        self.assertEqual(json.loads((self.checkout / "data/managed-runners/profile.json").read_text())["runner"]["image"],
                         IMAGE_ID)

    def test_an_install_without_managed_runners_writes_the_switch_off(self):
        run = self.run_script(INSTALL, "--no-managed-runners", "--no-start")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        live = self.live_lines((self.checkout / ".env").read_text())
        self.assertIn("ORBIT_MANAGED_RUNNERS_ENABLED=false", live)
        self.assertFalse([line for line in live if line.startswith(("ORBIT_MANAGED_RUNNERS_DIR=", "COMPOSE_PROFILES="))])
        self.assertFalse((self.checkout / "data/managed-runners").exists())
        self.assertEqual([c for c in self.calls() if not c.startswith("compose version")], [])

    def test_an_install_never_touches_an_existing_deployment(self):
        existing = 'JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\n'
        (self.checkout / ".env").write_text(existing)
        run = self.run_script(INSTALL)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("upgrade", run.stderr)
        self.assertEqual((self.checkout / ".env").read_text(), existing)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.checkout / "data").exists())
        # A database without its .env is a deployment too.
        (self.checkout / ".env").unlink()
        (self.checkout / "data/postgres").mkdir(parents=True)
        run = self.run_script(INSTALL)
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse((self.checkout / ".env").exists())
        self.assertFalse((self.checkout / "data/managed-runners").exists())
        self.assertEqual(self.calls(), [])

    # ── an administrator's explicit choice ────────────────────────────────────────────────────

    def test_an_administrator_switches_managed_runners_on_for_an_existing_deployment(self):
        # Installed with them off: the switch is replaced, every other line kept as it was.
        existing = ('JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\nPUBLIC_ORIGIN="https://orbit.example.com"\n'
                    "ORBIT_MANAGED_RUNNERS_ENABLED=false\n")
        (self.checkout / ".env").write_text(existing)
        (self.checkout / ".env").chmod(0o600)
        run = self.run_script(INSTALL, "--enable-managed-runners", "--managed-runner-image", "orbit-managed-runner:fixture")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        text = (self.checkout / ".env").read_text()
        live = self.live_lines(text)
        self.assertEqual(live, [line for line in existing.splitlines() if not line.startswith("ORBIT_MANAGED_RUNNERS_ENABLED=")]
                         + SWITCH_LINES)
        self.assertEqual(stat.S_IMODE((self.checkout / ".env").stat().st_mode), 0o600)
        profile = json.loads((self.checkout / "data/managed-runners/profile.json").read_text())
        self.assertEqual((profile["backend"], profile["runner"]["image"]), ("docker", IMAGE_ID))
        calls = self.calls()
        self.assertIn("compose build docker-channel", calls)
        self.assertIn("compose up -d --wait --wait-timeout 300 --no-deps docker-channel apiserver", calls)
        # The apiserver is recreated from the image it runs: switching managed runners on deploys nothing else.
        self.assertFalse([c for c in calls if c.startswith(("compose up -d --build", "compose build apiserver"))], calls)

    def test_switching_on_refuses_where_there_is_no_deployment_or_it_was_prepared_already(self):
        run = self.run_script(INSTALL, "--enable-managed-runners")
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse((self.checkout / ".env").exists())
        prepared = 'JWT_SECRET="kept"\n' + "\n".join(SWITCH_LINES).replace("=true", "=false") + "\n"
        (self.checkout / ".env").write_text(prepared)
        run = self.run_script(INSTALL, "--enable-managed-runners")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("ORBIT_MANAGED_RUNNERS_ENABLED", run.stderr)
        self.assertEqual((self.checkout / ".env").read_text(), prepared)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.checkout / "data").exists())

    # ── the upgrade ───────────────────────────────────────────────────────────────────────────

    # What each copy of /upgrade asked of Docker for a deployment without managed runners before it kept their
    # image current (both copies at c16d115b3, run exactly as below): that path is unchanged, call for call.
    BEFORE_IMAGE_UPGRADES = {
        ".claude/skills/upgrade/upgrade.sh": [
            "compose version",
            "inspect --format {{.Image}} orbit-web",
            "compose config --services",
            "compose build apiserver wiki-worker web",
            "compose up -d --wait apiserver wiki-worker web gateway",
            "compose ps",
        ],
        ".agents/skills/upgrade/scripts/upgrade.sh": [
            "compose version",
            "compose config --services",
            "compose build apiserver wiki-worker web",
            "compose run --rm --no-deps apiserver /bin/sh -c cd src/apiserver && node "
            "\"$(node -p 'require.resolve(\"prisma/build/index.js\")')\" migrate deploy",
            "compose up -d --wait --no-deps apiserver wiki-worker web gateway",
            "compose ps",
        ],
    }

    def test_an_upgrade_does_for_an_existing_deployment_exactly_what_it_did(self):
        # A deployment installed before managed runners, as orbitd.io was: .env.example's lines, nothing about them.
        existing = 'JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\nPUBLIC_ORIGIN="http://localhost:2086"\n'
        for upgrade in UPGRADES:
            with self.subTest(upgrade=upgrade):
                (self.checkout / ".env").write_text(existing)
                run = self.run_script(upgrade, "--no-pull")
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual((self.checkout / ".env").read_text(), existing, "/upgrade wrote .env")
                self.assertEqual(self.calls(), self.BEFORE_IMAGE_UPGRADES[upgrade],
                                 "the same Docker calls, in the same order, as before")
                self.assertFalse((self.checkout / "data").exists(), "/upgrade wrote under data/")
                self.assertNotIn("managed runner", (run.stdout + run.stderr).lower())

    # ── the upgrade of a new deployment's managed runners ─────────────────────────────────────

    NEW_IMAGE_ID = "sha256:" + "cd" * 32
    DIRECTORY = "data/managed-runners"

    def fresh_install(self):
        """A new deployment, installed from scratch on IMAGE_ID: the bytes of its managed runners' files."""
        for leftover in (self.checkout / ".env", self.log.with_name(self.log.name + ".apiserver")):
            leftover.unlink(missing_ok=True)
        shutil.rmtree(self.checkout / "data", ignore_errors=True)
        run = self.run_script(INSTALL, "--no-start", FAKE_IMAGE_ID=IMAGE_ID)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        return self.managed_files()

    def managed_files(self):
        directory = self.checkout / self.DIRECTORY
        return {path.name: path.read_bytes() for path in sorted(directory.iterdir()) if path.is_file()}

    def ups(self):
        return [c for c in self.calls() if c.startswith("compose up")]

    def test_an_upgrade_rebuilds_the_managed_runner_image_and_names_its_id_in_both_files(self):
        for upgrade in UPGRADES:
            with self.subTest(upgrade=upgrade):
                before = self.fresh_install()
                env_before = (self.checkout / ".env").read_bytes()
                run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual((self.checkout / ".env").read_bytes(), env_before, "/upgrade wrote .env")

                # The two files name the new ID, and nothing else in them, or in the directory, changed.
                after = self.managed_files()
                self.assertEqual(sorted(after), ["channel.json", "profile.json", "token"], "no temporary file or marker left")
                self.assertEqual(after["token"], before["token"])
                for name in ("channel.json", "profile.json"):
                    self.assertEqual(after[name].decode(), before[name].decode().replace(IMAGE_ID, self.NEW_IMAGE_ID), name)
                    self.assertEqual(stat.S_IMODE((self.checkout / self.DIRECTORY / name).stat().st_mode), 0o600, name)
                channel = load_channel().parse_config(json.loads(after["channel.json"]))
                profile = json.loads(after["profile.json"])
                self.assertEqual((channel["image"], profile["runner"]["image"]), (self.NEW_IMAGE_ID, self.NEW_IMAGE_ID))

                # Built from this checkout, here: the channel with the other images, then the managed runner image.
                calls = self.calls()
                head = self.git("rev-parse", "HEAD")
                images = "compose build apiserver wiki-worker web docker-channel"
                runner = (f"build -f deploy/managed-runner/image/Dockerfile --build-arg ORBIT_SOURCE_SHA={head} "
                          "-t orbit-managed-runner:local .")
                self.assertLess(calls.index(images), calls.index(runner), calls)
                self.assertIn("image inspect -f {{.Id}} orbit-managed-runner:local", calls)
                self.assertFalse([c for c in calls if re.match(r"(image )?(push|tag)\b|login\b", c)], calls)
                # The other services first, then the apiserver, which that did not recreate, then the channel, last.
                self.assertRegex(self.ups()[0], r"^compose up -d --wait (--no-deps )?apiserver wiki-worker web gateway$")
                self.assertEqual(self.ups()[1:], ["compose up -d --wait --no-deps --force-recreate apiserver",
                                                  "compose up -d --wait --no-deps --force-recreate docker-channel"])
                self.assertIn(f"The managed runner image is now {self.NEW_IMAGE_ID}", run.stdout)

    def test_an_apiserver_the_upgrade_recreated_already_is_not_recreated_again(self):
        for upgrade in UPGRADES:
            with self.subTest(upgrade=upgrade):
                self.fresh_install()
                run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID, FAKE_APISERVER_IMAGE_CHANGED="1")
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual(self.ups()[1:], ["compose up -d --wait --no-deps --force-recreate docker-channel"])

    def test_an_upgrade_that_builds_the_same_image_changes_nothing_of_managed_runners(self):
        for upgrade in UPGRADES:
            with self.subTest(upgrade=upgrade):
                self.fresh_install()
                self.assertEqual(self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID).returncode, 0)
                switched = self.managed_files()
                stamps = {name: (self.checkout / self.DIRECTORY / name).stat().st_mtime_ns for name in switched}
                run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual(self.managed_files(), switched)
                self.assertEqual({name: (self.checkout / self.DIRECTORY / name).stat().st_mtime_ns for name in switched}, stamps,
                                 "neither file was rewritten")
                # Nothing forced: the channel is recreated only if its own image changed.
                self.assertEqual(self.ups()[1:], ["compose up -d --wait --no-deps docker-channel"])
                self.assertIn(f"The managed runner image is unchanged ({self.NEW_IMAGE_ID})", run.stdout)

    def test_a_switch_that_failed_before_the_channel_started_on_it_is_finished_by_the_next_upgrade(self):
        for upgrade in UPGRADES:
            with self.subTest(upgrade=upgrade):
                self.fresh_install()
                channel_up = "compose up -d --wait --no-deps --force-recreate docker-channel"
                run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID, FAKE_FAIL=channel_up)
                self.assertNotEqual(run.returncode, 0)
                marker = self.checkout / self.DIRECTORY / ".image-switch"
                self.assertEqual(marker.read_text().strip(), self.NEW_IMAGE_ID, "the switch is still marked unfinished")
                # The files already name the image the next run builds: the marker alone makes it start both again.
                run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual(self.ups()[1:], ["compose up -d --wait --no-deps --force-recreate apiserver", channel_up])
                self.assertFalse(marker.exists())

    def test_nothing_is_switched_when_the_upgrade_stops_before_its_services_are_recreated(self):
        head = self.git("rev-parse", "HEAD")
        image = f"build -f deploy/managed-runner/image/Dockerfile --build-arg ORBIT_SOURCE_SHA={head} -t orbit-managed-runner:local ."
        for upgrade in UPGRADES:
            failures = [image, "compose build *"]
            if upgrade.startswith(".agents/"):
                failures.append("compose run --rm --no-deps apiserver *")  # its migrations, before the switch
            for failing in failures:
                with self.subTest(upgrade=upgrade, failing=failing):
                    before = self.fresh_install()
                    run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID, FAKE_FAIL=failing)
                    self.assertNotEqual(run.returncode, 0)
                    self.assertEqual(self.managed_files(), before, "both files as they were, and no marker")
                    self.assertEqual(self.ups(), [], "nothing recreated")

    def test_with_pull_base_the_channel_still_follows_the_apiserver(self):
        for upgrade in UPGRADES:
            with self.subTest(upgrade=upgrade):
                self.fresh_install()
                run = self.run_script(upgrade, "--no-pull", "--pull-base", FAKE_IMAGE_ID=self.NEW_IMAGE_ID)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                ups = self.ups()
                self.assertEqual([c for c in ups if "docker-channel" in c], ups[-1:], "the channel only in the last recreate")
                self.assertEqual(ups[-1], "compose up -d --wait --no-deps --force-recreate docker-channel")
                if upgrade.startswith(".claude/"):
                    # The full recreate, every service Compose lists but the channel.
                    self.assertEqual(ups[0], "compose up -d --wait postgres apiserver wiki-worker web gateway pgbackup")

    def test_an_upgrade_refuses_before_building_where_the_managed_runners_files_are_not_right(self):
        installed = 'JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\n' + "\n".join(SWITCH_LINES) + "\n"
        twice = {"schemaVersion": 1, "image": IMAGE_ID, "runner": {"image": IMAGE_ID}}
        for upgrade in UPGRADES:
            for case in ("no directory", "a file naming two images"):
                with self.subTest(upgrade=upgrade, case=case):
                    shutil.rmtree(self.checkout / "data", ignore_errors=True)
                    (self.checkout / ".env").write_text(installed)
                    if case == "a file naming two images":
                        self.fresh_install()
                        (self.checkout / ".env").write_text(installed)
                        (self.checkout / self.DIRECTORY / "channel.json").write_text(json.dumps(twice))
                    before = self.managed_files() if (self.checkout / self.DIRECTORY).exists() else None
                    run = self.run_script(upgrade, "--no-pull", FAKE_IMAGE_ID=self.NEW_IMAGE_ID)
                    self.assertNotEqual(run.returncode, 0)
                    self.assertRegex(run.stderr, r"channel\.json")
                    self.assertFalse([c for c in self.calls() if re.match(r"(compose (build|up|run)|build) ", c)], self.calls())
                    if before is None:
                        self.assertFalse((self.checkout / "data").exists())
                    else:
                        self.assertEqual(self.managed_files(), before)

    def test_both_copies_keep_the_managed_runners_section_the_same(self):
        sections = []
        for upgrade in UPGRADES:
            text = (REPO / upgrade).read_text()
            start = text.index("# ── Managed runners' image: this section is the same in both copies")
            sections.append(text[start:text.index("# ── end of the managed runners' section", start)])
        self.assertEqual(sections[0], sections[1])
        self.assertIn("managed_runner_image_switch()", sections[0])

if __name__ == "__main__":
    unittest.main()
