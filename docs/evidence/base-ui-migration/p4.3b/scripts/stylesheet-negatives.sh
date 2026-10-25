#!/usr/bin/env bash
# stylesheet-negatives.sh: src/firstPageStylesheet.test.ts on the delivery (try/aux-del), as delivered and with
# each half of the fix taken out in turn — A: vite.config.ts without the codeSplitting group; B: main.tsx
# without the three stylesheets imported ahead of the reset — printing each change as a diff and what vitest
# says. The tree is put back after each control.
set -u
T=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W/try/aux-del
export TMPDIR=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W/tmp
. /mnt/data/tmp/34blYpxEcHMAf4oafuC2W/scripts/memgate.sh
cd "$T/src/web"
echo "tree $(git rev-parse HEAD), $(date -u +%FT%TZ)"
run() { scoped npx vitest run src/firstPageStylesheet.test.ts --reporter=default 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v '^\s*$' | grep -vE '^ (RUN|Start at|Duration)' ; echo "vitest exit ${PIPESTATUS[0]}"; }
echo; echo "== as delivered"; run
echo; echo "== control A: vite.config.ts without the first-page stylesheet group"
python3 -I - <<'PY'
p = 'vite.config.ts'
s = open(p).read()
old = "        codeSplitting: { groups: [{ name: 'app', test: /\\.css$/, tags: ['$initial'] }] },\n"
assert s.count(old) == 1
open(p, 'w').write(s.replace(old, ''))
PY
git diff -- vite.config.ts; run; git checkout -q -- vite.config.ts
echo; echo "== control B: main.tsx without the three stylesheets ahead of the reset"
python3 -I - <<'PY'
p = 'src/main.tsx'
s = open(p).read()
old = "import './components/ui/Overlay.css';\nimport './components/ReviewCard.css';\nimport 'highlight.js/styles/github.css';\n"
assert s.count(old) == 1
open(p, 'w').write(s.replace(old, ''))
PY
git diff -- src/main.tsx; run; git checkout -q -- src/main.tsx
echo; echo "== put back"; git status --short | head -3; echo "(clean when empty)"
