#!/usr/bin/env bash
# bundle-build.sh NAME TREE: the production build of TREE/src/web (vite build, the app's own config) into
# try/bundle/NAME/dist with its chunk map (chunk-sizes.config.mjs) beside it.
set -euo pipefail
name=$1; tree=$2
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
. $V/scripts/memgate.sh
O=$V/try/bundle/$name
mkdir -p "$O"
cd "$tree/src/web"
cp "$V/scripts/chunk-sizes.config.mjs" ./chunk-sizes.config.mjs
TMPDIR=$V/tmp CHUNK_MAP=$O/chunks.json scoped nice npx vite build --config chunk-sizes.config.mjs --outDir "$O/dist" --emptyOutDir > "$O/build.log" 2>&1 || { rm -f chunk-sizes.config.mjs; tail -20 "$O/build.log"; exit 1; }
rm -f chunk-sizes.config.mjs
echo "$name: $(git -C "$tree" rev-parse --short HEAD) built ($(tail -1 "$O/build.log"))"
