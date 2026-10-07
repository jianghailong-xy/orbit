# Configuration reference

This page covers [.env.example](../.env.example) and the environment and build arguments in
[docker-compose.yml](../docker-compose.yml). Start with [self-hosting](self-hosting.md) or the
[first-run checklist](first-run.md). Examples contain placeholders, not working credentials.

Compose reads `.env` for `${VARIABLE}` substitutions; an exported shell variable takes precedence.
An entry in `.env` does not automatically become a container environment variable. In particular,
Compose fixes `DATABASE_URL`, `PORT`, and `CORS_ORIGINS` in the API container. Changing those values
requires editing the service definition or supplying a Compose override.

In the tables, **recreate** means `docker compose up -d <service>` after editing `.env` or the service
definition. `docker compose restart` alone does not apply changed environment variables. **Rebuild**
means `docker compose up -d --build <service>`. Run commands from the deployment checkout with its
existing `.env` and data mounts. Do not paste `docker compose config`, `.env`, or container environment
output into a public report: expanded values can contain secrets.

## Control plane and web

| Variable | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Required for a standalone API; example `postgresql://orbit:orbit@localhost:5432/orbit?schema=public` | Prisma database connection. Compose fixes it to the `postgres` service, not the host's `localhost`. | Yes: connection password | Recreate API; coordinate database credentials first |
| `JWT_SECRET` | Required; no default | Signs user authentication and, by default, derives the orchestration signing key. Generate with `openssl rand -base64 32`. | Yes | Recreate API; existing signed tokens may become invalid |
| `RUNNER_ORCHESTRATION_JWT_SECRET` | Optional; derived from `JWT_SECRET` when empty | Independent signing key for the 15-minute runner/session orchestration proofs. | Yes | Recreate API; outstanding proofs may become invalid |
| `ACCESS_TOKEN_TTL` | Optional; `7d` | User access-token lifetime, using a duration such as `1h`, `24h`, or `7d`. Refresh tokens last 30 days. | No | Recreate API; applies to newly issued access tokens |
| `PROVIDER_SECRET_KEY` | Required by Compose; no default | AES-256-GCM master key for stored provider credentials, account-pool logins and the Google sign-in client secret. Generate independently with `openssl rand -base64 32`. | Yes | Recreate API only after planning key migration; replacing it makes existing encrypted credentials unreadable |
| `PORT` | Standalone default / example `3000`; Compose fixes `3000` | API listener port. A Compose change also needs matching gateway upstreams and health checks. | No | Recreate API and affected gateway |
| `CORS_ORIGINS` | Compose fixes `http://localhost:2086` | Allowed cross-origin browser origins. The included gateway serves web and API from one origin. | No | Recreate API after changing its service definition |
| `PUBLIC_ORIGIN` | Optional; `http://localhost:2086` | External origin in runner installation commands, the runner's built-in server default, control-plane shared-pool routing, and the Google sign-in redirect URI. Use the external HTTPS origin for a network deployment. | No | Rebuild web and recreate API; update deployed runners as appropriate, and the redirect URI registered with Google |
| `MODEL_CATALOG_URL` | Optional; `https://models.dev/api.json` | Source for twice-daily vendor model-list refreshes. Failed fetches retain the shipped lists. | No; avoid embedding credentials in URLs | Recreate API |
| `ORBIT_WATCHES_MODE` → container `ORBIT_WATCHES` | Optional; `on` | Watch rollout: `on`, `canary`, `drain` (no new watches), or `off` (also stops evaluation/delivery on this API). | No | Recreate API; no migration or runner release |
| `ORBIT_WATCHES_CANARY_OWNERS` | Optional; empty | Comma-separated account IDs enabled in Watch canary mode. | No; account identifiers are private diagnostic data | Recreate API |
| `ORBIT_WIKI_MODE` → container `ORBIT_WIKI` | Optional; `on` | Wiki rollout: `on`, `canary`, or `off`. Disabled accounts receive `WIKI_DISABLED` and no Wiki tools/context. | No | Recreate API; no migration or runner release |
| `ORBIT_WIKI_CANARY_OWNERS` | Optional; empty | Comma-separated account IDs enabled in Wiki canary mode. | No; account identifiers are private diagnostic data | Recreate API |
| `DEEPSEEK_API_KEY` | Optional; empty disables title enrichment | Asynchronous session title/tag enrichment; independent of the coding runtime's credentials. | Yes | Recreate API |
| `DEEPSEEK_BASE_URL` | Optional; `https://api.deepseek.com` | Endpoint for title/tag enrichment. | No; avoid credential-bearing URLs | Recreate API |
| `DEEPSEEK_MODEL` | Optional; `deepseek-chat` | Model used for title/tag enrichment. | No | Recreate API |
| `APNS_KEY` | Optional; empty disables push | Base64-encoded contents of the Apple `AuthKey_XXXX.p8` key. Push also needs the key/team identifiers. | Yes | Recreate API |
| `APNS_KEY_ID` | Required when APNs is enabled; otherwise empty | Apple push authentication key identifier. | No; redact in public diagnostics | Recreate API |
| `APNS_TEAM_ID` | Required when APNs is enabled; otherwise empty | Apple developer team identifier. | No; redact in public diagnostics | Recreate API |
| `APNS_BUNDLE_ID` | Optional; `io.orbitd.app` | APNs topic matching the iOS application's bundle ID. | No | Recreate API |
| `ORBIT_SOURCE_SHA` | Optional in a Git checkout; required without Git metadata | Full lowercase 40-character source commit stamped into downloadable runner binaries at web-image build time. | No | Rebuild web for each source revision |

