# Orbit Cloud browser: design (v1)

**Status:** **decided** (owner, 2026-11-17), nothing built. P1 A, P2 B, P3 B, P4 A, P5 A. Board: `docs/mocks/runner-browser/`.

An agent on an Orbit Cloud runner (the account's managed runner) drives a real Chrome, and the owner watches that
Chrome live in their own browser and can take control of it. When the agent's run does not go as expected, the owner
sees what the agent saw instead of guessing from a transcript.

Owner requirements (2026-11-17):

- the owner can **watch and take control** (WebVNC), not only read screenshots;
- the feature **can be switched off**; it can be switched on **only for Orbit Cloud** (managed runners), and a
  default deployment has it **off**;
- the owner can **open the browser themselves** and sign in to sites; those logins are kept and the agents use them;
- the **whole runner shares one browser** (P2 = B): one Chrome, one saved profile, one session using it at a time;
- **taking control does not stop the agent** (P3 = B): the owner's input and the agent's run side by side.

## 1. Today

- The managed runner image (`deploy/managed-runner/image/Dockerfile`) has no browser and no display. Its apt line is
  `bash ca-certificates curl git openssh-client ripgrep sqlite3 python3 procps tini` plus the engine CLIs.
- The container is locked down: uid 10001, read-only root, every capability dropped, `no-new-privileges`, the
  runtime's default seccomp, private IPC, `/tmp` a tmpfs counted in the memory limit
  (`deploy/managed-runner/docker-channel/channel.py`, `deploy/managed-runner/runner-pod.yaml.example`).
- Nothing reaches into the container: no published port (`PortBindings: {}`), and the host firewall leaves a
  runner only the gateway's port, DNS and public addresses (`deploy/managed-runner/firewall/README.md`).
- The runner link (`contracts/runner-link/v1/runner_link.proto`, `docs/runner-link-design.md`) carries hints down,
  RPCs, heartbeats, durable events and best-effort live deltas up. Its `TunnelRequest` is the runner calling the
  apiserver, not a byte stream the server can open into the runner. There is no server-initiated stream.

So a viewer needs three new things: a browser and display in the image, a byte stream from the server into the
runner over the existing link, and a viewer in the client.

## 2. The switch

| Variable | Read as | Effect |
| --- | --- | --- |
| `ORBIT_MANAGED_RUNNERS_ENABLED` | existing gate (`managed-runner-gate.ts`) | no managed runners, no browser |
| `ORBIT_MANAGED_RUNNER_BROWSER_ENABLED` | new, the same strict table: absent, empty or `false` = off; `true` = on; anything else = off and one warning | on only if the first is also on |

- **Default off.** `scripts/install-server.sh` and `/upgrade` never write the new variable, and `.env.example` shows
  it commented out. A deployment that never sets it never has the feature. Orbit Cloud's production environment
  sets it to `true`.
- **Managed runners only.** The server offers a browser only to a runner whose link `Hello` carries a
  `ManagedInstance` that matches the manager's record (generation and Pod UID, as the control plane already checks).
  A self-hosted runner is never offered it, whatever the switches say, and the runner binary itself only accepts a
  stream when it was started by the managed image's entrypoint (`ORBIT_MANAGED_RUNNER_GENERATION` set). Two checks,
  either one enough to refuse.
- **Off means absent, not disabled.** No browser MCP server is given to an engine, no Chrome starts, the viewer
  route answers 404 (as the managed-runner routes do when that gate is off), and no client draws a Browser entry.
- **Read once at start**, like the existing gate. Switching it off and restarting the apiserver ends open streams;
  runners learn it from the next `Welcome` (`Welcome.browser`) and stop their displays after the running turn.

## 3. Inside the runner

- **Image.** Add `chromium`, `xvfb`, `x11vnc` and fonts (`fonts-noto-cjk`, `fonts-noto-color-emoji`) from the same
  dated Debian snapshot, and `@playwright/mcp` pinned like the other npm tools. Each gets a version check in the
  `tool-versions.json` step. About +350 MB. No websockify: the server side speaks WebSocket, the container only raw
  RFB on a local socket.
- **One browser per runner, started on demand.** One `Xvfb :1` (1280×800) and one Chrome, with its profile at
  `/home/orbit/.orbit/browser/profile` on the runner's volume, so logins survive restarts and image rolls (not a
  volume rebuild). It starts at the first browser tool call or when the owner presses **Open browser**, and stops
  after 15 minutes with no tool call and no viewer. Nothing runs on a runner that never uses a browser.
