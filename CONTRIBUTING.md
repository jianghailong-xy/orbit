# Contributing to Orbit

Thank you for helping improve Orbit. Contributions can include bug reports, documentation, tests, design
feedback, runtime integrations, and code.

## Before you start

- Search [existing issues](https://github.com/jianghailong-xy/orbit/issues) before opening a new one.
- Use the [bug report](https://github.com/jianghailong-xy/orbit/issues/new?template=bug_report.yml) or [feature request](https://github.com/jianghailong-xy/orbit/issues/new?template=feature_request.yml) form for actionable public Issues.
- Use [Discussions](https://github.com/jianghailong-xy/orbit/discussions) for questions, early ideas, release feedback, and showcases. The [community guide](COMMUNITY.md) explains the channel and label conventions.
- If you are new to the repository, start with an open [good first issue](https://github.com/jianghailong-xy/orbit/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). Claim it in a comment before starting so two people do not duplicate the work.
- For a large feature, schema change, new dependency, protocol change, or visible product redesign, open an
  issue before investing in an implementation. Early agreement on scope prevents wasted work.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.
- Do not report vulnerabilities in a public issue; follow [SECURITY.md](SECURITY.md).

Small fixes, tests, and documentation improvements can go directly to a pull request.

## Development setup

Follow [docs/development.md](docs/development.md) for prerequisites, local setup, repository layout, and build
commands.

## Making a change

1. Fork the repository and create a focused branch from `main`.
2. Keep the change scoped to one problem. Avoid unrelated formatting or refactors.
3. Add or update tests for behavior changes.
4. Update user-facing documentation when behavior, configuration, commands, APIs, or workflows change.
5. Run the relevant build and test commands locally.
6. Open a pull request using the repository template and explain the problem, approach, and verification.

Use clear commit messages. The existing history generally follows `type(scope): summary`, for example
`fix(runner): preserve queued turns after reconnect` or `docs: clarify backup verification`.

## Verification

Run the checks relevant to the files you changed:

```bash
# TypeScript packages and web client
npm run build
npm test -w @orbit/shared
npm test -w @orbit/apiserver
npm test -w @orbit/web

# Go runner
cd src/runner-go
go test ./...

# Shared Swift core
cd src/macos/OrbitKit
swift test
```

macOS and iOS UI changes also need their platform build gates. See the [macOS app
guide](src/macos/OrbitApp/README.md) and [iOS guide](src/ios/README.md).

If a check cannot run in your environment, state which check and why in the pull request. That context is
more useful than silently leaving the checklist incomplete.

## Pull-request expectations

A reviewable pull request:

- describes the user or operator problem before the implementation;
- calls out migrations, compatibility changes, security implications, and operational risk;
- includes focused tests and manual verification where appropriate;
- avoids committing generated output, local data, credentials, or unrelated changes;
- keeps shared TypeScript, Go, and Swift contracts synchronized when a protocol changes;
- updates the nearest public guide in the same change.

Maintainers may ask for a change to be split, simplified, or discussed in an issue before it is merged.
The [community guide](COMMUNITY.md#maintainer-response-convention) describes response targets; they are
volunteer targets, not an SLA.

## Documentation

Public user and contributor guides are written in English. Existing design records may be in English or
Chinese; do not translate or rewrite a historical decision record merely for consistency. When implementation
diverges from an old design, append an implementation note and update the current operator or architecture
guide.

Start at [docs/README.md](docs/README.md).

From the repository root, with the Node.js version in `package.json`, check documentation on a clean checkout:

```bash
npm ci --ignore-scripts
npm run test:docs
npm run docs:check
```

The check reuses `.markdownlint-cli2.jsonc` and `.markdown-link-check.json`. It checks tracked root public
guides, public `.github/` Markdown, and the current guides listed in
[`scripts/docs-public-files.txt`](scripts/docs-public-files.txt). Add a new public guide to that list and
stage the file with Git before checking it locally. Agent instructions, historical design records,
generated `docs/evidence/`, and mocks are outside the lint scope; linked local files still have to exist
in the checkout. Local paths and GitHub heading/HTML anchors are checked, including links to other pages;
external URLs are excluded so network failures and authenticated pages do not make the gate flaky.

The **Documentation / Markdown and local links** workflow checks Markdown, Issue Form, configuration,
and checker changes on pull requests and pushes to `main`. Its status is also reported for code-only
changes, so maintainers can require **Markdown and local links** in branch protection without a path-filter
deadlock. The existing required **JavaScript** check also runs both documentation commands, so documentation
failures block merging through the current branch protection. A failure in the focused workflow uploads only
`docs-check.log` with file/rule or local-target diagnostics; it does not
upload `.env`, runner config, container output, or credentials.

## License

By submitting a contribution, you agree that it may be distributed under the project's [MIT License](LICENSE).
