#!/usr/bin/python3
"""The host firewall of Orbit's managed runners (Docker backend).

docs/managed-runner-design.md, "Implementation record: the managed runners' host firewall", and this
directory's README. Every account's managed runner is a container on one bridge network of this host
(orbit-managed-runners). Without rules, code in it reaches every service this host listens to on an
address other than loopback, and through the host the private networks behind it. These rules, which
match only traffic that comes in from that network's bridge, leave it:

  to the host itself   the gateway's published port at the network's gateway address (how a runner
                       reaches the apiserver), DNS to the servers Docker's resolver forwards to from the
                       container, the destinations an operator allows, and the replies of connections
                       already made; everything else is rejected
  through the host     the published port again (Docker's DNAT of it, so with or without its userland
                       proxy), that DNS, those destinations, and every public address; private, shared,
                       link-local (the cloud metadata address among them), loopback, documentation,
                       benchmarking, multicast and reserved addresses are rejected
  over IPv6            nothing: the network is IPv4-only, and anything IPv6 from its bridge is rejected

They only take reachability away: an allowed packet goes on to the rules the host already has
(RETURN), so nothing that was closed is opened. They live in two chains of this program's,
ORBIT-MR-INPUT and ORBIT-MR-FORWARD, reached from the first rule of INPUT and of DOCKER-USER, which
Docker keeps first in FORWARD and never flushes. They are written in one iptables-restore transaction
of the iptables backend Docker uses (nft or legacy), so a reader finds the old rules or the new ones.

Commands:
  serve       apply, then check every intervalSeconds and repair what changed; keep the status file
              (state "enforced" with how long that holds, "failing" and why, or "stopped") that the
              Docker channel reads before it starts any runner container. Stopping leaves the rules.
  status      exit 0 if the status file says the rules are in force now (the service's health check)
  apply       apply once and verify; check: are they in force?; show: this program's rules as they are
  preflight   can this host carry them? Runs every match and target in a scratch chain it removes
  remove      take every rule and chain of this program off the host, whatever bridge it names
  docker-dns  (in a container on the network) the DNS servers Docker forwards to from the container
  probe       (in a container on the network) connect to what must be reached and what must be refused

Run as root Compose's managed-runner-firewall service runs it: host network, NET_ADMIN and NET_RAW,
no Docker socket. Python 3 standard library and the iptables binaries only.
"""

import argparse
import errno
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import struct
import subprocess
import sys
import time

CONFIG = "/var/lib/orbit-managed-runner-firewall/config.json"
STATUS = "/var/lib/orbit-managed-runner-firewall/status.json"
CHAIN_INPUT = "ORBIT-MR-INPUT"
CHAIN_FORWARD = "ORBIT-MR-FORWARD"
CHAINS = (CHAIN_INPUT, CHAIN_FORWARD)
PREFLIGHT_CHAIN = "ORBIT-MR-PREFLIGHT"
COMMENT = "orbit-managed-runners"
REJECT_V4 = "-j REJECT --reject-with icmp-admin-prohibited"
REJECT_V6 = "-j REJECT --reject-with icmp6-adm-prohibited"
# What a runner never reaches through this host unless an operator allows it by name: IANA's IPv4 special-purpose
# blocks (RFC 6890 and its updates) that are not globally reachable, the private, shared and link-local ones first.
# 169.254.0.0/16 holds the cloud metadata address, 169.254.169.254.
BLOCKED_V4 = (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "0.0.0.0/8",
    "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
)
# The binaries of each iptables backend, by address family.
BACKENDS = {
    "nft": {4: ("iptables-nft", "iptables-nft-save", "iptables-nft-restore"),
            6: ("ip6tables-nft", "ip6tables-nft-save", "ip6tables-nft-restore")},
    "legacy": {4: ("iptables-legacy", "iptables-legacy-save", "iptables-legacy-restore"),
               6: ("ip6tables-legacy", "ip6tables-legacy-save", "ip6tables-legacy-restore")},
}
# A bridge's name: at most 15 characters (IFNAMSIZ less its NUL), as Docker names them (br-<12 hex>) or an operator does.
BRIDGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}\Z")
NETWORK_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
SIOCGIFADDR = 0x8915
# connect() errors that mean a firewall refused the packet: icmp-admin-prohibited arrives as EHOSTUNREACH.
REFUSED_BY_A_FIREWALL = ("EHOSTUNREACH", "ENETUNREACH", "EACCES", "EPERM")


