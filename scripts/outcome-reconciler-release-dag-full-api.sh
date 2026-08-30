#!/usr/bin/env bash
# Full API DAG adapter. The inventory is exhaustive; four disjoint parallel shards plus one
# explicitly serialized hazard partition execute every compiled spec exactly once.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
ACTION="${1:-}"
: "${OUTCOME_RELEASE_DAG_RUN_ROOT:?}"
: "${OUTCOME_RELEASE_DAG_BINDING_DIGEST:?}"
CASE_ROOT="$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-cases"
mkdir -p "$CASE_ROOT" "$REPO/build"

assert_contexts() {
  outcome_release_dag_assert_build
  : "${OUTCOME_RELEASE_DAG_PG_CONTAINER:?}"
  : "${OUTCOME_RELEASE_DAG_PG_ADMIN:?}"
  : "${OUTCOME_RELEASE_DAG_PG_PASSWORD:?}"
  : "${OUTCOME_RELEASE_DAG_PG_HOST:?}"
  : "${OUTCOME_RELEASE_DAG_PG_PORT:?}"
  : "${OUTCOME_RELEASE_DAG_PG_SYSTEM_ID:?}"
  : "${OUTCOME_RELEASE_DAG_PG_TEMPLATE:?}"
}

run_partition() {
  local inventory="$1"
  local class="$2"
  local index="$3"
  local count="$4"
  local label tap manifest
  if [ "$class" = serial ]; then
    label='serial'
  else
    label="shard-$index"
  fi
  tap="$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-$label.tap"
  manifest="$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-$label.json"

  mapfile -d '' -t selected < <(node -e '
    const fs=require("fs");
    const path=require("path");
    const [inventoryPath,kind,indexText,countText,repo]=process.argv.slice(1);
    const value=JSON.parse(fs.readFileSync(inventoryPath,"utf8"));
    const index=Number(indexText), count=Number(countText);
    for (const spec of value.specs) {
      const selected=kind==="serial" ? spec.class==="serial"
        : spec.class==="parallel" && ((spec.index-1)%count)===index;
      if (selected) process.stdout.write(String(spec.index)+"\0"+path.join(repo,spec.path)+"\0");
    }
  ' "$inventory" "$class" "$index" "$count" "$REPO")
  [ "${#selected[@]}" -gt 0 ] && [ $(( ${#selected[@]} % 2 )) -eq 0 ] || {
    echo "Full API $label selected no complete cases" >&2
    exit 2
  }

  export OUTCOME_API_CASE_CONTAINER="$OUTCOME_RELEASE_DAG_PG_CONTAINER"
  export OUTCOME_API_CASE_ADMIN="$OUTCOME_RELEASE_DAG_PG_ADMIN"
  export OUTCOME_API_CASE_PASSWORD="$OUTCOME_RELEASE_DAG_PG_PASSWORD"
  export OUTCOME_API_CASE_HOST="$OUTCOME_RELEASE_DAG_PG_HOST"
  export OUTCOME_API_CASE_PORT="$OUTCOME_RELEASE_DAG_PG_PORT"
  export OUTCOME_API_CASE_SYSTEM_ID="$OUTCOME_RELEASE_DAG_PG_SYSTEM_ID"
  export OUTCOME_API_CASE_TEMPLATE="$OUTCOME_RELEASE_DAG_PG_TEMPLATE"
  export OUTCOME_API_CASE_PREFIX="ord_${OUTCOME_RELEASE_DAG_BINDING_DIGEST:0:8}"
  export OUTCOME_API_CASE_REPO="$REPO"
  export OUTCOME_API_CASE_API="$API"
  export OUTCOME_API_CASE_DIR="$CASE_ROOT"
  export OUTCOME_API_CASE_TOTAL
  OUTCOME_API_CASE_TOTAL="$(node -e 'const v=require(process.argv[1]);process.stdout.write(String(v.totalSpecs))' "$inventory")"

  local offset case_index spec
  for ((offset = 0; offset < ${#selected[@]}; offset += 2)); do
    case_index="${selected[$offset]}"
    spec="${selected[$((offset + 1))]}"
    "$REPO/scripts/outcome-reconciler-full-api-case.sh" "$case_index" "$spec"
  done
  node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" full-api-partition \
    "$inventory" "$class" "$index" "$count" "$tap" "$manifest"
}

case "$ACTION" in
  inventory)
    assert_contexts
    OUTPUT="${2:?inventory output is required}"
    node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" full-api-inventory "$OUTPUT"
    ;;
  shard)
    assert_contexts
    INDEX="${2:?shard index is required}"
    COUNT="${3:?shard count is required}"
    INVENTORY="${4:?inventory is required}"
    run_partition "$INVENTORY" parallel "$INDEX" "$COUNT"
    ;;
  serial)
    assert_contexts
    INVENTORY="${2:?inventory is required}"
    run_partition "$INVENTORY" serial 0 1
    ;;
  aggregate)
    assert_contexts
    INVENTORY="${2:?inventory is required}"
    TAP="$REPO/build/outcome-reconciler-full-api.tap"
    MANIFEST="$REPO/build/outcome-reconciler-full-api-manifest.json"
    node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" full-api-combine \
      "$INVENTORY" "$TAP" \
      "$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-shard-0.json" \
      "$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-shard-1.json" \
      "$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-shard-2.json" \
      "$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-shard-3.json" \
      "$OUTCOME_RELEASE_DAG_RUN_ROOT/full-api-serial.json"
    OUTCOME_FULL_API_STARTED_AT="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.generatedAt||new Date().toISOString())' "$OUTCOME_RELEASE_DAG_BUILD_CONTEXT")" \
    OUTCOME_FULL_API_PG_VERSION="$OUTCOME_RELEASE_DAG_PG_VERSION" \
    OUTCOME_FULL_API_MIGRATIONS="$OUTCOME_RELEASE_DAG_PG_MIGRATIONS" \
    OUTCOME_FULL_API_SYSTEM_IDENTIFIER="$OUTCOME_RELEASE_DAG_PG_SYSTEM_ID" \
      node "$REPO/scripts/outcome-reconciler-full-api-manifest.mjs" "$TAP" "$MANIFEST"
    ;;
  *)
    echo 'usage: release-dag-full-api.sh inventory OUTPUT | shard INDEX COUNT INVENTORY | serial INVENTORY | aggregate INVENTORY' >&2
    exit 2
    ;;
esac
