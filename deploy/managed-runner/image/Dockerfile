# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Optional image only. Build from the repository root with an explicit source SHA.
FROM golang:1.27.1-trixie@sha256:3b77fc618ec235a1ab412de7737f120dd507c57e8d87de4cbb7994fb94275ed5 AS orbit-build
ARG ORBIT_SOURCE_SHA
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src/runner-go
COPY src/runner-go/ ./
RUN test "$(go env GOVERSION)" = go1.27.1 \
 && printf '%s\n' "$ORBIT_SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' \
 && go build -buildvcs=false -trimpath \
      -ldflags="-s -w -X main.sourceSHA=$ORBIT_SOURCE_SHA -X main.version=managed-$ORBIT_SOURCE_SHA" \
      -o /out/orbit .

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS codex
# Preserve the whole native layout, including codex-path/rg and package resources.
# Invoke its native binary directly so there is no npm wrapper in the signal path.
RUN test "$(node --version)" = v26.10.0 \
 && npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.158.0 \
 && mv /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*-unknown-linux-musl /opt/codex \
 && test -x /opt/codex/bin/codex \
 && test -x /opt/codex/codex-path/rg

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
ARG ORBIT_SOURCE_SHA
LABEL org.opencontainers.image.title="Orbit optional managed runner" \
      org.opencontainers.image.revision="$ORBIT_SOURCE_SHA"
# Bootstrap HTTPS trust from Node's bundled public roots before installing Debian's
# ca-certificates. Snapshot expiry is disabled; apt signature checks remain enabled.
RUN mkdir -p /etc/ssl/certs \
 && node -p "require('tls').rootCertificates.join('\n')" > /etc/ssl/certs/ca-certificates.crt \
 && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260928T000000Z/ trixie main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260928T000000Z/ trixie-security main' \
      > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install --no-install-recommends -y \
      bash ca-certificates curl git openssh-client ripgrep sqlite3 python3 procps tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 orbit \
 && useradd --uid 10001 --gid 10001 --home-dir /var/lib/orbit/home --no-create-home --shell /bin/bash orbit \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/orbit /var/lib/orbit/home

COPY --from=orbit-build /usr/local/go/ /usr/local/go/
COPY --from=orbit-build --chmod=0755 /out/orbit /usr/local/bin/orbit
COPY --from=codex /opt/codex/ /opt/codex/
COPY --chmod=0755 deploy/managed-runner/image/entrypoint.py /usr/local/bin/orbit-container
COPY --chmod=0644 deploy/managed-runner/image/pins.json /usr/local/share/orbit/pins.json
ENV PATH="/usr/local/go/bin:${PATH}" \
    HOME=/var/lib/orbit/home \
    ORBIT_HOME=/var/lib/orbit/home/.orbit \
    CODEX_HOME=/var/lib/orbit/home/.codex \
    CLAUDE_CONFIG_DIR=/var/lib/orbit/home/.claude \
    ORBIT_NO_SELFUPDATE=1 \
    ORBIT_NO_ENGINE_UPDATE=1 \
    GOTOOLCHAIN=local \
    PYTHONDONTWRITEBYTECODE=1
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex \
 && chown -R root:root /opt/codex /usr/local/go /usr/local/share/orbit \
 && chmod -R go-w /opt/codex /usr/local/go /usr/local/share/orbit
# Record actual build-time versions without a login, registration or model call.
RUN <<'SH'
set -eu
python3 - <<'PY'
import json
import os
import platform
import subprocess
from pathlib import Path

pins = json.loads(Path('/usr/local/share/orbit/pins.json').read_text())
env = dict(os.environ, HOME='/tmp/orbit-version-check',
           ORBIT_HOME='/tmp/orbit-version-check/.orbit',
           CODEX_HOME='/tmp/orbit-version-check/.codex')
def version(*argv):
    return subprocess.check_output(argv, env=env, text=True).strip()

actual = {
    'go': version('go', 'env', 'GOVERSION'),
    'node': version('node', '--version'),
    'codex': version('codex', '--version'),
    'codexRipgrep': version('/opt/codex/codex-path/rg', '--version'),
    'git': version('git', '--version'),
    'python': version('python3', '--version'),
    'ripgrep': version('rg', '--version'),
    'sqlite': version('sqlite3', '--version'),
    'tini': version('/usr/bin/tini', '--version'),
}
for tool, expected in {'go': 'go1.27.1', 'node': 'v26.10.0', 'codex': 'codex-cli 0.158.0'}.items():
    if actual[tool] != expected:
        raise SystemExit(f'{tool}: expected {expected}, got {actual[tool]}')
orbit = json.loads(version('orbit', 'capabilities', '--json'))
if orbit['sourceSha'] != os.environ['ORBIT_SOURCE_SHA']:
    raise SystemExit('Orbit source SHA did not reach the binary')
packages = version('dpkg-query', '-W', '-f=${binary:Package}\t${Version}\n')
manifest = {'schemaVersion': 1, 'sourceSha': orbit['sourceSha'],
            'orbitVersion': orbit['cliVersion'], 'architecture': platform.machine(),
            'pins': pins, 'actualVersions': actual,
            'debianPackages': dict(line.split('\t', 1) for line in packages.splitlines())}
Path('/usr/local/share/orbit/tool-versions.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
rm -rf /tmp/orbit-version-check
SH

WORKDIR /var/lib/orbit
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orbit-container"]
CMD ["run"]
