#!/usr/bin/env python3
"""The restricted Docker channel (deploy/managed-runner/docker-channel/channel.py) against an
in-memory Docker Engine fake, through its real HTTP server on a scratch unix socket.

Covers what the channel decides: its configuration, the bearer token, the template and its safety
rules (an executable /tmp with a size limit among them), the refusal of every Docker parameter a
request may not carry, the instance label on everything it touches, one container per data volume
and a cap on all of them, credentials, the stop and removal of a container, volume removal (off
unless an operator turns it on), the disk limit and the disk it is measured on, and a create
interrupted by the channel stopping. The Docker calls themselves are exercised on a real daemon by
the Docker backend's integration run, not here.
"""

import copy
import errno
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tarfile
import tempfile
import threading
import unittest
import urllib.parse
import uuid


CHANNEL = Path(__file__).resolve().parents[2] / "deploy/managed-runner/docker-channel/channel.py"
sys.dont_write_bytecode = True

INSTANCE = "orbit-test-instance"
IMAGE = "sha256:" + "a" * 64
OTHER_IMAGE = "sha256:" + "b" * 64
OWNER = "0195c0de-0000-7000-8000-0000000000b1"
RUNNER = "0195c0de-0000-7000-8000-0000000000a1"
OTHER_RUNNER = "0195c0de-0000-7000-8000-0000000000a2"
TOKEN = "t" * 48
ZERO = "0001-01-01T00:00:00Z"


def load_channel():
    spec = importlib.util.spec_from_file_location("managed_runner_docker_channel", CHANNEL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.log = lambda message: None  # the request log is the service's, not the test's
    return module


class FakeDocker:
    """The part of the Engine API the channel uses, in memory, with Docker's answers for missing things."""

    def __init__(self, ch):
        self.ch = ch
        self.volumes_by_name = {}
        self.containers_by_name = {}
        self.images = {IMAGE: {"Id": IMAGE, "Config": {"Env": ["PATH=/usr/bin:/bin", "ORBIT_HOME=/var/lib/orbit/home/.orbit"]}}}
        self.networks = {"orbit-mr-test": {"Name": "orbit-mr-test", "Driver": "bridge", "Internal": True,
                                           "Options": {"com.docker.network.bridge.enable_icc": "false"}}}
        self.sizes = {}
        self.calls = []
        self.tamper = None
        self.stop_hook = None
        self.host = {"Name": "docker-host-a", "NCPU": 8, "MemTotal": 16 * 2 ** 30, "DockerRootDir": "/nonexistent-docker-root", "ServerVersion": "29.0"}

    # ── the client's surface ──
    def info(self):
        return dict(self.host)

    def volume_usage(self):
        self.calls.append(("df",))
        return dict(self.sizes)

    def image(self, ref):
        return copy.deepcopy(self.images.get(ref))

    def network(self, name):
        return copy.deepcopy(self.networks.get(name))

    def volume(self, name):
        found = self.volumes_by_name.get(name)
        return copy.deepcopy(found) if found else None

    def volumes(self, labels):
        return [copy.deepcopy(v) for v in self.volumes_by_name.values() if self.matches(v.get("Labels"), labels)]

    def create_volume(self, name, labels):
        self.calls.append(("create_volume", name))
        # Docker answers an existing name with the volume as it is.
        self.volumes_by_name.setdefault(name, {"Name": name, "Driver": "local", "Labels": dict(labels), "CreatedAt": "2026-10-17T00:00:00Z"})
        return copy.deepcopy(self.volumes_by_name[name])

    def remove_volume(self, name):
        self.calls.append(("remove_volume", name))
        if any(self.mounts(c, name) for c in self.containers_by_name.values()):
            raise self.ch.DockerError(409, "volume is in use")
        if name not in self.volumes_by_name:
            raise self.ch.DockerError(404, "no such volume")
        del self.volumes_by_name[name]

    def container(self, name):
        found = self.containers_by_name.get(name)
        return copy.deepcopy(found) if found else None

    def containers(self, labels=None, volume=None):
        found = []
        for c in self.containers_by_name.values():
            if labels and not self.matches(c["Config"]["Labels"], labels):
                continue
            if volume and not self.mounts(c, volume):
                continue
            found.append({"Names": [c["Name"]], "Labels": dict(c["Config"]["Labels"]), "State": c["State"]["Status"]})
        return found

    def create_container(self, name, spec):
        self.calls.append(("create_container", name))
        if name in self.containers_by_name:
            raise self.ch.DockerError(409, "name in use")
        if spec["Image"] not in self.images:
            raise self.ch.DockerError(404, "no such image")
        host = copy.deepcopy(spec["HostConfig"])
        if self.tamper:
            self.tamper(host)
        mounts = []
        for m in host.get("Mounts") or []:
            if m["Type"] == "volume":
                if m["Source"] not in self.volumes_by_name:
                    self.create_volume(m["Source"], (m.get("VolumeOptions") or {}).get("Labels") or {})
                mounts.append({"Type": "volume", "Name": m["Source"], "Source": f"/var/lib/docker/volumes/{m['Source']}/_data",
                               "Destination": m["Target"], "RW": not m.get("ReadOnly")})
            elif m["Type"] == "bind":
                mounts.append({"Type": "bind", "Source": m["Source"], "Destination": m["Target"]})
            else:
                mounts.append({"Type": "tmpfs", "Source": "", "Destination": m["Target"]})
        image_env = self.images[spec["Image"]]["Config"]["Env"]
        self.containers_by_name[name] = {
            "Id": uuid.uuid4().hex * 2, "Name": f"/{name}", "Image": spec["Image"],
            "Config": {"User": spec["User"], "Env": image_env + list(spec["Env"]), "Labels": dict(spec["Labels"]), "Image": spec["Image"]},
            "HostConfig": host, "Mounts": mounts,
            "State": {"Status": "created", "Running": False, "Paused": False, "ExitCode": 0, "StartedAt": ZERO, "FinishedAt": ZERO,
                      "OOMKilled": False, "Pid": 0},
            "archives": {},
        }
        return {"Id": self.containers_by_name[name]["Id"]}

    def put_archive(self, name, path, tar_bytes):
        self.calls.append(("put_archive", name, path))
        files = {}
        with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
            for member in tar.getmembers():
                files[member.name] = {"data": tar.extractfile(member).read().decode(), "mode": member.mode, "uid": member.uid, "gid": member.gid}
        self.containers_by_name[name]["archives"][path] = files

    def start_container(self, name):
        self.calls.append(("start_container", name))
        state = self.containers_by_name[name]["State"]
        state.update(Status="running", Running=True, StartedAt="2026-10-17T01:00:00.000000000Z", Pid=4242)

    def stop_container(self, name, seconds):
        self.calls.append(("stop_container", name, seconds))
        if self.stop_hook:
            self.stop_hook()
        self.exit(name, 143)

    def remove_container(self, name):
        self.calls.append(("remove_container", name))
        if self.containers_by_name[name]["State"]["Status"] in ("running", "paused", "restarting"):
            raise self.ch.DockerError(409, "stop the container before removing")
        del self.containers_by_name[name]

    # ── test controls ──
    def exit(self, name, code=0):
        state = self.containers_by_name[name]["State"]
        state.update(Status="exited", Running=False, ExitCode=code, FinishedAt="2026-10-17T02:00:00.000000000Z", Pid=0)

    def foreign_container(self, name, volume, labels=None):
        self.containers_by_name[name] = {
            "Id": uuid.uuid4().hex * 2, "Name": f"/{name}", "Image": OTHER_IMAGE,
            "Config": {"User": "", "Env": [], "Labels": labels or {}, "Image": OTHER_IMAGE}, "HostConfig": {},
            "Mounts": [{"Type": "volume", "Name": volume, "Destination": "/data"}],
            "State": {"Status": "running", "Running": True, "Paused": False, "ExitCode": 0, "StartedAt": "2026-10-17T00:00:00Z",
                      "FinishedAt": ZERO, "OOMKilled": False, "Pid": 99},
            "archives": {},
        }

    @staticmethod
    def matches(labels, wanted):
        labels = labels or {}
        for item in wanted or []:
            key, _, value = item.partition("=")
            if labels.get(key) != value:
                return False
        return True

    @staticmethod
    def mounts(container, volume):
        return any(m.get("Name") == volume for m in container.get("Mounts") or [])


class ChannelFixture(unittest.TestCase):
    def setUp(self):
        self.ch = load_channel()
        self.scratch = tempfile.TemporaryDirectory(prefix="docker-channel-test-")
        self.addCleanup(self.scratch.cleanup)
        root = Path(self.scratch.name)
        self.token_file = root / "token"
        self.token_file.write_text(TOKEN + "\n")
        self.token_file.chmod(0o600)
        self.config = self.ch.parse_config(self.config_value(root))
        self.docker = FakeDocker(self.ch)
        self.channel = self.ch.Channel(self.config, self.docker, TOKEN)
        self.channel.prepare()
        self.server = self.ch.make_server(self.config, self.channel)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()

    def config_value(self, root):
        return {
            "schemaVersion": 1,
            "instanceId": INSTANCE,
            "listen": {"unixSocket": str(root / "channel.sock")},
            "tokenFile": str(self.token_file),
            "dockerSocket": "/nonexistent/docker.sock",
            "stateDir": str(root / "state"),
            "image": IMAGE,
            "network": "orbit-mr-test",
            "limits": {"maxCpuMillis": 2000, "maxMemoryBytes": 4 * 2 ** 30, "maxPids": 2048, "maxTmpBytes": 2 ** 30,
                       "maxVolumeBytes": 50 * 2 ** 30, "maxConcurrent": 8},
            "stopGraceSeconds": 240,
            "diskCheckSeconds": 60,
            "extraLabels": {"orbit.test": "docker-channel-unit"},
        }

    def call(self, method, path, body=None, token=TOKEN, raw=None):
        connection = self.ch.UnixConnection(self.config["listen"]["unixSocket"], 10)
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if payload is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        try:
            return response.status, (json.loads(data) if data else None)
        except ValueError:
            return response.status, data.decode("utf-8", "replace")

    # ── helpers playing the backend ──
    def volume(self, runner=RUNNER, limit=10 * 2 ** 30):
        status, body = self.call("PUT", f"/v1/volumes/mr-data-{runner}", {"ownerId": OWNER, "runnerId": runner, "limitBytes": limit})
        self.assertEqual(status, 200, body)
        return body

    def credential(self, generation=1, runner=RUNNER, token="generation-1-credential-0123456789"):
        status, body = self.call("PUT", f"/v1/credentials/{runner}", {"ownerId": OWNER, "generation": generation, "token": token})
        self.assertEqual(status, 200, body)
        return body

    def request(self, volume_uid, generation=1, runner=RUNNER, **change):
        body = {
            "name": f"mr-{runner}", "image": IMAGE, "ownerId": OWNER, "runnerId": runner, "generation": generation,
            "volume": {"name": f"mr-data-{runner}", "uid": volume_uid},
            "resources": {"cpuMillis": 1000, "memoryBytes": 2 * 2 ** 30, "pids": 1024, "tmpBytes": 256 * 2 ** 20},
            "runner": {"serverUrl": "http://172.18.0.1:3000", "maxConcurrent": 2},
        }
        body.update(change)
        return body

    def running_container(self, generation=1):
        volume = self.volume()
        self.credential(generation)
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation))
        self.assertEqual(status, 201, body)
        return volume, body


class ConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.ch = load_channel()

    def valid(self):
        return {
            "schemaVersion": 1, "instanceId": "orbit-a", "listen": {"unixSocket": "/run/c.sock"}, "tokenFile": "/etc/t",
            "dockerSocket": "/var/run/docker.sock", "stateDir": "/var/lib/c", "image": IMAGE, "network": "orbit-mr",
            "limits": {"maxCpuMillis": 1, "maxMemoryBytes": 1, "maxPids": 1, "maxTmpBytes": 1, "maxVolumeBytes": 1, "maxConcurrent": 1},
            "stopGraceSeconds": 240, "diskCheckSeconds": 60,
        }

    def test_the_example_is_a_valid_configuration(self):
        example = json.loads((CHANNEL.parent / "channel.example.json").read_text())
        self.ch.parse_config(example)

    def test_a_valid_configuration_gets_its_defaults(self):
        config = self.ch.parse_config(self.valid())
        self.assertEqual((config["socketMode"], config["logMaxSize"], config["logMaxFiles"], config["allowVolumeRemoval"]),
                         (0o600, "10m", 3, False))
        self.assertNotIn("maxContainers", config["limits"], "derived from the host when the channel starts")
        capped = self.ch.parse_config({**self.valid(), "limits": {**self.valid()["limits"], "maxContainers": 12}})
        self.assertEqual(capped["limits"]["maxContainers"], 12)

    def test_the_default_container_cap_is_one_per_cpu_and_per_gib_of_memory(self):
        GiB = 2 ** 30
        for cpus, memory, cap in ((8, 16 * GiB, 8), (24, 15 * GiB + 1, 15), (2, 64 * GiB, 2), (64, 512 * 2 ** 20, 1), (0, 0, 1)):
            with self.subTest(cpus=cpus, memory=memory):
                self.assertEqual(self.ch.default_max_containers({"NCPU": cpus, "MemTotal": memory}), cap)

    def test_the_disk_probe_path_a_deployment_gives_is_a_default_the_configuration_overrides(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "channel.json"
            path.write_text(json.dumps(self.valid()))
            self.assertNotIn("diskProbePath", self.ch.serve_config(str(path)))
            self.assertEqual(self.ch.serve_config(str(path), "/var/lib/orbit-docker-volumes")["diskProbePath"], "/var/lib/orbit-docker-volumes")
            path.write_text(json.dumps({**self.valid(), "diskProbePath": "/srv/docker"}))
            self.assertEqual(self.ch.serve_config(str(path), "/var/lib/orbit-docker-volumes")["diskProbePath"], "/srv/docker")

    def test_every_problem_is_reported(self):
        for change, needle in (
            ({"network": "host"}, "network"), ({"network": "bridge"}, "network"), ({"network": "none"}, "network"),
            ({"image": "orbit-managed-runner:latest"}, "image"), ({"instanceId": "Has Spaces"}, "instanceId"),
            ({"listen": {"tcp": {"host": "0.0.0.0", "port": 7000}}}, "listen"), ({"tokenFile": "relative"}, "tokenFile"),
            ({"limits": {"maxCpuMillis": 1}}, "limits"), ({"privileged": True}, "privileged is not a configuration field"),
            ({"extraLabels": {"orbit.managed-runner.instance": "x"}}, "extraLabels"), ({"diskCheckSeconds": 1}, "diskCheckSeconds"),
            ({"socketMode": 0o666}, "socketMode"),
            ({"limits": {**self.valid()["limits"], "maxContainers": 0}}, "maxContainers"),
            ({"limits": {**self.valid()["limits"], "maxContainers": "8"}}, "maxContainers"),
            ({"limits": {**self.valid()["limits"], "maxVolumes": 8}}, "limits"),
            ({"diskProbePath": "relative/dir"}, "diskProbePath"),
        ):
            with self.subTest(change=change):
                value = {**self.valid(), **change}
                with self.assertRaisesRegex(ValueError, needle):
                    self.ch.parse_config(value)

    def test_the_token_file_must_be_private_and_long(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "token"
            path.write_text(TOKEN)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "only its owner"):
                self.ch.read_token(str(path))
            path.chmod(0o600)
            self.assertEqual(self.ch.read_token(str(path)), TOKEN)
            path.write_text("short")
            with self.assertRaisesRegex(ValueError, "at least 32"):
                self.ch.read_token(str(path))


class TemplateTest(ChannelFixture):
    def spec(self):
        return self.ch.container_spec(self.config, self.request(str(uuid.uuid4())), str(uuid.uuid4()))

    def test_the_template_keeps_every_rule(self):
        spec = self.spec()
        self.assertEqual(self.ch.unsafe(self.config, spec), [])
        host = spec["HostConfig"]
        self.assertEqual((host["Privileged"], host["CapDrop"], host["CapAdd"], host["ReadonlyRootfs"]), (False, ["ALL"], [], True))
        self.assertIn("no-new-privileges:true", host["SecurityOpt"])
        self.assertEqual((host["NanoCpus"], host["Memory"], host["MemorySwap"], host["PidsLimit"]), (10 ** 9, 2 * 2 ** 30, 2 * 2 ** 30, 1024))
        self.assertEqual(host["NetworkMode"], "orbit-mr-test")
        self.assertEqual([(m["Type"], m["Target"]) for m in host["Mounts"]],
                         [("volume", "/var/lib/orbit"), ("volume", "/run/orbit-bootstrap"), ("tmpfs", "/tmp")])
        # /tmp: executable (Docker keeps every tmpfs nosuid and nodev), sized, and held in the memory limit.
        self.assertEqual(host["Mounts"][2]["TmpfsOptions"], {"SizeBytes": 256 * 2 ** 20, "Mode": 0o1777, "Options": [["exec"]]})
        self.assertEqual(spec["User"], "10001:10001")
        env = dict(e.split("=", 1) for e in spec["Env"])
        self.assertEqual(env["ORBIT_RUNNER_CREDENTIAL_FILE"], "/run/orbit-bootstrap/token")
        self.assertEqual(env["ORBIT_MANAGED_RUNNER_INSTANCE_FILE"], "/run/orbit-bootstrap/instance.json")
        for forbidden in ("ORBIT_MANAGED_RUNNER_GENERATION", "ORBIT_MANAGED_RUNNER_POD_UID", "ORBIT_RUNNER_TOKEN"):
            self.assertNotIn(forbidden, env)

    def test_each_dangerous_change_is_caught(self):
        def bind_socket(spec):
            spec["HostConfig"]["Mounts"][1] = {"Type": "bind", "Source": "/var/run/docker.sock", "Target": "/run/orbit-bootstrap"}

        def socket_volume(spec):
            spec["HostConfig"]["Mounts"][0]["Source"] = "/var/run/docker.sock"

        cases = {
            "privileged mode": lambda s: s["HostConfig"].update(Privileged=True),
            "added capabilities": lambda s: s["HostConfig"].update(CapAdd=["SYS_ADMIN"]),
            "capabilities not all dropped": lambda s: s["HostConfig"].update(CapDrop=[]),
            "host directory binds": lambda s: s["HostConfig"].update(Binds=["/:/host"]),
            "a host directory mount": bind_socket,
            "a host path as a volume source": socket_volume,
            "a network other than the configured one": lambda s: s["HostConfig"].update(NetworkMode="host"),
            "a shared PID namespace": lambda s: s["HostConfig"].update(PidMode="host"),
            "a shared IPC namespace": lambda s: s["HostConfig"].update(IpcMode="host"),
            "a shared UTS namespace": lambda s: s["HostConfig"].update(UTSMode="host"),
            "devices": lambda s: s["HostConfig"].update(Devices=[{"PathOnHost": "/dev/kvm"}]),
            "a weakened security profile": lambda s: s["HostConfig"]["SecurityOpt"].append("seccomp=unconfined"),
            "a writable root filesystem": lambda s: s["HostConfig"].update(ReadonlyRootfs=False),
            "a user other than 10001:10001": lambda s: s.update(User="0:0"),
            "an image other than the configured one": lambda s: s.update(Image=OTHER_IMAGE),
            "an environment other than the runner's": lambda s: s["Env"].append("DOCKER_HOST=unix:///var/run/docker.sock"),
            "a missing CPU, memory or PID limit": lambda s: s["HostConfig"].update(PidsLimit=0),
            "published ports": lambda s: s["HostConfig"].update(PublishAllPorts=True),
            "a restart policy": lambda s: s["HostConfig"].update(RestartPolicy={"Name": "always"}),
            "a /tmp without a size limit": lambda s: s["HostConfig"]["Mounts"][2]["TmpfsOptions"].pop("SizeBytes"),
            "/tmp mount options other than exec": lambda s: s["HostConfig"]["Mounts"][2]["TmpfsOptions"].update(Options=[["exec"], ["suid"]]),
        }
        for problem, change in cases.items():
            with self.subTest(problem=problem):
                spec = self.spec()
                change(spec)
                self.assertIn(problem, self.ch.unsafe(self.config, spec))

    def test_what_docker_made_of_tmp_is_checked(self):
        spec = self.spec()
        inspected = {"Image": spec["Image"], "Config": {"User": spec["User"], "Env": spec["Env"]}, "HostConfig": spec["HostConfig"],
                     "Mounts": [{"Type": "volume", "Name": m["Source"], "Destination": m["Target"]} for m in spec["HostConfig"]["Mounts"][:2]]
                     + [{"Type": "tmpfs", "Destination": "/tmp"}]}
        self.assertEqual(self.ch.unsafe_container(self.config, inspected), [])
        # An engine older than 27 drops the option: its /tmp stays noexec, which is no breach of the rules.
        del inspected["HostConfig"]["Mounts"][2]["TmpfsOptions"]["Options"]
        self.assertEqual(self.ch.unsafe_container(self.config, inspected), [])
        inspected["HostConfig"]["Mounts"][2]["TmpfsOptions"]["Options"] = [["noexec"]]
        self.assertIn("/tmp mount options other than exec", self.ch.unsafe_container(self.config, inspected))
        inspected["HostConfig"]["Mounts"][2]["TmpfsOptions"] = {}
        self.assertIn("a /tmp without a size limit", self.ch.unsafe_container(self.config, inspected))

    def test_the_bootstrap_files_are_root_owned_and_read_only(self):
        archive = self.ch.bootstrap_archive("the-token", 3, {"runnerId": RUNNER, "generation": 3, "instanceUid": "u"})
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            members = {m.name: m for m in tar.getmembers()}
            self.assertEqual(sorted(members), ["generation", "instance.json", "token"])
            for member in members.values():
                self.assertEqual((member.uid, member.gid, member.mode), (0, 0, 0o444))
            self.assertEqual(tar.extractfile(members["token"]).read(), b"the-token")
            self.assertEqual(tar.extractfile(members["generation"]).read(), b"3")


class AuthenticationAndRoutesTest(ChannelFixture):
    def test_every_route_needs_the_token(self):
        for token in (None, "", "wrong-token-" + "x" * 40, TOKEN + "x"):
            with self.subTest(token=token):
                status, body = self.call("GET", "/v1/resources", token=token)
                self.assertEqual((status, body["code"]), (401, "UNAUTHENTICATED"))
        self.assertEqual(self.call("GET", "/v1/resources")[0], 200)

    def test_unknown_routes_methods_and_parameters_are_refused(self):
        self.assertEqual(self.call("GET", "/v1/containers/create")[1]["code"], "NAME_REFUSED")
        self.assertEqual(self.call("GET", "/containers/json")[0], 404)
        self.assertEqual(self.call("PATCH", f"/v1/volumes/mr-data-{RUNNER}")[0], 501)
        self.assertEqual(self.call("POST", f"/v1/volumes/mr-data-{RUNNER}", {})[0], 405)
        status, body = self.call("GET", "/v1/resources?all=1")
        self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"))
        status, body = self.call("PUT", f"/v1/volumes/mr-data-{RUNNER}", raw=b"{not json")
        self.assertEqual((status, body["code"]), (400, "BODY_REFUSED"))

    def test_an_identity_with_a_trailing_newline_is_not_canonical(self):
        # A `$` anchor also matches before a final newline: "<uuid>\n" once named a credential file and an owner label.
        status, body = self.call("PUT", f"/v1/credentials/{RUNNER}%0A", {"ownerId": OWNER, "generation": 1, "token": "c" * 32})
        self.assertEqual((status, body["code"]), (400, "NAME_REFUSED"))
        self.assertEqual(list((Path(self.config["stateDir"]) / "credentials").iterdir()), [])
        status, body = self.call("PUT", f"/v1/volumes/mr-data-{RUNNER}", {"ownerId": OWNER + "\n", "runnerId": RUNNER, "limitBytes": 1024})
        self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"))
        self.assertNotIn(f"mr-data-{RUNNER}", self.docker.volumes_by_name)
        status, body = self.call("PUT", f"/v1/credentials/{RUNNER}", {"ownerId": OWNER, "generation": 1, "token": "c" * 32 + "\n"})
        self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"))
        self.assertEqual(self.call("GET", f"/v1/fencing-receipts/{RUNNER}%0A")[1]["code"], "NAME_REFUSED")
        self.assertEqual(self.call("DELETE", f"/v1/credentials/{RUNNER}?uid={uuid.uuid4()}%0A")[1]["code"], "PARAMETER_REFUSED")


class VolumeTest(ChannelFixture):
    def test_a_data_volume_is_created_once_with_this_instance_s_labels(self):
        first = self.volume()
        labels = self.docker.volumes_by_name[f"mr-data-{RUNNER}"]["Labels"]
        self.assertEqual(labels["orbit.managed-runner.instance"], INSTANCE)
        self.assertEqual(labels["orbit.managed-runner.kind"], "data")
        self.assertEqual((labels["orbit.managed-runner.owner"], labels["orbit.managed-runner.runner"]), (OWNER, RUNNER))
        self.assertEqual(labels["orbit.managed-runner.disk-limit-bytes"], str(10 * 2 ** 30))
        self.assertEqual(labels["orbit.test"], "docker-channel-unit")
        self.assertEqual(first["uid"], labels["orbit.managed-runner.uid"])
        again = self.volume()
        self.assertEqual(again["uid"], first["uid"], "created once")
        self.assertEqual(self.docker.calls.count(("create_volume", f"mr-data-{RUNNER}")), 1)
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}")[1]["uid"], first["uid"])

    def test_a_volume_without_this_instance_s_label_is_never_read_adopted_or_removed(self):
        self.channel.config["allowVolumeRemoval"] = True  # even where an operator turned removal on
        for labels in ({}, {"orbit.managed-runner.instance": "another-instance", "orbit.managed-runner.kind": "data"}):
            with self.subTest(labels=labels):
                name = f"mr-data-{OTHER_RUNNER}"
                self.docker.volumes_by_name[name] = {"Name": name, "Labels": labels}
                self.assertEqual(self.call("GET", f"/v1/volumes/{name}")[0], 404)
                status, body = self.call("PUT", f"/v1/volumes/{name}", {"ownerId": OWNER, "runnerId": OTHER_RUNNER, "limitBytes": 1024})
                self.assertEqual((status, body["code"]), (409, "NOT_MANAGED"))
                self.assertEqual(self.call("DELETE", f"/v1/volumes/{name}?uid={uuid.uuid4()}")[0], 404)
                self.assertIn(name, self.docker.volumes_by_name)
                self.assertNotIn(name, [v["name"] for v in self.call("GET", "/v1/resources")[1]["volumes"]])

    def test_host_paths_and_sockets_are_not_volumes(self):
        for name in ("%2Fvar%2Frun%2Fdocker.sock", "docker.sock", "mr-data-not-a-uuid", "..", f"mr-{RUNNER}", "%2Fetc"):
            with self.subTest(name=name):
                status, body = self.call("PUT", f"/v1/volumes/{name}", {"ownerId": OWNER, "runnerId": RUNNER, "limitBytes": 1024})
                self.assertIn(status, (400, 404), body)
        status, body = self.call("PUT", f"/v1/volumes/mr-data-{RUNNER}", {"ownerId": OWNER, "runnerId": OTHER_RUNNER, "limitBytes": 1024})
        self.assertEqual((status, body["code"]), (400, "NAME_REFUSED"))
        status, body = self.call("PUT", f"/v1/volumes/mr-data-{RUNNER}", {"ownerId": OWNER, "runnerId": RUNNER, "limitBytes": 2 ** 50})
        self.assertEqual((status, body["code"]), (403, "LIMIT_REFUSED"))
        status, body = self.call("PUT", f"/v1/volumes/mr-data-{RUNNER}", {"ownerId": OWNER, "runnerId": RUNNER, "limitBytes": 1024, "driverOpts": {"device": "/"}})
        self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"))

    def test_holders_count_containers_of_any_label_and_name_only_ours(self):
        self.channel.config["allowVolumeRemoval"] = True  # an operator's removal, by UID, of a volume nothing holds
        volume = self.volume()
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}/holders")[1], {"holders": []})
        self.docker.foreign_container("someone-elses", f"mr-data-{RUNNER}")
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}/holders")[1], {"holders": [{"managed": False}]})
        status, body = self.call("DELETE", f"/v1/volumes/mr-data-{RUNNER}?uid={volume['uid']}")
        self.assertEqual((status, body["code"]), (409, "VOLUME_IN_USE"))
        del self.docker.containers_by_name["someone-elses"]
        self.assertEqual(self.call("DELETE", f"/v1/volumes/mr-data-{RUNNER}?uid={uuid.uuid4()}")[1]["code"], "UID_MISMATCH")
        self.assertEqual(self.call("DELETE", f"/v1/volumes/mr-data-{RUNNER}?uid={volume['uid']}")[0], 204)
        self.assertNotIn(f"mr-data-{RUNNER}", self.docker.volumes_by_name)


