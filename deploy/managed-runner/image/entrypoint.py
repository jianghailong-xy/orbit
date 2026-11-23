#!/usr/bin/python3
"""Optional runner container bootstrap; the existing Orbit protocol owns recovery."""

import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

# The user's persistent volume is mounted as the home directory itself.
ROOT = Path("/home/orbit")
# The volume's directory the template mounts at /tmp (managed-runner-resources.ts TMP_SUBPATH, channel.py TMP_SUBPATH):
# filled, it gives the writer ENOSPC like the rest of the volume. The runner empties it (runner-go managed_tmp.go).
TMP_NAME = ".orbit-tmp"
UID = GID = 10001
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
GENERATION = re.compile(r"[1-9][0-9]{0,9}")
# Where an image before a944a7f362 (2026-11-17) kept home: the volume was mounted at /var/lib/orbit with home in its
# `home` folder. A volume it ran on is moved to today's layout on the next start (move_earlier_home); the paths the old
# home recorded inside itself (git worktree links, the runner's session state) still name it, and the image keeps this
# path as a link to /home/orbit so they resolve.
EARLIER_HOME = "/var/lib/orbit/home"
# The earlier home, set aside at the volume root while its entries are moved out of it: its existence says a move is
# under way, and nothing a runner or a workspace makes is called this.
MOVING_HOME = ".orbit-earlier-home"
# What prepare() and a managed or enrolled start write before `orbit run`: all a start of this image on an earlier
# volume could have left beside `home` without running anything.
BOOTSTRAP_FILES = ("config.json", "container-identity.json", "container.lock", "managed-instance.json")
# A home an image of today's layout without move_earlier_home ran in beside the earlier one, when it is still unused
# (root_home_use): set aside, never deleted, so that the earlier home can take the root. Its entries move into
# SETTING_ASIDE, whose existence says the set-aside is under way, and that folder is then named EMPTY_HOME and the
# time it was set aside (UTC), where it stays.
SETTING_ASIDE = ".orbit-setting-aside-home"
EMPTY_HOME = ".orbit-empty-home-"
# Where a runner keeps an engine's sign-in, relative to home: Claude Code's, Codex's, Kimi Code's, Antigravity's and
# Cursor's, for the runner's own account and each one added on it (<ORBIT_HOME>/<engine>-accounts/<id>,
# src/runner-go/account_slot.go). Anything at one of these paths is a sign-in, whatever it holds.
SIGN_INS = (
    ".claude/.credentials.json", ".orbit/claude-accounts/*/.credentials.json",
    ".codex/auth.json", ".orbit/codex-accounts/*/auth.json",
    ".kimi-code/credentials/*", ".orbit/kimi-accounts/*/credentials/*",
    ".orbit/antigravity/google/antigravity-cli/antigravity-oauth-token",
    ".orbit/antigravity-accounts/*/antigravity-cli/antigravity-oauth-token",
    ".gemini/antigravity-cli/antigravity-oauth-token",
    ".orbit/cursor/*/xdg-config/cursor/auth.json", ".orbit/cursor-accounts/*/xdg-config/cursor/auth.json",
    ".config/cursor/auth.json", ".cursor/auth.json",
)
# The instance identity the Pod states through the Downward API; `orbit run` sends it with every
# request (src/runner-go/managed_instance.go).
INSTANCE_ENV = ("ORBIT_MANAGED_RUNNER_GENERATION", "ORBIT_MANAGED_RUNNER_POD_UID")
# The Docker backend's container states it in a read-only bootstrap file instead
# (deploy/managed-runner/docker-channel): {"runnerId", "generation", "instanceUid"}.
INSTANCE_FILE_ENV = "ORBIT_MANAGED_RUNNER_INSTANCE_FILE"


def paths():
    """Home, the runner's state, and the runner's own work directory: home itself, never a project in it.
    A managed runner has no default workspace (docs/managed-runner-no-default-workspace.md): each workspace's
    folder is made in home, or in orbit-repos for a clone, by the runner when it is first needed. The image makes
    neither orbit-repos nor anything in it."""
    home = ROOT
    orbit = home / ".orbit"
    return home, orbit, home


def legacy_workdirs():
    """The work directories earlier images named: `orbit-repos/default`, made empty for the managed default
    workspace, and then the repos folder itself (until 2026-11-23)."""
    repos = paths()[0] / "orbit-repos"
    return repos / "default", repos