def log(message):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"{stamp} orbit-managed-runner-firewall: {message}", file=sys.stderr, flush=True)


# ── configuration ───────────────────────────────────────────────────────────────────────────────

def load_config(path):
    """Read and check the firewall's configuration. Every problem is reported, not just the first."""
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"the configuration at {path} could not be read as JSON: {error}") from None
    return parse_config(value)


def ipv4(value):
    """An IPv4 address in its usual spelling, or None."""
    try:
        return str(ipaddress.IPv4Address(value)) if isinstance(value, str) else None
    except ValueError:
        return None


def port_number(value):
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535


def parse_config(value):
    problems = []
    if not isinstance(value, dict):
        raise ValueError("the configuration must be a JSON object")
    known = {"schemaVersion", "network", "bridge", "gateway", "apiPort", "dnsServers", "allow", "intervalSeconds"}
    for key in value:
        if key not in known:
            problems.append(f"{key} is not a configuration field")
    if value.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    if not (isinstance(value.get("network"), str) and NETWORK_NAME.match(value["network"])):
        problems.append("network must name the managed runners' Docker network")
    if not (isinstance(value.get("bridge"), str) and BRIDGE.match(value["bridge"])):
        problems.append("bridge must name that network's bridge interface (at most 15 characters)")
    gateway = ipv4(value.get("gateway"))
    if not gateway or ipaddress.IPv4Address(gateway).is_loopback or ipaddress.IPv4Address(gateway).is_unspecified:
        problems.append("gateway must be the network's IPv4 gateway address")
    if not port_number(value.get("apiPort")):
        problems.append("apiPort must be the gateway's published port, 1 to 65535")
    dns = value.get("dnsServers", [])
    if not isinstance(dns, list) or len(dns) > 8 or not all(ipv4(server) for server in dns) or len(set(dns)) != len(dns):
        problems.append("dnsServers must list at most 8 distinct IPv4 addresses")
    allow = value.get("allow", [])
    parsed_allow = []
    if not isinstance(allow, list) or len(allow) > 64:
        problems.append("allow must list at most 64 destinations")
        allow = []
    for index, entry in enumerate(allow):
        where = f"allow[{index}]"
        if not isinstance(entry, dict) or set(entry) != {"to", "protocol", "port"}:
            problems.append(f"{where} must be {{\"to\": <IPv4 address or network>, \"protocol\": \"tcp\" or \"udp\", \"port\": <port>}}")
            continue
        try:
            network = ipaddress.IPv4Network(entry["to"], strict=False) if isinstance(entry["to"], str) else None
        except ValueError:
            network = None
        if network is None or network.prefixlen < 8:
            problems.append(f"{where}.to must be an IPv4 address or a network of /8 or narrower")
        if entry["protocol"] not in ("tcp", "udp"):
            problems.append(f"{where}.protocol must be tcp or udp")
        if not port_number(entry["port"]):
            problems.append(f"{where}.port must be 1 to 65535")
        if network is not None:
            parsed_allow.append({"to": str(network), "protocol": entry["protocol"], "port": entry["port"]})
    interval = value.get("intervalSeconds", 10)
    if not (isinstance(interval, int) and not isinstance(interval, bool) and 2 <= interval <= 300):
        problems.append("intervalSeconds must be an integer from 2 to 300")
    if problems:
        raise ValueError("; ".join(problems))
    return {"schemaVersion": 1, "network": value["network"], "bridge": value["bridge"], "gateway": gateway,
            "apiPort": value["apiPort"], "dnsServers": [ipv4(server) for server in dns], "allow": parsed_allow,
            "intervalSeconds": interval}


# ── the rules ───────────────────────────────────────────────────────────────────────────────────
# Every rule is spelled as iptables-save prints it (the same for the nft and the legacy backend), so that what
# is on the host compares with what should be by string.