- **One session at a time (the browser lease).** The first session whose agent calls a browser tool holds the lease
  until its turn ends or it has made no browser call for 5 minutes. Another session's browser call meanwhile returns a
  tool error naming the holder ("The browser is in use by session …; try again after it finishes"), so the agent can
  wait or do other work. The owner is never refused and never takes the lease: their input goes to the browser
  whoever holds it (§5).
- **Shared state is accepted.** Sessions see each other's tabs, history and logins. Every agent on the runner can act
  on any site the profile is signed in to; the UI says so where the owner signs in (§5).
- **Chrome flags.** `--no-sandbox` (the container drops every capability and sets `no-new-privileges`, so Chrome's
  own sandbox cannot start; the container is the boundary), `--disable-dev-shm-usage` (small `/dev/shm` in a private
  IPC namespace). The profile on the volume, not on `/tmp`, so it does not eat the memory limit.
- **The agent's tool.** The runner gives each engine a `browser` MCP server (`@playwright/mcp --cdp-endpoint` at the
  runner's Chrome, behind the lease), the way it already gives `orbit mcp` (`claude_spawn.go`, `codex.go`,
  `cursor_mcp.go`, `dsh_mcp.go`). Only when the switch is on.
- **VNC.** `x11vnc -display :1 -unixsock /home/orbit/.orbit/browser/vnc.sock -shared -forever -nopw`, started with the
  display. Unix socket only: no TCP port, not even loopback. The runner is the only thing that connects to it.
- **Budget.** One Chrome, about 0.5–1.5 GiB, so the operator raises the runner's memory limit by about 1.5 GiB.

## 4. The stream

```
owner's browser ──WSS──▶ nginx ──▶ apiserver /api/runners/:id/browser/vnc
                                     │ checks: switch on, owner of the runner, runner managed
                                     ▼
                                   NATS  rnr.<runnerId>  (StreamOpen, request/reply)
                                   NATS  vnc.<streamId>.down / .up  (bytes)
                                     ▼
                                   link gateway holding the runner's connection
                                     ▼  link frames: StreamOpen / StreamData / StreamCredit / StreamClose
                                   runner ──▶ ~/.orbit/browser/vnc.sock (x11vnc)
```

- **Protocol (link minor version).** Four new `Frame` bodies: `StreamOpen{stream_id, kind: VNC}` (down),
  `StreamOpened{stream_id}` or `StreamClose{stream_id, code}` (up), `StreamData{stream_id, bytes}` (both),
  `StreamCredit{stream_id, bytes}` (both). Data rides the lowest write tier, below live deltas, and never blocks
  control frames; a window of 256 KiB per stream, refilled by `StreamCredit`. A runner that did not announce the
  capability in `Hello` is never sent `StreamOpen`.
- **Gateway.** Answers the apiserver's `StreamOpen` request on `rnr.<runnerId>` only if it holds a connection of that
  runner whose `Hello` named a `ManagedInstance` and whose `Welcome` offered the browser (the welcome route's verdict
  on that instance against the manager's record, §2), then relays `vnc.<streamId>.*` to and from link frames. At most 2 open streams per runner (two
  tabs or devices watching). The gateway's NATS user gets `vnc.>`; nothing else changes in its permissions.