def same_workdir(value):
    """A retained config or marker names this volume's work directory: today's, or an earlier image's."""
    return value in (str(paths()[2]), *map(str, legacy_workdirs()))


def directories():
    home, orbit, _ = paths()
    return [home, orbit, home / ".codex", home / ".claude",
            *[orbit / name for name in ("runs", "worktrees", "uploads", "codex-state")]]


def require_mount():
    # ismount alone misses bind mounts on the same device. The container path is fixed.
    if not any(line.split()[4] == str(ROOT)
               for line in Path("/proc/self/mountinfo").read_text().splitlines()):
        raise ValueError("mount the user's persistent volume at /home/orbit")


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
    for name in ("config.json", "container-identity.json", "registration-pending.json", "container.lock",
                 "managed-instance.json"):
        path = orbit / name
        if path.exists() or path.is_symlink():
            private_path(path, initialize=initialize)


def init_volume():
    # Scoped one-shot init: no recursive chown, credentials, network, or runner start.
    prepare(initialize=True)
    prepare_tmp()


def prepare_tmp():
    """The volume's /tmp directory, open to all with the sticky bit as /tmp is. The kubelet makes a subPath it does
    not find root-owned with the volume root's mode (0700), which UID 10001 cannot write. Anything else in its place
    (a link, which would mount another directory at /tmp, or a file) is replaced by the directory. Absent, it is
    left absent: the template that mounts it makes it, and an earlier one has a /tmp of its own."""
    path = paths()[0] / TMP_NAME
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        path.unlink()
        path.mkdir()
    if path.is_dir():
        os.chmod(path, 0o1777)


def clean_env():
    home, orbit, _ = paths()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("ORBIT_") and key not in ("KUBECONFIG", "DOCKER_HOST")}
    env.update(HOME=str(home), ORBIT_HOME=str(orbit), CODEX_HOME=str(home / ".codex"),
               CLAUDE_CONFIG_DIR=str(home / ".claude"), ORBIT_ENGINE_STORE="/opt/orbit-engines",
               ORBIT_NO_SELFUPDATE="1",
               ORBIT_NO_ENGINE_UPDATE="1",
               PATH=":".join(["/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin",
                              str(home / ".local/bin"), str(home / ".opencode/bin"),
                              str(home / ".kimi-code/bin")]))
    return env


def private_host(hostname):
    """A private, loopback or link-local IP literal, or a single-label name (a Compose service). Neither
    proves the address is on the host's container network (private ranges include LANs; a single label
    can resolve through search domains): the operator who sets the URL guarantees that."""
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return bool(re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", hostname))
    return address.is_private or address.is_loopback or address.is_link_local


def server_url():
    value = os.environ.get("ORBIT_RUNNER_SERVER_URL", "").rstrip("/")
    parsed = urlsplit(value)
    # A Docker backend container (its identity comes from the bootstrap file, beside the manager's
    # credential) reaches the server on its host, over the host's container network: plain HTTP is
    # accepted there, to a private address only. A start without the credential file is an enrollment,
    # whose one-time token never travels in plain HTTP beyond loopback.
    docker_private = (bool(os.environ.get(INSTANCE_FILE_ENV)) and bool(os.environ.get("ORBIT_RUNNER_CREDENTIAL_FILE"))
                      and private_host(parsed.hostname or ""))
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme != "https" and not
                (parsed.scheme == "http" and (parsed.hostname in ("127.0.0.1", "localhost", "::1") or docker_private)))):
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


def lock_volume(orbit=None):
    fd = os.open((orbit or paths()[1]) / "container.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
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
            or config["serverUrl"] != server_url() or not same_workdir(config.get("workDir"))
            or config.get("autoInstallEngines", False) is not False):
        raise ValueError("retained config does not match the fixed runner contract")
    expected = os.environ.get("ORBIT_RUNNER_EXPECTED_ID")
    if expected and config["runnerId"] != expected:
        # config.json keeps the UUID `orbit register` prints; the owner API's public id spells
        # the same runner differently and does not match here.
        raise ValueError("retained runner ID does not match the expected user's volume "
                         "(ORBIT_RUNNER_EXPECTED_ID is the runner UUID that `orbit-container check` prints)")
    identity = {"layoutVersion": 1, "runnerId": config["runnerId"],
                "serverUrl": config["serverUrl"], "workDir": str(workspace)}
    marker = orbit / "container-identity.json"
    if marker.exists():
        retained = read_json(marker)
        if not isinstance(retained, dict) or {**retained, "workDir": str(workspace)} != identity \
                or not same_workdir(retained.get("workDir")):
            raise ValueError("retained volume identity mismatch")
    return identity