def allowed_destinations(config):
    """(destination, protocol, port) a runner reaches besides the gateway's port: Docker's DNS, then the operator's."""
    found = []
    for server in config["dnsServers"]:
        found += [(f"{server}/32", "udp", 53), (f"{server}/32", "tcp", 53)]
    for entry in config["allow"]:
        found.append((entry["to"], entry["protocol"], entry["port"]))
    return found


def chain_rules(config, family):
    """The rules of this program's two chains, as iptables-save prints them: {chain: [rule, ...]}."""
    if family == 6:
        return {CHAIN_INPUT: [f"-A {CHAIN_INPUT} {REJECT_V6}"], CHAIN_FORWARD: [f"-A {CHAIN_FORWARD} {REJECT_V6}"]}
    gateway, port = config["gateway"], config["apiPort"]

    def passes(chain, destination, protocol, number):
        return f"-A {chain} -d {destination} -p {protocol} -m {protocol} --dport {number} -j RETURN"

    allowed = allowed_destinations(config)
    to_host = [
        f"-A {CHAIN_INPUT} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
        passes(CHAIN_INPUT, f"{gateway}/32", "tcp", port),
        *(passes(CHAIN_INPUT, *destination) for destination in allowed),
        f"-A {CHAIN_INPUT} {REJECT_V4}",
    ]
    through_host = [
        f"-A {CHAIN_FORWARD} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
        # The published port, DNATed by Docker to the gateway's container on the stack's network (a private address):
        # what the runner asked for was the gateway address and the published port.
        f"-A {CHAIN_FORWARD} -p tcp -m conntrack --ctstate DNAT --ctorigdst {gateway} --ctorigdstport {port} -j RETURN",
        *(passes(CHAIN_FORWARD, *destination) for destination in allowed),
        *(f"-A {CHAIN_FORWARD} -d {block} {REJECT_V4}" for block in BLOCKED_V4),
    ]
    return {CHAIN_INPUT: to_host, CHAIN_FORWARD: through_host}


def jump_rules(config, hooks):
    """The jumps into this program's chains: {hook chain: rule}. hooks maps "input"/"forward" to the chain to hook."""
    match = f"-i {config['bridge']} -m comment --comment {COMMENT}"
    return {hooks["input"]: f"-A {hooks['input']} {match} -j {CHAIN_INPUT}",
            hooks["forward"]: f"-A {hooks['forward']} {match} -j {CHAIN_FORWARD}"}


def parse_save(text):
    """The filter table of iptables-save output: {"chains": set of declared chains, "rules": {chain: [rule, ...]}}."""
    chains, rules, table = set(), {}, None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("*"):
            table = line[1:]
        elif table != "filter" or line == "COMMIT":
            continue
        elif line.startswith(":"):
            chains.add(line[1:].split()[0])
        elif line.startswith("-A "):
            rules.setdefault(line.split()[1], []).append(line)
    return {"chains": chains, "rules": rules}


def jumps_into_ours(saved):
    """Every rule, in any chain, that jumps to one of this program's chains: [(chain, rule), ...]."""
    found = []
    for chain, rules in saved["rules"].items():
        for rule in rules:
            words = rule.split()
            if "-j" in words and words.index("-j") + 1 < len(words) and words[words.index("-j") + 1] in CHAINS:
                found.append((chain, rule))
    return found


def hooks_for(saved, family):
    """Where the jumps go. DOCKER-USER is Docker's: it keeps the jump to it first in FORWARD and never flushes it. Over
    IPv6, where Docker may manage no ip6tables at all, FORWARD itself carries the jump when DOCKER-USER is not there."""
    if "DOCKER-USER" in saved["chains"]:
        return {"input": "INPUT", "forward": "DOCKER-USER"}
    if family == 6:
        return {"input": "INPUT", "forward": "FORWARD"}
    return None


