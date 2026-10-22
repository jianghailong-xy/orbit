#!/usr/bin/python3
"""The restricted Docker channel of Orbit's managed runners (Docker backend).

docs/managed-runner-design.md, "Implementation record: Docker backend", and this directory's
README. The apiserver's Docker backend (src/apiserver/src/managed-runners/docker-backend.ts) never
holds the Docker socket: it reaches Docker only through this process, a small HTTP service on a
local unix socket (or a loopback port) that requires a bearer token and offers exactly what a
managed runner needs:

  volumes      create, read and remove a runner's data volume; what still holds one
  credentials  keep the runner credential of one generation until its container starts
  containers   create one runner container from this channel's own template and start it; read
               its state and exit; stop it; remove it once it has stopped
  resources    everything this instance labelled, and the host's size for the capacity budget

The rules it keeps, whoever asks:

  - Every volume and container it creates carries `orbit.managed-runner.instance=<instanceId>`. It
    reads, returns, changes and removes nothing without that label.
  - Containers come only from its template: the configured image, UID 10001, every capability
    dropped, no-new-privileges, a read-only root filesystem, CPU, memory, PID and /tmp limits (an
    executable tmpfs, nosuid and nodev), the one configured network, and two volumes: the runner's
    own data volume and its bootstrap volume.
    A request names identities and amounts, never Docker parameters. Privileged mode, capabilities,
    host directories, the Docker socket, host network/PID/IPC, devices and anything else it does
    not know are refused by name. What it is about to create is checked against the same rules,
    and so is what Docker made of it.
  - One container per data volume. Creates are serialized per runner, the name is fixed
    (`mr-<runner uuid>`), and a volume any container refers to, labelled or not, is not mounted
    again. And no more containers than `limits.maxContainers` in all (by default one per CPU and
    per GiB of the host's memory, whichever is fewer), so the token's holder cannot multiply them.
  - A data volume is removed only where an operator turned removal on (`allowVolumeRemoval`): the
    manager never removes one, so by default nobody can through this channel.
  - Where the managed runners' host firewall is configured (a `firewall/config.json` beside this
    configuration file, which scripts/install-server.sh writes), no runner container is created or
    started unless the firewall service's status (`firewall/status.json`) says its rules are in force
    now, since this host last started, for the configured network's bridge: 503 FIREWALL_NOT_ENFORCED,
    which the manager retries. Neither a boot nor a firewall that stopped checking lets one start
    unprotected.
  - The runner credential, and the generation and instance UID the runner presents, reach the
    container as read-only files in its bootstrap volume (root-owned, mode 0444), written before it
    starts. The credential is never in an environment, a label or a log line, and the runner is
    given neither value in its environment; the channel's own labels name the generation only for
    its identity checks.
  - Disk: a Docker local volume has no size limit of its own. Each data volume is measured with
    Docker's own report every `diskCheckSeconds`; the container of a volume over its limit is
    stopped (with the stop grace), and no container is created for a volume over its limit. The
    pool's disk is the filesystem of `diskProbePath` (in Compose an empty volume of its own, which
    Docker keeps beside the data volumes), or Docker's data root where this process can see it.

Run: `channel.py serve --config <file> [--disk-probe-path <dir>]` (channel.example.json). Python 3
standard library only.
"""

import argparse
import hmac
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import stat
import sys
import tarfile
import tempfile
import threading
import time
import traceback
import urllib.parse
import uuid

# Docker Engine 25 and later; every field used here exists in it but one: TmpfsOptions.Options, which makes /tmp
# executable, came with Engine 27 (API 1.46). An older engine ignores it, and its /tmp stays noexec.
API = "/v1.44"
EXEC_TMPFS_ENGINE = 27
LABEL = "orbit.managed-runner."
INSTANCE_LABEL = LABEL + "instance"
KIND_LABEL = LABEL + "kind"
OWNER_LABEL = LABEL + "owner"
RUNNER_LABEL = LABEL + "runner"
UID_LABEL = LABEL + "uid"
GENERATION_LABEL = LABEL + "generation"
VOLUME_UID_LABEL = LABEL + "volume-uid"
DISK_LIMIT_LABEL = LABEL + "disk-limit-bytes"

# \Z, not $: `$` also matches before a final newline, and "<uuid>\n" is not a runner's name.
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
INSTANCE_ID = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\Z")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}\Z")
LABEL_KEY = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,126}[a-z0-9])?\Z")
TOKEN_SHAPE = re.compile(r"^[\x21-\x7e]{16,512}\Z")
NETWORK_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")

RUNNER_USER = "10001:10001"
DATA_MOUNT = "/var/lib/orbit"
BOOT_MOUNT = "/run/orbit-bootstrap"
TMP_MOUNT = "/tmp"
RUNNER_NAME = "orbit-managed"
MAX_BODY = 64 * 1024
GiB = 2 ** 30
# What the runner needs in its environment, and nothing else: never a credential or a generation.
RUNNER_ENV_KEYS = (
    "ORBIT_RUNNER_SERVER_URL", "ORBIT_RUNNER_NAME", "ORBIT_RUNNER_MAX_CONCURRENT", "ORBIT_RUNNER_EXPECTED_ID",
    "ORBIT_RUNNER_CREDENTIAL_FILE", "ORBIT_MANAGED_RUNNER_INSTANCE_FILE",
)
# Docker container states in which processes of the container may exist.
LIVE_STATES = ("running", "paused", "restarting")
# The managed runners' host firewall (deploy/managed-runner/firewall): its directory, beside the configuration file.
FIREWALL_DIR = "firewall"
ZERO_TIME = "0001-01-01T00:00:00Z"


def data_volume_name(runner_id):
    return f"mr-data-{runner_id}"


def container_name(runner_id):
    return f"mr-{runner_id}"


def boot_volume_name(runner_id, generation):
    return f"mr-boot-{runner_id}-g{generation}"


def runner_of_data_volume(name):
    match = re.fullmatch(r"mr-data-([0-9a-f-]{36})", name or "")
    return match.group(1) if match and UUID.match(match.group(1)) else None


def runner_of_container(name):
    match = re.fullmatch(r"mr-([0-9a-f-]{36})", name or "")
    return match.group(1) if match and UUID.match(match.group(1)) else None


def log(message):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"{stamp} orbit-docker-channel: {message}", file=sys.stderr, flush=True)


class Refused(Exception):
    """A request the channel will not carry out: an HTTP status, a stable code and a sentence."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# ── configuration ───────────────────────────────────────────────────────────────────────────────

def load_config(path):
    """Read and check the channel's configuration. Every problem is reported, not just the first."""
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"the configuration at {path} could not be read as JSON: {error}") from None
    return parse_config(value)