def register():
    home, orbit, workspace = paths()
    repos = home / "orbit-repos"
    pending = orbit / "registration-pending.json"
    if pending.exists() or (orbit / "container-identity.json").exists():
        raise ValueError("registration result is uncertain; reconcile it without re-enrolling")
    state_dirs = ("runs", "worktrees", "uploads", "codex-state")
    if (any(any((orbit / name).iterdir()) for name in state_dirs)
            or any(path.name not in (*state_dirs, "container.lock") for path in orbit.iterdir())
            or any(any((home / name).iterdir()) for name in (".codex", ".claude"))
            # An earlier image made orbit-repos, empty, before its first registration.
            or ((repos.exists() or repos.is_symlink())
                and (repos.is_symlink() or not repos.is_dir() or any(repos.iterdir())))
            # lost+found: an ext4 volume's own, at its root, which is home.
            # TMP_NAME: the template's /tmp, made by the kubelet before any container starts.
            or any(path.name not in (".orbit", ".codex", ".claude", "orbit-repos", "lost+found", TMP_NAME)
                   for path in home.iterdir())):
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


def instance_file_identity(expected):
    """The Docker backend's statement of this instance: the bootstrap file the channel wrote, root-owned
    and read-only, beside the credential (deploy/managed-runner/docker-channel). Generation and instance
    UID come from it, never from the environment."""
    path = Path(os.environ[INSTANCE_FILE_ENV])
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError, UnicodeError) as error:
        raise ValueError(f"the instance file {path} could not be read") from error
    if not isinstance(value, dict) or set(value) != {"runnerId", "generation", "instanceUid"}:
        raise ValueError("the instance file must state exactly runnerId, generation and instanceUid")
    if value["runnerId"] != expected:
        raise ValueError("the instance file names another runner than ORBIT_RUNNER_EXPECTED_ID")
    generation, instance_uid = value["generation"], value["instanceUid"]
    if (not isinstance(generation, int) or isinstance(generation, bool) or not GENERATION.fullmatch(str(generation))
            or not isinstance(instance_uid, str) or not UUID.fullmatch(instance_uid)):
        raise ValueError("the instance file needs a positive generation and a canonical instance UID")
    return str(generation), instance_uid


def managed_instance():
    """The manager's Pod or container (ORBIT_RUNNER_CREDENTIAL_FILE): which runner, generation and instance this is.

    The runner row already exists and the manager issued its credential for one generation, in the
    bootstrap Secret beside the generation it was issued for. The Pod states its own generation and
    UID through the Downward API; a Docker backend container states them in its read-only instance
    file instead, and never both. A credential of another generation is an instance started against a
    credential that is not its own: refused, as is anything missing or malformed. Never an enrollment.
    """
    if os.environ.get("ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE"):
        raise ValueError("a managed runner Pod is given a runner credential, never an enrollment token")
    expected = os.environ.get("ORBIT_RUNNER_EXPECTED_ID", "").strip()
    if not UUID.fullmatch(expected):
        raise ValueError("a managed runner Pod needs ORBIT_RUNNER_EXPECTED_ID, its runner's UUID")
    if os.environ.get(INSTANCE_FILE_ENV):
        if any(name in os.environ for name in INSTANCE_ENV):
            raise ValueError("an instance is stated by its instance file or by the Downward API, never both")
        generation, pod_uid = instance_file_identity(expected)
    else:
        generation = os.environ.get(INSTANCE_ENV[0], "").strip()
        pod_uid = os.environ.get(INSTANCE_ENV[1], "").strip().lower()
    if not GENERATION.fullmatch(generation) or not UUID.fullmatch(pod_uid):
        raise ValueError("a managed runner Pod needs its generation and Pod UID from the Downward API")
    credential_file = Path(os.environ["ORBIT_RUNNER_CREDENTIAL_FILE"])
    credential = credential_file.read_text().strip()
    issued_for = (credential_file.parent / "generation").read_text().strip()
    if not credential:
        raise ValueError("empty managed runner credential")
    if issued_for != generation:
        raise ValueError(f"the bootstrap credential was issued for generation {issued_for or '?'}, "
                         f"not this Pod's generation {generation}")
    return {"runnerId": expected, "generation": int(generation), "podUid": pod_uid}, credential


