# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Optional image only. Build from the repository root with an explicit source SHA.
# ORBIT_RELEASE_VERSION, the release tag without its "v" (0.1.261-beta.83), is what a release's image is built with
# (deploy/two-stage/publish-managed-runner.sh, from the tag's commit): its runner reports that version, as every other
# runner of the release does. Without it, as a single host builds orbit-managed-runner:local from its checkout, the
# runner reports managed-<source sha>.
FROM golang:1.27.1-trixie@sha256:3b77fc618ec235a1ab412de7737f120dd507c57e8d87de4cbb7994fb94275ed5 AS orbit-build
ARG ORBIT_SOURCE_SHA
ARG ORBIT_RELEASE_VERSION=
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src/runner-go
COPY src/runner-go/ ./
RUN test "$(go env GOVERSION)" = go1.27.1 \
 && printf '%s\n' "$ORBIT_SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' \
 && { [ -z "$ORBIT_RELEASE_VERSION" ] || printf '%s\n' "$ORBIT_RELEASE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; } \
 && go build -buildvcs=false -trimpath \
      -ldflags="-s -w -X main.sourceSHA=$ORBIT_SOURCE_SHA -X main.version=${ORBIT_RELEASE_VERSION:-managed-$ORBIT_SOURCE_SHA}" \
      -o /out/orbit .

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS codex
# Preserve the whole native layout, including codex-path/rg and package resources.
# Invoke its native binary directly so there is no npm wrapper in the signal path.
RUN test "$(node --version)" = v26.10.0 \
 && npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.172.0 \
 && mv /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*-unknown-linux-musl /opt/codex \
 && test -x /opt/codex/bin/codex \
 && test -x /opt/codex/codex-path/rg

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS claude
# The engine an Anthropic-dialect key (DeepSeek's included) runs on. The wrapper package's
# postinstall only copies its platform package's native binary over a stub: take that binary
# directly, so no Node wrapper sits in the signal path either.
RUN test "$(node --version)" = v26.10.0 \
 && npm install --global --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-code@2.1.332 \
 && install -D -m 0755 \
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-$(node -p process.arch)/claude" \
      /opt/claude/bin/claude

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS opencode
# The platform package's native binary, as for Codex. On x64 the baseline build, which needs no AVX2:
# the image runs on whatever host a channel schedules it on.
ARG TARGETARCH
RUN test "$(node --version)" = v26.10.0 \
 && case "$TARGETARCH" in amd64) package=opencode-linux-x64-baseline ;; arm64) package=opencode-linux-arm64 ;; *) exit 1 ;; esac \
 && npm install --prefix /tmp/opencode --ignore-scripts --no-audit --no-fund "$package@1.19.6" \
 && install -D -m 0755 "/tmp/opencode/node_modules/$package/bin/opencode" /opt/opencode/bin/opencode

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS dsh
# DeepSeek Harness exactly as the runner installs it (src/runner-go/dsh_install.go): `npm ci` from the
# runner's own frozen lock into the version directory the runner looks in, under ORBIT_ENGINE_STORE.
# The runner admits Harness on Linux x64 only, so an arm64 image ships an empty store.
ARG TARGETARCH
COPY src/runner-go/dsh-install/package.json src/runner-go/dsh-install/package-lock.json /tmp/dsh/
RUN install -d /opt/orbit-engines/engines/dsh \
 && if [ "$TARGETARCH" = amd64 ]; then \
      cd /tmp/dsh \
      && HOME=/tmp/dsh-home DSH_TELEMETRY_DISABLED=1 npm ci --prefix /tmp/dsh --cache /tmp/dsh-cache --no-audit --no-fund \
      && mv /tmp/dsh /opt/orbit-engines/engines/dsh/0.2.0-rc.2; \
    fi \
 && chown -R root:root /opt/orbit-engines && chmod -R go-w /opt/orbit-engines

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS playwright-mcp
# The browser tool server, with its exact playwright and playwright-core pins nested under it. No browser download
# (--ignore-scripts): it drives the image's Debian Chromium. Its cli.js is run by node directly, with no npm wrapper.
RUN test "$(node --version)" = v26.10.0 \
 && npm install --global --ignore-scripts --no-audit --no-fund @playwright/mcp@0.0.85 \
 && mv /usr/local/lib/node_modules/@playwright/mcp /opt/playwright-mcp \
 && test -x /opt/playwright-mcp/cli.js