class VolumeRemovalTest(ChannelFixture):
    def test_volume_removal_is_off_unless_an_operator_turns_it_on(self):
        volume = self.volume()
        self.assertEqual(self.config["allowVolumeRemoval"], False, "off when the configuration does not name it")
        self.assertEqual(self.call("GET", "/v1/info")[1]["allowVolumeRemoval"], False)
        before = list(self.docker.calls)
        for uid in (volume["uid"], str(uuid.uuid4())):
            with self.subTest(uid=uid):
                status, body = self.call("DELETE", f"/v1/volumes/mr-data-{RUNNER}?uid={uid}")
                self.assertEqual((status, body["code"]), (403, "REMOVAL_REFUSED"))
                self.assertIn("allowVolumeRemoval", body["message"])
        self.assertEqual(self.docker.calls, before, "nothing was asked of Docker")
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}")[1]["uid"], volume["uid"], "the volume is there")
        # Malformed requests are still refused for what they are.
        self.assertEqual(self.call("DELETE", f"/v1/volumes/mr-data-{RUNNER}")[1]["code"], "PARAMETER_REFUSED")
        # Turned on (allowVolumeRemoval: true, read when the channel starts), the volume goes, by its UID.
        on = self.ch.Channel(self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "allowVolumeRemoval": True}), self.docker, TOKEN)
        on.prepare()
        self.server.channel = on
        self.assertEqual(self.call("GET", "/v1/info")[1]["allowVolumeRemoval"], True)
        self.assertEqual(self.call("DELETE", f"/v1/volumes/mr-data-{RUNNER}?uid={volume['uid']}")[0], 204)
        self.assertNotIn(f"mr-data-{RUNNER}", self.docker.volumes_by_name)

    def test_only_a_boolean_turns_it_on(self):
        for value in ("true", 1, None, "yes"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "allowVolumeRemoval must be true or false"):
                    self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "allowVolumeRemoval": value})


