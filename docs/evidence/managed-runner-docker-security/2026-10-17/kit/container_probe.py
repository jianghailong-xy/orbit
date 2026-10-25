#!/usr/bin/env python3
"""D5 (task 34hJ7S9C3isVnzIDDfSHD): what a process inside a managed runner container can and cannot do.

Run inside the container, as its runner user, from standard input (nothing is copied into the container):

    docker exec -i mr-<runner uuid> python3 - '<targets JSON>' < container_probe.py

<targets JSON> is a list of {"name", "host", "port", "expect"} TCP endpoints to try (expect: "reach" or "blocked");
it may be "[]". Prints one JSON object. It never prints a credential or an environment value: the bootstrap files
are compared with themselves by digest, and only environment variable names are listed.
"""

import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys
import time


def err(error):
    return errno.errorcode.get(error.errno, str(error.errno)) if isinstance(error, OSError) else type(error).__name__


def attempt(action):
    try:
        action()
        return "ALLOWED"
    except Exception as error:  # noqa: BLE001 - the refusal is the result
        return err(error)


def read_one(path):
    """Open and read at most one byte (a directory: list it): the errno, or how much there was."""
    try:
        if os.path.isdir(path):
            return f"LISTED {len(os.listdir(path))} entries"
        with open(path, "rb") as handle:
            return f"READ {len(handle.read(1))} byte(s)"
    except OSError as error:
        return err(error)


def safe(action):
    try:
        return action()
    except Exception as error:  # noqa: BLE001 - reported, not fatal
        return f"error: {err(error)}"


def in_child(action):
    """Run one attempt in a forked child, so that a call that succeeds (a new namespace, a chroot) changes nothing here."""
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_end)
        try:
            result = action()
        except Exception as error:  # noqa: BLE001
            result = f"error: {err(error)}"
        os.write(write_end, str(result).encode())
        os._exit(0)
    os.close(write_end)
    with os.fdopen(read_end, "rb") as handle:
        result = handle.read().decode()
    os.waitpid(pid, 0)
    return result