Use the host names `ORBIT_WATCHES_MODE` and `ORBIT_WIKI_MODE`, not `ORBIT_WATCHES` or `ORBIT_WIKI`:
agent sessions already carry the latter variables, and shell precedence could accidentally change a
deployment's rollout. See [Watch rollout](watch-rollout.md) for mode transitions.

Supply `ORBIT_SOURCE_SHA` for a single build rather than saving it in `.env`, where it becomes stale:

```bash
ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" docker compose up -d --build web
```

Keep `JWT_SECRET` and `PROVIDER_SECRET_KEY` in a protected backup alongside the database recovery plan.
They have different jobs; generate them independently. Consult the [security policy](../SECURITY.md)
before changing credential storage or the runner/server trust boundary.

### Google sign-in

Google sign-in has no environment variables. Its settings (the switch, the Google OAuth client ID and secret,
and who may sign in with Google) are stored in the database. An administrator enters them under
**Admin → Sign-in** in the web UI, and a change applies from the next request, with no rebuild or restart.
Nothing in `.env` turns it on: until an administrator does, no login page offers Google.

Two deployment values matter to it:

- `PUBLIC_ORIGIN` decides the redirect URI, `${PUBLIC_ORIGIN}/api/auth/google/callback`. **Admin → Sign-in**
  shows it, and it must be registered on the Google client exactly as shown. After changing `PUBLIC_ORIGIN`,
  register the new redirect URI with Google too.
- `PROVIDER_SECRET_KEY` encrypts the saved client secret. After replacing the key, enter the client secret
  again under **Admin → Sign-in**.