class CredentialTest(ChannelFixture):
    def test_a_credential_is_kept_once_privately_and_removed_by_uid(self):
        first = self.credential(1, token="first-credential-0123456789")
        again = self.credential(2, token="second-credential-0123456789")
        self.assertEqual((again["uid"], again["generation"], again["token"]), (first["uid"], 1, "first-credential-0123456789"), "issued once")
        path = Path(self.config["stateDir"]) / "credentials" / f"{RUNNER}.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        listed = self.call("GET", "/v1/resources")[1]["credentials"]
        self.assertEqual(listed, [{"uid": first["uid"], "ownerId": OWNER, "runnerId": RUNNER, "generation": 1, "createdAt": first["createdAt"]}])
        self.assertNotIn("token", json.dumps(listed), "a listing never carries a credential")
        self.assertEqual(self.call("DELETE", f"/v1/credentials/{RUNNER}?uid={uuid.uuid4()}")[1]["code"], "UID_MISMATCH")
        self.assertEqual(self.call("DELETE", f"/v1/credentials/{RUNNER}?uid={first['uid']}")[0], 204)
        self.assertEqual(self.call("GET", f"/v1/credentials/{RUNNER}")[0], 404)
        status, body = self.call("PUT", f"/v1/credentials/{RUNNER}", {"ownerId": OWNER, "generation": 1, "token": "short"})
        self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"))


