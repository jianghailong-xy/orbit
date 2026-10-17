#!/usr/bin/env python3
"""The restricted Docker channel (deploy/managed-runner/docker-channel/channel.py) against an
in-memory Docker Engine fake, through its real HTTP server on a scratch unix socket.

Covers what the channel decides: its configuration, the bearer token, the template and its safety
rules, the refusal of every Docker parameter a request may not carry, the instance label on
everything it touches, one container per data volume, credentials, the stop and removal of a
container, the disk limit and a create interrupted by the channel stopping. The Docker calls
themselves are exercised on a real daemon by the Docker backend's integration run, not here.
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

    # ── the client's surface ──
    def info(self):
        return {"Name": "docker-host-a", "NCPU": 8, "MemTotal": 16 * 2 ** 30, "DockerRootDir": "/nonexistent-docker-root", "ServerVersion": "29.0"}

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
        self.assertEqual((config["socketMode"], config["logMaxSize"], config["logMaxFiles"]), (0o600, "10m", 3))

    def test_every_problem_is_reported(self):
        for change, needle in (
            ({"network": "host"}, "network"), ({"network": "bridge"}, "network"), ({"network": "none"}, "network"),
            ({"image": "orbit-managed-runner:latest"}, "image"), ({"instanceId": "Has Spaces"}, "instanceId"),
            ({"listen": {"tcp": {"host": "0.0.0.0", "port": 7000}}}, "listen"), ({"tokenFile": "relative"}, "tokenFile"),
            ({"limits": {"maxCpuMillis": 1}}, "limits"), ({"privileged": True}, "privileged is not a configuration field"),
            ({"extraLabels": {"orbit.managed-runner.instance": "x"}}, "extraLabels"), ({"diskCheckSeconds": 1}, "diskCheckSeconds"),
            ({"socketMode": 0o666}, "socketMode"),
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
        }
        for problem, change in cases.items():
            with self.subTest(problem=problem):
                spec = self.spec()
                change(spec)
                self.assertIn(problem, self.ch.unsafe(self.config, spec))

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
