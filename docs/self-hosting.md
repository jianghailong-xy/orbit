# Self-hosting Orbit

This guide covers the included Docker Compose deployment: PostgreSQL, the control plane, web UI, backup
sidecar, and nginx gateway. It is a practical starting point for one trusted team. Production operators remain
responsible for TLS, host security, monitoring, and off-host backups.

## Requirements

- Docker Engine with the Compose plugin
- Enough CPU, memory, and disk to build the images and retain Postgres data
- A Linux host for the server deployment
- One or more runner machines with a supported runtime installed and authenticated

The server does not need the runtime credentials. Claude Code, Codex, Kimi, and OpenCode logins stay on the
runner machines.

## 1. Configure the deployment

```bash
git clone https://github.com/jianghailong-xy/orbit.git
cd orbit
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
JWT_SECRET="generate-a-unique-value"
PROVIDER_SECRET_KEY="generate-a-different-unique-value"
PUBLIC_ORIGIN="https://orbit.example.com"
```

Generate the two secrets independently:

```bash
openssl rand -base64 32
```

`JWT_SECRET` signs user authentication. `PROVIDER_SECRET_KEY` encrypts model-provider API keys at rest and is
required by the Compose service definition. Losing either secret can invalidate credentials or make stored
provider keys unreadable, so include the values in a protected secret backup. Do not commit `.env`.

`PUBLIC_ORIGIN` is baked into the web image and runner install instructions. Set it before building and
rebuild the web image whenever it changes.

## 2. Start the stack

```bash
docker compose up -d --build
docker compose ps
```

By default, the gateway listens on <http://localhost:2086>. A fresh deployment redirects the first visitor to
`/setup`; that account becomes the initial administrator. There is no public self-service signup. Additional
users are provisioned by an administrator.

Useful diagnostics:

```bash
docker compose ps
docker compose logs --tail=200 apiserver
docker compose logs --tail=200 gateway
```

## 3. Put HTTPS in front

The included gateway serves HTTP. Before exposing Orbit beyond a trusted local host:

- terminate TLS in a reverse proxy or load balancer;
- redirect HTTP to HTTPS;
- forward the original host and protocol headers;
- allow long-lived SSE responses without proxy buffering or a short idle timeout;
- restrict database and control-plane ports so only the gateway can reach them;
- set `PUBLIC_ORIGIN` to the exact external HTTPS origin and rebuild the web image.

Orbit can execute code with the runner account's privileges. Do not expose an instance to untrusted users or
attach a runner with broader credentials than its users should be able to exercise.

## 4. Register a runner

Open **Add a runner** in the web UI and use the generated command. It points at this deployment and enrolls
the machine through browser approval. A generic example is:

```bash
curl -fsSL https://orbit.example.com/install.sh | bash
```

Registration can attach routing labels and a concurrency limit:

```bash
curl -fsSL https://orbit.example.com/install.sh | bash -s -- \
  --labels linux,internal-network --max-concurrent 2
```

The installer can create a systemd or launchd service. Use `--foreground` for an interactive process, or set
`ORBIT_NO_REGISTER=1` to install only the binary. Run `orbit doctor` on the runner to diagnose missing runtime
installations or authentication.

## 5. Back up and monitor

The Compose stack writes Postgres data to `./data/postgres`. A sidecar writes base backups and archived WAL to
`./data/pg-archive`.

- Copy `./data/pg-archive` to a different host or object store. A same-disk backup does not protect against
  disk or host loss.
- Periodically perform the verification procedure in the [backup and restore runbook](postgres-backup-restore.md).
- Monitor container health, free disk, failed backups, runner heartbeat status, and HTTP error rates.
- Decide an attachment/artifact retention policy appropriate for your deployment.

## Upgrading

Review the release notes and create a verified backup before upgrading. Then fetch and check out the desired
release tag or reviewed commit and rebuild the changed services:

```bash
git fetch --tags
git checkout <release-tag-or-reviewed-commit>
docker compose up -d --build
```

The control plane applies pending Prisma migrations on startup. Keep Postgres running unless the release notes
explicitly require a database change outside the normal migration path.

## Production checklist

- [ ] `JWT_SECRET` and `PROVIDER_SECRET_KEY` are unique, protected, and backed up.
- [ ] The public endpoint uses HTTPS and the configured origin matches it.
- [ ] Only the gateway is publicly reachable.
- [ ] The first administrator uses a strong password and user access is reviewed.
- [ ] Runner machines use least-privilege OS accounts and narrowly scoped credentials.
- [ ] Backups are copied off-host and a restore has been tested.
- [ ] Container health, disk space, backup failures, and runner availability are monitored.
- [ ] The deployment is pinned to a known release or commit and has a documented upgrade cadence.