def assess(saved, config, family):
    """Why the rules of one address family are not in force: [] when they are."""
    hooks = hooks_for(saved, family)
    if hooks is None:
        return ["Docker's DOCKER-USER chain is not there: Docker does not manage this backend's iptables (is it its nftables "
                "backend, iptables turned off, or rootless?)"]
    problems = []
    if hooks["forward"] == "DOCKER-USER":
        forward = saved["rules"].get("FORWARD", [])
        if not forward or forward[0] != "-A FORWARD -j DOCKER-USER":
            problems.append("FORWARD does not start with Docker's jump to DOCKER-USER")
    for chain, rules in chain_rules(config, family).items():
        if chain not in saved["chains"]:
            problems.append(f"chain {chain} is missing")
        elif saved["rules"].get(chain, []) != rules:
            problems.append(f"chain {chain} does not hold exactly its {len(rules)} rules")
    wanted = jump_rules(config, hooks)
    found = jumps_into_ours(saved)
    for hook, rule in wanted.items():
        first = (saved["rules"].get(hook) or [None])[0]
        if first != rule:
            problems.append(f"{hook} does not start with the jump for {config['bridge']}")
    extra = [rule for _, rule in found if rule not in wanted.values()] + [
        rule for rule in wanted.values() if [r for _, r in found].count(rule) > 1]
    if extra:
        problems.append(f"{len(extra)} other jump(s) into this program's chains")
    return problems


def restore_payload(saved, config, family):
    """One iptables-restore --noflush transaction that leaves exactly the rules of one family: declaring a chain empties
    it (creating it if need be), the old jumps go, the new ones go first."""
    hooks = hooks_for(saved, family)
    lines = ["*filter", *(f":{chain} - [0:0]" for chain in CHAINS)]
    lines += ["-D" + rule[2:] for _, rule in jumps_into_ours(saved)]
    for rules in chain_rules(config, family).values():
        lines += rules
    lines += ["-I" + rule[2:].replace(f"{hook} ", f"{hook} 1 ", 1) for hook, rule in jump_rules(config, hooks).items()]
    lines.append("COMMIT")
    return "\n".join(lines) + "\n"


# ── the host ────────────────────────────────────────────────────────────────────────────────────

class Iptables:
    """The iptables binaries of one backend, run as subprocesses (run is replaced in tests)."""

    def __init__(self, backend, run=None):
        self.backend = backend
        self.binaries = BACKENDS[backend]
        self._run = run or default_run

    def run(self, argv, stdin=None):
        return self._run(argv, stdin)

    def save(self, family):
        code, out, err = self.run([self.binaries[family][1], "-t", "filter"])
        if code != 0:
            raise RuntimeError(f"{self.binaries[family][1]} failed: {(err or out).strip()[:500]}")
        return parse_save(out)

    def restore(self, family, payload):
        code, out, err = self.run([self.binaries[family][2], "--noflush", "-w", "10"], payload)
        if code != 0:
            raise RuntimeError(f"{self.binaries[family][2]} refused the rules: {(err or out).strip()[:500]}")

    def command(self, family, *args):
        return self.run([self.binaries[family][0], "-w", "10", *args])


def default_run(argv, stdin=None):
    try:
        done = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        return 127, "", f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]}: timed out"
    return done.returncode, done.stdout, done.stderr


def legacy_tables_present(proc="/proc/net/ip_tables_names"):
    """Whether this network namespace has legacy iptables tables. Reading the legacy backend where it has none would
    make one (the kernel instantiates a table on first use), so it is read only where Docker's would be."""
    try:
        return bool(Path(proc).read_text().strip())
    except OSError:
        return False


