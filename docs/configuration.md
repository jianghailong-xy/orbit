# Configuration reference

This page covers every value [.env.example](../.env.example) and the Compose files in this repository read:
[docker-compose.yml](../docker-compose.yml), the optional [macOS signing file](../deploy/macos-runner-signing.yml),
and the [remote channel-host file](../deploy/managed-runner/remote-host/compose.yml). Start with
[self-hosting](self-hosting.md) or the [first-run checklist](first-run.md). Examples contain placeholders, not
working credentials.

Compose reads `.env` for `${VARIABLE}` substitutions; an exported shell variable takes precedence.
An entry in `.env` does not automatically become a container environment variable. In particular,
Compose fixes `DATABASE_URL`, `PORT`, and `CORS_ORIGINS` in the API container. Changing those values
requires editing the service definition or supplying a Compose override.

Each table gives a variable's **type**, whether it is required or what it defaults to, what it does, whether it
holds a secret, and how a change is applied. Types are:

| Type | Meaning |
| --- | --- |
| `secret` | A credential or key. Never commit it, paste it into an issue, or include it in a public log. |
| `string` | Free text, such as a name, a list of identifiers, or a host name. |
| `path` | A filesystem path. |
| `URL` | An absolute URL, origin, or endpoint. |
| `integer` | A whole number, in the unit the row names (seconds, MiB, bytes, a count). |
| `duration` | A lifespan such as `1h`, `24h` or `7d`. |
| `boolean` | `true` turns a feature on; empty or any other value leaves it off, unless the row says otherwise. |
| `enum` | One of the values the row lists. Any other value is refused or logged. |
| `flag` | Set to any value, including empty, to turn a feature on; unset to leave it off. |

In the tables, **recreate** means `docker compose up -d <service>` after editing `.env` or the service
definition. `docker compose restart` alone does not apply changed environment variables. **Rebuild**
means `docker compose up -d --build <service>`. Run commands from the deployment checkout with its
existing `.env` and data mounts. Do not paste `docker compose config`, `.env`, or container environment
output into a public report: expanded values can contain secrets.