def status_fields(pid="self"):
    keep = ("Uid", "Gid", "Groups", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp", "Seccomp_filters")
    fields = {}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in keep:
            fields[key] = value.strip()
    for name in ("current", "apparmor/current"):
        try:
            fields["AppArmor"] = Path(f"/proc/{pid}/attr/{name}").read_text().strip("\x00\n ")
            break
        except OSError:
            continue
    return fields


def processes():
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
                found.append({"pid": int(entry.name), "cmdline": cmdline[:120], **status_fields(entry.name)})
            except OSError:
                continue
    return sorted(found, key=lambda p: p["pid"])


def mounts():
    rows = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        left, _, right = line.partition(" - ")
        parts, tail = left.split(), right.split()
        rows.append({"target": parts[4], "root": parts[3], "options": parts[5], "fstype": tail[0], "source": tail[1]})
    return rows


def writable(path):
    probe = Path(path) / f".d5-probe-{os.getpid()}"
    try:
        fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        os.unlink(probe)
        return "WRITABLE"
    except OSError as error:
        return err(error)


def digest(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError as error:
        return err(error)


def bootstrap_tamper(directory="/run/orbit-bootstrap"):
    base = Path(directory)
    report = {"directory": {}}
    try:
        info = base.stat()
        report["directory"] = {"owner": f"{info.st_uid}:{info.st_gid}", "mode": oct(stat.S_IMODE(info.st_mode))}
    except OSError as error:
        report["directory"] = {"error": err(error)}
        return report
    report["directory"]["createFile"] = writable(base)
    report["directory"]["symlink"] = attempt(lambda: os.symlink("/tmp", base / "d5-link"))
    report["directory"]["mkdir"] = attempt(lambda: os.mkdir(base / "d5-dir"))
    report["directory"]["rmdir"] = attempt(lambda: os.rmdir(base))
    report["directory"]["chmod"] = attempt(lambda: os.chmod(base, 0o777))
    before = {name: digest(base / name) for name in ("token", "generation", "instance.json")}
    for name in ("token", "generation", "instance.json"):
        path = base / name
        try:
            info = path.stat()
        except OSError as error:
            report[name] = {"error": err(error)}
            continue
        report[name] = {
            "owner": f"{info.st_uid}:{info.st_gid}", "mode": oct(stat.S_IMODE(info.st_mode)),
            "readable": attempt(lambda: path.read_bytes()),
            "append": attempt(lambda: open(path, "ab").close()),
            "overwrite": attempt(lambda: open(path, "r+b").close()),
            "truncate": attempt(lambda: os.truncate(path, 0)),
            "unlink": attempt(lambda: os.unlink(path)),
            "rename": attempt(lambda: os.rename(path, base / f"{name}.moved")),
            "chmod": attempt(lambda: os.chmod(path, 0o666)),
            "chown": attempt(lambda: os.chown(path, os.getuid(), os.getgid())),
            "utime": attempt(lambda: os.utime(path, (0, 0))),
        }
    after = {name: digest(base / name) for name in ("token", "generation", "instance.json")}
    report["contentsUnchanged"] = before == after
    return report


def sockets_anywhere():
    """Every unix socket on the container's own filesystems (not /proc or /sys)."""
    found = []
    for root, dirs, files in os.walk("/", onerror=lambda e: None):
        if root in ("/proc", "/sys") or root.startswith(("/proc/", "/sys/")):
            dirs[:] = []
            continue
        for name in files + dirs:
            path = os.path.join(root, name)
            try:
                if stat.S_ISSOCK(os.lstat(path).st_mode):
                    found.append(path)
            except OSError:
                continue
    return found


def devices():
    entries = {}
    for path in sorted(Path("/dev").iterdir()):
        try:
            mode = path.lstat().st_mode
        except OSError:
            continue
        kind = "block" if stat.S_ISBLK(mode) else "char" if stat.S_ISCHR(mode) else "dir" if stat.S_ISDIR(mode) else "link" if stat.S_ISLNK(mode) else "file"
        entries[path.name] = kind
    return entries


def syscalls():
    """Each call in a forked child (x86_64 numbers). EPERM from seccomp or a missing capability is the expected answer;
    EFAULT/EINVAL would mean the call reached the kernel proper."""

    def call(name, *args):
        def run():
            libc = ctypes.CDLL(None, use_errno=True)
            result = getattr(libc, name)(*args)
            return "ALLOWED" if result >= 0 else errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))
        return in_child(run)

    return {
        "setuid(0)": call("setuid", 0),
        "unshare(CLONE_NEWUSER)": call("unshare", 0x10000000),
        "unshare(CLONE_NEWNS)": call("unshare", 0x00020000),
        "mount(tmpfs on /mnt)": call("mount", b"none", b"/mnt", b"tmpfs", 0, None),
        "chroot(/tmp)": call("chroot", b"/tmp"),
        "keyctl(KEYCTL_JOIN_SESSION_KEYRING)": call("syscall", 250, 1, None),
        "bpf(BPF_PROG_LOAD, NULL)": call("syscall", 321, 5, None, 0),
        "perf_event_open(NULL)": call("syscall", 298, None, 0, -1, -1, 0),
        "open_by_handle_at": call("syscall", 304, -100, None, 0),
    }


def kernel_files():
    report = {}
    for path in ("/proc/sys/kernel/hostname", "/proc/sysrq-trigger", "/sys/fs/cgroup/cgroup.procs", "/sys/kernel/uevent_helper"):
        report[f"open for writing {path}"] = attempt(lambda: open(path, "w").close())
    for path in ("/proc/kcore", "/proc/keys", "/sys/firmware", "/proc/1/root/etc/shadow", "/etc/shadow"):
        report[f"read {path}"] = read_one(path)
    return report


def cgroup_limits():
    values = {}
    for name in ("cpu.max", "cpu.weight", "memory.max", "memory.high", "memory.swap.max", "pids.max", "memory.current",
                 "pids.current", "memory.oom.group"):
        try:
            values[name] = Path("/sys/fs/cgroup", name).read_text().strip()
        except OSError as error:
            values[name] = err(error)
    return values


def setuid_binaries():
    found = []
    for directory in ("/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/lib", "/usr/libexec"):
        for root, dirs, files in os.walk(directory, onerror=lambda e: None):
            for name in files:
                path = os.path.join(root, name)
                try:
                    mode = os.lstat(path).st_mode
                except OSError:
                    continue
                if stat.S_ISREG(mode) and mode & (stat.S_ISUID | stat.S_ISGID):
                    found.append(path)
    return sorted(found)


