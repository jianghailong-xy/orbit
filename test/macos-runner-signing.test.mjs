// A deployment with a Developer ID signs the macOS runner binaries inside the web image build
// (docs/release-process.md, "macOS runner signature"), so a Mac keeps its privacy (TCC) answers
// across runner updates. Two things are held here. scripts/build-binaries.sh signs exactly the darwin
// binaries, before it compresses them, so the sha256 version.json publishes is the signed file's and
// the runner's update check still passes; a build told to sign that cannot publishes nothing. And
// the chain that carries the identity into that build is whole: the opt-in Compose file, the web
// Dockerfile's secrets and the variables the script reads. One broken link publishes ad-hoc binaries
// again without a word, and every Mac asks again after its next update.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

const repo = path.resolve(import.meta.dirname, '..');
const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const PASSWORD = 'fixture-p12-password-that-must-never-be-printed';

// `go build` writes a stand-in binary carrying the source stamp the script checks for; `go run
// ./cmd/release-manifest` keeps a copy of every asset it is handed, as it stands when the manifest
// is written, beside the manifest.
const FAKE_GO = `#!/bin/sh
case "$1" in
  build)
    while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
    printf 'fixture %s/%s binary, source %s\\n' "$GOOS" "$GOARCH" "$ORBIT_SOURCE_SHA" > "$out" ;;
  run)
    out="$5"; shift 5
    for asset in "$@"; do cp "$asset" "$out.vouched.$(basename "$asset")"; done
    echo '{}' > "$out" ;;
esac
`;

// Logs every call. `sign` appends a line standing for the signature, naming the identifier it was
// given; `print-signature-info` reads that back the way rcodesign prints a code directory.
const FAKE_RCODESIGN = `#!/bin/sh
printf '%s\\n' "$*" >> "$RCODESIGN_LOG"
case "$1" in
  sign)
    if [ -n "$FAKE_RCODESIGN_FAIL" ]; then echo "Error: incorrect password given when decrypting PFX data" >&2; exit 1; fi
    prev=""
    for arg in "$@"; do
      case "$prev" in
        --binary-identifier) identifier="$arg" ;;
        --entitlements-xml-file) cp "$arg" "$RCODESIGN_LOG.entitlements" ;;
      esac
      prev="$arg"; bin="$arg"
    done
    printf '\\nFIXTURE-SIGNATURE identifier=%s\\n' "$identifier" >> "$bin" ;;
  print-signature-info)
    printf '        code_directory:\\n          identifier: %s\\n          team_name: FIXTURETM1\\n' \\
      "$(sed -n 's/^FIXTURE-SIGNATURE identifier=//p' "$2")" ;;
esac
`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-macos-signing-'));
  for (const sub of ['scripts', 'src/runner-go', 'contracts', 'bin', 'secrets']) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  copyFileSync(path.join(repo, 'scripts/build-binaries.sh'), path.join(dir, 'scripts/build-binaries.sh'));
  writeFileSync(path.join(dir, 'package.json'), '{ "version": "0.0.0-fixture" }\n');
  writeFileSync(path.join(dir, 'contracts/runner-write-protocol.json'), '{}\n');
  for (const [name, source] of [['go', FAKE_GO], ['rcodesign', FAKE_RCODESIGN]]) {
    writeFileSync(path.join(dir, 'bin', name), source);
    chmodSync(path.join(dir, 'bin', name), 0o755);
  }
  const p12 = path.join(dir, 'secrets/developer-id.p12');
  const password = path.join(dir, 'secrets/developer-id.password');
  writeFileSync(p12, 'fixture p12\n');
  writeFileSync(password, `${PASSWORD}\n`);
  const log = path.join(dir, 'rcodesign.log');
  const build = (env = {}) => {
    const merged = {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      ORBIT_SOURCE_SHA: '3'.repeat(40),
      RCODESIGN_LOG: log,
      ...env,
    };
    for (const name of ['ORBIT_MACOS_SIGNING_P12', 'ORBIT_MACOS_SIGNING_PASSWORD_FILE']) {
      if (!(name in env)) delete merged[name];
    }
    return spawnSync('bash', [path.join(dir, 'scripts/build-binaries.sh'), 'dist-bin'],
      { cwd: dir, env: merged, encoding: 'utf8' });
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const published = () => (existsSync(path.join(dir, 'dist-bin'))
    ? readdirSync(path.join(dir, 'dist-bin')) : []);
  return { dir, p12, password, log, build, calls, published };
}