## Control plane and web

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | `URL` | Required for a standalone API; example `postgresql://orbit:orbit@localhost:5432/orbit?schema=public` | Prisma database connection. Compose fixes it to the `postgres` service, not the host's `localhost`. | Yes: connection password | Recreate API; coordinate database credentials first |
| `JWT_SECRET` | `secret` | Required; no default | Signs user authentication and, by default, derives the orchestration signing key. Generate with `openssl rand -base64 32`. | Yes | Recreate API; existing signed tokens may become invalid |
| `RUNNER_ORCHESTRATION_JWT_SECRET` | `secret` | Optional; derived from `JWT_SECRET` when empty | Independent signing key for the 15-minute runner/session orchestration proofs. | Yes | Recreate API; outstanding proofs may become invalid |
| `ACCESS_TOKEN_TTL` | `duration` | Optional; `7d` | User access-token lifetime, using a duration such as `1h`, `24h`, or `7d`. Refresh tokens last 30 days. | No | Recreate API; applies to newly issued access tokens |
| `PROVIDER_SECRET_KEY` | `secret` | Required by Compose; no default | AES-256-GCM master key for stored provider credentials, account-pool logins and the Google sign-in client secret. Generate independently with `openssl rand -base64 32`. | Yes | Recreate API only after planning key migration; replacing it makes existing encrypted credentials unreadable |
| `PORT` | `integer` | Standalone default / example `3000`; Compose fixes `3000` | API listener port. A Compose change also needs matching gateway upstreams and health checks. | No | Recreate API and affected gateway |
| `CORS_ORIGINS` | `string` | Compose fixes `http://localhost:2086` | Allowed cross-origin browser origins, comma-separated. The included gateway serves web and API from one origin. | No | Recreate API after changing its service definition |
| `PUBLIC_ORIGIN` | `URL` | Optional; `http://localhost:2086` | External origin in runner installation commands, the runner's built-in server default, control-plane shared-pool routing, the runner link's same-origin address, and the Google sign-in redirect URI. Use the external HTTPS origin for a network deployment. | No | Rebuild web and recreate API; update deployed runners as appropriate, and the redirect URI registered with Google |
| `TRUSTED_PROXIES` | `string` | Optional; empty | Addresses and CIDR ranges of the proxies in front of the gateway, separated by commas or spaces: a CDN's published ranges (Cloudflare's are at <https://www.cloudflare.com/ips/>), a load balancer, a TLS proxy on the host. The API then reads a visitor's own address from `X-Forwarded-For`, past those proxies only: the **From** row of the register approval page, an access token's last-used address, per-visitor limits. The [Claude region check](#claude-region-check) reads Cloudflare's country headers only from those proxies. Empty, a visitor is the address that connected to the gateway, which behind a proxy is the proxy's. An entry that is not an address or a range stops the API at start. | No | Recreate API |
| `MODEL_CATALOG_URL` | `URL` | Optional; `https://models.dev/api.json` | Source for twice-daily vendor model-list refreshes. Failed fetches retain the shipped lists. | No; avoid embedding credentials in URLs | Recreate API |
| `ORBIT_WATCHES_MODE` → container `ORBIT_WATCHES` | `enum`: `on`, `canary`, `drain`, `off` | Optional; `on` | Watch rollout: `drain` takes no new watches, `off` also stops evaluation/delivery on this API. | No | Recreate API; no migration or runner release |
| `ORBIT_WATCHES_CANARY_OWNERS` | `string` | Optional; empty | Comma-separated account IDs enabled in Watch canary mode. | No; account identifiers are private diagnostic data | Recreate API |
| `ORBIT_WIKI_MODE` → container `ORBIT_WIKI` | `enum`: `on`, `canary`, `off` | Optional; `on` | Wiki rollout. Disabled accounts receive `WIKI_DISABLED` and no Wiki tools/context. | No | Recreate API; no migration or runner release |
| `ORBIT_WIKI_CANARY_OWNERS` | `string` | Optional; empty | Comma-separated account IDs enabled in Wiki canary mode. | No; account identifiers are private diagnostic data | Recreate API |
| `DEEPSEEK_API_KEY` | `secret` | Optional; empty names sessions with their own provider | Asynchronous session title/tag enrichment. When empty, a session is named by its own provider instead: on a configured API key the server holds (title and tags; not a Claude subscription token or an internal-host endpoint), or, for an engine's own sign-in, by Claude Code or Codex from inside the process running the session (title only). | Yes | Recreate API |
| `DEEPSEEK_BASE_URL` | `URL` | Optional; `https://api.deepseek.com` | Endpoint for title/tag enrichment. | No; avoid credential-bearing URLs | Recreate API |
| `DEEPSEEK_MODEL` | `string` | Optional; `deepseek-chat` | Model used for title/tag enrichment. | No | Recreate API |
| `APNS_KEY` | `secret` (base64) | Optional; empty disables push | Base64-encoded contents of the Apple `AuthKey_XXXX.p8` key. Push also needs the key/team identifiers. | Yes | Recreate API |
| `APNS_KEY_ID` | `string` | Required when APNs is enabled; otherwise empty | Apple push authentication key identifier. | No; redact in public diagnostics | Recreate API |
| `APNS_TEAM_ID` | `string` | Required when APNs is enabled; otherwise empty | Apple developer team identifier. | No; redact in public diagnostics | Recreate API |
| `APNS_BUNDLE_ID` | `string` | Optional; `io.orbitd.app` | APNs topic matching the iOS application's bundle ID. | No | Recreate API |
| `FCM_PROJECT_ID` | `string` | Optional; empty disables Android push | Target Firebase project with Cloud Messaging HTTP v1 enabled, independent of the APNs values. | No; redact in public diagnostics | Recreate API |
| `FCM_CLIENT_EMAIL` | `string` | Required when FCM is enabled; otherwise empty | Service-account `client_email` authorized for that project. | No; redact in public diagnostics | Recreate API |
| `FCM_PRIVATE_KEY` | `secret` (base64) | Required when FCM is enabled; otherwise empty | Base64 of the service account's PEM `private_key`, not of the whole JSON file. | Yes | Recreate API |
| `FCM_ANDROID_PACKAGE` | `string` | Optional; `io.orbitd.android` | Exact Android application ID permitted to receive push. Use `io.orbitd.android.debug` for the debug client. | No | Recreate API |
| `ORBIT_SOURCE_SHA` | `string` (40 lowercase hex) | Optional in a Git checkout; required without Git metadata | Source commit stamped into downloadable runner binaries and their advertised capability revision at web-image build time. | No | Rebuild web for each source revision |
| `RUNNER_RELEASE_DL_URL` | `URL` | Optional; `http://web/dl/` | Where the API reads the runner release manifests it states to a linked runner in Welcome and HeartbeatAck, as `GET /api/runner/release` answers them. Read at most once a minute, for at most two seconds; while unreadable, runners ask the route over HTTPS. | No | Recreate API |
| `ORBIT_CLAUDE_OPENAI_GATEWAY` | `boolean` (`true` only) | Optional; off | Claude Code on an OpenAI API key, through the API server's own gateway at `/api/gw/anthropic` ([design](claude-engine-openai-gateway-design.md)). `true` turns it on: an OpenAI key's engines become Codex (still the default), Claude Code and OpenCode, and a Claude Code session on one is handed `PUBLIC_ORIGIN` + `/api/gw/anthropic` and a session token, never the key. Absent, empty, `false` or any other value is off: no key's engines or dispatch environment change, and the gateway refuses every token. Turning it off stops the running sessions' requests at once. | No | Recreate API |
| `ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY` | `boolean` (`true` only) | Optional; off | Claude Code on the account owner's own Codex login pool (their own ChatGPT accounts), through the same `/api/gw/anthropic` gateway ([design §9](claude-engine-openai-gateway-design.md#9-claude-code-on-the-owners-own-codex-login-pool-p2b)). Separate from `ORBIT_CLAUDE_OPENAI_GATEWAY`, and either works without the other. `true` turns it on: a Codex pool its owner made and did not share runs Codex (still the default) and Claude Code; a Claude Code session on one runs on an account its owner signed in, is handed `PUBLIC_ORIGIN` + `/api/gw/anthropic` and the pool's session token, never an account's token, and its requests go to ChatGPT's Codex backend as Claude Code's own, with no Codex prompt or user agent. A shared pool, or somebody else's, is never offered Claude Code. Absent, empty, `false` or any other value is off: no pool's engines or dispatch environment change, and the gateway refuses such tokens. Using a ChatGPT account outside the official Codex CLI may lead OpenAI to restrict the account. | No | Recreate API |
| `ORBIT_GATEWAY_UPSTREAM_HOSTS` | `string` | Optional; empty | The hosts, besides `api.openai.com`, that the `/api/gw/anthropic` gateway may send an OpenAI key's requests to ([design §5.3](claude-engine-openai-gateway-design.md)): host names, comma- or space-separated, such as `responses.example.org`. The gateway calls a key's endpoint only over https, only on one of these hosts, and only when every address the host resolves to is public: private, loopback, link-local and other non-public addresses are refused before anything connects, and a redirect is never followed. A key whose endpoint is anywhere else is not offered Claude Code. Read at each request. | No | Recreate API |

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

