#!/usr/bin/env bash
# Local preparation checks only. Run via Orbit bg_run in an Orbit session.
set -euo pipefail

if [[ ${MANAGED_RUNNER_SMOKE_PHASE:-} != isolated ]]; then
  exec python3 - "$0" "$@" <<'PY'
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

script = Path(sys.argv[1]).resolve()
if len(sys.argv) > 3:
    raise SystemExit("usage: local-smoke.sh [evidence-directory]")
evidence = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else Path(tempfile.mkdtemp(prefix="orbit-managed-smoke-"))
evidence.mkdir(parents=True, exist_ok=True)
scratch = Path(tempfile.mkdtemp(prefix="isolated-", dir=evidence))
env = dict(os.environ)
for key in tuple(env):
    if (key.startswith(("ORBIT_", "OPENAI_", "ANTHROPIC_", "CLAUDE_", "CODEX_", "KIMI_", "MOONSHOT_", "GOOGLE_", "GEMINI_", "AZURE_", "AWS_", "OPENCODE_", "ANTIGRAVITY_", "AGY_"))
            or key.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"))
            or key in ("GH_TOKEN", "GITHUB_TOKEN", "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "SSH_AUTH_SOCK")):
        env.pop(key)
providers = {name: shutil.which(name, path=env.get("PATH")) for name in ("codex", "claude", "opencode", "kimi", "agy", "antigravity", "gemini")}
tripwires = scratch / "tripwires"
tripwires.mkdir(mode=0o700)
log = evidence / "provider-tripwire.jsonl"
if log.exists():
    raise SystemExit("evidence directory already has provider-tripwire.jsonl; choose a fresh directory")
log.touch(mode=0o600)
for name, binary in providers.items():
    wrapper = tripwires / name
    wrapper.write_text("#!/usr/bin/env python3\n" +
        "import json, os, sys\n" +
        "from pathlib import Path\n" +
        "keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']\n" +
        "record = {'engine': " + repr(name) + ", 'argv': sys.argv[1:], 'credentialEnvReachable': {key: bool(os.environ.get(key)) for key in keys}, 'credentialFilesReachable': {str(path): path.exists() for path in [Path(os.environ['HOME']) / '.claude.json', Path(os.environ['CODEX_HOME']) / 'auth.json']}}\n" +
        "with open(" + repr(str(log)) + ", 'a') as output: output.write(json.dumps(record) + '\\n')\n" +
        "binary = " + repr(binary) + "\n" +
        "if not binary: sys.exit(127)\n" +
        "os.execv(binary, [binary, *sys.argv[1:]])\n")
    wrapper.chmod(0o700)
for name in ("home", "codex", "orbit", "go-cache"):
    (scratch / name).mkdir(mode=0o700)
# Go's fixtures create private t.TempDir directories directly under /tmp; a deeply
# nested TMPDIR exceeds the Unix socket path budget in the real drain supervisor.
env.update({"HOME": str(scratch / "home"), "CODEX_HOME": str(scratch / "codex"), "ORBIT_HOME": str(scratch / "orbit"), "GOCACHE": str(scratch / "go-cache"), "TMPDIR": "/tmp", "MANAGED_RUNNER_SMOKE_PHASE": "isolated", "MANAGED_RUNNER_SMOKE_EVIDENCE": str(evidence), "PATH": str(tripwires) + os.pathsep + env.get("PATH", ""), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "PYTHONDONTWRITEBYTECODE": "1"})
(evidence / "scope.json").write_text(json.dumps({"scope": "isolated local filesystem and fake-engine checks", "realEngineSession": "UNEXECUTED: authorized test model and credentials not supplied", "kubernetesCephRestore": "UNEXECUTED: authorized non-production cluster unavailable", "containerExecution": "UNEXECUTED by this script", "home": env["HOME"], "codexHome": env["CODEX_HOME"], "orbitHome": env["ORBIT_HOME"], "providers": providers}, indent=2) + "\n")
os.execvpe("bash", ["bash", str(script)], env)
PY
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
evidence_dir=${MANAGED_RUNNER_SMOKE_EVIDENCE:?}
exec > >(tee "$evidence_dir/local-smoke.log") 2>&1
printf 'Evidence: %s\n' "$evidence_dir"
printf 'Scope: isolated local checks; no cluster, container or real provider acceptance.\n'
go version
git --version
python3 --version
uname -sm
python3 "$script_dir/entrypoint_test.py" -v

cd -- "$repo_dir/src/runner-go"
go build -trimpath -buildvcs=false -o "$evidence_dir/orbit" .
"$evidence_dir/orbit" --version

# Every name is checked against PASS output; go test -run matching nothing is not success.
tests=(
  TestMachineHomeHonorsOrbitHome
  TestSaveLoadConfigRoundTrip
  TestSaveConfigCreatesPrivateStorage
  TestSaveConfigMigratesLegacyPermissions
  TestHardenConfigStorageMigratesTrustedRunnerHome
  TestSharedCodexStateIsAbsolutePrivateAndPartitionedByCodexHome
  TestEnsureSharedCodexStateRejectsFileAndSymlink
  TestResolveCodexStateKeepsSuccessfulLegacySessionSticky
  TestResolveCodexStateIgnoresHalfInitializedLegacyDirWithoutRuntime
  TestResolveCodexStateMarkerWinsAndCustomProviderStaysLocal
  TestIsolatedCodexHomeBorrowsConfigurationButNotHistoryOrLogin
  TestSessionMetaPreservesCodexStateLayout
  TestCodexCredentialIsolatedSessionRunsInAHomeOfItsOwn
  TestCodexPreThreadLegacySessionIsPlacedAfresh
  TestCodexIsolatedSessionRevivedOnTheRunnersLoginCarriesItsThread
  TestSetupWorktreeForksFromWorkdirHead
  TestParkCheckpointRoundTrip
  TestStageCodexGeneratedImageCopiesIntoSessionUploads
  TestWaitForRunLoopStopSignalDoesNotRequestUpdate
  TestARunnerStopLetsAnAcceptanceCommandInFlightFinish
  TestAnOpenCodeRunnerStopLetsAnAcceptanceCommandInFlightFinish
)
test_pattern=$(IFS='|'; printf '%s' "${tests[*]}")
go test -v -count=1 -timeout 5m -run "^($test_pattern)$" . | tee "$evidence_dir/go-test.log"
python3 - "$evidence_dir/go-test.log" "${tests[@]}" <<'PY'
from pathlib import Path
import re
import sys
output = Path(sys.argv[1]).read_text()
passed = set(re.findall(r"^--- PASS: (\S+) ", output, re.MULTILINE))
missing = set(sys.argv[2:]) - passed
if missing:
    raise SystemExit("Expected test PASS records absent: " + ", ".join(sorted(missing)))
print(f"Verified {len(sys.argv) - 2} named top-level PASS records")
PY
if [[ -s "$evidence_dir/provider-tripwire.jsonl" ]]; then
  printf 'FAIL: a real provider executable was invoked; inspect provider-tripwire.jsonl.\n' >&2
  exit 1
fi
printf 'Provider tripwire: zero real provider executable invocations.\n'
printf 'SKIP: real engine session and container/Kubernetes/Ceph rebuild acceptance require authorized test resources.\n'
printf 'Local preparation smoke passed.\n'
