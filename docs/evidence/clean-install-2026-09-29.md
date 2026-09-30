# Clean-host install and runner smoke record

**Run date:** 2026-09-29 (UTC)
**Result:** server boot and runner-online path **PASS**; first real agent task **BLOCKED** by the provider quota on
the test machine.
**Purpose:** provide a reproducible, sanitized record for the README entry path. This is evidence for the path,
not a claim of a hosted Orbit service or an SLA.

## What was tested

The test used a fresh checkout copy, a fresh Compose project name, a new PostgreSQL data directory, a new first-run
administrator, a one-time enrollment token, and a new `ORBIT_HOME` for the runner. The host itself was not
credential-clean: Claude Code, Codex, Kimi Code, and OpenCode binaries were already installed, and the host's
Claude/Codex logins were visible to the runner. No credentials, enrollment tokens, cookies, or private repository
contents are included in this record.

| Item | Observed value |
| --- | --- |
| OS | Debian GNU/Linux 13 (trixie), x86_64, kernel `6.12.107+deb13-cloud-amd64` |
| Git | 2.47.3 |
| Docker | 29.5.2 |
| Docker Compose | v5.1.4 |
| Validation source SHA | `3638d553569dc1f93479f2039f40fc61f0f17001` (the application tree used by the image build) |
| Runner reported version | `0.1.198` |
| Compose project | `orbit-readme-smoke` (isolated from the operator's existing project) |
| Gateway port | `22086` (temporary test port; normal docs use `2086`) |

## Timeline and elapsed time

Times below are the timestamps emitted by Compose/runner logs. The build and boot command used
`docker compose up -d --build --wait --wait-timeout 900` and exited 0.

| Stage | UTC observation | Elapsed / outcome |
| --- | --- | --- |
| Build images and boot PostgreSQL, API, web, backup sidecar, and gateway | 13:12:30 → 13:23:01 | **10m 31s**, all five services healthy |
| Confirm `/healthz` and `/api/auth/setup-status` | 13:23:44 | API returned `needsSetup: true` |
| Fix the temporary gateway override and re-check `/install.sh` | 13:25:24 | **~1m 40s**; the first 502 was caused by the test override renaming `orbit-web` without rewriting its nginx upstream, not by the repository Compose file |
| Bootstrap admin, mint one-time enrollment token, download `install.sh`, install runner, and `orbit register --token` | 13:28:20 | **PASS**; runner row created and registration returned successfully |
| Start `orbit run` with the fresh runner config | 13:29:10 | Process stayed up and began polling the control plane |
| Observe a post-start heartbeat | 13:30:10 | **PASS**; `/api/runners` reported `online: true`, `status: ONLINE`, and a fresh `lastHeartbeatAt` |
| Create a workspace and dispatch a tiny `npm test` task | 13:33:01 → 13:33:08 | Runner claimed the isolated worktree; turn stopped with the provider's weekly-limit message |

The measured control-plane build is therefore about ten and a half minutes on this host. Enrollment and the first
heartbeat took about two minutes after the stack was healthy; the UI's normal device-approval path adds the time a
person takes to approve the browser card.

## Commands exercised (secrets redacted)

```bash
git clone https://github.com/jianghailong-xy/orbit.git orbit-readme-smoke
cd orbit-readme-smoke
git fetch --all --tags
git checkout 3638d553569dc1f93479f2039f40fc61f0f17001
cp .env.example .env
# JWT_SECRET and PROVIDER_SECRET_KEY were generated independently and kept out of logs.
docker compose up -d --build --wait

curl -fsS http://127.0.0.1:22086/healthz
curl -fsS http://127.0.0.1:22086/api/auth/setup-status
curl -fsS -X POST http://127.0.0.1:22086/api/auth/bootstrap \
  -H 'content-type: application/json' \
  --data '{"email":"<operator>","name":"<operator>","password":"<redacted>"}'
curl -fsS -X POST http://127.0.0.1:22086/api/runners/enrollment-tokens \
  -H 'authorization: Bearer <access-token>' \
  --data '{"label":"clean-host-smoke","ttlHours":1}'

curl -fsSL http://127.0.0.1:22086/install.sh -o install.sh
ORBIT_BASE_URL=http://127.0.0.1:22086 ORBIT_BIN_DIR="$TMP/bin" \
  ORBIT_NO_REGISTER=1 bash install.sh
ORBIT_HOME="$TMP/orbit-home" "$TMP/bin/orbit" register \
  --server http://127.0.0.1:22086 --token <one-time-token> \
  --name clean-runner --no-service --no-auto-install-engines --workdir "$TMP/workspace"
ORBIT_HOME="$TMP/orbit-home" "$TMP/bin/orbit" run
```

The smoke used the enrollment-token path so it could verify the complete server-to-runner handshake without
automating a browser click. The documented interactive command (`curl …/install.sh | bash`) remains the normal
operator path; it opens the same approval flow when run from a terminal.

## Acceptance result and blockers

- **Repository → Compose server:** passed. Images built from the checkout and all services reached healthy state.
- **Server → fresh runner install:** passed. The installer downloaded the platform binary, registration returned a
  runner credential, and the runner reported `online: true` with a fresh heartbeat.
- **Runner → workspace:** passed. A workspace pointed at a Git checkout and the runner created an isolated
  worktree for the dispatched task.
- **Runner → first agent result:** blocked. The configured Claude provider returned `You've hit your weekly limit`;
  the task remained open with the failure recorded by Orbit. Re-run the same smoke with a test account that has
  available quota to turn this line green. This is an external provider-availability blocker, not a successful
  first-task result.

Two details are worth preserving for future runs:

1. The temporary test gateway had renamed containers, so its nginx bind-mount needed a matching upstream name. A
   normal checkout using the repository's `docker-compose.yml` does not make that rename and did not show this 502.
2. The first temporary runner home made the Unix background-job socket path longer than the OS limit. The rerun used
   a short fresh `ORBIT_HOME`, which is also a useful troubleshooting hint for unusually deep CI paths.

## Follow-up gates

- Keep the provider-quota failure visible until a clean host with an authenticated, available runtime completes one
  real task.
- Reconcile the public release identity before calling this a production install: this checkout's root
  `package.json` says `0.1.198`, while the newest repository tag is `v0.1.2-beta.138`.
- The web UI currently offers a Windows installer command, while this checkout ships `install.sh` only. The README
  deliberately documents and tests Linux/macOS until a Windows asset is published and verified.
