#!/bin/bash
# Inside the D9 test host: the runbook's "Let runners reach an internal model endpoint", for the fake model at
# 10.77.0.2:18080: one entry in allow, the service restarted, the rules checked.
#   allow-model.sh <dir under /work>
set -euo pipefail
cd "/work/$1"
cp -p data/managed-runners/firewall/config.json /tmp/config.before
python3 - <<'PY'
import json
path = "data/managed-runners/firewall/config.json"
config = json.load(open(path))
entry = {"to": "10.77.0.2", "protocol": "tcp", "port": 18080}
if entry not in config["allow"]:
    config["allow"].append(entry)
open(path, "w").write(json.dumps(config, indent=2) + "\n")
PY
diff /tmp/config.before data/managed-runners/firewall/config.json || true
docker compose restart managed-runner-firewall
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' orbit-managed-runner-firewall)" = healthy ] && break; sleep 2; done
docker inspect -f 'health: {{.State.Health.Status}}' orbit-managed-runner-firewall
docker compose run --rm --no-deps managed-runner-firewall check
iptables -S ORBIT-MR-FORWARD | grep 18080
