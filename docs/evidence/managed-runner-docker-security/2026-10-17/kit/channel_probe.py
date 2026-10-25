#!/usr/bin/env python3
"""D5 (task 34hJ7S9C3isVnzIDDfSHD): independent refusal tests against a running restricted Docker channel.

    channel_probe.py --dir <the managed runners' directory> --out <evidence dir> [--docker /var/run/docker.sock]

<dir> is what a deployment mounts at /var/lib/orbit-managed-runners: channel.json, token, state/ and channel.sock
(data/managed-runners in a Compose deployment). Run it as root on the Docker host that channel manages, with nothing
else changing that Docker meanwhile: before and after every request it reads Docker's whole inventory (containers,
volumes, networks, images) and a digest of the channel's state directory, so a refusal is shown to have changed
nothing. The token is read from its file and never printed or written; nor is any credential.

Writes <out>/channel-refusals.jsonl (one line per request: case, what it attempts, the request with its
Authorization described rather than given, the answer, and whether Docker and the state stayed unchanged) and
<out>/channel-refusals-summary.json. Exits 1 if any case did not get its expected answer or changed something.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.parse
import uuid

FOREIGN_INSTANCE = "orbit-foreign-d5"
TEST_LABEL = {"orbit.test": "d5-34hJ7S9C3isVnzIDDfSHD"}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ── HTTP over a unix socket, written byte by byte so that malformed requests can be sent too ─────

def exchange(socket_path, raw, timeout=30):
    """One request on its own connection; the channel always answers with a Content-Length and closes."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sock.connect(socket_path)
    chunks = []
    try:
        try:
            sock.sendall(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass  # refused before the whole body was read: its answer is still there to read
        while True:
            try:
                data = sock.recv(65536)
            except (socket.timeout, ConnectionResetError):
                break
            if not data:
                break
            chunks.append(data)
    finally:
        sock.close()
    response = b"".join(chunks)
    head, _, body = response.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1]) if lines and lines[0].startswith("HTTP/") else None
    try:
        payload = json.loads(body) if body else None
    except ValueError:
        payload = {"nonJsonBody": body[:200].decode("utf-8", "replace")}
    return status, payload


def build(method, path, body=None, auth=None, extra_headers=(), raw_body=None):
    headers = [("Host", "localhost")]
    if auth is not None:
        headers.append(("Authorization", auth))
    payload = b""
    if raw_body is not None:
        payload = raw_body
    elif body is not None:
        payload = json.dumps(body).encode()
        headers.append(("Content-Type", "application/json"))
    named = {k.lower() for k, _ in extra_headers}
    if (raw_body is not None or body is not None) and not named & {"content-length", "transfer-encoding"}:
        headers.append(("Content-Length", str(len(payload))))
    headers.extend(extra_headers)
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers) + "\r\n"
    return head.encode("latin-1") + payload


# ── Docker's inventory, read through its own API ──────────────────────────────────────────────────

class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=120):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


class Docker:
    def __init__(self, path):
        self.path = path

    def get(self, url):
        connection = UnixHTTPConnection(self.path)
        try:
            connection.request("GET", "/v1.44" + url)
            response = connection.getresponse()
            status, data = response.status, response.read()
        finally:
            connection.close()
        if status != 200:
            raise RuntimeError(f"Docker GET {url} answered {status}: {data[:300]!r}")
        return json.loads(data)

    def inventory(self):
        containers = sorted(
            (c["Id"], ",".join(sorted(c.get("Names") or [])), c.get("State"), c.get("ImageID"),
             json.dumps(c.get("Labels") or {}, sort_keys=True))
            for c in self.get("/containers/json?all=1"))
        volumes = sorted((v["Name"], json.dumps(v.get("Labels") or {}, sort_keys=True))
                         for v in (self.get("/volumes").get("Volumes") or []))
        networks = sorted((n["Id"], n["Name"]) for n in self.get("/networks"))
        images = sorted(i["Id"] for i in self.get("/images/json?all=1"))
        return {"containers": containers, "volumes": volumes, "networks": networks, "images": images}


def state_digest(state_dir):
    """Names and content digests of every file under the channel's state directory (never the contents)."""
    entries = []
    for root, dirs, files in os.walk(state_dir):
        dirs.sort()
        for name in sorted(files):
            path = Path(root) / name
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError as error:
                digest = f"unreadable: {error.strerror}"
            entries.append((str(path.relative_to(state_dir)), digest))
    return entries


def docker_cli(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=300)
    if check and result.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args)} exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout.strip()


# ── the run ───────────────────────────────────────────────────────────────────────────────────────