class ContainerTest(ChannelFixture):
    def test_a_runner_container_is_made_from_the_template_with_its_bootstrap_files(self):
        volume, created = self.running_container()
        name = f"mr-{RUNNER}"
        stored = self.docker.containers_by_name[name]
        self.assertEqual(stored["State"]["Status"], "running")
        self.assertEqual(self.ch.unsafe_container(self.config, stored, self.channel.image_env), [])
        labels = stored["Config"]["Labels"]
        self.assertEqual((labels["orbit.managed-runner.instance"], labels["orbit.managed-runner.generation"],
                          labels["orbit.managed-runner.volume-uid"]), (INSTANCE, "1", volume["uid"]))
        self.assertTrue(self.ch.UUID.match(created["uid"]), "the instance UID is a canonical UUID")
        self.assertEqual(created["uid"], labels["orbit.managed-runner.uid"])
        files = stored["archives"]["/run/orbit-bootstrap"]
        self.assertEqual(files["token"]["data"], "generation-1-credential-0123456789")
        self.assertEqual(files["generation"]["data"], "1")
        self.assertEqual(json.loads(files["instance.json"]["data"]), {"runnerId": RUNNER, "generation": 1, "instanceUid": created["uid"]})
        self.assertTrue(all((f["uid"], f["mode"]) == (0, 0o444) for f in files.values()))
        environment = "\n".join(stored["Config"]["Env"])
        self.assertNotIn("generation-1-credential", environment, "the credential never reaches the environment")
        self.assertNotIn("instance.json\n", environment)
        self.assertEqual(self.docker.calls.index(("put_archive", name, "/run/orbit-bootstrap")) + 1,
                         self.docker.calls.index(("start_container", name)), "the files are there before it starts")
        self.assertEqual((created["running"], created["node"], created["volume"]), (True, "docker-host-a", f"mr-data-{RUNNER}"))
        boot = self.docker.volumes_by_name[f"mr-boot-{RUNNER}-g1"]["Labels"]
        self.assertEqual((boot["orbit.managed-runner.instance"], boot["orbit.managed-runner.kind"]), (INSTANCE, "bootstrap"))

    def test_a_create_is_answered_once(self):
        volume, created = self.running_container()
        status, again = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, again["uid"]), (200, created["uid"]))
        self.assertEqual(self.docker.calls.count(("create_container", f"mr-{RUNNER}")), 1)
        self.docker.exit(f"mr-{RUNNER}", 0)
        status, again = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, again["status"]), (200, "exited"), "a stopped container is never started again")
        self.assertEqual(self.docker.calls.count(("start_container", f"mr-{RUNNER}")), 1)

    def test_docker_parameters_are_refused_by_name(self):
        volume = self.volume()
        self.credential()
        for key, value in (("privileged", True), ("Privileged", True), ("capAdd", ["SYS_ADMIN"]), ("CapAdd", ["ALL"]),
                           ("binds", ["/:/host"]), ("mounts", [{"Type": "bind", "Source": "/var/run/docker.sock"}]),
                           ("volumes", {"/var/run/docker.sock": {}}), ("networkMode", "host"), ("NetworkMode", "host"),
                           ("pidMode", "host"), ("ipcMode", "host"), ("utsMode", "host"), ("devices", ["/dev/kvm"]),
                           ("deviceRequests", [{"Count": -1}]), ("securityOpt", ["seccomp=unconfined"]),
                           ("hostConfig", {"Privileged": True}), ("HostConfig", {}), ("env", ["DOCKER_HOST=x"]),
                           ("user", "0"), ("entrypoint", ["sh"]), ("cmd", ["sh"]), ("labels", {"a": "b"}),
                           ("sysctls", {"net.ipv4.ip_forward": "1"}), ("cgroupParent", "/")):
            with self.subTest(parameter=key):
                status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], **{key: value}))
                self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"), body)
                self.assertIn(repr(key), body["message"])
        for where, change in (("volume", {"readOnly": False, "driver": "local"}), ("resources", {"devices": ["/dev/sda"]}),
                              ("runner", {"env": {"A": "b"}})):
            with self.subTest(where=where):
                request = self.request(volume["uid"])
                request[where] = {**request[where], **change}
                status, body = self.call("POST", "/v1/containers", request)
                self.assertEqual((status, body["code"]), (400, "PARAMETER_REFUSED"), body)
        self.assertNotIn(f"mr-{RUNNER}", self.docker.containers_by_name, "nothing was created")

    def test_other_images_volumes_names_and_amounts_are_refused(self):
        volume = self.volume()
        self.credential()
        uid = volume["uid"]
        cases = [
            (self.request(uid, image=OTHER_IMAGE), 403, "IMAGE_REFUSED"),
            (self.request(uid, image="alpine:3"), 403, "IMAGE_REFUSED"),
            (self.request(uid, volume={"name": "/var/run/docker.sock", "uid": uid}), 400, "NAME_REFUSED"),
            (self.request(uid, volume={"name": "/", "uid": uid}), 400, "NAME_REFUSED"),
            (self.request(uid, volume={"name": f"mr-data-{OTHER_RUNNER}", "uid": uid}), 403, "VOLUME_REFUSED"),
            (self.request(uid, resources={"cpuMillis": 64000, "memoryBytes": 2 ** 30, "pids": 10, "tmpBytes": 10}), 403, "LIMIT_REFUSED"),
            (self.request(uid, resources={"cpuMillis": 1000, "memoryBytes": 2 ** 30, "pids": 10 ** 6, "tmpBytes": 10}), 403, "LIMIT_REFUSED"),
            (self.request(uid, resources={"cpuMillis": 1000, "memoryBytes": 2 ** 30, "pids": 0, "tmpBytes": 10}), 400, "PARAMETER_REFUSED"),
            (self.request(uid, resources={"cpuMillis": 1000, "memoryBytes": 2 ** 20, "pids": 10, "tmpBytes": 2 ** 21}), 400, "PARAMETER_REFUSED"),
            (self.request(uid, runner={"serverUrl": "http://user:pass@host", "maxConcurrent": 1}), 400, "PARAMETER_REFUSED"),
            (self.request(uid, runner={"serverUrl": "file:///var/run/docker.sock", "maxConcurrent": 1}), 400, "PARAMETER_REFUSED"),
            (self.request(uid, name=f"mr-{RUNNER}-second"), 409, "SINGLE_CONTAINER_GUARD"),
            (self.request(uid, name="debug-shell"), 409, "SINGLE_CONTAINER_GUARD"),
            (self.request(uid, name=f"mr-{OTHER_RUNNER}"), 409, "SINGLE_CONTAINER_GUARD"),
        ]
        for request, status, code in cases:
            with self.subTest(code=code, request=json.dumps(request)[-160:]):
                answer = self.call("POST", "/v1/containers", request)
                self.assertEqual((answer[0], answer[1]["code"]), (status, code), answer)
        self.assertEqual(self.docker.containers_by_name, {}, "nothing was created")

    def test_the_guard_probe_is_refused_by_the_guard_and_a_dry_run_creates_nothing(self):
        uid = str(uuid.uuid4())
        status, body = self.call("POST", "/v1/containers", self.request(uid, name=f"mr-{RUNNER}-guard-probe", dryRun=True))
        self.assertEqual((status, body["code"]), (409, "SINGLE_CONTAINER_GUARD"))
        status, body = self.call("POST", "/v1/containers", self.request(uid, dryRun=True))
        self.assertEqual((status, body), (200, {"dryRun": True, "admitted": True}))
        self.assertEqual(self.docker.calls, [], "a dry run touches nothing")

    def test_one_container_per_volume(self):
        volume = self.volume()
        self.credential()
        self.docker.foreign_container("hand-made", f"mr-data-{RUNNER}")
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, body["code"]), (409, "VOLUME_IN_USE"))
        del self.docker.containers_by_name["hand-made"]
        status, body = self.call("POST", "/v1/containers", self.request(str(uuid.uuid4())))
        self.assertEqual((status, body["code"]), (409, "VOLUME_REFUSED"), "the volume this runner was authorized for, by UID")
        self.call("POST", "/v1/containers", self.request(volume["uid"]))
        # The next generation while this one is still there: refused until its stop is proven and it is removed.
        self.call("DELETE", f"/v1/credentials/{RUNNER}?uid={self.call('GET', f'/v1/credentials/{RUNNER}')[1]['uid']}")
        self.credential(2, token="generation-2-credential-0123456789")
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation=2))
        self.assertEqual((status, body["code"]), (409, "CONTAINER_CONFLICT"))
        self.docker.exit(f"mr-{RUNNER}")
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation=2))
        self.assertEqual((status, body["code"]), (409, "CONTAINER_CONFLICT"), "exited is not removed")

    def test_concurrent_creates_make_one_container(self):
        volume = self.volume()
        self.credential()
        answers = []

        def create():
            answers.append(self.call("POST", "/v1/containers", self.request(volume["uid"])))

        threads = [threading.Thread(target=create) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(a[0] for a in answers), [200] * 7 + [201])
        self.assertEqual(len({a[1]["uid"] for a in answers}), 1)
        self.assertEqual(self.docker.calls.count(("create_container", f"mr-{RUNNER}")), 1)

    def test_a_container_needs_its_generation_s_credential(self):
        volume = self.volume()
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, body["code"]), (409, "CREDENTIAL_MISSING"))
        self.credential(2, token="generation-2-credential-0123456789")
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation=1))
        self.assertEqual((status, body["code"]), (409, "CREDENTIAL_MISSING"), "another generation's credential is not this one's")

    def test_what_docker_made_is_checked_and_a_bad_container_never_starts(self):
        volume = self.volume()
        self.credential()
        self.docker.tamper = lambda host: host.update(Privileged=True)
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, body["code"]), (500, "TEMPLATE_VIOLATION"))
        self.assertIn("privileged mode", body["message"])
        self.assertNotIn(f"mr-{RUNNER}", self.docker.containers_by_name, "removed before it ever started")
        self.assertNotIn(("start_container", f"mr-{RUNNER}"), self.docker.calls)

    def test_stop_and_removal_by_uid_report_the_exit(self):
        volume, created = self.running_container()
        name = f"mr-{RUNNER}"
        status, body = self.call("DELETE", f"/v1/containers/{name}?uid={created['uid']}")
        self.assertEqual((status, body["code"]), (409, "CONTAINER_RUNNING"), "never removed while it runs")
        self.assertEqual(self.call("POST", f"/v1/containers/{name}/stop?uid={uuid.uuid4()}")[1]["code"], "UID_MISMATCH")
        stopped = threading.Event()
        self.docker.stop_hook = stopped.set
        status, body = self.call("POST", f"/v1/containers/{name}/stop?uid={created['uid']}")
        self.assertEqual((status, body["stopping"]), (202, True))
        self.assertTrue(stopped.wait(5))
        for _ in range(100):
            view = self.call("GET", f"/v1/containers/{name}")[1]
            if view["status"] == "exited":
                break
            threading.Event().wait(0.02)
        self.assertEqual((view["status"], view["running"], view["exitCode"], view["finishedAt"]),
                         ("exited", False, 143, "2026-10-17T02:00:00.000000000Z"))
        self.assertIn(("stop_container", name, 240), self.docker.calls, "with the configured grace")
        self.assertEqual(self.call("DELETE", f"/v1/containers/{name}?uid={uuid.uuid4()}")[1]["code"], "UID_MISMATCH")
        self.assertEqual(self.call("DELETE", f"/v1/containers/{name}?uid={created['uid']}")[0], 204)
        self.assertEqual(self.call("GET", f"/v1/containers/{name}")[0], 404, "removed: gone")
        self.assertNotIn(f"mr-boot-{RUNNER}-g1", self.docker.volumes_by_name, "its bootstrap volume went with it")
        self.assertIn(f"mr-data-{RUNNER}", self.docker.volumes_by_name, "the data volume stays")
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}/holders")[1], {"holders": []})

    def test_another_instance_s_container_is_invisible(self):
        self.docker.foreign_container(f"mr-{RUNNER}", f"mr-data-{RUNNER}", {"orbit.managed-runner.instance": "another"})
        self.assertEqual(self.call("GET", f"/v1/containers/mr-{RUNNER}")[0], 404)
        self.assertEqual(self.call("POST", f"/v1/containers/mr-{RUNNER}/stop?uid={uuid.uuid4()}")[0], 404)
        self.assertEqual(self.call("DELETE", f"/v1/containers/mr-{RUNNER}?uid={uuid.uuid4()}")[0], 404)
        self.assertEqual(self.call("GET", "/v1/resources")[1]["containers"], [])
        volume = self.volume()
        self.credential()
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, body["code"]), (409, "NOT_MANAGED"))
        self.assertEqual(self.docker.containers_by_name[f"mr-{RUNNER}"]["State"]["Status"], "running", "left alone")


