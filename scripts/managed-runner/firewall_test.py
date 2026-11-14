#!/usr/bin/env python3
"""The managed runners' host firewall (deploy/managed-runner/firewall/firewall.py) against an in-memory iptables.

Covers what the program decides: its configuration, the rules it generates (and that they only ever take reachability
away), how it reads iptables-save, when it finds the rules in force, the one iptables-restore transaction that repairs
them, which backend it picks and when it refuses to pick, the scratch-chain preflight, removal, the service's status
file and how it is read, the DNS servers it learns from a container's resolv.conf, and how it coexists with Kubernetes
(k3s: kube-proxy, kube-router, flannel) on the same host. The fake keeps a filter and a nat table per backend and
address family with iptables-save, iptables-restore --noflush (all or nothing, as both backends are) and -D/-F/-X
semantics. What the rules do to packets is measured on a real Docker host, not here
(docs/evidence/managed-runner-docker-firewall/).
"""

import contextlib
import copy
import importlib.util
import io
import ipaddress
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest import mock

FIREWALL = Path(__file__).resolve().parents[2] / "deploy/managed-runner/firewall/firewall.py"
sys.dont_write_bytecode = True

BRIDGE = "br-0123456789ab"


def load_firewall():
    spec = importlib.util.spec_from_file_location("managed_runner_firewall", FIREWALL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.log = lambda message: None
    return module


def docker_table():
    """The filter table as Docker leaves it: DOCKER-USER first in FORWARD, its own chains after."""
    return {
        "chains": {"INPUT": [], "FORWARD": ["-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD"], "OUTPUT": [],
                   "DOCKER-USER": [], "DOCKER-FORWARD": ["-A DOCKER-FORWARD -j DOCKER-CT"], "DOCKER-CT": []},
        "builtin": {"INPUT", "FORWARD", "OUTPUT"},
    }


def nat_table():
    return {"chains": {"PREROUTING": [], "INPUT": [], "OUTPUT": [], "POSTROUTING": []},
            "builtin": {"PREROUTING", "INPUT", "OUTPUT", "POSTROUTING"}}


def raw_table():
    return {"chains": {"PREROUTING": [], "OUTPUT": []}, "builtin": {"PREROUTING", "OUTPUT"}}


def routing_table(family):
    """`ip -j rule show` of a fresh network namespace."""
    rules = [{"priority": 0, "src": "all", "table": "local"}, {"priority": 32766, "src": "all", "table": "main"}]
    return rules + ([{"priority": 32767, "src": "all", "table": "default"}] if family == 4 else [])


def docker_nat():
    """The nat table as Docker leaves it: DOCKER for local destinations, appended to PREROUTING."""
    table = nat_table()
    table["chains"]["PREROUTING"] = ["-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER"]
    table["chains"]["DOCKER"] = ["-A DOCKER -i docker0 -j RETURN"]
    return table


# What k3s (v1.37: kube-proxy in iptables mode, kube-router's network policy, flannel) puts in front of Docker's rules,
# as on 10.66.0.3. kube-router keeps its jumps first, inserting them again as it starts and syncs.
KUBE_FORWARD = [
    '-A FORWARD -m comment --comment "kube-router netpol - TEMCG2JMHZYE7H7T" -j KUBE-ROUTER-FORWARD',
    "-A FORWARD -m conntrack --ctstate NEW -m comment --comment \"kubernetes load balancer firewall\" -j KUBE-PROXY-FIREWALL",
    '-A FORWARD -m comment --comment "kubernetes forwarding rules" -j KUBE-FORWARD',
    "-A FORWARD -m conntrack --ctstate NEW -m comment --comment \"kubernetes service portals\" -j KUBE-SERVICES",
    "-A FORWARD -m conntrack --ctstate NEW -m comment --comment \"kubernetes externally-visible service portals\" -j KUBE-EXTERNAL-SERVICES",
]
KUBE_INPUT = [
    '-A INPUT -m comment --comment "kube-router netpol - 4IA2OSFRMVNDXBVV" -j KUBE-ROUTER-INPUT',
    "-A INPUT -m conntrack --ctstate NEW -m comment --comment \"kubernetes load balancer firewall\" -j KUBE-PROXY-FIREWALL",
    '-A INPUT -m comment --comment "kubernetes health check service ports" -j KUBE-NODEPORTS',
    "-A INPUT -j KUBE-FIREWALL",
]
KUBE_PREROUTING = '-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES'


def add_k3s(host, backend="nft", family=4):
    """k3s starting on a host whose Docker is running: its chains, and its jumps above Docker's."""
    chains = host.table(backend, family)["chains"]
    for name in ("KUBE-ROUTER-FORWARD", "KUBE-ROUTER-INPUT", "KUBE-PROXY-FIREWALL", "KUBE-FORWARD", "KUBE-SERVICES",
                 "KUBE-EXTERNAL-SERVICES", "KUBE-NODEPORTS", "KUBE-FIREWALL", "FLANNEL-FWD"):
        chains.setdefault(name, [])
    chains["KUBE-FORWARD"] = ['-A KUBE-FORWARD -m comment --comment "kubernetes forwarding rules" -m mark --mark 0x4000/0x4000 -j ACCEPT']
    chains["FLANNEL-FWD"] = ['-A FLANNEL-FWD -s 10.42.0.0/16 -m comment --comment "flanneld forward" -j ACCEPT']
    chains["FORWARD"][:0] = KUBE_FORWARD
    chains["FORWARD"].append('-A FORWARD -m comment --comment "flanneld forward" -j FLANNEL-FWD')
    chains["INPUT"][:0] = KUBE_INPUT
    nat = host.table(backend, family, "nat")["chains"]
    nat["KUBE-SERVICES"] = ["-A KUBE-SERVICES -d 10.43.0.10/32 -p udp -m udp --dport 53 -j KUBE-SVC-TCOU7JCQXEZGVUNU"]
    nat["KUBE-SVC-TCOU7JCQXEZGVUNU"] = []
    nat["PREROUTING"].insert(0, KUBE_PREROUTING)


def kube_router_sync(host, backend="nft", family=4):
    """kube-router's sync (and k3s restarting): its top-level jumps go back to the first place; kube-proxy's nat jump
    is put first again too, as if it had been deleted and prepended."""
    chains = host.table(backend, family)["chains"]
    for hook, rule in (("FORWARD", KUBE_FORWARD[0]), ("INPUT", KUBE_INPUT[0])):
        chains[hook].remove(rule)
        chains[hook].insert(0, rule)
    nat = host.table(backend, family, "nat")["chains"]["PREROUTING"]
    nat.remove(KUBE_PREROUTING)
    nat.insert(0, KUBE_PREROUTING)


class FakeHost:
    """iptables as the program runs it: <ip|ip6>tables-<nft|legacy>[-save|-restore], each backend and family a filter
    and a nat table."""

    def __init__(self, docker_backend="nft", legacy=None, ipv6_docker=True):
        self.tables = {}
        self.nat = {}
        self.raw = {}
        self.routing = {4: routing_table(4), 6: routing_table(6)}
        for family in (4, 6):
            if docker_backend and (family == 4 or ipv6_docker):
                self.tables[(docker_backend, family)] = docker_table()
                self.nat[(docker_backend, family)] = docker_nat()
        for backend in ("nft", "legacy"):
            for family in (4, 6):
                self.tables.setdefault((backend, family), {"chains": {"INPUT": [], "FORWARD": [], "OUTPUT": []},
                                                           "builtin": {"INPUT", "FORWARD", "OUTPUT"}})
                self.nat.setdefault((backend, family), nat_table())
                self.raw[(backend, family)] = raw_table()
        self.legacy_present = docker_backend == "legacy" if legacy is None else legacy
        self.calls = []
        self.fail = None  # a binary name whose every call fails

    def table(self, backend, family, name="filter"):
        return {"filter": self.tables, "nat": self.nat, "raw": self.raw}[name][(backend, family)]

    def save_text(self, backend, family, name="filter"):
        table = self.table(backend, family, name)
        lines = ["# Generated by iptables-save", f"*{name}"]
        lines += [f":{name} {'ACCEPT [0:0]' if name in table['builtin'] else '- [0:0]'}" for name in table["chains"]]
        for rules in table["chains"].values():
            lines += rules
        lines += ["COMMIT", "# Completed"]
        return "\n".join(lines) + "\n"

    def run(self, argv, stdin=None):
        self.calls.append((argv, stdin))
        binary = argv[0]
        if self.fail and binary == self.fail:
            return 1, "", f"{binary}: failing as the test asked"
        if binary == "ip":
            return self.ip(argv[1:])
        family = 6 if binary.startswith("ip6") else 4
        backend = "nft" if "-nft" in binary else "legacy"
        if binary.endswith("-save"):
            return 0, self.save_text(backend, family, argv[argv.index("-t") + 1] if "-t" in argv else "filter"), ""
        if binary.endswith("-restore"):
            assert "--noflush" in argv, argv
            return self.restore(backend, family, stdin)
        args = [a for a in argv[1:] if a not in ("-w", "10")]
        if args == ["--version"]:
            return 0, f"iptables v1.8.13 ({'nf_tables' if backend == 'nft' else 'legacy'})\n", ""
        return self.command(backend, family, args)

    def restore(self, backend, family, payload):
        tables = {name: copy.deepcopy(self.table(backend, family, name)) for name in ("filter", "nat", "raw")}
        chains = None
        for number, line in enumerate(payload.splitlines(), 1):
            if line == "COMMIT" or not line:
                continue
            if line.startswith("*"):
                chains = tables[line[1:]]["chains"]
                continue
            words = line.split()
            if words[0] == "-X" and words[1] in chains and not chains[words[1]]:
                del chains[words[1]]
            elif line.startswith(":"):
                chains[line[1:].split()[0]] = []
            elif words[0] == "-A" and words[1] in chains:
                chains[words[1]].append(line)
            elif words[0] == "-D" and words[1] in chains and ("-A" + line[2:]) in chains[words[1]]:
                chains[words[1]].remove("-A" + line[2:])
            elif words[0] == "-I" and words[1] in chains:
                chains[words[1]].insert(int(words[2]) - 1, " ".join(["-A", words[1], *words[3:]]))
            else:
                return 1, "", f"line {number} failed"  # nothing of the transaction is kept
        self.tables[(backend, family)], self.nat[(backend, family)] = tables["filter"], tables["nat"]
        self.raw[(backend, family)] = tables["raw"]
        return 0, "", ""

    def ip(self, args):
        """ip -j -<4|6> rule show; ip -<4|6> rule add|del priority N [iif I] fwmark M/K prohibit."""
        as_json = args[0] == "-j"
        args = args[1:] if as_json else args
        family, args = int(args[0][1:]), args[1:]
        rules = self.routing[family]
        if args == ["rule", "show"] and as_json:
            return 0, json.dumps(rules), ""
        if args[0] != "rule" or args[1] not in ("add", "del") or args[-1] != "prohibit":
            return 1, "", f"bad ip command {args}"
        words = dict(zip(args[2:-1:2], args[3:-1:2]))
        mark, mask = words["fwmark"].split("/")
        rule = {"priority": int(words["priority"]), "src": "all", "fwmark": mark, "fwmask": mask,
                **({"iif": words["iif"]} if "iif" in words else {}), "action": "prohibit"}
        if args[1] == "add":
            rules.append(rule)
            rules.sort(key=lambda r: r["priority"])
        elif rule in rules:
            rules.remove(rule)
        else:
            return 2, "", "RTNETLINK answers: No such file or directory"
        return 0, "", ""

    def command(self, backend, family, args):
        name = "filter"
        if args[0] == "-t":
            name, args = args[1], args[2:]
        table = self.table(backend, family, name)
        chains = table["chains"]
        if args[0] == "-D" and args[1] in chains and " ".join(["-A", *args[1:]]) in chains[args[1]]:
            chains[args[1]].remove(" ".join(["-A", *args[1:]]))
        elif args[0] == "-F" and args[1] in chains:
            chains[args[1]] = []
        elif args[0] == "-X" and args[1] in chains and not chains[args[1]] and args[1] not in table["builtin"]:
            if any(rule.endswith(f"-j {args[1]}") for rules in chains.values() for rule in rules):
                return 1, "", "chain is referenced"
            del chains[args[1]]
        else:
            return 1, "", f"bad command {args}"
        return 0, "", ""


def config_value(**change):
    value = {"schemaVersion": 1, "network": "orbit-managed-runners", "bridge": BRIDGE, "gateway": "172.19.0.1", "apiPort": 2086,
             "dnsServers": ["192.168.1.254"], "allow": [{"to": "10.77.0.2", "protocol": "tcp", "port": 18080}],
             "intervalSeconds": 10}
    value.update(change)
    return value


class FirewallFixture(unittest.TestCase):
    def setUp(self):
        self.fw = load_firewall()
        self.config = self.fw.parse_config(config_value())
        self.scratch = tempfile.TemporaryDirectory(prefix="managed-runner-firewall-test-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.lock = self.root / "xtables.lock"
        self.lock.write_text("")

    def address_of(self, name):
        return "172.19.0.1" if name == BRIDGE else None

    def apply(self, host, backend="nft", ipv6=True, config=None):
        return self.fw.apply(config or self.config, self.fw.Iptables(backend, host.run), ipv6, self.address_of, str(self.lock))

    def check(self, host, backend="nft", ipv6=True, seen=False):
        return self.fw.check(self.config, self.fw.Iptables(backend, host.run), ipv6, self.address_of, seen)


class ConfigurationTest(FirewallFixture):
    def test_a_valid_configuration_is_normalized(self):
        self.assertEqual(self.config["allow"], [{"to": "10.77.0.2/32", "protocol": "tcp", "port": 18080}])
        self.assertEqual(self.fw.parse_config(config_value(dnsServers=[], allow=[]))["intervalSeconds"], 10)

    def test_the_example_is_a_valid_configuration(self):
        self.fw.parse_config(json.loads((FIREWALL.parent / "config.example.json").read_text()))

    def test_every_problem_is_reported(self):
        for change, needle in (
                ({"schemaVersion": 2}, "schemaVersion"),
                ({"bridge": "br-0123456789abcdef"}, "bridge"),
                ({"bridge": "br 0"}, "bridge"),
                ({"gateway": "127.0.0.1"}, "gateway"),
                ({"gateway": "fe80::1"}, "gateway"),
                ({"apiPort": 0}, "apiPort"),
                ({"apiPort": True}, "apiPort"),
                ({"dnsServers": ["192.168.1.254", "192.168.1.254"]}, "dnsServers"),
                ({"dnsServers": ["::1"]}, "dnsServers"),
                ({"allow": [{"to": "0.0.0.0/0", "protocol": "tcp", "port": 1}]}, "allow[0].to"),
                ({"allow": [{"to": "10.0.0.0/7", "protocol": "tcp", "port": 1}]}, "allow[0].to"),
                ({"allow": [{"to": "10.0.0.1", "protocol": "icmp", "port": 1}]}, "allow[0].protocol"),
                ({"allow": [{"to": "10.0.0.1", "protocol": "tcp"}]}, "allow[0]"),
                ({"allow": [{"to": "10.0.0.1", "protocol": "tcp", "port": 70000}]}, "allow[0].port"),
                ({"intervalSeconds": 1}, "intervalSeconds"),
                ({"extra": 1}, "extra is not a configuration field"),
        ):
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, re.escape(needle)):
                    self.fw.parse_config(config_value(**change))
        with self.assertRaises(ValueError) as both:
            self.fw.parse_config(config_value(apiPort=0, bridge=""))
        self.assertIn("apiPort", str(both.exception))
        self.assertIn("bridge", str(both.exception))


class RulesTest(FirewallFixture):
    def test_the_host_itself_is_reachable_only_on_the_gateway_port_dns_and_what_is_allowed(self):
        self.assertEqual(self.fw.chain_rules(self.config, 4)["ORBIT-MR-INPUT"], [
            "-A ORBIT-MR-INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
            "-A ORBIT-MR-INPUT -d 172.19.0.1/32 -p tcp -m tcp --dport 2086 -j RETURN",
            "-A ORBIT-MR-INPUT -d 192.168.1.254/32 -p udp -m udp --dport 53 -j RETURN",
            "-A ORBIT-MR-INPUT -d 192.168.1.254/32 -p tcp -m tcp --dport 53 -j RETURN",
            "-A ORBIT-MR-INPUT -d 10.77.0.2/32 -p tcp -m tcp --dport 18080 -j RETURN",
            "-A ORBIT-MR-INPUT -j REJECT --reject-with icmp-admin-prohibited",
        ])

    def test_through_the_host_only_public_addresses_the_published_port_dns_and_what_is_allowed(self):
        rules = self.fw.chain_rules(self.config, 4)["ORBIT-MR-FORWARD"]
        self.assertEqual(rules[:5], [
            "-A ORBIT-MR-FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
            "-A ORBIT-MR-FORWARD -p tcp -m conntrack --ctstate DNAT --ctorigdst 172.19.0.1 --ctorigdstport 2086 -j RETURN",
            "-A ORBIT-MR-FORWARD -d 192.168.1.254/32 -p udp -m udp --dport 53 -j RETURN",
            "-A ORBIT-MR-FORWARD -d 192.168.1.254/32 -p tcp -m tcp --dport 53 -j RETURN",
            "-A ORBIT-MR-FORWARD -d 10.77.0.2/32 -p tcp -m tcp --dport 18080 -j RETURN",
        ])
        rejected = [rule.split()[3] for rule in rules[5:]]
        self.assertTrue(all(rule.endswith("-j REJECT --reject-with icmp-admin-prohibited") for rule in rules[5:]))
        # The ranges the account owner named, the cloud metadata address among them, and none twice.
        for required in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"):
            self.assertIn(required, rejected)
        self.assertEqual(len(rejected), len(set(rejected)))
        self.assertTrue(any(ipaddress.IPv4Address("169.254.169.254") in ipaddress.IPv4Network(block) for block in rejected))
        # Every IPv4 address that is not globally reachable is in one of them; a public one in none.
        for address in ("10.1.2.3", "172.31.255.255", "192.168.1.12", "100.127.0.1", "127.0.0.1", "0.1.2.3", "192.0.0.8",
                        "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.251", "239.255.255.250",
                        "255.255.255.255", "240.0.0.1"):
            with self.subTest(address=address):
                self.assertTrue(any(ipaddress.IPv4Address(address) in ipaddress.IPv4Network(b) for b in rejected))
        for address in ("1.1.1.1", "20.205.243.166", "3.173.21.63", "172.15.255.255", "172.32.0.1", "100.63.255.255", "192.88.99.1"):
            with self.subTest(address=address):
                self.assertFalse(any(ipaddress.IPv4Address(address) in ipaddress.IPv4Network(b) for b in rejected))

    def test_the_rules_only_take_reachability_away(self):
        # Nothing is accepted here: an allowed packet RETURNs to the rules the host already has.
        for family in (4, 6):
            for chain, rules in self.fw.chain_rules(self.config, family).items():
                for rule in rules:
                    with self.subTest(rule=rule):
                        self.assertRegex(rule, r" -j (RETURN|REJECT --reject-with icmp6?-ad(min|m)-prohibited)$")

    def test_ipv6_from_the_bridge_is_rejected_whole(self):
        self.assertEqual(self.fw.chain_rules(self.config, 6), {
            "ORBIT-MR-INPUT": ["-A ORBIT-MR-INPUT -j REJECT --reject-with icmp6-adm-prohibited"],
            "ORBIT-MR-FORWARD": ["-A ORBIT-MR-FORWARD -j REJECT --reject-with icmp6-adm-prohibited"],
        })

    def test_the_jumps_match_the_bridge_only(self):
        self.assertEqual(self.fw.jump_rules(self.config, {"input": "INPUT", "forward": "DOCKER-USER"}), {
            "INPUT": f"-A INPUT -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT",
            "DOCKER-USER": f"-A DOCKER-USER -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD",
        })


class SaveParsingTest(FirewallFixture):
    def test_only_the_filter_table_is_read_and_comments_and_warnings_are_skipped(self):
        saved = self.fw.parse_save(
            "# Warning: iptables-legacy tables present, use iptables-legacy-save to see them\n"
            "*nat\n:PREROUTING ACCEPT [0:0]\n-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER\nCOMMIT\n"
            "*filter\n:INPUT ACCEPT [12:345]\n:DOCKER-USER - [0:0]\n"
            "-A INPUT -i br-x -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT\nCOMMIT\n")
        self.assertEqual(saved["chains"], {"INPUT", "DOCKER-USER"})
        self.assertEqual(saved["rules"], {"INPUT": ["-A INPUT -i br-x -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT"]})
        self.assertEqual(self.fw.jumps_into_ours(saved), [("INPUT", saved["rules"]["INPUT"][0])])


class ApplyTest(FirewallFixture):
    def test_rules_are_written_in_one_transaction_and_then_found_in_force(self):
        host = FakeHost()
        self.assertEqual(len(self.check(host)), 8, "two chains and two jumps, in each family")
        changed, problems = self.apply(host)
        self.assertEqual((changed, problems), ([4, 6], []))
        restores = [argv for argv, _ in host.calls if argv[0].endswith("-restore")]
        self.assertEqual([argv[0] for argv in restores], ["iptables-nft-restore", "ip6tables-nft-restore"])
        self.assertEqual(self.check(host), [])
        chains = host.table("nft", 4)["chains"]
        self.assertEqual(chains["INPUT"][0], f"-A INPUT -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT")
        self.assertEqual(chains["DOCKER-USER"], [f"-A DOCKER-USER -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD"])
        self.assertEqual(chains["FORWARD"][0], "-A FORWARD -j DOCKER-USER", "Docker's own rules are untouched")

    def test_applying_again_writes_nothing(self):
        host = FakeHost()
        self.apply(host)
        host.calls.clear()
        self.assertEqual(self.apply(host), ([], []))
        self.assertFalse([argv for argv, _ in host.calls if argv[0].endswith("-restore")])

    def test_what_changed_on_the_host_is_repaired(self):
        cases = {
            "the input chain flushed": lambda t: t["chains"].__setitem__("ORBIT-MR-INPUT", []),
            "a rule dropped from the forward chain": lambda t: t["chains"]["ORBIT-MR-FORWARD"].pop(3),
            "a rule added to it": lambda t: t["chains"]["ORBIT-MR-FORWARD"].insert(0, "-A ORBIT-MR-FORWARD -j RETURN"),
            "the jump no longer first in INPUT": lambda t: t["chains"]["INPUT"].insert(0, "-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT"),
            "the jump gone": lambda t: t["chains"]["DOCKER-USER"].clear(),
            "the jump twice": lambda t: t["chains"]["INPUT"].append(t["chains"]["INPUT"][0]),
            "a jump left for an old bridge": lambda t: t["chains"]["INPUT"].append(
                "-A INPUT -i br-feedfacecafe -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT"),
            "every chain flushed and deleted": lambda t: t.__setitem__("chains", docker_table()["chains"]),
        }
        for name, change in cases.items():
            with self.subTest(name=name):
                host = FakeHost()
                self.apply(host)
                change(host.table("nft", 4))
                self.assertNotEqual(self.check(host), [])
                self.assertEqual(self.apply(host), ([4], []))
                self.assertEqual(self.check(host), [])
                input_rules = host.table("nft", 4)["chains"]["INPUT"]
                self.assertEqual([rule for rule in input_rules if rule.endswith("-j ORBIT-MR-INPUT")], input_rules[:1])

    def test_a_refused_transaction_leaves_the_rules_as_they_were(self):
        host = FakeHost()
        self.apply(host)
        before = copy.deepcopy(host.tables)
        host.table("nft", 4)["chains"]["ORBIT-MR-INPUT"].pop()
        changed_table = copy.deepcopy(host.tables)
        host.fail = "iptables-nft-restore"
        with self.assertRaisesRegex(RuntimeError, "refused the rules"):
            self.apply(host)
        self.assertEqual(host.tables, changed_table)
        self.assertNotEqual(before, changed_table)

    def test_a_changed_configuration_replaces_the_rules_whole(self):
        host = FakeHost()
        self.apply(host)
        other = self.fw.parse_config(config_value(bridge="br-feedfacecafe", apiPort=8086, dnsServers=[], allow=[]))
        self.fw.apply(other, self.fw.Iptables("nft", host.run), True, lambda name: "172.19.0.1", str(self.lock))
        chains = host.table("nft", 4)["chains"]
        jumps = [rule for rules in chains.values() for rule in rules if rule.endswith(("-j ORBIT-MR-INPUT", "-j ORBIT-MR-FORWARD"))]
        self.assertEqual(sorted(jumps), sorted(self.fw.jump_rules(other, {"input": "INPUT", "forward": "DOCKER-USER"}).values()))
        self.assertEqual(chains["ORBIT-MR-INPUT"], self.fw.chain_rules(other, 4)["ORBIT-MR-INPUT"])

    def test_without_docker_user_nothing_is_written(self):
        host = FakeHost(docker_backend=None)
        with self.assertRaisesRegex(RuntimeError, "DOCKER-USER chain is not there"):
            self.apply(host)
        self.assertFalse([argv for argv, _ in host.calls if argv[0].endswith("-restore")])

    def test_ipv6_rules_hook_forward_where_docker_manages_no_ip6tables(self):
        host = FakeHost(ipv6_docker=False)
        self.assertEqual(self.apply(host), ([4, 6], []))
        self.assertEqual(host.table("nft", 6)["chains"]["FORWARD"][0],
                         f"-A FORWARD -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD")

    def test_a_host_without_ipv6_gets_ipv4_rules_only(self):
        host = FakeHost()
        self.assertEqual(self.apply(host, ipv6=False), ([4], []))
        self.assertNotIn("ORBIT-MR-INPUT", host.table("nft", 6)["chains"])

    def test_forward_must_start_with_dockers_jump(self):
        host = FakeHost()
        self.apply(host)
        host.table("nft", 4)["chains"]["FORWARD"].insert(0, "-A FORWARD -j ACCEPT")
        self.assertIn("IPv4: FORWARD does not start with Docker's jump to DOCKER-USER", self.check(host))

    def test_the_bridge_must_carry_the_gateway_address(self):
        host = FakeHost()
        self.apply(host)
        self.assertRegex(" ".join(self.fw.check(self.config, self.fw.Iptables("nft", host.run), True, lambda name: None)),
                         "not in this network namespace")
        self.assertRegex(" ".join(self.fw.check(self.config, self.fw.Iptables("nft", host.run), True, lambda name: "172.20.0.1")),
                         "not the network's gateway")

    def test_the_legacy_backend_needs_the_hosts_xtables_lock(self):
        host = FakeHost(docker_backend="legacy")
        self.lock.unlink()
        with self.assertRaisesRegex(RuntimeError, "xtables.lock"):
            self.apply(host, backend="legacy")
        self.lock.write_text("")
        self.assertEqual(self.apply(host, backend="legacy"), ([4, 6], []))


class BackendTest(FirewallFixture):
    def test_the_backend_holding_dockers_chains_is_used(self):
        self.assertEqual(self.fw.detect_backend(FakeHost("nft").run, legacy_present=False), "nft")
        self.assertEqual(self.fw.detect_backend(FakeHost("legacy").run, legacy_present=True), "legacy")
        # Empty legacy tables beside Docker's nft rules, as on a host where something once used the legacy backend.
        self.assertEqual(self.fw.detect_backend(FakeHost("nft", legacy=True).run, legacy_present=True), "nft")

    def test_the_legacy_backend_is_not_read_where_it_has_no_tables(self):
        host = FakeHost("nft")
        self.fw.detect_backend(host.run, legacy_present=False)
        self.assertFalse([argv for argv, _ in host.calls if "legacy" in argv[0]], "reading it would make its tables")

    def test_no_backend_holding_dockers_chains_is_refused_with_why(self):
        with self.assertRaisesRegex(ValueError, "neither iptables backend.*nftables or rootless"):
            self.fw.detect_backend(FakeHost(docker_backend=None).run, legacy_present=True)
        host = FakeHost("nft")
        host.fail = "iptables-nft-save"
        with self.assertRaisesRegex(ValueError, "nft: iptables-nft-save failed"):
            self.fw.detect_backend(host.run, legacy_present=False)

    def test_both_backends_holding_dockers_chains_is_refused(self):
        host = FakeHost("nft")
        host.tables[("legacy", 4)] = docker_table()
        with self.assertRaisesRegex(ValueError, "both iptables backends"):
            self.fw.detect_backend(host.run, legacy_present=True)


class PreflightAndRemoveTest(FirewallFixture):
    def test_preflight_tries_every_rule_in_a_scratch_chain_and_removes_it(self):
        host = FakeHost()
        facts = self.fw.preflight(self.fw.Iptables("nft", host.run), ipv6=True, xtables_lock=str(self.lock))
        self.assertEqual(facts, {"backend": "nft", "ipv6": "present", "ipv4Hook": "DOCKER-USER", "ipv6Hook": "DOCKER-USER",
                                 "iptables": "iptables v1.8.13 (nf_tables)"})
        payloads = [stdin for argv, stdin in host.calls if argv[0].endswith("-restore")]
        self.assertEqual(len(payloads), 2)
        self.assertIn("--ctstate DNAT --ctorigdst 192.0.2.1 --ctorigdstport 2086", payloads[0])
        self.assertIn("-m comment --comment orbit-managed-runners", payloads[0])
        self.assertNotIn("-A INPUT", payloads[0] + payloads[1], "no rule a packet reaches")
        for family in (4, 6):
            self.assertNotIn("ORBIT-MR-PREFLIGHT", host.table("nft", family)["chains"])
        self.assertEqual(host.tables[("nft", 4)], docker_table())

    def test_preflight_fails_where_a_rule_cannot_be_written(self):
        host = FakeHost()
        host.fail = "ip6tables-nft-restore"
        with self.assertRaisesRegex(RuntimeError, "ip6tables-nft-restore refused"):
            self.fw.preflight(self.fw.Iptables("nft", host.run), ipv6=True, xtables_lock=str(self.lock))
        self.assertNotIn("ORBIT-MR-PREFLIGHT", host.table("nft", 6)["chains"])

    def test_remove_takes_every_rule_and_chain_off_both_families(self):
        host = FakeHost()
        self.apply(host)
        host.table("nft", 4)["chains"]["INPUT"].append(
            "-A INPUT -i br-feedfacecafe -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT")
        done = self.fw.remove(host.run, legacy_present=False, ipv6=True)
        self.assertEqual(len(done), 9)
        self.assertEqual(host.tables[("nft", 4)], docker_table())
        self.assertEqual(host.tables[("nft", 6)], docker_table())
        self.assertEqual(self.fw.remove(host.run, legacy_present=False, ipv6=True), [], "removing twice finds nothing")


class StatusTest(FirewallFixture):
    def test_the_service_says_starting_then_enforced_then_stopped_and_the_rules_stay(self):
        host = FakeHost()
        config_file, status_file = self.root / "config.json", self.root / "status.json"
        config_file.write_text(json.dumps(config_value()))
        written = []
        real = self.fw.write_status

        def capture(path, status):
            written.append(status)
            real(path, status)

        with mock.patch.object(self.fw, "write_status", capture), mock.patch.object(self.fw, "boot_id", lambda *a: "boot-1"), \
                mock.patch.object(self.fw, "detect_backend", lambda run=None: "nft"), mock.patch.object(self.fw.signal, "signal"):
            code = self.fw.serve(str(config_file), str(status_file), host.run, self.address_of, True, str(self.lock), cycles=1)
        self.assertEqual(code, 0)
        self.assertEqual([status["state"] for status in written], ["starting", "enforced", "stopped"])
        enforced = written[1]
        self.assertEqual(enforced["validUntil"], enforced["checkedAt"] + 30)
        self.assertEqual((enforced["bridge"], enforced["gateway"], enforced["backend"], enforced["bootId"]),
                         (BRIDGE, "172.19.0.1", "nft", "boot-1"))
        self.assertEqual(self.check(host), [], "stopping leaves the rules")
        self.assertEqual(json.loads(status_file.read_text())["state"], "stopped")

    def test_a_failure_is_reported_not_raised(self):
        host = FakeHost(docker_backend=None)
        config_file, status_file = self.root / "config.json", self.root / "status.json"
        config_file.write_text(json.dumps(config_value()))
        written = []
        with mock.patch.object(self.fw, "write_status", lambda path, status: written.append(status)), \
                mock.patch.object(self.fw.signal, "signal"):
            self.fw.serve(str(config_file), str(status_file), host.run, self.address_of, True, str(self.lock), cycles=1)
        self.assertEqual(written[1]["state"], "failing")
        self.assertRegex(written[1]["reason"], "neither iptables backend")
        self.assertNotIn("validUntil", written[1])

    def test_an_unreadable_configuration_is_a_failing_status(self):
        status_file = self.root / "status.json"
        (self.root / "config.json").write_text("{")
        with mock.patch.object(self.fw.signal, "signal"):
            self.assertEqual(self.fw.serve(str(self.root / "config.json"), str(status_file), FakeHost().run), 2)
        self.assertEqual(json.loads(status_file.read_text())["state"], "failing")

    def test_the_status_is_believed_only_while_fresh_from_this_boot(self):
        status_file = self.root / "status.json"
        record = {"schemaVersion": 1, "state": "enforced", "checkedAt": 1000, "validUntil": 1030, "bootId": "boot-1",
                  "bridge": BRIDGE, "gateway": "172.19.0.1"}
        status_file.write_text(json.dumps(record))
        self.assertEqual(self.fw.read_status(str(status_file), now=1010, current_boot="boot-1"), (True, record))
        self.assertFalse(self.fw.read_status(str(status_file), now=1031, current_boot="boot-1")[0])
        ok, why = self.fw.read_status(str(status_file), now=1010, current_boot="boot-2")
        self.assertFalse(ok)
        self.assertIn("before this host last started", why)
        status_file.write_text(json.dumps({**record, "state": "failing", "reason": "the bridge is gone"}))
        self.assertEqual(self.fw.read_status(str(status_file), now=1010, current_boot="boot-1"),
                         (False, "the firewall service reports 'failing': the bridge is gone"))
        status_file.unlink()
        self.assertFalse(self.fw.read_status(str(status_file), now=1010, current_boot="boot-1")[0])


class KubernetesTest(FirewallFixture):
    """k3s beside Docker: its jumps sit above DOCKER-USER in FORWARD, and kube-proxy's KUBE-SERVICES DNATs in nat
    PREROUTING on every interface. The rules must still come first for the runners' bridge, and stay first."""

    FORWARD_JUMP = f"-A FORWARD -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD"
    INPUT_JUMP = f"-A INPUT -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT"
    NAT_JUMP = f"-A PREROUTING -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-PREROUTING"
    RAW_JUMP = f"-A PREROUTING -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-RAW"
    ROUTING_RULE = {"priority": 1, "src": "all", "fwmark": "0x100000", "fwmask": "0x100000", "iif": BRIDGE, "action": "prohibit"}

    def k3s_host(self, ipv6_k3s=True):
        host = FakeHost()
        add_k3s(host)
        if ipv6_k3s:
            add_k3s(host, family=6)
        return host

    def assert_first(self, host, family=4):
        filter_chains = host.table("nft", family)["chains"]
        nat = host.table("nft", family, "nat")["chains"]
        self.assertEqual(filter_chains["FORWARD"][0], self.FORWARD_JUMP)
        self.assertEqual(filter_chains["INPUT"][0], self.INPUT_JUMP)
        self.assertEqual(nat["PREROUTING"][0], self.NAT_JUMP)
        self.assertLess(nat["PREROUTING"].index(self.NAT_JUMP), nat["PREROUTING"].index(KUBE_PREROUTING))
        self.assertEqual(nat["ORBIT-MR-PREROUTING"], self.fw.nat_rules(self.config, family))
        raw = host.table("nft", family, "raw")["chains"]
        self.assertEqual(raw["PREROUTING"][0], self.RAW_JUMP)
        self.assertEqual(raw["ORBIT-MR-RAW"], self.fw.guard_rules(self.config, family, "raw"))
        self.assertEqual(self.fw.our_routing_rules(host.routing[family]), [self.ROUTING_RULE])
        self.assertEqual(host.routing[family][:2], [{"priority": 0, "src": "all", "table": "local"}, self.ROUTING_RULE])

    def test_the_nat_guard_lets_only_dockers_dnat_of_the_published_port_and_the_allowed_destinations_through(self):
        self.assertEqual(self.fw.nat_rules(self.config, 4), [
            "-A ORBIT-MR-PREROUTING -d 172.19.0.1/32 -p tcp -m tcp --dport 2086 -j RETURN",
            "-A ORBIT-MR-PREROUTING -d 192.168.1.254/32 -p udp -m udp --dport 53 -j RETURN",
            "-A ORBIT-MR-PREROUTING -d 192.168.1.254/32 -p tcp -m tcp --dport 53 -j RETURN",
            "-A ORBIT-MR-PREROUTING -d 10.77.0.2/32 -p tcp -m tcp --dport 18080 -j RETURN",
            "-A ORBIT-MR-PREROUTING -j ACCEPT",
        ])
        self.assertEqual(self.fw.nat_rules(self.config, 6), ["-A ORBIT-MR-PREROUTING -j ACCEPT"])

    def test_kubernetes_is_found_by_its_chains(self):
        host = FakeHost()
        self.assertFalse(self.fw.kubernetes(self.fw.Iptables("nft", host.run).save_both(4)))
        add_k3s(host)
        self.assertTrue(self.fw.kubernetes(self.fw.Iptables("nft", host.run).save_both(4)))
        flannel_only = FakeHost()
        flannel_only.table("nft", 4)["chains"]["FLANNEL-FWD"] = []
        self.assertTrue(self.fw.kubernetes(self.fw.Iptables("nft", flannel_only.run).save_both(4)))

    def test_what_kubernetes_put_first_is_named(self):
        problems = self.check(self.k3s_host())
        self.assertNotIn("IPv4: FORWARD does not start with Docker's jump to DOCKER-USER", problems)
        self.assertIn("IPv4: nat chain ORBIT-MR-PREROUTING is missing", problems)
        self.assertIn(f"IPv4: nat PREROUTING does not start with the jump for {BRIDGE}: it is missing", problems)
        host = self.k3s_host()
        self.apply(host)
        kube_router_sync(host)
        problems = self.check(host)
        self.assertIn(f"IPv4: FORWARD does not start with the jump for {BRIDGE}: KUBE-ROUTER-FORWARD come(s) before it", problems)
        self.assertIn(f"IPv4: INPUT does not start with the jump for {BRIDGE}: KUBE-ROUTER-INPUT come(s) before it", problems)
        self.assertIn(f"IPv4: nat PREROUTING does not start with the jump for {BRIDGE}: KUBE-SERVICES come(s) before it", problems)
        self.assertFalse([problem for problem in problems if problem.startswith("IPv6")])

    def test_the_rules_go_first_in_forward_and_nat_prerouting_ahead_of_kubernetes(self):
        host = self.k3s_host()
        self.assertEqual(self.apply(host), ([4, 6], []))
        self.assertEqual(self.check(host), [])
        for family in (4, 6):
            with self.subTest(family=family):
                self.assert_first(host, family)
        chains = host.table("nft", 4)["chains"]
        # Docker's DOCKER-USER keeps its jump too, and every rule of Kubernetes and Docker is still there, in order.
        self.assertEqual(chains["DOCKER-USER"], [f"-A DOCKER-USER -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD"])
        self.assertEqual(chains["FORWARD"][1:], [*KUBE_FORWARD, "-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD",
                                                  '-A FORWARD -m comment --comment "flanneld forward" -j FLANNEL-FWD'])
        self.assertEqual(chains["INPUT"][1:], KUBE_INPUT)
        self.assertEqual(host.table("nft", 4, "nat")["chains"]["PREROUTING"][1:],
                         [KUBE_PREROUTING, "-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER"])
        # Every jump matches the bridge only.
        jumps = [rule for table in ("filter", "nat") for rules in host.table("nft", 4, table)["chains"].values()
                 for rule in rules if " -j ORBIT-MR-" in rule]
        self.assertEqual(len(jumps), 4)
        self.assertTrue(all(f" -i {BRIDGE} " in rule for rule in jumps))
        restores = [stdin for argv, stdin in host.calls if argv[0] == "iptables-nft-restore"]
        self.assertEqual(len(restores), 1, "filter and nat in one iptables-restore")
        self.assertIn("*nat", restores[0])

    def test_the_raw_guard_marks_every_refused_address_and_a_routing_rule_refuses_it(self):
        rules = self.fw.guard_rules(self.config, 4, "raw")
        self.assertEqual(rules[:4], [
            "-A ORBIT-MR-RAW -d 172.19.0.1/32 -p tcp -m tcp --dport 2086 -j RETURN",
            "-A ORBIT-MR-RAW -d 192.168.1.254/32 -p udp -m udp --dport 53 -j RETURN",
            "-A ORBIT-MR-RAW -d 192.168.1.254/32 -p tcp -m tcp --dport 53 -j RETURN",
            "-A ORBIT-MR-RAW -d 10.77.0.2/32 -p tcp -m tcp --dport 18080 -j RETURN",
        ])
        # Every range the filter chain rejects is marked, and nothing else; marking takes nothing but routing away.
        self.assertEqual([rule.split()[3] for rule in rules[4:]], list(self.fw.BLOCKED_V4))
        self.assertTrue(all(rule.endswith("-j MARK --set-xmark 0x100000/0x100000") for rule in rules[4:]))
        self.assertEqual(self.fw.guard_rules(self.config, 6, "raw"), ["-A ORBIT-MR-RAW -j MARK --set-xmark 0x100000/0x100000"])
        self.assertEqual(self.fw.routing_rule(self.config), self.ROUTING_RULE)
        self.assertEqual(self.fw.rule_args(self.ROUTING_RULE),
                         ["priority", "1", "iif", BRIDGE, "fwmark", "0x100000/0x100000", "prohibit"])

    def test_the_raw_guard_holds_while_kube_router_sits_above_the_filter_rules(self):
        host = self.k3s_host()
        self.apply(host)
        kube_router_sync(host)
        problems = self.check(host)
        # The filter rules lost their first place; the guard that does not depend on it did not.
        self.assertFalse([problem for problem in problems if "raw" in problem or "routing rule" in problem])
        self.assertEqual(host.table("nft", 4, "raw")["chains"]["PREROUTING"][0], self.RAW_JUMP)
        self.assertIn(self.ROUTING_RULE, host.routing[4])

    def test_a_missing_or_stale_routing_rule_is_put_back(self):
        for name, change in {
            "deleted": lambda r: r.remove(self.ROUTING_RULE),
            "for an old bridge": lambda r: r.append({**self.ROUTING_RULE, "iif": "br-feedfacecafe"}),
            "a rule routed before it": lambda r: r.insert(1, {"priority": 0, "src": "all", "fwmark": "0x1", "table": "100"}),
        }.items():
            with self.subTest(name=name):
                host = self.k3s_host()
                self.apply(host)
                change(host.routing[4])
                self.assertTrue(any("routing rule" in problem for problem in self.check(host)))
                if name == "a rule routed before it":
                    # Not this program's to remove: reported, so never enforced while it is there.
                    self.assertIn("IPv4: 1 routing rule(s) other than the local table's come before the guard's", self.apply(host)[1])
                    continue
                self.assertEqual(self.apply(host), ([4], []))
                self.assertEqual(self.fw.our_routing_rules(host.routing[4]), [self.ROUTING_RULE])

    def test_once_kubernetes_was_seen_the_guards_go_on_before_it_starts(self):
        host = FakeHost()  # after a host restart: Docker's rules, no Kubernetes yet
        self.assertEqual(self.fw.apply(self.config, self.fw.Iptables("nft", host.run), True, self.address_of, str(self.lock),
                                       None, True), ([4, 6], []))
        for family in (4, 6):
            chains = host.table("nft", family)["chains"]
            self.assertEqual(chains["FORWARD"][0], self.FORWARD_JUMP)
            self.assertEqual(host.table("nft", family, "raw")["chains"]["PREROUTING"][0], self.RAW_JUMP)
            self.assertEqual(self.fw.our_routing_rules(host.routing[family]), [self.ROUTING_RULE])
        # k3s comes up after the firewall: kube-proxy prepends KUBE-SERVICES in nat PREROUTING and kube-router its jumps in
        # FORWARD and INPUT. The raw guard and the routing rule, which no Kubernetes component writes, stay as they were
        # (a ClusterIP is marked before KUBE-SERVICES DNATs it); the next check puts the rest first again.
        add_k3s(host)
        problems = self.check(host, seen=True)
        self.assertIn(f"IPv4: nat PREROUTING does not start with the jump for {BRIDGE}: KUBE-SERVICES come(s) before it", problems)
        self.assertFalse([problem for problem in problems if "raw" in problem or "routing" in problem])
        self.assertEqual(self.fw.apply(self.config, self.fw.Iptables("nft", host.run), True, self.address_of, str(self.lock),
                                       None, True), ([4], []))
        self.assert_first(host)

    def test_applying_again_writes_nothing(self):
        host = self.k3s_host()
        self.apply(host)
        host.calls.clear()
        self.assertEqual(self.apply(host), ([], []))
        self.assertFalse([argv for argv, _ in host.calls if argv[0].endswith("-restore")])

    def test_the_rules_are_put_first_again_after_kubernetes_reinserts_its_jumps(self):
        host = self.k3s_host()
        self.apply(host)
        for change in ("kube-router sync", "kube-proxy prepends KUBE-SERVICES again", "nat guard flushed", "forward jump deleted"):
            with self.subTest(change=change):
                if change == "kube-router sync":
                    kube_router_sync(host)
                elif change == "kube-proxy prepends KUBE-SERVICES again":
                    host.table("nft", 4, "nat")["chains"]["PREROUTING"].remove(KUBE_PREROUTING)
                    host.table("nft", 4, "nat")["chains"]["PREROUTING"].insert(0, KUBE_PREROUTING)
                elif change == "nat guard flushed":
                    host.table("nft", 4, "nat")["chains"]["ORBIT-MR-PREROUTING"] = []
                else:
                    host.table("nft", 4)["chains"]["FORWARD"].remove(self.FORWARD_JUMP)
                self.assertNotEqual(self.check(host), [])
                self.assertEqual(self.apply(host), ([4], []))
                self.assertEqual(self.check(host), [])
                self.assert_first(host)
                chains = host.table("nft", 4)["chains"]
                self.assertEqual(chains["FORWARD"].count(self.FORWARD_JUMP), 1)
                self.assertEqual(host.table("nft", 4, "nat")["chains"]["PREROUTING"].count(self.NAT_JUMP), 1)

    def test_the_service_is_enforced_only_while_first_and_restores_within_one_check(self):
        host = self.k3s_host(ipv6_k3s=False)
        config_file, status_file = self.root / "config.json", self.root / "status.json"
        config_file.write_text(json.dumps(config_value()))
        written, checks, synced = [], [], []
        real_apply = self.fw.apply

        def capture(path, status):
            written.append(status)

        def apply_and_record(*args, **kwargs):
            checks.append(self.check(host))  # what a check finds before this cycle repairs it
            return real_apply(*args, **kwargs)

        def sleep(seconds):
            if not synced:  # k3s restarts during the first interval
                kube_router_sync(host)
                synced.append(True)

        with mock.patch.object(self.fw, "write_status", capture), mock.patch.object(self.fw, "boot_id", lambda *a: "boot-1"), \
                mock.patch.object(self.fw, "detect_backend", lambda run=None: "nft"), mock.patch.object(self.fw.signal, "signal"), \
                mock.patch.object(self.fw, "apply", apply_and_record), mock.patch.object(self.fw.time, "sleep", sleep):
            self.fw.serve(str(config_file), str(status_file), host.run, self.address_of, True, str(self.lock), cycles=2)
        self.assertEqual([status["state"] for status in written], ["starting", "enforced", "enforced", "stopped"])
        self.assertEqual(written[1]["kubernetes"], ["IPv4"])
        # Kubernetes was seen: from then on the guards hold for both families, and as the service starts.
        self.assertTrue((self.root / "kubernetes-seen").exists())
        self.assertEqual(written[2]["kubernetes"], ["IPv4", "IPv6"])
        self.assertTrue(any("KUBE-ROUTER-FORWARD come(s) before it" in problem for problem in checks[1]),
                        "the second check found Kubernetes' jumps above the rules")
        self.assertEqual(self.check(host, seen=True), [])
        self.assert_first(host)

    def test_enforced_is_not_reported_while_the_rules_cannot_be_put_first(self):
        host = self.k3s_host(ipv6_k3s=False)
        self.apply(host)
        kube_router_sync(host)
        host.fail = "iptables-nft-restore"
        with self.assertRaisesRegex(RuntimeError, "refused the rules"):
            self.apply(host)
        self.assertRegex(" ".join(self.check(host)), "FORWARD does not start with the jump")

    def test_the_guard_goes_when_kubernetes_does(self):
        host = FakeHost()
        before = copy.deepcopy((host.tables, host.nat))
        add_k3s(host)
        self.apply(host)
        for table in ("filter", "nat"):
            for name in [n for n in host.table("nft", 4, table)["chains"] if n.startswith(("KUBE-", "FLANNEL-"))]:
                del host.table("nft", 4, table)["chains"][name]
        host.table("nft", 4)["chains"]["FORWARD"] = [r for r in host.table("nft", 4)["chains"]["FORWARD"] if "KUBE" not in r and "FLANNEL" not in r]
        host.table("nft", 4)["chains"]["INPUT"] = [r for r in host.table("nft", 4)["chains"]["INPUT"] if "KUBE" not in r]
        host.table("nft", 4, "nat")["chains"]["PREROUTING"].remove(KUBE_PREROUTING)
        problems = self.check(host)
        self.assertIn("IPv4: the nat guard is left from when Kubernetes shared this host", problems)
        self.assertIn("IPv4: the raw guard is left from when Kubernetes shared this host", problems)
        self.assertIn("IPv4: the routing rule is left from when Kubernetes shared this host", problems)
        self.assertEqual(self.apply(host), ([4], []))
        plain = FakeHost()
        self.apply(plain)
        self.assertEqual((host.tables[("nft", 4)], host.nat[("nft", 4)], host.raw[("nft", 4)], host.routing[4]),
                         (plain.tables[("nft", 4)], plain.nat[("nft", 4)], plain.raw[("nft", 4)], plain.routing[4]))
        self.assertEqual(host.nat[("nft", 4)], before[1][("nft", 4)])

    def test_remove_takes_the_guard_off_too_and_leaves_kubernetes(self):
        host = self.k3s_host()
        k3s = copy.deepcopy((host.tables, host.nat, host.raw, host.routing))
        self.apply(host)
        done = self.fw.remove(host.run, legacy_present=False, ipv6=True)
        self.assertIn(f"nft IPv4: deleted nat {self.NAT_JUMP}", done)
        self.assertIn("nft IPv4: removed nat chain ORBIT-MR-PREROUTING", done)
        self.assertIn(f"nft IPv4: deleted raw {self.RAW_JUMP}", done)
        self.assertIn("nft IPv6: removed raw chain ORBIT-MR-RAW", done)
        self.assertIn(f"IPv4: deleted routing rule priority 1 iif {BRIDGE} fwmark 0x100000/0x100000 prohibit", done)
        self.assertIn(f"nft IPv4: deleted {self.FORWARD_JUMP}", done)
        self.assertEqual((host.tables, host.nat, host.raw, host.routing), k3s)

    def test_preflight_tries_the_nat_guard_in_a_scratch_chain(self):
        host = self.k3s_host(ipv6_k3s=False)
        k3s = copy.deepcopy((host.tables, host.nat, host.raw, host.routing))
        facts = self.fw.preflight(self.fw.Iptables("nft", host.run), ipv6=True, xtables_lock=str(self.lock))
        self.assertTrue(facts["ipv4Kubernetes"])
        self.assertNotIn("ipv6Kubernetes", facts)
        payload = [stdin for argv, stdin in host.calls if argv[0] == "iptables-nft-restore"][0]
        self.assertIn("*nat\n:ORBIT-MR-PREFLIGHT - [0:0]\n-A ORBIT-MR-PREFLIGHT -d 192.0.2.1/32", payload)
        self.assertIn("*raw\n:ORBIT-MR-PREFLIGHT - [0:0]\n-A ORBIT-MR-PREFLIGHT -d 192.0.2.1/32", payload)
        ip_calls = [argv for argv, _ in host.calls if argv[0] == "ip" and "show" not in argv]
        self.assertEqual([argv[3] for argv in ip_calls], ["add", "del"])
        self.assertIn("orbit-preflight", ip_calls[0])
        self.assertEqual((host.tables, host.nat, host.raw, host.routing), k3s)


class WithoutKubernetesTest(FirewallFixture):
    """A host without Kubernetes keeps exactly the rules it had: no nat rule, no jump in FORWARD itself."""

    def test_the_transaction_and_the_tables_are_as_before(self):
        host = FakeHost()
        nat_before = copy.deepcopy(host.nat)
        self.apply(host)
        payloads = [stdin for argv, stdin in host.calls if argv[0].endswith("-restore")]
        saved = self.fw.parse_save(host.save_text("nft", 4))
        self.assertEqual(payloads[0], "\n".join([
            "*filter", ":ORBIT-MR-INPUT - [0:0]", ":ORBIT-MR-FORWARD - [0:0]",
            *self.fw.chain_rules(self.config, 4)["ORBIT-MR-INPUT"], *self.fw.chain_rules(self.config, 4)["ORBIT-MR-FORWARD"],
            f"-I INPUT 1 -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT",
            f"-I DOCKER-USER 1 -i {BRIDGE} -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD",
            "COMMIT"]) + "\n")
        self.assertNotIn("*nat", "".join(payloads))
        self.assertNotIn("*raw", "".join(payloads))
        self.assertEqual(host.nat, nat_before)
        self.assertEqual(host.raw, FakeHost().raw)
        self.assertEqual(host.routing, FakeHost().routing)
        self.assertFalse([argv for argv, _ in host.calls if argv[0] == "ip" and "show" not in argv], "no routing rule written")
        self.assertEqual(saved["rules"]["FORWARD"], ["-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD"])
        self.assertEqual(self.fw.hooks_for(saved, 4), {"input": "INPUT", "forward": "DOCKER-USER"})

    def test_the_status_says_nothing_of_kubernetes(self):
        host = FakeHost()
        config_file, status_file = self.root / "config.json", self.root / "status.json"
        config_file.write_text(json.dumps(config_value()))
        written = []
        with mock.patch.object(self.fw, "write_status", lambda path, status: written.append(status)), \
                mock.patch.object(self.fw, "detect_backend", lambda run=None: "nft"), mock.patch.object(self.fw.signal, "signal"):
            self.fw.serve(str(config_file), str(status_file), host.run, self.address_of, True, str(self.lock), cycles=1)
        self.assertEqual(written[1]["state"], "enforced")
        self.assertNotIn("kubernetes", written[1])

    def test_a_rule_above_dockers_jump_is_still_refused_without_kubernetes(self):
        host = FakeHost()
        self.apply(host)
        host.table("nft", 4)["chains"]["FORWARD"].insert(0, "-A FORWARD -j ACCEPT")
        self.assertIn("IPv4: FORWARD does not start with Docker's jump to DOCKER-USER", self.check(host))
        self.assertEqual(self.apply(host)[1], ["IPv4: FORWARD does not start with Docker's jump to DOCKER-USER"])


class DockerDnsTest(FirewallFixture):
    def test_only_servers_reached_from_the_containers_namespace_need_a_rule(self):
        resolv = ("nameserver 127.0.0.11\noptions ndots:0\n\n# Based on host file: '/etc/resolv.conf' (internal resolver)\n"
                  "# ExtServers: [host(192.168.1.254)]\n# Overrides: []\n")
        self.assertEqual(self.fw.docker_dns(resolv), [])
        self.assertEqual(self.fw.docker_dns(resolv.replace("[host(192.168.1.254)]", "[192.168.1.254 10.0.0.2 192.168.1.254]")),
                         ["192.168.1.254", "10.0.0.2"])
        self.assertEqual(self.fw.docker_dns(resolv.replace("[host(192.168.1.254)]", "[host(127.0.0.53) 2001:db8::53 10.0.0.2]")),
                         ["10.0.0.2"])

    def test_without_dockers_line_the_listed_nameservers_count(self):
        self.assertEqual(self.fw.docker_dns("nameserver 127.0.0.11\nnameserver 10.0.0.2\nnameserver 2001:db8::1\n"), ["10.0.0.2"])


class CommandLineTest(FirewallFixture):
    def test_probe_endpoints_are_host_and_port(self):
        self.assertEqual(self.fw.endpoint("172.19.0.1:2086"), ("172.19.0.1", 2086))
        for bad in ("172.19.0.1", "host:0", ":22", "host:http"):
            with self.subTest(bad=bad):
                with self.assertRaises(Exception):
                    self.fw.endpoint(bad)

    def test_a_firewall_refusal_is_told_apart_from_a_refused_connection_and_a_timeout(self):
        self.assertIn("EHOSTUNREACH", self.fw.REFUSED_BY_A_FIREWALL)
        self.assertNotIn("ECONNREFUSED", self.fw.REFUSED_BY_A_FIREWALL, "a refused connection reached the host's stack")
        self.assertNotIn("TIMEOUT", self.fw.REFUSED_BY_A_FIREWALL, "a timeout proves nothing about this firewall")

    def test_the_status_command_is_the_health_check(self):
        status_file = self.root / "status.json"
        status_file.write_text(json.dumps({"schemaVersion": 1, "state": "stopped", "reason": "the firewall service stopped"}))
        with contextlib.redirect_stdout(io.StringIO()) as said:
            self.assertEqual(self.fw.main(["status", "--status", str(status_file)]), 1)
        self.assertIn("'stopped'", said.getvalue())


if __name__ == "__main__":
    unittest.main()