class Run:
    def __init__(self, args):
        self.dir = Path(args.dir)
        self.socket = str(self.dir / "channel.sock")
        self.config = json.loads((self.dir / "channel.json").read_text())
        self.token = (self.dir / "token").read_text().strip()
        self.state = self.dir / "state"
        self.docker = Docker(args.docker)
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.log = (self.out / "channel-refusals.jsonl").open("a")
        self.results = []
        network = self.docker.get(f"/networks/{urllib.parse.quote(self.config['network'])}")
        gateways = [c.get("Gateway") for c in (network.get("IPAM") or {}).get("Config") or [] if "." in (c.get("Gateway") or "")]
        self.server_url = f"http://{gateways[0]}:2086"

    def auth(self, kind="good"):
        return {
            "good": f"Bearer {self.token}",
            "none": None,
            "wrong": "Bearer " + secrets.token_hex(32),
            "lowercase-scheme": f"bearer {self.token}",
            "basic": "Basic " + base64.b64encode(f"orbit:{self.token}".encode()).decode(),
            "prefix": f"Bearer {self.token[:-1]}",
            "suffix": f"Bearer {self.token}x",
            "empty": "Bearer ",
            "token-only": self.token,
        }[kind]

    def call(self, case, attempts, method, path, body=None, *, auth="good", expect=(400, "PARAMETER_REFUSED"),
             category, changes=False, raw_body=None, extra_headers=(), body_note=None):
        before = (self.docker.inventory(), state_digest(self.state))
        status, payload = exchange(self.socket, build(method, path, body, self.auth(auth), extra_headers, raw_body))
        after = (self.docker.inventory(), state_digest(self.state))
        code = (payload or {}).get("code") if isinstance(payload, dict) else None
        docker_unchanged, state_unchanged = before[0] == after[0], before[1] == after[1]
        expected_status, expected_code = expect
        answered_as_expected = status == expected_status and (expected_code is None or code == expected_code)
        passed = answered_as_expected and (changes or (docker_unchanged and state_unchanged))
        entry = {
            "at": now(), "case": case, "category": category, "attempts": attempts,
            "request": {"method": method, "path": path,
                        "authorization": {"good": "Bearer <the channel's token>", "none": "(none)",
                                          "wrong": "Bearer <a random 64-hex token>",
                                          "lowercase-scheme": "bearer <the channel's token>",
                                          "basic": "Basic base64(orbit:<the channel's token>)",
                                          "prefix": "Bearer <the token less its last character>",
                                          "suffix": "Bearer <the token>x", "empty": "Bearer (empty)",
                                          "token-only": "<the token, no scheme>"}[auth],
                        "body": body_note if body_note is not None else body,
                        **({"extraHeaders": [k for k, _ in extra_headers]} if extra_headers else {})},
            "expected": {"status": expected_status, "code": expected_code},
            "answer": {"status": status, "code": code,
                       "message": ((payload or {}).get("message") or "")[:300] if isinstance(payload, dict) else None},
            "dockerUnchanged": docker_unchanged, "channelStateUnchanged": state_unchanged,
            "expectedToChange": changes, "pass": passed,
        }
        self.log.write(json.dumps(entry, sort_keys=True) + "\n")
        self.log.flush()
        self.results.append(entry)
        flag = "ok  " if passed else "FAIL"
        print(f"{flag} [{category}] {case}: {status} {code}", flush=True)
        return status, payload


