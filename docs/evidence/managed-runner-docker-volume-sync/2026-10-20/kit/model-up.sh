#!/bin/bash
# Inside the D10 test host, after every start of it: the model the runners' engines talk to, as D9's host-fixtures.sh
# set it up. "lan", a network namespace behind the host (10.77.0.0/24 on a veth pair, the host at 10.77.0.1), stands for
# a deployer's private network, and the "internal model endpoint" is at 10.77.0.2:18080:
# scripts/managed-runner/lab/fake-model.py behind a TCP relay (it listens on its loopback only). Its requests go to
# /evidence/fake-model.jsonl. The managed runners' firewall lets runners reach it once allow-model.sh has run.
#   model-up.sh <fake-model.py>
set -euo pipefail
FAKE_MODEL="$1"
if ! ip netns list | grep -qw lan; then
  ip netns add lan
  ip link add veth-lan type veth peer name veth-lan-ns
  ip link set veth-lan-ns netns lan
  ip addr add 10.77.0.1/24 dev veth-lan
  ip link set veth-lan up
  ip netns exec lan ip addr add 10.77.0.2/24 dev veth-lan-ns
  ip netns exec lan ip link set veth-lan-ns up
  ip netns exec lan ip link set lo up
fi
pkill -f 'fake-model.py 18081' 2>/dev/null || true
pkill -f 'TCP-LISTEN:18080' 2>/dev/null || true
nohup ip netns exec lan python3 "$FAKE_MODEL" 18081 /evidence/fake-model.jsonl >/evidence/fake-model.log 2>&1 &
nohup ip netns exec lan socat TCP-LISTEN:18080,bind=10.77.0.2,fork,reuseaddr TCP:127.0.0.1:18081 >/evidence/fake-model-relay.log 2>&1 &
sleep 1
echo "internal model endpoint 10.77.0.2:18080 ($FAKE_MODEL)"
