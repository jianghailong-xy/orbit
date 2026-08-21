# Development guide

## Prerequisites

- Node.js 26 or newer and npm
- PostgreSQL 16, or Docker with Compose for the local database
- Go 1.27 or newer for the runner
- Swift 6.1 for OrbitKit; current Xcode for macOS and iOS app builds

## Local web and API setup

```bash
npm install
cp .env.example .env
```

For local development, set `JWT_SECRET` and `PROVIDER_SECRET_KEY` in `.env`, then start and migrate Postgres:

```bash
npm run db:up
npm run prisma:generate
npm run prisma:migrate -w @orbit/apiserver
```

Start the API and web app in separate terminals:

```bash
npm run dev:apiserver
```

```bash
npm run dev:web
```

The API runs on <http://localhost:3000>. Vite runs on <http://localhost:5173> and proxies `/api` to the API.

## Repository layout

```text
src/
  shared/       TypeScript contracts and provider presets
  apiserver/    NestJS control plane and Prisma schema/migrations
  runner-go/    Go runner, runtime adapters, and automation CLI
  web/          Vite + React web client
  macos/        OrbitKit and the native macOS app
  ios/          iPhone/iPad app reusing OrbitKit and shared SwiftUI sources
gateway/        nginx configuration for the Compose deployment
docs/           user guides, operator runbooks, and design records
brand/          approved brand assets and source explorations
scripts/        build, backup, and repository automation
```

## Build and test

Build all JavaScript workspaces:

```bash
npm run build
```

Run the TypeScript and web test suites:

```bash
npm test -w @orbit/shared
npm test -w @orbit/apiserver
npm test -w @orbit/web
```

Run the Go runner tests:

```bash
cd src/runner-go
go test ./...
```

Run the platform-independent Swift core tests:

```bash
cd src/macos/OrbitKit
swift test
```

Native app compilation needs macOS. Follow the [OrbitApp guide](../src/macos/OrbitApp/README.md) and [iOS
guide](../src/ios/README.md) for Xcode-specific commands.

Build distributable runner binaries from the repository root:

```bash
npm run build:runner
```

## Database changes

Edit `src/apiserver/prisma/schema.prisma`, generate a named development migration, and include the migration in
the pull request. Do not edit a migration that may already have run in another environment.

```bash
npm run prisma:migrate -w @orbit/apiserver -- --name describe_the_change
```

Exercise both a fresh migration and an upgrade from existing data when a change transforms or deletes data.

## Change expectations

- Add or update tests for behavior changes.
- Update the nearest user or operator guide when a command, configuration key, API, or visible workflow changes.
- Keep shared contracts in `src/shared` synchronized with the Go and Swift representations that consume them.
- Treat design notes as records: add an implementation-differences section instead of silently rewriting old
  decisions after the code diverges.
- Never commit credentials, production data, runner config files, or generated build artifacts.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the issue and pull-request workflow.