def uid4():
    return str(uuid.uuid4())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--docker", default="/var/run/docker.sock")
    run = Run(parser.parse_args())
    c = run.config
    image, network, limits = c["image"], c["network"], c["limits"]
    started = now()
    print(f"channel instance {c['instanceId']}, image {image}, network {network}, server {run.server_url}", flush=True)

    # ── setup: three victim runners with a labelled data volume and a stored credential each ──────
    owner = uid4()
    victims = {}
    for key in ("R", "R2", "R3"):
        runner = uid4()
        status, volume = run.call(f"setup: data volume of victim {key}", "create a labelled data volume through the channel",
                                  "PUT", f"/v1/volumes/mr-data-{runner}",
                                  {"ownerId": owner, "runnerId": runner, "limitBytes": 1 << 30},
                                  expect=(200, None), category="setup", changes=True)
        run.call(f"setup: credential of victim {key}", "store a credential for generation 1 through the channel",
                 "PUT", f"/v1/credentials/{runner}", {"ownerId": owner, "generation": 1, "token": secrets.token_urlsafe(36)},
                 expect=(200, None), category="setup", changes=True, body_note={"ownerId": owner, "generation": 1, "token": "<random>"})
        victims[key] = {"runner": runner, "volumeUid": volume["uid"]}
    R = victims["R"]["runner"]

    def base(key="R", **overrides):
        v = victims[key]
        body = {
            "name": f"mr-{v['runner']}", "image": image, "ownerId": owner, "runnerId": v["runner"], "generation": 1,
            "volume": {"name": f"mr-data-{v['runner']}", "uid": v["volumeUid"]},
            "resources": {"cpuMillis": 500, "memoryBytes": 512 << 20, "pids": 256, "tmpBytes": 64 << 20},
            "runner": {"serverUrl": run.server_url, "maxConcurrent": 1},
        }
        body.update(overrides)
        return body

    def nested(section, **extra):
        body = base()
        body[section] = {**body[section], **extra}
        return body

    run.call("baseline: the victim's request as a dry run is admitted", "show the base request is valid, so each refusal below is the added parameter's",
             "POST", "/v1/containers", base(dryRun=True), expect=(200, None), category="baseline")

    create = lambda case, category, attempts, body, expect=(400, "PARAMETER_REFUSED"): run.call(  # noqa: E731
        case, attempts, "POST", "/v1/containers", body, expect=expect, category=category)

    # ── privileged mode ───────────────────────────────────────────────────────────────────────────
    for key, value in (("privileged", True), ("Privileged", True), ("HostConfig", {"Privileged": True})):
        create(f"{key}={json.dumps(value)}", "privileged", "a privileged container", base(**{key: value}))
    create("resources.privileged=true", "privileged", "privileged mode smuggled into resources", nested("resources", privileged=True))
    create("runner.privileged=true", "privileged", "privileged mode smuggled into runner", nested("runner", privileged=True))
    create("volume.privileged=true", "privileged", "privileged mode smuggled into volume", nested("volume", privileged=True))
    create("securityOpt seccomp=unconfined", "privileged", "seccomp off", base(securityOpt=["seccomp=unconfined"]))
    create("securityOpt apparmor=unconfined", "privileged", "AppArmor off", base(SecurityOpt=["apparmor=unconfined"]))
    create("user=0:0", "privileged", "run as root", base(user="0:0"))
    create("User=root", "privileged", "run as root", base(User="root"))

    # ── capabilities ─────────────────────────────────────────────────────────────────────────────
    for key, value in (("capAdd", ["SYS_ADMIN"]), ("CapAdd", ["ALL"]), ("cap_add", ["NET_ADMIN"]),
                       ("capabilities", ["SYS_PTRACE"]), ("capDrop", []), ("HostConfig", {"CapAdd": ["SYS_ADMIN"]})):
        create(f"{key}={json.dumps(value)}", "cap-add", "added (or not dropped) capabilities", base(**{key: value}))
    create("resources.capAdd", "cap-add", "capabilities smuggled into resources", nested("resources", capAdd=["SYS_ADMIN"]))

    # ── host directories ─────────────────────────────────────────────────────────────────────────
    for key, value in (("binds", ["/:/host"]), ("Binds", ["/etc:/host-etc:ro"]),
                       ("mounts", [{"Type": "bind", "Source": "/root", "Target": "/host-root"}]),
                       ("Mounts", [{"Type": "bind", "Source": "/var/lib/docker", "Target": "/x"}]),
                       ("volumes", {"/host": {}}), ("volumesFrom", ["orbit-postgres"]), ("tmpfs", {"/run": ""}),
                       ("HostConfig", {"Binds": ["/:/host"]})):
        create(f"{key}={json.dumps(value)}", "host-directory", "a host directory or another container's volumes", base(**{key: value}))
    for name in ("/", "/etc", "/root", "/var/lib/docker", "../../../../", "mr-data-" + R + "/../../..", "/var/lib/docker/volumes/mr-data-" + R + "/_data"):
        create(f"volume.name={name!r}", "host-directory", "a host path as the data volume",
               nested("volume", name=name), expect=(400, "NAME_REFUSED"))
    create("volume.source=/", "host-directory", "a host path beside the data volume", nested("volume", source="/"))
    create("volume.type=bind", "host-directory", "the data volume as a bind mount", nested("volume", type="bind"))

    # ── the Docker socket ──────────────────────────────────────────────────────────────────────
    sock = "/var/run/docker.sock"
    for key, value in (("binds", [f"{sock}:{sock}"]), ("Binds", ["/run/docker.sock:/run/docker.sock"]),
                       ("mounts", [{"Type": "bind", "Source": sock, "Target": sock}]),
                       ("env", [f"DOCKER_HOST=unix://{sock}"]), ("Env", ["DOCKER_HOST=tcp://172.17.0.1:2375"])):
        create(f"{key}={json.dumps(value)}", "docker-socket", "the Docker socket in the container", base(**{key: value}))
    for name in (sock, "/run/docker.sock", "docker.sock", "/var/run/docker.sock:/var/run/docker.sock"):
        create(f"volume.name={name!r}", "docker-socket", "the Docker socket as the data volume", nested("volume", name=name),
               expect=(400, "NAME_REFUSED"))
    for url in (f"unix://{sock}", "http+unix://%2Fvar%2Frun%2Fdocker.sock/v1.44/info", "tcp://172.17.0.1:2375"):
        create(f"runner.serverUrl={url!r}", "docker-socket", "the Docker API as the runner's server",
               nested("runner", serverUrl=url))
    run.call(f"PUT /v1/volumes/{urllib.parse.quote(sock, safe='')}", "the Docker socket as a volume name",
             "PUT", f"/v1/volumes/{urllib.parse.quote(sock, safe='')}", {"ownerId": owner, "runnerId": R, "limitBytes": 1 << 20},
             expect=(400, "NAME_REFUSED"), category="docker-socket")

    # ── host namespaces ────────────────────────────────────────────────────────────────────────
    for key, value, category in (("networkMode", "host", "host-network"), ("NetworkMode", "host", "host-network"),
                                 ("network", "host", "host-network"), ("network_mode", "host", "host-network"),
                                 ("networkMode", "container:orbit-apiserver", "host-network"),
                                 ("network", "bridge", "host-network"),
                                 ("HostConfig", {"NetworkMode": "host"}, "host-network"),
                                 ("pidMode", "host", "host-pid"), ("PidMode", "host", "host-pid"), ("pid", "host", "host-pid"),
                                 ("pidMode", "container:orbit-docker-channel", "host-pid"),
                                 ("HostConfig", {"PidMode": "host"}, "host-pid"),
                                 ("ipcMode", "host", "host-ipc"), ("IpcMode", "host", "host-ipc"), ("ipc", "shareable", "host-ipc"),
                                 ("HostConfig", {"IpcMode": "host"}, "host-ipc"),
                                 ("utsMode", "host", "host-uts"), ("usernsMode", "host", "host-userns"),
                                 ("cgroupnsMode", "host", "host-cgroupns")):
        create(f"{key}={json.dumps(value)}", category, f"the host's (or another container's) {category.split('-', 1)[1]} namespace",
               base(**{key: value}))
    create("runner.networkMode=host", "host-network", "host network smuggled into runner", nested("runner", networkMode="host"))
    create("resources.pidMode=host", "host-pid", "host PID smuggled into resources", nested("resources", pidMode="host"))

    # ── devices ───────────────────────────────────────────────────────────────────────────────
    for key, value in (("devices", ["/dev/sda:/dev/sda"]),
                       ("Devices", [{"PathOnHost": "/dev/kmsg", "PathInContainer": "/dev/kmsg", "CgroupPermissions": "rwm"}]),
                       ("deviceRequests", [{"Driver": "nvidia", "Count": -1, "Capabilities": [["gpu"]]}]),
                       ("DeviceRequests", [{"Driver": "", "Count": -1, "Capabilities": [["gpu"]]}]),
                       ("gpus", "all"), ("deviceCgroupRules", ["a *:* rwm"]),
                       ("HostConfig", {"Devices": [{"PathOnHost": "/dev/mem", "PathInContainer": "/dev/mem", "CgroupPermissions": "rwm"}]})):
        create(f"{key}={json.dumps(value)}", "device", "a host device or GPU passed through", base(**{key: value}))
    create("resources.devices", "device", "devices smuggled into resources", nested("resources", devices=["/dev/sda"]))

    # ── images ────────────────────────────────────────────────────────────────────────────────
    other_images = [i for i in run.docker.inventory()["images"] if i != image][:2]
    tags = [t for i in run.docker.get("/images/json") if i.get("Id") == image for t in (i.get("RepoTags") or [])]
    candidates = [("alpine:3", "a public image by tag"), ("docker:29.8.2-dind", "the Docker-in-Docker image"),
                  (image.upper().replace("SHA256:", "sha256:"), "the configured ID in upper case"),
                  (image + "@sha256:" + "0" * 64, "the configured ID with a digest appended"),
                  (None, "no image"), ("", "an empty image")]
    candidates += [(i, "another local image by its ID") for i in other_images]
    candidates += [(t, "the configured image's own tag, not its ID") for t in tags[:1]]
    for value, what in candidates:
        create(f"image={value!r}", "image", what, base(image=value), expect=(403, "IMAGE_REFUSED"))
    body = base()
    del body["image"]
    create("image absent", "image", "no image named at all", body, expect=(403, "IMAGE_REFUSED"))
    create("Image=alpine:3 beside the configured image", "image", "a second, Docker-spelled image key", base(Image="alpine:3"))

    # ── everything else the template fixes ─────────────────────────────────────────────────────
    for key, value in (("entrypoint", ["/bin/sh"]), ("cmd", ["sh", "-c", "id"]), ("Cmd", ["sh"]), ("workingDir", "/"),
                       ("labels", {"orbit.managed-runner.instance": "x"}), ("sysctls", {"net.ipv4.ip_forward": "1"}),
                       ("readonlyRootfs", False), ("restartPolicy", {"Name": "always"}), ("portBindings", {"22/tcp": [{"HostPort": "2222"}]}),
                       ("publishAllPorts", True), ("extraHosts", ["host.docker.internal:host-gateway"]), ("links", ["orbit-postgres:db"]),
                       ("oomKillDisable", True), ("memorySwap", -1), ("groupAdd", ["docker"]), ("init", True),
                       ("runtime", "runc"), ("logConfig", {"Type": "none"}), ("stopSignal", "SIGKILL"), ("hostname", "x"),
                       ("dns", ["1.1.1.1"]), ("ulimits", [{"Name": "nofile", "Soft": 1048576, "Hard": 1048576}]),
                       ("cgroupParent", "/"), ("shmSize", 1 << 40), ("autoRemove", True)):
        create(f"{key}={json.dumps(value)}", "other-docker-parameter", "a Docker parameter the template fixes", base(**{key: value}))
    for section, key, value in (("resources", "memorySwap", -1), ("resources", "cpuset", "0-23"), ("runner", "env", ["A=1"]),
                                ("runner", "image", "alpine:3"), ("volume", "readOnly", False), ("volume", "driver", "local")):
        create(f"{section}.{key}={json.dumps(value)}", "other-docker-parameter", f"a Docker parameter inside {section}",
               nested(section, **{key: value}))

    # ── amounts and identities ─────────────────────────────────────────────────────────────────
    for key, ceiling in (("cpuMillis", limits["maxCpuMillis"]), ("memoryBytes", limits["maxMemoryBytes"]),
                         ("pids", limits["maxPids"]), ("tmpBytes", limits["maxTmpBytes"])):
        create(f"resources.{key} above the ceiling ({ceiling}+1)", "limit", "more than the channel's ceiling",
               nested("resources", **{key: ceiling + 1, **({"memoryBytes": limits["maxMemoryBytes"]} if key == "tmpBytes" else {})}),
               expect=(403, "LIMIT_REFUSED"))
        for bad in (0, -1, True, 1.5, "1", None):
            create(f"resources.{key}={json.dumps(bad)}", "limit", "no limit, a negative one or not an integer",
                   nested("resources", **{key: bad}))
    create("resources.tmpBytes above resources.memoryBytes", "limit", "a /tmp larger than the memory it is held in",
           nested("resources", tmpBytes=512 << 20, memoryBytes=256 << 20))
    create("runner.maxConcurrent above the ceiling", "limit", "more sessions than the ceiling",
           nested("runner", maxConcurrent=limits["maxConcurrent"] + 1), expect=(403, "LIMIT_REFUSED"))
    body = base()
    del body["resources"]
    create("resources absent", "limit", "no resources object at all", body, expect=(400, "BODY_REFUSED"))
    other = uid4()
    create("name of another runner", "single-container", "a second container on the victim's volume",
           base(name=f"mr-{other}"), expect=(409, "SINGLE_CONTAINER_GUARD"))
    create("name orbit-apiserver", "single-container", "a container under a stack service's name",
           base(name="orbit-apiserver"), expect=(409, "SINGLE_CONTAINER_GUARD"))
    create("volume of another runner", "single-container", "mount another runner's data volume",
           nested("volume", name=f"mr-data-{victims['R2']['runner']}"), expect=(403, "VOLUME_REFUSED"))
    create("volume UID of another volume", "single-container", "the victim's volume under another volume's UID",
           nested("volume", uid=victims["R2"]["volumeUid"]), expect=(409, "VOLUME_REFUSED"))
    create("owner other than the volume's", "single-container", "another owner's request for the victim's volume",
           base(ownerId=uid4()), expect=(409, "VOLUME_REFUSED"))
    create("generation without a stored credential", "single-container", "start a generation nobody issued a credential for",
           base(generation=2), expect=(409, "CREDENTIAL_MISSING"))
    for url in ("http://user:pass@10.0.0.1:2086", "http://10.0.0.1:2086/?x=1", "ftp://10.0.0.1/", "http:///nohost", 7):
        create(f"runner.serverUrl={url!r}", "other-docker-parameter", "a server URL that is not a plain http(s) origin",
               nested("runner", serverUrl=url))

    # ── resources without this instance's label ─────────────────────────────────────────────────
    U, F, K, U2, F2 = uid4(), uid4(), uid4(), uid4(), uid4()
    made = []

    def raw(*args):
        made.append(args)
        return docker_cli(*args)

    label_args = [a for k, v in TEST_LABEL.items() for a in ("--label", f"{k}={v}")]
    raw("volume", "create", *label_args, f"mr-data-{U}")
    raw("volume", "create", *label_args, "--label", f"orbit.managed-runner.instance={FOREIGN_INSTANCE}",
        "--label", "orbit.managed-runner.kind=data", "--label", f"orbit.managed-runner.owner={owner}",
        "--label", f"orbit.managed-runner.runner={F}", "--label", f"orbit.managed-runner.uid={uid4()}", f"mr-data-{F}")
    raw("volume", "create", *label_args, "--label", f"orbit.managed-runner.instance={c['instanceId']}",
        "--label", "orbit.managed-runner.kind=bootstrap", f"mr-data-{K}")
    raw("run", "-d", *label_args, "--name", f"mr-{U2}", "--network", "none", "alpine:3", "sleep", "3600")
    raw("run", "-d", *label_args, "--label", f"orbit.managed-runner.instance={FOREIGN_INSTANCE}",
        "--label", "orbit.managed-runner.kind=runner", "--label", f"orbit.managed-runner.runner={F2}",
        "--label", f"orbit.managed-runner.uid={uid4()}", "--name", f"mr-{F2}", "--network", "none", "alpine:3", "sleep", "3600")
    raw("create", *label_args, "--name", "d5-intruder", "--network", "none",
        "-v", f"mr-data-{victims['R2']['runner']}:/stolen", "alpine:3", "true")
    raw("volume", "create", *label_args, f"mr-boot-{victims['R3']['runner']}-g1")
    (run.out / "unlabelled-objects.json").write_text(json.dumps(
        {"made with the docker CLI, not the channel": [" ".join(a) for a in made]}, indent=2) + "\n")

    for name, what in ((f"mr-data-{U}", "a volume with the channel's naming and no instance label"),
                       (f"mr-data-{F}", "another instance's labelled data volume"),
                       (f"mr-data-{K}", "this instance's label but not a data volume")):
        rid = name[len("mr-data-"):]
        run.call(f"GET volume {what}", f"read {what}", "GET", f"/v1/volumes/{name}", expect=(404, "NOT_FOUND"), category="unlabelled")
        run.call(f"PUT volume {what}", f"adopt {what}", "PUT", f"/v1/volumes/{name}",
                 {"ownerId": owner, "runnerId": rid, "limitBytes": 1 << 20}, expect=(409, "NOT_MANAGED"), category="unlabelled")
        run.call(f"DELETE volume {what}", f"remove {what}", "DELETE", f"/v1/volumes/{name}?uid={uid4()}",
                 expect=(404, "NOT_FOUND"), category="unlabelled")
        run.call(f"holders of {what}", f"list what holds {what}", "GET", f"/v1/volumes/{name}/holders",
                 expect=(404, "NOT_FOUND"), category="unlabelled")
        run.call(f"PUT credential then container on {what}", "store a credential for that runner (allowed), then mount the volume",
                 "PUT", f"/v1/credentials/{rid}", {"ownerId": owner, "generation": 1, "token": secrets.token_urlsafe(36)},
                 expect=(200, None), category="setup", changes=True, body_note={"ownerId": owner, "generation": 1, "token": "<random>"})
        body = base(name=f"mr-{rid}", runnerId=rid, volume={"name": name, "uid": uid4()})
        create(f"container on {what}", "unlabelled", f"a container mounting {what}", body, expect=(409, "VOLUME_REFUSED"))
    for name, what in ((f"mr-{U2}", "a running container with the channel's naming and no instance label"),
                       (f"mr-{F2}", "another instance's labelled running container")):
        rid = name[len("mr-"):]
        run.call(f"GET container {what}", f"read {what}", "GET", f"/v1/containers/{name}", expect=(404, "NOT_FOUND"), category="unlabelled")
        run.call(f"stop container {what}", f"stop {what}", "POST", f"/v1/containers/{name}/stop?uid={uid4()}",
                 expect=(404, "NOT_FOUND"), category="unlabelled")
        run.call(f"DELETE container {what}", f"remove {what}", "DELETE", f"/v1/containers/{name}?uid={uid4()}",
                 expect=(404, "NOT_FOUND"), category="unlabelled")
        create(f"create over {what}", "unlabelled", f"replace or adopt {what}",
               base(name=name, runnerId=rid, volume={"name": f"mr-data-{rid}", "uid": uid4()}), expect=(409, "NOT_MANAGED"))
    status, holders = run.call("holders of the victim R2's volume, mounted by an unlabelled container",
                               "learn which foreign container holds a managed volume", "GET",
                               f"/v1/volumes/mr-data-{victims['R2']['runner']}/holders", expect=(200, None), category="unlabelled")
    holders_ok = (holders or {}).get("holders") == [{"managed": False}]
    create("container on R2's volume while an unlabelled container refers to it", "unlabelled",
           "a second container on a volume something else already mounts", base("R2"), expect=(409, "VOLUME_IN_USE"))
    create("container whose bootstrap volume name an unlabelled volume squats", "unlabelled",
           "make the channel write the credential into a volume it did not make", base("R3"), expect=(409, "NOT_MANAGED"))
    status, listing = run.call("GET /v1/resources", "list everything this instance has", "GET", "/v1/resources",
                               expect=(200, None), category="unlabelled")
    listed = {v.get("name") for v in (listing or {}).get("volumes") or []} | {x.get("name") for x in (listing or {}).get("containers") or []}
    foreign_listed = sorted(n for n in (f"mr-data-{U}", f"mr-data-{F}", f"mr-{U2}", f"mr-{F2}", "d5-intruder") if n in listed)
    for name in ("orbit-postgres", "orbit-apiserver", "orbit-docker-channel", "orbit-gateway"):
        run.call(f"GET container {name}", "read a stack container by its name", "GET", f"/v1/containers/{name}",
                 expect=(400, "NAME_REFUSED"), category="unlabelled")
        run.call(f"stop container {name}", "stop a stack container", "POST", f"/v1/containers/{name}/stop?uid={uid4()}",
                 expect=(400, "NAME_REFUSED"), category="unlabelled")
        run.call(f"DELETE container {name}", "remove a stack container", "DELETE", f"/v1/containers/{name}?uid={uid4()}",
                 expect=(400, "NAME_REFUSED"), category="unlabelled")
    stack_volumes = [v for v, _ in run.docker.inventory()["volumes"] if not v.startswith("mr-")][:3]
    for name in stack_volumes:
        run.call(f"DELETE volume {name[:24]}", "remove a volume the stack uses", "DELETE",
                 f"/v1/volumes/{urllib.parse.quote(name)}?uid={uid4()}", expect=(400, "NAME_REFUSED"), category="unlabelled")

    # ── routes, paths and requests the channel does not serve ────────────────────────────────────
    for method, path, expect, what in (
            ("GET", "/v1.44/containers/json?all=1", (404, "NOT_FOUND"), "Docker's own API through the channel"),
            ("POST", "/v1.44/containers/create", (404, "NOT_FOUND"), "Docker's create through the channel"),
            ("GET", "/containers/json", (404, "NOT_FOUND"), "Docker's API without a version"),
            ("GET", "/_ping", (404, "NOT_FOUND"), "Docker's ping"),
            ("GET", "/v1/../v1.44/info", (404, "NOT_FOUND"), "a dot-dot path to Docker's API"),
            ("GET", f"/v1/containers/mr-{R}%2F..%2F..%2Fcontainers%2Forbit-postgres", (400, "NAME_REFUSED"), "an encoded dot-dot name"),
            ("GET", f"/v1/containers/mr-{R.upper()}", (400, "NAME_REFUSED"), "an upper-case UUID"),
            ("GET", f"/v1/containers/mr-{R}%00", (400, "NAME_REFUSED"), "a NUL after the name"),
            ("GET", f"/v1/volumes/mr-data-{R}%0A", (400, "NAME_REFUSED"), "a newline after the volume name"),
            ("GET", f"/v1/credentials/{R}%2F..%2F..%2Ftoken", (400, "NAME_REFUSED"), "a dot-dot runner id for the credentials store"),
            ("GET", f"/v1/fencing-receipts/..%2F..%2Ftoken", (400, "NAME_REFUSED"), "a dot-dot runner id for the receipts"),
            ("DELETE", "/v1/resources", (405, "METHOD_REFUSED"), "a method a route does not serve"),
            ("POST", f"/v1/containers/mr-{R}/stop?uid={uid4()}&t=0", (400, "PARAMETER_REFUSED"), "a Docker stop timeout"),
            ("DELETE", f"/v1/containers/mr-{R}?uid={uid4()}&force=1&v=1", (400, "PARAMETER_REFUSED"), "Docker's force and volume removal"),
            ("DELETE", f"/v1/volumes/mr-data-{R}?uid={uid4()}&force=1", (400, "PARAMETER_REFUSED"), "Docker's forced volume removal"),
            ("GET", "/v1/info?all=1", (400, "PARAMETER_REFUSED"), "a query parameter where none is taken")):
        run.call(f"{method} {path[:90]}", what, method, path, expect=expect, category="route")
    run.call(f"PUT credential for runner id with a trailing newline", "write a credential file under a name that is not a canonical UUID",
             "PUT", f"/v1/credentials/{R}%0A", {"ownerId": owner, "generation": 1, "token": secrets.token_urlsafe(36)},
             expect=(400, "NAME_REFUSED"), category="route", body_note={"ownerId": owner, "generation": 1, "token": "<random>"})
    fourth = uid4()
    run.call("PUT volume with an ownerId ending in a newline", "label a managed volume with an owner that is not a canonical UUID",
             "PUT", f"/v1/volumes/mr-data-{fourth}", {"ownerId": owner + "\n", "runnerId": fourth, "limitBytes": 1 << 20},
             expect=(400, "PARAMETER_REFUSED"), category="route")
    for method, path in (("HEAD", "/v1/info"), ("PATCH", "/v1/info"), ("OPTIONS", "/v1/info")):
        run.call(f"{method} /v1/info", "a method the channel does not implement", method, path, expect=(501, None), category="route")
    run.call("chunked body", "a body without a Content-Length", "POST", "/v1/containers", None,
             raw_body=b"5\r\n{\"a\":\r\n0\r\n\r\n", extra_headers=(("Transfer-Encoding", "chunked"),),
             expect=(400, "BODY_REFUSED"), category="route", body_note="(chunked)")
    run.call("oversized body", "a body over 64 KiB", "POST", "/v1/containers", None,
             raw_body=b"{" + b" " * (70 * 1024) + b"}", extra_headers=(("Content-Length", str(70 * 1024 + 2)),),
             expect=(413, "BODY_REFUSED"), category="route", body_note="(70 KiB)")
    run.call("non-JSON body", "a body that is not JSON", "POST", "/v1/containers", None, raw_body=b"privileged=true",
             extra_headers=(("Content-Length", "15"),), expect=(400, "BODY_REFUSED"), category="route", body_note="privileged=true")
    run.call("JSON array body", "a body that is not an object", "POST", "/v1/containers", [base()],
             expect=(400, "BODY_REFUSED"), category="route")

    # ── authentication ─────────────────────────────────────────────────────────────────────────
    for kind in ("none", "wrong", "lowercase-scheme", "basic", "prefix", "suffix", "empty", "token-only"):
        for method, path, body in (("GET", "/v1/info", None), ("GET", "/v1/resources", None),
                                   ("GET", f"/v1/credentials/{R}", None), ("POST", "/v1/containers", base()),
                                   ("DELETE", f"/v1/volumes/mr-data-{R}?uid={victims['R']['volumeUid']}", None)):
            run.call(f"{kind} token: {method} {path.split('?')[0][:60]}", "use the channel without its token",
                     method, path, body, auth=kind, expect=(401, "UNAUTHENTICATED"), category="authentication")
    run.call("good token after a wrong one in a second header", "a second Authorization header", "GET", "/v1/info",
             auth="wrong", extra_headers=(("Authorization", f"Bearer {run.token}"),), expect=(401, "UNAUTHENTICATED"), category="authentication")

    # ── positive control: the base request, which the channel does carry out ─────────────────────
    status, view = run.call("control: the victim's base request", "create and start the container the template makes",
                            "POST", "/v1/containers", base(), expect=(201, None), category="control", changes=True)
    control = {}
    if status == 201:
        inspected = run.docker.get(f"/containers/mr-{R}/json")
        host = inspected["HostConfig"]
        control = {
            "user": inspected["Config"]["User"], "image": inspected["Image"], "privileged": host["Privileged"],
            "capAdd": host["CapAdd"], "capDrop": host["CapDrop"], "securityOpt": host["SecurityOpt"],
            "readonlyRootfs": host["ReadonlyRootfs"], "networkMode": host["NetworkMode"], "pidMode": host["PidMode"],
            "ipcMode": host["IpcMode"], "binds": host["Binds"], "devices": host["Devices"], "deviceRequests": host["DeviceRequests"],
            "nanoCpus": host["NanoCpus"], "memory": host["Memory"], "memorySwap": host["MemorySwap"], "pidsLimit": host["PidsLimit"],
            "mounts": sorted(f"{m['Type']} {m.get('Name') or m.get('Source')} -> {m['Destination']} rw={m['RW']}" for m in inspected["Mounts"]),
            "tmpfs": [m for m in host.get("Mounts") or [] if m.get("Type") == "tmpfs"],
            "envKeys": sorted(e.split("=", 1)[0] for e in inspected["Config"]["Env"]),
            "appArmorProfile": inspected.get("AppArmorProfile"),
        }
        run.call("control: stop it by its UID", "stop the control container", "POST",
                 f"/v1/containers/mr-{R}/stop?uid={view['uid']}", expect=(202, None), category="control", changes=True)
        for _ in range(60):
            if run.docker.get(f"/containers/mr-{R}/json")["State"]["Status"] not in ("running", "restarting", "paused"):
                break
            time.sleep(1)
        run.call("control: remove it by its UID", "remove the stopped control container and its bootstrap volume", "DELETE",
                 f"/v1/containers/mr-{R}?uid={view['uid']}", expect=(204, None), category="control", changes=True)

    # ── clean up: what this run made, through the channel where it made it ────────────────────────
    for args in made:
        if args[0] == "volume":
            docker_cli("volume", "rm", args[-1], check=False)
    for name in (f"mr-{U2}", f"mr-{F2}", "d5-intruder"):
        docker_cli("rm", "-f", name, check=False)
    for args in made:
        if args[0] == "volume":
            docker_cli("volume", "rm", args[-1], check=False)
    for key, v in victims.items():
        credential = run.call(f"cleanup: read victim {key}'s credential UID", "find the credential's UID", "GET",
                              f"/v1/credentials/{v['runner']}", expect=(200, None), category="cleanup")[1] or {}
        run.call(f"cleanup: delete victim {key}'s credential", "remove it by UID", "DELETE",
                 f"/v1/credentials/{v['runner']}?uid={credential.get('uid')}", expect=(204, None), category="cleanup", changes=True)
        run.call(f"cleanup: delete victim {key}'s volume", "remove it by UID", "DELETE",
                 f"/v1/volumes/mr-data-{v['runner']}?uid={v['volumeUid']}", expect=(204, None), category="cleanup", changes=True)
    for rid in (U, F, K):
        credential = run.call("cleanup: read a probe credential UID", "find the credential's UID", "GET", f"/v1/credentials/{rid}",
                              expect=(200, None), category="cleanup")[1] or {}
        run.call("cleanup: delete a probe credential", "remove it by UID", "DELETE", f"/v1/credentials/{rid}?uid={credential.get('uid')}",
                 expect=(204, None), category="cleanup", changes=True)
    leftovers = [e for e in run.results if e["case"].startswith("PUT credential for runner id with a trailing newline")
                 and e["answer"]["status"] == 200]
    stray = []
    for entry in leftovers:
        credential = run.call("cleanup: the trailing-newline credential", "read it back", "GET", f"/v1/credentials/{R}%0A",
                              expect=(200, None), category="cleanup")[1] or {}
        run.call("cleanup: delete the trailing-newline credential", "remove it by UID", "DELETE",
                 f"/v1/credentials/{R}%0A?uid={credential.get('uid')}", expect=(204, None), category="cleanup", changes=True)
        stray.append("credential file named <uuid>\\n.json")
    newline_volume = [e for e in run.results if e["case"] == "PUT volume with an ownerId ending in a newline" and e["answer"]["status"] == 200]
    if newline_volume:
        volume = run.call("cleanup: read the newline-owner volume", "read it back", "GET", f"/v1/volumes/mr-data-{fourth}",
                          expect=(200, None), category="cleanup")[1] or {}
        run.call("cleanup: delete the newline-owner volume", "remove it by UID", "DELETE",
                 f"/v1/volumes/mr-data-{fourth}?uid={volume.get('uid')}", expect=(204, None), category="cleanup", changes=True)
        stray.append("volume labelled with an owner ending in a newline")

    refusals = [e for e in run.results if e["category"] not in ("setup", "baseline", "control", "cleanup")]
    failed = [e for e in run.results if not e["pass"]]
    by_category = {}
    for e in refusals:
        tally = by_category.setdefault(e["category"], {"cases": 0, "refusedAsExpected": 0, "dockerUnchanged": 0})
        tally["cases"] += 1
        tally["refusedAsExpected"] += int(e["pass"])
        tally["dockerUnchanged"] += int(e["dockerUnchanged"] and e["channelStateUnchanged"])
    summary = {
        "startedAt": started, "endedAt": now(), "instanceId": c["instanceId"], "image": image, "network": network,
        "serverUrl": run.server_url, "requests": len(run.results), "refusalCases": len(refusals),
        "byCategory": by_category, "failed": [{k: e[k] for k in ("case", "category", "expected", "answer")} for e in failed],
        "holdersOfR2ShowOnlyAnUnmanagedCount": holders_ok, "foreignObjectsListedInResources": foreign_listed,
        "strayObjectsCleanedUp": stray, "controlContainer": control,
    }
    (run.out / "channel-refusals-summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps({k: summary[k] for k in ("requests", "refusalCases", "byCategory", "failed", "holdersOfR2ShowOnlyAnUnmanagedCount",
                                              "foreignObjectsListedInResources", "strayObjectsCleanedUp")}, indent=2), flush=True)
    return 0 if not failed and holders_ok and not foreign_listed else 1


if __name__ == "__main__":
    sys.exit(main())