test('the darwin binaries are signed before they are compressed, so the manifest vouches for the signed bytes', () => {
  const f = fixture();
  try {
    const run = f.build({ ORBIT_MACOS_SIGNING_P12: f.p12, ORBIT_MACOS_SIGNING_PASSWORD_FILE: f.password });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const signs = f.calls().filter((call) => call.startsWith('sign '));
    assert.equal(signs.length, 2, `expected one signature per darwin binary:\n${signs.join('\n')}`);

    for (const platform of PLATFORMS) {
      const served = readFileSync(path.join(f.dir, `dist-bin/orbit-${platform}.gz`));
      const vouched = readFileSync(path.join(f.dir, `dist-bin/version.json.vouched.orbit-${platform}.gz`));
      assert.ok(served.equals(vouched), `${platform}: /dl serves other bytes than version.json vouches for`);
      const binary = gunzipSync(served).toString();
      if (platform.startsWith('linux')) {
        assert.doesNotMatch(binary, /FIXTURE-SIGNATURE/, `${platform} must not be signed`);
        continue;
      }
      assert.match(binary, /FIXTURE-SIGNATURE identifier=com\.orbit\.runner\n$/,
        `${platform}: the published binary is not the signed one`);
      const sign = signs.find((call) => call.endsWith(`/orbit-${platform}`));
      assert.ok(sign, `${platform} was never handed to rcodesign`);
      assert.match(sign, /--binary-identifier com\.orbit\.runner /);
      assert.match(sign, /--code-signature-flags runtime /);
      assert.match(sign, new RegExp(`--p12-file ${f.p12} --p12-password-file ${f.password} `));
    }
    // A hardened process is refused Apple Events and the like outright unless entitled to ask.
    const entitlements = readFileSync(`${f.log}.entitlements`, 'utf8');
    for (const key of ['automation.apple-events', 'device.camera', 'device.audio-input']) {
      assert.match(entitlements, new RegExp(`<key>com\\.apple\\.security\\.${key.replace('.', '\\.')}</key><true/>`));
    }
    assert.match(run.stdout, /signed as com\.orbit\.runner, team FIXTURETM1/);
    assert.ok(!`${run.stdout}${run.stderr}`.includes(PASSWORD), 'the .p12 password reached the build log');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('without a signing identity nothing is signed and rcodesign is not needed', () => {
  const f = fixture();
  try {
    rmSync(path.join(f.dir, 'bin/rcodesign'));
    const run = f.build();
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    for (const platform of PLATFORMS) {
      const binary = gunzipSync(readFileSync(path.join(f.dir, `dist-bin/orbit-${platform}.gz`))).toString();
      assert.doesNotMatch(binary, /FIXTURE-SIGNATURE/, `${platform} was signed with no identity given`);
    }
    assert.doesNotMatch(run.stdout, /signed as/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a build told to sign that cannot publishes nothing', () => {
  const cases = [
    ['a .p12 that is not there', (f) => ({ env: { ORBIT_MACOS_SIGNING_P12: `${f.p12}.missing`,
      ORBIT_MACOS_SIGNING_PASSWORD_FILE: f.password }, says: /ORBIT_MACOS_SIGNING_P12/, compiles: false })],
    ['no password file', (f) => ({ env: { ORBIT_MACOS_SIGNING_P12: f.p12 },
      says: /ORBIT_MACOS_SIGNING_PASSWORD_FILE/, compiles: false })],
    ['no rcodesign', (f) => {
      rmSync(path.join(f.dir, 'bin/rcodesign'));
      return { env: { ORBIT_MACOS_SIGNING_P12: f.p12, ORBIT_MACOS_SIGNING_PASSWORD_FILE: f.password },
        says: /needs rcodesign/, compiles: false };
    }],
    ['rcodesign refusing the .p12', (f) => ({ env: { ORBIT_MACOS_SIGNING_P12: f.p12,
      ORBIT_MACOS_SIGNING_PASSWORD_FILE: f.password, FAKE_RCODESIGN_FAIL: '1' },
    says: /incorrect password given[\s\S]*could not sign orbit-darwin-x64/, compiles: true })],
  ];
  for (const [what, setup] of cases) {
    const f = fixture();
    try {
      const { env, says, compiles } = setup(f);
      const run = f.build(env);
      assert.notEqual(run.status, 0, `${what}: the build must fail`);
      assert.match(run.stderr, says, `${what}: ${run.stderr}`);
      assert.ok(!f.published().includes('version.json'), `${what}: a manifest was written`);
      assert.ok(!f.published().some((name) => name.startsWith('orbit-darwin') && name.endsWith('.gz')),
        `${what}: an unsigned darwin binary was published`);
      if (!compiles) assert.deepEqual(f.published(), [], `${what}: it must refuse before compiling`);
      assert.ok(!`${run.stdout}${run.stderr}`.includes(PASSWORD), `${what}: the password was printed`);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test('the signing identity reaches build-binaries.sh as BuildKit secrets, from an opt-in Compose file', () => {
  const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');
  const optIn = read('deploy/macos-runner-signing.yml');
  const dockerfile = read('src/web/Dockerfile');
  const binbuild = dockerfile.slice(dockerfile.indexOf('AS binbuild'), dockerfile.indexOf('AS previous-release'));
  const links = [
    [optIn, /^ {6}args:\n {8}ORBIT_MACOS_SIGNING: "\$\{ORBIT_MACOS_SIGNING_P12:\?/m,
      'the opt-in file must mark the web build as one that signs'],
    [optIn, /^ {6}secrets:\n {8}- orbit_macos_signing_p12\n {8}- orbit_macos_signing_password$/m,
      'the opt-in file must hand the web build both secrets'],
    [optIn, /^ {2}orbit_macos_signing_p12:\n {4}file: "\$\{ORBIT_MACOS_SIGNING_P12:\?/m,
      'the .p12 secret must come from ORBIT_MACOS_SIGNING_P12, required'],
    [optIn, /^ {2}orbit_macos_signing_password:\n {4}file: "\$\{ORBIT_MACOS_SIGNING_PASSWORD_FILE:\?/m,
      'the password secret must come from ORBIT_MACOS_SIGNING_PASSWORD_FILE, required'],
    [binbuild, /^ARG ORBIT_MACOS_SIGNING$/m, 'the runner-binary stage must accept the build argument'],
    [binbuild, /sha256sum -c -/, 'rcodesign must be checked against its pinned digest'],
    [binbuild, /--mount=type=secret,id=orbit_macos_signing_p12 /, 'the build step must mount the .p12'],
    [binbuild, /--mount=type=secret,id=orbit_macos_signing_password /, 'the build step must mount the password'],
    [binbuild, /export ORBIT_MACOS_SIGNING_P12=\/run\/secrets\/orbit_macos_signing_p12\s+\\?\s*ORBIT_MACOS_SIGNING_PASSWORD_FILE=\/run\/secrets\/orbit_macos_signing_password;/,
      'the mounted secrets must reach the variables build-binaries.sh reads'],
  ];
  for (const [source, pattern, why] of links) assert.match(source, pattern, why);
  // Declared ahead of the steps it gates: an ARG only reaches a RUN that follows it.
  assert.ok(binbuild.indexOf('ARG ORBIT_MACOS_SIGNING') < binbuild.indexOf('bash scripts/build-binaries.sh'));
  assert.doesNotMatch(binbuild, /ARG ORBIT_MACOS_SIGNING_(P12|PASSWORD)/,
    'the .p12 and its password are secrets, never build arguments');

  // Every place that tells a deployment how to opt in names files that exist.
  for (const relative of ['.env.example', 'docs/release-process.md', 'deploy/macos-runner-signing.yml']) {
    const named = [...read(relative).matchAll(/COMPOSE_FILE=(\S+)/g)].map((match) => match[1]);
    assert.ok(named.length > 0, `${relative} no longer shows the COMPOSE_FILE line`);
    for (const files of named) {
      for (const file of files.split(':')) {
        assert.ok(existsSync(path.join(repo, file)), `${relative} names ${file}, which does not exist`);
      }
    }
  }
});