def detect_backend(run=None, legacy_present=None):
    """The iptables backend whose filter table holds Docker's chains: (backend, facts) or ValueError, with every reason."""
    legacy_present = legacy_tables_present() if legacy_present is None else legacy_present
    holding, reasons = [], []
    for backend in ("nft", "legacy"):
        if backend == "legacy" and not legacy_present:
            reasons.append("legacy: no legacy tables in this network namespace")
            continue
        tables = Iptables(backend, run)
        try:
            saved = tables.save(4)
        except RuntimeError as error:
            reasons.append(f"{backend}: {error}")
            continue
        if "DOCKER-USER" in saved["chains"] and "-A FORWARD -j DOCKER-USER" in saved["rules"].get("FORWARD", []):
            holding.append(backend)
        else:
            reasons.append(f"{backend}: no DOCKER-USER chain jumped to from FORWARD")
    if len(holding) == 1:
        return holding[0]
    if not holding:
        raise ValueError("Docker's chains are in neither iptables backend (" + "; ".join(reasons) + "): Docker does not manage "
                         "iptables in this network namespace. Is this the host's network (network_mode: host), and does "
                         "Docker use its iptables backend, not nftables or rootless?")
    raise ValueError("both iptables backends, nft and legacy, hold a DOCKER-USER chain jumped to from FORWARD: which one Docker "
                     "uses cannot be told apart. Remove the stale one's rules first.")


def ipv6_present(proc="/proc/net/if_inet6"):
    """Whether this kernel has IPv6 at all. Without it there is no IPv6 to filter."""
    return os.path.exists(proc)


def interface_ipv4(name):
    """The IPv4 address of a network interface of this namespace, or None (no such interface, or none set)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            answer = fcntl.ioctl(probe.fileno(), SIOCGIFADDR, struct.pack("256s", name.encode()[:15]))
        except OSError:
            return None
    return socket.inet_ntoa(answer[20:24])


def bridge_problems(config, address_of=interface_ipv4):
    address = address_of(config["bridge"])
    if address is None:
        return [f"the bridge {config['bridge']} of network {config['network']} is not in this network namespace, or has no "
                f"address (run in the host's network, and recreate the configuration if the network was recreated)"]
    if address != config["gateway"]:
        return [f"the bridge {config['bridge']} has the address {address}, not the network's gateway {config['gateway']}"]
    return []


def families(ipv6=None):
    return (4, 6) if (ipv6_present() if ipv6 is None else ipv6) else (4,)


def require_lock(backend, xtables_lock="/run/xtables.lock"):
    """The legacy backend replaces a whole table at a time, so it needs the host's lock to keep out of Docker's way."""
    if backend == "legacy" and not os.path.isfile(xtables_lock):
        raise RuntimeError(f"the legacy iptables backend needs the host's {xtables_lock} in this container (root Compose "
                           f"mounts it when .env sets ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK=/run/xtables.lock)")


def check(config, tables, ipv6=None, address_of=interface_ipv4):
    """Why the rules are not in force on this host: [] when they are."""
    problems = list(bridge_problems(config, address_of))
    for family in families(ipv6):
        problems += [f"IPv{family}: {problem}" for problem in assess(tables.save(family), config, family)]
    return problems


def apply(config, tables, ipv6=None, address_of=interface_ipv4, xtables_lock="/run/xtables.lock"):
    """Leave exactly this program's rules, writing only a family whose rules are not in force: (families written, why
    the rules are still not in force or [])."""
    require_lock(tables.backend, xtables_lock)
    changed, problems = [], list(bridge_problems(config, address_of))
    for family in families(ipv6):
        saved = tables.save(family)
        if hooks_for(saved, family) is None:
            raise RuntimeError(f"IPv{family}: " + assess(saved, config, family)[0])
        if assess(saved, config, family):
            tables.restore(family, restore_payload(saved, config, family))
            changed.append(family)
            saved = tables.save(family)
        problems += [f"IPv{family}: {problem}" for problem in assess(saved, config, family)]
    return changed, problems


def remove(run=None, legacy_present=None, ipv6=None):
    """Take this program's jumps and chains off every backend and family that has them: [description, ...]."""
    legacy_present = legacy_tables_present() if legacy_present is None else legacy_present
    done = []
    for backend in ("nft", "legacy"):
        if backend == "legacy" and not legacy_present:
            continue
        tables = Iptables(backend, run)
        for family in families(ipv6):
            try:
                saved = tables.save(family)
            except RuntimeError:
                continue
            for chain, rule in jumps_into_ours(saved):
                code, _, err = tables.command(family, "-D", *rule.split()[1:])
                if code != 0:
                    raise RuntimeError(f"{backend} IPv{family}: could not delete '{rule}': {err.strip()[:300]}")
                done.append(f"{backend} IPv{family}: deleted {rule}")
            for chain in CHAINS:
                if chain in saved["chains"]:
                    for args in (("-F", chain), ("-X", chain)):
                        code, _, err = tables.command(family, *args)
                        if code != 0:
                            raise RuntimeError(f"{backend} IPv{family}: {' '.join(args)} failed: {err.strip()[:300]}")
                    done.append(f"{backend} IPv{family}: removed chain {chain}")
    return done