class ContainerLimitTest(ChannelFixture):
    """No more containers of this instance than limits.maxContainers, whoever holds the token: a create at the cap is
    refused before anything is made, and the containers already there go on as they were."""

    RUNNERS = [f"0195c0de-0000-7000-8000-0000000001{i:02x}" for i in range(6)]

    def restart(self, **limits):
        self.config = self.ch.parse_config({**self.config_value(Path(self.scratch.name)),
                                            "limits": {**self.config_value(Path(self.scratch.name))["limits"], **limits}})
        self.channel = self.ch.Channel(self.config, self.docker, TOKEN)
        self.channel.prepare()
        self.server.channel = self.channel

    def start(self, runner):
        volume = self.volume(runner)
        self.credential(runner=runner, token=f"credential-of-{runner}")
        return volume, self.call("POST", "/v1/containers", self.request(volume["uid"], runner=runner))

    def test_the_cap_is_derived_from_the_host_unless_configured(self):
        self.assertEqual(self.call("GET", "/v1/info")[1]["limits"]["maxContainers"], 8, "8 CPUs, 16 GiB")
        self.docker.host.update(NCPU=24, MemTotal=15 * 2 ** 30)
        self.restart()
        self.assertEqual(self.call("GET", "/v1/info")[1]["limits"]["maxContainers"], 15, "24 CPUs, 15 GiB")
        self.restart(maxContainers=3)
        info = self.call("GET", "/v1/info")[1]["limits"]
        self.assertEqual((info["maxContainers"], info["maxCpuMillis"]), (3, 2000))

    def test_a_create_at_the_cap_is_refused_and_the_containers_there_go_on(self):
        self.restart(maxContainers=2)
        first, second, third = self.RUNNERS[:3]
        made = {}
        for runner in (first, second):
            _, (status, body) = self.start(runner)
            self.assertEqual(status, 201, body)
            made[runner] = body["uid"]
        before = copy.deepcopy(self.docker.containers_by_name)
        volume, (status, body) = self.start(third)
        self.assertEqual((status, body["code"]), (429, "CONTAINER_LIMIT"))
        self.assertIn("limits.maxContainers 2", body["message"])
        self.assertNotIn(("create_container", f"mr-{third}"), self.docker.calls, "nothing was made")
        self.assertNotIn(f"mr-boot-{third}-g1", self.docker.volumes_by_name)
        self.assertEqual(self.docker.containers_by_name, before, "the containers there are exactly as they were")
        self.assertFalse([c for c in self.docker.calls if c[0] in ("stop_container", "remove_container")])
        for runner, uid in made.items():
            view = self.call("GET", f"/v1/containers/mr-{runner}")[1]
            self.assertEqual((view["uid"], view["status"]), (uid, "running"))
        # The refused runner keeps its volume and credential: once a container is removed, the same request is made.
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{third}")[1]["uid"], volume["uid"])
        self.assertEqual(self.call("GET", f"/v1/credentials/{third}")[0], 200)
        self.docker.exit(f"mr-{second}")
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], runner=third))
        self.assertEqual((status, body["code"]), (429, "CONTAINER_LIMIT"), "an exited container still counts until it is removed")
        self.assertEqual(self.call("DELETE", f"/v1/containers/mr-{second}?uid={made[second]}")[0], 204)
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], runner=third))
        self.assertEqual(status, 201, body)

    def test_a_container_already_made_is_answered_at_the_cap(self):
        self.restart(maxContainers=1)
        volume, (status, created) = self.start(self.RUNNERS[0])
        self.assertEqual(status, 201, created)
        status, again = self.call("POST", "/v1/containers", self.request(volume["uid"], runner=self.RUNNERS[0]))
        self.assertEqual((status, again["uid"]), (200, created["uid"]), "the create answered once, not a second container")
        status, probe = self.call("POST", "/v1/containers", self.request(volume["uid"], runner=self.RUNNERS[0], name=f"mr-{self.RUNNERS[0]}-guard-probe", dryRun=True))
        self.assertEqual((status, probe["code"]), (409, "SINGLE_CONTAINER_GUARD"), "the manager's guard probe is unchanged")

    def test_only_this_instance_s_containers_count(self):
        self.restart(maxContainers=1)
        self.docker.foreign_container("someone-elses", "unrelated")
        self.docker.foreign_container(f"mr-{OTHER_RUNNER}", f"mr-data-{OTHER_RUNNER}", {"orbit.managed-runner.instance": "another"})
        _, (status, body) = self.start(self.RUNNERS[0])
        self.assertEqual(status, 201, body)

    def test_concurrent_creates_at_the_cap_make_one(self):
        self.restart(maxContainers=3)
        for runner in self.RUNNERS[:2]:
            self.assertEqual(self.start(runner)[1][0], 201)
        requests = []
        for runner in self.RUNNERS[2:6]:
            volume = self.volume(runner)
            self.credential(runner=runner, token=f"credential-of-{runner}")
            requests.append(self.request(volume["uid"], runner=runner))
        answers = []
        threads = [threading.Thread(target=lambda r=r: answers.append(self.call("POST", "/v1/containers", r))) for r in requests]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(a[0] for a in answers), [201, 429, 429, 429])
        self.assertEqual(len([c for c in self.docker.containers_by_name.values() if c["Config"]["Labels"].get("orbit.managed-runner.instance") == INSTANCE]), 3)


class DiskLimitTest(ChannelFixture):
    def test_a_container_over_its_volume_limit_is_stopped_and_not_started_again(self):
        volume, created = self.running_container()
        name, data = f"mr-{RUNNER}", f"mr-data-{RUNNER}"
        self.docker.sizes[data] = 10 * 2 ** 30
        self.assertEqual(self.channel.enforce_disk_limits(), [], "at the limit is within it")
        stopped = threading.Event()
        self.docker.stop_hook = stopped.set
        self.docker.sizes[data] = 10 * 2 ** 30 + 1
        self.assertEqual(self.channel.enforce_disk_limits(), [name])
        self.assertTrue(stopped.wait(5))
        for _ in range(100):
            view = self.call("GET", f"/v1/containers/{name}")[1]
            if view["status"] == "exited":
                break
            threading.Event().wait(0.02)
        self.assertEqual(view["evicted"]["reason"], "VOLUME_OVER_LIMIT")
        self.assertEqual((view["evicted"]["usageBytes"], view["evicted"]["limitBytes"]), (10 * 2 ** 30 + 1, 10 * 2 ** 30))
        self.assertEqual(self.call("DELETE", f"/v1/containers/{name}?uid={created['uid']}")[0], 204)
        self.assertFalse((Path(self.config["stateDir"]) / "evictions" / f"{created['uid']}.json").exists())
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, body["code"]), (409, "VOLUME_OVER_LIMIT"))
        self.channel.config["volumeLimitOverrides"][data] = 20 * 2 ** 30
        self.assertEqual(self.call("POST", "/v1/containers", self.request(volume["uid"]))[0], 201, "an operator's override lets it start")

    def test_a_full_state_disk_does_not_keep_an_over_limit_container_running(self):
        self.running_container()
        self.docker.sizes[f"mr-data-{RUNNER}"] = 10 * 2 ** 30 + 1
        stopped = threading.Event()
        self.docker.stop_hook = stopped.set

        def no_space(path, value):
            raise OSError(errno.ENOSPC, "No space left on device", str(path))

        self.ch.durable_write = no_space  # the eviction record cannot be written: the disk it is on is full
        self.assertEqual(self.channel.enforce_disk_limits(), [f"mr-{RUNNER}"])
        self.assertTrue(stopped.wait(5), "stopped although the reason could not be kept")


class RestartTest(ChannelFixture):
    def test_a_create_interrupted_before_start_is_finished_when_the_channel_starts_again(self):
        volume = self.volume()
        self.credential()
        request = self.request(volume["uid"])
        spec = self.ch.container_spec(self.config, request, str(uuid.uuid4()))
        self.docker.create_container(f"mr-{RUNNER}", spec)  # the channel stopped right after Docker's create
        restarted = self.ch.Channel(self.config, self.docker, TOKEN)
        restarted.prepare()
        stored = self.docker.containers_by_name[f"mr-{RUNNER}"]
        self.assertEqual(stored["State"]["Status"], "running")
        self.assertEqual(json.loads(stored["archives"]["/run/orbit-bootstrap"]["instance.json"]["data"])["instanceUid"],
                         stored["Config"]["Labels"]["orbit.managed-runner.uid"])

    def test_without_its_credential_it_is_left_never_started_for_the_manager(self):
        volume = self.volume()
        spec = self.ch.container_spec(self.config, self.request(volume["uid"]), str(uuid.uuid4()))
        self.docker.create_container(f"mr-{RUNNER}", spec)
        self.ch.Channel(self.config, self.docker, TOKEN).prepare()
        view = self.call("GET", f"/v1/containers/mr-{RUNNER}")[1]
        self.assertEqual((view["status"], view["neverStarted"], view["running"]), ("created", True, False))

    def test_state_survives_a_restart(self):
        volume, created = self.running_container()
        restarted = self.ch.Channel(self.config, self.docker, TOKEN)
        restarted.prepare()
        self.assertEqual(restarted.read_credential(RUNNER)["generation"], 1)
        self.assertEqual(restarted.read_container(f"mr-{RUNNER}")["uid"], created["uid"])
        self.assertEqual(restarted.read_volume(f"mr-data-{RUNNER}")["uid"], volume["uid"])


