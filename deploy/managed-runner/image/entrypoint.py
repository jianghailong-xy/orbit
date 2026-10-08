#!/usr/bin/python3
"""Optional runner container bootstrap; the existing Orbit protocol owns recovery."""

import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path("/var/lib/orbit")
UID = GID = 10001


def paths():
    home = ROOT / "home"
    orbit = home / ".orbit"
    return home, orbit, home / "orbit-repos" / "default"


def directories():
    home, orbit, workspace = paths()
    return [ROOT, home, orbit, home / ".codex", home / ".claude",
            home / "orbit-repos", workspace,
            *[orbit / name for name in ("runs", "worktrees", "uploads", "codex-state")]]


def require_mount():
    # ismount alone misses bind mounts on the same device. The container path is fixed.
    if not any(line.split()[4] == str(ROOT)
               for line in Path("/proc/self/mountinfo").read_text().splitlines()):
        raise ValueError("mount the user's persistent volume at /var/lib/orbit")


def private_path(path, directory=False, initialize=False):
    info = path.lstat()
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid not in ((0, UID) if initialize else (UID,)):
        raise ValueError(f"unexpected type or owner: {path}")
    if initialize:
        os.chown(path, UID, GID)
    path.chmod(0o700 if directory else 0o600)


def prepare(initialize=False):
    require_mount()
    if (initialize and os.geteuid() != 0) or (not initialize and os.geteuid() != UID):
        raise ValueError("init-volume requires root; run/check require UID 10001")
    os.umask(0o077)
    for path in directories():
        # Check every ancestor before descending; never follow retained symlinks.
        if not path.exists() and not path.is_symlink():
            path.mkdir(mode=0o700)
        private_path(path, directory=True, initialize=initialize)
    orbit = paths()[1]
    for name in ("config.json", "container-identity.json", "registration-pending.json", "container.lock"):
        path = orbit / name
        if path.exists() or path.is_symlink():
            private_path(path, initialize=initialize)


def init_volume():
    # Scoped one-shot init: no recursive chown, credentials, network, or runner start.
    prepare(initialize=True)


def clean_env():
    home, orbit, _ = paths()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("ORBIT_") and key not in ("KUBECONFIG", "DOCKER_HOST")}
    env.update(HOME=str(home), ORBIT_HOME=str(orbit), CODEX_HOME=str(home / ".codex"),
               CLAUDE_CONFIG_DIR=str(home / ".claude"), ORBIT_NO_SELFUPDATE="1",
               ORBIT_NO_ENGINE_UPDATE="1",
               PATH=":".join(["/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin",
                              str(home / ".local/bin"), str(home / ".opencode/bin"),
                              str(home / ".kimi-code/bin")]))
    return env


def server_url():
    value = os.environ.get("ORBIT_RUNNER_SERVER_URL", "").rstrip("/")
    parsed = urlsplit(value)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme != "https" and not
                (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")))):
        raise ValueError("ORBIT_RUNNER_SERVER_URL must explicitly name the approved HTTPS test server")
    return value


def read_json(path):
    private_path(path)
    try:
        value = json.loads(path.read_text())
    except (ValueError, UnicodeError) as error:
        raise ValueError(f"invalid retained JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"invalid retained object: {path}")
    return value


def durable_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".container-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def lock_volume():
    fd = os.open(paths()[1] / "container.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise ValueError("another local runner process holds this volume") from None
    os.set_inheritable(fd, True)
    return fd  # Retained through exec until the foreground runner exits.


def load_identity():
    _, orbit, workspace = paths()
    config = read_json(orbit / "config.json")
    if (any(not isinstance(config.get(key), str) or not config[key].strip()
            for key in ("runnerId", "runnerToken", "serverUrl"))
            or config["serverUrl"] != server_url() or config.get("workDir") != str(workspace)
            or config.get("autoInstallEngines", False) is not False):
        raise ValueError("retained config does not match the fixed runner contract")
    expected = os.environ.get("ORBIT_RUNNER_EXPECTED_ID")
    if expected and config["runnerId"] != expected:
        raise ValueError("retained runner ID does not match the expected user's volume")
    identity = {"layoutVersion": 1, "runnerId": config["runnerId"],
                "serverUrl": config["serverUrl"], "workDir": str(workspace)}
    marker = orbit / "container-identity.json"
    if marker.exists() and read_json(marker) != identity:
        raise ValueError("retained volume identity mismatch")
    return identity


def register():
    home, orbit, workspace = paths()
    pending = orbit / "registration-pending.json"
    if pending.exists() or (orbit / "container-identity.json").exists():
        raise ValueError("registration result is uncertain; reconcile it without re-enrolling")
    state_dirs = ("runs", "worktrees", "uploads", "codex-state")
    if (any(any((orbit / name).iterdir()) for name in state_dirs)
            or any(path.name not in (*state_dirs, "container.lock") for path in orbit.iterdir())
            or any(any((home / name).iterdir()) for name in (".codex", ".claude"))
            or any(path != workspace for path in (home / "orbit-repos").iterdir())
            or any(workspace.iterdir())
            or any(path.name not in (".orbit", ".codex", ".claude", "orbit-repos") for path in home.iterdir())):
        raise ValueError("retained session/repository data has no config; restore the original identity")
    name = os.environ.get("ORBIT_RUNNER_NAME", "").strip()
    concurrency = os.environ.get("ORBIT_RUNNER_MAX_CONCURRENT", "")
    token_path = os.environ.get("ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE", "")
    if not name or not concurrency.isdecimal() or int(concurrency) < 1 or not token_path:
        raise ValueError("first start requires runner name, positive max concurrency, and enrollment token file")
    token = Path(token_path).read_text().strip()
    if not token:
        raise ValueError("empty one-time enrollment token")
    server = server_url()
    # This marker survives ambiguous HTTP outcomes and process loss. Never retry by registering
    # a new identity: an operator must reconcile the server-side attempt and original credential.
    durable_json(pending, {"serverUrl": server, "name": name})
    process = subprocess.Popen(["/usr/local/bin/orbit", "register", "--server", server, "--token", token,
                                "--name", name, "--max-concurrent", concurrency,
                                "--workdir", str(workspace), "--no-service",
                                "--no-auto-install-engines"], env=clean_env(), stdin=subprocess.DEVNULL)
    stopped = []

    def stop(signum, _frame):
        stopped.append(signum)
        process.send_signal(signum)

    old_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        result = process.wait()
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
    if stopped:
        raise SystemExit(128 + stopped[0])
    if result:
        raise ValueError("enrollment failed; reconcile the persisted attempt before retrying")


def run():
    prepare()
    lock_fd = lock_volume()
    try:
        config = paths()[1] / "config.json"
        if not config.exists():
            register()
        identity = load_identity()
        marker = paths()[1] / "container-identity.json"
        if not marker.exists():
            durable_json(marker, identity)
        pending = paths()[1] / "registration-pending.json"
        if pending.exists():
            pending.unlink()
        os.execvpe("/usr/local/bin/orbit", ["orbit", "run"], clean_env())
    finally:
        os.close(lock_fd)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args == ["init-volume"]:
        init_volume()
    elif args == ["check"]:
        prepare()
        print(json.dumps(load_identity(), sort_keys=True))
    elif args == ["run"]:
        run()
    else:
        raise ValueError("usage: orbit-container {init-volume|check|run}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"orbit-container: {error}", file=sys.stderr)
        sys.exit(1)