def preflight(tables, ipv6=None, xtables_lock="/run/xtables.lock"):
    """Can this host carry the rules? Every match and target they use goes into a scratch chain no packet reaches, which
    is then removed. Returns the facts found; raises with the reason otherwise."""
    facts = {"backend": tables.backend, "ipv6": "present" if (ipv6_present() if ipv6 is None else ipv6) else "absent"}
    require_lock(tables.backend, xtables_lock)
    sample = {"bridge": "orbit-preflight", "gateway": "192.0.2.1", "apiPort": 2086, "dnsServers": ["192.0.2.53"],
              "allow": [{"to": "192.0.2.0/24", "protocol": "tcp", "port": 1}], "network": "preflight"}
    for family in families(ipv6):
        saved = tables.save(family)
        if hooks_for(saved, family) is None:
            raise RuntimeError(f"IPv{family}: " + assess(saved, sample, family)[0])
        rules = [rule.replace(f"-A {chain} ", f"-A {PREFLIGHT_CHAIN} ", 1)
                 for chain, chain_list in chain_rules(sample, family).items() for rule in chain_list]
        rules += [f"-A {PREFLIGHT_CHAIN} -i orbit-preflight -m comment --comment {COMMENT} -j RETURN"]
        payload = "\n".join(["*filter", f":{PREFLIGHT_CHAIN} - [0:0]", *rules, "COMMIT"]) + "\n"
        try:
            tables.restore(family, payload)
        finally:
            for args in (("-F", PREFLIGHT_CHAIN), ("-X", PREFLIGHT_CHAIN)):
                tables.command(family, *args)
        facts[f"ipv{family}Hook"] = hooks_for(saved, family)["forward"]
    code, out, _ = tables.run([tables.binaries[4][0], "--version"])
    facts["iptables"] = out.strip() if code == 0 else "unknown"
    return facts


# ── the service ─────────────────────────────────────────────────────────────────────────────────

def boot_id(path="/proc/sys/kernel/random/boot_id"):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def write_status(path, status):
    """Replace the status file whole: a reader finds the previous one or this one."""
    target = Path(path)
    temporary = target.with_name(f".{target.name}.{os.getpid()}")
    with open(temporary, "w") as out:
        os.fchmod(out.fileno(), 0o644)
        out.write(json.dumps(status, sort_keys=True) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, target)


def status_record(config, backend, state, now, reason=None, interval=None):
    record = {"schemaVersion": 1, "state": state, "backend": backend, "checkedAt": int(now), "bootId": boot_id(),
              **({key: config[key] for key in ("network", "bridge", "gateway", "apiPort")} if config else {})}
    if state == "enforced":
        # The channel trusts this for three check intervals: a service that stopped checking stops being believed.
        record["validUntil"] = int(now) + 3 * interval
    if reason:
        record["reason"] = reason[:1000]
    return record


def read_status(path, now=None, current_boot=None):
    """(True, status) if the status file says the rules are in force now, or (False, why not)."""
    try:
        status = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        return False, f"no status from the firewall service ({error.__class__.__name__})"
    if not isinstance(status, dict) or status.get("schemaVersion") != 1:
        return False, "the firewall's status file is not one this channel reads"
    now = time.time() if now is None else now
    current_boot = boot_id() if current_boot is None else current_boot
    if status.get("state") != "enforced":
        return False, f"the firewall service reports {status.get('state')!r}: {status.get('reason', 'no reason given')}"
    if current_boot and status.get("bootId") != current_boot:
        return False, "the firewall's status is from before this host last started"
    valid_until = status.get("validUntil")
    if not isinstance(valid_until, int) or now > valid_until:
        return False, f"the firewall service has not confirmed its rules since {status.get('checkedAt')}"
    return True, status