FROM golang:1.27.1-trixie@sha256:3b77fc618ec235a1ab412de7737f120dd507c57e8d87de4cbb7994fb94275ed5 AS downloads
# Native builds fetched by URL, each checked against the digest its publisher's manifest gives for the pinned
# version (pins.json names the manifests). One RUN per engine, so a new pin refetches only its own engine.
ARG TARGETARCH
# How each of them is fetched. A download that stops moving is ended and started again: below 4 KB/s for a minute
# is a stall, and a stall is retried, five times. There is no total time limit, so a slow download that is still
# moving finishes. Without these, curl waits on a dead connection forever: on 2026-11-19 the release build sat 18
# minutes at 81.7 MB of the Kimi binary until it was killed by hand.
ARG FETCH="curl -fsSL --connect-timeout 30 --speed-limit 4096 --speed-time 60 --retry 5 --retry-delay 10 --retry-all-errors"
RUN case "$TARGETARCH" in \
      amd64) target=linux-x64 sum=a8855467385e823209e1f45014f3fa9ade81260b648bcba33fbe461963dae9e2 ;; \
      arm64) target=linux-arm64 sum=ee6d96407dd17c4123ae3bf1d2d021be26dce7c358cd81771b6cad2d740dc323 ;; \
      *) exit 1 ;; esac \
 && $FETCH -o /tmp/kimi "https://code.kimi.com/kimi-code/binaries/2.8.0/kimi-code-$target" \
 && echo "$sum  /tmp/kimi" | sha256sum -c - \
 && install -D -m 0755 /tmp/kimi /opt/kimi-code/bin/kimi \
 && rm /tmp/kimi
RUN case "$TARGETARCH" in \
      amd64) path=linux-x64/cli_linux_x64.tar.gz sum=71a967aa16e0ab5d87196bcd6772130bdab55b2fd768cd24d21b1da401ff9f60280b976cad3dc14a2d646233b0eaf8caf87c490eed73044d54550cbb3d8d67d2 ;; \
      arm64) path=linux-arm/cli_linux_arm64.tar.gz sum=e4f086d0730b325cfd438ea90396ee78eb23a3110ef7f792824c8817b8d0432462b7b5f91b3d933fc1932a6f4ba73de505e2e96f44448c9fb2427292ead716f7 ;; \
      *) exit 1 ;; esac \
 && $FETCH -o /tmp/agy.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.17-4823843970351104/$path" \
 && echo "$sum  /tmp/agy.tar.gz" | sha512sum -c - \
 && mkdir /tmp/agy && tar -xzf /tmp/agy.tar.gz -C /tmp/agy --no-same-owner \
 && install -D -m 0755 /tmp/agy/antigravity /opt/agy/bin/agy \
 && rm -r /tmp/agy /tmp/agy.tar.gz
# Cursor CLI: the build and SHA-256 the runner pins (cursorSupportedVersion and cursorArtifacts in
# src/runner-go/cursor_install.go), unpacked as the runner unpacks it into the version directory it looks in.
# Measured on Linux x64 only, so an arm64 image ships an empty store, as the runner would install nothing there.
RUN install -d /opt/orbit-engines/cursor/versions \
 && if [ "$TARGETARCH" = amd64 ]; then \
      $FETCH -o /tmp/cursor.tar.gz https://downloads.cursor.com/lab/2026.10.14-941492e/linux/x64/agent-cli-package.tar.gz \
      && echo "6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d  /tmp/cursor.tar.gz" | sha256sum -c - \
      && test "$(stat -c %s /tmp/cursor.tar.gz)" = 183861376 \
      && mkdir /tmp/cursor && tar -xzf /tmp/cursor.tar.gz -C /tmp/cursor --no-same-owner \
      && mv /tmp/cursor/dist-package /opt/orbit-engines/cursor/versions/2026.10.14-941492e \
      && rm -r /tmp/cursor /tmp/cursor.tar.gz; \
    fi \
 && chown -R root:root /opt/orbit-engines && chmod -R go-w /opt/orbit-engines

FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
# Bootstrap HTTPS trust from Node's bundled public roots before installing Debian's
# ca-certificates. Snapshot expiry is disabled; apt signature checks remain enabled.
# apt 3 verifies HTTPS with OpenSSL, whose default CA file (/usr/lib/ssl/cert.pem) does not
# exist in the slim image until the openssl package arrives: name the bootstrap bundle.
RUN mkdir -p /etc/ssl/certs \
 && node -p "require('tls').rootCertificates.join('\n')" > /etc/ssl/certs/ca-certificates.crt \
 && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260928T000000Z/ trixie main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260928T000000Z/ trixie-security main' \
      > /etc/apt/sources.list \
 && apt-get -o Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt update \
 && apt-get -o Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt install --no-install-recommends -y \
      bash ca-certificates curl duperemove git openssh-client ripgrep sqlite3 python3 procps tini \
 && apt-get install --no-install-recommends -y \
      chromium=154.0.8037.57-1~deb13u1 chromium-common=154.0.8037.57-1~deb13u1 \
      xvfb=2:21.1.16-1.3+deb13u4 x11vnc=0.9.17-1 \
      xclip=0.13-4 xdotool=1:3.20160805.1-5.1 \
      fonts-noto-cjk=1:20240730+repack1-1 fonts-noto-color-emoji=2.051-0+deb13u1 \
      fonts-noto-core=20201225-2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 orbit \
 && useradd --uid 10001 --gid 10001 --home-dir /home/orbit --no-create-home --shell /bin/bash orbit \
 && install -d -o 10001 -g 10001 -m 0700 /home/orbit

COPY --from=orbit-build /usr/local/go/ /usr/local/go/
COPY --from=codex /opt/codex/ /opt/codex/
COPY --from=claude /opt/claude/ /opt/claude/
COPY --from=opencode /opt/opencode/ /opt/opencode/
COPY --from=playwright-mcp /opt/playwright-mcp/ /opt/playwright-mcp/
COPY --from=downloads /opt/kimi-code/ /opt/kimi-code/
COPY --from=downloads /opt/agy/ /opt/agy/
COPY --from=downloads /opt/orbit-engines/ /opt/orbit-engines/
COPY --from=dsh /opt/orbit-engines/engines/ /opt/orbit-engines/engines/
COPY --chmod=0644 deploy/managed-runner/image/pins.json /usr/local/share/orbit/pins.json
COPY --chmod=0644 deploy/managed-runner/image/orbit-browser-opener.sh /etc/profile.d/orbit-browser-opener.sh
ENV PATH="/usr/local/go/bin:${PATH}" \
    HOME=/home/orbit \
    ORBIT_HOME=/home/orbit/.orbit \
    CODEX_HOME=/home/orbit/.codex \
    CLAUDE_CONFIG_DIR=/home/orbit/.claude \
    ORBIT_ENGINE_STORE=/opt/orbit-engines \
    ORBIT_NO_SELFUPDATE=1 \
    ORBIT_NO_ENGINE_UPDATE=1 \
    DISABLE_AUTOUPDATER=1 \
    GOTOOLCHAIN=local \
    PYTHONDONTWRITEBYTECODE=1
# COPY --chmod=0644 gives the directory it creates that mode too: make it traversable again.
# /opt/orbit-engines (Cursor CLI's ~590 MB and Harness's node_modules) is made root-owned and read-only in the
# stages that build it: a chown here would copy every file of it into another layer.
# The runner's commits (the autoInitGit baseline, finalize, checkpoints) need an identity, and
# a fresh volume has none: give a neutral one at system level, the lowest precedence, so an
# identity in the repository, the user's global config or the environment still wins.
# Chromium's browser sign-in (BrowserSignin) is off: Debian's build cannot complete it ("Missing authorization code
# due to OAuth outage in Dice"), and while it is on, Google signs out the web login at the browser's next start.
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex \
 && ln -s /opt/claude/bin/claude /usr/local/bin/claude \
 && ln -s /opt/opencode/bin/opencode /usr/local/bin/opencode \
 && ln -s /opt/kimi-code/bin/kimi /usr/local/bin/kimi \
 && ln -s /opt/agy/bin/agy /usr/local/bin/agy \
 && ln -s /opt/playwright-mcp/cli.js /usr/local/bin/playwright-mcp \
 && chown -R root:root /opt/codex /opt/claude /opt/opencode /opt/kimi-code /opt/agy /opt/playwright-mcp /usr/local/go /usr/local/share/orbit \
 && chmod -R go-w /opt/codex /opt/claude /opt/opencode /opt/kimi-code /opt/agy /opt/playwright-mcp /usr/local/go /usr/local/share/orbit \
 && chmod 0755 /usr/local/share/orbit \
 && git config --system user.name 'Orbit Runner' \
 && git config --system user.email runner@orbit.invalid \
 && install -d -m 0755 /etc/chromium/policies/managed \
 && printf '{"BrowserSignin": 0}\n' > /etc/chromium/policies/managed/orbit.json \
 && chmod 0644 /etc/chromium/policies/managed/orbit.json
