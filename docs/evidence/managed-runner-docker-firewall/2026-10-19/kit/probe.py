#!/usr/bin/env python3
"""D9 (task 34iSiGtPrJ0LWSqn17esR): what a managed runner reaches, measured inside its container as its user.

    docker exec -i -u 10001 <runner container> python3 - '<targets JSON>' < probe.py

Each target is {"name", "kind": tcp|udp|https|dns, "host", "port"} (https: "url"; dns: "host"). A TCP probe only
connects: nothing is sent. UDP sends one datagram to the test host's own echo. HTTPS asks for a public page with no
credential and reads the status code. One JSON line per target, then the container's own network facts.
"""

import errno
import json
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request


def tcp(host, port, timeout=4):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return "CONNECTED"
    except socket.timeout:
        return "TIMEOUT"
    except OSError as error:
        return errno.errorcode.get(error.errno, str(error.errno)) if error.errno else type(error).__name__


def udp(host, port, timeout=3):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            s.send(b"d9-probe")
            return "ECHOED" if s.recv(64) == b"d9-probe" else "OTHER"
        except socket.timeout:
            return "TIMEOUT"
        except OSError as error:
            return errno.errorcode.get(error.errno, str(error.errno))


def https(url, timeout=15):
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "orbit-d9-probe"})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
            return f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - the probe reports, it does not judge
        reason = getattr(error, "reason", error)
        return f"{type(reason).__name__}: {reason}"[:160]


def dns(name):
    try:
        return "RESOLVED " + ",".join(sorted({i[4][0] for i in socket.getaddrinfo(name, 443, socket.AF_INET, socket.SOCK_STREAM)}))
    except OSError as error:
        return f"FAILED {error}"


def read(path):
    try:
        with open(path) as handle:
            return handle.read().strip()
    except OSError as error:
        return f"unreadable: {error.strerror}"


for target in json.loads(sys.argv[1]):
    started = time.monotonic()
    kind = target["kind"]
    if kind == "tcp":
        result = tcp(target["host"], target["port"])
    elif kind == "udp":
        result = udp(target["host"], target["port"])
    elif kind == "https":
        result = https(target["url"])
    else:
        result = dns(target["host"])
    print(json.dumps({**target, "result": result, "seconds": round(time.monotonic() - started, 3)}, sort_keys=True), flush=True)

resolv = read("/etc/resolv.conf").splitlines()
print(json.dumps({"facts": {
    "uid": __import__("os").getuid(),
    "ipv6Disabled": {"all": read("/proc/sys/net/ipv6/conf/all/disable_ipv6"), "eth0": read("/proc/sys/net/ipv6/conf/eth0/disable_ipv6")},
    "ipv6Addresses": read("/proc/net/if_inet6"),
    "resolvConf": [line for line in resolv if line.startswith(("nameserver", "# ExtServers"))],
}}, sort_keys=True), flush=True)
