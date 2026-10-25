# Dependency security baseline

This page records Orbit's first production dependency review. It is evidence for a point in time, not a claim
that dependencies remain safe indefinitely. See the [security policy](../SECURITY.md#dependency-vulnerability-handling)
for the recurring controls and response targets.

## Baseline and decision

On 2026-08-20, `npm audit --omit=dev` reported 12 affected production packages: 3 high and 9 moderate. The
review treated an alert as reachable whenever untrusted network or file input crossed the affected component.
All affected packages were upgraded, even where the vulnerable function was not reachable, so no risk
acceptance is needed for this baseline.

| Package | Locked before | Reachability | Disposition | Locked after |
| --- | --- | --- | --- | --- |
| `@nestjs/common` | 10.4.22 | Direct server framework dependency. Orbit does not use Nest's `FileTypeValidator`, but the package is present in every API process. | Upgrade with the Nest 11 runtime. | 11.2.1 |
| `@nestjs/config` | 3.3.0 | Used at process startup. Orbit does not pass request data to the affected Lodash template/path helpers. | Upgrade; remove the vulnerable Lodash version transitively. | 4.0.4 |
| `@nestjs/core` | 10.4.22 | Direct and reachable for every controller, provider, and request. | Upgrade to the patched framework line. | 11.2.1 |
| `@nestjs/platform-express` | 10.4.22 | Direct HTTP adapter; reachable for every API request and file upload. | Upgrade together with Nest core. | 11.2.1 |
| `body-parser` | 1.20.4 | Transitive request parser; reachable from untrusted HTTP bodies. | Upgrade through the Nest/Express update. | 2.3.0 |
| `express` | 4.22.1 | Transitive HTTP runtime; reachable for every API request. | Upgrade through the Nest adapter update. | 5.2.1 |
| `file-type` | 20.4.1 | No direct import or `FileTypeValidator` use was found, so the vulnerable parsers were not reachable in Orbit. | Upgrade through `@nestjs/common`; no exception retained. | 21.3.4 |
| `lodash` | 4.17.21 | No direct import was found. It was used internally by `@nestjs/config`, while Orbit's configuration sources are operator-controlled. | Upgrade through `@nestjs/config`; no exception retained. | 4.18.1 |
| `multer` | 2.0.2 | Reachable through `FileInterceptor` in attachment and runner upload endpoints. Existing file-size caps reduce impact but do not address cleanup and nesting DoS cases. | Upgrade through the Nest adapter update. | 2.2.0 |
| `qs` | 6.14.2 | Transitive query parser; reachable from untrusted query strings. | Upgrade through Express/body-parser. | 6.15.3 |
| `react-router` | 6.30.4 | The SSR hydration issue is not reachable because Orbit is a client-only SPA. Navigation APIs are active throughout the UI, so the redirect class remains relevant. | Upgrade the router runtime. | 7.18.2 |
| `react-router-dom` | 6.30.4 | Direct client runtime with extensive `Link` and `useNavigate` use. Targets are built from static paths or encoded Orbit IDs, but the open-redirect class warrants removal. | Upgrade and run the full web suite. | 7.18.2 |

The original findings were associated with
[Nest core injection](https://github.com/advisories/GHSA-36xv-jgw5-4q75),
[body-parser limits](https://github.com/advisories/GHSA-v422-hmwv-36x6),
[file-type ASF parsing](https://github.com/advisories/GHSA-5v7r-6r5c-r473),
[file-type ZIP handling](https://github.com/advisories/GHSA-j47w-4g3g-c36v),
[Lodash template injection](https://github.com/advisories/GHSA-r5fr-rjxr-66jc),
[Lodash path pollution](https://github.com/advisories/GHSA-f23m-r3pf-42rh),
[Multer upload handling](https://github.com/advisories/GHSA-72gw-mp4g-v24j),
[qs denial of service](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), and
[React Router navigation](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6).

The same maintenance change upgrades Vite, Vitest, and the React plugin to remove development-tool findings.
The root Node.js requirement is therefore 20.19 or newer.

## Active overrides

| Override | Reason | Removal condition |
| --- | --- | --- |
| `deepmerge-ts` pinned to `^8.0.2` | Prisma 7.9.1's CLI pins `@prisma/config` to `deepmerge-ts` 7.1.5, which carries [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) (high; stack exhaustion when merging recursive object graphs). The package reaches the production tree through `@prisma/client`'s optional `prisma` peer, so it is not a dev-only finding. `@prisma/config` uses only `deepmerge` as c12's config merger, and 8.x keeps that export with the same semantics for plain objects. | Drop the `overrides` entry once a Prisma release depends on `deepmerge-ts` 8 or later. |
| `katex` pinned to `^0.18.2` | `micromark-extension-math` 3.1.0, which the `markdownlint` documentation linter pins, asks for `katex` `^0.16.0`, and no 0.16 release fixes [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (low; inherited `Object.prototype` properties, `trust` among them, are read as renderer options). The extension calls only `katex.renderToString`, which 0.17 and 0.18 left unchanged: their breaking changes are the internal `__defineFunction` API and prefixed CSS class names. | Drop the `overrides` entry once the `markdownlint` release in use resolves a `micromark-extension-math` that accepts `katex` 0.18.2 or later. |
| `@deepseek-ai/libreoffice-kit` → `fflate` pinned to `0.8.3` in `scripts/deepseek-harness-p0/package.json` | The P0 harness's `@deepseek-ai/libreoffice-kit` 0.1.5 pins vulnerable `fflate` 0.8.2 exactly; the scoped override fixes [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) while retaining the recorded DSH release. | Remove when the harness adopts an upstream `libreoffice-kit` release whose dependency resolves to patched `fflate` without the override, or when the P0 harness is retired. |

## Multer aborted-upload cleanup (2026-09-30)

[Dependabot alert #67](https://github.com/jianghailong-xy/orbit/security/dependabot/67) reports
[GHSA-3pph-fpjx-jg34](https://github.com/expressjs/multer/security/advisories/GHSA-3pph-fpjx-jg34):
Multer versions from 2.2.0 up to, but excluding, 2.4.0 can leave orphaned disk files after aborted uploads.
Orbit's attachment, runner, and avatar `FileInterceptor` endpoints use default memory storage, so the
specific disk-storage race is not reachable with the current configuration. The lockfile nevertheless
upgrades Multer from 2.3.0 to the patched 2.4.0 and removes its unused `concat-stream` dependency tree.
The old `multer` override (`^2.3.0`) is removed because `@nestjs/platform-express` 12.1.0 already pins
Multer to 2.4.0; the upstream dependency now meets the override's removal condition.

## braces in the documentation linter (2026-10-03)

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (high; stack exhaustion through deeply
nested brace patterns) was widened on 2026-10-02 to every `braces` release through 3.0.3, with no patched version,
and `npm audit --audit-level=high` began failing the JavaScript job. The only path to `braces` was the
development-only documentation linter: `markdownlint-cli2` 0.23.3 → `globby` → `fast-glob` → `micromatch` →
`braces`. Every package in that chain was already its latest release and still depended on the next one, so no
upgrade or override could clear the advisory, and the fix npm offers downgrades `markdownlint-cli2` to 0.0.4.
`braces` only expanded the fixed list of tracked public Markdown paths that `npm run docs:check` passes to the
linter; it was not part of the production dependency tree.

`scripts/check-docs.mjs` now calls the `markdownlint` 0.41.1 library, the engine that `markdownlint-cli2` 0.23.3
pinned, with the `config` object from `.markdownlint-cli2.jsonc`, the same file list, and the CLI's issue format.
`markdownlint-cli2` and the 31 lockfile entries that only it used are removed and nothing is added, so no override
or audit exception is needed and the audit still gates development dependencies. On the documentation tree and
on a copy with deliberate errors in four files, the old and new checkers linted the same 32 files and printed
identical issue lines. The direct call drops the CLI features that were not in use: globs, per-directory
configuration files, other `.markdownlint-cli2.jsonc` options or comments in that file, YAML or JSONC
`markdownlint-configure-file` comments, and `--fix`.

Removal condition: keep the direct call while GHSA-vfj7-8cjw-p6xm has no patched `braces`. Return to
`markdownlint-cli2` only when one of those CLI features is needed and its release no longer resolves an affected
`braces`.

## fflate in the DeepSeek P0 harness (2026-10-04)

[GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) (CVE-2026-45820, moderate) affects
`fflate` 0.8.0 through 0.8.2: `unzipSync()` can loop indefinitely on a malformed ZIP64 archive. The independent
`scripts/deepseek-harness-p0/package-lock.json` contained 0.8.2 under `@deepseek-ai/libreoffice-kit` 0.1.5,
alongside an already-patched top-level 0.8.3. Root workspace audits do not cover this separate lockfile.

The affected dependency belongs to the local ACP contract experiment, outside Orbit's production workspaces.
Its office library processes ZIP-based documents; the ACP experiment does not exercise office conversion.
The upstream library's latest release still pins 0.8.2 exactly, so a harness-local scoped override upgrades
only that nested copy to 0.8.3. The lockfile's version, registry URL, and integrity are updated manually;
the fixed `@deepseek-ai/dsh` 0.2.0-rc.2 release and all other resolved packages stay the same.
The override's removal condition is listed above. Previously committed protocol recordings retain their
original lockfile hashes as historical evidence; fresh reproductions use the patched lockfile.

Audit this independent dependency tree separately:

```sh
npm audit --prefix scripts/deepseek-harness-p0 --package-lock-only
```

## proxy-addr, source-map-js and KaTeX (2026-10-06)

[Dependabot alerts #72](https://github.com/jianghailong-xy/orbit/security/dependabot/72),
[#73](https://github.com/jianghailong-xy/orbit/security/dependabot/73), and
[#74](https://github.com/jianghailong-xy/orbit/security/dependabot/74) cover three advisories that GitHub reviewed on
2026-10-05. `npm audit` reported the same three against the root lockfile; the P0 harness and `dsh-install`
lockfiles, `go.mod`, and the Swift packages were not affected.

| Package | Advisory | Locked before | Reachability | Locked after |
| --- | --- | --- | --- | --- |
| `proxy-addr` | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) (critical) | 2.0.7 | Production, through Express. Only a trust subnet written as IPv4-mapped IPv6 with a short prefix, such as `::ffff:10.0.0.0/8`, is affected: it matches every IPv4 client, which can then set `req.ip` through `X-Forwarded-For`. Orbit never sets Express's `trust proxy` and never reads `req.ip`; `visitorAddress` takes the nginx proxies' `X-Real-IP` or the socket address, so the flaw is not reachable. | 2.0.8 |
| `source-map-js` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high) | 1.2.1 | Development only, through `postcss` and `css-tree` in the Vite build, which reads only this repository's sources and their maps. | 1.2.2 |
| `katex` | [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (low) | 0.16.47 | Development only, through the documentation linter: `markdownlint` → `micromark-extension-math` → `katex`. The linter parses math syntax in tracked Markdown and never renders it. | 0.18.2 |

`proxy-addr` and `source-map-js` move inside the ranges their dependents ask for (`^2.0.7` from `express`, `^1.2.1`
from `postcss` and `css-tree`). KaTeX needs the root override listed under [Active overrides](#active-overrides); the
lockfile takes 0.18.2, the first patched release, which keeps KaTeX's own `commander` dependency at the locked 8.3.0.

## Runner link protocol dependencies (2026-10-25)

The runner link protocol (`contracts/runner-link`, designed in `docs/runner-link-design.md` §5.1) gives the runner its
first external Go module and adds protobuf code generation to `@orbit/shared`. Each package was reviewed before it was
added:

| Package | Version | Added to | Purpose | License |
| --- | --- | --- | --- | --- |
| `google.golang.org/protobuf` | v1.36.12 | `src/runner-go/go.mod` | Runtime of the generated `src/runner-go/linkpb`; `protoc-gen-go` is built from the same module. | BSD-3-Clause |
| `@bufbuild/protobuf` | 2.16.0 | `@orbit/shared` dependencies | Runtime of the generated `src/shared/src/runner-link`. | Apache-2.0 AND BSD-3-Clause |
| `@bufbuild/protoc-gen-es` | 2.16.0 | `@orbit/shared` devDependencies | Generates that TypeScript. Brings `@bufbuild/protoplugin` 2.16.0, its own `typescript` 5.4.5 and `@typescript/vfs` 1.6.5. | Apache-2.0 |
| `@bufbuild/buf` | 1.75.0 | `@orbit/shared` devDependencies | Runs `buf lint`, `buf breaking` and `buf generate`, in CI and locally. | Apache-2.0 |

- **Source and integrity.** `google.golang.org/protobuf` is the Go project's own protobuf implementation
  (go.googlesource.com/protobuf); the npm packages are Buf's, published from its protobuf-es and buf repositories.
  `go.sum` records the module's hashes, which the Go checksum database vouched for when it was downloaded, and
  `go mod verify` passes; `package-lock.json` pins every npm package by integrity. All four are pinned to exact
  versions, so each generator stays the same release as the runtime its output runs on.
- **Known vulnerabilities: none at these versions.** govulncheck v1.9.0 finds nothing reachable from `linkpb`, and its
  module scan lists only standard-library advisories of the scanning host's go1.27.1 toolchain (fixed in go1.27.2 and
  go1.27.3), none in this module. OSV lists nothing for any package above. The module's two past advisories,
  GO-2023-1631 (a panic on invalid messages, fixed in v1.29.1) and GO-2024-2611 (a `protojson` infinite loop, fixed in
  v1.33.0), predate v1.36.12. `npm audit` reports the same findings with and without these packages.
- **Reach.** Only `src/runner-go/linkpb` imports the module. The `orbit` binary does not import that package yet: built
  from this change it is byte-identical to the binary built from main, and its build downloads nothing. Once the link
  client imports `linkpb`, the binary will decode binary frames from the link gateway, over a TLS connection it
  authenticated; `protojson`, where GO-2024-2611 lived, is not on that path.
- **Transitive modules.** The module's `go.mod` requires `github.com/google/go-cmp` v0.7.0 and
  `github.com/golang/protobuf` v1.5.0 for its own tests. Neither is compiled into the runner: `go.sum` lists go-cmp
  only as a checksum, because a test of `internal/filedesc` imports it, and golang/protobuf is pruned from the graph.
- **Install scripts.** `@bufbuild/buf` declares a postinstall script, which npm does not run without approval
  (`allowScripts`). Nothing needs it: the package's `bin/buf` runs the binary from the matching optional
  `@bufbuild/buf-<platform>` package, which the lockfile pins as well. The other packages declare none.
- **Production tree.** `@bufbuild/protobuf` has no dependencies of its own. It enters the production tree through
  `@orbit/shared`, but `src/shared/src/index.ts` does not export the generated code, so neither the API server nor the
  web bundle loads any of it until something imports it.
- **Updates.** Dependabot's existing `npm` (`/`) and `gomod` (`/src/runner-go`) entries cover all four. Move
  `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` together, since the generator requires the runtime of its own
  version, and regenerate after updating any of the four (`npm run generate:runner-link -w @orbit/shared`).

Decision: accepted, with no override or audit exception.

## Link gateway dependencies (2026-10-25)

The runner link gateway (`src/link-gateway`, designed in `docs/runner-link-design.md` §6.1) is a Go module of its own and
a server on the public internet. It adds four external modules, reviewed before they were added. The protobuf runtime
is the version reviewed above, at the same release as the runner's:

| Module | Version | Purpose | License |
| --- | --- | --- | --- |
| `github.com/coder/websocket` | v1.8.15 | The WebSocket server, plus the dialer of the `client` test subcommand. | ISC |
| `golang.org/x/crypto` | v0.58.0 | `acme` and `acme/autocert`, for the ACME TLS mode: certificates obtained and renewed over TLS-ALPN-01. | BSD-3-Clause |
| `golang.org/x/net` | v0.60.0 | `idna`, which `autocert` imports to normalize host names. | BSD-3-Clause |
| `golang.org/x/text` | v0.43.0 | `secure/bidirule`, `transform` and `unicode/{bidi,norm}`, imported by `idna`. | BSD-3-Clause |
| `google.golang.org/protobuf` | v1.36.12 | The runtime of the generated `src/link-gateway/linkpb`. | BSD-3-Clause |

- **Source and integrity.**
  - `github.com/coder/websocket` is Coder's WebSocket library, the continuation of `nhooyr.io/websocket` since 2024.
    Its `go.mod` requires nothing, so it brings no further module. Besides Go, it holds the assembly of its frame
    masking for amd64 and arm64.
  - The `golang.org/x` modules are the Go project's own.
  - `go.sum` records every module's hash, which the Go checksum database vouched for when it was downloaded, and
    `go mod verify` passes. The image build runs `go mod verify` again before it compiles.
- **Known vulnerabilities.**
  - OSV lists nothing for `github.com/coder/websocket`, at this version or any earlier one (`nhooyr.io/websocket`
    included), and nothing for `golang.org/x/net` v0.60.0 or `golang.org/x/text` v0.43.0.
  - For `golang.org/x/crypto`, OSV lists GO-2026-5932: `golang.org/x/crypto/openpgp` is unmaintained and unsafe by
    design, and no version fixes it. The gateway imports only `acme` and `acme/autocert`, never `openpgp`.
  - govulncheck v1.9.0 with the scanning host's go1.27.1 found ten standard-library advisories reachable from the
    gateway's code (fourteen in its module scan). All are fixed in go1.27.2 and go1.27.3. That is a fact about the
    toolchain, but the gateway is a public TLS and HTTP server, so its image is built with **Go 1.27.3**
    (`golang:1.27.3-alpine`). The Dockerfile pins it and says never to lower it.
  - Run again with go1.27.3 (`GOTOOLCHAIN=go1.27.3`), govulncheck reports no vulnerability in the gateway's code.
    Its module scan reports only GO-2026-5932, which the gateway does not import.
- **Reach.**
  - The WebSocket library parses frames only from connections that have already passed the upgrade checks: the
    connection token is verified by the gateway's own code before `websocket.Accept` runs. An unauthenticated client
    reaches only Go's `net/http` and that verifier. Messages are capped at 256 KiB, and compression is off.
  - `acme` and `autocert` run only in the ACME TLS mode. There they answer TLS-ALPN-01 challenges in the TLS handshake,
    and `HostWhitelist` refuses any name not in `LINK_ACME_DOMAINS` before anything is asked of the CA. They talk only
    to the configured ACME directory, Let's Encrypt by default.
  - `protojson` is compiled in for `link-gateway dump -json`, an operator tool. It is not on the serving path.
- **Image.** The build stage is `golang:1.27.3-alpine`. The runtime is `scratch`, holding the binary and the build
  image's CA bundle, which the ACME client trusts: there is no shell or package manager to patch. The container runs
  read-only, with every capability dropped and `no-new-privileges` (`docker-compose.yml`, pinned by
  `test/compose-topology.test.mjs` (o)).
- **Updates.** Dependabot gains a `gomod` entry for `/src/link-gateway`. Keep `google.golang.org/protobuf` at the
  runner's version: `contracts/runner-link/buf.gen.yaml` builds each module's `protoc-gen-go` from that module's own
  `go.mod`. When a newer Go fixes an advisory that govulncheck reports for the gateway, raise the image's Go.

Decision: accepted, with no override or audit exception. GO-2026-5932 needs none, since its package is not imported.

## Runner link client dependencies (2026-10-25)

The runner's link client and its shadow connection (`src/runner-go/link_*.go`, `docs/runner-link-design.md` §7 and
§11.2) give the `orbit` binary its first compiled-in external modules. Both are the versions reviewed above:

| Module | Version | Purpose | License |
| --- | --- | --- | --- |
| `github.com/coder/websocket` | v1.8.15 | The link's WebSocket dialer. New in `src/runner-go/go.mod`. | ISC |
| `google.golang.org/protobuf` | v1.36.12 | The runtime of `src/runner-go/linkpb`, which the binary now imports. | BSD-3-Clause |

- **Source and integrity.** The same releases the link gateway builds with. `github.com/coder/websocket` requires no
  module of its own, so `go.sum` gains its two hashes and nothing else, and `go mod verify` passes.
- **Known vulnerabilities.** OSV lists nothing for either module at these versions, nor for `github.com/coder/websocket`
  at any version (`nhooyr.io/websocket` included). govulncheck v1.9.0 with the scanning host's go1.27.1 finds nothing in
  either module. What it reports for the runner is standard-library advisories of that toolchain: ten reachable from the
  runner's code, fourteen in its module scan, all fixed in go1.27.2. These are the gateway's toolchain findings above.
- **Reach.** The runner only dials. It reads frames from the connections it opened itself, over TLS verified against the
  system's roots, to the link address the control plane hands out with the link token. A message is capped at 256 KiB
  (a frame in pieces at 8 MiB), and compression is off. During the shadow period nothing it reads changes the runner's
  work: it counts answers, and follows Drain and Close. With the shadow off (`ORBIT_LINK_SHADOW=0`), only
  `orbit doctor` dials the link.
- **Updates.** Dependabot's existing `gomod` entry for `/src/runner-go` covers both. Keep them at the gateway's
  versions.

Decision: accepted, with no override or audit exception.

## NATS clients for runner link hints (2026-10-25)

The runner link's hints (`docs/runner-link-design.md` §5.5, §6.3; task B1) are published by the apiserver on NATS and
relayed by the link gateway, so each side gains NATS's own client. Both were reviewed before they were added. The server
is the official image.

| Package | Version | Added to | Purpose | License |
| --- | --- | --- | --- | --- |
| `@nats-io/transport-node` | 3.4.0 | `@orbit/apiserver` dependencies | The client the apiserver publishes hints with (`src/apiserver/src/realtime/runner-hints.ts`). | Apache-2.0 |
| `@nats-io/nats-core` | 3.4.0 | its dependency | The protocol client under the Node transport. | Apache-2.0 |
| `@nats-io/nkeys` | 2.0.3 | its dependency | NKey and JWT authentication, for a server that asks for it; this deployment's does not. | Apache-2.0 |
| `@nats-io/nuid` | 3.0.0 | its dependency | Unique ids for request inboxes. | Apache-2.0 |
| `tweetnacl` | 1.0.3 | through `@nats-io/nkeys` | Ed25519 for NKeys. | Unlicense |
| `github.com/nats-io/nats.go` | v1.55.0 | `src/link-gateway/go.mod` | The client the gateway subscribes with (`src/link-gateway/hints.go`). | Apache-2.0 |
| `github.com/nats-io/nkeys` | v0.4.16 | indirect | NKey authentication, unused here. | Apache-2.0 |
| `github.com/nats-io/nuid` | v1.0.1 | indirect | Unique ids for inboxes. | Apache-2.0 |
| `github.com/klauspost/compress` | v1.20.0 | indirect | `flate`, for the client's WebSocket transport, which a `nats://` address does not use. | BSD-3-Clause for `flate`; the module holds Apache-2.0 parts too |
| `golang.org/x/sys` | v0.49.0 | indirect | `cpu`, read by x/crypto's `blake2b` through nkeys. `golang.org/x/crypto` v0.58.0 already asked for this version. | BSD-3-Clause |
| `nats` (Docker image) | `2.15-alpine` (nats-server v2.15.1) | `docker-compose.yml` | The server, under the `runner-link` profile. | Apache-2.0 |

- **Not the package named `nats`.** The task named the npm package `nats`. Its last release, 2.29.3 (2026-05-08), is
  deprecated with "Package moved. Use @nats-io/transport-node". `@nats-io/transport-node` is the same NATS.io client,
  the line that gets fixes. The runner link's coordinator agreed to the substitution.
- **Not a client of the gateway's own.** The gateway's other protocols are written in its own code. NATS is not,
  because the coordinator decided that the reconnects, re-subscriptions, keepalives, partial reads, payload limits and
  slow consumers a client must get right are better left to nats.go.
- **Source and integrity.**
  - The npm packages are NATS.io's, published from nats-io/nats.js, nats-io/nkeys.js and nats-io/nuid.js. `tweetnacl`
    is the widely used port of TweetNaCl. `package-lock.json` pins each by integrity. The change to the lockfile is
    the 52 lines of those five entries and the apiserver's dependency, and `npm ci` leaves it as it is.
  - The Go modules are NATS.io's, Klaus Post's and the Go project's. `go.sum` records each module's hash, which the Go
    checksum database vouched for when it was downloaded, and `go mod verify` passes. The image build verifies again.
- **Known vulnerabilities: none at these versions.**
  - OSV lists nothing for any package above at its locked version, nats-server v2.15.1 included.
  - The advisories OSV holds for earlier versions are fixed before these, or lie in code that is not imported:
    - nkeys GO-2023-2163, fixed in v0.4.6;
    - klauspost/compress GO-2026-5841, in `s2`, fixed in v1.18.7;
    - two for the deprecated `nats`, in 2.0.0 pre-releases;
    - 51 for nats-server, none of which affects 2.15.1.
  - `npm audit` reports the same 11 findings with and without these packages: the set already on main, all in
    other packages.
  - govulncheck v1.9.0 with Go 1.27.3, the gateway image's Go, finds no vulnerability in the gateway's code. Its module
    scan lists only GO-2026-5932, as before.
- **Reach.**
  - In the apiserver, only `runner-hints.ts` imports the client. It connects only while the runner link is configured,
    to `RUNNER_LINK_NATS_URL` (the `nats` service in this project's network), and it only publishes. It subscribes to
    nothing, so the only input from the server it parses is the protocol's own lines: INFO, PING, PONG and errors. No
    authentication is configured: nkeys and tweetnacl are loaded with the client and sign nothing.
  - In the gateway, nats.go dials only `LINK_NATS_URL` and subscribes to `rnr.<runnerId>` for the runners connected
    there. What it hands over is decoded with `protojson` into a Frame, and only a Hint is used. That puts `protojson`
    on the serving path for messages the apiserver published, never for anything a runner sends. GO-2024-2611, the
    `protojson` loop, predates v1.36.12. Nothing a runner sends reaches NATS's code.
  - The gateway binary (linux/amd64, stripped) grows from 10,690,720 to 11,460,768 bytes.
- **The server.** The official image on its 2.15 line, run from flags alone. The image's configuration file opens a
  cluster port with the route password it publishes, and it is never read. JetStream is off, and nothing is stored.
  The container runs read-only, with every capability dropped and `no-new-privileges`. Its client port is exposed only
  to this project's network, and its monitoring port is reached there too, by its health check. It asks for no
  authentication: the project's network is the boundary, as it is for Postgres. `test/compose-topology.test.mjs` (p)
  pins the definition.
- **Install scripts.** None of the five npm packages runs anything when installed (`hasInstallScript` is absent from
  the lockfile). `@nats-io/nkeys` declares `prepare`, which npm runs only when it installs a package from a Git
  checkout, never from the registry's tarball.
- **Runtime.** `@nats-io/nuid` asks for Node 22 or later. The apiserver runs on Node 26.
- **Updates.** Dependabot's `npm` (`/`) and `gomod` (`/src/link-gateway`) entries cover every package above. The image
  tag takes 2.15's patch releases. A minor or major version is a change to `docker-compose.yml`, which (p) refuses until
  it is decided.

Decision: accepted, with no override or audit exception.

## Verification

Run from a clean checkout:

```sh
npm ci
npm audit --json
npm run prisma:generate
npm run build
npm test -w @orbit/shared
npm test -w @orbit/apiserver
npm test -w @orbit/web
```

The 2026-08-20 clean-room run reported zero audit findings and passed 141 shared tests, 1,212 API tests, and
552 web tests. Pull requests also run the dependency review action and fail when a changed dependency introduces
a high or critical advisory. Dependabot checks npm, GitHub Actions, Go modules, Swift packages, and Dockerfiles
weekly; maintainers must still review release notes, lockfile changes, licenses, and test evidence before merge.