def parse_config(value):
    problems = []
    if not isinstance(value, dict):
        raise ValueError("the configuration must be a JSON object")

    def need(key, check, why):
        v = value.get(key)
        if not check(v):
            problems.append(f"{key} {why}")
        return v

    def absolute(v):
        return isinstance(v, str) and os.path.isabs(v)

    def positive(v, upper):
        return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= upper

    known = {"schemaVersion", "instanceId", "listen", "tokenFile", "dockerSocket", "stateDir", "image", "network",
             "limits", "stopGraceSeconds", "diskCheckSeconds", "diskProbePath", "volumeLimitOverrides", "extraLabels",
             "socketMode", "logMaxSize", "logMaxFiles", "allowVolumeRemoval"}
    for key in value:
        if key not in known:
            problems.append(f"{key} is not a configuration field")
    if value.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    need("instanceId", lambda v: isinstance(v, str) and INSTANCE_ID.match(v), "must be a DNS label (the label value every resource carries)")
    need("tokenFile", absolute, "must be an absolute path")
    need("dockerSocket", absolute, "must be an absolute path")
    need("stateDir", absolute, "must be an absolute path")
    need("image", lambda v: isinstance(v, str) and IMAGE_ID.match(v), "must be a local image ID, sha256:<64 hex>")
    need("network", lambda v: isinstance(v, str) and NETWORK_NAME.match(v) and v not in ("host", "none", "bridge", "default"),
         "must name the dedicated network managed runners join (never host, none or the default bridge)")
    need("stopGraceSeconds", lambda v: positive(v, 3600), "must be an integer from 1 to 3600")
    need("diskCheckSeconds", lambda v: positive(v, 86400) and v >= 10, "must be an integer from 10 to 86400")
    listen = value.get("listen")
    if not isinstance(listen, dict) or len(listen) != 1 or not (
            ("unixSocket" in listen and absolute(listen["unixSocket"]))
            or ("tcp" in listen and isinstance(listen["tcp"], dict)
                and listen["tcp"].get("host") in ("127.0.0.1", "::1")
                and positive(listen["tcp"].get("port"), 65535))):
        problems.append("listen must be {\"unixSocket\": <absolute path>} or {\"tcp\": {\"host\": \"127.0.0.1\" or \"::1\", \"port\": <port>}}")
    limits = value.get("limits")
    limit_keys = ("maxCpuMillis", "maxMemoryBytes", "maxPids", "maxTmpBytes", "maxVolumeBytes", "maxConcurrent")
    if not isinstance(limits, dict) or not set(limit_keys) <= set(limits) <= {*limit_keys, "maxContainers"} or not all(
            positive(limits[k], 2 ** 53) for k in limits):
        problems.append(f"limits must give every one of {', '.join(limit_keys)}, and may give maxContainers, as a positive integer")
    if "diskProbePath" in value and not absolute(value["diskProbePath"]):
        problems.append("diskProbePath must be an absolute path")
    overrides = value.get("volumeLimitOverrides", {})
    if not isinstance(overrides, dict) or not all(
            runner_of_data_volume(k) and positive(v, 2 ** 53) for k, v in overrides.items()):
        problems.append("volumeLimitOverrides must map data volume names (mr-data-<uuid>) to byte counts")
    extra = value.get("extraLabels", {})
    if not isinstance(extra, dict) or not all(
            isinstance(k, str) and LABEL_KEY.match(k) and not k.startswith(LABEL) and isinstance(v, str) and len(v) <= 128
            for k, v in extra.items()):
        problems.append(f"extraLabels must map label keys outside {LABEL} to short strings")
    if "socketMode" in value and not (isinstance(value["socketMode"], int) and not isinstance(value["socketMode"], bool)
                                      and 0 <= value["socketMode"] and value["socketMode"] & ~0o770 == 0):
        problems.append("socketMode must be a file mode no wider than 0770: nobody outside the owner and its group")
    if "logMaxSize" in value and not (isinstance(value["logMaxSize"], str) and re.fullmatch(r"[1-9][0-9]{0,4}[km]", value["logMaxSize"])):
        problems.append("logMaxSize must look like 10m")
    if "logMaxFiles" in value and not positive(value["logMaxFiles"], 20):
        problems.append("logMaxFiles must be an integer from 1 to 20")
    if "allowVolumeRemoval" in value and not isinstance(value["allowVolumeRemoval"], bool):
        problems.append("allowVolumeRemoval must be true or false")
    if problems:
        raise ValueError("; ".join(problems))
    config = dict(value)
    config.setdefault("volumeLimitOverrides", {})
    config.setdefault("extraLabels", {})
    config.setdefault("socketMode", 0o600)
    config.setdefault("logMaxSize", "10m")
    config.setdefault("logMaxFiles", 3)
    config.setdefault("allowVolumeRemoval", False)
    return config