def serve(config_path, status_path, run=None, address_of=interface_ipv4, ipv6=None, xtables_lock="/run/xtables.lock",
          cycles=None):
    """Apply, then check every intervalSeconds and repair, until SIGTERM (or, in tests, `cycles` checks)."""
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(True))
    try:
        config = load_config(config_path)
    except ValueError as error:
        log(f"error: {error}")
        write_status(status_path, status_record(None, None, "failing", time.time(), str(error)))
        return 2
    # Before anything else: whatever an earlier run of this service said (one killed before it could say "stopped",
    # on a host whose rules went with its network namespace) is no longer believed.
    write_status(status_path, status_record(config, None, "starting", time.time(), "the firewall service is starting"))
    interval, backend, last = config["intervalSeconds"], None, None
    log(f"network {config['network']} (bridge {config['bridge']}, gateway {config['gateway']}): only the gateway's port "
        f"{config['apiPort']}, {len(config['dnsServers'])} DNS server(s) and {len(config['allow'])} allowed destination(s) "
        f"besides public addresses; checked every {interval} s")
    while not stopping:
        now = time.time()
        try:
            backend = backend or detect_backend(run)
            tables = Iptables(backend, run)
            changed, problems = apply(config, tables, ipv6, address_of, xtables_lock)
            if changed:
                log(f"rules written for IPv{' and IPv'.join(map(str, changed))} ({backend} backend)")
            state, reason = ("enforced", None) if not problems else ("failing", "; ".join(problems))
        except (RuntimeError, ValueError, OSError) as error:
            backend = None  # detect again: Docker may have come back on another backend
            state, reason = "failing", str(error)
        write_status(status_path, status_record(config, backend, state, now, reason, interval))
        if (state, reason) != last:
            log(f"{state}{': ' + reason if reason else ''}")
            last = (state, reason)
        if cycles is not None:
            cycles -= 1
            if cycles <= 0:
                break
        for _ in range(interval * 10):
            if stopping:
                break
            time.sleep(0.1)
    # The rules stay: stopping the service must not open the network. The channel just stops believing it.
    write_status(status_path, status_record(config, backend, "stopped", time.time(), "the firewall service stopped; its rules stay"))
    log("stopped; the rules stay on the host")
    return 0


# ── inside a container on the managed runners' network ──────────────────────────────────────────

def docker_dns(text):
    """The IPv4 DNS servers Docker's embedded resolver forwards to from the container's own network namespace, read from
    its resolv.conf ("# ExtServers: [host(192.0.2.1) 192.0.2.2]"; host(...) ones are reached from the host's namespace,
    which these rules do not see). Without that line, the nameservers it lists other than the embedded resolver."""
    found = []
    line = re.search(r"^#\s*ExtServers:\s*\[(.*)\]\s*$", text, re.M)
    if line:
        candidates = [token for token in line.group(1).split() if not token.startswith("host(")]
    else:
        candidates = re.findall(r"^\s*nameserver\s+(\S+)", text, re.M)
    for candidate in candidates:
        address = ipv4(candidate)
        if address and address != "127.0.0.11" and not ipaddress.IPv4Address(address).is_loopback and address not in found:
            found.append(address)
    return found


def endpoint(value):
    host, _, port = value.rpartition(":")
    if not host or not port.isdigit() or not port_number(int(port)):
        raise argparse.ArgumentTypeError(f"{value!r} is not HOST:PORT")
    return host, int(port)


def connect(host, port, timeout):
    """A TCP connection attempt only: nothing is sent. CONNECTED, TIMEOUT or the errno's name."""
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            result = "CONNECTED"
    except socket.timeout:
        result = "TIMEOUT"
    except OSError as error:
        result = errno.errorcode.get(error.errno, str(error.errno)) if error.errno else type(error).__name__
    return result, round(time.monotonic() - started, 3)