- **Apiserver.** A WebSocket route behind the new gate. It authenticates the owner's web session, checks the
  runner is the caller's managed runner, opens the stream, and pipes bytes. A viewer that
  closes the tab closes the stream; the runner closes its socket connection.
- **nginx.** An upgrade location for the route, with the long-stream settings the SSE routes needed (no
  `max_fails` on the stream upstream, long read timeout).

## 5. The viewer (web first)

Two ways in, one viewer (the existing right-side `Drawer` with a noVNC canvas, `@novnc/novnc` pinned, scaled to fit):

- **From a session.** A **Browser** chip in the outputs bar, shown when the switch is on, the session runs on the
  managed runner and the browser is running. The drawer's header says which session holds the browser.
- **On its own.** The Orbit Cloud runner's page in Settings gets a **Browser** section: **Open browser**, which starts
  Chrome if needed and opens the drawer already in control (the owner came to type), the saved-logins line
  ("Sites you sign in to here stay signed in on this runner. Agents on this runner can use them."), and
  **Clear saved logins**, which stops Chrome and deletes the profile after a confirmation.

Control (P3 = B, shared input):

- **View only by default** from a session. **Take control** sends pointer and keys; the header then says "You are
  controlling the browser · the agent keeps running".
- **Taking control does not interrupt the agent.** The owner and the agent both act on the same page; the agent sees
  the owner's changes in its next page snapshot. The owner who wants the agent to stop uses the session's existing
  Stop. Opening the browser from Settings while a session holds it says so in the drawer's footer and asks nothing.
- **Hand back** (from a session) or **Done** (from Settings) only stops sending input. Nothing is sent to the agent.
- macOS, iOS and Android come later; they can host the same noVNC page in a web view.

## 6. Security

- The stream shows whatever the agent's Chrome shows, logged-in pages included. Only the runner's owner can open it in
  v1; guests of a shared session cannot.
- Saved logins are cookies in the profile on the runner's volume. They are as safe as the volume, every agent on the
  runner can use them, and **Clear saved logins** removes them. Passwords typed in the viewer cross the encrypted
  stream and are not stored by Orbit.
- No new inbound port and no firewall change. The stream comes in over the runner's own outbound link.
- No VNC password: the socket is reachable only inside the container, and every stream is authorised by the
  apiserver before it is opened.
- Chrome's egress is the runner's: public addresses only.
- Nothing is recorded. The agent's own screenshots stay in the transcript as today.

## 7. Decisions

| # | Question | A | B | Decision |
| --- | --- | --- | --- | --- |
| P1 | Image | one image, browser always in it, started only when on | a second `-browser` image the manager picks when on | **decided A** (owner, 2026-11-17) |
| P2 | Display | one per session, on demand | one per runner, shared by its sessions | **decided B** (owner, 2026-11-17): logins persist and agents use them |
| P3 | Take control | interrupts the agent's turn | shared input, the agent keeps running | **decided B** (owner, 2026-11-17) |
| P4 | Who can watch | the runner's owner only | owner and session guests | **decided A** (owner, 2026-11-17) |
| P5 | Clients in v1 | web only | web and macOS | **decided A** (owner, 2026-11-17) |

## 8. Phases (by cost)

1. **Switch and browser in the image** — the gate, `Welcome.browser`, image packages, the runner's browser and its lease, the
   `browser` MCP server for Claude Code and Codex first. Agents can use a browser; nobody watches yet.
2. **Stream** — the four link frames, gateway relay, apiserver WebSocket route, nginx location, runner socket bridge.
3. **Web viewer** — Browser chip, Settings' Open browser and Clear saved logins, drawer, view only, take control
   and hand back (shared input).
4. **Later** — the remaining engines, native clients, guests.

Each phase is tested on the managed-runner lab (`scripts/managed-runner/lab/`) with the switch on, and with it off to
show nothing changes.