def default_max_containers(info):
    """With no limits.maxContainers: one container per CPU and per GiB of memory of the host, whichever is fewer.
    That holds every runner of a profile giving each at least one CPU and 1 GiB, which is more than the manager's
    budget (the host less a reserve) can ever start; it reads this cap in /v1/info and plans for no more."""
    return max(1, min(int(info.get("NCPU") or 0), int(info.get("MemTotal") or 0) // GiB))


def network_bridge(network):
    """The Linux bridge of a Docker bridge network: the name its options give, or Docker's br-<first 12 of its ID>."""
    named = (network.get("Options") or {}).get("com.docker.network.bridge.name")
    return named or (f"br-{network['Id'][:12]}" if network.get("Id") else None)


def boot_id(path="/proc/sys/kernel/random/boot_id"):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def firewall_status(path, now, current_boot=None):
    """(True, status) if the firewall service's status file says its rules are in force now, or (False, why not): the
    same reading as the firewall's own health check (deploy/managed-runner/firewall/firewall.py, read_status)."""
    try:
        status = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        return False, f"no status from the firewall service ({error.__class__.__name__})"
    if not isinstance(status, dict) or status.get("schemaVersion") != 1:
        return False, "the firewall's status file is not one this channel reads"
    current_boot = boot_id() if current_boot is None else current_boot
    if status.get("state") != "enforced":
        return False, f"the firewall service reports {status.get('state')!r}: {status.get('reason', 'no reason given')}"
    if current_boot and status.get("bootId") != current_boot:
        return False, "the firewall's status is from before this host last started"
    valid_until = status.get("validUntil")
    if not isinstance(valid_until, int) or now > valid_until:
        return False, f"the firewall service has not confirmed its rules since {status.get('checkedAt')}"
    return True, status


def read_token(path):
    """The bearer token the apiserver presents. A token file others may read is refused."""
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError(f"{path} must be a regular file that only its owner can read (mode 0600 or 0400)")
    token = Path(path).read_text().strip()
    if not TOKEN_SHAPE.match(token) or len(token) < 32:
        raise ValueError(f"{path} must hold one token of at least 32 printable characters")
    return token


# ── the Docker Engine API ───────────────────────────────────────────────────────────────────────

class DockerError(Exception):
    def __init__(self, status, message):
        super().__init__(f"Docker answered {status}: {message}")
        self.status = status
        self.message = message


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.unix_path)
        self.sock = sock


class Docker:
    """The Engine API over its unix socket: only the calls this channel makes, one connection each."""

    def __init__(self, socket_path, timeout=60):
        self.socket_path = socket_path
        self.timeout = timeout

    def call(self, method, path, query=None, body=None, raw=None, timeout=None):
        url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
        headers, payload = {}, None
        if body is not None:
            payload, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        elif raw is not None:
            payload, headers["Content-Type"] = raw, "application/x-tar"
        connection = UnixConnection(self.socket_path, timeout or self.timeout)
        try:
            connection.request(method, url, body=payload, headers=headers)
            response = connection.getresponse()
            data = response.read()
        finally:
            connection.close()
        if response.status >= 400:
            try:
                message = json.loads(data).get("message", "")
            except (ValueError, AttributeError):
                message = data.decode("utf-8", "replace")[:300]
            raise DockerError(response.status, message)
        if not data:
            return None
        return json.loads(data) if "json" in (response.getheader("Content-Type") or "") else data

    def maybe(self, method, path, **kwargs):
        try:
            return self.call(method, path, **kwargs)
        except DockerError as error:
            if error.status == 404:
                return None
            raise

    @staticmethod
    def filters(**values):
        return {"filters": json.dumps({k: v for k, v in values.items() if v})}

    def info(self):
        return self.call("GET", "/info")

    def volume_usage(self):
        """Every local volume's size as Docker measures it: name → bytes (absent when not measured)."""
        df = self.call("GET", "/system/df", query={"type": "volume"}, timeout=max(self.timeout, 600))
        sizes = {}
        for volume in (df or {}).get("Volumes") or []:
            size = (volume.get("UsageData") or {}).get("Size", -1)
            if isinstance(size, int) and size >= 0:
                sizes[volume["Name"]] = size
        return sizes

    def image(self, ref):
        return self.maybe("GET", f"/images/{urllib.parse.quote(ref, safe=':')}/json")

    def network(self, name):
        return self.maybe("GET", f"/networks/{urllib.parse.quote(name)}")

    def volume(self, name):
        return self.maybe("GET", f"/volumes/{urllib.parse.quote(name)}")

    def volumes(self, labels):
        return (self.call("GET", "/volumes", query=self.filters(label=labels)) or {}).get("Volumes") or []

    def create_volume(self, name, labels):
        return self.call("POST", "/volumes/create", body={"Name": name, "Driver": "local", "Labels": labels})

    def remove_volume(self, name):
        self.call("DELETE", f"/volumes/{urllib.parse.quote(name)}")

    def container(self, name):
        found = self.maybe("GET", f"/containers/{urllib.parse.quote(name)}/json")
        # Docker also resolves an ID prefix; only the exact name is this container.
        return found if found and found.get("Name") == f"/{name}" else None

    def containers(self, labels=None, volume=None):
        return self.call("GET", "/containers/json", query={"all": "1", **self.filters(label=labels, volume=[volume] if volume else None)}) or []

    def create_container(self, name, spec):
        return self.call("POST", "/containers/create", query={"name": name}, body=spec)

    def put_archive(self, name, path, tar_bytes):
        self.call("PUT", f"/containers/{urllib.parse.quote(name)}/archive", query={"path": path, "noOverwriteDirNonDir": "true"}, raw=tar_bytes)

    def start_container(self, name):
        self.call("POST", f"/containers/{urllib.parse.quote(name)}/start")

    def stop_container(self, name, seconds):
        self.call("POST", f"/containers/{urllib.parse.quote(name)}/stop", query={"t": str(seconds)}, timeout=seconds + 60)

    def remove_container(self, name):
        self.call("DELETE", f"/containers/{urllib.parse.quote(name)}", query={"v": "0", "force": "0"})


# ── credentials: the runner credential of a generation, until its container starts ─────────────

def durable_write(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".channel-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_private_json(path):
    """A file this channel wrote (or an operator left): a regular file, never a symlink, under 64 KiB."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BODY:
        raise ValueError(f"{path} is not a regular file of at most {MAX_BODY} bytes")
    return json.loads(path.read_text())


class CredentialStore:
    """One JSON file per runner under the state directory (0700 directory, 0600 files)."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)

    def path(self, runner_id):
        return self.directory / f"{runner_id}.json"

    def read(self, runner_id):
        return read_private_json(self.path(runner_id))

    def write(self, record):
        durable_write(self.path(record["runnerId"]), record)

    def remove(self, runner_id):
        self.path(runner_id).unlink(missing_ok=True)

    def all(self):
        found = []
        for path in sorted(self.directory.glob("*.json")):
            if UUID.match(path.stem):
                record = read_private_json(path)
                if record:
                    found.append(record)
        return found


# ── the container template and its checks ───────────────────────────────────────────────────────

def container_spec(config, request, instance_uid, extra_labels=None):
    """The one container a request may have: this channel's template, filled with identities and amounts."""
    runner_id, generation = request["runnerId"], request["generation"]
    resources, runner = request["resources"], request["runner"]
    labels = {
        **config["extraLabels"], **(extra_labels or {}),
        INSTANCE_LABEL: config["instanceId"],
        KIND_LABEL: "runner",
        OWNER_LABEL: request["ownerId"],
        RUNNER_LABEL: runner_id,
        GENERATION_LABEL: str(generation),
        VOLUME_UID_LABEL: request["volume"]["uid"],
        UID_LABEL: instance_uid,
    }
    boot_labels = {
        **config["extraLabels"],
        INSTANCE_LABEL: config["instanceId"],
        KIND_LABEL: "bootstrap",
        OWNER_LABEL: request["ownerId"],
        RUNNER_LABEL: runner_id,
        GENERATION_LABEL: str(generation),
    }
    return {
        "Image": config["image"],
        "Cmd": ["run"],
        "User": RUNNER_USER,
        "Env": [
            f"ORBIT_RUNNER_SERVER_URL={runner['serverUrl']}",
            f"ORBIT_RUNNER_NAME={RUNNER_NAME}",
            f"ORBIT_RUNNER_MAX_CONCURRENT={runner['maxConcurrent']}",
            f"ORBIT_RUNNER_EXPECTED_ID={runner_id}",
            f"ORBIT_RUNNER_CREDENTIAL_FILE={BOOT_MOUNT}/token",
            f"ORBIT_MANAGED_RUNNER_INSTANCE_FILE={BOOT_MOUNT}/instance.json",
        ],
        "Labels": labels,
        "StopSignal": "SIGTERM",
        "StopTimeout": config["stopGraceSeconds"],
        "NetworkDisabled": False,
        "AttachStdin": False,
        "OpenStdin": False,
        "Tty": False,
        "HostConfig": {
            "NetworkMode": config["network"],
            "Mounts": [
                {"Type": "volume", "Source": data_volume_name(runner_id), "Target": DATA_MOUNT, "ReadOnly": False,
                 "VolumeOptions": {"NoCopy": False}},
                {"Type": "volume", "Source": boot_volume_name(runner_id, generation), "Target": BOOT_MOUNT, "ReadOnly": False,
                 "VolumeOptions": {"NoCopy": True, "Labels": boot_labels}},
                # Executable: builds and test runners (go test among them) run what they write there. Docker keeps it
                # nosuid and nodev whatever is asked, and takes no option here but exec and noexec.
                {"Type": "tmpfs", "Target": TMP_MOUNT,
                 "TmpfsOptions": {"SizeBytes": resources["tmpBytes"], "Mode": 0o1777, "Options": [["exec"]]}},
            ],
            "Binds": [],
            "Devices": [],
            "DeviceRequests": [],
            "DeviceCgroupRules": [],
            "NanoCpus": resources["cpuMillis"] * 1_000_000,
            "Memory": resources["memoryBytes"],
            "MemorySwap": resources["memoryBytes"],
            "PidsLimit": resources["pids"],
            "OomKillDisable": False,
            "CapAdd": [],
            "CapDrop": ["ALL"],
            "Privileged": False,
            "SecurityOpt": ["no-new-privileges:true"],
            "ReadonlyRootfs": True,
            "IpcMode": "private",
            "PidMode": "",
            "UTSMode": "",
            "UsernsMode": "",
            "CgroupnsMode": "private",
            "GroupAdd": [],
            "Sysctls": {},
            "PortBindings": {},
            "PublishAllPorts": False,
            "ExtraHosts": [],
            "VolumesFrom": [],
            "Links": [],
            "RestartPolicy": {"Name": "no"},
            "AutoRemove": False,
            "Init": False,
            "LogConfig": {"Type": "json-file", "Config": {"max-size": config["logMaxSize"], "max-file": str(config["logMaxFiles"])}},
        },
    }


def unsafe(config, spec):
    """Why a container spec breaks the channel's rules: an empty list when it keeps every one of them."""
    host = spec.get("HostConfig") or {}
    problems = []

    def bad(condition, what):
        if condition:
            problems.append(what)

    bad(spec.get("Image") != config["image"], "an image other than the configured one")
    bad(spec.get("User") != RUNNER_USER, "a user other than 10001:10001")
    bad(host.get("Privileged"), "privileged mode")
    bad(host.get("CapAdd"), "added capabilities")
    bad(host.get("CapDrop") != ["ALL"], "capabilities not all dropped")
    bad(host.get("Binds"), "host directory binds")
    bad(host.get("Devices") or host.get("DeviceRequests") or host.get("DeviceCgroupRules"), "devices")
    bad(host.get("NetworkMode") != config["network"], "a network other than the configured one")
    bad(host.get("PidMode") not in ("", None), "a shared PID namespace")
    bad(host.get("IpcMode") not in ("private",), "a shared IPC namespace")
    bad(host.get("UTSMode") not in ("", None), "a shared UTS namespace")
    bad(host.get("UsernsMode") not in ("", None), "a user namespace mode")
    bad(host.get("CgroupnsMode") != "private", "the host cgroup namespace")
    bad(not host.get("ReadonlyRootfs"), "a writable root filesystem")
    options = host.get("SecurityOpt") or []
    bad("no-new-privileges:true" not in options and "no-new-privileges" not in options, "no-new-privileges off")
    bad(any(re.search(r"unconfined|label[:=]disable|systempaths", o) for o in options), "a weakened security profile")
    bad(host.get("VolumesFrom") or host.get("Links") or host.get("ExtraHosts"), "another container's volumes, links or host entries")
    bad(host.get("PortBindings") or host.get("PublishAllPorts"), "published ports")
    bad(host.get("Sysctls") or host.get("GroupAdd"), "sysctls or extra groups")
    bad(not (host.get("NanoCpus") or 0) > 0 or not (host.get("Memory") or 0) > 0 or not (host.get("PidsLimit") or 0) > 0,
        "a missing CPU, memory or PID limit")
    bad(host.get("MemorySwap") != host.get("Memory"), "swap beyond the memory limit")
    bad((host.get("RestartPolicy") or {}).get("Name") not in ("no", "", None), "a restart policy")
    mounts = host.get("Mounts") or []
    expected_targets = {DATA_MOUNT: "volume", BOOT_MOUNT: "volume", TMP_MOUNT: "tmpfs"}
    bad(sorted(m.get("Target") for m in mounts) != sorted(expected_targets), "mounts other than the data volume, bootstrap volume and /tmp")
    for mount in mounts:
        kind, target, source = mount.get("Type"), mount.get("Target"), mount.get("Source") or ""
        bad(expected_targets.get(target) != kind, f"a {kind} mount at {target}")
        bad(kind == "bind", "a host directory mount")
        bad("docker.sock" in source or source.startswith("/"), "a host path as a volume source")
        if target == DATA_MOUNT:
            bad(not runner_of_data_volume(source), "a data volume that is not a managed runner's")
        if target == BOOT_MOUNT:
            bad(not re.fullmatch(r"mr-boot-[0-9a-f-]{36}-g[1-9][0-9]*", source), "a bootstrap volume that is not a managed runner's")
        if target == TMP_MOUNT and kind == "tmpfs":
            tmpfs = mount.get("TmpfsOptions") or {}
            bad(not (tmpfs.get("SizeBytes") or 0) > 0, "a /tmp without a size limit")
            # None: an engine older than 27 drops the option, and its /tmp stays noexec (prepare warns).
            bad(tmpfs.get("Options") not in (None, [], [["exec"]]), "/tmp mount options other than exec")
    env = spec.get("Env") or []
    bad(sorted(e.split("=", 1)[0] for e in env) != sorted(RUNNER_ENV_KEYS), "an environment other than the runner's")
    bad(any("docker.sock" in e or "DOCKER_HOST" in e for e in env), "the Docker socket in the environment")
    return problems


def unsafe_container(config, inspected, image_env=()):
    """What Docker made of a created container, checked against the same rules. Its environment is the
    template's plus the image's own (PATH, HOME, ...), and nothing else."""
    host = inspected.get("HostConfig") or {}
    cfg = inspected.get("Config") or {}
    mounts = inspected.get("Mounts") or []
    env = cfg.get("Env") or []
    template_env = [e for e in env if e.split("=", 1)[0] in RUNNER_ENV_KEYS]
    foreign_env = [e.split("=", 1)[0] for e in env if e.split("=", 1)[0] not in RUNNER_ENV_KEYS and e not in image_env]
    as_spec = {
        "Image": inspected.get("Image"),
        "User": cfg.get("User"),
        "Env": template_env,
        "HostConfig": {
            **host,
            "Mounts": [{"Type": m.get("Type"), "Target": m.get("Destination"), "Source": m.get("Name") or m.get("Source") or ""}
                       for m in mounts if m.get("Type") != "tmpfs"]
            + [{"Type": "tmpfs", "Target": target} for target in (host.get("Tmpfs") or {})]
            + [{"Type": "tmpfs", "Target": m.get("Target"), "TmpfsOptions": m.get("TmpfsOptions")}
               for m in (host.get("Mounts") or []) if m.get("Type") == "tmpfs"],
            "CgroupnsMode": host.get("CgroupnsMode") or "private",
            "IpcMode": host.get("IpcMode") or "private",
        },
    }
    problems = unsafe(config, as_spec)
    if foreign_env:
        problems.append(f"environment the template did not set: {', '.join(sorted(foreign_env))}")
    return problems


def bootstrap_archive(token, generation, instance):
    """The bootstrap files, root-owned and read-only, as the tar Docker extracts into the bootstrap volume."""
    buffer = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data in (("token", token.encode()), ("generation", str(generation).encode()),
                           ("instance.json", json.dumps(instance, sort_keys=True).encode())):
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.uid, entry.gid, entry.mtime = len(data), 0o444, 0, 0, now
            entry.uname = entry.gname = "root"
            tar.addfile(entry, io.BytesIO(data))
    return buffer.getvalue()


# ── request checks ──────────────────────────────────────────────────────────────────────────────

def strict(body, allowed, where="the request"):
    """A JSON object holding only `allowed` keys. Anything else is refused by name, Docker parameters first."""
    if not isinstance(body, dict):
        raise Refused(400, "BODY_REFUSED", f"{where} must be a JSON object")
    for key in body:
        if key not in allowed:
            raise Refused(400, "PARAMETER_REFUSED",
                          f"{where} may not carry {key!r}: containers are built from this channel's template alone, "
                          "and it takes no Docker parameters (privileged mode, capabilities, host paths, the Docker "
                          "socket, host namespaces, devices or anything else)")
    return body


def uuid_field(body, key):
    value = body.get(key)
    if not isinstance(value, str) or not UUID.match(value):
        raise Refused(400, "PARAMETER_REFUSED", f"{key} must be a canonical lowercase UUID")
    return value


def count_field(body, key, upper, name=None):
    value = body.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise Refused(400, "PARAMETER_REFUSED", f"{name or key} must be a positive integer")
    if value > upper:
        raise Refused(403, "LIMIT_REFUSED", f"{name or key} {value} is above this channel's ceiling of {upper}")
    return value


def server_url_field(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise Refused(400, "PARAMETER_REFUSED", "runner.serverUrl must be a URL")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Refused(400, "PARAMETER_REFUSED", "runner.serverUrl must be an http(s) URL with no credentials, query or fragment")
    return value


# ── the channel ─────────────────────────────────────────────────────────────────────────────────

class Channel:
    def __init__(self, config, docker, token, clock=time.time, firewall_dir=None):
        self.config = config
        self.docker = docker
        self.token = token
        self.clock = clock
        state = Path(config["stateDir"])
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(state, 0o700)
        self.credentials = CredentialStore(state / "credentials")
        self.evictions = state / "evictions"
        self.evictions.mkdir(mode=0o700, exist_ok=True)
        self.fencing = state / "fencing"
        self.fencing.mkdir(mode=0o700, exist_ok=True)
        self._locks = {}
        self._locks_guard = threading.Lock()
        self._usage = {}
        self._usage_at = None
        self._usage_lock = threading.Lock()
        self._stopping = set()
        self._stopping_lock = threading.Lock()
        self._create_lock = threading.Lock()  # counting the containers and making one are one step
        self.max_containers = None
        self.host_name = None
        self.network_facts = None
        self.image_env = ()
        self.firewall_dir = Path(firewall_dir) if firewall_dir else None

    # ── start-up ────────────────────────────────────────────────────────────────────────────────

    def prepare(self):
        """Check the environment before serving, and finish what a stopped channel left half done."""
        info = self.docker.info()
        self.host_name = info.get("Name") or socket.gethostname()
        configured = self.config["limits"].get("maxContainers")
        self.max_containers = configured or default_max_containers(info)
        log(f"containers of this instance: at most {self.max_containers}"
            + ("" if configured else " (one per CPU and per GiB of this host's memory, whichever is fewer)"))
        engine = re.match(r"(\d+)\.", info.get("ServerVersion") or "")
        if engine and int(engine.group(1)) < EXEC_TMPFS_ENGINE:
            log(f"warning: Docker {info.get('ServerVersion')} ignores TmpfsOptions.Options: runners' /tmp stays noexec until Docker {EXEC_TMPFS_ENGINE}")
        probe = self.config.get("diskProbePath")
        if probe and not os.path.isdir(probe):
            raise ValueError(f"the disk probe path {probe} is not a directory: the storage budget would measure nothing")
        root = info.get("DockerRootDir")
        if not probe and not (root and os.path.isdir(root)):
            log(f"warning: Docker's data root {root} is not visible here and no disk probe path is set: the storage budget "
                f"measures the disk under {self.config['stateDir']}, which is right only if Docker's volumes are on it too")
        image = self.docker.image(self.config["image"])
        if not image or image.get("Id") != self.config["image"]:
            raise ValueError(f"the configured image {self.config['image']} is not on this Docker host")
        self.image_env = tuple((image.get("Config") or {}).get("Env") or ())
        network = self.docker.network(self.config["network"])
        if not network:
            raise ValueError(f"the configured network {self.config['network']} does not exist")
        if network.get("Driver") != "bridge":
            raise ValueError(f"the configured network {self.config['network']} is a {network.get('Driver')} network, not a bridge")
        options = network.get("Options") or {}
        self.network_facts = {
            "name": network.get("Name"),
            "internal": bool(network.get("Internal")),
            "interContainer": options.get("com.docker.network.bridge.enable_icc", "true") != "false",
        }
        if self.network_facts["interContainer"]:
            log(f"warning: network {self.config['network']} lets containers reach each other; create it with com.docker.network.bridge.enable_icc=false")
        self.finish_interrupted_creates()

    def finish_interrupted_creates(self):
        """A container this channel created and never started (it stopped in between) is started now, or left
        for the manager when its credential is gone. Never started means no process of it ever ran."""
        for summary in self.docker.containers(labels=[f"{INSTANCE_LABEL}={self.config['instanceId']}", f"{KIND_LABEL}=runner"]):
            name = (summary.get("Names") or ["/"])[0].lstrip("/")
            runner_id = runner_of_container(name)
            if not runner_id or summary.get("State") != "created":
                continue
            with self.lock(runner_id):
                found = self.docker.container(name)
                if not found or not self.ours(found["Config"].get("Labels")) or found["State"].get("Status") != "created":
                    continue
                labels = found["Config"]["Labels"]
                credential = self.credentials.read(runner_id)
                if not credential or str(credential.get("generation")) != labels.get(GENERATION_LABEL):
                    log(f"container {name} was created and never started, and its credential is gone: left for the manager")
                    continue
                problems = unsafe_container(self.config, found, self.image_env)
                if problems:
                    log(f"container {name} breaks the template ({'; '.join(problems)}): removed before it ever ran")
                    self.docker.remove_container(name)
                    continue
                refusal = self.firewall_refusal()
                if refusal:
                    log(f"container {name} was created and never started: left for the manager, the firewall not being in force ({refusal})")
                    continue
                self.populate_and_start(name, credential, int(labels[GENERATION_LABEL]), runner_id, labels[UID_LABEL])
                log(f"container {name}: an interrupted create was finished and started")

    # ── the managed runners' host firewall ──────────────────────────────────────────────────────

    def firewall_refusal(self):
        """Why no runner container may start now, or None. Only where the firewall is configured (the install writes
        firewall/config.json beside this configuration file): then its service's status must say the rules are in
        force, fresh and from this boot, for the bridge the configured network has now."""
        if self.firewall_dir is None or not (self.firewall_dir / "config.json").exists():
            return None
        ok, status = firewall_status(self.firewall_dir / "status.json", self.clock())
        if not ok:
            return status
        network = self.docker.network(self.config["network"]) or {}
        bridge = network_bridge(network)
        if status.get("bridge") != bridge:
            return (f"its rules are for the bridge {status.get('bridge')}, and network {self.config['network']} has "
                    f"{bridge or 'no bridge'} now")
        if status.get("gateway") not in {entry.get("Gateway") for entry in (network.get("IPAM") or {}).get("Config") or []}:
            return f"its rules are for the gateway {status.get('gateway')}, which network {self.config['network']} does not have"
        return None

    def require_firewall(self):
        refusal = self.firewall_refusal()
        if refusal:
            log(f"no runner container is started: the managed runners' host firewall is not in force ({refusal})")
            raise Refused(503, "FIREWALL_NOT_ENFORCED", f"the managed runners' host firewall is not in force: {refusal}")

    # ── helpers ─────────────────────────────────────────────────────────────────────────────────

    def lock(self, runner_id):
        with self._locks_guard:
            return self._locks.setdefault(runner_id, threading.Lock())

    def ours(self, labels):
        return (labels or {}).get(INSTANCE_LABEL) == self.config["instanceId"]

    def authorized(self, header):
        presented = header[len("Bearer "):] if isinstance(header, str) and header.startswith("Bearer ") else ""
        return hmac.compare_digest(presented.encode(), self.token.encode())

    def base_labels(self, kind):
        return {**self.config["extraLabels"], INSTANCE_LABEL: self.config["instanceId"], KIND_LABEL: kind}

    def volume_limit(self, name, labels):
        override = self.config["volumeLimitOverrides"].get(name)
        if override:
            return override
        said = (labels or {}).get(DISK_LIMIT_LABEL, "")
        return int(said) if said.isdigit() else None

    # ── disk usage ──────────────────────────────────────────────────────────────────────────────

    def measure(self):
        sizes = self.docker.volume_usage()
        with self._usage_lock:
            self._usage, self._usage_at = sizes, self.clock()
        return sizes

    def usage(self, name, fresh=False):
        """A volume's measured bytes: the last measurement if it is recent enough, otherwise measured now."""
        with self._usage_lock:
            recent = self._usage_at is not None and self.clock() - self._usage_at <= self.config["diskCheckSeconds"]
            if recent and not fresh:
                return self._usage.get(name)
        return self.measure().get(name)

    def eviction_path(self, instance_uid):
        return self.evictions / f"{instance_uid}.json"

    def eviction(self, instance_uid):
        try:
            return read_private_json(self.eviction_path(instance_uid)) if UUID.match(instance_uid or "") else None
        except ValueError:
            return None

    def enforce_disk_limits(self):
        """One check: the container of every data volume over its limit is stopped, and why is kept."""
        sizes = self.measure()
        evicted = []
        for volume in self.docker.volumes([f"{INSTANCE_LABEL}={self.config['instanceId']}", f"{KIND_LABEL}=data"]):
            name, labels = volume["Name"], volume.get("Labels") or {}
            limit, used = self.volume_limit(name, labels), sizes.get(name)
            runner_id = runner_of_data_volume(name)
            if limit is None or used is None or used <= limit or not runner_id:
                continue
            found = self.docker.container(container_name(runner_id))
            if not found or not self.ours(found["Config"].get("Labels")) or found["State"].get("Status") not in LIVE_STATES:
                continue
            instance_uid = found["Config"]["Labels"].get(UID_LABEL, "")
            if not self.eviction(instance_uid):
                try:
                    durable_write(self.eviction_path(instance_uid), {
                        "reason": "VOLUME_OVER_LIMIT", "volume": name, "usageBytes": used, "limitBytes": limit,
                        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock())),
                    })
                except OSError as error:
                    # A full disk is when the limit matters most: the stop never waits for the record of why.
                    log(f"container {container_name(runner_id)}: the reason for its stop could not be kept ({error})")
                log(f"container {container_name(runner_id)}: volume {name} holds {used} bytes, over its {limit}-byte limit; stopping it")
            self.stop_in_background(container_name(runner_id))
            evicted.append(container_name(runner_id))
        return evicted

    def watch_disk(self, stop_event):
        while not stop_event.wait(self.config["diskCheckSeconds"]):
            try:
                self.enforce_disk_limits()
            except Exception as error:  # noqa: BLE001 - one failed check must not end the watch
                log(f"disk check failed: {error}")

    # ── views ───────────────────────────────────────────────────────────────────────────────────

    def volume_view(self, volume):
        labels = volume.get("Labels") or {}
        name = volume["Name"]
        with self._usage_lock:
            measured = self._usage.get(name)
        return {
            "name": name, "uid": labels.get(UID_LABEL), "ownerId": labels.get(OWNER_LABEL), "runnerId": labels.get(RUNNER_LABEL),
            "limitBytes": self.volume_limit(name, labels), "createdAt": volume.get("CreatedAt"), "usageBytes": measured,
        }

    def container_view(self, found):
        labels = found["Config"].get("Labels") or {}
        state = found.get("State") or {}
        status = state.get("Status")
        started, finished = state.get("StartedAt") or ZERO_TIME, state.get("FinishedAt") or ZERO_TIME
        uid = labels.get(UID_LABEL)
        generation = labels.get(GENERATION_LABEL, "")
        return {
            "name": found["Name"].lstrip("/"),
            "uid": uid,
            "ownerId": labels.get(OWNER_LABEL),
            "runnerId": labels.get(RUNNER_LABEL),
            "generation": int(generation) if generation.isdigit() else None,
            "volumeUid": labels.get(VOLUME_UID_LABEL),
            "volume": next((m.get("Name") for m in found.get("Mounts") or [] if m.get("Destination") == DATA_MOUNT), None),
            "node": self.host_name,
            "status": status,
            "running": status == "running",
            "neverStarted": started.startswith("0001-01-01"),
            "exitCode": state.get("ExitCode") if status in ("exited", "dead") else None,
            "startedAt": None if started.startswith("0001-01-01") else started,
            "finishedAt": None if finished.startswith("0001-01-01") else finished,
            "oomKilled": bool(state.get("OOMKilled")),
            "stopping": found["Name"].lstrip("/") in self._stopping,
            "evicted": self.eviction(uid),
        }

    # ── volumes ─────────────────────────────────────────────────────────────────────────────────

    def check_volume_name(self, name):
        runner_id = runner_of_data_volume(name)
        if not runner_id:
            raise Refused(400, "NAME_REFUSED", "a data volume of this channel is named mr-data-<runner uuid>; nothing else (no host path, no socket) is a volume here")
        return runner_id

    def read_volume(self, name):
        self.check_volume_name(name)
        volume = self.docker.volume(name)
        if not volume or not self.ours(volume.get("Labels")) or (volume.get("Labels") or {}).get(KIND_LABEL) != "data":
            return None
        return self.volume_view(volume)

    def ensure_volume(self, name, body):
        runner_id = self.check_volume_name(name)
        strict(body, {"ownerId", "runnerId", "limitBytes"})
        owner_id, said_runner = uuid_field(body, "ownerId"), uuid_field(body, "runnerId")
        if said_runner != runner_id:
            raise Refused(400, "NAME_REFUSED", "a data volume is named after the runner it belongs to")
        limit = count_field(body, "limitBytes", self.config["limits"]["maxVolumeBytes"])
        with self.lock(runner_id):
            found = self.docker.volume(name)
            if found:
                if not self.ours(found.get("Labels")) or (found.get("Labels") or {}).get(KIND_LABEL) != "data":
                    raise Refused(409, "NOT_MANAGED", f"a volume named {name} exists without this instance's data label; it is never adopted")
                return self.volume_view(found)  # created once: the caller checks whose it is
            labels = {**self.base_labels("data"), OWNER_LABEL: owner_id, RUNNER_LABEL: runner_id,
                      UID_LABEL: str(uuid.uuid4()), DISK_LIMIT_LABEL: str(limit)}
            self.docker.create_volume(name, labels)
            created = self.docker.volume(name)
            if not created or not self.ours(created.get("Labels")):
                raise Refused(409, "NOT_MANAGED", f"a volume named {name} appeared without this instance's label")
            log(f"volume {name} created")
            return self.volume_view(created)

    def holders(self, name):
        """Every container that refers to the volume, in any state, labelled or not: names of ours, a count of others."""
        found = []
        for summary in self.docker.containers(volume=name):
            if self.ours(summary.get("Labels")):
                found.append({"name": (summary.get("Names") or ["/?"])[0].lstrip("/"), "managed": True})
            else:
                found.append({"managed": False})
        return found

    def volume_holders(self, name):
        if self.read_volume(name) is None:
            raise Refused(404, "NOT_FOUND", f"no data volume {name} of this instance")
        return {"holders": self.holders(name)}

    def remove_volume(self, name, uid):
        if not self.config["allowVolumeRemoval"]:
            # The manager never removes a data volume; with removal off, the token removes none either.
            raise Refused(403, "REMOVAL_REFUSED", "volume removal is off on this channel: an operator turns it on with "
                          "allowVolumeRemoval in its configuration (docs/managed-runner-docker-operations.md)")
        runner_id = self.check_volume_name(name)
        with self.lock(runner_id):
            volume = self.read_volume(name)
            if volume is None:
                raise Refused(404, "NOT_FOUND", f"no data volume {name} of this instance")
            if volume["uid"] != uid:
                raise Refused(409, "UID_MISMATCH", f"volume {name} is not the one with UID {uid}")
            if self.holders(name):
                raise Refused(409, "VOLUME_IN_USE", f"volume {name} is still referred to by a container")
            self.docker.remove_volume(name)
            log(f"volume {name} removed")

    # ── credentials ─────────────────────────────────────────────────────────────────────────────

    def check_runner_id(self, runner_id):
        if not UUID.match(runner_id or ""):
            raise Refused(400, "NAME_REFUSED", "a runner is named by its canonical UUID")
        return runner_id

    def credential_view(self, record, with_token=True):
        view = {k: record.get(k) for k in ("uid", "ownerId", "runnerId", "generation", "createdAt")}
        if with_token:
            view["token"] = record.get("token")
        return view

    def read_credential(self, runner_id):
        self.check_runner_id(runner_id)
        record = self.credentials.read(runner_id)
        return self.credential_view(record) if record and record.get("instance") == self.config["instanceId"] else None

    def put_credential(self, runner_id, body):
        self.check_runner_id(runner_id)
        strict(body, {"ownerId", "generation", "token"})
        owner_id = uuid_field(body, "ownerId")
        generation = count_field(body, "generation", 2 ** 31 - 1)
        token = body.get("token")
        if not isinstance(token, str) or not TOKEN_SHAPE.match(token):
            raise Refused(400, "PARAMETER_REFUSED", "token must be 16 to 512 printable characters")
        with self.lock(runner_id):
            existing = self.credentials.read(runner_id)
            if existing:
                return self.credential_view(existing)  # issued once: the caller checks which generation it is for
            record = {"uid": str(uuid.uuid4()), "instance": self.config["instanceId"], "ownerId": owner_id,
                      "runnerId": runner_id, "generation": generation, "token": token,
                      "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock()))}
            self.credentials.write(record)
            log(f"credential of runner {runner_id} stored")
            return self.credential_view(record)

    def delete_credential(self, runner_id, uid):
        self.check_runner_id(runner_id)
        with self.lock(runner_id):
            existing = self.credentials.read(runner_id)
            if not existing:
                raise Refused(404, "NOT_FOUND", f"no credential of runner {runner_id}")
            if existing.get("uid") != uid:
                raise Refused(409, "UID_MISMATCH", f"the credential of runner {runner_id} is not the one with UID {uid}")
            self.credentials.remove(runner_id)
            log(f"credential of runner {runner_id} removed")

    # ── containers ──────────────────────────────────────────────────────────────────────────────

    def check_container_name(self, name):
        runner_id = runner_of_container(name)
        if not runner_id:
            raise Refused(400, "NAME_REFUSED", "a container of this channel is named mr-<runner uuid>")
        return runner_id

    def read_container(self, name):
        runner_id = self.check_container_name(name)
        with self.lock(runner_id):  # never seen half made
            found = self.docker.container(name)
        if not found or not self.ours(found["Config"].get("Labels")):
            return None
        return self.container_view(found)

    def check_container_request(self, body):
        strict(body, {"name", "image", "ownerId", "runnerId", "generation", "volume", "resources", "runner", "dryRun"})
        runner_id = uuid_field(body, "runnerId")
        uuid_field(body, "ownerId")
        count_field(body, "generation", 2 ** 31 - 1)
        if body.get("image") != self.config["image"]:
            raise Refused(403, "IMAGE_REFUSED", f"this channel runs the configured managed runner image {self.config['image']} and no other")
        volume = strict(body.get("volume"), {"name", "uid"}, "volume")
        if not runner_of_data_volume(volume.get("name")):
            raise Refused(400, "NAME_REFUSED", "volume.name must be a managed runner's data volume (mr-data-<runner uuid>); host paths and sockets are never mounted")
        if volume["name"] != data_volume_name(runner_id):
            raise Refused(403, "VOLUME_REFUSED", "a runner's container mounts its own data volume and no other")
        uuid_field(volume, "uid")
        limits = self.config["limits"]
        resources = strict(body.get("resources"), {"cpuMillis", "memoryBytes", "pids", "tmpBytes"}, "resources")
        for key, ceiling in (("cpuMillis", limits["maxCpuMillis"]), ("memoryBytes", limits["maxMemoryBytes"]),
                             ("pids", limits["maxPids"]), ("tmpBytes", limits["maxTmpBytes"])):
            count_field(resources, key, ceiling, f"resources.{key}")
        if resources["tmpBytes"] > resources["memoryBytes"]:
            raise Refused(400, "PARAMETER_REFUSED", "resources.tmpBytes is held in memory and cannot exceed resources.memoryBytes")
        runner = strict(body.get("runner"), {"serverUrl", "maxConcurrent"}, "runner")
        server_url_field(runner.get("serverUrl"))
        count_field(runner, "maxConcurrent", limits["maxConcurrent"], "runner.maxConcurrent")
        if "dryRun" in body and not isinstance(body["dryRun"], bool):
            raise Refused(400, "PARAMETER_REFUSED", "dryRun must be true or false")
        # The single-container guard: a runner's volume is used by the container under its fixed name only.
        if body.get("name") != container_name(runner_id):
            raise Refused(409, "SINGLE_CONTAINER_GUARD",
                          f"only {container_name(runner_id)} may use this runner's data volume; a container under any other name is refused")
        return runner_id

    def same_identity(self, labels, body):
        return (labels.get(OWNER_LABEL) == body["ownerId"] and labels.get(RUNNER_LABEL) == body["runnerId"]
                and labels.get(GENERATION_LABEL) == str(body["generation"]) and labels.get(VOLUME_UID_LABEL) == body["volume"]["uid"])

    def create_container(self, body):
        runner_id = self.check_container_request(body)
        if body.get("dryRun"):
            return 200, {"dryRun": True, "admitted": True}
        name = body["name"]
        with self.lock(runner_id):
            for _ in range(2):
                found = self.docker.container(name)
                if found:
                    labels = found["Config"].get("Labels") or {}
                    if not self.ours(labels):
                        raise Refused(409, "NOT_MANAGED", f"a container named {name} exists without this instance's label")
                    status = found["State"].get("Status")
                    never_started = status == "created" and (found["State"].get("StartedAt") or ZERO_TIME).startswith("0001-01-01")
                    # One made before the configuration changed — from the previous image after an upgrade —
                    # is never started: only the configured image runs, and having never run it is removed.
                    stale = never_started and unsafe_container(self.config, found, self.image_env)
                    if self.same_identity(labels, body) and not stale:
                        if status == "created":
                            self.require_firewall()
                            credential = self.matching_credential(body)
                            self.populate_and_start(name, credential, body["generation"], runner_id, labels[UID_LABEL])
                            return 200, self.container_view(self.docker.container(name))
                        return 200, self.container_view(found)  # created once; a stopped one is never started again
                    if never_started:
                        log(f"container {name}: an earlier container that never started was removed"
                            f"{' (it breaks the template: ' + '; '.join(stale) + ')' if stale else ''}")
                        self.remove_with_bootstrap(name, found)
                        continue
                    raise Refused(409, "CONTAINER_CONFLICT",
                                  f"an earlier {name} is still there; it is removed only once its stop is proven")
                self.require_firewall()
                created = self.create_new(name, runner_id, body)
                if created is not None:
                    return 201, created
            raise Refused(409, "CONTAINER_CONFLICT", f"{name} kept changing while it was created")

    def matching_credential(self, body):
        credential = self.credentials.read(body["runnerId"])
        if (not credential or credential.get("instance") != self.config["instanceId"]
                or credential.get("ownerId") != body["ownerId"] or credential.get("generation") != body["generation"]):
            raise Refused(409, "CREDENTIAL_MISSING", f"no credential of runner {body['runnerId']} for generation {body['generation']} is stored here")
        return credential

    def create_new(self, name, runner_id, body):
        volume_name = body["volume"]["name"]
        volume = self.docker.volume(volume_name)
        labels = (volume or {}).get("Labels") or {}
        if not volume or not self.ours(labels) or labels.get(KIND_LABEL) != "data":
            raise Refused(409, "VOLUME_REFUSED", f"{volume_name} is not a data volume of this instance")
        if labels.get(UID_LABEL) != body["volume"]["uid"] or labels.get(OWNER_LABEL) != body["ownerId"] or labels.get(RUNNER_LABEL) != runner_id:
            raise Refused(409, "VOLUME_REFUSED", f"{volume_name} is not the volume this runner was authorized for")
        holders = self.holders(volume_name)
        if holders:
            raise Refused(409, "VOLUME_IN_USE", f"{volume_name} is still referred to by {len(holders)} container(s); a second container never mounts it")
        credential = self.matching_credential(body)
        limit, used = self.volume_limit(volume_name, labels), self.usage(volume_name)
        if limit is not None and used is not None and used > limit:
            raise Refused(409, "VOLUME_OVER_LIMIT", f"{volume_name} holds {used} bytes, over its {limit}-byte limit; no container is started on it")
        boot = boot_volume_name(runner_id, body["generation"])
        existing_boot = self.docker.volume(boot)
        if existing_boot and not self.ours(existing_boot.get("Labels")):
            raise Refused(409, "NOT_MANAGED", f"a volume named {boot} exists without this instance's label")
        if existing_boot and self.holders(boot):
            raise Refused(409, "VOLUME_IN_USE", f"{boot} is still referred to by a container")
        instance_uid = str(uuid.uuid4())
        spec = container_spec(self.config, body, instance_uid)
        problems = unsafe(self.config, spec)
        if problems:  # the template itself: never sent
            raise Refused(500, "TEMPLATE_VIOLATION", f"the container template breaks the channel's rules: {'; '.join(problems)}")
        with self._create_lock:
            # Every container of this instance, in any state: each one holds its volume until it is removed.
            count = len(self.docker.containers(labels=[f"{INSTANCE_LABEL}={self.config['instanceId']}"]))
            if count >= self.max_containers:
                raise Refused(429, "CONTAINER_LIMIT", f"containers of this instance: {count}, at its limit (limits.maxContainers "
                              f"{self.max_containers}); another is made only once one of them is removed")
            try:
                self.docker.create_container(name, spec)
            except DockerError as error:
                if error.status == 409:
                    return None  # a create raced this one: read again
                raise
        try:
            inspected = self.docker.container(name)
            problems = unsafe_container(self.config, inspected or {}, self.image_env)
            if problems:
                raise Refused(500, "TEMPLATE_VIOLATION", f"Docker made a container that breaks the channel's rules: {'; '.join(problems)}")
            self.populate_and_start(name, credential, body["generation"], runner_id, instance_uid)
        except Exception:
            # Never started: removing it cannot stop anything.
            found = self.docker.container(name)
            if found and found["State"].get("Status") == "created":
                self.remove_with_bootstrap(name, found)
            raise
        log(f"container {name} created and started")
        return self.container_view(self.docker.container(name))

    def populate_and_start(self, name, credential, generation, runner_id, instance_uid):
        instance = {"runnerId": runner_id, "generation": generation, "instanceUid": instance_uid}
        self.docker.put_archive(name, BOOT_MOUNT, bootstrap_archive(credential["token"], generation, instance))
        self.docker.start_container(name)

    def remove_with_bootstrap(self, name, found):
        boots = [m.get("Name") for m in found.get("Mounts") or [] if m.get("Destination") == BOOT_MOUNT and m.get("Name")]
        self.docker.remove_container(name)
        for boot in boots:
            volume = self.docker.volume(boot)
            if volume and self.ours(volume.get("Labels")) and not self.holders(boot):
                self.docker.remove_volume(boot)

    def stop_in_background(self, name):
        with self._stopping_lock:
            if name in self._stopping:
                return
            self._stopping.add(name)

        def stop():
            try:
                self.docker.stop_container(name, self.config["stopGraceSeconds"])
                log(f"container {name} stopped")
            except Exception as error:  # noqa: BLE001 - reported, and the next request may ask again
                log(f"container {name}: stop failed: {error}")
            finally:
                with self._stopping_lock:
                    self._stopping.discard(name)

        threading.Thread(target=stop, name=f"stop-{name}", daemon=True).start()

    def stop_container(self, name, uid):
        self.check_container_name(name)
        found = self.docker.container(name)
        if not found or not self.ours(found["Config"].get("Labels")):
            raise Refused(404, "NOT_FOUND", f"no container {name} of this instance")
        if found["Config"]["Labels"].get(UID_LABEL) != uid:
            raise Refused(409, "UID_MISMATCH", f"{name} is not the container with UID {uid}")
        if found["State"].get("Status") in LIVE_STATES:
            log(f"container {name}: stop asked (grace {self.config['stopGraceSeconds']} s)")
            self.stop_in_background(name)
            view = self.container_view(found)
            view["stopping"] = True
            return 202, view
        return 200, self.container_view(found)

    def remove_container(self, name, uid):
        runner_id = self.check_container_name(name)
        with self.lock(runner_id):
            found = self.docker.container(name)
            if not found or not self.ours(found["Config"].get("Labels")):
                raise Refused(404, "NOT_FOUND", f"no container {name} of this instance")
            if found["Config"]["Labels"].get(UID_LABEL) != uid:
                raise Refused(409, "UID_MISMATCH", f"{name} is not the container with UID {uid}")
            if found["State"].get("Status") in LIVE_STATES:
                raise Refused(409, "CONTAINER_RUNNING", f"{name} is {found['State'].get('Status')}: a container is removed only once it has stopped")
            self.remove_with_bootstrap(name, found)
            path = self.eviction_path(uid)
            if path.exists():
                path.unlink()
            log(f"container {name} removed")

    # ── listing, host and receipts ──────────────────────────────────────────────────────────────

    def resources(self):
        mark = f"{INSTANCE_LABEL}={self.config['instanceId']}"
        volumes = [{"name": v["Name"], "kind": (v.get("Labels") or {}).get(KIND_LABEL), **{
            k: v2 for k, v2 in self.volume_view(v).items() if k != "name"}} for v in self.docker.volumes([mark])]
        containers = []
        for summary in self.docker.containers(labels=[mark]):
            found = self.docker.container((summary.get("Names") or ["/"])[0].lstrip("/"))
            if found and self.ours(found["Config"].get("Labels")):
                containers.append(self.container_view(found))
        credentials = [self.credential_view(r, with_token=False) for r in self.credentials.all() if r.get("instance") == self.config["instanceId"]]
        return {"instanceId": self.config["instanceId"], "volumes": volumes, "containers": containers, "credentials": credentials}

    def host(self):
        info = self.docker.info()
        probe = self.config.get("diskProbePath")
        if not probe:
            root = info.get("DockerRootDir")
            probe = root if root and os.path.isdir(root) else self.config["stateDir"]
        disk = None
        try:
            fs = os.statvfs(probe)
            disk = {"path": probe, "totalBytes": fs.f_blocks * fs.f_frsize, "freeBytes": fs.f_bavail * fs.f_frsize}
        except OSError:
            pass
        sizes = self.measure()
        managed = [v["Name"] for v in self.docker.volumes([f"{INSTANCE_LABEL}={self.config['instanceId']}", f"{KIND_LABEL}=data"])]
        return {
            "name": info.get("Name"), "cpus": info.get("NCPU"), "memoryBytes": info.get("MemTotal"),
            "serverVersion": info.get("ServerVersion"), "disk": disk,
            "managedVolumeBytes": sum(sizes.get(name, 0) for name in managed),
        }

    def info(self):
        return {
            "schemaVersion": 1, "instanceId": self.config["instanceId"], "image": self.config["image"],
            "network": self.network_facts, "limits": {**self.config["limits"], "maxContainers": self.max_containers},
            "allowVolumeRemoval": self.config["allowVolumeRemoval"], "stopGraceSeconds": self.config["stopGraceSeconds"],
            "diskCheckSeconds": self.config["diskCheckSeconds"], "host": self.host(),
        }

    def fencing_receipt(self, runner_id):
        """An operator's receipt for a vanished container, left at <stateDir>/fencing/<runner uuid>.json. Read, never written."""
        self.check_runner_id(runner_id)
        try:
            receipt = read_private_json(self.fencing / f"{runner_id}.json")
        except ValueError as error:
            raise Refused(422, "RECEIPT_UNREADABLE", str(error)) from None
        return receipt


# ── HTTP ────────────────────────────────────────────────────────────────────────────────────────

ROUTES = [
    ("GET", re.compile(r"^/v1/info$"), "info"),
    ("GET", re.compile(r"^/v1/resources$"), "resources"),
    ("GET", re.compile(r"^/v1/volumes/(?P<name>[^/]+)$"), "read_volume"),
    ("PUT", re.compile(r"^/v1/volumes/(?P<name>[^/]+)$"), "ensure_volume"),
    ("DELETE", re.compile(r"^/v1/volumes/(?P<name>[^/]+)$"), "remove_volume"),
    ("GET", re.compile(r"^/v1/volumes/(?P<name>[^/]+)/holders$"), "volume_holders"),
    ("GET", re.compile(r"^/v1/credentials/(?P<runner>[^/]+)$"), "read_credential"),
    ("PUT", re.compile(r"^/v1/credentials/(?P<runner>[^/]+)$"), "put_credential"),
    ("DELETE", re.compile(r"^/v1/credentials/(?P<runner>[^/]+)$"), "delete_credential"),
    ("POST", re.compile(r"^/v1/containers$"), "create_container"),
    ("GET", re.compile(r"^/v1/containers/(?P<name>[^/]+)$"), "read_container"),
    ("POST", re.compile(r"^/v1/containers/(?P<name>[^/]+)/stop$"), "stop_container"),
    ("DELETE", re.compile(r"^/v1/containers/(?P<name>[^/]+)$"), "remove_container"),
    ("GET", re.compile(r"^/v1/fencing-receipts/(?P<runner>[^/]+)$"), "fencing_receipt"),
]
# The query parameters a route takes; anything else is refused.
QUERY = {"remove_volume": {"uid"}, "delete_credential": {"uid"}, "stop_container": {"uid"}, "remove_container": {"uid"}}


def handle(channel, method, path, query, body):
    """One request, routed: (status, JSON-able body or None)."""
    for verb, pattern, action in ROUTES:
        match = pattern.match(path)
        if not match:
            continue
        if verb != method:
            continue
        allowed = QUERY.get(action, set())
        for key in query:
            if key not in allowed:
                raise Refused(400, "PARAMETER_REFUSED", f"this request takes no {key!r} parameter")
        args = {k: urllib.parse.unquote(v) for k, v in match.groupdict().items()}
        if method in ("PUT", "POST") and action not in ("stop_container",):
            if body is None:
                raise Refused(400, "BODY_REFUSED", "this request needs a JSON body")
        elif body is not None:
            raise Refused(400, "BODY_REFUSED", "this request takes no body")
        uid = query.get("uid")
        if action in QUERY and not (uid and UUID.match(uid)):
            raise Refused(400, "PARAMETER_REFUSED", "uid must name, by its canonical UUID, the object this request is for")
        if action == "info":
            return 200, channel.info()
        if action == "resources":
            return 200, channel.resources()
        if action == "read_volume":
            found = channel.read_volume(args["name"])
            if not found:
                raise Refused(404, "NOT_FOUND", f"no data volume {args['name']} of this instance")
            return 200, found
        if action == "ensure_volume":
            return 200, channel.ensure_volume(args["name"], body)
        if action == "remove_volume":
            channel.remove_volume(args["name"], uid)
            return 204, None
        if action == "volume_holders":
            return 200, channel.volume_holders(args["name"])
        if action == "read_credential":
            found = channel.read_credential(args["runner"])
            if not found:
                raise Refused(404, "NOT_FOUND", f"no credential of runner {args['runner']}")
            return 200, found
        if action == "put_credential":
            return 200, channel.put_credential(args["runner"], body)
        if action == "delete_credential":
            channel.delete_credential(args["runner"], uid)
            return 204, None
        if action == "create_container":
            return channel.create_container(body)
        if action == "read_container":
            found = channel.read_container(args["name"])
            if not found:
                raise Refused(404, "NOT_FOUND", f"no container {args['name']} of this instance")
            return 200, found
        if action == "stop_container":
            if body is not None:
                raise Refused(400, "BODY_REFUSED", "this request takes no body")
            return channel.stop_container(args["name"], uid)
        if action == "remove_container":
            channel.remove_container(args["name"], uid)
            return 204, None
        if action == "fencing_receipt":
            found = channel.fencing_receipt(args["runner"])
            if found is None:
                raise Refused(404, "NOT_FOUND", f"no fencing receipt for runner {args['runner']}")
            return 200, found
    if any(pattern.match(path) for _, pattern, _ in ROUTES):
        raise Refused(405, "METHOD_REFUSED", f"{method} is not served at {path}")
    raise Refused(404, "NOT_FOUND", f"no such route: {path}")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "orbit-docker-channel/1"
    protocol_version = "HTTP/1.1"

    def address_string(self):
        return "unix" if not self.client_address else str(self.client_address[0])

    def log_message(self, fmt, *args):  # request lines are logged below, without bodies
        pass

    def do_GET(self):
        self.dispatch("GET")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_POST(self):
        self.dispatch("POST")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def read_body(self):
        length = self.headers.get("Content-Length")
        if self.headers.get("Transfer-Encoding"):
            raise Refused(400, "BODY_REFUSED", "send a Content-Length body")
        if not length:
            return None
        if not length.isdigit() or int(length) > MAX_BODY:
            raise Refused(413, "BODY_REFUSED", f"a body is at most {MAX_BODY} bytes")
        raw = self.rfile.read(int(length))
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            raise Refused(400, "BODY_REFUSED", "the body is not JSON") from None

    def dispatch(self, method):
        channel = self.server.channel
        code = None
        parsed = urllib.parse.urlsplit(self.path)
        try:
            body = self.read_body()
            if not channel.authorized(self.headers.get("Authorization")):
                raise Refused(401, "UNAUTHENTICATED", "this channel answers its configured bearer token only")
            query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
            status, payload = handle(channel, method, parsed.path, query, body)
        except Refused as refused:
            status, payload, code = refused.status, {"code": refused.code, "message": refused.message}, refused.code
        except DockerError as error:
            # Docker unavailable or refusing something the checks above let through: worth another try later.
            status, code = 502, "DOCKER_ERROR"
            payload = {"code": code, "message": f"Docker answered {error.status}: {error.message}"[:500]}
        except (OSError, http.client.HTTPException) as error:
            status, code = 503, "DOCKER_UNAVAILABLE"
            payload = {"code": code, "message": f"Docker could not be reached: {error}"[:500]}
        except Exception as error:  # noqa: BLE001 - reported to the caller as a server error
            traceback.print_exc(file=sys.stderr)
            status, code = 500, "INTERNAL"
            payload = {"code": code, "message": f"{type(error).__name__}"}
        log(f"{method} {parsed.path} -> {status}{' ' + code if code else ''}")
        data = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        if data:
            self.wfile.write(data)
        self.close_connection = True


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ("",)


class TcpServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def make_server(config, channel):
    listen = config["listen"]
    if "unixSocket" in listen:
        path = Path(listen["unixSocket"])
        if path.exists() or path.is_symlink():
            if not stat.S_ISSOCK(path.lstat().st_mode):
                raise ValueError(f"{path} exists and is not a socket")
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        old = os.umask(0o177)
        try:
            server = UnixServer(str(path), Handler)
        finally:
            os.umask(old)
        os.chmod(path, config["socketMode"])
    else:
        tcp = listen["tcp"]
        server_class = TcpServer
        if ":" in tcp["host"]:
            server_class = type("TcpServer6", (TcpServer,), {"address_family": socket.AF_INET6})
        server = server_class((tcp["host"], tcp["port"]), Handler)
    server.channel = channel
    return server


def serve_config(config_path, disk_probe_path=None):
    """The configuration to serve: the file's, with --disk-probe-path as the deployment's default for diskProbePath."""
    config = load_config(config_path)
    if disk_probe_path and "diskProbePath" not in config:
        config["diskProbePath"] = disk_probe_path
    return config


def serve(config_path, disk_probe_path=None):
    config = serve_config(config_path, disk_probe_path)
    token = read_token(config["tokenFile"])
    firewall_dir = Path(config_path).resolve().parent / FIREWALL_DIR
    channel = Channel(config, Docker(config["dockerSocket"]), token, firewall_dir=firewall_dir)
    if (firewall_dir / "config.json").exists():
        log(f"runner containers start only while the managed runners' host firewall is in force ({firewall_dir}/status.json)")
    channel.prepare()
    server = make_server(config, channel)
    stop = threading.Event()
    watcher = threading.Thread(target=channel.watch_disk, args=(stop,), name="disk-watch", daemon=True)
    watcher.start()

    def shutdown(signum, _frame):
        log(f"signal {signum}: shutting down")
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    where = config["listen"].get("unixSocket") or f"{config['listen']['tcp']['host']}:{config['listen']['tcp']['port']}"
    log(f"instance {config['instanceId']} serving on {where}; image {config['image']}, network {config['network']}")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        if "unixSocket" in config["listen"]:
            Path(config["listen"]["unixSocket"]).unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="channel.py", description="Orbit managed runners' restricted Docker channel")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_command = commands.add_parser("serve", help="serve the channel")
    serve_command.add_argument("--config", required=True)
    serve_command.add_argument("--disk-probe-path", help="where to measure the disk Docker's volumes live on, "
                               "unless the configuration names diskProbePath (root Compose mounts an empty volume there)")
    check_command = commands.add_parser("check-config", help="validate a configuration file and its token")
    check_command.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    if getattr(args, "disk_probe_path", None) and not os.path.isabs(args.disk_probe_path):
        parser.error("--disk-probe-path must be an absolute path")
    try:
        if args.command == "check-config":
            config = load_config(args.config)
            read_token(config["tokenFile"])
            print(json.dumps({"ok": True, "instanceId": config["instanceId"]}))
            return 0
        serve(args.config, args.disk_probe_path)
        return 0
    except (OSError, ValueError) as error:
        log(f"error: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