class FirewallGateTest(ChannelFixture):
    """Where the managed runners' host firewall is configured (firewall/config.json beside the channel's configuration,
    as scripts/install-server.sh writes it), no runner container is created or started unless the firewall service's
    status says its rules are in force: fresh, from this boot, for the bridge the configured network has now."""

    NETWORK_ID = "0078ad95b9cc" + "f" * 52

    def setUp(self):
        super().setUp()
        self.firewall = Path(self.scratch.name) / "firewall"
        self.firewall.mkdir()
        (self.firewall / "config.json").write_text("{}")
        self.docker.networks["orbit-mr-test"].update(Id=self.NETWORK_ID, IPAM={"Config": [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]})
        self.server.channel = self.channel = self.ch.Channel(self.config, self.docker, TOKEN, firewall_dir=self.firewall)
        self.channel.prepare()

    def status(self, **change):
        now = int(self.channel.clock())
        record = {"schemaVersion": 1, "state": "enforced", "network": "orbit-mr-test", "bridge": "br-0078ad95b9cc",
                  "gateway": "172.19.0.1", "apiPort": 2086, "backend": "nft", "checkedAt": now, "validUntil": now + 30,
                  "bootId": self.ch.boot_id()}
        record.update(change)
        (self.firewall / "status.json").write_text(json.dumps(record))

    def create(self):
        volume = self.volume()
        self.credential()
        return self.call("POST", "/v1/containers", self.request(volume["uid"]))

    def assert_refused(self, needle):
        status, body = self.create()
        self.assertEqual((status, body["code"]), (503, "FIREWALL_NOT_ENFORCED"), body)
        self.assertIn(needle, body["message"])
        self.assertFalse([c for c in self.docker.calls if c[0] in ("create_container", "start_container")], "nothing made or started")

    def test_with_the_rules_in_force_a_runner_container_starts(self):
        self.status()
        status, body = self.create()
        self.assertEqual(status, 201, body)
        self.assertTrue(body["running"])

    def test_without_a_status_nothing_starts(self):
        self.assert_refused("no status from the firewall service")

    def test_a_status_that_is_not_enforced_stale_or_from_before_the_boot_starts_nothing(self):
        for change, needle in (
                ({"state": "failing", "reason": "Docker's chains are in neither iptables backend"}, "neither iptables backend"),
                ({"state": "stopped", "reason": "the firewall service stopped; its rules stay"}, "'stopped'"),
                ({"state": "starting"}, "'starting'"),
                ({"validUntil": int(self.channel.clock()) - 1}, "has not confirmed its rules since"),
                ({"bootId": "a-boot-before-this-one"}, "before this host last started"),
                ({"schemaVersion": 2}, "not one this channel reads"),
        ):
            with self.subTest(change=change):
                self.status(**change)
                self.assert_refused(needle)

    def test_rules_for_another_bridge_or_gateway_start_nothing(self):
        # The network was removed and made again: a new ID, so a new bridge the rules do not match.
        self.status()
        self.docker.networks["orbit-mr-test"]["Id"] = "feedfacecafe" + "0" * 52
        self.assert_refused("network orbit-mr-test has br-feedfacecafe now")
        self.docker.networks["orbit-mr-test"]["Id"] = self.NETWORK_ID
        self.docker.networks["orbit-mr-test"]["IPAM"] = {"Config": [{"Subnet": "172.20.0.0/16", "Gateway": "172.20.0.1"}]}
        self.assert_refused("which network orbit-mr-test does not have")
        # A bridge named by the network's options is the one the rules must name.
        self.docker.networks["orbit-mr-test"].update(Options={"com.docker.network.bridge.name": "orbit-mr0"},
                                                     IPAM={"Config": [{"Gateway": "172.19.0.1"}]})
        self.status(bridge="orbit-mr0")
        self.assertEqual(self.create()[0], 201)

    def test_the_single_container_guard_s_dry_run_answers_whatever_the_firewall(self):
        volume = self.volume()
        self.credential()
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], name=f"mr-{RUNNER}-guard-probe", dryRun=True))
        self.assertEqual((status, body["code"]), (409, "SINGLE_CONTAINER_GUARD"))

    def test_a_container_created_and_never_started_waits_for_the_firewall(self):
        self.status()
        volume = self.volume()
        self.credential()
        spec = self.ch.container_spec(self.config, self.request(volume["uid"]), str(uuid.uuid4()))
        self.docker.create_container(f"mr-{RUNNER}", spec)  # the channel stopped right after Docker's create
        (self.firewall / "status.json").unlink()
        restarted = self.ch.Channel(self.config, self.docker, TOKEN, firewall_dir=self.firewall)
        restarted.prepare()
        self.assertEqual(self.docker.containers_by_name[f"mr-{RUNNER}"]["State"]["Status"], "created", "left for the manager")
        self.server.channel = restarted
        self.assertEqual(self.call("POST", "/v1/containers", self.request(volume["uid"]))[1]["code"], "FIREWALL_NOT_ENFORCED")
        self.status()
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"]))
        self.assertEqual((status, body["running"]), (200, True))

    def test_without_the_firewall_s_configuration_there_is_no_gate(self):
        (self.firewall / "config.json").unlink()
        self.assertEqual(self.create()[0], 201)

    def test_a_running_container_is_read_stopped_and_removed_whatever_the_firewall(self):
        self.status()
        volume, created = self.running_container()
        (self.firewall / "status.json").unlink()
        self.assertEqual(self.call("GET", f"/v1/containers/mr-{RUNNER}")[0], 200)
        stopped = threading.Event()
        self.docker.stop_hook = stopped.set
        self.assertEqual(self.call("POST", f"/v1/containers/mr-{RUNNER}/stop?uid={created['uid']}")[0], 202)
        self.assertTrue(stopped.wait(5))
        for _ in range(100):
            if self.call("GET", f"/v1/containers/mr-{RUNNER}")[1]["status"] == "exited":
                break
            threading.Event().wait(0.02)
        self.assertEqual(self.call("DELETE", f"/v1/containers/mr-{RUNNER}?uid={created['uid']}")[0], 204)