def adopt_managed_credential(instance, credential):
    """Write the manager's identity and this generation's credential into the runner config.

    The runner ID is the mapping's; a config or volume that names another runner, server or work
    directory is not this runner's volume and is refused. A volume a later generation has already
    run on, or another Pod of this generation, is refused too: this Pod is stale. Only the
    credential changes from one generation to the next.
    """
    _, orbit, workspace = paths()
    if (orbit / "registration-pending.json").exists():
        raise ValueError("this volume holds an uncertain enrollment; reconcile it before a managed start")
    marker = orbit / "managed-instance.json"
    if marker.exists():
        previous = read_json(marker)
        if previous.get("runnerId") != instance["runnerId"]:
            raise ValueError("this volume belongs to another managed runner")
        if not isinstance(previous.get("generation"), int) or previous["generation"] > instance["generation"]:
            raise ValueError("a later generation of this runner has already run on this volume; this Pod is stale")
        if previous["generation"] == instance["generation"] and previous.get("podUid") != instance["podUid"]:
            raise ValueError("another Pod of this generation has already run on this volume")
    server = server_url()
    config_path = orbit / "config.json"
    if config_path.exists():
        config = read_json(config_path)
        if (config.get("runnerId") != instance["runnerId"] or config.get("serverUrl") != server
                or not same_workdir(config.get("workDir")) or config.get("autoInstallEngines", False) is not False):
            raise ValueError("retained config does not match this managed runner")
    else:
        name = os.environ.get("ORBIT_RUNNER_NAME", "").strip()
        concurrency = os.environ.get("ORBIT_RUNNER_MAX_CONCURRENT", "")
        if not name or not concurrency.isdecimal() or int(concurrency) < 1:
            raise ValueError("a managed runner needs its name and a positive max concurrency")
        config = {"serverUrl": server, "runnerId": instance["runnerId"], "name": name, "labels": [],
                  "maxConcurrent": int(concurrency), "workDir": str(workspace), "autoInstallEngines": False}
    if config.get("runnerToken") != credential:
        config["runnerToken"] = credential
        durable_json(config_path, config)
    durable_json(marker, instance)


