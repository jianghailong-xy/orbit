#!/usr/bin/env bash
# What the default entry points say about managed runners: the switch's default, the opt-in Compose profile, the
# commented .env.example lines, every Kubernetes/Rook/Ceph/CSI word they contain (none expected), then the boundary
# and new-deployment tests that keep it so. Reads tracked files only; starts and sends nothing.
# Usage: entry-review.sh   (from anywhere inside the checkout)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
echo "== source $(git rev-parse HEAD)"
echo "== docker-compose.yml: the switch, its profile and the channel's profile"
grep -n -E 'ORBIT_MANAGED_RUNNERS_ENABLED|ORBIT_MANAGED_RUNNERS_PROFILE|profiles: \[managed-runners-docker\]' docker-compose.yml
echo "== .env.example: managed-runner lines (commented unless a fresh install appends them)"
grep -n -E 'ORBIT_MANAGED_RUNNERS_|COMPOSE_PROFILES' .env.example
echo "== Kubernetes, Rook, Ceph and CSI words in the default entry points (files per word)"
entry=('docker-compose*.yml' .env.example package.json .github/ .agents/skills/ .claude/skills/ src/web/public/install.sh gateway/
       'src/apiserver/Dockerfile*' 'src/web/Dockerfile*' 'scripts/*.sh' 'scripts/*.mjs' scripts/ci/ scripts/lib/ ':(exclude)scripts/managed-runner/')
for word in kubernetes kube kubectl kubeconfig k3s helm rook ceph csi storageclass persistentvolumeclaim; do
  printf '%s: %s\n' "$word" "$(git grep -i -w -F -l "$word" -- "${entry[@]}" | wc -l)"
done
echo "== the same entry points naming the Kubernetes delivery, the lab or the webhook (files)"
for needle in scripts/managed-runner pod-admission-webhook managed-runner-lab; do
  printf '%s: %s\n' "$needle" "$(git grep -F -l "$needle" -- "${entry[@]}" | wc -l)"
done
echo "== deployment_boundary_test.py and new_deployment_test.py"
python3 -m unittest -v scripts/managed-runner/deployment_boundary_test.py scripts/managed-runner/new_deployment_test.py 2>&1 | tail -25
