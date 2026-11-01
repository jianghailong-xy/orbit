#!/usr/bin/env bash
# Re-runs the checks behind docs/evidence/wiki-model-thinking/ and writes each one's output there as a .txt file.
#
#   bash docs/evidence/wiki-model-thinking/run.sh
#
# Needs Docker (scripts/run-pg-spec.sh starts a throwaway PostgreSQL; `docker compose config` renders Compose). Calls no
# real model and needs no key: every model here is a stub on 127.0.0.1. It writes only the .txt files named below, in
# the evidence directory, and src/apiserver/build, which run-pg-spec.sh and `npm test` rebuild anyway. body-before.txt
# is not rewritten: it was captured once from the build of the commit before the switch (README.md).
set -uo pipefail
# A grep function inherited from an interactive shell (a wrapper around another tool) is not the grep this reads with.
unset -f grep 2>/dev/null || true

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
E="$ROOT/docs/evidence/wiki-model-thinking"
[ -f "$E/README.md" ] || { echo "refusing: $E/README.md is missing" >&2; exit 2; }
cd "$ROOT" || exit 2

strip() { sed 's/\x1b\[[0-9;]*m//g'; }
tree() {
  local dirty=''
  git diff --quiet HEAD -- . ':(exclude)docs/evidence/wiki-model-thinking' || dirty=' with uncommitted changes'
  echo "$(git rev-parse HEAD)${dirty}"
}
header() { printf '# %s\n# Run %s on %s.\n\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(tree)"; }
declare -a RESULTS=()
note() { RESULTS+=("$1 exit=$2"); }

bash scripts/worktree-overlay.sh > /dev/null 2>&1
note 'worktree-overlay' $?

# 1. The contract spec, which holds the shared constants to contracts/wiki.contract.json; then the whole shared suite.
{
  header 'src/shared/src/wikiContract.spec.ts (vitest, verbose)'
  (cd src/shared && npx vitest run src/wikiContract.spec.ts --reporter=verbose 2>&1 | strip; exit "${PIPESTATUS[0]}")
  code=$?; echo; echo "exit=$code"
  echo; echo '## The whole shared suite'
  (cd src/shared && npx vitest run 2>&1 | strip | grep -E '^ +(Test Files|Tests) '; exit "${PIPESTATUS[0]}")
  code2=$?; echo "exit=$code2"
} > "$E/shared-specs.txt" 2>&1
note 'shared wikiContract.spec.ts' "$(sed -n 's/^exit=//p' "$E/shared-specs.txt" | head -1)"
note 'shared suite' "$(sed -n 's/^exit=//p' "$E/shared-specs.txt" | tail -1)"

# 2. The whole apiserver unit suite (it compiles build/), then the three specs this change touches, as TAP, from that build.
{
  header 'src/apiserver: npm test (every unit spec), then the touched specs as TAP'
  (cd src/apiserver && rm -rf build && npm test > /tmp/wiki-model-thinking-apiserver-unit.$$ 2>&1)
  code=$?
  echo '## npm test summary'
  grep -aE '^ℹ (tests|pass|fail|cancelled|skipped|todo) ' "/tmp/wiki-model-thinking-apiserver-unit.$$"
  grep -aE '^✖ ' "/tmp/wiki-model-thinking-apiserver-unit.$$" | head -20
  rm -f "/tmp/wiki-model-thinking-apiserver-unit.$$"
  echo "exit=$code"
  echo; echo '## wiki-system-model.spec, wiki-model-client.spec and wiki-compose-env.spec'
  (cd src/apiserver && node --test --test-reporter=tap build/wiki-worker/wiki-system-model.spec.js \
    build/wiki-worker/wiki-model-client.spec.js build/wiki/wiki-compose-env.spec.js 2>&1)
  echo "exit=$?"
} > "$E/apiserver-specs.txt" 2>&1
note 'apiserver unit suite' "$(sed -n 's/^exit=//p' "$E/apiserver-specs.txt" | head -1)"
note 'apiserver touched specs' "$(sed -n 's/^exit=//p' "$E/apiserver-specs.txt" | tail -1)"

# 3. The bodies the client sends now, for each value, from that build: compare their sha256 with body-before.txt.
{
  echo "# Bodies the client POSTs to {base}/v1/messages, captured at a 127.0.0.1 stub by capture-body.cjs."
  echo "# Build: src/apiserver/build of $(tree), compiled by npm test (tsc -p tsconfig.test.json)."
  echo "# Captured $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  for value in UNSET '' '  ' disabled enabled ' disabled ' Disabled off; do
    echo
    if [ "$value" = UNSET ]; then
      echo '## ORBIT_WIKI_MODEL_THINKING unset'
      node "$E/capture-body.cjs" src/apiserver/build
    else
      echo "## ORBIT_WIKI_MODEL_THINKING=\"$value\""
      node "$E/capture-body.cjs" src/apiserver/build "$value"
    fi
    echo "exit=$?"
  done
} > "$E/body-after.txt.part" 2>&1
{
  echo
  echo '## How many bodies had each sha256: in body-before.txt (the commit before the switch), and above'
  echo 'before:'; grep -a '^sha256' "$E/body-before.txt" | sort | uniq -c
  echo 'after:'; grep -a '^sha256' "$E/body-after.txt.part" | sort | uniq -c
} >> "$E/body-after.txt.part"
mv "$E/body-after.txt.part" "$E/body-after.txt"
note 'body capture' "$(grep -ac '^exit=0$' "$E/body-after.txt")/8 calls answered"

# 4. The request queue against a real PostgreSQL, with the System model a stub: case 8 is the thinking switch end to end.
{
  header 'bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-model-queue.pg.spec.ts'
  bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-model-queue.pg.spec.ts 2>&1
  echo "exit=$?"
} > "$E/pg-wiki-model-queue.txt" 2>&1
note 'queue pg spec' "$(sed -n 's/^exit=//p' "$E/pg-wiki-model-queue.txt" | tail -1)"

# 5. Compose: the topology suites, the file renders, and what the wiki-worker (and no other service) is given.
{
  header 'node --test --test-reporter=tap test/compose-topology.test.mjs test/compose-topology-rejections.test.mjs'
  node --test --test-reporter=tap test/compose-topology.test.mjs test/compose-topology-rejections.test.mjs 2>&1
  echo "exit=$?"
  echo; echo '## JWT_SECRET=x PROVIDER_SECRET_KEY=x docker compose config --quiet'
  JWT_SECRET=x PROVIDER_SECRET_KEY=x docker compose config --quiet 2>&1
  echo "exit=$?"
  for value in UNSET disabled; do
    echo; echo "## Rendered with ORBIT_WIKI_MODEL_THINKING $([ "$value" = UNSET ] && echo unset || echo "=$value"): the System model's variables of each service"
    if [ "$value" = UNSET ]; then
      env -u ORBIT_WIKI_MODEL_THINKING JWT_SECRET=x PROVIDER_SECRET_KEY=x docker compose config --format json
    else
      ORBIT_WIKI_MODEL_THINKING="$value" JWT_SECRET=x PROVIDER_SECRET_KEY=x docker compose config --format json
    fi | node -e '
      let text = "";
      process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => {
        const services = JSON.parse(text).services;
        for (const name of Object.keys(services).sort()) {
          const given = Object.entries(services[name].environment ?? {}).filter(([key]) => key.startsWith("ORBIT_WIKI_MODEL"))
            .map(([key, value]) => `${key}=${JSON.stringify(key.includes("KEY") ? "<redacted>" : value)}`);
          console.log(`${name}: ${given.length ? given.join(" ") : "none"}`);
        }
      });'
  done
} > "$E/compose-topology.txt" 2>&1
note 'compose topology suites' "$(sed -n 's/^exit=//p' "$E/compose-topology.txt" | head -1)"
note 'docker compose config --quiet' "$(sed -n 's/^exit=//p' "$E/compose-topology.txt" | tail -1)"

# 6. The public guides this change edits, and the copy guard (every product string English).
{
  header 'npm run docs:check, and the web copy-language guard'
  npm run docs:check 2>&1 | tail -3
  echo "exit=${PIPESTATUS[0]}"
  echo; echo '## src/web/src/copyLanguage.test.ts'
  (cd src/web && npx vitest run src/copyLanguage.test.ts 2>&1 | strip | grep -E '^ +(Test Files|Tests) |✓|×'; exit "${PIPESTATUS[0]}")
  echo "exit=$?"
} > "$E/docs-and-copy.txt" 2>&1
note 'docs:check' "$(sed -n 's/^exit=//p' "$E/docs-and-copy.txt" | head -1)"
note 'web copyLanguage.test.ts' "$(sed -n 's/^exit=//p' "$E/docs-and-copy.txt" | tail -1)"

printf '%s\n' "${RESULTS[@]}"