# An image before a944a7f362 kept home at /var/lib/orbit/home. The entrypoint moves such a volume's home to /home/orbit
# (move_earlier_home); this link keeps the paths that home recorded inside itself (git worktree links, the runner's
# session state) resolving there.
RUN install -d -o root -g root -m 0755 /var/lib/orbit && ln -s /home/orbit /var/lib/orbit/home
# What changes with every source commit comes after the slow steps above, so a new commit reuses
# them and rebuilds only the runner binary, the entrypoint and the version record. A build argument
# reaches every RUN after its ARG, so the source SHA must not be declared any earlier.
COPY --from=orbit-build --chmod=0755 /out/orbit /usr/local/bin/orbit
COPY --chmod=0755 deploy/managed-runner/image/entrypoint.py /usr/local/bin/orbit-container
ARG ORBIT_SOURCE_SHA
ARG ORBIT_RELEASE_VERSION=
# The version label is empty on an image built without a release version, which the Docker channel reports as none.
LABEL org.opencontainers.image.title="Orbit optional managed runner" \
      org.opencontainers.image.revision="$ORBIT_SOURCE_SHA" \
      org.opencontainers.image.version="$ORBIT_RELEASE_VERSION"
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
           CODEX_HOME='/tmp/orbit-version-check/.codex',
           CLAUDE_CONFIG_DIR='/tmp/orbit-version-check/.claude')
def version(*argv):
    return subprocess.check_output(argv, env=env, text=True).strip()
def first_line(*argv):  # x11vnc prints its version on stderr
    out = subprocess.run(argv, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT).stdout.split('\n')
    return next(line.strip() for line in out if line.strip())
def package(name, binary=None):  # Xvfb has no version option: its package's version, once its binary is there
    if binary and not os.access(binary, os.X_OK):
        raise SystemExit(f'{name}: {binary} is missing')
    return version('dpkg-query', '-W', '-f=${Version}', name)

actual = {
    'go': version('go', 'env', 'GOVERSION'),
    'node': version('node', '--version'),
    'codex': version('codex', '--version'),
    'codexRipgrep': version('/opt/codex/codex-path/rg', '--version'),
    'claude': version('claude', '--version'),
    'git': version('git', '--version'),
    'python': version('python3', '--version'),
    'ripgrep': version('rg', '--version'),
    'sqlite': version('sqlite3', '--version'),
    'tini': version('/usr/bin/tini', '--version'),
    # The runner shares duplicate files on its volume with it while idle (src/runner-go/managed_dedupe.go).
    'duperemove': package('duperemove', '/usr/bin/duperemove'),
    'opencode': version('opencode', '--version'),
    'kimi': version('kimi', '--version'),
    'agy': version('agy', '--version'),
    # The browser stack (docs/runner-browser-design.md §3). Nothing here starts at boot.
    'chromium': version('chromium', '--version'),
    'xvfb': package('xvfb', '/usr/bin/Xvfb'),
    'x11vnc': first_line('x11vnc', '-version'),
    'xclip': package('xclip', '/usr/bin/xclip'),
    'xdotool': package('xdotool', '/usr/bin/xdotool'),
    'fontsNotoCjk': package('fonts-noto-cjk'),
    'fontsNotoColorEmoji': package('fonts-noto-color-emoji'),
    'fontsNotoCore': package('fonts-noto-core'),
    'playwrightMcp': version('playwright-mcp', '--version'),
}
# Cursor CLI and DeepSeek Harness are where the runner looks for them (ORBIT_ENGINE_STORE), on Linux x64 only.
store = Path(os.environ['ORBIT_ENGINE_STORE'])
if platform.machine() == 'x86_64':
    actual['cursor'] = version(str(store / 'cursor/versions/2026.10.14-941492e/cursor-agent'), '--version')
    actual['dsh'] = version(str(store / 'engines/dsh/0.2.0-rc.2/node_modules/.bin/dsh'), '--version')