### Orbit Files

Attachment bytes live outside PostgreSQL: one copy per content, named by its sha256 ([design](orbit-files-design.md)).
`local` keeps them under `./data/files`, which Compose mounts at `/var/lib/orbit/files`; `s3` keeps them in an
S3-compatible bucket addressed path-style under `files/`. Uploads are written to the files directory's `tmp/` first
with either backend. An invalid backend, an incomplete S3 configuration, or an endpoint that is not `http://` or
`https://` stops the API at start with the reason.

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `ORBIT_FILES_BACKEND` | `enum`: `local`, `s3` | Optional; `local` | Where new attachment bytes are stored. `local` is `./data/files` in Compose. | No | Recreate API; existing bytes stay where they were written and remain readable through their store |
| `ORBIT_FILES_DIR` | `path` | Optional; `/var/lib/orbit/files` | The local store's directory and the upload staging directory (`tmp/` inside it). In Compose it is the mount of `./data/files`. | Holds user data | Recreate API |
| `ORBIT_FILES_S3_ENDPOINT` | `URL` | Required with `ORBIT_FILES_BACKEND=s3`; otherwise empty | The bucket's endpoint, such as `https://s3.eu-west-1.amazonaws.com`. | No; avoid credential-bearing URLs | Recreate API |
| `ORBIT_FILES_S3_BUCKET` | `string` | Required with `s3`; otherwise empty | Bucket name. Objects are addressed path-style under `files/`. | No | Recreate API |
| `ORBIT_FILES_S3_REGION` | `string` | Optional with `s3`; `us-east-1` | Signing region. | No | Recreate API |
| `ORBIT_FILES_S3_ACCESS_KEY_ID` | `secret` | Required with `s3`; otherwise empty | Access key ID for the bucket. | Yes | Recreate API |
| `ORBIT_FILES_S3_SECRET_ACCESS_KEY` | `secret` | Required with `s3`; otherwise empty | Secret access key for the bucket. | Yes | Recreate API |
| `ORBIT_FILES_QUOTA_BYTES` | `integer` (bytes) | Optional; empty means no limit | The most one account may keep, each content counted once. Past it an upload is refused with `413` and the code `FILE_QUOTA_EXCEEDED`. For a hosted instance; a self-hosted deployment needs none. | No | Recreate API |

