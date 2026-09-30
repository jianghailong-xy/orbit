# Clean-machine first-run checklist

Use this checklist on a fresh Linux deployment host and a trusted Linux or macOS runner. It takes you
from an empty database to one completed task. Orbit is community-maintained, self-hosted software;
this procedure does not provide a hosted service or an SLA. Keep the
[self-hosting guide](self-hosting.md), [configuration reference](configuration.md),
[security policy](../SECURITY.md), [backup runbook](postgres-backup-restore.md), and
[release checklist](release-process.md) available.

## 1. Check prerequisites and pin the source

- [ ] Use a host with Docker Engine, the Compose plugin, Git, curl, OpenSSL, and enough free disk to
  build images and retain data/backups. Check versions and capacity:

  ```bash
  uname -srm
  docker version
  docker compose version
  git --version
  df -h .
  ```

- [ ] Clone into a new directory and choose a reviewed release tag or commit from the repository:

  ```bash
  git clone https://github.com/jianghailong-xy/orbit.git orbit-first-run
  cd orbit-first-run
  git fetch --tags
  ORBIT_INSTALL_REF='<release-tag-or-reviewed-commit>'
  git checkout --detach "$ORBIT_INSTALL_REF"
  git rev-parse HEAD
  ```

Expected: Docker and Compose answer successfully, and `HEAD` resolves to the intended source. Record
the full SHA before building. If any prerequisite is missing, install it before continuing.

## 2. Generate secrets and choose the network boundary

- [ ] Run `cp .env.example .env` and edit `.env` locally. Generate two independent values with
  `openssl rand -base64 32`: one for `JWT_SECRET`, the other for `PROVIDER_SECRET_KEY`. Protect the file
  with `chmod 600 .env`, and back it up securely. Do not print its contents into a shared transcript.
- [ ] Set `PUBLIC_ORIGIN` before the web build. For a local smoke test use `http://localhost:2086`.
  For access from another machine use the exact HTTPS origin served by your reverse proxy.
- [ ] The included gateway serves **HTTP only**, and Compose publishes port 2086 on the host.
  Keep inbound access blocked during bootstrap. Before network exposure, add TLS termination,
  HTTP-to-HTTPS redirects, and proxy settings for long-lived SSE as described in
  [self-hosting](self-hosting.md#3-put-https-in-front). Only the gateway should be reachable externally.
- [ ] Choose a runner OS account with only the files and credentials its Orbit users may use.
  Tasks execute with that account's privileges; processes sharing the account are not isolated.
  Keep runtime logins, the server environment, and the Docker socket outside an untrusted runner's reach.

Expected: both required secrets are nonempty, the origin matches the access path, and the host is
still private. Compose reports missing required substitutions at startup; correct `.env` locally.

## 3. Build, boot, and create the first administrator

```bash
docker compose up -d --build --wait --wait-timeout 900
docker compose ps
curl -fsS http://localhost:2086/healthz
curl -fsS http://localhost:2086/api/auth/setup-status
docker compose logs --since=10m --tail=100 apiserver pgbackup
```

- [ ] Confirm PostgreSQL, API, web, and gateway are healthy, and `pgbackup` is running without backup
  errors. `/healthz` returns `ok`; setup status returns `needsSetup: true` on a fresh database.
  Gateway health alone does not prove API/database readiness.
- [ ] Open the configured origin in a browser. The first visit redirects to `/setup`; create the
  first administrator with a strong password, then sign in. Setup status should now report
  `needsSetup: false`. Additional accounts are created by an administrator.

If boot fails, read the API/Postgres logs for migration or disk errors. Do not delete the data
directory to retry an existing deployment. If setup is already complete on an expected fresh host,
verify the checkout and data mount before writing anything else.

## 4. Enroll a runner and authenticate one runtime

- [ ] In the web UI open **Add a runner** and copy its generated command to the runner machine.
  Confirm that the command points at your deployment. Run it as the selected runner OS account,
  approve the device enrollment in the signed-in browser, and keep any enrollment token private.
- [ ] Let the installer create the systemd/launchd service, or select `--foreground` for a supervised
  terminal smoke test. Check the runner:

  ```bash
  orbit status
  orbit doctor
  ```

- [ ] Use the install/sign-in command printed by `orbit doctor` for the runtime you will select.
  Authenticate as the service's OS account and confirm that the runtime appears on the service PATH.
  An authentication result of `unknown` needs a real task check; exit status 0 only means at least
  one runtime is installed. Confirm the selected provider has available quota.
- [ ] Confirm the UI shows the runner online and `orbit status` reports a recent heartbeat.
  Use [runner troubleshooting](runner-troubleshooting.md) if registration, heartbeat, or auth fails.

Expected: the runner belongs to the intended account/deployment, its heartbeat advances, and the
selected runtime can authenticate. Runtime credentials stay on the runner for this local-login path.

## 5. Complete a small task

- [ ] On the runner, create a disposable Git workspace owned by the runner OS account:

  ```bash
  mkdir orbit-smoke-workspace
  cd orbit-smoke-workspace
  git init
  printf '# Orbit smoke workspace\n' > README.md
  git add README.md
  git -c user.name='Orbit smoke' -c user.email='smoke@example.invalid' commit -m 'Initialize smoke workspace'
  ```

- [ ] Add an Orbit workspace/agent pointing at that absolute path on the enrolled runner. Select the
  installed, authenticated runtime. Create and start a task: “Create `smoke.txt` containing
  `Orbit first task passed`, and verify it with `cat smoke.txt`.” Configure executable completion
  evidence if offered, or review the result and confirm completion in the UI.
- [ ] Inspect the task transcript for a successful run and the resulting file. Check that the task
  reaches `DONE`; a session awaiting input or an online runner does not prove task completion.
- [ ] Recheck `docker compose ps`, the recent API logs, and the runner heartbeat. Follow the
  [backup verification procedure](postgres-backup-restore.md#verify-a-backup-without-touching-production)
  before treating this deployment as ready for valuable work.

A provider quota/authentication failure is a failed or blocked task check. Record it and rerun after
resolving it; keep the existing [clean-host smoke record](evidence/clean-install-2026-09-29.md) as
historical evidence, not proof that your first task passed.

## Evidence to retain

Fill in this table for each install or release test. Save a sanitized copy with the release evidence;
redact tokens, cookies, keys, private origins/paths, repository content, and user data from logs.

| Evidence | Observed value / UTC timestamp |
| --- | --- |
| Server OS / architecture; runner OS / architecture | Fill in |
| Docker Engine and Compose versions | Fill in |
| Release tag and full source SHA | Fill in |
| Start/end of build; container health result | Fill in |
| Setup before/after; first administrator created (no identity/credential) | Fill in |
| Runner/runtime versions; heartbeat age; authentication result | Fill in |
| First task result and completion evidence | Fill in |
| Backup/restore check and off-host copy | Fill in |
| Sanitized API/runner log excerpts with timestamps | Fill in |
| Any blocked gate, limitation, and next action | Fill in |