class ImageSwitchTest(ChannelFixture):
    """An upgrade restarts the channel on a new image (channel.json's `image`) while containers made from the
    previous one still run: those are this instance's as before — read, stopped and removed by UID — and every
    container made from then on comes from the new image, still one per data volume."""

    NEW = "sha256:" + "c" * 64

    def switch(self):
        """The channel restarted on a configuration naming the new image, built on this host."""
        self.docker.images[self.NEW] = {"Id": self.NEW, "Config": {"Env": ["PATH=/usr/bin:/bin", "ORBIT_HOME=/var/lib/orbit/home/.orbit"]}}
        self.config = self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "image": self.NEW})
        self.channel = self.ch.Channel(self.config, self.docker, TOKEN)
        self.channel.prepare()
        self.server.channel = self.channel

    def next_generation(self, volume_uid):
        """The manager's next generation for the runner: its credential replaces the retired one's."""
        old = self.call("GET", f"/v1/credentials/{RUNNER}")[1]
        self.assertEqual(self.call("DELETE", f"/v1/credentials/{RUNNER}?uid={old['uid']}")[0], 204)
        self.credential(2, token="generation-2-credential-0123456789")
        return self.request(volume_uid, generation=2, image=self.NEW)

    def test_the_previous_image_s_container_is_still_read_stopped_and_removed_by_uid(self):
        volume, created = self.running_container()
        self.switch()
        name = f"mr-{RUNNER}"
        status, view = self.call("GET", f"/v1/containers/{name}")
        self.assertEqual((status, view["uid"], view["status"]), (200, created["uid"], "running"), "nothing that runs is touched")
        self.assertEqual(self.docker.containers_by_name[name]["Image"], IMAGE)
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}/holders")[1], {"holders": [{"name": name, "managed": True}]})
        self.assertEqual([c["uid"] for c in self.call("GET", "/v1/resources")[1]["containers"]], [created["uid"]])
        self.assertEqual(self.call("DELETE", f"/v1/containers/{name}?uid={created['uid']}")[1]["code"], "CONTAINER_RUNNING")
        stopped = threading.Event()
        self.docker.stop_hook = stopped.set
        self.assertEqual(self.call("POST", f"/v1/containers/{name}/stop?uid={created['uid']}")[0], 202)
        self.assertTrue(stopped.wait(5))
        for _ in range(100):
            view = self.call("GET", f"/v1/containers/{name}")[1]
            if view["status"] == "exited":
                break
            threading.Event().wait(0.02)
        self.assertEqual((view["status"], view["exitCode"]), ("exited", 143), "Docker's report, as before the switch")
        self.assertEqual(self.call("DELETE", f"/v1/containers/{name}?uid={created['uid']}")[0], 204)
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}/holders")[1], {"holders": []})
        self.assertEqual(self.call("GET", f"/v1/volumes/mr-data-{RUNNER}")[1]["uid"], volume["uid"], "the volume stays")

    def test_only_the_new_image_makes_containers_and_only_once_the_previous_one_is_gone(self):
        volume, created = self.running_container()
        self.switch()
        self.assertEqual(self.call("GET", "/v1/info")[1]["image"], self.NEW)
        # A request naming the previous image — an apiserver still on the previous profile — makes nothing.
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation=2))
        self.assertEqual((status, body["code"]), (403, "IMAGE_REFUSED"))
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation=2, name=f"mr-{RUNNER}-guard-probe", dryRun=True))
        self.assertEqual((status, body["code"]), (403, "IMAGE_REFUSED"), "not even its guard probe is admitted")
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], generation=2, image=self.NEW, name=f"mr-{RUNNER}-guard-probe", dryRun=True))
        self.assertEqual((status, body["code"]), (409, "SINGLE_CONTAINER_GUARD"), "the new profile's probe meets the guard")
        # The next generation on the new image waits for the previous container: exited is not enough, removed is.
        request = self.next_generation(volume["uid"])
        self.assertEqual(self.call("POST", "/v1/containers", request)[1]["code"], "CONTAINER_CONFLICT")
        self.docker.exit(f"mr-{RUNNER}")
        self.assertEqual(self.call("POST", "/v1/containers", request)[1]["code"], "CONTAINER_CONFLICT")
        self.assertEqual(self.call("DELETE", f"/v1/containers/mr-{RUNNER}?uid={created['uid']}")[0], 204)
        status, body = self.call("POST", "/v1/containers", request)
        self.assertEqual(status, 201, body)
        made = self.docker.containers_by_name[f"mr-{RUNNER}"]
        self.assertEqual((made["Image"], made["Config"]["Labels"]["orbit.managed-runner.generation"], body["volumeUid"]), (self.NEW, "2", volume["uid"]))
        self.assertNotEqual(body["uid"], created["uid"])
        self.assertEqual(self.docker.calls.count(("create_container", f"mr-{RUNNER}")), 2, "one container per generation, never two at once")

    def test_a_create_the_previous_channel_left_unstarted_is_removed_and_never_started(self):
        volume = self.volume()
        self.credential()
        spec = self.ch.container_spec(self.config, self.request(volume["uid"]), str(uuid.uuid4()))
        self.docker.create_container(f"mr-{RUNNER}", spec)  # the channel stopped right after Docker's create
        self.switch()  # ...and came back on the new image
        self.assertNotIn(f"mr-{RUNNER}", self.docker.containers_by_name)
        self.assertNotIn(("start_container", f"mr-{RUNNER}"), self.docker.calls)
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], image=self.NEW))
        self.assertEqual(status, 201, body)
        self.assertEqual(self.docker.containers_by_name[f"mr-{RUNNER}"]["Image"], self.NEW)

    def test_an_unstarted_container_of_the_previous_image_is_made_again_never_started(self):
        volume = self.volume()
        stale_uid = str(uuid.uuid4())
        spec = self.ch.container_spec(self.config, self.request(volume["uid"]), stale_uid)
        self.docker.create_container(f"mr-{RUNNER}", spec)
        self.switch()  # its credential was gone: left for the manager, never started
        self.assertEqual(self.docker.containers_by_name[f"mr-{RUNNER}"]["State"]["Status"], "created")
        self.credential()
        status, body = self.call("POST", "/v1/containers", self.request(volume["uid"], image=self.NEW))
        self.assertEqual(status, 201, body)
        made = self.docker.containers_by_name[f"mr-{RUNNER}"]
        self.assertEqual((made["Image"], made["State"]["Status"]), (self.NEW, "running"))
        self.assertNotEqual(body["uid"], stale_uid, "a new container, not the previous image's started")
        self.assertEqual(self.docker.calls.count(("start_container", f"mr-{RUNNER}")), 1)
        self.assertIn(("remove_container", f"mr-{RUNNER}"), self.docker.calls)
        instance = json.loads(made["archives"]["/run/orbit-bootstrap"]["instance.json"]["data"])
        self.assertEqual(instance["instanceUid"], body["uid"], "the bootstrap files are the new container's")

    def test_a_channel_does_not_serve_an_image_this_host_does_not_have(self):
        config = self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "image": self.NEW})
        with self.assertRaisesRegex(ValueError, "is not on this Docker host"):
            self.ch.Channel(config, self.docker, TOKEN).prepare()


class ListingAndHostTest(ChannelFixture):
    def test_the_listing_holds_this_instance_s_resources_only(self):
        self.running_container()
        self.docker.volumes_by_name["unrelated"] = {"Name": "unrelated", "Labels": {}}
        self.docker.foreign_container("unrelated-app", "unrelated")
        listing = self.call("GET", "/v1/resources")[1]
        self.assertEqual(sorted(v["name"] for v in listing["volumes"]), [f"mr-boot-{RUNNER}-g1", f"mr-data-{RUNNER}"])
        self.assertEqual([c["name"] for c in listing["containers"]], [f"mr-{RUNNER}"])

    def test_info_reports_the_host_for_the_budget(self):
        self.volume()
        self.docker.sizes[f"mr-data-{RUNNER}"] = 12345
        self.docker.sizes["unrelated"] = 999
        info = self.call("GET", "/v1/info")[1]
        self.assertEqual((info["instanceId"], info["image"]), (INSTANCE, IMAGE))
        self.assertEqual(info["network"], {"name": "orbit-mr-test", "internal": True, "interContainer": False})
        self.assertEqual((info["host"]["cpus"], info["host"]["memoryBytes"]), (8, 16 * 2 ** 30))
        self.assertEqual(info["host"]["managedVolumeBytes"], 12345, "only this instance's data volumes")
        self.assertEqual(info["host"]["disk"]["path"], self.config["stateDir"], "the Docker root is not visible here, so the state dir")
        self.assertGreater(info["host"]["disk"]["totalBytes"], 0)

    def test_the_disk_is_measured_where_the_probe_path_says(self):
        # Root Compose mounts an empty volume of the channel's own there: Docker keeps it beside the data volumes.
        probe = Path(self.scratch.name) / "docker-volumes"
        probe.mkdir()
        self.server.channel = self.channel = self.ch.Channel(
            self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "diskProbePath": str(probe)}), self.docker, TOKEN)
        self.channel.prepare()
        disk = self.call("GET", "/v1/info")[1]["host"]["disk"]
        stat_ = os.statvfs(probe)
        self.assertEqual((disk["path"], disk["totalBytes"]), (str(probe), stat_.f_blocks * stat_.f_frsize))

    def test_a_probe_path_that_is_not_a_directory_stops_the_channel_before_it_serves(self):
        missing = Path(self.scratch.name) / "not-mounted"
        channel = self.ch.Channel(self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "diskProbePath": str(missing)}),
                                  self.docker, TOKEN)
        with self.assertRaisesRegex(ValueError, "not a directory"):
            channel.prepare()

    def test_what_the_channel_says_at_start_up_about_the_disk_the_cap_and_tmp(self):
        said = []
        self.ch.log = said.append
        self.channel.prepare()  # Docker 29, no probe path, a data root this process cannot see
        self.assertIn("containers of this instance: at most 8 (one per CPU and per GiB of this host's memory, whichever is fewer)", said)
        self.assertTrue(any("measures the disk under" in line and self.config["stateDir"] in line for line in said), said)
        self.assertFalse(any("TmpfsOptions" in line for line in said), "Docker 29 makes /tmp executable")
        said.clear()
        self.docker.host.update(ServerVersion="26.1.4")
        probe = Path(self.scratch.name) / "docker-volumes"
        probe.mkdir()
        self.ch.Channel(self.ch.parse_config({**self.config_value(Path(self.scratch.name)), "diskProbePath": str(probe),
                                              "limits": {**self.config_value(Path(self.scratch.name))["limits"], "maxContainers": 3}}),
                        self.docker, TOKEN).prepare()
        self.assertIn("containers of this instance: at most 3", said)
        self.assertTrue(any("Docker 26.1.4 ignores TmpfsOptions.Options" in line for line in said), said)
        self.assertFalse(any("measures the disk under" in line for line in said), "a probe path is set")

    def test_a_fencing_receipt_is_read_from_the_state_directory_only(self):
        self.assertEqual(self.call("GET", f"/v1/fencing-receipts/{RUNNER}")[0], 404)
        receipt = Path(self.config["stateDir"]) / "fencing" / f"{RUNNER}.json"
        receipt.write_text(json.dumps({"schemaVersion": 1}))
        self.assertEqual(self.call("GET", f"/v1/fencing-receipts/{RUNNER}")[1], {"schemaVersion": 1})
        receipt.unlink()
        receipt.symlink_to("/etc/hostname")
        self.assertEqual(self.call("GET", f"/v1/fencing-receipts/{RUNNER}")[1]["code"], "RECEIPT_UNREADABLE")
        self.assertEqual(self.call("GET", "/v1/fencing-receipts/..%2F..%2Fetc%2Fpasswd")[1]["code"], "NAME_REFUSED")


if __name__ == "__main__":
    unittest.main()