def probe(reach, blocked, resolve, timeout, attempts):
    results, ok = [], True
    for name in resolve:
        try:
            addresses = sorted({info[4][0] for info in socket.getaddrinfo(name, 443, socket.AF_INET, socket.SOCK_STREAM)})
            entry = {"resolve": name, "addresses": addresses, "ok": True}
        except OSError as error:
            entry = {"resolve": name, "error": str(error), "ok": False}
        results.append(entry)
    for (host, port) in reach:
        for attempt in range(attempts):
            result, seconds = connect(host, port, timeout)
            if result == "CONNECTED":
                break
            time.sleep(min(2, timeout))
        results.append({"reach": f"{host}:{port}", "result": result, "seconds": seconds, "ok": result == "CONNECTED"})
    for (host, port) in blocked:
        result, seconds = connect(host, port, timeout)
        results.append({"blocked": f"{host}:{port}", "result": result, "seconds": seconds, "ok": result in REFUSED_BY_A_FIREWALL})
    for entry in results:
        ok = ok and entry["ok"]
        print(json.dumps(entry, sort_keys=True), flush=True)
    return 0 if ok else 1


# ── command line ────────────────────────────────────────────────────────────────────────────────

def command_line():
    parser = argparse.ArgumentParser(prog="firewall.py", description="Orbit managed runners' host firewall")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "apply", "check", "show"):
        command = commands.add_parser(name)
        command.add_argument("--config", default=CONFIG)
        if name == "serve":
            command.add_argument("--status", default=STATUS)
    commands.add_parser("status").add_argument("--status", default=STATUS)
    commands.add_parser("preflight")
    commands.add_parser("remove")
    commands.add_parser("docker-dns").add_argument("--resolv-conf", default="/etc/resolv.conf")
    probe_command = commands.add_parser("probe")
    probe_command.add_argument("--reach", type=endpoint, action="append", default=[], help="HOST:PORT that must connect")
    probe_command.add_argument("--blocked", type=endpoint, action="append", default=[],
                               help="HOST:PORT a firewall must refuse (EHOSTUNREACH and the like, not a timeout)")
    probe_command.add_argument("--resolve", action="append", default=[], help="a name that must resolve")
    probe_command.add_argument("--timeout", type=float, default=5)
    probe_command.add_argument("--attempts", type=int, default=1, help="tries for each --reach")
    return parser


def main(argv=None):
    args = command_line().parse_args(argv)
    try:
        if args.command == "serve":
            return serve(args.config, args.status)
        if args.command == "status":
            ok, detail = read_status(args.status)
            print(json.dumps(detail, sort_keys=True) if ok else detail)
            return 0 if ok else 1
        if args.command == "docker-dns":
            print(json.dumps(docker_dns(Path(args.resolv_conf).read_text())))
            return 0
        if args.command == "probe":
            return probe(args.reach, args.blocked, args.resolve, args.timeout, max(1, args.attempts))
        if args.command == "remove":
            done = remove()
            print("\n".join(done) if done else "no rule or chain of this program was on this host")
            return 0
        tables = Iptables(detect_backend())
        if args.command == "preflight":
            print(json.dumps(preflight(tables), sort_keys=True))
            return 0
        config = load_config(args.config)
        if args.command == "show":
            for family in families():
                saved = tables.save(family)
                hooks = hooks_for(saved, family) or {"input": "INPUT", "forward": "DOCKER-USER"}
                print(f"# IPv{family}, {tables.backend} backend")
                for hook in (hooks["input"], hooks["forward"]):
                    print(*[rule for rule in saved["rules"].get(hook, []) if rule.split()[-1] in CHAINS], sep="\n")
                for chain in CHAINS:
                    print(*saved["rules"].get(chain, [f"# chain {chain} is missing"]), sep="\n")
            return 0
        if args.command == "apply":
            changed, problems = apply(config, tables)
            print(json.dumps({"backend": tables.backend, "written": [f"IPv{family}" for family in changed],
                              "enforced": not problems, "problems": problems}, sort_keys=True))
            return 0 if not problems else 1
        problems = check(config, tables)
        print(json.dumps({"backend": tables.backend, "enforced": not problems, "problems": problems}, sort_keys=True))
        return 0 if not problems else 1
    except (OSError, RuntimeError, ValueError) as error:
        log(f"error: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
