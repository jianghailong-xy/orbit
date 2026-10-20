#!/bin/bash
# Inside the D10 test host: a managed runner image that differs from the installed one only in the runner binary
# (/work/bin/orbit-<variant>, binaries.sh), and the deployment switched to it the way /upgrade switches an image: its ID
# written into channel.json and profile.json (a copy with the original's mode and owner, then a rename), the apiserver
# recreated, then the channel. A runner moves to it with its next container: d10.py's `cycle` puts each to sleep and
# wakes it.
#   image.sh <variant> <installed image id>
set -euo pipefail
VARIANT="$1"; BASE="$2"
cd /work/orbit
ctx="$(mktemp -d)"
cp "/work/bin/orbit-$VARIANT" "$ctx/orbit"
# BuildKit resolves a FROM by name, never by a bare ID: name the installed image locally.
docker tag "$BASE" orbit-managed-runner:d10-installed
printf 'FROM orbit-managed-runner:d10-installed\nCOPY --chmod=0755 orbit /usr/local/bin/orbit\nLABEL orbit.test.d10.variant=%s\n' "$VARIANT" >"$ctx/Dockerfile"
docker build -q --provenance=false -t "orbit-managed-runner:d10-$VARIANT" "$ctx" >/dev/null
rm -rf "$ctx"
ID="$(docker image inspect -f '{{.Id}}' "orbit-managed-runner:d10-$VARIANT")"
python3 - "$ID" <<'PY'
import json, os, sys
image = sys.argv[1]
for path, keys in (("data/managed-runners/channel.json", ("image",)), ("data/managed-runners/profile.json", ("runner", "image"))):
    info = os.stat(path)
    value = json.load(open(path))
    node = value
    for key in keys[:-1]:
        node = node[key]
    node[keys[-1]] = image
    temporary = path + ".d10"
    with open(temporary, "w") as out:
        out.write(json.dumps(value, indent=2) + "\n")
    os.chmod(temporary, info.st_mode & 0o7777)
    os.chown(temporary, info.st_uid, info.st_gid)
    os.replace(temporary, path)
PY
docker compose up -d --no-deps --force-recreate apiserver >/dev/null 2>&1
docker compose up -d --no-deps --force-recreate docker-channel >/dev/null 2>&1
echo "variant $VARIANT: image $ID; channel.json $(grep -c "$ID" data/managed-runners/channel.json), profile.json $(grep -c "$ID" data/managed-runners/profile.json); runner binary $(docker run --rm --entrypoint /usr/local/bin/orbit "$ID" capabilities --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sourceSha"))')"