def fsync_directory(path):
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def claude_slug(path):
    """Claude Code's folder for a working directory's conversations: every character outside [A-Za-z0-9] becomes `-`
    (src/runner-go/transcript_rebuild.go, claudeTranscriptPath). `--resume` reads only the one for its cwd."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def earlier_home():
    """The home an earlier image left on this volume: `home` at the root, holding that runner's .orbit, whose config
    names its work directory under EARLIER_HOME. A workspace folder that happens to be called `home` does not."""
    home = ROOT / "home"
    config = home / ".orbit" / "config.json"
    if home.is_symlink() or not home.is_dir() or (home / ".orbit").is_symlink() or not config.is_file() \
            or config.is_symlink():
        return None
    work_dir = read_json(config).get("workDir")
    return home if isinstance(work_dir, str) and work_dir.startswith(EARLIER_HOME + "/") else None


def fresh_home_beside(home):
    """Today's folders beside the earlier home, when they hold nothing a runner wrote: only folders, and in .orbit the
    bootstrap's own files. A start of a pre-move image of today's layout leaves that and nothing more before it runs;
    the earlier home is the runner's and this is not. None when anything else is there: a home this image has run in,
    which root_home_use weighs."""
    found = []
    for path in ROOT.iterdir():
        if path.name in ("home", "lost+found") or path.name.startswith(EMPTY_HOME):
            continue
        if path.name not in (".orbit", ".codex", ".claude", "orbit-repos") or path.is_symlink() or not path.is_dir():
            return None
        for parent, folders, files in os.walk(path):
            allowed = BOOTSTRAP_FILES if Path(parent) == ROOT / ".orbit" else ()
            if any((Path(parent) / name).is_symlink() for name in folders) or any(
                    name not in allowed and not (allowed and name.startswith(".container-")) for name in files):
                return None
        found.append(path)
    return found


def first_file(path):
    """The first entry under path that is not a folder (a file, a link, anything else), or None: folders alone are
    what a start makes for a workspace before anything is put in it."""
    if path.is_symlink() or not path.is_dir():
        return path
    for parent, folders, files in os.walk(path):
        for name in (*files, *folders):
            entry = Path(parent) / name
            if name in files or entry.is_symlink():
                return entry
    return None


def root_home_use():
    """What says the home at the volume root has been used, beside an earlier home in `home`, or None when it is
    still UNUSED. The rule (owner, 2026-11-22), with `home` and lost+found left out of the root home:
      - a sign-in: anything at one of SIGN_INS (an engine's credential, the runner's own account or an added one);
      - a workspace file: anything but folders under a folder at the root whose name does not start with `.`, which
        is orbit-repos and every workspace's stored path under home (migration 0980 named them /home/orbit/...), or
        under .orbit/worktrees, the sessions' checkouts. Empty folders are what a start makes before any work.
    Nothing else counts: conversations, logs, the runner's state and the engines' settings an unused start writes
    go with the home when it is set aside. A workspace stored under a hidden folder of home is not looked at."""
    for pattern in SIGN_INS:
        found = next(ROOT.glob(pattern), None)
        if found is not None:
            return f"a sign-in at {found}"
    for path in sorted(ROOT.iterdir()):
        if path.name in ("home", "lost+found") or path.name.startswith("."):
            continue
        found = first_file(path)
        if found is not None:
            return f"a workspace file at {found}"
    worktrees = ROOT / ".orbit" / "worktrees"
    if worktrees.exists() or worktrees.is_symlink():
        found = first_file(worktrees)
        if found is not None:
            return f"a workspace file at {found}"
    return None


def set_aside_root_home(aside):
    """Move every entry of the root home but `home` and lost+found into aside, one durable rename at a time (.orbit
    last), then name aside EMPTY_HOME and the time. A start stopped half-way carries on from where it stopped."""
    for path in sorted(ROOT.iterdir(), key=lambda entry: (entry.name == ".orbit", entry.name)):
        if path.name in ("home", "lost+found", SETTING_ASIDE) or path.name.startswith(EMPTY_HOME):
            continue
        target = aside / path.name
        if target.exists() or target.is_symlink():
            raise ValueError(f"{target} is in the way of the root home's {path.name}; move it to finish setting the "
                             f"root home aside in {aside}")
        os.rename(path, target)
        fsync_directory(ROOT)
        fsync_directory(aside)
    named = ROOT / (EMPTY_HOME + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    if named.exists() or named.is_symlink():
        raise ValueError(f"{named} is in the way of the root home set aside in {aside}")
    os.rename(aside, named)
    fsync_directory(ROOT)
    print(f"orbit-container: the unused home at the volume root is set aside in {named}; the earlier image's home "
          "takes its place", file=sys.stderr)


def move_earlier_home():
    """Move the home an earlier image left in `home` to the volume root, which is home now, before anything else
    touches the volume. Under the volume lock: the earlier home's own lock file, which moves with its .orbit and stays
    held. Returns that lock, or None when there is nothing to move.

    Each step is a rename, made durable before the next, and a start stopped half-way finishes on the next one:
    `home` is first set aside as MOVING_HOME, its entries then move out one by one (.orbit last), the paths this image
    reads are rewritten, and the empty MOVING_HOME goes last. Before that, whatever this image left at the root:
    folders it made before it ran anything are removed; a home it ran in that is still unused (root_home_use) is set
    aside in a dated EMPTY_HOME folder, never deleted (set_aside_root_home); a home with any real use is left as it
    is, and so is `home`, with a warning that names the use.
    """
    moving = ROOT / MOVING_HOME
    aside = ROOT / SETTING_ASIDE
    if not moving.exists() and not moving.is_symlink():
        home = earlier_home()
        if home is None:
            return None
        private_path(home, directory=True)
        private_path(home / ".orbit", directory=True)
        lock_fd = lock_volume(home / ".orbit")
        try:
            setting_aside = aside.exists() or aside.is_symlink()
            fresh = [] if setting_aside else fresh_home_beside(home)
            if fresh is None:
                use = root_home_use()
                if use is not None:
                    print(f"orbit-container: this volume holds an earlier image's home in {home} and a home this image "
                          f"has run in ({use}); it starts on the second and leaves the first as it is", file=sys.stderr)
                    os.close(lock_fd)
                    return None
            if (ROOT / ".orbit" / "container.lock").exists():
                os.close(lock_volume(ROOT / ".orbit"))  # Nothing runs on the folders about to go.
            if fresh is None:
                aside.mkdir(mode=0o700)
                fsync_directory(ROOT)
                setting_aside = True
            if setting_aside:
                private_path(aside, directory=True)
                set_aside_root_home(aside)
            for path in fresh or ():
                shutil.rmtree(path)
            fsync_directory(ROOT)
            os.rename(home, moving)
            fsync_directory(ROOT)
        except BaseException:
            os.close(lock_fd)
            raise
    else:
        private_path(moving, directory=True)
        lock_fd = lock_volume(moving / ".orbit" if (moving / ".orbit").is_dir() else None)
    try:
        for path in sorted(moving.iterdir(), key=lambda entry: (entry.name == ".orbit", entry.name)):
            target = ROOT / path.name
            if target.exists() or target.is_symlink():
                raise ValueError(f"{target} is in the way of the earlier home's {path.name}; move it to finish "
                                 f"moving {moving} to the volume root")
            os.rename(path, target)
            fsync_directory(ROOT)
            fsync_directory(moving)
        rewrite_earlier_paths()
        moving.rmdir()
        fsync_directory(ROOT)
    except BaseException:
        os.close(lock_fd)
        raise
    return lock_fd


def rewrite_earlier_paths():
    """What this image reads by path, moved from EARLIER_HOME to today's home: the work directory the config and the
    identity marker name, and Claude Code's folders of conversations, named after the working directory they were
    held in. Anything else the earlier home recorded by path resolves through the image's link at EARLIER_HOME."""
    _, orbit, _ = paths()
    for name in ("config.json", "container-identity.json"):
        path = orbit / name
        if path.exists():
            value = read_json(path)
            work_dir = value.get("workDir")
            if isinstance(work_dir, str) and work_dir.startswith(EARLIER_HOME + "/"):
                durable_json(path, {**value, "workDir": str(ROOT) + work_dir[len(EARLIER_HOME):]})
    projects = ROOT / ".claude" / "projects"
    if projects.is_dir() and not projects.is_symlink():
        earlier, today = claude_slug(EARLIER_HOME), claude_slug(str(ROOT))
        for path in sorted(projects.iterdir()):
            if path.name == earlier or path.name.startswith(earlier + "-"):
                target = projects / (today + path.name[len(earlier):])
                if not target.exists() and not target.is_symlink():
                    os.rename(path, target)
        fsync_directory(projects)