See [Google sign-in](self-hosting.md#google-sign-in) for the Google Cloud console steps and who can sign in.

## PostgreSQL and backups

These values are fixed inside Compose unless the table names a host substitution. Changing a
`POSTGRES_*` value does not update users/passwords in an existing data directory; coordinate SQL
credential changes and the API connection rather than deleting or reinitializing the database.

| Variable | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- |
| `POSTGRES_USER` | Compose fixes `orbit` | Bootstrap database superuser on first initialization. | No | Initialization setting; existing cluster needs an explicit SQL change |
| `POSTGRES_PASSWORD` | Compose fixes `orbit` | Bootstrap password; database port is not published by the included stack. | Yes | Rotate in SQL and update API connection; recreate affected services |
| `POSTGRES_DB` | Compose fixes `orbit` | Initial application database. | No | Initialization setting; coordinate an existing database change |
| `PGHOST` | Backup service fixes `/var/run/postgresql` | Backup connection over the shared Unix socket. | No | Recreate backup service after editing Compose |
| `PGUSER` | Backup service fixes `orbit` | Database role running the backup; matches the bootstrap superuser. | No | Recreate backup service; coordinate database role changes |
| `PGDATABASE` | Backup service fixes `postgres` | Maintenance database for backup commands. | No | Recreate backup service after editing Compose |
| `ORBIT_BASE_BACKUP_INTERVAL` | Optional; `86400` seconds | Time between base backups. | No | Recreate `pgbackup` |
| `ORBIT_BASE_BACKUP_KEEP` | Optional; `2` | Number of base backups retained; retention bounds available recovery history. | No | Recreate `pgbackup` |
| `ORBIT_BACKUP_MIN_FREE_MB` | Optional; `2048` MiB | Minimum free space to leave; a backup that cannot meet it is skipped with an error. | No | Recreate `pgbackup` |
| `ORBIT_BACKUP_SYNC_TARGET` | Optional; empty means local only | SSH rsync destination dedicated to the archive. The mirror deletes unrelated destination files. | No; redact private host/path | Recreate `pgbackup` |
| `ORBIT_BACKUP_SYNC_SSH_PORT` | Optional; `22` | SSH port for the off-host mirror. | No | Recreate `pgbackup` |
| `ORBIT_BACKUP_SSH_DIR` | Optional; `/root/.ssh` | Host directory mounted read-only at `/ssh`, containing `id_rsa` and `known_hosts` for the mirror. | Contents include a private key | Recreate `pgbackup`; keep host-key checking enabled |

The data and local archive live at `./data/postgres` and `./data/pg-archive`. Local backups share the
database disk; configure an off-host copy and test restoration using the
[backup and restore runbook](postgres-backup-restore.md).

## Runner machine only

Do not put runtime credentials in the server's `.env`. Run registration and authentication as the OS
account that will run the service. By default registration stores the server URL and long-lived
credential in `~/.orbit/config.json`; that file is private and must not be posted for diagnosis.

| Variable | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- |
| `ORBIT_RUNNER_TOKEN` | Issued by registration; no public default | Long-lived machine credential; also available to authorized CLI/session contexts. Never invent or share it. | Yes | Re-register when revoked; registration restarts the installed service |
| `ANTHROPIC_API_KEY` | Optional; unset uses local login | Usage-billed Claude Code authentication on the runner. | Yes | Update the service's private environment and restart it |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional; unset uses local login | Non-interactive subscription authentication from the runtime's token setup flow. | Yes | Update the service's private environment and restart it |
| `ORBIT_HOME` | Optional; `~/.orbit` | Runner configuration and run scratch directory, and the CLI's saved login (`user.json`). A shell and service must use the same home. | Directory contains credentials | Update the service configuration and restart it |
| `ORBIT_NO_SELFUPDATE` | Optional; unset | Disables runner self-updates. | No | Restart runner with the setting |
| `ORBIT_NO_ENGINE_UPDATE` | Optional; unset | Disables periodic coding-runtime updates. | No | Restart runner with the setting |

An export in an interactive shell does not update an already-running systemd/launchd service. Use
`orbit doctor` to inspect the selected runtime and service PATH; see
[runner troubleshooting](runner-troubleshooting.md) and [CLI automation](runner-cli.md).

## CLI acting as a person

The `orbit` CLI can act as a user with a personal access token, on any machine and with or without a runner.
`orbit login` (approved in the browser, or `--with-token` from stdin) saves the token and its server in
`$ORBIT_HOME/user.json` (mode `0600`), apart from the runner's `config.json`; the runner service never reads it.
These variables take its place where a saved login is impractical, such as CI. See
[personal access tokens](runner-cli.md#personal-access-tokens).

| Variable | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- |
| `ORBIT_USER_TOKEN` | Optional; unset uses the saved login | A personal access token (Settings → Access tokens) the CLI acts as, in place of `user.json`. Ignored inside an Orbit session and in any process the runner starts for one (both ignore `user.json` too), and never passed to agent processes. | Yes | Next CLI command |
| `ORBIT_SERVER_URL` | Optional; the runner's server, else the server the binary was built for | The server `ORBIT_USER_TOKEN` belongs to, and the default for `orbit login --server`. A saved login always uses its own server. | No; redact private origin | Next CLI command |