def tcp(host, port, timeout=4.0):
    started = time.monotonic()
    try:
        address = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)[0][4]
    except OSError as error:
        return {"result": "NO_ADDRESS", "error": err(error) if error.errno else str(error)[:80]}
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(address)
        return {"result": "CONNECTED", "address": address[0], "ms": int((time.monotonic() - started) * 1000)}
    except socket.timeout:
        return {"result": "TIMEOUT", "address": address[0], "ms": int((time.monotonic() - started) * 1000)}
    except OSError as error:
        return {"result": err(error), "address": address[0], "ms": int((time.monotonic() - started) * 1000)}
    finally:
        sock.close()


def network(targets):
    routes = []
    for line in Path("/proc/net/route").read_text().splitlines()[1:]:
        parts = line.split()
        to_ip = lambda h: socket.inet_ntoa(bytes.fromhex(h)[::-1])  # noqa: E731
        routes.append({"iface": parts[0], "destination": to_ip(parts[1]), "gateway": to_ip(parts[2]), "mask": to_ip(parts[7])})
    resolved = {}
    for name in ("postgres", "orbit-postgres", "apiserver", "orbit-apiserver", "docker-channel", "orbit-docker-channel", "gateway",
                 "host.docker.internal"):
        try:
            resolved[name] = sorted({a[4][0] for a in socket.getaddrinfo(name, None, socket.AF_INET)})
        except OSError:
            resolved[name] = "NO_ADDRESS"
    probes = []
    for target in targets:
        result = tcp(target["host"], int(target["port"]))
        reached = result["result"] == "CONNECTED"
        probes.append({**target, **result, "asExpected": reached == (target.get("expect") == "reach")})
    listening = []
    for proto in ("tcp", "tcp6"):
        try:
            for line in Path(f"/proc/net/{proto}").read_text().splitlines()[1:]:
                parts = line.split()
                if parts[3] == "0A":
                    listening.append(f"{proto} {parts[1]}")
        except OSError:
            pass
    return {"routes": routes, "resolve": resolved, "probes": probes, "listeningInThisNamespace": listening,
            "resolvConf": [l for l in Path("/etc/resolv.conf").read_text().splitlines() if l.startswith("nameserver")]}


def main():
    targets = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    me = pwd.getpwuid(os.getuid())
    report = {
        "identity": {"uid": os.getuid(), "gid": os.getgid(), "euid": os.geteuid(), "groups": os.getgroups(), "user": me.pw_name,
                     "home": me.pw_dir},
        "self": status_fields(),
        "processes": processes(),
        "mounts": mounts(),
        "writable": {p: writable(p) for p in ("/", "/etc", "/usr/local/bin", "/opt", "/root", "/run", "/var/lib/orbit",
                                              "/var/lib/orbit/home", "/tmp", "/dev/shm", "/run/orbit-bootstrap", "/sys/fs/cgroup")},
        "bootstrap": bootstrap_tamper(),
        "dockerControl": {
            "unixSocketsOnTheFilesystem": sockets_anywhere(),
            "knownSocketPaths": {p: os.path.exists(p) for p in ("/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock",
                                                                "/var/lib/orbit-managed-runners", "/run/orbit-docker-channel")},
            "dockerBinary": [p for p in ("/usr/bin/docker", "/usr/local/bin/docker", "/bin/docker") if os.path.exists(p)],
        },
        "hostAccess": {"devices": devices(), "hostPaths": {p: os.path.exists(p) for p in ("/host", "/hostfs", "/rootfs", "/mnt/data", "/root/.orbit",
                                                                                         "/var/lib/docker", "/etc/orbit-docker-channel")}},
        "credentials": {
            "environmentNames": sorted(os.environ),
            "pid1EnvironmentNames": safe(lambda: sorted(
                e.split(b"=", 1)[0].decode() for e in Path("/proc/1/environ").read_bytes().split(b"\0") if e)),
            "files": {p: read_one(p) for p in ("/root/.docker/config.json", "/etc/shadow", "/run/secrets",
                                               "/var/run/secrets/kubernetes.io/serviceaccount/token")},
        },
        "privilege": {"syscalls": syscalls(), "kernelFiles": kernel_files(), "setuidBinaries": setuid_binaries()},
        "limits": {"cgroup": cgroup_limits(), "maxProcessesRlimit": safe(lambda: next(
            line.split()[2:4] for line in Path("/proc/self/limits").read_text().splitlines() if line.startswith("Max processes")))},
        "network": safe(lambda: network(targets)),
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