With `local`, `./data/files` is the only copy of those bytes: it is not in PostgreSQL or in any local backup. The
off-host mirror copies it to `<target>-files` beside the archive; with `s3`, the bucket's versioning or replication
is what protects them. See [File retention and quota](self-hosting.md#file-retention-and-quota) for expiry and
[Attachment files](postgres-backup-restore.md#attachment-files) for the restore order.

### Wiki worker and System model

The `wiki-worker` service runs the apiserver image with another command and calls the wiki's System model: the
deployment's own endpoint speaking the Anthropic Messages API, such as vLLM. These variables are passed to
`wiki-worker` only. The API container never receives the model's address or key; it reads the model's name and
state from the status row the worker writes.

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `ORBIT_WIKI_MODEL_BASE_URL` | `URL` | Optional; empty means no System model | The endpoint. Calls go to `{base}/v1/messages` and the worker probes `{base}/health` every 10 seconds. Use an address the `wiki-worker` container can reach. | No, but it is never shown to clients; avoid credential-bearing URLs | Recreate `wiki-worker` |
| `ORBIT_WIKI_MODEL_API_KEY` | `secret` | Required with the base URL | Sent as `Authorization: Bearer`. | Yes | Recreate `wiki-worker` |
| `ORBIT_WIKI_MODEL` | `string` | Required with the base URL | The model name sent with every call; the only part of the configuration clients see. | No | Recreate `wiki-worker` |
| `ORBIT_WIKI_MODEL_CONCURRENCY` | `integer` | Optional; `4` | The most model requests in flight at once, across every wiki space. | No | Recreate `wiki-worker` |
| `ORBIT_WIKI_MODEL_THINKING` | `enum`: `disabled`, `enabled`, empty | Optional; empty | `disabled` or `enabled` is sent as `"thinking": {"type": "<value>"}` in the body of every call. Empty sends no `thinking` field, so the endpoint decides; vLLM does not think unless asked. Set `disabled` for an endpoint that thinks by default, such as DeepSeek's V4 models. Any other value is logged as a problem, and no `thinking` field is sent. | No | Recreate `wiki-worker` |

The server runs every account's wiki work in `wiki-worker`; there is no runner path to fall back to, and no
executor switch (`ORBIT_WIKI_EXECUTOR` and `ORBIT_WIKI_EXECUTOR_CANARY_OWNERS` are read by nothing since P11, so an
old `.env` line is harmless). To pause the wiki's model work, stop the worker (`docker compose stop wiki-worker`):
its jobs and model requests wait in the queue, nothing is lost, and the wiki shows the worker as not running until
`docker compose up -d wiki-worker`. To turn the wiki off altogether, use `ORBIT_WIKI_MODE=off` above.

All three of the base URL, key, and model must be set; otherwise the System model reads as unconfigured and the
worker calls nothing. The wiki settings and health line show the model's name and one of these states: up,
unreachable, key refused, unconfigured, or wiki worker not running (no heartbeat for 60 seconds). A refused key
(HTTP 401) stays refused until the worker restarts, so correct the key in `.env` and run
`docker compose up -d wiki-worker`.

The worker runs in Compose's default bridge network, where `127.0.0.1` is the container itself and
`host.docker.internal` is not defined. For a model on the Docker host or a GPU machine, use its LAN or tunnel
address, or give `wiki-worker` an `extra_hosts: ["host.docker.internal:host-gateway"]` entry in a Compose override.
The names deliberately avoid `ANTHROPIC_*`: agent sessions carry those variables, and a deploy run from inside one
would otherwise pick up the session's values.

Until the wiki's jobs move to the server, the worker only probes the model and reports its state; wiki jobs still
run on runners.

### Managed runners

Every account's own runner, a container on this host's Docker, given at sign-in: see
[Managed runners](self-hosting.md#managed-runners) for what it is, who gets one and how far a container isolates
it. A fresh install (`scripts/install-server.sh`) writes all three variables; an upgrade never writes any of them,
so a deployment installed before them keeps managed runners off.

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `ORBIT_MANAGED_RUNNERS_ENABLED` | `boolean` (`true` only) | Optional; off. A fresh install writes `true` | The switch. `true` turns managed runners on; absent, empty or `false` is off, and so is any other value, with a warning in the API's log. Off, no account is given a runner and none is started or woken; nothing is stopped or deleted. | No | Recreate API |
| `ORBIT_MANAGED_RUNNERS_DIR` | `path` | Optional; unset mounts nothing. A fresh install writes `./data/managed-runners` | The managed runners' directory: the API's profile (`profile.json`), the Docker channel's configuration (`channel.json`), token, socket and state. Mounted read-only into the API and read-write into `docker-channel`. | Holds the channel's token | Recreate API and `docker-channel` |
| `COMPOSE_PROFILES` | `string` (comma-separated list) | Optional; unset. A fresh install writes `managed-runners-docker` | Compose's own variable. `managed-runners-docker` runs `docker-channel`, the restricted Docker channel and the only service given the Docker socket. `managed-runner-firewall` adds the runners' host firewall; an install made with `--no-managed-runner-firewall` leaves it out. Compose takes the last value it reads, so keep one line listing every profile. | No | `docker compose up -d docker-channel` |
| `ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK` | `path` | Optional; `/dev/null` when unset | The host's `/run/xtables.lock` on a host whose iptables uses the legacy backend, which must share the lock with Docker's own iptables calls. The install writes it only where that backend is in use; the nft backend takes no lock and gets `/dev/null`. The mount refuses to create the path (`create_host_path: false`), because a directory made there would break the host's iptables. | No | Recreate `managed-runner-firewall` |
| `ORBIT_CHANNEL_HOST_DIR` | `path` | Required only by the [remote channel-host file](../deploy/managed-runner/remote-host/compose.yml); written into its `compose.env` by `remote-host.sh`, never set by hand | A [channel host's](self-hosting.md#managed-runners-on-another-host) data directory, holding the channel's `channel.json` and token and the firewall's configuration. | Holds the channel's token | Recreate that host's `docker-channel` and `managed-runner-firewall` |

`profile.json` chooses the Docker backend (`"backend": "docker"`) and sets each runner's CPU, memory, process and
volume limits, its image (by local image ID) and the address it reaches the deployment at. `channel.json` names
the same image and the network `orbit-managed-runners`, and caps what a runner may be given. After editing either,
run `docker compose up -d --force-recreate docker-channel apiserver`.

### Runner link

Each runner keeps one WebSocket to a link gateway, which is part of this stack. A fresh install and
`/upgrade` generate every value below and append the lines to `.env`; a hand-written `.env` needs one
`/upgrade` run. See [Runner link](self-hosting.md#runner-link) for what the link is, how a runner reaches it, and
the steps to give it [a host name of its own](self-hosting.md#a-link-gateway-of-its-own).

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `RUNNER_LINK_SIGNING_KEY` | `secret` (base64 PEM) | Required by Compose; no default | Ed25519 private key that signs a runner's one-hour connection tokens. Compose refuses to render without it, naming what to run. | Yes | Recreate `apiserver`; outstanding tokens stay valid for up to an hour unless the old public key is kept |
| `RUNNER_LINK_PUBLIC_KEY` | `secret` (base64 PEM) | Required with the `runner-link` profile; otherwise empty | The public half of the signing key, as `openssl pkey -in runner-link.pem -pubout \| base64 -w0`. Two values, comma-separated, while the signing key is being replaced. | No; it is a public key | Recreate `link-gateway` |
| `RUNNER_LINK_URL` | `string` (`same-origin`, `ws://…`, or `wss://…`) | Optional; empty. A fresh install writes `same-origin` | The address runners are told to connect to. `same-origin` makes each runner connect through the web gateway at the address it reached this server at, decided by `PUBLIC_ORIGIN`. | No | Recreate `apiserver` |
| `RUNNER_LINK_GATEWAY_TOKEN` | `secret` (at least 32 characters) | Optional; empty means link calls are not served | The secret the gateway presents to the apiserver's link-call listener, and to read revoked credentials. | Yes | Recreate `apiserver` and `link-gateway` |
| `RUNNER_LINK_GATEWAY_DIR` | `path` | Optional; `/dev/null` (no volume) on a same-origin link; a directory such as `/srv/orbit/link-gateway` for a link of its own | The gateway's state: `tls/fullchain.pem` and `tls/privkey.pem` for certificates from files, and `acme/` for certificates it obtains itself. Create it before starting. | Contains the TLS private key | Recreate `link-gateway` |
| `RUNNER_LINK_ENV_FILE` | `path` | Optional; `/dev/null`. A same-origin link writes `./deploy/runner-link/behind-web-gateway.env` | An env file merged into `link-gateway`'s environment; on a same-origin link it holds the internal addresses and ports. | No | Recreate `link-gateway` |
| `RUNNER_LINK_BIND` | `string` (address) | Optional; empty publishes on every interface. A same-origin link writes `127.0.0.1` | The host address the gateway's public port binds to. | No | Recreate `link-gateway` |
| `RUNNER_LINK_PORT` | `integer` | Optional; `8443`. A same-origin link writes `0`, a free port nobody uses | The host port for the gateway's own listener. ACME's TLS-ALPN-01 challenge needs `443`. | No | Recreate `link-gateway` |
| `RUNNER_LINK_METRICS_PORT` | `integer` | Optional; `9464`. A same-origin link writes `0` | The loopback-only port serving the gateway's `/metrics`. Keep it closed to the internet. | No | Recreate `link-gateway` |
| `RUNNER_LINK_ACME_DOMAINS` | `string` | Optional; empty | The link's host name for ACME certificates (TLS-ALPN-01), so the gateway obtains and renews them itself. | No | Recreate `link-gateway` |
| `RUNNER_LINK_ACME_EMAIL` | `string` | Optional; empty | Contact address for ACME registration. | No; it is published to the CA | Recreate `link-gateway` |
| `RUNNER_LINK_NATS_URL` | `URL` | Optional; `nats://nats:4222` | Where the apiserver publishes runner hints. | No | Recreate `apiserver` |
| `RUNNER_LINK_INTERNAL_PORT` | `integer` | Optional; Compose `3001` | The port of the apiserver's listener that serves the runner routes to the gateway alone. Never publish it. | No | Recreate `apiserver` and `link-gateway` |
| `RUNNER_LINK_INTERNAL_HOST` | `string` (address) | Optional; Compose `0.0.0.0`, outside Compose `127.0.0.1` | The address that listener binds. Inside the container, `0.0.0.0` means this project's network. | No | Recreate `apiserver` |
| `RUNNER_LINK_NATS_APISERVER_SEED` | `secret` (`SU…`) | Required with the `runner-link` profile; otherwise empty | The apiserver's NATS nkey seed. Given to the apiserver alone. | Yes | Recreate `apiserver` and `nats` |
| `RUNNER_LINK_NATS_APISERVER_KEY` | `string` (`U…`) | Required with the `runner-link` profile; otherwise empty | Its public key, given to `nats` alone. | No | Recreate `nats` |
| `RUNNER_LINK_NATS_GATEWAY_SEED` | `secret` (`SU…`) | Required with the `runner-link` profile; otherwise empty | The link gateway's NATS nkey seed. Given to the gateway alone. | Yes | Recreate `link-gateway` and `nats` |
| `RUNNER_LINK_NATS_GATEWAY_KEY` | `string` (`U…`) | Required with the `runner-link` profile; otherwise empty | Its public key, given to `nats` alone. | No | Recreate `nats` |

Make a NATS pair with `docker compose --profile runner-link run --rm --no-deps link-gateway nkey`, which prints
`seed=SU…` and `public=U…` once and keeps no copy. A seed is a credential: keep the four values with this
deployment's other secrets.

### Claude region check

Before a Claude Code turn that talks to Anthropic (the machine's own Claude sign-in, an Anthropic API key or a Claude
pool), the runner asks the API which country its Claude connection comes out in: one request to
`GET /api/runner/region-check`, sent through the proxy Claude Code uses for `api.anthropic.com`. The API answers from
Cloudflare's headers and Anthropic's [Supported Regions Policy](https://www.anthropic.com/legal/supported-regions), as
copied into Orbit. Where Anthropic doesn't offer Claude, that machine starts no Anthropic-bound Claude turn and no Claude
sign-in. Claude Code turns on other providers' keys are not checked. There is no variable to set; the check depends on
how the deployment is reached:

- **It needs Cloudflare and `TRUSTED_PROXIES`.** The API reads the country from Cloudflare's `CF-IPCountry` header,
  and Ukraine's region from `cf-region-code`, only when the address that connected to the gateway (`X-Real-IP`) is in
  `TRUSTED_PROXIES`. So the deployment has to be behind Cloudflare, with Cloudflare's ranges
  (<https://www.cloudflare.com/ips/>) in `TRUSTED_PROXIES`. From any other address those headers are whatever the client
  wrote, and the API ignores them. `cf-region-code` comes from the zone's **Add visitor location headers** Managed
  Transform; without it, a connection from Ukraine reads as unknown. Orbit bundles no GeoIP database.
- **A deployment without them never blocks.** Without Cloudflare, or with `TRUSTED_PROXIES` not listing it, every check
  answers unknown, and unknown counts as allowed. A check that fails counts the same way. An unknown result keeps a
  machine's last decided result for up to 24 hours, and a deployment that never decides one never blocks.
- **What the check does not see:**
  - Only Claude's own connection. A proxy that comes out in a supported region passes, wherever the machine is.
  - Unknown counts as allowed. A self-hosted deployment without Cloudflare can't tell the region and never blocks.
    Production (orbitd.io) is behind Cloudflare.
  - A runner too old to run the check is not blocked until it updates itself.
  - Who controls the account. Anthropic's terms also restrict companies controlled from unsupported regions; that is
    not a property of a network connection.
  - Anthropic's list is copied into Orbit by hand, with its date and source, and changes with an Orbit release.

For each machine, the API keeps the country and region the last check decided, never an address.

## PostgreSQL and backups

These values are fixed inside Compose unless the table names a host substitution. Changing a
`POSTGRES_*` value does not update users/passwords in an existing data directory; coordinate SQL
credential changes and the API connection rather than deleting or reinitializing the database.

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `POSTGRES_USER` | `string` | Compose fixes `orbit` | Bootstrap database superuser on first initialization. | No | Initialization setting; existing cluster needs an explicit SQL change |
| `POSTGRES_PASSWORD` | `secret` | Compose fixes `orbit` | Bootstrap password; database port is not published by the included stack. | Yes | Rotate in SQL and update API connection; recreate affected services |
| `POSTGRES_DB` | `string` | Compose fixes `orbit` | Initial application database. | No | Initialization setting; coordinate an existing database change |
| `PGHOST` | `path` | Backup service fixes `/var/run/postgresql` | Backup connection over the shared Unix socket. | No | Recreate backup service after editing Compose |
| `PGUSER` | `string` | Backup service fixes `orbit` | Database role running the backup; matches the bootstrap superuser. | No | Recreate backup service; coordinate database role changes |
| `PGDATABASE` | `string` | Backup service fixes `postgres` | Maintenance database for backup commands. | No | Recreate backup service after editing Compose |
| `ORBIT_BASE_BACKUP_INTERVAL` | `integer` (seconds) | Optional; `86400` | Time between base backups. With `ORBIT_BASE_BACKUP_KEEP` it says how far back a retained backup reaches: an expired file's bytes go no sooner than max(7 days, interval × (keep + 1)) after its tombstone. | No | Recreate `pgbackup` and `apiserver` |
| `ORBIT_BASE_BACKUP_KEEP` | `integer` (count) | Optional; `2` | Number of base backups retained; retention bounds available recovery history. With the interval, it also sets that grace period. | No | Recreate `pgbackup` and `apiserver` |
| `ORBIT_BACKUP_MIN_FREE_MB` | `integer` (MiB) | Optional; `2048` | Minimum free space to leave; a backup that cannot meet it is skipped with an error. | No | Recreate `pgbackup` |
| `ORBIT_BACKUP_SYNC_TARGET` | `string` | Optional; empty means local only | SSH rsync destination dedicated to the archive. The mirror deletes unrelated destination files. `./data/files` is copied beside it, to `<target>-files`, so the SSH user must be able to create that directory too. | No; redact private host/path | Recreate `pgbackup` |
| `ORBIT_BACKUP_SYNC_SSH_PORT` | `integer` | Optional; `22` | SSH port for the off-host mirror. | No | Recreate `pgbackup` |
| `ORBIT_BACKUP_SSH_DIR` | `path` | Optional; `/root/.ssh` | Host directory mounted read-only at `/ssh`, containing `id_rsa` and `known_hosts` for the mirror. | Contents include a private key | Recreate `pgbackup`; keep host-key checking enabled |

The data and local archive live at `./data/postgres` and `./data/pg-archive`. Local backups share the
database disk; configure an off-host copy and test restoration using the
[backup and restore runbook](postgres-backup-restore.md).

## Ports and endpoints

The included stack publishes one port to the host. Everything else is reachable only inside Compose's project
network.

| Port | Service | Reachable from | Purpose |
| --- | --- | --- | --- |
| `2086/tcp` | `gateway` (nginx) | Every host interface, unless the host firewall narrows it | The only public entrance: the web UI, `/api`, `/runner-link` WebSocket upgrades, `/dl` runner downloads, and `/healthz`. |
| `80/tcp` | `web` | The Compose project network | The built web bundle and its `/healthz`. |
| `3000/tcp` | `apiserver` | The Compose project network | The HTTP API, under `/api`. |
| `3001/tcp` | `apiserver` | The Compose project network, while the runner link is configured | The runner-link call listener. It answers the gateway alone and requires `RUNNER_LINK_GATEWAY_TOKEN`; never publish it. |
| `5432/tcp` | `postgres` | The Compose project network | PostgreSQL. Not published to the host. |
| `4222/tcp` | `nats` | The Compose project network, under the `runner-link` profile | Runner hints. |
| `8443/tcp` | `link-gateway` | The host, bound by `RUNNER_LINK_BIND`, published as `RUNNER_LINK_PORT` | The link gateway's own WebSocket listener on a link with a host name of its own. A same-origin link sets `RUNNER_LINK_PORT=0` and binds loopback, so nothing useful is published. |
| `9464/tcp` | `link-gateway` | Host loopback only | `/metrics`. Keep it closed to the internet. |
| `7300/tcp` | `docker-channel` on a channel host | Only the private addresses named by `--allow-peer` | The remote channel host's control API, over a private link. |
| none | managed runner containers | The `orbit-managed-runners` network | Runners reach the deployment through the gateway's published port; they publish nothing themselves. |

On the runner machine, Orbit publishes no port: the runner makes outbound HTTPS and WebSocket connections only.

## Data and storage paths

Paths are relative to the deployment checkout unless the row says otherwise. Back them up together, and keep the
two secrets (`JWT_SECRET`, `PROVIDER_SECRET_KEY`) in the same protected backup.

| Path | What it holds | Backup |
| --- | --- | --- |
| `./data/postgres` | The PostgreSQL data directory. | `pgbackup` base backups plus archived WAL. |
| `./data/pg-archive` | `base/` base backups and `wal/` archived WAL segments. | Mirrored to `ORBIT_BACKUP_SYNC_TARGET` when set. |
| `./data/files` | Attachment bytes of the local store, and `tmp/` for uploads in flight. Mounted at `/var/lib/orbit/files`. | Copied to `<target>-files` beside the off-host mirror; with `ORBIT_FILES_BACKEND=s3`, the bucket holds them instead. |
| `./data/files/tmp` | Upload staging. Each apiserver start removes files there untouched for a day. | No. |
| `./data/managed-runners` | `profile.json`, `channel.json`, the channel's token and socket, and runner state. | No built-in backup; losing the token re-issues it, and losing the profile loses the runner limits. |
| `RUNNER_LINK_GATEWAY_DIR` | `tls/` certificates and `acme/` state for the link gateway. | The certificates are renewable; keep them if they come from files. |
| `ORBIT_BACKUP_SSH_DIR` | The mirror's `id_rsa` and `known_hosts`, mounted read-only at `/ssh`. | Keep with the deployment's secrets. |
| `pg-socket` (Docker volume) | The PostgreSQL Unix socket shared by `postgres` and `pgbackup`. | No; it is recreated with the containers. |
| `$ORBIT_HOME` (runner machine, default `~/.orbit`) | `config.json` (server URL and runner credential), `user.json` (a CLI login), and `worktrees/` (session checkouts). | No; a runner re-registers, and checkouts are disposable. |

## Retention

What the stack keeps, and for how long. Durations are fixed unless a variable is named.

| Data | Retained | Set by |
| --- | --- | --- |
| Base backups and their WAL | `ORBIT_BASE_BACKUP_KEEP` backups, one every `ORBIT_BASE_BACKUP_INTERVAL` seconds; an expired file's bytes are freed no sooner than max(7 days, interval × (keep + 1)) after its tombstone. | `ORBIT_BASE_BACKUP_KEEP`, `ORBIT_BASE_BACKUP_INTERVAL` |
| Attachment bytes | Per [File retention and quota](self-hosting.md#file-retention-and-quota): agent uploads expire 14 to 30 days after upload unless evidence cites them; a pinned file never expires. | Fixed, plus `ORBIT_FILES_QUOTA_BYTES` for the per-account cap |
| A session in Trash | 30 days, after which an hourly purge deletes it and its events, turns, tool calls, usage, approvals and diff. A file that is pinned or still cited by evidence keeps the session in Trash past the 30 days. Emptying Trash by hand deletes at once. | Fixed (`TRASH_RETENTION_DAYS`) |
| A wiki space's Trash | 365 days; a restore brings entries back. | Fixed |
| User access tokens | `ACCESS_TOKEN_TTL` (default 7 days); a refresh token lasts 30 days. | `ACCESS_TOKEN_TTL` |
| Runner-link connection tokens | One hour; revocations are deleted once every token minted with them has expired. | Fixed |
| Container logs | `100 MB` per container, at most five rotated files (older ones compressed), for every service in the stack. A gateway's access log therefore holds a few days of traffic. | `x-logging` in [docker-compose.yml](../docker-compose.yml) |
| Managed runner data volumes | Until the runner's container and volume are removed; a volume over its limit stops the runner rather than deleting data. | Operator |

Session and wiki records otherwise live until their owner deletes them; there is no time-based deletion of run
events or transcripts.

## Optional Compose files

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `COMPOSE_FILE` | `string` (colon-separated list) | Optional; `docker-compose.yml` | Extra Compose files merged into every Compose command in the checkout. The included one signs this deployment's published macOS runner binaries with a Developer ID, so a Mac keeps its privacy (TCC) answers across runner updates ([release process](release-process.md#macos-runner-signature)). | No | Every `docker compose` command reads it |
| `ORBIT_MACOS_SIGNING_P12` | `path` | Required with the signing file; no default | The Developer ID `.p12`. Read as a BuildKit secret, which reaches only the signing step, never an image layer. Keep it outside the checkout. | Yes | Rebuild `web` |
| `ORBIT_MACOS_SIGNING_PASSWORD_FILE` | `path` | Required with the signing file; no default | A file holding the `.p12`'s password. Read the same way. | Yes | Rebuild `web` |

Enable signing by setting all three in `.env`:

```dotenv
COMPOSE_FILE=docker-compose.yml:deploy/macos-runner-signing.yml
ORBIT_MACOS_SIGNING_P12=/root/orbit-signing/developer-id.p12
ORBIT_MACOS_SIGNING_PASSWORD_FILE=/root/orbit-signing/developer-id.password
```

Both files stay on the host, readable only by the deploying account, outside the checkout.

Two more files pin the PostgreSQL image and put a TCP proxy in front of the database, for a host that runs its
database as a standby first or moves it later ([PostgreSQL standby and database proxy](postgres-standby.md)):
`deploy/postgres-pinned.yml` pins `postgres` and `pgbackup` to PostgreSQL 16.14 by digest, and
`deploy/db-proxy.yml` adds `db-proxy` and points the apiserver and wiki-worker at it.

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `ORBIT_REGISTRY` | `string` (host[:port]) | Optional; `docker.io` | Where those two files pull their images from, each by a fixed digest, so the registry cannot change what runs. Production's is the WireGuard-only `10.66.0.1:5000`. | No | The next `up` recreates `postgres`, `pgbackup` and `db-proxy`: a database restart |
| `ORBIT_DB_PROXY_TARGET` | `string` (host:port) | Optional with `deploy/db-proxy.yml`; `postgres:5432` | The database `db-proxy` forwards to. A name is resolved through Docker's DNS and followed when its container is recreated. To move it without recreating the proxy, use the proxy's runtime API ([switching the target](postgres-standby.md#switching-the-target)). | No | `docker compose up -d --no-deps db-proxy`: every database connection ends once and reconnects; the apiserver is not restarted |

```dotenv
COMPOSE_FILE=docker-compose.yml:deploy/postgres-pinned.yml:deploy/db-proxy.yml
ORBIT_REGISTRY=10.66.0.1:5000
```

## Runner machine only

Do not put runtime credentials in the server's `.env`. Run registration and authentication as the OS
account that will run the service. By default registration stores the server URL and long-lived
credential in `~/.orbit/config.json`; that file is private and must not be posted for diagnosis.

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `ORBIT_RUNNER_TOKEN` | `secret` | Issued by registration; no public default | Long-lived machine credential; also available to authorized CLI/session contexts. Never invent or share it. | Yes | Re-register when revoked; registration restarts the installed service |
| `ANTHROPIC_API_KEY` | `secret` | Optional; unset uses local login | Usage-billed Claude Code authentication on the runner. | Yes | Update the service's private environment and restart it |
| `CLAUDE_CODE_OAUTH_TOKEN` | `secret` | Optional; unset uses local login | Non-interactive subscription authentication from the runtime's token setup flow. | Yes | Update the service's private environment and restart it |
| `ORBIT_HOME` | `path` | Optional; `~/.orbit` | Runner configuration and run scratch directory, and the CLI's saved login (`user.json`). A shell and service must use the same home. Session checkouts are made in its `worktrees` directory, cloned from the workspace's checkout where both are on one filesystem that can clone files: [Session checkouts on the runner's disk](self-hosting.md#session-checkouts-on-the-runners-disk). | Directory contains credentials | Update the service configuration and restart it |
| `ORBIT_NO_SELFUPDATE` | `flag` | Optional; unset | Disables runner self-updates. | No | Restart runner with the setting |
| `ORBIT_NO_ENGINE_UPDATE` | `flag` | Optional; unset | Disables periodic coding-runtime updates. | No | Restart runner with the setting |

An export in an interactive shell does not update an already-running systemd/launchd service. Use
`orbit doctor` to inspect the selected runtime and service PATH; see
[runner troubleshooting](runner-troubleshooting.md) and [CLI automation](runner-cli.md).

## CLI acting as a person

The `orbit` CLI can act as a user with a personal access token, on any machine and with or without a runner.
`orbit login` (approved in the browser, or `--with-token` from stdin) saves the token and its server in
`$ORBIT_HOME/user.json` (mode `0600`), apart from the runner's `config.json`; the runner service never reads it.
These variables take its place where a saved login is impractical, such as CI. See
[personal access tokens](runner-cli.md#personal-access-tokens).

| Variable | Type | Required / default | Purpose | Secret? | Apply change |
| --- | --- | --- | --- | --- | --- |
| `ORBIT_USER_TOKEN` | `secret` | Optional; unset uses the saved login | A personal access token (Settings → Access tokens) the CLI acts as, in place of `user.json`. Ignored inside an Orbit session and in any process the runner starts for one (both ignore `user.json` too), and never passed to agent processes. | Yes | Next CLI command |
| `ORBIT_SERVER_URL` | `URL` | Optional; the runner's server, else the server the binary was built for | The server `ORBIT_USER_TOKEN` belongs to, and the default for `orbit login --server`. A saved login always uses its own server. | No; redact private origin | Next CLI command |
