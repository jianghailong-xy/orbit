#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
unset MERGE_CHECK_SUITES
checks=0

expect_plan() {
  local expected=$1 actual
  shift
  actual=$(bash scripts/merge-check.sh --plan -- "$@")
  if [[ $actual != "$expected" ]]; then
    printf 'Expected:\n%s\nGot:\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
  checks=$((checks + 1))
}

expect_plan $'  src/apiserver/src/main.ts -> apiserver\nSuites: apiserver' src/apiserver/src/main.ts
expect_plan $'  src/runner-go/integrate.go -> runner-go\nSuites: runner-go' src/runner-go/integrate.go
expect_plan $'  src/web/src/App.tsx -> web\nSuites: web' src/web/src/App.tsx
expect_plan $'  src/android/core/build.gradle.kts -> android\nSuites: android' src/android/core/build.gradle.kts
expect_plan $'  src/macos/OrbitKit/Package.swift -> orbitkit\nSuites: orbitkit' src/macos/OrbitKit/Package.swift
expect_plan $'  src/shared/src/index.ts -> shared apiserver web\n  src/web/src/App.tsx -> web\nSuites: shared apiserver web' \
  src/shared/src/index.ts src/web/src/App.tsx
expect_plan $'  docker-compose.yml -> compose\n  src/link-gateway/nats.conf -> compose\nSuites: compose' \
  docker-compose.yml src/link-gateway/nats.conf
expect_plan 'Suites: none (no code changes)' docs/example.ts README.md site/logo.svg
expect_plan $'  src/ios/Orbit.swift -> apiserver (fallback for an unmapped path)\nSuites: apiserver' \
  src/ios/Orbit.swift

printf 'Passed %d merge-check mapping cases.\n' "$checks"