expected_versions = {'go': 'go1.27.1', 'node': 'v26.10.0', 'codex': 'codex-cli 0.172.0',
                     'claude': '2.1.332 (Claude Code)', 'opencode': '1.19.6', 'kimi': '2.8.0', 'agy': '1.5.17'}
expected_versions.update(chromium='Chromium 154.0.8037.57 built on Debian GNU/Linux 13 (trixie)',
                         xvfb='2:21.1.16-1.3+deb13u4', x11vnc='x11vnc: 0.9.17 lastmod: 2025-04-11',
                         xclip='0.13-4', xdotool='1:3.20160805.1-5.1',
                         fontsNotoCjk='1:20240730+repack1-1', fontsNotoColorEmoji='2.051-0+deb13u1',
                         fontsNotoCore='20201225-2',
                         playwrightMcp='Version 0.0.85')
if platform.machine() == 'x86_64':
    expected_versions.update(cursor='2026.10.14-941492e', dsh='0.2.0-rc.2')
for tool, expected in expected_versions.items():
    if actual[tool] != expected:
        raise SystemExit(f'{tool}: expected {expected}, got {actual[tool]}')
if json.loads(Path('/etc/chromium/policies/managed/orbit.json').read_text()) != {'BrowserSignin': 0}:
    raise SystemExit("Chromium's managed policy must turn browser sign-in off")
orbit = json.loads(version('orbit', 'capabilities', '--json'))
if orbit['sourceSha'] != os.environ['ORBIT_SOURCE_SHA']:
    raise SystemExit('Orbit source SHA did not reach the binary')
expected_cli = os.environ.get('ORBIT_RELEASE_VERSION') or 'managed-' + os.environ['ORBIT_SOURCE_SHA']
if orbit['cliVersion'] != expected_cli:
    raise SystemExit(f"Orbit version: expected {expected_cli}, got {orbit['cliVersion']}")
# The runner's autoInitGit baseline (src/runner-go/worktree.go initGitRepo) with no identity
# configured anywhere but the image, then a repository identity, which must win over it.
repo = Path('/tmp/orbit-version-check/identity')
repo.mkdir(parents=True)
git_env = {key: value for key, value in env.items()
           if not key.startswith(('GIT_AUTHOR_', 'GIT_COMMITTER_')) and key != 'EMAIL'}
git_env['GIT_CONFIG_GLOBAL'] = '/dev/null'
def git(*argv):
    return subprocess.check_output(['git', '-C', str(repo), *argv], env=git_env, text=True).strip()
git('init', '-q')
git('commit', '--no-verify', '--allow-empty', '-q', '-m', 'orbit: baseline')
actual['gitDefaultIdentity'] = git('log', '-1', '--format=%an <%ae>')
if actual['gitDefaultIdentity'] != 'Orbit Runner <runner@orbit.invalid>':
    raise SystemExit(f"baseline commit identity: {actual['gitDefaultIdentity']}")
git('config', 'user.name', 'Repository User')
git('config', 'user.email', 'repository@example.invalid')
git('commit', '--no-verify', '--allow-empty', '-q', '-m', 'repository identity')
if git('log', '-1', '--format=%an <%ae>') != 'Repository User <repository@example.invalid>':
    raise SystemExit('a repository identity must override the image default')
packages = version('dpkg-query', '-W', '-f=${binary:Package}\t${Version}\n')
manifest = {'schemaVersion': 1, 'sourceSha': orbit['sourceSha'],
            'orbitVersion': orbit['cliVersion'], 'architecture': platform.machine(),
            'pins': pins, 'actualVersions': actual,
            'debianPackages': dict(line.split('\t', 1) for line in packages.splitlines())}
Path('/usr/local/share/orbit/tool-versions.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
rm -rf /tmp/orbit-version-check
SH

WORKDIR /home/orbit
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orbit-container"]
CMD ["run"]