def retire_legacy_workdir():
    """Move a volume an earlier image ran on to today's work directory, under the volume lock: its config and
    identity marker name home instead of `orbit-repos/default` or `orbit-repos`, and `orbit-repos/default` goes if
    it is still the empty one the image made. One with anything in it is somebody's project and stays, and so does
    orbit-repos, where the runner keeps its clones. Each step is durable and can run again: a start stopped half-way
    finishes the move on the next one."""
    _, orbit, workspace = paths()
    old, repos = legacy_workdirs()
    for name in ("config.json", "container-identity.json"):
        path = orbit / name
        if path.exists():
            value = read_json(path)
            if isinstance(value, dict) and value.get("workDir") in (str(old), str(repos)):
                durable_json(path, {**value, "workDir": str(workspace)})
    if old.is_dir() and not old.is_symlink() and not any(old.iterdir()):
        old.rmdir()
        fsync_directory(repos)


def run():
    require_mount()
    if os.geteuid() != UID:
        raise ValueError("init-volume requires root; run/check require UID 10001")
    os.umask(0o077)
    lock_fd = move_earlier_home()
    try:
        prepare()
        if lock_fd is None:
            lock_fd = lock_volume()
        retire_legacy_workdir()
        config = paths()[1] / "config.json"
        instance = None
        if os.environ.get("ORBIT_RUNNER_CREDENTIAL_FILE"):
            instance, credential = managed_instance()
            adopt_managed_credential(instance, credential)
        elif not config.exists():
            register()
        identity = load_identity()
        marker = paths()[1] / "container-identity.json"
        if not marker.exists():
            durable_json(marker, identity)
        pending = paths()[1] / "registration-pending.json"
        if pending.exists():
            pending.unlink()
        env = clean_env()
        if instance:
            env.update({INSTANCE_ENV[0]: str(instance["generation"]), INSTANCE_ENV[1]: instance["podUid"]})
        os.execvpe("/usr/local/bin/orbit", ["orbit", "run"], env)
    finally:
        if lock_fd is not None:
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
